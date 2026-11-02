import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import express from "express";
import bcrypt from "bcryptjs";
import type { AddressInfo } from "net";
import type { Server } from "http";

/**
 * The app-store routes — users, saved queries, artifacts, analytics,
 * connections and the audit archive — through their real routers against a
 * real (temp) SQLite store. Only the target-database probe is faked. The
 * caller is whoever the `x-user` header says (no header: no user at all).
 */

const dir = mkdtempSync(path.join(tmpdir(), "d-pilot-crud-routes-"));
vi.stubEnv("DATA_DIR", dir);
vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "crud-routes-key");
vi.stubEnv("EMAIL_DOMAIN", "");
vi.spyOn(console, "log").mockImplementation(() => {});

const testConnection = vi.fn(async () => true);
vi.mock("../services/query-executor.js", async (orig) => ({
  ...(await orig<typeof import("../services/query-executor.js")>()),
  testConnection,
}));

const store = await import("../services/sqlite-store.js");
const { initAuthTables } = await import("../middleware/auth.js");
const routers = {
  users: (await import("./users.js")).default,
  "saved-queries": (await import("./saved-queries.js")).default,
  artifacts: (await import("./artifacts.js")).default,
  analytics: (await import("./analytics.js")).default,
  connections: (await import("./connections.js")).default,
  audit: (await import("./audit.js")).default,
};

store.initDatabase();
for (const [id, env] of [
  ["dev-core", "DEV"],
  ["qa-core", "QA"],
  ["qa-orders", "QA"],
  ["prod-core", "PROD"],
])
  store.saveDbConnection({
    id,
    name: id,
    env,
    type: "postgres",
    host: "db.internal",
    port: 5432,
    database: "app_core",
    username: "reader",
    password: "never-sent",
  });
initAuthTables();

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const raw = req.headers["x-user"];
    if (raw) req.user = JSON.parse(raw as string);
    next();
  });
  for (const [mount, router] of Object.entries(routers))
    app.use(`/${mount}`, router);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const ADMIN = {
  sub: "usr-admin-001",
  email: "admin@example.com",
  isAdmin: true,
};
const ALICE = {
  sub: "u-alice",
  email: "alice@example.com",
  isAdmin: false,
  allowedEnvironments: ["QA"],
  writeEnvironments: ["DEV"],
};
const BOB = { sub: "u-bob", email: "bob@example.com", isAdmin: false };

async function call(
  method: string,
  url: string,
  user: object | null,
  body?: unknown,
) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(user ? { "x-user": JSON.stringify(user) } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, body: json };
}

