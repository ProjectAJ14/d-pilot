import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

/**
 * In-process twin of mcp-bridge.test.ts: that file drives the bridge as a child
 * process (the real thing), this one imports it into the test process with a
 * fake stdin/stdout/fetch, so every branch is reachable and measurable.
 */
const exec = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFileSync: exec }));

const BRIDGE = fileURLToPath(
  new URL("../public/mcp-bridge.mjs", import.meta.url),
);
const AUTH = "Basic YWdlbnRAZXhhbXBsZS5jb206cHc=";
const MCP_URL = "https://dpilot.example.test/api/mcp";
const HEALTH = "https://dpilot.example.test/api/health";
const UNREACHABLE = /can't be reached from this machine/;

type Bridge = {
  parseMcpUrl: (raw: string, name: string) => URL | string;
  desktopConfigPath: (
    platform: string,
    env: Record<string, string | undefined>,
    home: string,
    fs?: {
      readdirSync: (p: string) => string[];
      existsSync: (p: string) => boolean;
    },
  ) => { file: string | null; store?: { name: string; count: number } };
  describeConfig: (t: {
    file: string;
    store?: { name: string; count: number };
  }) => string;
  desktopRunning: (platform: string, exec?: unknown) => boolean;
  desktopArgs: (bridge: string, systemCa?: boolean) => string[];
  stableNodePath: (
    platform: string,
    env: Record<string, string | undefined>,
    execPath: string,
    realpath?: (p: string) => string,
  ) => string;
};

class ExitError extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}

const saved = {
  argv: process.argv,
  env: { ...process.env },
  stdin: Object.getOwnPropertyDescriptor(process, "stdin")!,
  platform: Object.getOwnPropertyDescriptor(process, "platform")!,
};
let exits: number[];
let out: string[];
let errors: string[];
let logs: string[];
let fetchMock: ReturnType<typeof vi.fn>;
let stdin: PassThrough;

beforeEach(() => {
  exits = [];
  out = [];
  errors = [];
  logs = [];
  exec.mockReset();
  vi.spyOn(process, "exit").mockImplementation(((code: number) => {
    exits.push(code);
    if (code) throw new ExitError(code);
  }) as never);
  vi.spyOn(process.stdout, "write").mockImplementation(((s: string) => {
    out.push(s);
    return true;
  }) as never);
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    errors.push(a.join(" "));
  });
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.join(" "));
  });
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  stdin = new PassThrough();
  Object.defineProperty(process, "stdin", {
    value: stdin,
    configurable: true,
  });
  for (const k of Object.keys(process.env))
    if (k.startsWith("DPILOT_")) delete process.env[k];
});

afterEach(async () => {
  // Let readline see the end (and call the mocked exit) before exit is restored.
  stdin.end();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  process.argv = saved.argv;
  process.env = { ...saved.env };
  Object.defineProperty(process, "stdin", saved.stdin);
  Object.defineProperty(process, "platform", saved.platform);
});

/** Imports a fresh copy of the bridge as if run as `node mcp-bridge.mjs ...args`. */
async function run(args: string[] = []): Promise<Bridge> {
  process.argv = [process.execPath, BRIDGE, ...args];
  vi.resetModules();
  return (await import(/* @vite-ignore */ BRIDGE)) as Bridge;
}

const tick = () => new Promise((r) => setImmediate(r));
const messages = () => out.map((l) => JSON.parse(l) as Record<string, unknown>);
const byId = (id: unknown) => messages().find((m) => m.id === id);
const send = (m: unknown) => stdin.write(`${JSON.stringify(m)}\n`);
async function call(m: Record<string, unknown>) {
  send({ jsonrpc: "2.0", ...m });
  await vi.waitFor(() => expect(byId(m.id)).toBeDefined());
  return byId(m.id) as Record<string, unknown> & {
    result?: Record<string, unknown> & {
      content?: { text: string }[];
      tools?: { name: string }[];
    };
    error?: { code: number; message: string };
  };
}
const text = (m: Awaited<ReturnType<typeof call>>) =>
  m.result!.content![0].text;

