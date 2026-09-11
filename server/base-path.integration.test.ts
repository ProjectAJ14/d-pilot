import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { createServer } from "net";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

/**
 * The sub-path mechanism end to end, against a real server process.
 *
 * The unit tests around it check the pure helpers; nothing there would notice if
 * `app.use(BASE_PATH || "/", router)` were dropped, if the manifest stopped
 * carrying the prefix, or if `/api/config` handed the client an unprefixed logo.
 * Those are exactly the failures a sub-path deployment shows as a blank page, so
 * they are worth the cost of booting.
 *
 * A child process rather than importing the app: `server/index.ts` calls
 * `app.listen` at import time, so there is no exported handle to drive and a
 * second import would bind twice. Booting it the way production does also means
 * this test sees the mount, not a reconstruction of it.
 */

const DEFAULT_ADMIN_PASSWORD = "integration-test-only";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (typeof address === "string" || address === null) {
        reject(new Error("no port assigned"));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

interface Booted {
  child: ChildProcess;
  origin: string;
  dataDir: string;
}

/** Boot the server with the given BASE_PATH and wait until it answers. */
async function boot(basePath: string): Promise<Booted> {
  const port = await freePort();
  const dataDir = mkdtempSync(path.join(tmpdir(), "d-pilot-basepath-"));
  const child = spawn("npx", ["tsx", "server/index.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      BASE_PATH: basePath,
      DATA_DIR: dataDir,
      APP_NAME: "D-Pilot Test",
      // A file in public/ — must come back prefixed.
      LOGO_URL: "/logo.svg",
      // Somebody else's CDN — must come back untouched.
      FAVICON_URL: "https://cdn.example/favicon.png",
      DEFAULT_ADMIN_PASSWORD,
      JWT_SECRET: "integration-test-secret",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const origin = `http://127.0.0.1:${port}`;
  const health = `${origin}${basePath}/api/health`;
  const deadline = Date.now() + 45_000;
  let stderr = "";
  child.stderr?.on("data", (c) => (stderr += String(c)));

  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server exited (${child.exitCode}): ${stderr}`);
    }
    try {
      const res = await fetch(health);
      if (res.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline)
      throw new Error(`server never answered ${health}: ${stderr}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  return { child, origin, dataDir };
}

function shutdown({ child, dataDir }: Booted) {
  child.kill("SIGKILL");
  rmSync(dataDir, { recursive: true, force: true });
}

describe.each([
  { label: "domain root", basePath: "", outside: "/d-pilot" },
  { label: "sub-path", basePath: "/d-pilot", outside: "" },
])("$label deployment (BASE_PATH=$basePath)", ({ basePath, outside }) => {
  let booted: Booted;

  beforeAll(async () => {
    booted = await boot(basePath);
  }, 60_000);

  afterAll(() => booted && shutdown(booted));

  const url = (p: string) => `${booted.origin}${basePath}${p}`;

  it("serves the API under the prefix", async () => {
    const res = await fetch(url("/api/health"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: "ok" });
  });

  it("does not answer outside the prefix", async () => {
    // At the root this asks for /d-pilot/api/health and at a sub-path for
    // /api/health: either way, a path this deployment does not own.
    const res = await fetch(`${booted.origin}${outside}/api/health`);
    expect(res.status).toBe(404);
  });

  it("scopes the web manifest to the prefix, never the domain root", async () => {
    const res = await fetch(url("/manifest.webmanifest"));
    expect(res.status).toBe(200);
    const manifest = await res.json();
    const expected = `${basePath}/`;
    // A scope of "/" on a sub-path deployment makes the installed app claim the
    // whole domain, so every link to the app that owns the root opens inside
    // D-Pilot's window.
    expect(manifest.scope).toBe(expected);
    expect(manifest.start_url).toBe(expected);
    expect(manifest.id).toBe(expected);
    for (const icon of manifest.icons) {
      expect(icon.src.startsWith(`${basePath}/`)).toBe(true);
    }
  });

  it("prefixes branding that points into public/ and leaves a CDN alone", async () => {
    const config = await fetch(url("/api/config")).then((r) => r.json());
    expect(config.logoUrl).toBe(`${basePath}/logo.svg`);
    expect(config.faviconUrl).toBe("https://cdn.example/favicon.png");
  });
});
