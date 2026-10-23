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
 *
 * Or, once, to register it with Claude Desktop instead of serving:
 *   node mcp-bridge.mjs --install-desktop <url> "Basic <base64 of user:password>"
 * which writes the `d-pilot` entry into Claude Desktop's config file (this node,
 * this file, those two values) and keeps everything else in it.
 * DPILOT_DESKTOP_CONFIG overrides which file.
 */
import { createInterface } from "node:readline";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "1.0.0";
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const log = (...a) => console.error("[d-pilot-bridge]", ...a);
const quit = (...a) => {
  log(...a);
  process.exit(1);
};

/**
 * Parsed the way fetch parses it, so no spelling of userinfo slips past; fetch's
 * own errors would quote the URL, credentials included. Never echoes `raw`.
 */
export function parseMcpUrl(raw, name) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return `${name} is not a valid URL.`;
  }
  if (url.username || url.password)
    return `${name} must not contain a username or password; the credential goes in the authorization.`;
  return url;
}

/**
 * Where Claude Desktop keeps its config on `platform`, given `env` and the home
 * dir; null on Windows without APPDATA, which is where it lives there.
 */
export function desktopConfigPath(platform, env, home) {
  if (env.DPILOT_DESKTOP_CONFIG) return env.DPILOT_DESKTOP_CONFIG;
  if (platform === "win32")
    return env.APPDATA
      ? win32.join(env.APPDATA, "Claude", "claude_desktop_config.json")
      : null;
  if (platform === "darwin")
    return join(
      home,
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    );
  return join(home, ".config", "Claude", "claude_desktop_config.json");
}

/**
 * The `node` PATH finds (PATHEXT on Windows) when it is this very binary, else
 * `execPath`. Homebrew's execPath is a versioned Cellar path that an upgrade
 * deletes; its PATH entry (/opt/homebrew/bin/node) survives the upgrade.
 */
export function stableNodePath(platform, env, execPath) {
  const win = platform === "win32";
  const exts = win ? (env.PATHEXT || ".EXE").split(";") : [""];
  const self = realpathSync(execPath);
  for (const dir of (env.PATH ?? "").split(win ? ";" : ":").filter(Boolean))
    for (const ext of exts) {
      const candidate = join(dir, `node${ext}`);
      let real;
      try {
        real = realpathSync(candidate);
      } catch {
        continue; // not in this directory
      }
      return real === self ? candidate : execPath;
    }
  return execPath;
}

const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/** The JSON-RPC messages in an SSE body: an event's `data:` lines joined by "\n". */
function sseMessages(text) {
  const messages = [];
  let data = [];
  for (const line of `${text}\n\n`.split(/\r\n|\r|\n/)) {
    if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    else if (!line && data.length) {
      messages.push(JSON.parse(data.join("\n")));
      data = [];
    }
  }
  return messages;
}

// Node's codes for a certificate it does not trust (err.cause.code from fetch).
const TLS_CODES = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/**
 * `--install-desktop <url> <authorization>`: points Claude Desktop at this
 * file, run by this node — absolute paths, so the user never types one. Any
 * other content of the config is kept, and a file it can't parse is left
 * alone. The credential is never printed.
 */
function installDesktop(rawUrl, auth) {
  const url = parseMcpUrl(rawUrl, "The URL");
  if (typeof url === "string") quit(url);
  if (!/^Basic [A-Za-z0-9+/]+={0,2}$/.test(auth ?? ""))
    quit('The authorization must be "Basic <base64 of user:password>".');
  let file = desktopConfigPath(process.platform, process.env, homedir());
  if (!file)
    quit(
      "APPDATA is not set, so Claude Desktop's config can't be found. Set DPILOT_DESKTOP_CONFIG to the path of its claude_desktop_config.json and run this again.",
    );
  const existed = existsSync(file);
  // Write through a symlink (a dotfiles repo, say) to the file it points at:
  // renaming over the link would replace it with a copy.
  if (existed) file = realpathSync(file);
  let config = {};
  if (existed) {
    const text = readFileSync(file, "utf8");
    try {
      config = JSON.parse(text);
    } catch {
      quit(
        `${file} is not valid JSON; fix or remove it, then run this again. Nothing was changed.`,
      );
    }
    if (!isObject(config) || !isObject(config.mcpServers ?? {}))
      quit(
        `${file} does not hold a JSON object with an mcpServers object; nothing was changed.`,
      );
    // Owner-only, like the config: it holds every server's credentials. A
    // fresh file, since `mode` is ignored when writing over an existing one.
    rmSync(`${file}.bak`, { force: true });
    writeFileSync(`${file}.bak`, text, { mode: 0o600, flag: "wx" });
  } else mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  config.mcpServers = {
    ...config.mcpServers,
    "d-pilot": {
      command: stableNodePath(process.platform, process.env, process.execPath),
      args: [fileURLToPath(import.meta.url)],
      env: { DPILOT_MCP_URL: rawUrl, DPILOT_MCP_AUTH: auth },
    },
  };
  // Written beside the target and renamed over it, so a crash can't leave half a file.
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  console.log(
    `Added d-pilot (${url.origin}) to ${file}${existed ? ` (backup: ${file}.bak)` : ""}.`,
  );
  console.log("Fully quit Claude Desktop and reopen it.");
}

