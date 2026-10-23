import { describe, it, expect, afterEach, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

/**
 * Drives public/mcp-bridge.mjs the way an MCP client does: a child process
 * spoken to over stdio, relaying to a fake D-Pilot that can be up, down, slow,
 * behind a failing proxy, or anything in between.
 *
 * Children are stopped by closing stdin (the bridge's own clean exit), not
 * killed, so `NODE_V8_COVERAGE` — inherited from this process's env — still
 * gets written and coverage of the bridge can be measured.
 */
const BRIDGE = fileURLToPath(
  new URL("../public/mcp-bridge.mjs", import.meta.url),
);
const AUTH = "Basic YWdlbnRAZXhhbXBsZS5jb206cHc=";
const REAL_TOOLS = [{ name: "run_query", inputSchema: { type: "object" } }];
const UNREACHABLE = /can't be reached from this machine/;
const LIST_CHANGED = "notifications/tools/list_changed";

const children: ChildProcess[] = [];
const servers: http.Server[] = [];
const stdoutLines: string[][] = [];

afterEach(async () => {
  await Promise.all(children.splice(0).map(exit));
  await Promise.all(servers.splice(0).map(stop));
  // Nothing but JSON-RPC 2.0 may ever reach stdout: it IS the protocol.
  for (const line of stdoutLines.splice(0).flat()) {
    expect(JSON.parse(line).jsonrpc, line).toBe("2.0");
  }
});

/** Closes stdin and waits for the exit; kills only a bridge that ignores it. */
function exit(child: ChildProcess) {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => child.kill(), 2000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.stdin!.end();
  });
}