const netErr = (code?: string, name = "TypeError") =>
  Object.assign(new Error(`fetch failed ${AUTH}`), {
    name,
    cause: code ? { code } : undefined,
  });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const html = (status: number) =>
  new Response("<html>login</html>", {
    status,
    headers: { "content-type": "text/html" },
  });

/** Routes fetch: `health` answers the probe, `mcp` answers forwarded messages. */
function upstream(
  health: () => Promise<Response> | Response,
  mcp: (msg: { id: unknown; method: string }) => Promise<Response> | Response,
) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
    url === HEALTH ? health() : mcp(JSON.parse(String(init!.body))),
  );
}

async function serve(env: Record<string, string> = {}) {
  process.env.DPILOT_MCP_URL = MCP_URL;
  process.env.DPILOT_MCP_AUTH = AUTH;
  Object.assign(process.env, env);
  await run();
  await tick();
  await tick();
}

describe("mcp-bridge (in-process): importing", () => {
  it("does nothing when imported rather than run, or with no argv[1]", async () => {
    process.argv = [process.execPath];
    vi.resetModules();
    const mod = (await import(/* @vite-ignore */ BRIDGE)) as Bridge;
    expect(typeof mod.parseMcpUrl).toBe("function");
    process.argv = [process.execPath, fileURLToPath(import.meta.url)];
    vi.resetModules();
    await import(/* @vite-ignore */ BRIDGE);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out).toEqual([]);
  });
});

