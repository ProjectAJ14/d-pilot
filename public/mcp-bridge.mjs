#!/usr/bin/env node
/**
 * D-Pilot MCP bridge — a local stdio MCP server that relays to D-Pilot's
 * hosted `/api/mcp` endpoint.
 *
 * Why: D-Pilot often sits behind a VPN. Pointed straight at the HTTP endpoint,
 * an MCP client whose VPN is off just times out on `initialize`, marks the
 * server failed with no explanation, and stays failed until someone reconnects
 * it by hand. No request reaches D-Pilot, so D-Pilot cannot explain itself.
 * This bridge always starts: while D-Pilot is unreachable it offers a single
 * `dpilot_status` tool that says why, polls D-Pilot's health check, and tells
 * the client to re-list tools (`notifications/tools/list_changed`) the moment
 * D-Pilot is back — no reconnect needed.
 *
 * Node 18+, no dependencies. Configure with environment variables:
 *   DPILOT_MCP_URL   the endpoint, e.g. https://d-pilot.example.com/api/mcp
 *   DPILOT_MCP_AUTH  the Authorization header value: Basic base64(user:password)
 *   DPILOT_BRIDGE_POLL_MS     optional, health poll while unreachable (10000)
 *   DPILOT_BRIDGE_TIMEOUT_MS  optional, per forwarded request (120000)
 *
 * Run: node mcp-bridge.mjs — stdout carries only the MCP protocol; logs go to stderr.
 */
import { createInterface } from "node:readline";

const VERSION = "1.0.0";
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const MCP_URL = process.env.DPILOT_MCP_URL;
const POLL_MS = Number(process.env.DPILOT_BRIDGE_POLL_MS) || 10_000;
const TIMEOUT_MS = Number(process.env.DPILOT_BRIDGE_TIMEOUT_MS) || 120_000;
const log = (...a) => console.error("[d-pilot-bridge]", ...a);
if (!MCP_URL || !process.env.DPILOT_MCP_AUTH) {
  log("Set DPILOT_MCP_URL and DPILOT_MCP_AUTH (see the comment at the top).");
  process.exit(1);
}
// fetch refuses such a URL with an error that quotes it, credentials included.
if (/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(MCP_URL)) {
  log(
    "DPILOT_MCP_URL must not contain a username or password; use DPILOT_MCP_AUTH.",
  );
  process.exit(1);
}
// GNU base64 wraps long output at 76 columns; rejoin a wrapped credential.
const [SCHEME, ...CREDENTIAL] = process.env.DPILOT_MCP_AUTH.trim().split(/\s+/);
const AUTH = `${SCHEME} ${CREDENTIAL.join("")}`;
const BASE = MCP_URL.replace(/\/api\/mcp\/?$/, "");
const HEALTH_URL = `${BASE}/api/health`;
const CREDENTIALS_MSG =
  "D-Pilot rejected the credentials in DPILOT_MCP_AUTH. Check the username and password.";

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) =>
  send({ jsonrpc: "2.0", id, error: { code, message } });

let reachable = null; // null until the first probe or request settles it
let reason = "";
let poller;
const downMsg = () =>
  `D-Pilot at ${BASE} can't be reached from this machine (${reason}). D-Pilot itself is ` +
  "probably running — check your network or VPN connection. Its tools will come back automatically.";
const STATUS_TOOL = {
  name: "dpilot_status",
  description:
    "D-Pilot is currently unreachable from this machine, so its tools are hidden. Call this " +
    "for details, and ask the user to check their network/VPN connection.",
  inputSchema: { type: "object", properties: {} },
};

function setState(up, why) {
  reason = why;
  if (up === reachable) return;
  const was = reachable;
  reachable = up;
  log(up ? "D-Pilot is reachable" : `D-Pilot is unreachable (${why})`);
  if (was !== null)
    send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  clearInterval(poller);
  if (!up) (poller = setInterval(probe, POLL_MS)).unref();
}

