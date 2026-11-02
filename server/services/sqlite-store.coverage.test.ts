import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import Database from "better-sqlite3";
import { DEFAULT_PHI_RULES } from "../config/phi-defaults.js";

const dir = mkdtempSync(path.join(tmpdir(), "d-pilot-store-cov-"));
vi.stubEnv("DATA_DIR", dir);
vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "coverage-test-key");

const store = await import("./sqlite-store.js");
const { requestSource } = await import("./request-source.js");

afterAll(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("before initDatabase", () => {
  it("reads no settings and no connections", async () => {
    vi.resetModules();
    const fresh = await import("./sqlite-store.js");
    expect(fresh.getSetting("anything")).toBeNull();
    expect(fresh.listDbConnections()).toBeNull();
    vi.resetModules();
  });
});

describe("initDatabase on a fresh data dir", () => {
  beforeAll(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    store.initDatabase();
  });

  it("creates the database file and seeds settings and PHI rules", () => {
    expect(existsSync(path.join(dir, "dbpilot.sqlite"))).toBe(true);
    expect(store.getSetting("write_mode_enabled")).toBe("true");
    expect(store.getSetting("write_direct_envs")).toBe('["DEV"]');
    expect(store.getSetting("phi_masked_envs")).toBe("[]");
    expect(store.getPhiRules()).toHaveLength(DEFAULT_PHI_RULES.length);
    expect(JSON.parse(store.getSetting("phi_seeded_patterns")!)).toEqual(
      DEFAULT_PHI_RULES.map((r) => r.pattern),
    );
  });

  it("re-running keeps existing settings and never re-seeds deleted rules", () => {
    store.setSetting("write_mode_enabled", "false");
    const first = store.getPhiRules()[0];
    expect(store.deletePhiRule(first.id)).toBe(true);
    store.initDatabase();
    expect(store.getSetting("write_mode_enabled")).toBe("false");
    expect(store.getPhiRules().some((r) => r.pattern === first.pattern)).toBe(
      false,
    );
    store.setSetting("write_mode_enabled", "true");
  });

  it("getDb returns the live handle", () => {
    expect(store.getDb().prepare("SELECT 1 AS x").get()).toEqual({ x: 1 });
  });
});

describe("saved queries", () => {
  it("creates, lists by visibility, updates and deletes", () => {
    const own = store.createSavedQuery({
      name: "Recent orders",
      sql: "SELECT * FROM orders",
      createdBy: "u1",
      createdByEmail: "u1@example.com",
      isShared: false,
      tags: ["orders"],
    });
    const shared = store.createSavedQuery({
      name: "Customers",
      sql: "SELECT * FROM customers",
      description: "all customers",
      connectionId: "app_core-dev",
      createdBy: "u2",
      createdByEmail: "u2@example.com",
      isShared: true,
      tags: [],
    });

    expect(store.getSavedQueries("u1").map((q) => q.id)).toEqual(
      expect.arrayContaining([own.id, shared.id]),
    );
    expect(store.getSavedQueries("u3").map((q) => q.id)).toEqual([shared.id]);
    expect(store.getSavedQueryById(own.id, "u3")).toBeNull();
    const read = store.getSavedQueryById(shared.id, "u3")!;
    expect(read).toMatchObject({
      name: "Customers",
      description: "all customers",
      connectionId: "app_core-dev",
      isShared: true,
      tags: [],
    });

    // Only the author may update.
    expect(store.updateSavedQuery(shared.id, "u1", { name: "x" })).toBeNull();
    const updated = store.updateSavedQuery(own.id, "u1", {
      name: "Orders v2",
      sql: "SELECT id FROM orders",
      description: "d",
      connectionId: "app_core-qa",
      isShared: true,
      tags: ["a", "b"],
    })!;
    expect(updated).toMatchObject({
      name: "Orders v2",
      sql: "SELECT id FROM orders",
      description: "d",
      connectionId: "app_core-qa",
      isShared: true,
      tags: ["a", "b"],
    });
    // Unset fields are kept; isShared false is applied.
    const partial = store.updateSavedQuery(own.id, "u1", { isShared: false })!;
    expect(partial).toMatchObject({ name: "Orders v2", isShared: false });
    expect(store.updateSavedQuery(own.id, "u1", {})!.tags).toEqual(["a", "b"]);

    expect(store.deleteSavedQuery(own.id, "u2")).toBe(false);
    expect(store.deleteSavedQuery(own.id, "u1")).toBe(true);
    expect(store.getSavedQueryById(own.id, "u1")).toBeNull();
  });

  it("maps empty tags to an empty list", () => {
    const q = store.createSavedQuery({
      name: "t",
      sql: "SELECT 1",
      createdBy: "u9",
      createdByEmail: "u9@example.com",
      isShared: false,
      tags: [],
    });
    store
      .getDb()
      .prepare("UPDATE saved_queries SET tags = '' WHERE id = ?")
      .run(q.id);
    expect(store.getSavedQueryById(q.id, "u9")!.tags).toEqual([]);
  });
});