describe("mcp-bridge (in-process): helpers", () => {
  let b: Bridge;
  beforeEach(async () => {
    process.argv = [process.execPath, "/nonexistent-not-the-bridge"];
    process.argv[1] = fileURLToPath(import.meta.url);
    vi.resetModules();
    b = (await import(/* @vite-ignore */ BRIDGE)) as Bridge;
  });

  it("parseMcpUrl rejects non-URLs and userinfo, without echoing the input", () => {
    expect(b.parseMcpUrl("nope secret", "X")).toBe("X is not a valid URL.");
    expect(b.parseMcpUrl("https://u:secret@h.test/", "X")).toMatch(
      /^X must not contain a username or password/,
    );
    expect(b.parseMcpUrl("https://:secret@h.test/", "X")).toMatch(
      /must not contain/,
    );
    expect((b.parseMcpUrl(MCP_URL, "X") as URL).origin).toBe(
      "https://dpilot.example.test",
    );
  });

  it("desktopConfigPath covers the override, each OS, and the Store copy", () => {
    expect(
      b.desktopConfigPath("linux", { DPILOT_DESKTOP_CONFIG: "/x" }, "/h"),
    ).toEqual({ file: "/x" });
    expect(b.desktopConfigPath("darwin", {}, "/h").file).toBe(
      "/h/Library/Application Support/Claude/claude_desktop_config.json",
    );
    expect(b.desktopConfigPath("linux", {}, "/h").file).toBe(
      "/h/.config/Claude/claude_desktop_config.json",
    );
    // Windows, no LOCALAPPDATA: APPDATA or nothing.
    expect(b.desktopConfigPath("win32", { APPDATA: "C:\\A" }, "/h").file).toBe(
      "C:\\A\\Claude\\claude_desktop_config.json",
    );
    expect(b.desktopConfigPath("win32", {}, "/h").file).toBeNull();
    // LOCALAPPDATA without a Packages folder.
    const noPackages = {
      readdirSync: () => {
        throw new Error("ENOENT");
      },
      existsSync: () => false,
    };
    expect(
      b.desktopConfigPath("win32", { LOCALAPPDATA: "C:\\L" }, "/h", noPackages)
        .file,
    ).toBeNull();
    // Packages, but no Claude one with a Roaming\Claude dir.
    const pkgs = (have: string[]) => ({
      readdirSync: () => ["Other_1", "Claude_b", "claude_a"],
      existsSync: (p: string) => have.includes(p),
    });
    const dir = (n: string) =>
      win32.join("C:\\L", "Packages", n, "LocalCache", "Roaming", "Claude");
    const cfg = (n: string) => win32.join(dir(n), "claude_desktop_config.json");
    expect(
      b.desktopConfigPath(
        "win32",
        { LOCALAPPDATA: "C:\\L", APPDATA: "C:\\A" },
        "/h",
        pkgs([]),
      ).file,
    ).toBe("C:\\A\\Claude\\claude_desktop_config.json");
    // Two packages, neither has a config yet: the first, sorted.
    expect(
      b.desktopConfigPath(
        "win32",
        { LOCALAPPDATA: "C:\\L" },
        "/h",
        pkgs([dir("Claude_b"), dir("claude_a")]),
      ),
    ).toEqual({ file: cfg("Claude_b"), store: { name: "Claude_b", count: 2 } });
    // The one that already has a config wins.
    expect(
      b.desktopConfigPath(
        "win32",
        { LOCALAPPDATA: "C:\\L" },
        "/h",
        pkgs([dir("Claude_b"), dir("claude_a"), cfg("claude_a")]),
      ),
    ).toEqual({ file: cfg("claude_a"), store: { name: "claude_a", count: 2 } });
  });

  it("describeConfig names the Store version and the package when ambiguous", () => {
    expect(b.describeConfig({ file: "/f" })).toBe("/f");
    expect(
      b.describeConfig({ file: "/f", store: { name: "Claude_x", count: 1 } }),
    ).toBe("/f (Microsoft Store version)");
    expect(
      b.describeConfig({ file: "/f", store: { name: "Claude_x", count: 3 } }),
    ).toBe(
      "/f (Microsoft Store version; package Claude_x, of 3 Claude_* packages)",
    );
  });

  it("desktopRunning asks tasklist or pgrep and never throws", () => {
    const fake = vi.fn();
    fake.mockReturnValueOnce("claude.exe  1234 Console");
    expect(b.desktopRunning("win32", fake)).toBe(true);
    expect(fake.mock.calls[0][0]).toBe("tasklist");
    fake.mockReturnValueOnce("INFO: No tasks are running");
    expect(b.desktopRunning("win32", fake)).toBe(false);
    fake.mockReturnValueOnce("4321\n");
    expect(b.desktopRunning("darwin", fake)).toBe(true);
    expect(fake.mock.calls[2].slice(0, 2)).toEqual(["pgrep", ["-x", "Claude"]]);
    fake.mockImplementationOnce(() => {
      throw new Error("exit 1");
    });
    expect(b.desktopRunning("darwin", fake)).toBe(false);
    expect(b.desktopRunning("linux", fake)).toBe(false);
    expect(fake).toHaveBeenCalledTimes(4);
    // The default exec is node's execFileSync (mocked here).
    exec.mockReturnValueOnce("1");
    expect(b.desktopRunning("darwin")).toBe(true);
  });

  it("desktopArgs adds --use-system-ca only when supported", () => {
    expect(b.desktopArgs("/b.mjs", true)).toEqual([
      "--use-system-ca",
      "/b.mjs",
    ]);
    expect(b.desktopArgs("/b.mjs", false)).toEqual(["/b.mjs"]);
    expect(b.desktopArgs("/b.mjs")).toEqual(
      process.allowedNodeEnvironmentFlags.has("--use-system-ca")
        ? ["--use-system-ca", "/b.mjs"]
        : ["/b.mjs"],
    );
  });

  it("stableNodePath keeps PATH's node only when it is this node", () => {
    const rp = (map: Record<string, string>) => (p: string) => {
      if (p in map) return map[p];
      throw new Error("ENOENT");
    };
    // POSIX: first dir lacks node, second resolves to this binary.
    expect(
      b.stableNodePath(
        "darwin",
        { PATH: "/a::/opt/bin" },
        "/cellar/1/node",
        rp({
          "/cellar/1/node": "/cellar/1/node",
          "/opt/bin/node": "/cellar/1/node",
        }),
      ),
    ).toBe("/opt/bin/node");
    // A different node first on PATH: keep execPath.
    expect(
      b.stableNodePath(
        "linux",
        { PATH: "/usr/bin" },
        "/x/node",
        rp({ "/x/node": "/x/node", "/usr/bin/node": "/usr/bin/node" }),
      ),
    ).toBe("/x/node");
    // No PATH at all.
    expect(b.stableNodePath("linux", {}, "/x/node", (p) => p)).toBe("/x/node");
    // Windows: default PATHEXT, case-insensitive match.
    const winNode = join("C:\\n", "node.EXE");
    expect(
      b.stableNodePath(
        "win32",
        { PATH: "C:\\n" },
        "C:\\n\\node.exe",
        rp({
          "C:\\n\\node.exe": "C:\\N\\NODE.exe",
          [winNode]: "c:\\n\\node.EXE",
        }),
      ),
    ).toBe(winNode);
    // Windows with PATHEXT whose entries are all missing.
    expect(
      b.stableNodePath(
        "win32",
        { PATH: "C:\\n", PATHEXT: ".COM;.BAT" },
        "C:\\n\\node.exe",
        rp({ "C:\\n\\node.exe": "C:\\n\\node.exe" }),
      ),
    ).toBe("C:\\n\\node.exe");
  });
});