// Network failures reject with a coded `cause` (ECONNREFUSED, ENOTFOUND, ...) or
// time out. Anything else (a malformed URL or header) is configuration: undefined.
const why = (err) =>
  err.name === "TimeoutError" ? "no response" : err.cause?.code;

async function probe() {
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(5000) });
    setState(res.ok, `HTTP ${res.status}`);
  } catch (err) {
    setState(false, why(err));
  }
}

class Unreachable extends Error {}

/** POSTs one message upstream; resolves to its JSON-RPC response. */
async function forward(msg) {
  let res, text;
  try {
    res = await fetch(MCP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: AUTH,
      },
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    text = await res.text();
  } catch (err) {
    if (!why(err)) {
      // fetch's message can quote the header value: log it without the
      // credential, and keep it out of the reply, which an AI reads.
      log(
        "Could not send the request:",
        String(err.message).split(AUTH).join("<auth>"),
      );
      throw new Error(
        "Could not send the request to D-Pilot. Check DPILOT_MCP_URL and DPILOT_MCP_AUTH.",
      );
    }
    setState(false, why(err));
    throw new Unreachable(downMsg());
  }
  if ([502, 503, 504].includes(res.status)) {
    setState(false, `HTTP ${res.status}`);
    throw new Unreachable(downMsg());
  }
  setState(true, "");
  if (res.status === 401 || res.status === 403)
    throw new Error(CREDENTIALS_MSG);
  // Stateless Streamable HTTP answers with JSON or an SSE stream of `data:` lines.
  let found;
  try {
    const messages = (res.headers.get("content-type") || "").includes(
      "text/event-stream",
    )
      ? text
          .split("\n") // a CRLF's "\r" is JSON whitespace
          .filter((l) => l.startsWith("data:"))
          .map((l) => JSON.parse(l.slice(5)))
      : [JSON.parse(text)].flat();
    found = messages.find((m) => m.id === msg.id);
  } catch {
    // not JSON-RPC (an HTML error page, an empty body, `null`) — reported below
  }
  if (!found)
    throw new Error(
      `D-Pilot answered HTTP ${res.status} without an MCP response`,
    );
  return found;
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // a notification: the stateless upstream needs none of them
  if (method === "initialize") {
    const asked = params?.protocolVersion;
    return reply(id, {
      protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: "d-pilot-bridge", version: VERSION },
      instructions:
        "This is D-Pilot, reached through a local bridge. If its tools report D-Pilot is " +
        "unreachable, D-Pilot itself is most likely fine and this machine's network/VPN cannot " +
        "reach it: ask the user to check their connection or VPN. The tools come back on their own once it is reachable.",
    });
  }
  if (method === "ping") return reply(id, {});
  if (method === "tools/call" && params?.name === STATUS_TOOL.name) {
    await probe();
    const text = reachable
      ? `D-Pilot at ${BASE} is reachable; its tools are available.`
      : downMsg();
    return reply(id, { content: [{ type: "text", text }] });
  }
  if (method === "tools/list" && reachable === false)
    return reply(id, { tools: [STATUS_TOOL] });
  try {
    send(await forward(msg));
  } catch (err) {
    if (method === "tools/list" && err instanceof Unreachable)
      return reply(id, { tools: [STATUS_TOOL] });
    if (method === "tools/call")
      return reply(id, {
        content: [{ type: "text", text: err.message }],
        isError: true,
      });
    fail(id, -32603, err.message);
  }
}

createInterface({ input: process.stdin })
  .on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return fail(null, -32700, "Parse error");
    }
    if (typeof msg?.method !== "string")
      return fail(null, -32600, "Invalid Request (batches are not supported)");
    // handle() catches every failure it can meet; anything else is a bug and should crash loudly.
    void handle(msg);
  })
  // Exit now, even with a forwarded call still in flight: the client is gone.
  .on("close", () => process.exit(0));

probe();