describe("/users", () => {
  it("is admin-only", async () => {
    expect((await call("GET", "/users", ALICE)).status).toBe(403);
    expect((await call("GET", "/users", null)).status).toBe(403);
  });

  it("validates a new user", async () => {
    const make = (b: object) => call("POST", "/users", ADMIN, b);
    expect((await make({ email: "x@example.com" })).body).toEqual({
      error: "Email and password are required",
    });
    expect(
      (await make({ email: "no-at", password: "long-enough" })).body,
    ).toEqual({ error: "A valid email address is required" });
    expect(
      (await make({ email: "a@example.com", password: "short" })).body,
    ).toEqual({ error: "Password must be at least 8 characters" });
    const dup = await make({
      email: "admin@example.com",
      password: "long-enough",
    });
    expect(dup.status).toBe(409);
  });

  it("enforces EMAIL_DOMAIN when one is configured", async () => {
    vi.stubEnv("EMAIL_DOMAIN", "corp.example");
    const res = await call("POST", "/users", ADMIN, {
      email: "x@other.example",
      password: "long-enough",
    });
    expect(res.body).toEqual({
      error: "Email must be a @corp.example address",
    });
    const ok = await call("POST", "/users", ADMIN, {
      email: "dana@corp.example",
      password: "long-enough",
    });
    expect(ok.status).toBe(201);
    vi.stubEnv("EMAIL_DOMAIN", "");
  });

  it("creates a scoped user, dropping unknown envs and duplicates", async () => {
    const res = await call("POST", "/users", ADMIN, {
      email: "carol@example.com",
      password: "long-enough",
      allowedEnvironments: ["QA", "QA", "NOPE", 7],
      unmaskEnvironments: ["QA"],
      writeEnvironments: "QA",
      approveEnvironments: [],
      jobEnvironments: ["DEV"],
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      username: "carol@example.com",
      displayName: "carol",
      isAdmin: false,
      allowedEnvironments: ["QA"],
      unmaskEnvironments: ["QA"],
      writeEnvironments: [],
      approveEnvironments: [],
      jobEnvironments: ["DEV"],
    });
    const row = store
      .getDb()
      .prepare("SELECT * FROM users WHERE username = ?")
      .get("carol@example.com") as any;
    expect(bcrypt.compareSync("long-enough", row.password_hash)).toBe(true);
  });

  it("creates an admin with every env on every list", async () => {
    const res = await call("POST", "/users", ADMIN, {
      email: "root@example.com",
      displayName: "Root",
      password: "long-enough",
      isAdmin: true,
    });
    expect(res.body).toMatchObject({
      displayName: "Root",
      isAdmin: true,
      jobEnvironments: ["DEV", "QA", "PROD"],
    });
  });

  it("lists users, reading unparseable env lists as empty", async () => {
    store
      .getDb()
      .prepare(
        "UPDATE users SET unmask_environments = 'oops', write_environments = '{}', approve_environments = '' WHERE username = 'carol@example.com'",
      )
      .run();
    const list = await call("GET", "/users", ADMIN);
    const carol = list.body.find(
      (u: any) => u.username === "carol@example.com",
    );
    expect(carol).toMatchObject({
      unmaskEnvironments: [],
      writeEnvironments: [],
      approveEnvironments: [],
    });
    expect(list.body.some((u: any) => u.isAdmin)).toBe(true);
  });

  it("updates each field, keeping envs the user already holds", async () => {
    const id = (
      store
        .getDb()
        .prepare("SELECT id FROM users WHERE username = 'carol@example.com'")
        .get() as any
    ).id;
    // A retired env the user still has survives an edit; a new unknown doesn't.
    store
      .getDb()
      .prepare(
        `UPDATE users SET allowed_environments = '["QA","LEGACY"]' WHERE id = ?`,
      )
      .run(id);
    expect(
      (await call("PUT", "/users/nope", ADMIN, { isAdmin: true })).status,
    ).toBe(404);
    expect((await call("PUT", `/users/${id}`, ADMIN, {})).body).toEqual({
      error: "No fields to update",
    });
    const res = await call("PUT", `/users/${id}`, ADMIN, {
      displayName: "Carol C",
      isAdmin: false,
      allowedEnvironments: ["LEGACY", "OTHER", "DEV"],
      unmaskEnvironments: [],
      writeEnvironments: ["QA"],
      approveEnvironments: ["QA"],
      jobEnvironments: ["QA"],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      displayName: "Carol C",
      allowedEnvironments: ["LEGACY", "DEV"],
      writeEnvironments: ["QA"],
      approveEnvironments: ["QA"],
      jobEnvironments: ["QA"],
    });
    const promoted = await call("PUT", `/users/${id}`, ADMIN, {
      isAdmin: true,
    });
    expect(promoted.body.isAdmin).toBe(true);
  });

  it("resets a password", async () => {
    const id = (
      store
        .getDb()
        .prepare("SELECT id FROM users WHERE username = 'carol@example.com'")
        .get() as any
    ).id;
    expect(
      (await call("POST", `/users/${id}/reset-password`, ADMIN, {})).status,
    ).toBe(400);
    expect(
      (
        await call("POST", `/users/${id}/reset-password`, ADMIN, {
          newPassword: "short",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("POST", "/users/nope/reset-password", ADMIN, {
          newPassword: "brand-new-pass",
        })
      ).status,
    ).toBe(404);
    const ok = await call("POST", `/users/${id}/reset-password`, ADMIN, {
      newPassword: "brand-new-pass",
    });
    expect(ok.body).toEqual({
      success: true,
      message: "Password reset successfully",
    });
    const row = store
      .getDb()
      .prepare("SELECT password_hash FROM users WHERE id = ?")
      .get(id) as any;
    expect(bcrypt.compareSync("brand-new-pass", row.password_hash)).toBe(true);
  });

  it("deletes a user, but never yourself", async () => {
    const self = await call("DELETE", `/users/${ADMIN.sub}`, ADMIN);
    expect(self.body).toEqual({ error: "You cannot delete your own account" });
    expect((await call("DELETE", "/users/nope", ADMIN)).status).toBe(404);
    const id = (
      store
        .getDb()
        .prepare("SELECT id FROM users WHERE username = 'root@example.com'")
        .get() as any
    ).id;
    expect((await call("DELETE", `/users/${id}`, ADMIN)).body).toEqual({
      deleted: true,
    });
    expect(
      store.getDb().prepare("SELECT id FROM users WHERE id = ?").get(id),
    ).toBeUndefined();
  });
});

describe("/saved-queries", () => {
  let sharedId: string;
  let privateId: string;

  it("requires a name and sql", async () => {
    expect(
      (await call("POST", "/saved-queries", ALICE, { name: "x" })).status,
    ).toBe(400);
    expect(
      (await call("POST", "/saved-queries", ALICE, { sql: "select 1" })).status,
    ).toBe(400);
  });

  it("is shared by default, with no tags", async () => {
    const res = await call("POST", "/saved-queries", ALICE, {
      name: "Open orders",
      sql: "select * from orders",
      connectionId: "qa-core",
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: "Open orders",
      isShared: true,
      tags: [],
      createdBy: "u-alice",
      createdByEmail: "alice@example.com",
    });
    sharedId = res.body.id;
    const priv = await call("POST", "/saved-queries", ALICE, {
      name: "Mine",
      sql: "select 1",
      isShared: false,
      tags: ["draft"],
    });
    expect(priv.body).toMatchObject({ isShared: false, tags: ["draft"] });
    privateId = priv.body.id;
  });

  it("shows shared queries to others, private ones only to the author", async () => {
    expect((await call("GET", `/saved-queries/${sharedId}`, BOB)).status).toBe(
      200,
    );
    const hidden = await call("GET", `/saved-queries/${privateId}`, BOB);
    expect(hidden.status).toBe(404);
    expect(
      (await call("GET", `/saved-queries/${privateId}`, ALICE)).body.name,
    ).toBe("Mine");
    const bobList = await call("GET", "/saved-queries", BOB);
    expect(bobList.body.map((q: any) => q.id)).toEqual([sharedId]);
  });

  it("lets only the author edit or delete", async () => {
    expect(
      (await call("PUT", `/saved-queries/${sharedId}`, BOB, { name: "Bob's" }))
        .status,
    ).toBe(404);
    const edit = await call("PUT", `/saved-queries/${sharedId}`, ALICE, {
      name: "Open orders v2",
    });
    expect(edit.body.name).toBe("Open orders v2");
    expect(
      (await call("DELETE", `/saved-queries/${sharedId}`, BOB)).status,
    ).toBe(404);
    expect(
      (await call("DELETE", `/saved-queries/${sharedId}`, ALICE)).body,
    ).toEqual({ deleted: true });
    expect(
      (await call("GET", `/saved-queries/${sharedId}`, ALICE)).status,
    ).toBe(404);
  });
});

describe("/artifacts", () => {
  let id: string;
  const blocks = [
    { type: "text", body: "Orders stuck in PENDING." },
    { type: "sql", sql: "select * from orders", connectionId: "qa-core" },
  ];

  it("requires a title and valid blocks", async () => {
    expect((await call("POST", "/artifacts", ALICE, { blocks })).body).toEqual({
      error: "title is required",
    });
    const bad = await call("POST", "/artifacts", ALICE, {
      title: "T",
      blocks: [{ type: "sql", sql: " " }],
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/^blocks\[0\]\.sql:/);
  });

  it("is shared by default", async () => {
    const res = await call("POST", "/artifacts", ALICE, {
      title: "Stuck orders",
      blocks,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ isShared: true, tags: [] });
    id = res.body.id;
    const priv = await call("POST", "/artifacts", ALICE, {
      title: "Private",
      blocks,
      isShared: false,
      tags: ["wip"],
    });
    expect(priv.body).toMatchObject({ isShared: false, tags: ["wip"] });
    expect((await call("GET", `/artifacts/${priv.body.id}`, BOB)).status).toBe(
      404,
    );
  });

  it("opens by link for anyone, and lists", async () => {
    expect((await call("GET", `/artifacts/${id}`, BOB)).body.title).toBe(
      "Stuck orders",
    );
    expect(
      (await call("GET", "/artifacts", BOB)).body.map((a: any) => a.id),
    ).toContain(id);
  });

  it("edits a title without resending blocks, and validates new blocks", async () => {
    const title = await call("PUT", `/artifacts/${id}`, ALICE, {
      title: "Stuck orders (QA)",
    });
    expect(title.body.title).toBe("Stuck orders (QA)");
    expect(title.body.blocks).toHaveLength(2);
    const bad = await call("PUT", `/artifacts/${id}`, ALICE, {
      blocks: [{ type: "video" }],
    });
    expect(bad.status).toBe(400);
    const replaced = await call("PUT", `/artifacts/${id}`, ALICE, {
      blocks: [{ type: "html", body: "<h2>Why</h2>" }],
    });
    expect(replaced.body.blocks).toEqual([
      { type: "html", body: "<h2>Why</h2>" },
    ]);
  });

  it("only lets the author edit or archive", async () => {
    expect(
      (await call("PUT", `/artifacts/${id}`, BOB, { title: "Hijack" })).status,
    ).toBe(404);
    expect(
      (await call("PUT", `/artifacts/${id}`, BOB, { archived: true })).status,
    ).toBe(404);
  });

  it("archives on its own, or together with an edit", async () => {
    const archived = await call("PUT", `/artifacts/${id}`, ALICE, {
      archived: true,
    });
    expect(archived.body.archivedAt).toBeTruthy();
    // Hidden from listings, but the link still opens.
    expect(
      (await call("GET", "/artifacts", ALICE)).body.map((a: any) => a.id),
    ).not.toContain(id);
    expect((await call("GET", `/artifacts/${id}`, BOB)).status).toBe(200);
    const both = await call("PUT", `/artifacts/${id}`, ALICE, {
      archived: 0,
      title: "Restored",
    });
    expect(both.body.title).toBe("Restored");
    expect(both.body.archivedAt).toBeUndefined();
    const withBlocks = await call("PUT", `/artifacts/${id}`, ALICE, {
      archived: false,
      blocks,
    });
    expect(withBlocks.body.blocks).toHaveLength(2);
  });

  it("has no delete", async () => {
    const res = await call("DELETE", `/artifacts/${id}`, ALICE);
    expect(res.status).toBe(405);
    expect(res.body.error).toMatch(/Archive it instead/);
    expect((await call("GET", `/artifacts/${id}`, ALICE)).status).toBe(200);
  });
});

describe("/analytics", () => {
  it("is admin-only and merges write analytics in", async () => {
    expect((await call("GET", "/analytics", ALICE)).status).toBe(403);
    const res = await call("GET", "/analytics", ADMIN);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("writes");
    expect(res.body.writes).toEqual(store.getWriteAnalytics());
  });
});

describe("/connections", () => {
  it("lists only readable environments, and never credentials", async () => {
    const res = await call("GET", "/connections", ALICE);
    expect(res.body.map((c: any) => c.id).sort()).toEqual([
      "qa-core",
      "qa-orders",
    ]);
    expect(JSON.stringify(res.body)).not.toContain("never-sent");
    expect(res.body[0]).not.toHaveProperty("username");
    expect((await call("GET", "/connections", ADMIN)).body).toHaveLength(4);
    expect((await call("GET", "/connections", null)).body).toEqual([]);
    expect((await call("GET", "/connections", BOB)).body).toEqual([]);
  });

  it("lists writable connections by write capability", async () => {
    expect(
      (await call("GET", "/connections/writable", ALICE)).body.map(
        (c: any) => c.id,
      ),
    ).toEqual(["dev-core"]);
    expect(
      (await call("GET", "/connections/writable", ADMIN)).body,
    ).toHaveLength(4);
    expect((await call("GET", "/connections/writable", null)).body).toEqual([]);
  });

  it("groups by environment, filtered to readable ones", async () => {
    const alice = await call("GET", "/connections/grouped", ALICE);
    expect(Object.keys(alice.body)).toEqual(["QA"]);
    expect(alice.body.QA).toHaveLength(2);
    expect(JSON.stringify(alice.body)).not.toContain("never-sent");
    expect(
      Object.keys((await call("GET", "/connections/grouped", ADMIN)).body),
    ).toEqual(["DEV", "PROD", "QA"]);
    expect((await call("GET", "/connections/grouped", null)).body).toEqual({});
  });

  it("tests a readable connection and refuses others", async () => {
    testConnection.mockResolvedValueOnce(false);
    expect(
      (await call("GET", "/connections/qa-core/test", ALICE)).body,
    ).toEqual({ connectionId: "qa-core", connected: false });
    expect(testConnection).toHaveBeenCalledWith(
      expect.objectContaining({ id: "qa-core" }),
    );
    expect(
      (await call("GET", "/connections/prod-core/test", ALICE)).status,
    ).toBe(403);
    expect(
      (await call("GET", "/connections/prod-core/test", ADMIN)).body,
    ).toEqual({ connectionId: "prod-core", connected: true });
  });

  it("reports pool status and disconnects, admin-only", async () => {
    expect((await call("GET", "/connections/status", ALICE)).status).toBe(403);
    const status = await call("GET", "/connections/status", ADMIN);
    expect(status.body).toHaveLength(4);
    expect(status.body[0]).toMatchObject({
      id: "dev-core",
      env: "DEV",
      type: "postgres",
      database: "app_core",
      live: false,
    });
    expect(
      (await call("POST", "/connections/qa-core/disconnect", ALICE)).status,
    ).toBe(403);
    expect(
      (await call("POST", "/connections/nope/disconnect", ADMIN)).status,
    ).toBe(404);
    expect(
      (await call("POST", "/connections/qa-core/disconnect", ADMIN)).body,
    ).toEqual({ connectionId: "qa-core", closed: false });
  });
});

describe("/audit archive", () => {
  it("is admin-only", async () => {
    expect((await call("GET", "/audit/archive", ALICE)).status).toBe(403);
    expect((await call("POST", "/audit/archive", ALICE)).status).toBe(403);
  });

  it("says when there is nothing to archive", async () => {
    expect((await call("POST", "/audit/archive", ADMIN)).body).toEqual({
      archived: 0,
      message: "No entries to archive",
    });
  });

  it("moves entries older than 30 days and pages through the archive", async () => {
    store
      .getDb()
      .prepare(
        "INSERT INTO audit_log (id, user_id, user_email, action, sql, timestamp) VALUES (?, ?, ?, ?, ?, datetime('now', '-40 days'))",
      )
      .run(
        "old-1",
        "u-alice",
        "alice@example.com",
        "QUERY_EXECUTE",
        "select 1",
      );
    const res = await call("POST", "/audit/archive", ADMIN);
    expect(res.body).toEqual({
      archived: 1,
      message: "Archived 1 entries older than 30 days",
    });
    const page = await call(
      "GET",
      "/audit/archive?userId=u-alice&limit=5",
      ADMIN,
    );
    expect(page.body.map((e: any) => e.id)).toEqual(["old-1"]);
  });
});