/** The MCP server: stdio in, `DPILOT_MCP_URL` out. */
function serve() {
  const MCP_URL = process.env.DPILOT_MCP_URL;
  const POLL_MS = Number(process.env.DPILOT_BRIDGE_POLL_MS) || 10_000;
  const TIMEOUT_MS = Number(process.env.DPILOT_BRIDGE_TIMEOUT_MS) || 120_000;
  if (!MCP_URL || !process.env.DPILOT_MCP_AUTH)
    quit(
      "Set DPILOT_MCP_URL and DPILOT_MCP_AUTH (see the comment at the top).",
    );
  const url = parseMcpUrl(MCP_URL, "DPILOT_MCP_URL");
  if (typeof url === "string") quit(url);
  // GNU base64 wraps long output at 76 columns; rejoin a wrapped credential.
  const [SCHEME, ...CREDENTIAL] =
    process.env.DPILOT_MCP_AUTH.trim().split(/\s+/);
  const AUTH = `${SCHEME} ${CREDENTIAL.join("")}`;
  const BASE = url.origin + url.pathname.replace(/\/?(api\/mcp\/?)?$/, "");
  const HEALTH_URL = `${BASE}/api/health`;
  const CREDENTIALS_MSG =
    "D-Pilot rejected the credentials in DPILOT_MCP_AUTH. Check the username and password.";
  // Fixed text: Node's own message is not echoed (it can quote the request).
  const TLS_MSG =
    `D-Pilot's HTTPS certificate at ${BASE} is not trusted by Node on this machine. This is ` +
    "configuration, not an outage: if your organisation uses its own certificate authority " +
    "(or a TLS-inspecting proxy), set NODE_EXTRA_CA_CERTS to that CA's PEM file in this " +
    "server's env, then restart the MCP client.";
  // A 2xx from something that is not D-Pilot: it answered in its place.
  const NOT_MCP =
    "unexpected non-MCP response; a captive portal or VPN login page?";
  const GATEWAY = [502, 503, 504];

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
  const untrusted = (err) => TLS_CODES.has(err.cause?.code);

  /**
   * Any answer but a gateway error means the network path works, so a health
   * path a proxy remaps (404) does not hide the tools. Except a 2xx that is not
   * D-Pilot's JSON: something else (a captive portal) answered for it. An
   * untrusted certificate is configuration: shown, never polled.
   */
  async function probe() {
    try {
      const res = await fetch(HEALTH_URL, {
        signal: AbortSignal.timeout(5000),
      });
      let body;
      try {
        body = JSON.parse(await res.text());
      } catch {
        // not D-Pilot's JSON (an HTML page): checked below
      }
      if (res.ok && !isObject(body)) setState(false, NOT_MCP);
      else if (GATEWAY.includes(res.status))
        setState(false, `HTTP ${res.status}`);
      else setState(true, "");
    } catch (err) {
      if (untrusted(err)) setState(true, TLS_MSG);
      else setState(false, why(err));
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
      if (untrusted(err)) {
        setState(true, TLS_MSG);
        throw new Error(TLS_MSG);
      }
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
    if (GATEWAY.includes(res.status)) {
      setState(false, `HTTP ${res.status}`);
      throw new Unreachable(downMsg());
    }
    // Stateless Streamable HTTP answers with JSON or an SSE stream of `data:` lines.
    let found;
    try {
      const messages = (res.headers.get("content-type") || "").includes(
        "text/event-stream",
      )
        ? sseMessages(text)
        : [JSON.parse(text)].flat();
      found = messages.find((m) => m.id === msg.id);
    } catch {
      // not JSON-RPC (an HTML page, an empty body, `null`) — handled below
    }
    if (res.ok && !found) {
      setState(false, NOT_MCP);
      throw new Unreachable(downMsg());
    }
    setState(true, "");
    if (res.status === 401 || res.status === 403)
      throw new Error(CREDENTIALS_MSG);
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
        ? reason || `D-Pilot at ${BASE} is reachable; its tools are available.`
        : downMsg();
      return reply(id, { content: [{ type: "text", text }] });
    }
    try {
      send(await forward(msg));
    } catch (err) {
      // tools/list always tries D-Pilot first: a wrong guess from the health
      // check must never hide the tools for good.
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
        return fail(
          null,
          -32600,
          "Invalid Request (batches are not supported)",
        );
      // handle() catches every failure it can meet; anything else is a bug and should crash loudly.
      void handle(msg);
    })
    // Exit now, even with a forwarded call still in flight: the client is gone.
    .on("close", () => process.exit(0));

  probe();
}

/** Run as `node mcp-bridge.mjs`, not imported (by the tests). realpath: /tmp is a symlink on macOS. */
const isMain = () =>
  !!process.argv[1] &&
  realpathSync.native(process.argv[1]) ===
    realpathSync.native(fileURLToPath(import.meta.url));

if (isMain()) {
  if (process.argv[2] === "--install-desktop")
    installDesktop(process.argv[3], process.argv[4]);
  else serve();
}