describe("artifacts", () => {
  it("creates, updates, archives and restores", () => {
    const a = store.createArtifact({
      title: "Orders report",
      blocks: [{ type: "sql", sql: "SELECT * FROM orders" }],
      createdBy: "u1",
      createdByEmail: "u1@example.com",
      isShared: true,
      tags: ["orders"],
    });
    const priv = store.createArtifact({
      title: "Private",
      description: "mine",
      connectionId: "app_core-dev",
      blocks: [{ type: "text", body: "hi" }],
      createdBy: "u1",
      createdByEmail: "u1@example.com",
      isShared: false,
      tags: [],
    });

    expect(store.getArtifacts("u2").map((x) => x.id)).toContain(a.id);
    expect(store.getArtifacts("u2").map((x) => x.id)).not.toContain(priv.id);
    expect(store.getArtifactById(priv.id, "u2")).toBeNull();
    expect(store.getArtifactById(priv.id, "u1")).toMatchObject({
      description: "mine",
      connectionId: "app_core-dev",
      isShared: false,
      blocks: [{ type: "text", body: "hi" }],
    });

    expect(store.updateArtifact(a.id, "u2", { title: "x" })).toBeNull();
    const up = store.updateArtifact(a.id, "u1", {
      title: "Orders v2",
      description: "desc",
      blocks: [{ type: "html", body: "<p>x</p>" }],
      connectionId: "app_core-qa",
      isShared: false,
      tags: ["t"],
    })!;
    expect(up).toMatchObject({
      title: "Orders v2",
      description: "desc",
      blocks: [{ type: "html", body: "<p>x</p>" }],
      connectionId: "app_core-qa",
      isShared: false,
      tags: ["t"],
    });
    expect(store.updateArtifact(a.id, "u1", { isShared: true })).toMatchObject({
      title: "Orders v2",
      isShared: true,
      tags: ["t"],
    });
    // Omitted isShared leaves sharing as it is.
    const v3 = store.updateArtifact(a.id, "u1", { title: "Orders v3" })!;
    expect(v3).toMatchObject({ title: "Orders v3", isShared: true });

    expect(store.setArtifactArchived(a.id, "u2", true)).toBeNull();
    const archived = store.setArtifactArchived(a.id, "u1", true)!;
    expect(archived.archivedAt).toEqual(expect.any(String));
    expect(archived.updatedAt).toBe(v3.updatedAt);
    expect(store.getArtifacts("u1").map((x) => x.id)).not.toContain(a.id);
    // A share link still opens an archived artifact.
    expect(store.getArtifactById(a.id, "u2")!.archivedAt).toBeDefined();

    const restored = store.setArtifactArchived(a.id, "u1", false)!;
    expect(restored.archivedAt).toBeUndefined();
    expect(store.getArtifacts("u1").map((x) => x.id)).toContain(a.id);
  });

  it("maps empty blocks/tags columns to empty lists", () => {
    const a = store.createArtifact({
      title: "Empty",
      blocks: [],
      createdBy: "u5",
      createdByEmail: "u5@example.com",
      isShared: true,
      tags: [],
    });
    store
      .getDb()
      .prepare("UPDATE artifacts SET blocks = '', tags = '' WHERE id = ?")
      .run(a.id);
    expect(store.getArtifactById(a.id, "u5")).toMatchObject({
      blocks: [],
      tags: [],
    });
  });
});

describe("PHI rules", () => {
  it("upserts, imports and bulk-deletes", () => {
    const created = store.upsertPhiRule({
      pattern: "customer_note",
      maskingType: "REDACT",
      alwaysMasked: false,
      database: "app_core",
      table: "customers",
    });
    expect(created.id).toEqual(expect.any(String));
    const updated = store.upsertPhiRule({
      id: created.id,
      pattern: "customer_note",
      maskingType: "HASH",
      alwaysMasked: true,
    });
    expect(updated.id).toBe(created.id);
    const stored = store.getPhiRules().find((r) => r.id === created.id)!;
    expect(stored).toMatchObject({
      maskingType: "HASH",
      alwaysMasked: true,
      database: null,
      table: null,
    });

    store.applyPhiRuleImport(
      [
        { pattern: "order_secret", maskingType: "FULL", alwaysMasked: true },
        {
          pattern: "order_hint",
          maskingType: "PARTIAL",
          alwaysMasked: false,
          database: "app_core",
          table: "orders",
        },
      ],
      [
        {
          id: created.id,
          pattern: "customer_note2",
          maskingType: "FULL",
          alwaysMasked: false,
          database: "app_core",
          table: "customers",
        },
        {
          id: store.getPhiRules().find((r) => r.pattern !== "customer_note")!
            .id,
          pattern: "renamed_rule",
          maskingType: "FULL",
          alwaysMasked: true,
        },
      ],
    );
    const rules = store.getPhiRules();
    expect(rules.find((r) => r.id === created.id)).toMatchObject({
      pattern: "customer_note2",
      maskingType: "FULL",
      alwaysMasked: false,
      database: "app_core",
      table: "customers",
    });
    expect(rules.find((r) => r.pattern === "order_hint")).toMatchObject({
      database: "app_core",
      table: "orders",
    });
    expect(rules.some((r) => r.pattern === "renamed_rule")).toBe(true);

    expect(store.deletePhiRule("missing")).toBe(false);

    const locked = rules.filter((r) => r.alwaysMasked).length;
    const unlocked = rules.length - locked;
    expect(store.deleteAllPhiRules(false)).toEqual({
      deleted: unlocked,
      kept: locked,
    });
    expect(store.getPhiRules().every((r) => r.alwaysMasked)).toBe(true);
    expect(store.deleteAllPhiRules(true)).toEqual({ deleted: locked, kept: 0 });
    expect(store.getPhiRules()).toEqual([]);
  });
});

describe("settings", () => {
  it("sets, overwrites and deletes", () => {
    store.setSetting("custom_key", "a");
    store.setSetting("custom_key", "b");
    expect(store.getSetting("custom_key")).toBe("b");
    expect(store.deleteSetting("custom_key")).toBe(true);
    expect(store.deleteSetting("custom_key")).toBe(false);
    expect(store.getSetting("custom_key")).toBeNull();
  });

  it("write mode is on unless set to false", () => {
    store.setSetting("write_mode_enabled", "false");
    expect(store.getWriteModeEnabled()).toBe(false);
    store.deleteSetting("write_mode_enabled");
    expect(store.getWriteModeEnabled()).toBe(true);
  });
});

