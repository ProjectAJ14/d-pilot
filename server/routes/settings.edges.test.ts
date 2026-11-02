import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";

/**
 * The admin settings routes' less-travelled answers — bad bodies, unknown
 * keys, missing connections, a no-op update, a passing connection test — on a
 * real (temp) store. Unlike settings.test.ts the connection probe is faked, so
 * the "ok" answer is reachable without a live database.
 */

const dir = mkdtempSync(path.join(tmpdir(), "d-pilot-settings-edges-"));
vi.stubEnv("DATA_DIR", dir);
vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "settings-edges-key");

const testConnectionConfig = vi.fn(async () => {});
vi.mock("../services/query-executor.js", async (orig) => ({
  ...(await orig<typeof import("../services/query-executor.js")>()),
  testConnectionConfig,
}));
const clearSchemaCache = vi.fn();
vi.mock("../services/schema-introspector.js", async (orig) => ({
  ...(await orig<typeof import("../services/schema-introspector.js")>()),
  clearSchemaCache,
}));

const store = await import("../services/sqlite-store.js");
const { getConfigNumber, getConfigBool } =
  await import("../config/settings.js");
const { default: router } = await import("./settings.js");

store.initDatabase();
const pg = {
  name: "Dev core",
  env: "DEV",
  type: "postgres" as const,
  host: "db.internal",
  port: 5432,
  database: "app_core",
};
store.saveDbConnection({ id: "dev-core", ...pg });

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { sub: "a1", email: "admin@example.com", isAdmin: true } as any;
    next();
  });
  app.use("/settings", router);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/settings`;
});

afterAll(() => {
  server.close();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

async function call(method: string, url: string, body?: unknown) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
const audits = (action: string) =>
  store.getAuditLog({ limit: 1000, action }).map((e) => e.sql);

describe("settings", () => {
  it("400s a body that is not { values }", async () => {
    expect(await call("PUT", "", { MAX_ROWS: 5 })).toEqual({
      status: 400,
      body: { error: "Body must be { values: { KEY: value } }" },
    });
  });

  it("404s a reset of an unknown key", async () => {
    expect(await call("DELETE", "/NOT_A_SETTING")).toEqual({
      status: 404,
      body: { error: "Unknown setting: NOT_A_SETTING" },
    });
  });

  it("drops cached schemas when the cache TTL changes, set or reset", async () => {
    await call("PUT", "", { values: { SCHEMA_CACHE_TTL_HOURS: "2" } });
    expect(clearSchemaCache).toHaveBeenCalledTimes(1);
    await call("DELETE", "/SCHEMA_CACHE_TTL_HOURS");
    expect(clearSchemaCache).toHaveBeenCalledTimes(2);
    // A reset of a value that was never stored changes nothing.
    await call("DELETE", "/SCHEMA_CACHE_TTL_HOURS");
    expect(clearSchemaCache).toHaveBeenCalledTimes(2);
  });

  it("reads a numeric value of a setting with no ceiling uncapped", () => {
    // EMAIL_DOMAIN has no default and no max: "" reads as 0, never clamped.
    expect(getConfigNumber("EMAIL_DOMAIN")).toBe(0);
    // And an unset value reads as false, not as a crash.
    expect(getConfigBool("EMAIL_DOMAIN")).toBe(false);
  });
});

describe("connections", () => {
  it("404s an update of a missing connection, 400s a bad body", async () => {
    expect((await call("PUT", "/connections/nope", pg)).status).toBe(404);
    const bad = await call("PUT", "/connections/dev-core", {
      ...pg,
      port: "x",
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/^port:/);
  });

  it("audits an update that changed nothing as such", async () => {
    const res = await call("PUT", "/connections/dev-core", pg);
    expect(res.status).toBe(200);
    expect(audits("CONNECTION_UPDATE")).toContain(
      "Updated connection dev-core: no changes",
    );
  });

  it("reports a passing test as ok, and audits it", async () => {
    expect(await call("POST", "/connections/test", pg)).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(audits("CONNECTION_TEST")).toContain(
      "Tested unsaved connection (DEV, postgres): ok",
    );
  });

  it("falls back to the thrown value when a driver error has no message", async () => {
    testConnectionConfig.mockRejectedValueOnce(
      Object.assign(new Error(""), { toString: () => "ETIMEDOUT" }),
    );
    expect((await call("POST", "/connections/test", pg)).body).toEqual({
      ok: false,
      error: "ETIMEDOUT",
    });
  });

  it("lists a connection whose row vanished under the cache as having no secrets", async () => {
    // Prime the cache, then remove the row behind its back.
    store.saveDbConnection({ id: "ghost", ...pg, password: "pw" });
    await call("GET", "/connections");
    store
      .getDb()
      .prepare("DELETE FROM db_connections WHERE id = 'ghost'")
      .run();
    const list = await call("GET", "/connections");
    expect(list.body.find((c: any) => c.id === "ghost")).toMatchObject({
      passwordSet: false,
      uriSet: false,
    });
  });

  it("404s a delete of a missing connection", async () => {
    store.saveDbConnection({ id: "tmp", ...pg }); // also refreshes the cache
    expect(await call("DELETE", "/connections/nope")).toEqual({
      status: 404,
      body: { error: "Connection not found" },
    });
  });
});
