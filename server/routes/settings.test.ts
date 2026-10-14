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

const store = await import("../services/sqlite-store.js");
const settings = await import("../config/settings.js");
const { getConfig } = settings;
const { getEnvironments, getConnection, invalidateConnections } =
  await import("../config/connections.js");
const { applyDefaultLimit, getPoolStatus } =
  await import("../services/query-executor.js");
const { default: router, maskSecrets } = await import("./settings.js");

store.initDatabase();
store.saveDbConnection({
  id: "dev-core",
  name: "Dev core",
  env: "DEV",
  type: "postgres",
  host: "localhost",
  database: "app_core",
  password: "seed-pw",
});

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

  it("ignores AZURE_OPENAI_* in .env", async () => {
    vi.stubEnv("AZURE_OPENAI_ENDPOINT", "https://operator.example.com");
    vi.stubEnv("AZURE_OPENAI_DEPLOYMENT", "env-deployment");
    vi.stubEnv("AZURE_OPENAI_API_VERSION", "2099-01-01");
    expect(getConfig("AZURE_OPENAI_DEPLOYMENT")).toBeUndefined();
    expect(getConfig("AZURE_OPENAI_API_VERSION")).toBe("2024-08-01-preview");
    const list = await (await call("GET")).json();
    expect(
      list.find((s: any) => s.key === "AZURE_OPENAI_DEPLOYMENT"),
    ).toMatchObject({ source: "default", value: null });
    for (const key of [
      "AZURE_OPENAI_ENDPOINT",
      "AZURE_OPENAI_DEPLOYMENT",
      "AZURE_OPENAI_API_VERSION",
    ]) {
      vi.stubEnv(key, "");
    }
  });

  it("resets only the key, leaving its endpoint as saved", async () => {
    vi.stubEnv("AZURE_OPENAI_KEY", "sk-from-env");
    await call("PUT", "", {
      values: {
        AZURE_OPENAI_ENDPOINT: "https://ai.example.com",
        AZURE_OPENAI_KEY: "sk-saved",
      },
    });
    await call("DELETE", "/AZURE_OPENAI_KEY");
    expect(getConfig("AZURE_OPENAI_KEY")).toBeUndefined();
    expect(getConfig("AZURE_OPENAI_ENDPOINT")).toBe("https://ai.example.com");
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

    // Still guarded: restoring the key file later would revive that secret,
    // so its endpoint cannot move until a key is typed again.
    const moved = await call("PUT", "", {
      values: { AZURE_OPENAI_ENDPOINT: "https://elsewhere.example.com" },
    });
    expect(moved.status).toBe(400);
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
  it("stores the password encrypted and never returns it", async () => {
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

  it("cannot move a production connection to a non-production env", async () => {
    const prod = {
      name: "Orders prod",
      env: "PROD",
      type: "postgres" as const,
      database: "orders",
    };
    await call("POST", "/connections", {
      ...prod,
      id: "orders-prod",
      password: "p",
    });

    // Renaming the env would lift forced masking and the direct-write block.
    const demoted = await call("PUT", "/connections/orders-prod", {
      ...prod,
      env: "DEV",
    });
    expect(demoted.status).toBe(422);
    expect((await demoted.json()).error).toMatch(/PROD/);
    expect(getConnection("orders-prod")?.env).toBe("PROD");

    const stillProd = await call("PUT", "/connections/orders-prod", {
      ...prod,
      env: "SUPER_PROD",
    });
    expect(stillProd.status).toBe(200);
    await call("DELETE", "/connections/orders-prod");
  });

  it("clears a stored password or URI on request, without re-entry", async () => {
    const pg = {
      name: "Clearable",
      env: "DEV",
      type: "postgres" as const,
      host: "db.example.com",
    };
    await call("POST", "/connections", {
      ...pg,
      id: "clearable",
      password: "pw",
      uri: "postgres://db.example.com/app_core",
    });

    const noUri = await call("PUT", "/connections/clearable", {
      ...pg,
      password: "pw",
      clearUri: true,
    });
    expect(noUri.status).toBe(200);
    expect(await noUri.json()).toMatchObject({
      uriSet: false,
      passwordSet: true,
    });

    // Nothing is kept, so moving the host needs no password.
    const cleared = await call("PUT", "/connections/clearable", {
      ...pg,
      host: "other.example.com",
      clearPassword: true,
    });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({ passwordSet: false });
    expect(getConnection("clearable")?.password).toBeUndefined();
    await call("DELETE", "/connections/clearable");
  });

  it("treats a stored but undecryptable password as present", async () => {
    const pg = {
      name: "Locked",
      env: "DEV",
      type: "postgres" as const,
      host: "db.example.com",
    };
    await call("POST", "/connections", { ...pg, id: "locked", password: "pw" });
    // A lost or rotated key file leaves ciphertext that no longer decrypts.
    const bad = "enc:v1:AAAA:AAAA:AAAA";
    const rawPassword = () =>
      (
        store
          .getDb()
          .prepare("SELECT password_enc FROM db_connections WHERE id = ?")
          .get("locked") as { password_enc: string | null }
      ).password_enc;
    store
      .getDb()
      .prepare("UPDATE db_connections SET password_enc = ? WHERE id = ?")
      .run(bad, "locked");
    invalidateConnections();

    const list = await (await call("GET", "/connections")).json();
    expect(list.find((c: any) => c.id === "locked")).toMatchObject({
      passwordSet: true,
    });
    // Restoring the key file would revive it, so it still guards its target...
    const moved = await call("PUT", "/connections/locked", {
      ...pg,
      host: "elsewhere.example.com",
    });
    expect(moved.status).toBe(400);
    // ...and a save that keeps it leaves the ciphertext untouched.
    const renamed = await call("PUT", "/connections/locked", {
      ...pg,
      name: "Locked (renamed)",
    });
    expect(renamed.status).toBe(200);
    expect(rawPassword()).toBe(bad);
    await call("DELETE", "/connections/locked");
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

describe("JWT_EXPIRES_IN", () => {
  it("rejects a unitless or zero duration, which would lock everyone out", async () => {
    for (const bad of ["3600", "0h", "0"]) {
      const res = await call("PUT", "", { values: { JWT_EXPIRES_IN: bad } });
      expect(res.status).toBe(400);
    }
    expect(rawSetting("JWT_EXPIRES_IN")).toBeUndefined();
    const ok = await call("PUT", "", { values: { JWT_EXPIRES_IN: "7 days" } });
    expect(ok.status).toBe(200);
    expect(settings.jwtExpiresIn()).toBe("7 days");
    await call("DELETE", "/JWT_EXPIRES_IN");
  });

  it("signs with the default when an already-stored value is unusable", () => {
    store.setSetting("JWT_EXPIRES_IN", "3600");
    expect(settings.jwtExpiresIn()).toBe("24h");
    store.deleteSetting("JWT_EXPIRES_IN");
  });
});

describe("limits", () => {
  it("rejects values above each setting's maximum", async () => {
    for (const [key, value] of [
      ["QUERY_TIMEOUT_MS", "2147483648"],
      ["MAX_ROWS", "1000001"],
      ["MCP_MAX_ROWS", "1000001"],
      ["SCHEMA_CACHE_TTL_HOURS", "8761"],
    ]) {
      const before = rawSetting(key);
      const res = await call("PUT", "", { values: { [key]: value } });
      expect(res.status, key).toBe(400);
      expect(rawSetting(key), key).toBe(before);
    }
    const atMax = await call("PUT", "", {
      values: { QUERY_TIMEOUT_MS: "2147483647" },
    });
    expect(atMax.status).toBe(200);
    await call("DELETE", "/QUERY_TIMEOUT_MS");
  });
});

describe("bool settings", () => {
  it("treats saving the current TLS value as no change", async () => {
    await call("PUT", "", { values: { AZURE_OPENAI_KEY: "sk-bool" } });
    // Same value, so the key's target has not moved — no re-entry needed.
    const res = await call("PUT", "", {
      values: { AZURE_OPENAI_INSECURE_TLS: "false" },
    });
    expect(res.status).toBe(200);
    await call("DELETE", "/AZURE_OPENAI_KEY");
  });
});

describe("getConfigNumber", () => {
  it("falls back to the default for a non-positive or out-of-range env value", async () => {
    for (const key of ["MCP_MAX_ROWS", "MAX_ROWS", "QUERY_TIMEOUT_MS"]) {
      await call("DELETE", `/${key}`);
    }
    // "0" used to truncate every MCP result to zero rows.
    for (const bad of ["0", "-5", "abc"]) {
      vi.stubEnv("MCP_MAX_ROWS", bad);
      expect(settings.getConfigNumber("MCP_MAX_ROWS"), bad).toBe(1000);
      vi.stubEnv("MAX_ROWS", bad);
      expect(settings.getConfigNumber("MAX_ROWS"), bad).toBe(10000);
    }
    vi.stubEnv("QUERY_TIMEOUT_MS", "99999999999");
    expect(settings.getConfigNumber("QUERY_TIMEOUT_MS")).toBe(90000);
    vi.stubEnv("SCHEMA_CACHE_TTL_HOURS", "-1");
    expect(settings.getConfigNumber("SCHEMA_CACHE_TTL_HOURS")).toBe(24);
    vi.stubEnv("SCHEMA_CACHE_TTL_HOURS", "0");
    expect(settings.getConfigNumber("SCHEMA_CACHE_TTL_HOURS")).toBe(0);
    vi.stubEnv("MCP_MAX_ROWS", "250");
    expect(settings.getConfigNumber("MCP_MAX_ROWS")).toBe(250);
    for (const key of [
      "MCP_MAX_ROWS",
      "MAX_ROWS",
      "QUERY_TIMEOUT_MS",
      "SCHEMA_CACHE_TTL_HOURS",
    ]) {
      vi.stubEnv(key, "");
    }
  });
});

describe("POST /connections/test", () => {
  // Port 1 refuses at once, so every probe fails fast with a driver error.
  const pg = {
    name: "Probe",
    env: "DEV",
    type: "postgres" as const,
    host: "127.0.0.1",
    port: 1,
    database: "app_core",
  };

  it("tests unsaved values and reports the driver error", async () => {
    const res = await call("POST", "/connections/test", {
      ...pg,
      password: "typed-pw",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/ECONNREFUSED|connect/i);

    const audit = JSON.stringify(store.getAuditLog({ limit: 1000 }));
    expect(audit).toContain("CONNECTION_TEST");
    expect(audit).not.toContain("typed-pw");
  });

  it("validates the body like create/update", async () => {
    const res = await call("POST", "/connections/test", {
      ...pg,
      type: "oracle",
    });
    expect(res.status).toBe(400);
  });

  it("uses a stored password only under the same gate as PUT", async () => {
    await call("POST", "/connections", {
      ...pg,
      id: "probe",
      password: "stored-pw",
    });
    // Pointing the stored password somewhere new is refused, as on save.
    const moved = await call("POST", "/connections/test", {
      ...pg,
      id: "probe",
      host: "attacker.example.com",
    });
    expect(moved.status).toBe(400);
    expect((await moved.json()).error).toMatch(/Re-enter the password/);

    // Same target: the stored password is used, and the pool maps and the
    // saved row stay untouched.
    const same = await call("POST", "/connections/test", {
      ...pg,
      id: "probe",
      name: "Renamed in the form only",
    });
    expect(same.status).toBe(200);
    // A driver may echo the stored secret in any encoding, so a test that used
    // it returns no driver text at all — the detail goes to the server log.
    const sameBody = await same.json();
    expect(sameBody.ok).toBe(false);
    expect(sameBody.error).not.toMatch(/ECONNREFUSED|127\.0\.0\.1/);
    expect(sameBody.error).toMatch(/server log/i);
    expect(getPoolStatus("probe").live).toBe(false);
    expect(getConnection("probe")?.name).toBe("Probe");

    // Clearing keeps nothing, so a new host needs no re-entry.
    const cleared = await call("POST", "/connections/test", {
      ...pg,
      id: "probe",
      port: 2,
      clearPassword: true,
    });
    expect(cleared.status).toBe(200);
    await call("DELETE", "/connections/probe");
  });

  it("is admin-only", async () => {
    const res = await call("POST", "/connections/test", pg, false);
    expect(res.status).toBe(403);
  });
});

describe("maskSecrets", () => {
  it("masks a secret raw and percent-encoded", () => {
    const pw = "p@ss/w?rd";
    const text = `auth failed for mongodb://app:${encodeURIComponent(pw)}@h/db (${pw})`;
    const masked = maskSecrets(text, [pw, undefined]);
    expect(masked).not.toContain(pw);
    expect(masked).not.toContain(encodeURIComponent(pw));
  });
});

describe("POST /connections/import", () => {
  const conn = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    name: `Conn ${id}`,
    env: "QA",
    type: "postgres",
    host: "db.example.com",
    port: 5432,
    database: "orders",
    password: "import-pw",
    ...extra,
  });
  const rowCount = () =>
    (
      store
        .getDb()
        .prepare("SELECT COUNT(*) AS n FROM db_connections")
        .get() as {
        n: number;
      }
    ).n;
  const importAudits = () =>
    store
      .getDb()
      .prepare("SELECT sql FROM audit_log WHERE action = 'CONNECTION_IMPORT'")
      .all() as { sql: string }[];

  it("is admin-only", async () => {
    const res = await call(
      "POST",
      "/connections/import",
      { connections: [conn("imp-x")] },
      false,
    );
    expect(res.status).toBe(403);
  });

  it("writes nothing and reports every bad item when any item fails", async () => {
    const before = rowCount();
    const res = await call("POST", "/connections/import", {
      connections: [
        conn("imp-ok"),
        conn("imp-bad", { type: "oracle" }),
        conn("dev-core"),
        conn("imp-dup"),
        conn("imp-dup"),
        "not an object",
      ],
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errors.map((e: any) => [e.index, e.id])).toEqual([
      [1, "imp-bad"],
      [2, "dev-core"],
      [4, "imp-dup"],
      [5, undefined],
    ]);
    expect(body.errors[0].error).toMatch(/^type:/);
    expect(body.errors[1].error).toMatch(/already exists/);
    expect(body.errors[2].error).toMatch(/[Dd]uplicate/);
    expect(rowCount()).toBe(before);
    expect(getConnection("imp-ok")).toBeUndefined();
  });

  it("validates without writing on a dry run", async () => {
    const before = rowCount();
    const ok = await call("POST", "/connections/import", {
      connections: [conn("imp-dry")],
      dryRun: true,
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ errors: [] });
    const bad = await call("POST", "/connections/import", {
      connections: [conn("dev-core")],
      dryRun: true,
    });
    expect(bad.status).toBe(200);
    expect((await bad.json()).errors).toHaveLength(1);
    expect(rowCount()).toBe(before);
    expect(importAudits()).toHaveLength(0);
  });

  it("rejects an empty, oversized or non-array payload", async () => {
    for (const body of [
      { connections: [] },
      { connections: conn("imp-x") },
      [conn("imp-x")],
      {
        connections: Array.from({ length: 201 }, (_, i) => conn(`imp-${i}`)),
      },
    ]) {
      const res = await call("POST", "/connections/import", body);
      expect(res.status, JSON.stringify(body).slice(0, 40)).toBe(400);
    }
  });

  it("creates every item, secrets encrypted, and audits ids without secrets", async () => {
    const res = await call("POST", "/connections/import", {
      connections: [
        conn("imp-a"),
        conn("imp-b", {
          env: "SUPER_PROD",
          type: "mongodb",
          uri: "mongodb://u:uri-secret@db.example.com/orders",
        }),
      ],
    });
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain("import-pw");
    expect(text).not.toContain("uri-secret");
    const views = JSON.parse(text);
    expect(views.map((v: any) => v.id)).toEqual(["imp-a", "imp-b"]);
    expect(views[1]).toMatchObject({ passwordSet: true, uriSet: true });

    expect(getConnection("imp-a")?.password).toBe("import-pw");
    const row = store
      .getDb()
      .prepare("SELECT password_enc FROM db_connections WHERE id = ?")
      .get("imp-a") as { password_enc: string };
    expect(row.password_enc).toMatch(/^enc:v1:/);

    // The production rail applies to an imported production-like env too.
    expect(getEnvironments()).toContain("SUPER_PROD");
    expect(store.getPhiMaskedEnvs()).toContain("SUPER_PROD");

    const audits = importAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0].sql).toContain("imp-a (QA, postgres)");
    expect(audits[0].sql).toContain("imp-b (SUPER_PROD, mongodb)");
    expect(audits[0].sql).not.toContain("import-pw");
    expect(audits[0].sql).not.toContain("uri-secret");
  });

  it("never updates an existing connection", async () => {
    const res = await call("POST", "/connections/import", {
      connections: [conn("imp-a", { host: "elsewhere.example.com" })],
    });
    expect(res.status).toBe(400);
    expect(getConnection("imp-a")?.host).toBe("db.example.com");
    await call("DELETE", "/connections/imp-a");
    await call("DELETE", "/connections/imp-b");
  });
});

describe("operator ceilings (*_LIMIT)", () => {
  const maxOf = async (key: string) =>
    (await (await call("GET")).json()).find((s: any) => s.key === key).max;

  afterAll(() => {
    for (const key of ["MAX_ROWS_LIMIT", "MAX_ROWS"]) vi.stubEnv(key, "");
  });

  it("refuses to save a value above the ceiling", async () => {
    vi.stubEnv("MAX_ROWS_LIMIT", "500");
    const res = await call("PUT", "", { values: { MAX_ROWS: "1000" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(
      "MAX_ROWS must be ≤ 500 (set by the server operator)",
    );
    expect(
      (await call("PUT", "", { values: { MAX_ROWS: "500" } })).status,
    ).toBe(200);
  });

  it("clamps a saved value when the ceiling is lowered below it", async () => {
    vi.stubEnv("MAX_ROWS_LIMIT", "");
    await call("PUT", "", { values: { MAX_ROWS: "1000" } });
    vi.stubEnv("MAX_ROWS_LIMIT", "300");
    expect(settings.getConfigNumber("MAX_ROWS")).toBe(300);
    expect(applyDefaultLimit("SELECT * FROM orders", 5000)).toBe(
      "SELECT * FROM orders LIMIT 300",
    );
  });

  it("clamps the env fallback and the default too", async () => {
    await call("DELETE", "/MAX_ROWS");
    vi.stubEnv("MAX_ROWS_LIMIT", "300");
    expect(settings.getConfigNumber("MAX_ROWS")).toBe(300); // default 10000
    vi.stubEnv("MAX_ROWS", "2000");
    expect(settings.getConfigNumber("MAX_ROWS")).toBe(300);
    vi.stubEnv("MAX_ROWS", "200");
    expect(settings.getConfigNumber("MAX_ROWS")).toBe(200);
    vi.stubEnv("MAX_ROWS", "");
  });

  it("ignores a bogus ceiling or one above the built-in cap", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const bad of ["abc", "0", "-5", "12.5", "2000000"]) {
      vi.stubEnv("MAX_ROWS_LIMIT", bad);
      expect(await maxOf("MAX_ROWS"), bad).toBe(1_000_000);
      expect(settings.getConfigNumber("MAX_ROWS"), bad).toBe(10000);
    }
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("MAX_ROWS_LIMIT"),
    );
    warn.mockRestore();
    expect(
      (await call("PUT", "", { values: { MAX_ROWS: "1000000" } })).status,
    ).toBe(200);
    await call("DELETE", "/MAX_ROWS");
  });

  it("exposes each limit's max in GET /settings", async () => {
    vi.stubEnv("MAX_ROWS_LIMIT", "500");
    vi.stubEnv("SCHEMA_CACHE_TTL_HOURS_LIMIT", "48");
    expect(await maxOf("MAX_ROWS")).toBe(500);
    expect(await maxOf("SCHEMA_CACHE_TTL_HOURS")).toBe(48);
    expect(await maxOf("MCP_MAX_ROWS")).toBe(1_000_000);
    expect(await maxOf("QUERY_TIMEOUT_MS")).toBe(2_147_483_647);
    expect(await maxOf("APP_NAME")).toBeUndefined();
    // The value shown is the effective one: the 10000 default, clamped.
    const list = await (await call("GET")).json();
    expect(list.find((s: any) => s.key === "MAX_ROWS").value).toBe("500");
    vi.stubEnv("SCHEMA_CACHE_TTL_HOURS_LIMIT", "");
  });
});

describe("fallback defaults", () => {
  it("shows the built-in copy formats and favicon as real defaults", async () => {
    vi.stubEnv("COPY_FORMATS", "");
    vi.stubEnv("FAVICON_URL", "");
    const list = await (await call("GET")).json();
    const copy = list.find((s: any) => s.key === "COPY_FORMATS");
    expect(copy.source).toBe("default");
    expect(JSON.parse(copy.value).map((f: any) => f.id)).toContain("csv");
    expect(list.find((s: any) => s.key === "FAVICON_URL")).toMatchObject({
      value: "/favicon-32.png",
      source: "default",
    });
  });
});

describe("login page text", () => {
  const entry = async (key: string) =>
    (await (await call("GET")).json()).find((s: any) => s.key === key);

  it("lists both lines as branding with their defaults", async () => {
    expect(await entry("LOGIN_TAGLINE")).toMatchObject({
      group: "branding",
      value: "Internal query tool",
      source: "default",
    });
    expect(await entry("LOGIN_SUBTITLE")).toMatchObject({
      group: "branding",
      value: "HIPAA · PHI tokenized",
      source: "default",
    });
  });

  it("takes .env, then a saved value, and an empty save hides the line", async () => {
    vi.stubEnv("LOGIN_TAGLINE", "Env tagline");
    expect(await entry("LOGIN_TAGLINE")).toMatchObject({
      value: "Env tagline",
      source: "env",
    });
    await call("PUT", "", {
      values: { LOGIN_TAGLINE: "Saved tagline", LOGIN_SUBTITLE: "" },
    });
    expect(getConfig("LOGIN_TAGLINE")).toBe("Saved tagline");
    // "" is a saved value, not "unset": the line is hidden, Reset restores it.
    expect(await entry("LOGIN_SUBTITLE")).toMatchObject({
      value: "",
      source: "db",
    });
    await call("DELETE", "/LOGIN_SUBTITLE");
    expect(getConfig("LOGIN_SUBTITLE")).toBe("HIPAA · PHI tokenized");
    await call("DELETE", "/LOGIN_TAGLINE");
    expect(getConfig("LOGIN_TAGLINE")).toBe("Env tagline");
    vi.stubEnv("LOGIN_TAGLINE", "");
  });

  it("rejects a line longer than 80 characters", async () => {
    const res = await call("PUT", "", {
      values: { LOGIN_TAGLINE: "x".repeat(81) },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/LOGIN_TAGLINE/);
  });
});
