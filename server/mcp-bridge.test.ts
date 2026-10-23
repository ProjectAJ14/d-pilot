import { describe, it, expect, afterEach, vi } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
 * (anything else 404s).
 * `mcp` and `health` override the answers; leaving a response unended hangs.
 */
async function fakeDpilot(
  opts: {
    prefix?: string;
    /** Where the MCP endpoint is, when not `${prefix}/api/mcp`. */
    mcpPath?: string;
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
    if (req.url !== (opts.mcpPath ?? `${prefix}/api/mcp`))
      return res.writeHead(404).end();
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

  // A captive portal or VPN login page answers in place of D-Pilot.
  it.each([
    [200, "text/html", "<html>Sign in to the network</html>"],
    [200, "application/json", "null"],
    [202, undefined, ""],
  ])(
    "treats HTTP %i (%s) with no JSON-RPC answer as unreachable",
    async (status, type, body) => {
      const portal = (res: Res) =>
        res.writeHead(status, type ? { "content-type": type } : {}).end(body);
      const { port } = await fakeDpilot({
        mcp: (_m, res) => portal(res),
        health: portal,
      });
      const b = bridge(urlFor(port));
      const r = await run(b);
      expect(r.result.isError).toBe(true);
      expect(callText(r)).toMatch(UNREACHABLE);
      expect(callText(r)).toContain(
        "unexpected non-MCP response; a captive portal or VPN login page?",
      );
      expect(toolNames(await b.request("tools/list"))).toEqual([
        "dpilot_status",
      ]);
      // The health check gets the same page: still down, so no flapping.
      const status_ = await b.request("tools/call", { name: "dpilot_status" });
      expect(callText(status_)).toMatch(UNREACHABLE);
      expect(b.listChanged()).toBe(0);
    },
  );

  // A TLS-inspecting proxy or a private CA: configuration, not an outage.
  it("reports an untrusted certificate as configuration, and stops polling", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dpilot-tls-"));
    try {
      const gen = spawnSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-days",
          "1",
          "-subj",
          "/CN=127.0.0.1",
          "-keyout",
          join(dir, "key.pem"),
          "-out",
          join(dir, "cert.pem"),
        ],
        { encoding: "utf8" },
      );
      expect(gen.status, gen.stderr).toBe(0);
      let healthHits = 0;
      const server = https.createServer(
        {
          key: readFileSync(join(dir, "key.pem")),
          cert: readFileSync(join(dir, "cert.pem")),
        },
        (req, res) => {
          if (req.url === "/api/health") healthHits++;
          res.end("{}");
        },
      );
      servers.push(server as unknown as http.Server);
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const { port } = server.address() as AddressInfo;
      const b = bridge(`https://127.0.0.1:${port}/api/mcp`);
      const TLS =
        /certificate.*not trusted.*--use-system-ca.*--install-desktop.*NODE_EXTRA_CA_CERTS/s;
      const list = await b.request("tools/list");
      expect(list.error.message).toMatch(TLS);
      const call = await run(b);
      expect(call.result.isError).toBe(true);
      expect(callText(call)).toMatch(TLS);
      expect(callText(call)).not.toMatch(UNREACHABLE);
      const st = await b.request("tools/call", { name: "dpilot_status" });
      expect(callText(st)).toMatch(TLS);
      // No poll: only the startup probe and the dpilot_status one.
      await new Promise((r) => setTimeout(r, 350));
      expect(healthHits).toBe(0); // the handshake fails before any request
      expect(b.stderr()).not.toMatch(/poll/);
      // Node's own text never reaches the agent.
      expect(JSON.stringify(b.out)).not.toMatch(/self[- ]signed/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("joins an event's data lines with newlines, as SSE specifies", async () => {
    const { port } = await fakeDpilot({
      mcp: (msg, res) =>
        res
          .writeHead(200, { "content-type": "text/event-stream" })
          .end(
            [
              "event: message",
              'data: {"jsonrpc":"2.0",',
              `data: "id":${msg.id},`,
              'data:"result":{"content":[{"type":"text","text":"1 row"}]}}',
              "",
              "",
            ].join("\n"),
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
    [404, "text/html", "<h1>Not Found</h1>"],
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

  // A proxy remap or a typo in the path: /api/health 404s, D-Pilot is there.
  it("keeps the tools when the health check 404s but D-Pilot answers", async () => {
    const { port, healthHits } = await fakeDpilot({ mcpPath: "/tools/mcp" });
    // Health is derived as /tools/mcp/api/health, which 404s.
    const b = bridge(`http://127.0.0.1:${port}/tools/mcp`);
    const st = await b.request("tools/call", { name: "dpilot_status" });
    expect(callText(st)).toMatch(/is reachable/);
    expect(toolNames(await b.request("tools/list"))).toEqual(["run_query"]);
    expect(healthHits).toEqual([]);
    expect(b.listChanged()).toBe(0);
  });

  it("tries D-Pilot on tools/list even while the health check says it is down", async () => {
    // Health answers 503 forever; the MCP endpoint is fine.
    const { port, posts } = await fakeDpilot({
      health: (res) => res.writeHead(503).end(),
    });
    const b = bridge(urlFor(port), { DPILOT_BRIDGE_POLL_MS: "60000" });
    const st = await b.request("tools/call", { name: "dpilot_status" });
    expect(callText(st)).toMatch(UNREACHABLE);
    expect(toolNames(await b.request("tools/list"))).toEqual(["run_query"]);
    expect(posts.map((p) => p.msg.method)).toEqual(["tools/list"]);
    expect(b.listChanged()).toBe(1);
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

describe("mcp-bridge: --install-desktop", () => {
  const URL_ = "https://d-pilot.example.com/d-pilot/api/mcp";
  const B64 = AUTH.slice("Basic ".length);
  const dirs: string[] = [];
  afterEach(() =>
    dirs.splice(0).forEach((d) => rmSync(d, { recursive: true })),
  );
  const scratch = () => {
    const d = mkdtempSync(join(tmpdir(), "dpilot-desktop-"));
    dirs.push(d);
    return d;
  };
  const install = (
    file: string,
    args = [URL_, AUTH],
    env: Record<string, string> = {},
  ) => {
    const fakeHome = scratch();
    const r = spawnSync(
      process.execPath,
      [BRIDGE, "--install-desktop", ...args],
      {
        env: {
          ...process.env,
          // A fake home too, so a broken override can never reach the real
          // Claude Desktop config (one mutation run did, before this).
          HOME: fakeHome,
          APPDATA: fakeHome,
          USERPROFILE: fakeHome,
          DPILOT_DESKTOP_CONFIG: file,
          // No node on PATH unless a test puts one there: the entry then
          // records this node's own path.
          PATH: fakeHome,
          ...env,
        },
        // A Windows path computed on POSIX (a faked win32 platform) is one
        // relative file name: if a bug ever writes one, it lands here.
        cwd: fakeHome,
        encoding: "utf8",
      },
    );
    // The credential never reaches the terminal, whatever happened.
    expect(r.stdout + r.stderr).not.toContain(B64);
    return r;
  };
  const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));
  // Node 22.15+/23.8+ can trust the OS certificate store; the entry asks it to.
  const SYSTEM_CA = process.allowedNodeEnvironmentFlags.has("--use-system-ca");
  const ENTRY = {
    command: process.execPath,
    args: SYSTEM_CA ? ["--use-system-ca", BRIDGE] : [BRIDGE],
    env: { DPILOT_MCP_URL: URL_, DPILOT_MCP_AUTH: AUTH },
  };

  it("creates the file and its directory, pointing at this node and this file", () => {
    const file = join(scratch(), "a", "b", "claude_desktop_config.json");
    const r = install(file);
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(
      `${JSON.stringify({ mcpServers: { "d-pilot": ENTRY } }, null, 2)}\n`,
    );
    expect(isAbsolute(read(file).mcpServers["d-pilot"].args.at(-1))).toBe(true);
    expect(existsSync(`${file}.bak`)).toBe(false);
    expect(r.stdout).toContain(file);
    expect(r.stdout).toContain("https://d-pilot.example.com");
    expect(r.stdout).toMatch(/Start Claude Desktop/);
    expect(r.stdout).toMatch(/quit it fully.*run this again/s);
    // No pgrep/tasklist on the fake PATH: no way to tell, so no warning.
    expect(r.stderr).not.toMatch(/looks like it is running/);
    expect(readdirSync(dirname(file))).toEqual(["claude_desktop_config.json"]);
  });

  // It holds the credential, and every other server's.
  it.skipIf(process.platform === "win32")(
    "writes the config owner-only, new or replaced",
    () => {
      const file = join(scratch(), "claude_desktop_config.json");
      expect(install(file).status).toBe(0);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      writeFileSync(file, "{}", { mode: 0o644 });
      expect(install(file).status).toBe(0);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    },
  );

  // A dotfiles setup links the config into a repo; replacing the link with a
  // plain file would silently fork the two.
  it.skipIf(process.platform === "win32")(
    "writes through a symlinked config to the real file",
    () => {
      const realDir = scratch();
      const real = join(realDir, "real.json");
      writeFileSync(real, JSON.stringify({ theme: "dark" }));
      const link = join(scratch(), "claude_desktop_config.json");
      symlinkSync(real, link);
      const r = install(link);
      expect(r.status, r.stderr).toBe(0);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(read(real)).toEqual({
        theme: "dark",
        mcpServers: { "d-pilot": ENTRY },
      });
      // Backup and temp file beside the real file; nothing left behind.
      expect(readdirSync(realDir).sort()).toEqual([
        "real.json",
        "real.json.bak",
      ]);
      expect(readdirSync(dirname(link))).toEqual([
        "claude_desktop_config.json",
      ]);
    },
  );

  // Homebrew's node is a versioned Cellar path that an upgrade deletes; the
  // PATH entry pointing at it survives.
  it.skipIf(process.platform === "win32")(
    "records the node on PATH when it is this node, not the path it resolves to",
    () => {
      const bin = scratch();
      symlinkSync(process.execPath, join(bin, "node"));
      const file = join(scratch(), "claude_desktop_config.json");
      expect(
        install(file, undefined, { PATH: `${scratch()}:${bin}` }).status,
      ).toBe(0);
      expect(read(file).mcpServers["d-pilot"].command).toBe(join(bin, "node"));
    },
  );

  it.skipIf(process.platform === "win32")(
    "records this node when PATH's node is a different binary",
    () => {
      const bin = scratch();
      copyFileSync(process.execPath, join(bin, "node"));
      const file = join(scratch(), "claude_desktop_config.json");
      expect(install(file, undefined, { PATH: bin }).status).toBe(0);
      expect(read(file).mcpServers["d-pilot"].command).toBe(process.execPath);
    },
  );

  // It rewrites its config while it runs, so this edit would be lost. A fake
  // pgrep/tasklist on PATH stands in for the real one; the platform is faked
  // so both run on any OS.
  it.skipIf(process.platform === "win32").each([
    ["darwin", "pgrep", "echo 4242"],
    ["win32", "tasklist", "echo 'claude.exe   4242 Console   1   90,000 K'"],
  ])(
    "warns, on %s, when Claude Desktop looks like it is running",
    (platform, tool, script) => {
      const bin = scratch();
      writeFileSync(join(bin, tool), `#!/bin/sh\n${script}\n`, {
        mode: 0o755,
      });
      const file = join(scratch(), "claude_desktop_config.json");
      const as = `data:text/javascript,Object.defineProperty(process,'platform',{value:'${platform}'})`;
      const r = install(file, [URL_, AUTH], {
        PATH: bin,
        NODE_OPTIONS: `--import=${as}`,
      });
      expect(r.status, r.stderr).toBe(0);
      expect(read(file).mcpServers["d-pilot"].env.DPILOT_MCP_URL).toBe(URL_);
      expect(r.stderr).toMatch(/Claude Desktop looks like it is running/);
      expect(r.stderr).toMatch(/quit it fully.*run this again/s);
    },
  );

  // Claude Desktop's folder is under %APPDATA%; without it there is no path.
  it("exits 1 on Windows without APPDATA, saying what to set", () => {
    const fakeHome = scratch();
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      PATH: fakeHome,
      // Empty, so the default path is computed: this is what is under test.
      DPILOT_DESKTOP_CONFIG: "",
    };
    delete env.APPDATA;
    const asWindows =
      "data:text/javascript,Object.defineProperty(process,'platform',{value:'win32'})";
    const r = spawnSync(
      process.execPath,
      ["--import", asWindows, BRIDGE, "--install-desktop", URL_, AUTH],
      { env, cwd: fakeHome, encoding: "utf8" },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/APPDATA is not set.*DPILOT_DESKTOP_CONFIG/s);
    expect(r.stderr).not.toMatch(/TypeError/);
    expect(r.stdout).toBe("");
    expect(readdirSync(fakeHome)).toEqual([]);
  });

  it("merges: other servers and keys are kept, and the original is backed up", () => {
    const file = join(scratch(), "claude_desktop_config.json");
    const before = JSON.stringify(
      { globalShortcut: "Ctrl+Space", mcpServers: { other: { command: "x" } } },
      null,
      4,
    );
    writeFileSync(file, before);
    const r = install(file);
    expect(r.status, r.stderr).toBe(0);
    expect(read(file)).toEqual({
      globalShortcut: "Ctrl+Space",
      mcpServers: { other: { command: "x" }, "d-pilot": ENTRY },
    });
    expect(readFileSync(`${file}.bak`, "utf8")).toBe(before);
    expect(r.stdout).toContain(`${file}.bak`);
  });

  // The backup holds every other server's credentials too.
  it.skipIf(process.platform === "win32")(
    "writes the backup owner-only, even over an older world-readable one",
    () => {
      const file = join(scratch(), "claude_desktop_config.json");
      writeFileSync(file, "{}");
      writeFileSync(`${file}.bak`, "old", { mode: 0o644 });
      expect(install(file).status).toBe(0);
      expect(statSync(`${file}.bak`).mode & 0o777).toBe(0o600);
      expect(readFileSync(`${file}.bak`, "utf8")).toBe("{}");
    },
  );

  it("replaces an existing d-pilot entry, and starts mcpServers when absent", () => {
    const file = join(scratch(), "claude_desktop_config.json");
    writeFileSync(file, JSON.stringify({ theme: "dark" }));
    expect(install(file).status).toBe(0);
    expect(read(file)).toEqual({
      theme: "dark",
      mcpServers: { "d-pilot": ENTRY },
    });
    const other = "Basic b3RoZXI6cHc=";
    expect(install(file, [URL_, other]).status).toBe(0);
    expect(read(file).mcpServers["d-pilot"].env.DPILOT_MCP_AUTH).toBe(other);
    expect(Object.keys(read(file).mcpServers)).toEqual(["d-pilot"]);
  });

  it.each([
    ["invalid JSON", "{ not json", /not valid JSON/],
    ["a non-object root", "[1, 2]", /does not hold a JSON object/],
    ["a null root", "null", /does not hold a JSON object/],
    [
      "a non-object mcpServers",
      '{"mcpServers": "x"}',
      /does not hold a JSON object/,
    ],
  ])("%s: exits 1 and changes nothing", (_n, content, msg) => {
    const file = join(scratch(), "claude_desktop_config.json");
    writeFileSync(file, content);
    const r = install(file);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(msg);
    expect(r.stderr).toMatch(/[Nn]othing was changed/);
    expect(readFileSync(file, "utf8")).toBe(content);
    expect(readdirSync(dirname(file))).toEqual(["claude_desktop_config.json"]);
  });

  it.each([
    ["an invalid URL", ["not a url", AUTH], /The URL is not a valid URL/],
    [
      "a URL with userinfo",
      [`https://agent:${B64}@d-pilot.example.com/api/mcp`, AUTH],
      /must not contain a username or password/,
    ],
    ["no authorization", [URL_], /must be "Basic <base64/],
    [
      "a Bearer authorization",
      [URL_, `Bearer ${B64}`],
      /must be "Basic <base64/,
    ],
    ["a bare base64 token", [URL_, B64], /must be "Basic <base64/],
    ["trailing junk", [URL_, `${AUTH} x`], /must be "Basic <base64/],
  ])("refuses %s, writing nothing and echoing nothing", (_n, args, msg) => {
    const dir = scratch();
    const r = install(join(dir, "claude_desktop_config.json"), args);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(msg);
    expect(r.stdout).toBe("");
    expect(r.stderr).not.toContain("not a url");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("does nothing when imported rather than run", () => {
    const r = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(pathToFileURL(BRIDGE).href)})`,
      ],
      { env: { ...process.env, DPILOT_MCP_URL: "" }, encoding: "utf8" },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout + r.stderr).toBe("");
  });
});

// Called in a child, like everything else here, so c8 sees it run.
describe("mcp-bridge: desktopConfigPath", () => {
  const LAD = "C:\\Users\\a\\AppData\\Local";
  const PKGS = `${LAD}\\Packages`;
  const ROAMING = "C:\\Users\\a\\AppData\\Roaming";
  const APPDATA_FILE = `${ROAMING}\\Claude\\claude_desktop_config.json`;
  const storeDir = (pkg: string) =>
    `${PKGS}\\${pkg}\\LocalCache\\Roaming\\Claude`;
  const storeFile = (pkg: string) =>
    `${storeDir(pkg)}\\claude_desktop_config.json`;
  const WIN = { APPDATA: ROAMING, LOCALAPPDATA: LAD };
  /**
   * [platform, env, Packages listing (null: no such dir), paths that exist,
   * expected]. The fs is injected, so Windows paths work on any OS.
   */
  const CASES: [string, object, string[] | null, string[], object][] = [
    ["win32", { APPDATA: ROAMING }, null, [], { file: APPDATA_FILE }],
    [
      "darwin",
      {},
      null,
      [],
      {
        file: "/Users/a/Library/Application Support/Claude/claude_desktop_config.json",
      },
    ],
    [
      "linux",
      {},
      null,
      [],
      { file: "/Users/a/.config/Claude/claude_desktop_config.json" },
    ],
    [
      "win32",
      { DPILOT_DESKTOP_CONFIG: "/x/y.json" },
      null,
      [],
      { file: "/x/y.json" },
    ],
    ["win32", {}, null, [], { file: null }],
    // The Microsoft Store build: its config lives in the package's virtualized AppData.
    [
      "win32",
      WIN,
      ["Microsoft.Foo_8wekyb3d8bbwe", "Claude_pzs8sxrjxfjjc"],
      [storeDir("Claude_pzs8sxrjxfjjc")],
      {
        file: storeFile("Claude_pzs8sxrjxfjjc"),
        store: { name: "Claude_pzs8sxrjxfjjc", count: 1 },
      },
    ],
    // No Packages dir, or no Claude_ package with a Roaming\Claude inside.
    ["win32", WIN, null, [], { file: APPDATA_FILE }],
    [
      "win32",
      WIN,
      ["Claude_abc", "Other_Claude_x"],
      // Claude_abc has no Roaming\Claude; Other_Claude_x does, but isn't Claude_*.
      [storeDir("Other_Claude_x")],
      { file: APPDATA_FILE },
    ],
    // Several: the first (sorted) whose config exists, else the first.
    [
      "win32",
      WIN,
      ["Claude_c", "Claude_a", "Claude_b"],
      [
        storeDir("Claude_a"),
        storeDir("Claude_b"),
        storeDir("Claude_c"),
        storeFile("Claude_c"),
      ],
      { file: storeFile("Claude_c"), store: { name: "Claude_c", count: 3 } },
    ],
    [
      "win32",
      WIN,
      ["Claude_c", "Claude_a"],
      [storeDir("Claude_a"), storeDir("Claude_c")],
      { file: storeFile("Claude_a"), store: { name: "Claude_a", count: 2 } },
    ],
    // LOCALAPPDATA unset: APPDATA, without looking anywhere.
    [
      "win32",
      { APPDATA: ROAMING },
      ["Claude_a"],
      [storeDir("Claude_a")],
      { file: APPDATA_FILE },
    ],
    // The override beats the Store copy.
    [
      "win32",
      { ...WIN, DPILOT_DESKTOP_CONFIG: "D:\\c.json" },
      ["Claude_a"],
      [storeDir("Claude_a")],
      { file: "D:\\c.json" },
    ],
    // Only Windows has Store packages.
    [
      "darwin",
      WIN,
      ["Claude_a"],
      [storeDir("Claude_a")],
      {
        file: "/Users/a/Library/Application Support/Claude/claude_desktop_config.json",
      },
    ],
  ];

  it("knows each OS's default, the Microsoft Store copy, and honours the override", () => {
    const code = `const { desktopConfigPath } = await import(${JSON.stringify(pathToFileURL(BRIDGE).href)});
      const cases = ${JSON.stringify(CASES)};
      console.log(JSON.stringify(cases.map(([p, env, listing, existing]) =>
        desktopConfigPath(p, env, "/Users/a", {
          readdirSync: (d) => {
            if (d !== ${JSON.stringify(PKGS)} || !listing) throw new Error("ENOENT");
            return listing;
          },
          existsSync: (f) => existing.includes(f),
        }))));`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(CASES.map((c) => c[4]));
  });

  it("names the Store version, and which package when there are several", () => {
    const code = `const { describeConfig } = await import(${JSON.stringify(pathToFileURL(BRIDGE).href)});
      console.log(JSON.stringify([
        describeConfig({ file: "/a.json" }),
        describeConfig({ file: "C:\\\\s.json", store: { name: "Claude_x", count: 1 } }),
        describeConfig({ file: "C:\\\\s.json", store: { name: "Claude_x", count: 2 } }),
      ]));`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([
      "/a.json",
      "C:\\s.json (Microsoft Store version)",
      "C:\\s.json (Microsoft Store version; package Claude_x, of 2 Claude_* packages)",
    ]);
  });
});

describe("mcp-bridge: desktopRunning and desktopArgs", () => {
  it("asks tasklist (Windows) or pgrep (macOS), with no shell, and never fails", () => {
    const code = `const { desktopRunning } = await import(${JSON.stringify(pathToFileURL(BRIDGE).href)});
      const calls = [];
      const fake = (out) => (cmd, args, opts) => {
        calls.push([cmd, args, !!opts.shell]);
        if (out instanceof Error) throw out;
        return out;
      };
      const results = [
        desktopRunning("win32", fake("claude.exe    4242 Console   1   90,000 K\\r\\n")),
        desktopRunning("win32", fake("INFO: No tasks are running which match the specified criteria.\\r\\n")),
        desktopRunning("win32", fake(new Error("ENOENT"))),
        desktopRunning("darwin", fake("4242\\n")),
        desktopRunning("darwin", fake(new Error("exit 1"))),
        desktopRunning("linux", fake("4242\\n")),
      ];
      console.log(JSON.stringify({ results, calls }));`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
    const TASKLIST = [
      "tasklist",
      ["/FI", "IMAGENAME eq claude.exe", "/NH"],
      false,
    ];
    const PGREP = ["pgrep", ["-x", "Claude"], false];
    expect(JSON.parse(r.stdout)).toEqual({
      results: [true, false, false, true, false, false],
      // Linux: no check at all.
      calls: [TASKLIST, TASKLIST, TASKLIST, PGREP, PGREP],
    });
  });

  it("adds --use-system-ca only when this node supports it", () => {
    const code = `const { desktopArgs } = await import(${JSON.stringify(pathToFileURL(BRIDGE).href)});
      console.log(JSON.stringify([desktopArgs("/b.mjs", true), desktopArgs("/b.mjs", false), desktopArgs("/b.mjs")]));`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
    const supported =
      process.allowedNodeEnvironmentFlags.has("--use-system-ca");
    expect(JSON.parse(r.stdout)).toEqual([
      ["--use-system-ca", "/b.mjs"],
      ["/b.mjs"],
      supported ? ["--use-system-ca", "/b.mjs"] : ["/b.mjs"],
    ]);
  });

  // Really a node CLI flag here, not just a name in allowedNodeEnvironmentFlags.
  it.skipIf(!process.allowedNodeEnvironmentFlags.has("--use-system-ca"))(
    "starts node with --use-system-ca",
    () => {
      const r = spawnSync(
        process.execPath,
        ["--use-system-ca", "-e", "console.log(process.execArgv[0])"],
        { encoding: "utf8" },
      );
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.trim()).toBe("--use-system-ca");
    },
  );
});

describe("mcp-bridge: stableNodePath", () => {
  it("finds node on PATH the way the OS does, and keeps it only when it is this node", () => {
    const bin = mkdtempSync(join(tmpdir(), "dpilot-path-"));
    const other = mkdtempSync(join(tmpdir(), "dpilot-path-"));
    try {
      symlinkSync(process.execPath, join(bin, "node"));
      symlinkSync(process.execPath, join(bin, "node.EXE"));
      writeFileSync(join(other, "node"), "not node");
      writeFileSync(join(other, "node.CMD"), "not node");
      const self = process.execPath;
      const CASES = [
        ["darwin", { PATH: `:${bin}` }, join(bin, "node")],
        ["linux", { PATH: `${other}:${bin}` }, self],
        ["linux", {}, self],
        ["linux", { PATH: "/nowhere" }, self],
        // Windows: ';'-separated, and each PATHEXT extension in order.
        [
          "win32",
          { PATH: `${bin}`, PATHEXT: ".COM;.EXE" },
          join(bin, "node.EXE"),
        ],
        ["win32", { PATH: `${other};${bin}`, PATHEXT: ".CMD;.EXE" }, self],
        ["win32", { PATH: bin }, join(bin, "node.EXE")],
      ];
      const code = `const { stableNodePath } = await import(${JSON.stringify(pathToFileURL(BRIDGE).href)});
        const cases = ${JSON.stringify(CASES)};
        console.log(JSON.stringify(cases.map(([p, env]) => stableNodePath(p, env, process.execPath))));`;
      const r = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", code],
        { encoding: "utf8" },
      );
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual(CASES.map((c) => c[2]));
    } finally {
      rmSync(bin, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });
  // Windows realpath keeps the case it was given: PATHEXT's node.EXE is the
  // same file as execPath's node.exe. Elsewhere case still matters.
  it("matches node.EXE to node.exe on Windows only", () => {
    const code = `const { stableNodePath } = await import(${JSON.stringify(pathToFileURL(BRIDGE).href)});
      const real = (p) => { if (/node(\\.exe)?$/i.test(p)) return p; throw new Error("ENOENT"); };
      console.log(JSON.stringify([
        stableNodePath("win32", { PATH: "/opt/node", PATHEXT: ".COM;.EXE" }, "/opt/node/node.exe", real),
        stableNodePath("linux", { PATH: "/opt/node" }, "/opt/NODE/node", real),
      ]));`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([
      "/opt/node/node.EXE",
      "/opt/NODE/node",
    ]);
  });
});
