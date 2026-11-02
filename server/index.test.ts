import { describe, it, expect, vi, afterAll, beforeAll } from "vitest";
import express from "express";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";

/**
 * The process entry, in-process. `server/index.ts` calls `app.listen` at import
 * time; here that call is intercepted (its banner callback still runs) and the
 * exported app is served on an ephemeral port instead. Each boot re-imports the
 * module graph so BASE_PATH / NODE_ENV / PORT — read at import — take effect.
 * The real sub-path boot is covered end to end by base-path.integration.test.ts.
 */

const dirs: string[] = [];
const servers: Server[] = [];
const listenCalls: unknown[][] = [];

// A deployment may have a .env; pin everything index.ts reads so dotenv
// (which never overrides a set var) cannot leak it into the test.
const PINNED = [
  "APP_NAME",
  "LOGO_URL",
  "LIGHT_LOGO_URL",
  "FAVICON_URL",
  "EMAIL_DOMAIN",
  "LOGIN_TAGLINE",
  "LOGIN_SUBTITLE",
  "NETWORK_HINT",
  "SETTINGS_ENCRYPTION_KEY",
  "JWT_SECRET",
  "DEFAULT_ADMIN_PASSWORD",
];

async function boot(env: Record<string, string>) {
  vi.resetModules();
  const dir = mkdtempSync(path.join(tmpdir(), "d-pilot-index-"));
  dirs.push(dir);
  for (const key of PINNED) vi.stubEnv(key, "");
  vi.stubEnv("DATA_DIR", dir);
  vi.stubEnv("BASE_PATH", "");
  vi.stubEnv("PORT", "");
  vi.stubEnv("NODE_ENV", "test");
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);

  const { default: app } = await import("./index.js");
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

let staticOptions: { setHeaders: (res: any, file: string) => void } | null =
  null;

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(express.application, "listen").mockImplementation(function (
    this: unknown,
    ...args: unknown[]
  ) {
    listenCalls.push(args);
    (args[2] as () => void)();
    return {} as Server;
  } as any);
  const realStatic = express.static;
  vi.spyOn(express, "static").mockImplementation(((root: string, opts: any) => {
    staticOptions = opts;
    return realStatic(root, opts);
  }) as typeof express.static);
});