function stop(server: http.Server) {
  server.closeAllConnections();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

type Res = http.ServerResponse;
const jsonRpc = (msg: any) => {
  const result =
    msg.method === "tools/list"
      ? { tools: REAL_TOOLS }
      : msg.method === "resources/list"
        ? { resources: [] }
        : { content: [{ type: "text", text: "1 row" }] };
  return JSON.stringify({ jsonrpc: "2.0", id: msg.id, result });
};

/**
 * A fake D-Pilot answering only `${prefix}/api/health` and `${prefix}/api/mcp`
 * (anything else 404s, so a wrongly derived health URL reads as "down").
 * `mcp` and `health` override the answers; leaving a response unended hangs.
 */
async function fakeDpilot(
  opts: {
    prefix?: string;
    port?: number;
    mcp?: (msg: any, res: Res) => void;
    health?: (res: Res) => void;
  } = {},
) {
  const prefix = opts.prefix ?? "";
  const posts: { msg: any; headers: http.IncomingHttpHeaders }[] = [];
  const healthHits: string[] = [];
  const server = http.createServer((req, res) => {
    if (req.url === `${prefix}/api/health`) {
      healthHits.push(req.url);
      return opts.health ? opts.health(res) : res.end('{"status":"ok"}');
    }
    if (req.url !== `${prefix}/api/mcp`) return res.writeHead(404).end();
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body);
      posts.push({ msg, headers: req.headers });
      if (opts.mcp) return opts.mcp(msg, res);
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(jsonRpc(msg));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(opts.port ?? 0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { server, posts, healthHits, port };
}

/** A random port nothing listens on (for now). */
async function freePort() {
  const { server, port } = await fakeDpilot();
  servers.splice(servers.indexOf(server), 1);
  await stop(server);
  return port;
}

const urlFor = (port: number, prefix = "") =>
  `http://127.0.0.1:${port}${prefix}/api/mcp`;

function bridge(url: string | undefined, env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [BRIDGE], {
    env: {
      ...process.env, // carries NODE_V8_COVERAGE through when it is set
      ...(url && { DPILOT_MCP_URL: url }),
      DPILOT_MCP_AUTH: AUTH,
      DPILOT_BRIDGE_POLL_MS: "100",
      ...env,
    },
  });
  children.push(child);
  const lines: string[] = [];
  stdoutLines.push(lines);
  const out: any[] = [];
  let pending = "";
  child.stdout!.on("data", (chunk) => {
    pending += chunk;
    const parts = pending.split("\n");
    pending = parts.pop()!;
    for (const l of parts) {
      lines.push(l);
      out.push(JSON.parse(l));
    }
  });
  let stderr = "";
  child.stderr!.on("data", (c) => (stderr += c));
  let nextId = 1;
  const write = (m: unknown) =>
    child.stdin!.write(`${typeof m === "string" ? m : JSON.stringify(m)}\n`);
  const waitFor = (pred: (m: any) => boolean) =>
    vi.waitFor(
      () => {
        const m = out.find(pred);
        if (!m) throw new Error("not yet");
        return m;
      },
      { timeout: 4000, interval: 10 },
    );
  const request = async (method: string, params?: unknown) => {
    const id = nextId++;
    write({ jsonrpc: "2.0", id, method, params });
    return waitFor((m) => m.id === id);
  };
  const listChanged = () => out.filter((m) => m.method === LIST_CHANGED).length;
  const exited = new Promise<number | null>((r) => child.once("exit", r));
  return {
    child,
    out,
    write,
    request,
    waitFor,
    listChanged,
    exited,
    stderr: () => stderr,
  };
}

const toolNames = (r: any) => r.result.tools.map((t: any) => t.name);
const callText = (r: any) => r.result.content[0].text as string;
const run = (b: ReturnType<typeof bridge>) =>
  b.request("tools/call", {
    name: "run_query",
    arguments: { sql: "select 1" },
  });

describe("mcp-bridge: process", () => {
  it.each([
    ["DPILOT_MCP_URL", undefined, {}],
    ["DPILOT_MCP_AUTH", "http://127.0.0.1:9/api/mcp", { DPILOT_MCP_AUTH: "" }],
  ])(
    "refuses to start without %s, saying so on stderr",
    async (_v, url, env) => {
      const b = bridge(url, env);
      expect(await b.exited).toBe(1);
      expect(b.stderr()).toMatch(/Set DPILOT_MCP_URL and DPILOT_MCP_AUTH/);
      expect(b.out).toEqual([]);
    },
  );

  it("exits cleanly when stdin closes, even mid-request", async () => {
    // A call that never answers, under the default 120s timeout and poll.
    const { port, posts } = await fakeDpilot({ mcp: () => {} });
    const b = bridge(urlFor(port), { DPILOT_BRIDGE_POLL_MS: "" });
    b.write({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    b.child.stdin!.end();
    expect(await b.exited).toBe(0);
  });
});

describe("mcp-bridge: answered locally", () => {
  it("answers initialize without the network, echoing a known protocol version", async () => {
    const b = bridge(urlFor(await freePort()));
    const r = await b.request("initialize", { protocolVersion: "2025-06-18" });
    expect(r.result).toMatchObject({
      protocolVersion: "2025-06-18",
      serverInfo: { name: "d-pilot-bridge" },
      capabilities: { tools: { listChanged: true } },
    });
    expect(r.result.instructions).toMatch(/VPN/);
    const unknown = await b.request("initialize", {
      protocolVersion: "1999-01-01",
    });
    expect(unknown.result.protocolVersion).toBe("2025-11-25");
    const none = await b.request("initialize");
    expect(none.result.protocolVersion).toBe("2025-11-25");
  });

  it("answers ping", async () => {
    const b = bridge(urlFor(await freePort()));
    expect(await b.request("ping")).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {},
    });
  });

  it("neither answers nor forwards notifications", async () => {
    const { port, posts } = await fakeDpilot();
    const b = bridge(urlFor(port));
    b.write({ jsonrpc: "2.0", method: "notifications/initialized" });
    b.write({ jsonrpc: "2.0", method: "notifications/cancelled", params: {} });
    await b.request("ping");
    expect(b.out).toHaveLength(1);
    expect(posts).toEqual([]);
  });

  it("rejects malformed and invalid lines, ignores blank ones, and keeps working", async () => {
    const b = bridge(urlFor(await freePort()));
    b.write("");
    b.write("   ");
    b.write("{not json");
    b.write("null");
    b.write('[{"jsonrpc":"2.0","id":7,"method":"ping"}]');
    b.write('{"jsonrpc":"2.0","id":8}');
    await b.request("ping");
    expect(b.out.map((m) => m.error?.code ?? "ok")).toEqual([
      -32700,
      -32600,
      -32600,
      -32600,
      "ok",
    ]);
    expect(b.out.slice(0, 4).every((m) => m.id === null)).toBe(true);
  });
});

describe("mcp-bridge: D-Pilot unreachable", () => {
  it("lists only dpilot_status, which explains why", async () => {
    const port = await freePort();
    const b = bridge(urlFor(port));
    const list = await b.request("tools/list");
    expect(toolNames(list)).toEqual(["dpilot_status"]);
    expect(list.result.tools[0].description).toMatch(/unreachable.*VPN/s);
    const r = await b.request("tools/call", { name: "dpilot_status" });
    expect(callText(r)).toBe(
      `D-Pilot at http://127.0.0.1:${port} can't be reached from this machine (ECONNREFUSED). ` +
        "D-Pilot itself is probably running — check your network or VPN connection. " +
        "Its tools will come back automatically.",
    );
  });

  // A proxy in front of a dead D-Pilot answers its health check the same way.
  const failingProxy = (status: number) => ({
    mcp: (_m: any, res: Res) => res.writeHead(status).end("bad gateway"),
    health: (res: Res) => res.writeHead(status).end(),
  });
  it.each([
    ["a refused connection", "ECONNREFUSED", null],
    ["a timeout", "no response", { mcp: () => {}, health: () => {} }],
    ["HTTP 502", "HTTP 502", failingProxy(502)],
    ["HTTP 503", "HTTP 503", failingProxy(503)],
    ["HTTP 504", "HTTP 504", failingProxy(504)],
  ])("treats %s as unreachable", async (_label, reason, fake) => {
    const port = fake ? (await fakeDpilot(fake)).port : await freePort();
    const b = bridge(urlFor(port), { DPILOT_BRIDGE_TIMEOUT_MS: "300" });
    const r = await run(b);
    expect(r.result.isError).toBe(true);
    expect(callText(r)).toMatch(UNREACHABLE);
    expect(callText(r)).toContain(`(${reason})`);
    expect(toolNames(await b.request("tools/list"))).toEqual(["dpilot_status"]);
  });

  it("reports a request it cannot even send as configuration, not an outage", async () => {
    const { port, posts } = await fakeDpilot();
    // fetch refuses a non-Latin-1 header value before any network is involved.
    const b = bridge(urlFor(port), { DPILOT_MCP_AUTH: "Basic pässwörd✓" });
    const list = await b.request("tools/list");
    expect(list.error.message).toMatch(
      /^Could not send the request to D-Pilot\. Check DPILOT_MCP_URL and DPILOT_MCP_AUTH\.$/,
    );
    const call = await run(b);
    expect(call.result.isError).toBe(true);
    expect(callText(call)).not.toMatch(UNREACHABLE);
    expect(b.listChanged()).toBe(0);
    expect(posts).toEqual([]);
    // fetch's own error quotes the header value: it must not reach the agent
    // or the log, since both can end up in an AI's context.
    for (const seen of [JSON.stringify(b.out), b.stderr()])
      expect(seen).not.toContain("pässwörd");
  });

  it.each([
    "http://agent:s3cret@localhost:1/api/mcp",
    // Forms the WHATWG parser (which fetch uses) still reads as userinfo.
    "http:/agent:s3cret@localhost:1/api/mcp",
    "http:\\\\agent:s3cret@localhost:1/api/mcp",
  ])(
    "refuses a DPILOT_MCP_URL with credentials, without echoing them: %s",
    async (url) => {
      const b = bridge(url);
      expect(await b.exited).toBe(1);
      expect(b.stderr()).toMatch(/must not contain a username or password/);
      expect(b.stderr()).not.toContain("s3cret");
      expect(b.out).toEqual([]);
    },
  );

  it("refuses a DPILOT_MCP_URL that is not a URL, without echoing it", async () => {
    const b = bridge("not a url s3cret");
    expect(await b.exited).toBe(1);
    expect(b.stderr()).toMatch(/DPILOT_MCP_URL is not a valid URL/);
    expect(b.stderr()).not.toContain("s3cret");
    expect(b.out).toEqual([]);
  });

  it("answers other requests with a JSON-RPC error", async () => {
    const b = bridge(urlFor(await freePort()));
    const r = await b.request("resources/list");
    expect(r.error.code).toBe(-32603);
    expect(r.error.message).toMatch(UNREACHABLE);
  });
});

describe("mcp-bridge: D-Pilot reachable", () => {
  it.each(["json", "sse"])(
    "forwards tools/list and returns the %s answer",
    async (mode) => {
      const { port, posts } = await fakeDpilot({
        mcp: (msg, res) =>
          mode === "json"
            ? res
                .writeHead(200, { "content-type": "application/json" })
                .end(jsonRpc(msg))
            : res
                .writeHead(200, { "content-type": "text/event-stream" })
                .end(`event: message\ndata: ${jsonRpc(msg)}\n\n`),
      });
      const b = bridge(urlFor(port));
      expect(toolNames(await b.request("tools/list"))).toEqual(["run_query"]);
      expect(posts[0].headers).toMatchObject({
        authorization: AUTH,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      });
      expect(posts[0].msg).toMatchObject({ id: 1, method: "tools/list" });
    },
  );

  it("rejoins a credential that base64 wrapped across lines", async () => {
    const { port, posts } = await fakeDpilot();
    const wrapped = `  Basic ${AUTH.slice(6, 20)}\n${AUTH.slice(20)}\n`;
    const b = bridge(urlFor(port), { DPILOT_MCP_AUTH: wrapped });
    await b.request("tools/list");
    expect(posts[0].headers.authorization).toBe(AUTH);
  });

  it("picks the response out of a multi-event SSE stream", async () => {
    const { port } = await fakeDpilot({
      mcp: (msg, res) =>
        res
          .writeHead(200, { "content-type": "text/event-stream" })
          .end(
            [
              ": keep-alive {comments may hold anything}",
              "",
              "event: message",
              `data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}`,
              "",
              "",
              "event: message",
              `data: ${jsonRpc(msg)}`,
              "",
            ].join("\r\n"),
          ),
    });
    const b = bridge(urlFor(port));
    expect(callText(await run(b))).toBe("1 row");
  });

  it("forwards tool calls and other requests", async () => {
    const { port, posts } = await fakeDpilot();
    const b = bridge(urlFor(port));
    expect(callText(await run(b))).toBe("1 row");
    expect(callText(await b.request("tools/call"))).toBe("1 row");
    expect((await b.request("resources/list")).result).toEqual({
      resources: [],
    });
    expect(posts.map((p) => p.msg.method)).toEqual([
      "tools/call",
      "tools/call",
      "resources/list",
    ]);
  });

  it("reports dpilot_status as reachable", async () => {
    const { port } = await fakeDpilot();
    const b = bridge(urlFor(port));
    const r = await b.request("tools/call", { name: "dpilot_status" });
    expect(callText(r)).toBe(
      `D-Pilot at http://127.0.0.1:${port} is reachable; its tools are available.`,
    );
  });

  it.each([401, 403])(
    "reports %i as rejected credentials, not an outage",
    async (status) => {
      const { port } = await fakeDpilot({
        mcp: (_m, res) => res.writeHead(status).end("{}"),
      });
      const b = bridge(urlFor(port));
      const list = await b.request("tools/list");
      expect(list.error.message).toMatch(
        /rejected the credentials in DPILOT_MCP_AUTH/,
      );
      const call = await run(b);
      expect(call.result.isError).toBe(true);
      expect(callText(call)).toMatch(/rejected the credentials/);
      expect(b.listChanged()).toBe(0);
    },
  );

  it.each([
    [500, "text/html", "<h1>oops</h1>"],
    [500, "application/json", '{"error":"MCP request failed"}'],
    [202, undefined, ""],
    [200, "application/json", "null"],
  ])(
    "reports HTTP %i (%s) with no JSON-RPC answer as an error, not an outage",
    async (status, type, body) => {
      const { port } = await fakeDpilot({
        mcp: (_m, res) =>
          res.writeHead(status, type ? { "content-type": type } : {}).end(body),
      });
      const b = bridge(urlFor(port));
      const list = await b.request("tools/list");
      expect(list.error.message).toBe(
        `D-Pilot answered HTTP ${status} without an MCP response`,
      );
      const call = await run(b);
      expect(call.result.isError).toBe(true);
      expect(callText(call)).not.toMatch(UNREACHABLE);
      expect(b.listChanged()).toBe(0);
    },
  );
});

describe("mcp-bridge: state changes", () => {
  it("sends list_changed once per change, up -> down -> up -> down", async () => {
    const first = await fakeDpilot();
    const port = first.port;
    const b = bridge(urlFor(port));
    expect(toolNames(await b.request("tools/list"))).toEqual(["run_query"]);
    expect(b.listChanged()).toBe(0);

    await stop(first.server);
    expect((await run(b)).result.isError).toBe(true);
    expect(b.listChanged()).toBe(1);
    // Still down: more failures and polls are no change, so no notification.
    expect((await run(b)).result.isError).toBe(true);
    await new Promise((r) => setTimeout(r, 350)); // ~3 health polls
    expect(b.listChanged()).toBe(1);
    expect(toolNames(await b.request("tools/list"))).toEqual(["dpilot_status"]);

    const second = await fakeDpilot({ port });
    await vi.waitFor(() => expect(b.listChanged()).toBe(2), { timeout: 3000 });
    expect(toolNames(await b.request("tools/list"))).toEqual(["run_query"]);
    expect(callText(await run(b))).toBe("1 row");
    expect(b.listChanged()).toBe(2);

    await stop(second.server);
    expect((await run(b)).result.isError).toBe(true);
    expect(b.listChanged()).toBe(3);
  });

  it("recovers on its own when D-Pilot comes up after the bridge", async () => {
    const port = await freePort();
    const b = bridge(urlFor(port));
    expect(toolNames(await b.request("tools/list"))).toEqual(["dpilot_status"]);
    expect(b.listChanged()).toBe(0);
    await fakeDpilot({ port });
    await b.waitFor((m) => m.method === LIST_CHANGED);
    expect(toolNames(await b.request("tools/list"))).toEqual(["run_query"]);
  });

  it("derives the health URL under a BASE_PATH prefix", async () => {
    const { port, healthHits } = await fakeDpilot({ prefix: "/d-pilot" });
    const b = bridge(urlFor(port, "/d-pilot"));
    const r = await b.request("tools/call", { name: "dpilot_status" });
    expect(callText(r)).toBe(
      `D-Pilot at http://127.0.0.1:${port}/d-pilot is reachable; its tools are available.`,
    );
    expect(healthHits[0]).toBe("/d-pilot/api/health");
  });
});
