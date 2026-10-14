import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, statSync, readFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";

/**
 * Admin runtime config, driven through the real router against a real (temp)
 * SQLite store — the point is what lands on disk and what comes back over HTTP.
 */

const dir = mkdtempSync(path.join(tmpdir(), "d-pilot-admin-settings-"));
vi.stubEnv("DATA_DIR", dir);
vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "");
vi.stubEnv(
  "DBFORGE_CONNECTIONS",
  JSON.stringify([
    {
      id: "dev-core",
      name: "Dev core",
      env: "DEV",
      type: "postgres",
      host: "localhost",
      database: "app_core",
      password: "seed-pw",
    },
  ]),
);

const store = await import("../services/sqlite-store.js");
const { getConfig } = await import("../config/settings.js");
const { getEnvironments, getConnection } =
  await import("../config/connections.js");
const { applyDefaultLimit } = await import("../services/query-executor.js");
const { default: router } = await import("./settings.js");

store.initDatabase();

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      sub: "u1",
      email: "u1@example.com",
      isAdmin: req.headers["x-test-admin"] === "1",
    } as any;
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

const call = (method: string, url = "", body?: unknown, admin = true) =>
  fetch(`${base}${url}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(admin ? { "x-test-admin": "1" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const rawSetting = (key: string) =>
  (
    store
      .getDb()
      .prepare("SELECT value FROM app_settings WHERE key = ?")
      .get(key) as { value: string } | undefined
  )?.value;

describe("settings precedence", () => {
  it("is db > env > default, and a reset falls back to env", async () => {
    vi.stubEnv("MCP_MAX_ROWS", "");
    expect(getConfig("MCP_MAX_ROWS")).toBe("1000");
    vi.stubEnv("MCP_MAX_ROWS", "250");
    expect(getConfig("MCP_MAX_ROWS")).toBe("250");

    await call("PUT", "", { values: { MCP_MAX_ROWS: "300" } });
    expect(getConfig("MCP_MAX_ROWS")).toBe("300");
    const list = await (await call("GET")).json();
    expect(list.find((s: any) => s.key === "MCP_MAX_ROWS")).toMatchObject({
      value: "300",
      source: "db",
    });

    await call("DELETE", "/MCP_MAX_ROWS");
    expect(getConfig("MCP_MAX_ROWS")).toBe("250");
  });

  it("applies a changed MAX_ROWS without a restart", async () => {
    await call("PUT", "", { values: { MAX_ROWS: "7" } });
    expect(applyDefaultLimit("SELECT * FROM orders", 500)).toBe(
      "SELECT * FROM orders LIMIT 7",
    );
    await call("PUT", "", { values: { MAX_ROWS: "40" } });
    expect(applyDefaultLimit("SELECT * FROM orders", 500)).toBe(
      "SELECT * FROM orders LIMIT 40",
    );
  });

  it("rejects an invalid value without writing anything", async () => {
    const res = await call("PUT", "", {
      values: { APP_NAME: "Renamed", MAX_ROWS: "-1" },
    });
    expect(res.status).toBe(400);
    expect(rawSetting("APP_NAME")).toBeUndefined();
  });
});

describe("secrets", () => {
  const SECRET = "sk-test-value-123";

  it("are encrypted at rest and never returned", async () => {
    const res = await call("PUT", "", {
      values: { AZURE_OPENAI_KEY: SECRET },
    });
    expect(JSON.stringify(await res.json())).not.toContain(SECRET);
    expect(rawSetting("AZURE_OPENAI_KEY")).toMatch(/^enc:v1:/);
    expect(rawSetting("AZURE_OPENAI_KEY")).not.toContain(SECRET);
    expect(getConfig("AZURE_OPENAI_KEY")).toBe(SECRET);

    const list = await (await call("GET")).text();
    expect(list).not.toContain(SECRET);
    expect(
      JSON.parse(list).find((s: any) => s.key === "AZURE_OPENAI_KEY"),
    ).toEqual({
      key: "AZURE_OPENAI_KEY",
      group: "ai",
      secret: true,
      source: "db",
      set: true,
    });

    const audit = JSON.stringify(store.getAuditLog({ limit: 1000 }));
    expect(audit).toContain("AZURE_OPENAI_KEY");
    expect(audit).not.toContain(SECRET);
  });

  it("keeps the stored secret when updated with an empty value", async () => {
    await call("PUT", "", { values: { AZURE_OPENAI_KEY: "" } });
    expect(getConfig("AZURE_OPENAI_KEY")).toBe(SECRET);
  });

  it("must be re-entered when the endpoint changes, so it cannot be redirected", async () => {
    const before = getConfig("AZURE_OPENAI_ENDPOINT");
    const redirect = await call("PUT", "", {
      values: { AZURE_OPENAI_ENDPOINT: "https://attacker.example.com" },
    });
    expect(redirect.status).toBe(400);
    expect(getConfig("AZURE_OPENAI_ENDPOINT")).toBe(before);

    const ok = await call("PUT", "", {
      values: {
        AZURE_OPENAI_ENDPOINT: "https://ai.example.com",
        AZURE_OPENAI_KEY: "sk-new",
      },
    });
    expect(ok.status).toBe(200);
    expect(getConfig("AZURE_OPENAI_KEY")).toBe("sk-new");
  });

  it("must be re-entered when TLS verification is switched off", async () => {
    const res = await call("PUT", "", {
      values: { AZURE_OPENAI_INSECURE_TLS: "true" },
    });
    expect(res.status).toBe(400);
    expect(getConfig("AZURE_OPENAI_INSECURE_TLS")).toBe("false");
  });

  it("cannot be swapped for the .env key by resetting it", async () => {
    vi.stubEnv("AZURE_OPENAI_KEY", "sk-from-env");
    vi.stubEnv("AZURE_OPENAI_ENDPOINT", "https://operator.example.com");
    // An admin's own endpoint, saved with a throwaway key...
    await call("PUT", "", {
      values: {
        AZURE_OPENAI_ENDPOINT: "https://attacker.example.com",
        AZURE_OPENAI_KEY: "throwaway",
      },
    });
    // ...then resetting the key must not pair the .env key with that endpoint.
    await call("DELETE", "/AZURE_OPENAI_KEY");
    expect(getConfig("AZURE_OPENAI_KEY")).toBe("sk-from-env");
    expect(getConfig("AZURE_OPENAI_ENDPOINT")).toBe(
      "https://operator.example.com",
    );
  });

  it("does not fall back to the .env key when the stored one cannot be decrypted", async () => {
    vi.stubEnv("AZURE_OPENAI_KEY", "sk-from-env");
    await call("PUT", "", {
      values: {
        AZURE_OPENAI_ENDPOINT: "https://admin-chosen.example.com",
        AZURE_OPENAI_KEY: "sk-admin",
      },
    });
    // A lost or rotated key file leaves a value that no longer decrypts.
    store.setSetting("AZURE_OPENAI_KEY", "enc:v1:AAAA:AAAA:AAAA");
    expect(getConfig("AZURE_OPENAI_KEY")).toBeUndefined();
    const view = (await (await call("GET")).json()).find(
      (s: any) => s.key === "AZURE_OPENAI_KEY",
    );
    expect(view).toMatchObject({ source: "db", set: false });
    await call("DELETE", "/AZURE_OPENAI_KEY");
  });

  it("uses a 0600 key file in DATA_DIR, not the database", () => {
    const keyFile = path.join(dir, "settings.key");
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    const key = readFileSync(keyFile, "utf8").trim();
    const all = JSON.stringify(
      store.getDb().prepare("SELECT * FROM app_settings").all(),
    );
    expect(all).not.toContain(key);
  });
});

describe("access", () => {
  it("is admin-only", async () => {
    expect((await call("GET", "", undefined, false)).status).toBe(403);
    expect(
      (await call("PUT", "", { values: { MAX_ROWS: "1" } }, false)).status,
    ).toBe(403);
    expect((await call("GET", "/connections", undefined, false)).status).toBe(
      403,
    );
  });
});

describe("connections", () => {
  it("seeds from DBFORGE_CONNECTIONS on first run, password encrypted", async () => {
    expect(getConnection("dev-core")?.password).toBe("seed-pw");
    const row = store
      .getDb()
      .prepare("SELECT password_enc FROM db_connections WHERE id = ?")
      .get("dev-core") as { password_enc: string };
    expect(row.password_enc).toMatch(/^enc:v1:/);

    const text = await (await call("GET", "/connections")).text();
    expect(text).not.toContain("seed-pw");
    expect(JSON.parse(text)[0]).toMatchObject({
      id: "dev-core",
      passwordSet: true,
    });
  });

  it("reflects create, edit and delete in getEnvironments()", async () => {
    expect(getEnvironments()).toEqual(["DEV"]);

    const created = await call("POST", "/connections", {
      id: "orders-qa",
      name: "Orders QA",
      env: "QA",
      type: "postgres",
      database: "orders",
      password: "qa-pw",
    });
    expect(created.status).toBe(201);
    expect(getEnvironments()).toEqual(["DEV", "QA"]);

    const updated = await call("PUT", "/connections/orders-qa", {
      name: "Orders",
      env: "SUPER_PROD",
      type: "postgres",
      database: "orders",
      password: "",
    });
    expect(updated.status).toBe(200);
    expect(getEnvironments()).toEqual(["DEV", "SUPER_PROD"]);
    // Empty password on edit keeps the stored one.
    expect(getConnection("orders-qa")?.password).toBe("qa-pw");
    // A new production-like env is masked by the rail immediately.
    expect(store.getPhiMaskedEnvs()).toContain("SUPER_PROD");

    expect((await call("DELETE", "/connections/orders-qa")).status).toBe(200);
    expect(getEnvironments()).toEqual(["DEV"]);
  });

  it("requires the password again when host, port or type changes", async () => {
    const body = { name: "Core", env: "DEV", type: "postgres" as const };
    const redirect = await call("PUT", "/connections/dev-core", {
      ...body,
      host: "attacker.example.com",
    });
    expect(redirect.status).toBe(400);
    expect(getConnection("dev-core")?.host).not.toBe("attacker.example.com");

    const ok = await call("PUT", "/connections/dev-core", {
      ...body,
      host: "db.example.com",
      password: "new-pw",
    });
    expect(ok.status).toBe(200);
    expect(getConnection("dev-core")?.password).toBe("new-pw");
  });

  it("requires the password again when an Elasticsearch uri or protocol changes", async () => {
    const es = {
      name: "Search",
      env: "DEV",
      type: "elasticsearch" as const,
      host: "search.example.com",
      schema: "https",
      username: "elastic",
    };
    await call("POST", "/connections", {
      ...es,
      id: "search",
      password: "es-pw",
    });

    const viaUri = await call("PUT", "/connections/search", {
      ...es,
      uri: "https://attacker.example.com",
    });
    expect(viaUri.status).toBe(400);
    const viaHttp = await call("PUT", "/connections/search", {
      ...es,
      schema: "http",
    });
    expect(viaHttp.status).toBe(400);
    expect(getConnection("search")).toMatchObject({ schema: "https" });
    expect(getConnection("search")?.uri).toBeUndefined();
    await call("DELETE", "/connections/search");
  });

  it("requires the password again for any change outside the safe fields", async () => {
    const mongo = {
      name: "Docs",
      env: "DEV",
      type: "mongodb" as const,
      host: "docs.example.com",
      database: "orders",
      username: "app",
    };
    await call("POST", "/connections", {
      ...mongo,
      id: "docs",
      password: "m-pw",
    });

    // The username is spliced into the URI, so it can move the host.
    const viaUser = await call("PUT", "/connections/docs", {
      ...mongo,
      username: "x@attacker.example.com:27017/orders?",
    });
    expect(viaUser.status).toBe(400);
    const viaDb = await call("PUT", "/connections/docs", {
      ...mongo,
      database: "orders?authSource=x",
    });
    expect(viaDb.status).toBe(400);

    // Renaming, re-labelling the env or narrowing schemas cannot redirect.
    const safe = await call("PUT", "/connections/docs", {
      ...mongo,
      name: "Docs (renamed)",
      env: "QA",
      schemas: ["orders"],
    });
    expect(safe.status).toBe(200);
    expect(getConnection("docs")?.password).toBe("m-pw");
    await call("DELETE", "/connections/docs");
  });

  it("rejects a duplicate id and an invalid body", async () => {
    const dup = await call("POST", "/connections", {
      id: "dev-core",
      name: "x",
      env: "DEV",
      type: "postgres",
    });
    expect(dup.status).toBe(409);
    const bad = await call("POST", "/connections", {
      id: "x",
      name: "x",
      env: "DEV",
      type: "oracle",
    });
    expect(bad.status).toBe(400);
  });
});