afterAll(() => {
  for (const s of servers) s.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("server/index.ts at the domain root", () => {
  let base: string;
  beforeAll(async () => {
    base = await boot({ LOGO_URL: "/logo.svg", NETWORK_HINT: "Use the VPN." });
  });

  it("listens on PORT's default, all interfaces", () => {
    expect(listenCalls.at(-1)?.slice(0, 2)).toEqual([3101, "0.0.0.0"]);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Running on http://0.0.0.0:3101"),
    );
  });

  it("answers health without auth", async () => {
    const res = await fetch(`${base}/api/health`);
    expect(await res.json()).toEqual({
      status: "ok",
      version: "1.0.0",
      service: "d-pilot",
    });
  });

  it("serves public config with neutral fallbacks", async () => {
    const body = await (await fetch(`${base}/api/config`)).json();
    expect(body).toMatchObject({
      appName: "D-Pilot",
      logoUrl: "/logo.svg",
      lightLogoUrl: null,
      faviconUrl: "/favicon-32.png",
      emailDomain: null,
      loginTagline: "Internal query tool",
      networkHint: "Use the VPN.",
      environments: [],
    });
    expect(Array.isArray(body.phiMaskedEnvironments)).toBe(true);
  });

  it("renders the manifest from APP_NAME, uncached", async () => {
    const res = await fetch(`${base}/manifest.webmanifest`);
    expect(res.headers.get("content-type")).toContain(
      "application/manifest+json",
    );
    expect(res.headers.get("cache-control")).toBe("no-cache");
    const body = await res.json();
    expect(body).toMatchObject({ name: "D-Pilot", scope: "/", start_url: "/" });
    expect(body.icons[0].src).toBe("/pwa-192.png");
  });

  it("guards the API behind the JWT, and the seeded admin can log in", async () => {
    expect((await fetch(`${base}/api/auth/me`)).status).toBe(401);
    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "admin@example.com",
        password: "changeme123",
      }),
    });
    expect(login.status).toBe(200);
    const { token } = await login.json();
    const me = await fetch(`${base}/api/auth/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect((await me.json()).isAdmin).toBe(true);
  });

  it("serves no client and redirects nothing outside production", async () => {
    const res = await fetch(`${base}/some/page`, { redirect: "manual" });
    expect(res.status).toBe(404);
  });
});

describe("server/index.ts under a sub-path in production", () => {
  let base: string;
  beforeAll(async () => {
    staticOptions = null;
    base = await boot({
      BASE_PATH: "/d-pilot",
      NODE_ENV: "production",
      PORT: "4321",
      APP_NAME: "Ops Console",
    });
  });

  it("listens on PORT and prints the prefixed address", () => {
    expect(listenCalls.at(-1)?.[0]).toBe(4321);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Running on http://0.0.0.0:4321/d-pilot"),
    );
  });

  it("mounts the API and manifest under the prefix", async () => {
    expect((await fetch(`${base}/d-pilot/api/health`)).status).toBe(200);
    const manifest = await (
      await fetch(`${base}/d-pilot/manifest.webmanifest`)
    ).json();
    expect(manifest).toMatchObject({
      name: "Ops Console",
      scope: "/d-pilot/",
      id: "/d-pilot/",
    });
    expect(manifest.icons[2].src).toBe("/d-pilot/pwa-maskable-512.png");
  });

  it("falls back to the neutral name when APP_NAME is saved blank", async () => {
    const { setSetting } = await import("./services/sqlite-store.js");
    setSetting("APP_NAME", "");
    try {
      const config = await (await fetch(`${base}/d-pilot/api/config`)).json();
      expect(config).toMatchObject({ appName: "D-Pilot", networkHint: "" });
      const manifest = await (
        await fetch(`${base}/d-pilot/manifest.webmanifest`)
      ).json();
      expect(manifest.name).toBe("D-Pilot");
    } finally {
      setSetting("APP_NAME", "Ops Console");
    }
  });

  it("302s a stale root GET into the prefix", async () => {
    const res = await fetch(`${base}/queries?tab=2`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/d-pilot/queries?tab=2");
  });

  it("never redirects /api or a non-GET", async () => {
    const api = await fetch(`${base}/api/health`, { redirect: "manual" });
    expect(api.status).toBe(404);
    const post = await fetch(`${base}/queries`, {
      method: "POST",
      redirect: "manual",
    });
    expect(post.status).toBe(404);
  });

  it("falls back to the SPA's index.html for client routes", async () => {
    // No built client in a test checkout: sendFile fails, which proves the
    // catch-all (not a redirect or the API) answered.
    const res = await fetch(`${base}/d-pilot/queries`, { redirect: "manual" });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("Cannot GET");
  });

  it("never lets a proxy cache the service worker, but keeps assets cacheable", () => {
    expect(staticOptions).not.toBeNull();
    const headers = new Map<string, string>();
    const res = { setHeader: (k: string, v: string) => headers.set(k, v) };
    staticOptions!.setHeaders(res, "/client/assets/index-abc.js");
    expect(headers.size).toBe(0);
    staticOptions!.setHeaders(res, "/client/sw.js");
    expect(headers.get("Cache-Control")).toBe("no-cache");
    headers.clear();
    staticOptions!.setHeaders(res, "/client/workbox-1234.js");
    expect(headers.get("Cache-Control")).toBe("no-cache");
  });
});

describe("server/index.ts when a login line resolves to nothing", () => {
  it("serves an empty tagline and subtitle, which hide the lines", async () => {
    vi.doMock("./config/settings.js", async (orig) => {
      const m = await orig<typeof import("./config/settings.js")>();
      return {
        ...m,
        getConfig: (key: Parameters<typeof m.getConfig>[0]) =>
          key === "LOGIN_TAGLINE" || key === "LOGIN_SUBTITLE"
            ? undefined
            : m.getConfig(key),
      };
    });
    try {
      const base = await boot({});
      const body = await (await fetch(`${base}/api/config`)).json();
      expect(body).toMatchObject({ loginTagline: "", loginSubtitle: "" });
    } finally {
      vi.doUnmock("./config/settings.js");
    }
  });
});