describe("connections", () => {
  const full = {
    id: "app_core-dev",
    name: "App Core",
    env: "DEV",
    type: "postgres" as const,
    host: "localhost",
    port: 5432,
    database: "app_core",
    username: "reader",
    password: "pw-1",
    schema: "public",
    schemas: ["public", "sales"],
    uri: "postgres://reader:pw-1@localhost/app_core",
  };

  it("saves with encrypted secrets and lists them decrypted", () => {
    store.saveDbConnection(full);
    store.saveDbConnection({
      id: "orders-qa",
      name: "Orders",
      env: "QA",
      type: "mongodb",
    });
    const raw = store
      .getDb()
      .prepare("SELECT password_enc, uri_enc FROM db_connections WHERE id = ?")
      .get(full.id) as { password_enc: string; uri_enc: string };
    expect(raw.password_enc).not.toContain("pw-1");
    expect(raw.uri_enc).toMatch(/^enc:v1:/);

    const list = store.listDbConnections()!;
    expect(list.find((c) => c.id === full.id)).toEqual(full);
    // Absent optional fields are left off, not set to null.
    expect(list.find((c) => c.id === "orders-qa")).toEqual({
      id: "orders-qa",
      name: "Orders",
      env: "QA",
      type: "mongodb",
    });

    expect(store.storedConnectionSecrets(full.id)).toEqual({
      password: true,
      uri: true,
    });
    expect(store.storedConnectionSecrets("orders-qa")).toEqual({
      password: false,
      uri: false,
    });
    expect(store.storedConnectionSecrets("missing")).toEqual({
      password: false,
      uri: false,
    });
    const all = store.allStoredConnectionSecrets();
    expect(all.get(full.id)).toEqual({ password: true, uri: true });
    expect(all.get("orders-qa")).toEqual({ password: false, uri: false });
  });

  it("keeps stored secrets when asked, replaces them otherwise", () => {
    const { password: _p, uri: _u, ...noSecrets } = full;
    store.saveDbConnection(noSecrets, { password: true, uri: true });
    let conn = store.listDbConnections()!.find((c) => c.id === full.id)!;
    expect(conn.password).toBe("pw-1");
    expect(conn.uri).toBe(full.uri);

    store.saveDbConnection(noSecrets);
    conn = store.listDbConnections()!.find((c) => c.id === full.id)!;
    expect(conn.password).toBeUndefined();
    expect(conn.uri).toBeUndefined();
    store.saveDbConnection(full);
  });

  it("drops a secret that no longer decrypts but still reports it stored", () => {
    store.saveDbConnection({
      id: "bad-secret",
      name: "B",
      env: "DEV",
      type: "mssql",
    });
    store
      .getDb()
      .prepare(
        "UPDATE db_connections SET password_enc = 'garbage', uri_enc = 'garbage' WHERE id = 'bad-secret'",
      )
      .run();
    const conn = store.listDbConnections()!.find((c) => c.id === "bad-secret")!;
    expect(conn.password).toBeUndefined();
    expect(conn.uri).toBeUndefined();
    expect(store.storedConnectionSecrets("bad-secret")).toEqual({
      password: true,
      uri: true,
    });
    expect(store.deleteDbConnection("bad-secret")).toBe(true);
    expect(store.deleteDbConnection("bad-secret")).toBe(false);
  });

  it("saves several connections all-or-nothing", () => {
    store.saveDbConnections([
      { id: "orders-uat", name: "Orders", env: "UAT", type: "postgres" },
      { id: "orders-prod", name: "Orders", env: "PROD", type: "postgres" },
    ]);
    const ids = store.listDbConnections()!.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(["orders-uat", "orders-prod"]));

    expect(() =>
      store.saveDbConnections([
        { id: "orders-stg", name: "Orders", env: "STG", type: "postgres" },
        { id: "broken", name: null as any, env: "STG", type: "postgres" },
      ]),
    ).toThrow();
    expect(store.listDbConnections()!.map((c) => c.id)).not.toContain(
      "orders-stg",
    );
  });

  it("fingerprints the connection target", () => {
    expect(store.connectionTarget({ ...full, id: "missing" })).toBeNull();
    const t1 = store.connectionTarget(full)!;
    expect(t1).toMatch(/^[0-9a-f]{64}$/);
    // Name and password are not part of the target.
    expect(
      store.connectionTarget({ ...full, name: "Other", password: "pw-2" }),
    ).toBe(t1);
    expect(store.connectionTarget({ ...full, host: "elsewhere" })).not.toBe(t1);
    // Updating keeps the instance id; delete + re-create gives a new one.
    store.saveDbConnection(full);
    expect(store.connectionTarget(full)).toBe(t1);
    store.deleteDbConnection(full.id);
    store.saveDbConnection(full);
    expect(store.connectionTarget(full)).not.toBe(t1);
    // A bare connection still hashes.
    expect(
      store.connectionTarget({
        id: "orders-qa",
        name: "Orders",
        env: "QA",
        type: "mongodb",
      }),
    ).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("environment policy settings", () => {
  // orders-prod (PROD) was stored above, so PROD is a production env here.
  it("always masks production environments", () => {
    store.setSetting("phi_masked_envs", '["QA","PROD"]');
    expect(store.getPhiMaskedEnvs()).toEqual(["PROD", "QA"]);
    store.setSetting("phi_masked_envs", "not json");
    expect(store.getPhiMaskedEnvs()).toEqual(["PROD"]);
    store.setSetting("phi_masked_envs", '{"QA":true}');
    expect(store.getPhiMaskedEnvs()).toEqual(["PROD"]);
    store.deleteSetting("phi_masked_envs");
    expect(store.getPhiMaskedEnvs()).toEqual(["PROD"]);
  });

  it("never allows direct writes on production", () => {
    store.setSetting("write_direct_envs", '["DEV","QA","PROD","SUPER_PROD"]');
    expect(store.getWriteDirectEnvs()).toEqual(["DEV", "QA"]);
    store.setSetting("write_direct_envs", "not json");
    expect(store.getWriteDirectEnvs()).toEqual(["DEV"]);
    store.setSetting("write_direct_envs", '"QA"');
    expect(store.getWriteDirectEnvs()).toEqual(["DEV"]);
    store.deleteSetting("write_direct_envs");
    expect(store.getWriteDirectEnvs()).toEqual(["DEV"]);
  });
});

describe("audit log", () => {
  it("logs entries with and without a request source and filters them", () => {
    store.logAudit({
      userId: "a1",
      userEmail: "a1@example.com",
      action: "QUERY_EXECUTE",
      sql: "SELECT * FROM orders",
      connectionId: "app_core-dev",
      rowsReturned: 3,
      executionMs: 12,
      phiAccessed: true,
      phiFieldsUnmasked: ["email"],
      phiUnmaskReason: "support",
      phiUnmaskNotes: "ticket",
    });
    requestSource({ get: () => "mcp" } as any, {} as any, () =>
      store.logAudit({
        userId: "a2",
        userEmail: "a2@example.com",
        action: "PHI_UNMASK_DENIED",
        phiAccessed: false,
      }),
    );
    store.logAudit({
      userId: "a2",
      userEmail: "a2@example.com",
      action: "LOGIN",
      phiAccessed: false,
    });

    const all = store.getAuditLog();
    expect(all).toHaveLength(3);
    const first = all.find((e) => e.userId === "a1")!;
    expect(first).toMatchObject({
      sql: "SELECT * FROM orders",
      rowsReturned: 3,
      executionMs: 12,
      phiAccessed: true,
      phiFieldsUnmasked: ["email"],
      phiUnmaskReason: "support",
      phiUnmaskNotes: "ticket",
      source: undefined,
    });
    const denied = all.find((e) => e.action === "PHI_UNMASK_DENIED")!;
    expect(denied).toMatchObject({
      source: "mcp",
      sql: null,
      phiFieldsUnmasked: [],
      phiUnmaskReason: undefined,
    });

    expect(store.getAuditLog({ userId: "a2" })).toHaveLength(2);
    expect(store.getAuditLog({ action: "LOGIN" })).toHaveLength(1);
    expect(
      store
        .getAuditLog({ phiOnly: true })
        .map((e) => e.action)
        .sort(),
    ).toEqual(["PHI_UNMASK_DENIED", "QUERY_EXECUTE"]);
    expect(
      store.getAuditLog({ from: "2000-01-01", to: "2999-01-01" }),
    ).toHaveLength(3);
    expect(store.getAuditLog({ from: "2999-01-01" })).toEqual([]);
    expect(store.getAuditLog({ to: "2000-01-01" })).toEqual([]);
    expect(store.getAuditLog({ limit: 1 })).toHaveLength(1);
    expect(store.getAuditLog({ limit: 1_000_000, offset: 2 })).toHaveLength(1);
  });

  it("returns only the user's own executed queries as history", () => {
    const h = store.getQueryHistory("a1");
    expect(h.map((e) => e.sql)).toEqual(["SELECT * FROM orders"]);
    expect(store.getQueryHistory("a1", 10, 1)).toEqual([]);
    expect(store.getQueryHistory("a2")).toEqual([]);
  });
});

describe("AI chat log", () => {
  it("logs and filters entries", () => {
    store.logAiChat({
      userId: "c1",
      userEmail: "c1@example.com",
      connectionId: "app_core-dev",
      dbType: "postgres",
      prompt: "top customers",
      systemPrompt: "sys",
      userMessage: "msg",
      responseRaw: "{}",
      generatedQuery: "SELECT * FROM customers",
      explanation: "e",
      model: "m",
      promptTokens: 1,
      completionTokens: 2,
      totalTokens: 3,
      latencyMs: 4,
      status: "success",
      schemaTruncated: true,
      tablesProvided: 5,
      totalTables: 6,
    });
    store.logAiChat({
      userId: "c2",
      userEmail: "c2@example.com",
      prompt: "orders",
      status: "error",
      errorMessage: "boom",
      schemaTruncated: false,
    });
    store.logAiChat({
      userId: "c2",
      userEmail: "c2@example.com",
      prompt: "orders again",
      status: "error",
    });

    const all = store.getAiChatLog();
    expect(all).toHaveLength(3);
    expect(all.find((e) => e.userId === "c1")).toMatchObject({
      connectionId: "app_core-dev",
      dbType: "postgres",
      systemPrompt: "sys",
      totalTokens: 3,
      schemaTruncated: true,
      tablesProvided: 5,
      totalTables: 6,
    });
    const boom = all.find((e) => e.errorMessage === "boom")!;
    expect(boom.schemaTruncated).toBe(false);
    expect(boom.connectionId).toBeUndefined();
    expect(
      all.find((e) => e.prompt === "orders again")!.schemaTruncated,
    ).toBeUndefined();

    expect(store.getAiChatLog({ status: "error" })).toHaveLength(2);
    expect(store.getAiChatLog({ userId: "c1" })).toHaveLength(1);
    expect(store.getAiChatLog({ from: "2999-01-01" })).toEqual([]);
    expect(
      store.getAiChatLog({ to: "2999-01-01", limit: 5000, offset: 1 }),
    ).toHaveLength(2);
  });
});

describe("analytics", () => {
  it("aggregates users, queries, AI usage and daily series", () => {
    const db = store.getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, last_login TEXT, is_admin INTEGER NOT NULL DEFAULT 0,
      allowed_environments TEXT, unmask_environments TEXT,
      write_environments TEXT, approve_environments TEXT)`);
    const ins = db.prepare("INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?)");
    ins.run("adm", "2999-01-01 00:00:00", 1, null, null, null, null);
    ins.run("r1", null, 0, '["DEV"]', "[]", '["DEV"]', null);
    ins.run("r2", "2000-01-01 00:00:00", 0, "[]", '["QA"]', null, '["QA"]');

    store.logAudit({
      userId: "a1",
      userEmail: "a1@example.com",
      action: "EXPORT_CSV",
      phiAccessed: false,
    });
    store.logAudit({
      userId: "a1",
      userEmail: "a1@example.com",
      action: "QUERY_ERROR",
      phiAccessed: false,
    });
    store.logAudit({
      userId: "a3",
      userEmail: "a3@example.com",
      action: "QUERY_EXECUTE",
      sql: "SELECT 1",
      executionMs: 30,
      rowsReturned: 7,
      phiAccessed: false,
    });
    store.logAudit({
      userId: "a3",
      userEmail: "a3@example.com",
      action: "PHI_UNMASK",
      phiAccessed: true,
    });

    const a = store.getAnalytics();
    expect(a.totals).toMatchObject({
      totalUsers: 3,
      activeUsers: 1,
      neverLoggedIn: 1,
      queriesToday: 2,
      queries30d: 2,
      queriesTotal: 2,
      dauToday: 3,
      wau: 3,
      mau: 3,
      phiUnmask30d: 1,
      phiDenied30d: 1,
      errors30d: 1,
      exports30d: 1,
      avgLatencyMs: 21,
      totalRows30d: 10,
      aiGenerations30d: 3,
      aiSuccess30d: 1,
      aiTokens30d: 3,
    });
    expect(a.totals.savedQueries).toBeGreaterThan(0);
    expect(a.capabilityDistribution).toEqual([
      { capability: "admin", count: 1 },
      { capability: "unmask_phi", count: 2 },
      { capability: "write", count: 2 },
      { capability: "approve", count: 2 },
      { capability: "read", count: 2 },
    ]);
    expect(a.daily).toHaveLength(30);
    const today = new Date().toISOString().slice(0, 10);
    expect(a.daily[29]).toEqual({
      date: today,
      queries: 2,
      activeUsers: 3,
      aiQueries: 3,
    });
    expect(a.daily[0]).toMatchObject({ queries: 0, activeUsers: 0 });
    expect(a.actionBreakdown).toContainEqual({
      action: "QUERY_EXECUTE",
      count: 2,
    });
    expect(a.topUsers.map((u: any) => u.email).sort()).toEqual([
      "a1@example.com",
      "a3@example.com",
    ]);
    expect(a.byConnection).toEqual(
      expect.arrayContaining([
        { connectionId: "app_core-dev", count: 1 },
        { connectionId: "(none)", count: 1 },
      ]),
    );
  });
});

describe("audit archival", () => {
  const archivePath = () => path.join(dir, "audit_archive.sqlite");

  it("has nothing to read before the archive exists", () => {
    expect(existsSync(archivePath())).toBe(false);
    expect(store.queryArchive()).toEqual([]);
  });

  it("moves old entries to the archive and runs when due", () => {
    const db = store.getDb();
    db.prepare(
      "UPDATE audit_log SET timestamp = '2020-01-01 00:00:00' WHERE user_id = 'a2'",
    ).run();

    // No previous run: archiveIfDue archives right away.
    expect(store.getSetting("last_audit_archive")).toBeNull();
    store.archiveIfDue();
    const archived = store.queryArchive();
    expect(archived.map((e) => e.userId)).toEqual(["a2", "a2"]);
    expect(archived.find((e) => e.action === "PHI_UNMASK_DENIED")!.source).toBe(
      "mcp",
    );
    expect(store.queryArchive({ action: "LOGIN" })).toHaveLength(1);
    expect(store.getAuditLog({ userId: "a2" })).toEqual([]);
    const lastRun = store.getSetting("last_audit_archive")!;
    expect(lastRun).toEqual(expect.any(String));

    // Recent run: not due.
    db.prepare(
      "UPDATE audit_log SET timestamp = '2020-01-01 00:00:00' WHERE user_id = 'a3'",
    ).run();
    store.archiveIfDue();
    expect(store.getSetting("last_audit_archive")).toBe(lastRun);
    expect(store.getAuditLog({ userId: "a3" })).toHaveLength(2);

    // Last run long ago: due again.
    store.setSetting("last_audit_archive", "2020-01-01T00:00:00.000Z");
    store.archiveIfDue();
    expect(store.getAuditLog({ userId: "a3" })).toEqual([]);
    expect(store.queryArchive({ userId: "a3" })).toHaveLength(2);
  });

  it("archives nothing when nothing is old enough", () => {
    expect(store.archiveOldAuditEntries(30)).toEqual({ archived: 0 });
  });

  it("skips a call made while an archive run is in progress", () => {
    const db = store.getDb();
    db.prepare(
      "UPDATE audit_log SET timestamp = '2020-01-01 00:00:00' WHERE user_id = 'a1'",
    ).run();
    const before = store.getSetting("last_audit_archive");
    store.setSetting("last_audit_archive", "2020-01-01T00:00:00.000Z");
    const nested: unknown[] = [];
    // console.log runs inside the lock (after rows moved) — re-enter from it.
    vi.mocked(console.log).mockImplementationOnce(() => {
      nested.push(store.archiveOldAuditEntries());
      nested.push(store.archiveIfDue());
    });
    const result = store.archiveOldAuditEntries();
    expect(result.archived).toBeGreaterThan(0);
    expect(nested).toEqual([{ archived: 0 }, undefined]);
    expect(before).not.toBeNull();
    expect(store.getAuditLog({ userId: "a1" })).toEqual([]);
  });
});

describe("write requests", () => {
  const base = {
    title: "Fix orders",
    connectionId: "orders-uat",
    env: "UAT",
    dbType: "postgres",
    writeSql: "UPDATE orders SET status = 'x' WHERE id = 1",
    status: "PENDING" as const,
    requestedBy: "w1",
    requestedByEmail: "w1@example.com",
  };

  it("creates with defaults and with every optional field", () => {
    const plain = store.createWriteRequest(base);
    expect(plain).toMatchObject({
      title: "Fix orders",
      description: undefined,
      connectionName: undefined,
      selectSql: "",
      status: "PENDING",
      isMigration: false,
      noTransaction: false,
      transactional: undefined,
      aiReview: undefined,
      events: [],
    });
    expect(plain.kind).toBeUndefined();

    const full = store.createWriteRequest({
      ...base,
      description: "d",
      connectionName: "Orders",
      selectSql: "SELECT * FROM orders WHERE id = 1",
      isMigration: true,
      noTransaction: true,
      status: "DRAFT",
      requestedBy: "w2",
      env: "QA",
    });
    expect(full).toMatchObject({
      description: "d",
      connectionName: "Orders",
      selectSql: "SELECT * FROM orders WHERE id = 1",
      isMigration: true,
      noTransaction: true,
      status: "DRAFT",
    });
    expect(store.getWriteRequest("missing")).toBeNull();
    expect(store.getWriteRequest(full.id, false)!.events).toBeUndefined();
  });

  it("maps object and job changes", () => {
    const obj = store.createWriteRequest({
      ...base,
      dbType: "mssql",
      kind: "object_change",
      target: { schema: "dbo", name: "refresh_orders", type: "PROCEDURE" },
      snapshot: "CREATE PROCEDURE dbo.refresh_orders AS SELECT 1",
      writeSql:
        "CREATE OR ALTER PROCEDURE dbo.refresh_orders AS SELECT 'password=hunter22'",
    });
    expect(obj).toMatchObject({
      kind: "object_change",
      object: { schema: "dbo", name: "refresh_orders", type: "PROCEDURE" },
      snapshot: "CREATE PROCEDURE dbo.refresh_orders AS SELECT 1",
      restoreSql: "CREATE OR ALTER PROCEDURE dbo.refresh_orders AS SELECT 1",
    });
    expect(obj.warnings).toHaveLength(1);

    const noSnap = store.createWriteRequest({
      ...base,
      kind: "object_change",
      target: { name: "v_orders" },
    });
    expect(noSnap).toMatchObject({
      snapshot: null,
      restoreSql: null,
      warnings: [],
    });

    const job = store.createWriteRequest({
      ...base,
      kind: "job_change",
      target: { jobId: "7", action: { type: "set_enabled", enabled: false } },
      snapshot: '{"job":"nightly"}',
    });
    expect(job).toMatchObject({
      kind: "job_change",
      jobChange: {
        jobId: "7",
        action: { type: "set_enabled", enabled: false },
      },
      summary: "Disables the job",
      snapshot: '{"job":"nightly"}',
    });
    const jobNoSnap = store.createWriteRequest({
      ...base,
      kind: "job_change",
      target: { jobId: "8", action: { type: "rename", name: "n" } },
    });
    expect(jobNoSnap.snapshot).toBeNull();
    expect(jobNoSnap.summary).toBe('Renames the job to "n"');
  });

  it("lists by visibility and status", () => {
    const all = store.listWriteRequests();
    expect(all.length).toBeGreaterThanOrEqual(6);
    expect(
      store.listWriteRequests({ requestedBy: "w2" }).map((r) => r.requestedBy),
    ).toEqual(["w2"]);
    expect(
      store.listWriteRequests({ envs: ["QA"] }).every((r) => r.env === "QA"),
    ).toBe(true);
    // Own OR approvable env.
    expect(
      store.listWriteRequests({ requestedBy: "w2", envs: ["UAT"] }).length,
    ).toBe(all.length);
    expect(
      store.listWriteRequests({ statuses: ["DRAFT"] }).map((r) => r.status),
    ).toEqual(["DRAFT"]);
    expect(store.listWriteRequests({ envs: [], statuses: [] }).length).toBe(
      all.length,
    );
    expect(store.listWriteRequests({ limit: 2 })).toHaveLength(2);
    expect(store.listWriteRequests({ limit: 5000 }).length).toBe(all.length);
  });

  it("updates fields, binds targets and records events", () => {
    const wr = store.createWriteRequest(base);
    const review = {
      verdict: "SAFE" as const,
      risks: [],
      summary: "ok",
      recommendation: "approve",
    };
    const up = store.updateWriteRequest(wr.id, {
      status: "EXECUTED",
      requestedBy: "w3",
      requestedByEmail: "w3@example.com",
      reviewedBy: "r1",
      reviewedByEmail: "r1@example.com",
      reviewedAt: "2026-01-01T00:00:00Z",
      reviewNotes: "lgtm",
      executedAt: "2026-01-01T00:01:00Z",
      executedBy: "r1",
      executedByEmail: "r1@example.com",
      rowsAffected: 4,
      executionMs: 9,
      executionError: "none",
      transactional: true,
      aiVerdict: "SAFE",
      aiReview: review,
    })!;
    expect(up).toMatchObject({
      status: "EXECUTED",
      requestedBy: "w3",
      reviewedBy: "r1",
      reviewNotes: "lgtm",
      rowsAffected: 4,
      executionMs: 9,
      executionError: "none",
      transactional: true,
      aiVerdict: "SAFE",
      aiReview: review,
    });
    expect(
      store.updateWriteRequest(wr.id, { transactional: false })!.transactional,
    ).toBe(false);
    // Nothing to change: returns the request as it is.
    expect(store.updateWriteRequest(wr.id, {})!.status).toBe("EXECUTED");
    expect(store.updateWriteRequest("missing", {})).toBeNull();

    store
      .getDb()
      .prepare("UPDATE write_requests SET ai_review_json = '{bad' WHERE id = ?")
      .run(wr.id);
    expect(store.getWriteRequest(wr.id)!.aiReview).toBeUndefined();

    expect(store.getWriteRequestTarget(wr.id)).toBeNull();
    store.setWriteRequestTarget(wr.id, "abc");
    expect(store.getWriteRequestTarget(wr.id)).toBe("abc");
    expect(store.getWriteRequestTarget("missing")).toBeNull();

    store.addWriteRequestEvent(wr.id, "w1", "w1@example.com", "SUBMITTED");
    store.addWriteRequestEvent(wr.id, "r1", "r1@example.com", "APPROVED", "ok");
    const events = store.getWriteRequestEvents(wr.id);
    expect(events.map((e) => [e.event, e.notes])).toEqual([
      ["APPROVED", "ok"],
      ["SUBMITTED", undefined],
    ]);
    expect(store.getWriteRequest(wr.id)!.events).toHaveLength(2);

    expect(store.deleteWriteRequest(wr.id)).toBe(true);
    expect(store.getWriteRequestEvents(wr.id)).toEqual([]);
    expect(store.deleteWriteRequest(wr.id)).toBe(false);
  });

  it("claims a status for exactly one caller", () => {
    const wr = store.createWriteRequest(base);
    expect(store.claimWriteRequestForApproval(wr.id)).toBe(true);
    expect(store.claimWriteRequestForApproval(wr.id)).toBe(false);
    expect(store.claimWriteRequestStatus(wr.id, "APPROVED", "EXECUTED")).toBe(
      true,
    );
    expect(store.getWriteRequest(wr.id)!.status).toBe("EXECUTED");
  });

  it("revises only from the expected status and clears the prior outcome", () => {
    const wr = store.createWriteRequest({ ...base, status: "REJECTED" });
    store.updateWriteRequest(wr.id, {
      reviewedBy: "r1",
      reviewNotes: "no",
      aiVerdict: "DANGEROUS",
    });
    const fields = {
      env: "QA",
      connectionName: "Orders QA",
      title: "Fix orders v2",
      description: "d2",
      selectSql: "SELECT 1",
      writeSql: "UPDATE orders SET status = 'y' WHERE id = 2",
      isMigration: true,
      noTransaction: true,
      status: "PENDING" as const,
      snapshot: "ignored for plain writes",
    };
    expect(store.reviseWriteRequest(wr.id, fields, "PENDING")).toBeNull();
    const revised = store.reviseWriteRequest(wr.id, fields, "REJECTED")!;
    expect(revised).toMatchObject({
      env: "QA",
      connectionName: "Orders QA",
      title: "Fix orders v2",
      description: "d2",
      selectSql: "SELECT 1",
      isMigration: true,
      noTransaction: true,
      status: "PENDING",
      reviewedBy: undefined,
      reviewNotes: undefined,
      aiVerdict: undefined,
    });
    expect(revised.kind).toBeUndefined();

    const minimal = store.reviseWriteRequest(
      wr.id,
      {
        env: "QA",
        title: "t",
        writeSql: "DELETE FROM orders WHERE id = 3",
        status: "DRAFT",
      },
      "PENDING",
    )!;
    expect(minimal).toMatchObject({
      connectionName: undefined,
      description: undefined,
      selectSql: "",
      isMigration: false,
      noTransaction: false,
      status: "DRAFT",
    });

    // object_change re-bases its snapshot; other kinds keep theirs.
    const obj = store.createWriteRequest({
      ...base,
      status: "DRAFT",
      kind: "object_change",
      target: { name: "v_orders" },
      snapshot: "CREATE VIEW v_orders AS SELECT 1",
    });
    expect(
      store.reviseWriteRequest(
        obj.id,
        {
          ...fields,
          status: "DRAFT",
          snapshot: "CREATE VIEW v_orders AS SELECT 2",
        },
        "DRAFT",
      )!.snapshot,
    ).toBe("CREATE VIEW v_orders AS SELECT 2");
    expect(
      store.reviseWriteRequest(
        obj.id,
        { ...fields, status: "DRAFT", snapshot: undefined },
        "DRAFT",
      )!.snapshot,
    ).toBeNull();
    const job = store.createWriteRequest({
      ...base,
      status: "DRAFT",
      kind: "job_change",
      target: { jobId: "1", action: { type: "delete_step", stepId: 2 } },
      snapshot: "job-v1",
    });
    expect(
      store.reviseWriteRequest(job.id, { ...fields, status: "DRAFT" }, "DRAFT")!
        .snapshot,
    ).toBe("job-v1");
  });

  it("counts a scalar query that returns no row as zero", () => {
    const db = store.getDb();
    const prepare = db.prepare.bind(db);
    const empty = new Set([
      "SELECT COUNT(*) v FROM users",
      "SELECT COUNT(*) v FROM write_requests WHERE status='PENDING'",
    ]);
    const spy = vi
      .spyOn(db, "prepare")
      .mockImplementation(((sql: string) =>
        empty.has(sql) ? { get: () => undefined } : prepare(sql)) as any);
    try {
      expect(store.getAnalytics().totals.totalUsers).toBe(0);
      expect(store.getWriteAnalytics().pendingQueue).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("summarizes write activity", () => {
    const db = store.getDb();
    db.prepare("DELETE FROM write_requests").run();
    const a = store.createWriteRequest(base);
    const b = store.createWriteRequest(base);
    const c = store.createWriteRequest(base);
    store.createWriteRequest(base);
    store.updateWriteRequest(a.id, { status: "EXECUTED", rowsAffected: 5 });
    store.updateWriteRequest(b.id, { status: "REJECTED" });
    store.updateWriteRequest(c.id, { status: "FAILED" });
    expect(store.getWriteAnalytics()).toEqual({
      totals: {
        submitted30d: 4,
        executed30d: 1,
        rejected30d: 1,
        failed30d: 1,
        rowsAffected30d: 5,
      },
      pendingQueue: 1,
    });
  });
});

describe("upgrading an existing database", () => {
  const oldDir = mkdtempSync(path.join(tmpdir(), "d-pilot-store-old-"));

  afterAll(() => {
    rmSync(oldDir, { recursive: true, force: true });
  });

  it("adds missing columns, binds pending requests and keeps admin-deleted defaults out", () => {
    const old = new Database(path.join(oldDir, "dbpilot.sqlite"));
    old.exec(`
      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
        blocks TEXT NOT NULL DEFAULT '[]', connection_id TEXT,
        created_by TEXT NOT NULL, created_by_email TEXT NOT NULL,
        is_shared INTEGER NOT NULL DEFAULT 1, tags TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE audit_log (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, user_email TEXT NOT NULL,
        action TEXT NOT NULL, sql TEXT, connection_id TEXT, rows_returned INTEGER,
        execution_ms INTEGER, phi_accessed INTEGER NOT NULL DEFAULT 0,
        phi_fields_unmasked TEXT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE db_connections (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, env TEXT NOT NULL, type TEXT NOT NULL,
        host TEXT, port INTEGER, database_name TEXT, username TEXT, password_enc TEXT,
        schema_name TEXT, schemas TEXT, uri_enc TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE write_requests (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
        connection_id TEXT NOT NULL, connection_name TEXT, env TEXT NOT NULL,
        db_type TEXT NOT NULL, select_sql TEXT, write_sql TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING', requested_by TEXT NOT NULL,
        requested_by_email TEXT NOT NULL,
        requested_at TEXT NOT NULL DEFAULT (datetime('now')),
        reviewed_by TEXT, reviewed_by_email TEXT, reviewed_at TEXT, review_notes TEXT,
        executed_at TEXT, executed_by TEXT, executed_by_email TEXT,
        rows_affected INTEGER, execution_ms INTEGER, execution_error TEXT,
        transactional INTEGER, ai_verdict TEXT, ai_review_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE phi_field_rules (
        id TEXT PRIMARY KEY, pattern TEXT NOT NULL,
        masking_type TEXT NOT NULL CHECK(masking_type IN ('FULL','PARTIAL','HASH','REDACT')),
        always_masked INTEGER NOT NULL DEFAULT 0, database_name TEXT, table_name TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')));
      INSERT INTO db_connections (id, name, env, type) VALUES
        ('orders-dev', 'Orders', 'DEV', 'postgres'),
        ('orders-prod', 'Orders', 'PROD', 'postgres');
    `);
    const wr = old.prepare(
      "INSERT INTO write_requests (id, title, connection_id, env, db_type, write_sql, status, requested_by, requested_by_email) VALUES (?, 't', ?, ?, 'postgres', 'DELETE FROM orders WHERE id = 1', ?, 'u', 'u@example.com')",
    );
    wr.run("bound-pending", "orders-dev", "DEV", "PENDING");
    wr.run("bound-draft", "orders-dev", "DEV", "DRAFT");
    wr.run("moved-env", "orders-dev", "QA", "PENDING");
    wr.run("gone-conn", "customers-dev", "DEV", "PENDING");
    wr.run("executed", "orders-dev", "DEV", "EXECUTED");
    // Every default pattern already present (e.g. an earlier release seeded them).
    const rule = old.prepare(
      "INSERT INTO phi_field_rules (id, pattern, masking_type, always_masked) VALUES (?, ?, ?, ?)",
    );
    DEFAULT_PHI_RULES.forEach((r, i) =>
      rule.run(`r${i}`, r.pattern, r.maskingType, r.alwaysMasked ? 1 : 0),
    );
    old.close();

    // An archive from before `source` existed.
    const oldArchive = new Database(path.join(oldDir, "audit_archive.sqlite"));
    oldArchive.exec(`CREATE TABLE audit_log (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, user_email TEXT NOT NULL,
      action TEXT NOT NULL, sql TEXT, connection_id TEXT, rows_returned INTEGER,
      execution_ms INTEGER, phi_accessed INTEGER NOT NULL DEFAULT 0,
      phi_fields_unmasked TEXT, phi_unmask_reason TEXT, phi_unmask_notes TEXT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')))`);
    oldArchive.close();

    vi.stubEnv("DATA_DIR", oldDir);
    vi.stubEnv("DBFORGE_CONNECTIONS", "[]");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(console.log).mockClear();
    store.initDatabase();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("DBFORGE_CONNECTIONS is no longer read"),
    );
    vi.stubEnv("DBFORGE_CONNECTIONS", "");

    const db = store.getDb();
    const cols = (t: string) =>
      (db.pragma(`table_info(${t})`) as { name: string }[]).map((c) => c.name);
    expect(cols("artifacts")).toContain("archived_at");
    expect(cols("audit_log")).toEqual(
      expect.arrayContaining([
        "phi_unmask_reason",
        "phi_unmask_notes",
        "source",
      ]),
    );
    expect(cols("write_requests")).toEqual(
      expect.arrayContaining([
        "is_migration",
        "kind",
        "target_json",
        "snapshot",
        "no_transaction",
        "target_fingerprint",
      ]),
    );
    const instances = db
      .prepare("SELECT instance_id FROM db_connections")
      .all() as { instance_id: string | null }[];
    expect(instances.every((r) => /^[0-9a-f]{32}$/.test(r.instance_id!))).toBe(
      true,
    );

    const dev = store.listDbConnections()!.find((c) => c.id === "orders-dev")!;
    const target = store.connectionTarget(dev);
    expect(store.getWriteRequestTarget("bound-pending")).toBe(target);
    expect(store.getWriteRequestTarget("bound-draft")).toBe(target);
    expect(store.getWriteRequestTarget("moved-env")).toBeNull();
    expect(store.getWriteRequestTarget("gone-conn")).toBeNull();
    expect(store.getWriteRequestTarget("executed")).toBeNull();
    expect(store.getWriteRequest("bound-pending")).toMatchObject({
      isMigration: false,
      noTransaction: false,
    });

    // Production masking seeded from the connections' envs.
    expect(store.getSetting("phi_masked_envs")).toBe('["PROD"]');
    // All defaults already existed: none inserted, all marked offered.
    expect(store.getPhiRules()).toHaveLength(DEFAULT_PHI_RULES.length);
    expect(console.log).not.toHaveBeenCalledWith(
      expect.stringContaining("Seeded"),
    );
    expect(JSON.parse(store.getSetting("phi_seeded_patterns")!)).toHaveLength(
      DEFAULT_PHI_RULES.length,
    );

    // The old archive gains `source` and accepts copied rows.
    store.logAudit({
      userId: "o1",
      userEmail: "o1@example.com",
      action: "LOGIN",
      phiAccessed: false,
    });
    db.prepare("UPDATE audit_log SET timestamp = '2020-01-01 00:00:00'").run();
    expect(store.archiveOldAuditEntries()).toEqual({ archived: 1 });
    expect(store.queryArchive()).toMatchObject([
      { userId: "o1", action: "LOGIN", source: undefined },
    ]);

    // Second start on the upgraded file is a no-op for the migrations.
    store.initDatabase();
    expect(store.getWriteRequestTarget("bound-pending")).toBe(target);
    vi.stubEnv("DATA_DIR", dir);
  });

  it("defaults DATA_DIR to ./data under the working directory", () => {
    const cwd = path.join(oldDir, "cwd");
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    vi.stubEnv("DATA_DIR", "");
    try {
      store.initDatabase();
      const dataDir = path.join(cwd, "data");
      expect(existsSync(path.join(dataDir, "dbpilot.sqlite"))).toBe(true);
      expect(store.queryArchive()).toEqual([]);
      store.logAudit({
        userId: "d1",
        userEmail: "d1@example.com",
        action: "LOGIN",
        phiAccessed: false,
      });
      store
        .getDb()
        .prepare("UPDATE audit_log SET timestamp = '2020-01-01 00:00:00'")
        .run();
      expect(store.archiveOldAuditEntries()).toEqual({ archived: 1 });
      expect(existsSync(path.join(dataDir, "audit_archive.sqlite"))).toBe(true);
      expect(store.queryArchive().map((e) => e.userId)).toEqual(["d1"]);
    } finally {
      vi.mocked(process.cwd).mockRestore();
      vi.stubEnv("DATA_DIR", dir);
    }
  });

  it("creates a missing data directory", () => {
    const nested = path.join(oldDir, "nested", "data");
    vi.stubEnv("DATA_DIR", nested);
    store.initDatabase();
    expect(existsSync(path.join(nested, "dbpilot.sqlite"))).toBe(true);
    vi.stubEnv("DATA_DIR", dir);
  });
});