describe("mcp-bridge (in-process): startup", () => {
  it("exits 1 without DPILOT_MCP_URL / DPILOT_MCP_AUTH", async () => {
    await expect(run()).rejects.toThrow(ExitError);
    expect(exits).toEqual([1]);
    expect(errors.join("\n")).toMatch(/Set DPILOT_MCP_URL and DPILOT_MCP_AUTH/);
    process.env.DPILOT_MCP_URL = MCP_URL;
    await expect(run()).rejects.toThrow(ExitError);
  });

  it("exits 1 on a bad URL without echoing it", async () => {
    process.env.DPILOT_MCP_AUTH = AUTH;
    process.env.DPILOT_MCP_URL = "https://user:hunter2@dpilot.example.test/";
    await expect(run()).rejects.toThrow(ExitError);
    expect(errors.join("\n")).toMatch(/must not contain a username/);
    expect(errors.join("\n")).not.toContain("hunter2");
  });

  it("exits 0 when stdin closes", async () => {
    upstream(
      () => json({ status: "ok" }),
      () => json({}),
    );
    await serve();
    stdin.end();
    await vi.waitFor(() => expect(exits).toEqual([0]));
  });
});

describe("mcp-bridge (in-process): reachable", () => {
  it("answers locally, forwards the rest, and handles junk lines", async () => {
    upstream(
      () => json({ status: "ok" }),
      (m) => {
        if (m.method === "tools/list")
          return json({ jsonrpc: "2.0", id: m.id, result: { tools: [] } });
        if (m.method === "tools/call")
          return new Response(
            `event: message\ndata: {"jsonrpc":"2.0","id":0}\n\ndata: {"jsonrpc":"2.0",\ndata: "id":${m.id},"result":{"ok":1}}\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          );
        return json([{ jsonrpc: "2.0", id: m.id, result: { arr: true } }]);
      },
    );
    // Wrapped credential, as GNU base64 emits it.
    await serve({ DPILOT_MCP_AUTH: "Basic YWdlbnRAZXhh\n  bXBsZS5jb206cHc=" });
    expect(fetchMock).toHaveBeenCalledWith(HEALTH, expect.anything());

    stdin.write("\n   \n");
    stdin.write("not json\n");
    stdin.write("[1]\n");
    stdin.write("null\n");
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await vi.waitFor(() => expect(out).toHaveLength(3));
    expect(messages().map((m) => (m.error as { code: number }).code)).toEqual([
      -32700, -32600, -32600,
    ]);

    const init = await call({
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    expect(init.result!.protocolVersion).toBe("2025-06-18");
    expect(init.result!.capabilities).toEqual({ tools: { listChanged: true } });
    expect(
      (await call({ id: 2, method: "initialize" })).result!.protocolVersion,
    ).toBe("2025-11-25");
    expect(
      (
        await call({
          id: 3,
          method: "initialize",
          params: { protocolVersion: "1999" },
        })
      ).result!.protocolVersion,
    ).toBe("2025-11-25");
    expect((await call({ id: 4, method: "ping" })).result).toEqual({});

    const status = await call({
      id: 5,
      method: "tools/call",
      params: { name: "dpilot_status" },
    });
    expect(text(status)).toBe(
      "D-Pilot at https://dpilot.example.test is reachable; its tools are available.",
    );
    expect((await call({ id: 6, method: "tools/list" })).result).toEqual({
      tools: [],
    });
    expect(
      (await call({ id: 7, method: "tools/call", params: { name: "run" } }))
        .result,
    ).toEqual({ ok: 1 });
    expect((await call({ id: 8, method: "resources/list" })).result).toEqual({
      arr: true,
    });

    const posts = fetchMock.mock.calls.filter(([u]) => u === MCP_URL);
    expect(posts).toHaveLength(3);
    expect((posts[0][1] as RequestInit).headers).toMatchObject({
      Authorization: AUTH,
    });
    // The notification was never forwarded.
    expect(
      posts.some((p) => String((p[1] as RequestInit).body).includes("notif")),
    ).toBe(false);
  });

  it("reports credentials, non-MCP errors and captive portals", async () => {
    let next: () => Response = () => json({});
    upstream(
      () => json({ status: "ok" }),
      () => next(),
    );
    await serve({
      DPILOT_MCP_URL: "https://dpilot.example.test/api/mcp/",
      DPILOT_BRIDGE_POLL_MS: "50",
      DPILOT_BRIDGE_TIMEOUT_MS: "1000",
    });

    next = () => new Response("Unauthorized", { status: 401 });
    expect((await call({ id: 1, method: "x" })).error!.message).toMatch(
      /rejected the credentials/,
    );
    next = () => new Response("Forbidden", { status: 403 });
    expect(
      text(await call({ id: 2, method: "tools/call", params: { name: "q" } })),
    ).toMatch(/rejected the credentials/);
    // No content-type header at all, and a non-ok status.
    next = () =>
      ({
        status: 500,
        ok: false,
        headers: new Headers(),
        text: async () => "oops",
      }) as Response;
    expect((await call({ id: 3, method: "x" })).error!.message).toBe(
      "D-Pilot answered HTTP 500 without an MCP response",
    );
    // `null` body: not JSON-RPC.
    next = () => json(null, 500);
    expect((await call({ id: 4, method: "x" })).error!.message).toMatch(
      /HTTP 500/,
    );
    // A 200 HTML page answered for D-Pilot: treated as unreachable.
    next = () => html(200);
    const list = await call({ id: 5, method: "tools/list" });
    expect(list.result!.tools!.map((t) => t.name)).toEqual(["dpilot_status"]);
    expect(messages()).toContainEqual({
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
    });
    const status = await call({
      id: 6,
      method: "tools/call",
      params: { name: "dpilot_status" },
    });
    // The health check says ok again, so it is reachable.
    expect(text(status)).toMatch(/is reachable/);
  });
});

describe("mcp-bridge (in-process): unreachable", () => {
  it("hides the tools, explains why, and recovers via the poller", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let health: () => Response | Promise<Response> = () => {
      throw netErr("ECONNREFUSED");
    };
    let mcp: () => Response | Promise<Response> = () => {
      throw netErr("ECONNREFUSED");
    };
    upstream(
      () => health(),
      () => mcp(),
    );
    await serve({ DPILOT_BRIDGE_POLL_MS: "1000" });
    expect(errors.join("\n")).toMatch(/unreachable \(ECONNREFUSED\)/);

    const list = await call({ id: 1, method: "tools/list" });
    expect(list.result!.tools!.map((t) => t.name)).toEqual(["dpilot_status"]);
    const callRes = await call({
      id: 2,
      method: "tools/call",
      params: { name: "q" },
    });
    expect(callRes.result!.isError).toBe(true);
    expect(text(callRes)).toMatch(UNREACHABLE);
    expect((await call({ id: 3, method: "x" })).error).toMatchObject({
      code: -32603,
      message: expect.stringMatching(UNREACHABLE),
    });
    const status = await call({
      id: 4,
      method: "tools/call",
      params: { name: "dpilot_status" },
    });
    expect(text(status)).toMatch(/\(ECONNREFUSED\)/);
    // Still down: no list_changed yet (no state change).
    expect(messages().some((m) => m.method)).toBe(false);

    // Timeout on the poll: still down, now "no response".
    health = () => {
      throw netErr(undefined, "TimeoutError");
    };
    await vi.advanceTimersByTimeAsync(1000);
    expect(
      text(
        await call({
          id: 5,
          method: "tools/call",
          params: { name: "dpilot_status" },
        }),
      ),
    ).toMatch(/\(no response\)/);

    // Gateway, then HTML 200 (captive portal), then a 404 HTML: up.
    health = () => html(502);
    await vi.advanceTimersByTimeAsync(1000);
    health = () => html(200);
    await vi.advanceTimersByTimeAsync(1000);
    expect(messages().some((m) => m.method)).toBe(false);
    health = () => html(404);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() =>
      expect(messages()).toContainEqual({
        jsonrpc: "2.0",
        method: "notifications/tools/list_changed",
      }),
    );
    // Up: the poller stopped.
    const before = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchMock.mock.calls.length).toBe(before);

    // A gateway error on a forwarded call takes it down again.
    mcp = () => html(503);
    expect(
      (await call({ id: 6, method: "tools/list" })).result!.tools!.map(
        (t) => t.name,
      ),
    ).toEqual(["dpilot_status"]);
    expect(errors.join("\n")).toMatch(/unreachable \(HTTP 503\)/);
  });

  it("an untrusted certificate is configuration: shown, never polled", async () => {
    upstream(
      () => {
        throw netErr("CERT_HAS_EXPIRED");
      },
      () => {
        throw netErr("SELF_SIGNED_CERT_IN_CHAIN");
      },
    );
    await serve();
    const status = await call({
      id: 1,
      method: "tools/call",
      params: { name: "dpilot_status" },
    });
    expect(text(status)).toMatch(/certificate .* is not trusted by Node/);
    const res = await call({
      id: 2,
      method: "tools/call",
      params: { name: "q" },
    });
    expect(res.result!.isError).toBe(true);
    expect(text(res)).toMatch(/--use-system-ca/);
  });

  it("a request it cannot send is configuration, and never leaks the credential", async () => {
    upstream(
      () => json({ status: "ok" }),
      () => {
        throw netErr();
      },
    );
    await serve();
    const res = await call({ id: 1, method: "tools/list" });
    expect(res.error).toEqual({
      code: -32603,
      message:
        "Could not send the request to D-Pilot. Check DPILOT_MCP_URL and DPILOT_MCP_AUTH.",
    });
    const all = errors.join("\n") + out.join("\n");
    expect(all).toContain("Could not send the request: fetch failed <auth>");
    expect(all).not.toContain("YWdlbnRAZXhhbXBsZS5jb206cHc=");
  });
});

describe("mcp-bridge (in-process): --install-desktop", () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "bridge-inproc-")));
    Object.defineProperty(process, "platform", { value: "darwin" });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const install = (url?: string, auth?: string) =>
    run(["--install-desktop", ...(url ? [url] : []), ...(auth ? [auth] : [])]);

  it("refuses a bad URL or authorization", async () => {
    await expect(install("nope", AUTH)).rejects.toThrow(ExitError);
    expect(errors.join()).toMatch(/The URL is not a valid URL/);
    await expect(install(MCP_URL)).rejects.toThrow(ExitError);
    await expect(install(MCP_URL, "Bearer x")).rejects.toThrow(ExitError);
    expect(errors.join()).toMatch(/must be "Basic <base64/);
    expect(exits).toEqual([1, 1, 1]);
  });

  it("exits 1 on Windows without APPDATA", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    delete process.env.APPDATA;
    delete process.env.LOCALAPPDATA;
    await expect(install(MCP_URL, AUTH)).rejects.toThrow(ExitError);
    expect(errors.join()).toMatch(/APPDATA is not set/);
  });

  it("creates the file and its directory", async () => {
    const file = join(dir, "nested", "claude_desktop_config.json");
    process.env.DPILOT_DESKTOP_CONFIG = file;
    exec.mockImplementation(() => {
      throw new Error("no match");
    });
    await install(MCP_URL, AUTH);
    const config = JSON.parse(readFileSync(file, "utf8"));
    expect(config.mcpServers["d-pilot"]).toMatchObject({
      args: expect.arrayContaining([BRIDGE]),
      env: { DPILOT_MCP_URL: MCP_URL, DPILOT_MCP_AUTH: AUTH },
    });
    expect(existsSync(`${file}.bak`)).toBe(false);
    expect(logs[0]).toBe(
      `Added d-pilot (https://dpilot.example.test) to ${file}.`,
    );
    expect(logs.join("\n")).not.toContain(AUTH);
    expect(errors.join()).not.toMatch(/looks like it is running/);
  });

  it("merges through a symlink, backs up, and warns when Desktop is running", async () => {
    const real = join(dir, "real.json");
    const link = join(dir, "link.json");
    const original = JSON.stringify({ keep: 1, mcpServers: { other: {} } });
    writeFileSync(real, original);
    symlinkSync(real, link);
    process.env.DPILOT_DESKTOP_CONFIG = link;
    exec.mockReturnValue("123\n");
    await install(MCP_URL, AUTH);
    const config = JSON.parse(readFileSync(real, "utf8"));
    expect(config.keep).toBe(1);
    expect(Object.keys(config.mcpServers)).toEqual(["other", "d-pilot"]);
    expect(readFileSync(`${real}.bak`, "utf8")).toBe(original);
    expect(logs[0]).toContain(`(backup: ${real}.bak)`);
    expect(errors.join()).toMatch(/looks like it is running/);

    // Again, starting mcpServers where there was none; the old .bak is replaced.
    writeFileSync(real, "{}");
    await install(MCP_URL, AUTH);
    expect(readFileSync(`${real}.bak`, "utf8")).toBe("{}");
    expect(
      Object.keys(JSON.parse(readFileSync(real, "utf8")).mcpServers),
    ).toEqual(["d-pilot"]);
  });

  it.each([
    ["not json", /is not valid JSON/],
    ["[]", /does not hold a JSON object/],
    ['{"mcpServers":[]}', /does not hold a JSON object/],
  ])("leaves %s alone", async (content, msg) => {
    const file = join(dir, "c.json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, content);
    process.env.DPILOT_DESKTOP_CONFIG = file;
    await expect(install(MCP_URL, AUTH)).rejects.toThrow(ExitError);
    expect(errors.join()).toMatch(msg);
    expect(readFileSync(file, "utf8")).toBe(content);
    expect(existsSync(`${file}.bak`)).toBe(false);
  });
});
