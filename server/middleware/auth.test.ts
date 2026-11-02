import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import express from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import type { AddressInfo } from "net";
import type { Server } from "http";

/**
 * Login, the JWT middleware and the users-table migration, against a real
 * (temp) SQLite store. Connections define the environments, so three are
 * registered: DEV, QA and PROD.
 */

const dir = mkdtempSync(path.join(tmpdir(), "d-pilot-auth-"));
vi.stubEnv("DATA_DIR", dir);
vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "auth-test-key");
vi.stubEnv("JWT_SECRET", "");
vi.stubEnv("EMAIL_DOMAIN", "");
vi.stubEnv("DEFAULT_ADMIN_PASSWORD", "");
vi.spyOn(console, "log").mockImplementation(() => {});

const store = await import("../services/sqlite-store.js");
const auth = await import("./auth.js");
const {
  initAuthTables,
  handleLogin,
  handleMe,
  handleChangePassword,
  handleUpdateProfile,
  authMiddleware,
  resolveReadableConnection,
  requireAdmin,
} = auth;

const SECRET = "dbpilot-dev-secret-change-in-production";
const ENVS = ["DEV", "QA", "PROD"];

store.initDatabase();
for (const env of ENVS)
  store.saveDbConnection({
    id: `${env.toLowerCase()}-core`,
    name: `${env} core`,
    env,
    type: "postgres",
    host: "localhost",
    database: "app_core",
  });
initAuthTables();

const db = store.getDb();
const insertUser = (row: Record<string, unknown>) => {
  const cols = Object.keys(row);
  db.prepare(
    `INSERT INTO users (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
  ).run(...Object.values(row));
};

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.post("/login", handleLogin);
  app.get("/bare/admin", requireAdmin, (_req, res) => res.json({ ok: 1 }));
  app.use("/api", authMiddleware());
  app.get("/api/whoami", (req, res) => res.json(req.user));
  app.get("/api/me", handleMe);
  app.post("/api/change-password", handleChangePassword);
  app.put("/api/profile", handleUpdateProfile);
  app.get("/api/admin", requireAdmin, (_req, res) => res.json({ ok: 1 }));
  app.get("/api/conn", (req, res) => {
    const conn = resolveReadableConnection(
      req,
      res,
      req.query.id as string | undefined,
    );
    if (conn) res.json({ id: conn.id });
  });
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

const post = (url: string, body: unknown, token?: string, method = "POST") =>
  fetch(`${base}${url}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
const get = (url: string, token?: string) =>
  fetch(`${base}${url}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
const sign = (payload: object, opts: jwt.SignOptions = {}) =>
  jwt.sign(payload, SECRET, opts);

async function login(username: string, password: string) {
  const res = await post("/login", { username, password });
  return { status: res.status, body: await res.json() };
}

describe("initAuthTables", () => {
  it("seeds admin@example.com with the default password on an empty table", () => {
    const admin = db
      .prepare("SELECT * FROM users WHERE id = 'usr-admin-001'")
      .get() as any;
    expect(admin.username).toBe("admin@example.com");
    expect(admin.is_admin).toBe(1);
    expect(JSON.parse(admin.allowed_environments)).toEqual(ENVS);
    expect(bcrypt.compareSync("changeme123", admin.password_hash)).toBe(true);
  });

  it("leaves an existing, current table alone", () => {
    const before = db.prepare("SELECT COUNT(*) AS n FROM users").get();
    initAuthTables();
    expect(db.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual(before);
  });

  it("migrates a legacy role table to capabilities and drops role", () => {
    const saved = db.prepare("SELECT * FROM users").all();
    db.exec("DROP TABLE users");
    db.exec(`CREATE TABLE users (
      id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      email TEXT, display_name TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_login TEXT, role TEXT NOT NULL DEFAULT 'viewer')`);
    db.prepare(
      "INSERT INTO users (id, username, password_hash, role) VALUES (?,?,?,?)",
    ).run("u-adm", "old-admin@example.com", "x", "admin");
    db.prepare(
      "INSERT INTO users (id, username, password_hash, role) VALUES (?,?,?,?)",
    ).run("u-phi", "old-phi@example.com", "x", "phi_viewer");
    db.prepare(
      "INSERT INTO users (id, username, password_hash, role) VALUES (?,?,?,?)",
    ).run("u-view", "old-view@example.com", "x", "viewer");

    initAuthTables();

    const cols = (
      db.prepare("PRAGMA table_info(users)").all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).not.toContain("role");
    expect(cols).toContain("job_environments");
    const row = (id: string) =>
      db.prepare("SELECT * FROM users WHERE id = ?").get(id) as any;
    expect(row("u-adm").is_admin).toBe(1);
    expect(JSON.parse(row("u-phi").unmask_environments)).toEqual(
      JSON.parse(row("u-phi").allowed_environments),
    );
    expect(row("u-view").is_admin).toBe(0);
    expect(row("u-view").unmask_environments).toBe("[]");
    // Not seeded: the table had users.
    expect(row("usr-admin-001")).toBeUndefined();

    // Restore the seeded users for the rest of the file.
    db.exec("DELETE FROM users");
    for (const u of saved as Record<string, unknown>[]) insertUser(u);
  });

  it("seeds admin@EMAIL_DOMAIN with DEFAULT_ADMIN_PASSWORD when set", () => {
    const saved = db.prepare("SELECT * FROM users").all();
    db.exec("DELETE FROM users");
    vi.stubEnv("EMAIL_DOMAIN", "corp.example");
    vi.stubEnv("DEFAULT_ADMIN_PASSWORD", "seeded-secret");
    initAuthTables();
    const admin = db
      .prepare("SELECT * FROM users WHERE id = 'usr-admin-001'")
      .get() as any;
    expect(admin.username).toBe("admin@corp.example");
    expect(bcrypt.compareSync("seeded-secret", admin.password_hash)).toBe(true);
    vi.stubEnv("EMAIL_DOMAIN", "");
    vi.stubEnv("DEFAULT_ADMIN_PASSWORD", "");
    db.exec("DELETE FROM users");
    for (const u of saved as Record<string, unknown>[]) insertUser(u);
  });
});

describe("handleLogin", () => {
  beforeAll(() => {
    insertUser({
      id: "u-reader",
      username: "reader@example.com",
      password_hash: bcrypt.hashSync("reader-pass", 4),
      email: "reader@example.com",
      display_name: "Reader",
      allowed_environments: '["QA"]',
      unmask_environments: "not json",
      write_environments: '{"QA":true}',
      approve_environments: '["QA"]',
      job_environments: "[]",
    });
    insertUser({
      id: "u-garbled",
      username: "garbled@example.com",
      password_hash: bcrypt.hashSync("garbled-pass", 4),
      allowed_environments: "",
    });
  });

  it("400s without both fields", async () => {
    expect((await login("", "x")).status).toBe(400);
    expect((await login("x", "")).status).toBe(400);
  });

  it("401s an unknown user and a wrong password alike", async () => {
    const unknown = await login("nobody@example.com", "whatever1");
    const wrong = await login("reader@example.com", "wrong-pass");
    expect(unknown).toEqual({
      status: 401,
      body: { error: "Invalid credentials" },
    });
    expect(wrong).toEqual(unknown);
  });

  it("issues a token carrying the capability profile and stamps last_login", async () => {
    const { status, body } = await login("reader@example.com", "reader-pass");
    expect(status).toBe(200);
    expect(body.user).toMatchObject({
      id: "u-reader",
      isAdmin: false,
      allowedEnvironments: ["QA"],
      // Unparseable and non-array lists fall back to empty.
      unmaskEnvironments: [],
      writeEnvironments: [],
      approveEnvironments: ["QA"],
      canUnmaskPhi: false,
      canWrite: false,
      canApprove: true,
    });
    const claims = jwt.verify(body.token, SECRET) as any;
    expect(claims).toMatchObject({ sub: "u-reader", isAdmin: false });
    expect(
      (
        db
          .prepare("SELECT last_login FROM users WHERE id = 'u-reader'")
          .get() as any
      ).last_login,
    ).toBeTruthy();
  });

  it("falls back to every environment for read when the list is empty", async () => {
    const { body } = await login("garbled@example.com", "garbled-pass");
    expect(body.user.allowedEnvironments).toEqual([]);
    db.prepare(
      "UPDATE users SET allowed_environments = 'oops' WHERE id = 'u-garbled'",
    ).run();
    const again = await login("garbled@example.com", "garbled-pass");
    expect(again.body.user.allowedEnvironments).toEqual(ENVS);
  });

  it("gives an admin every env on every list", async () => {
    const { body } = await login("admin@example.com", "changeme123");
    expect(body.user.isAdmin).toBe(true);
    expect(body.user.jobEnvironments).toEqual(ENVS);
    expect(body.user.canWrite).toBe(true);
  });
});

describe("authMiddleware", () => {
  it("401s a missing or non-Bearer header", async () => {
    expect((await get("/api/whoami")).status).toBe(401);
    const basic = await fetch(`${base}/api/whoami`, {
      headers: { authorization: "Basic abc" },
    });
    expect(await basic.json()).toEqual({
      error: "Missing or invalid Authorization header",
    });
  });

  it("tells an expired token from a forged one", async () => {
    const expired = sign({ sub: "u1" }, { expiresIn: -10 });
    expect(await (await get("/api/whoami", expired)).json()).toEqual({
      error: "Token expired",
    });
    const forged = jwt.sign({ sub: "u1" }, "not-the-secret");
    expect(await (await get("/api/whoami", forged)).json()).toEqual({
      error: "Invalid token",
    });
  });

  it("takes capability claims as issued for a non-admin", async () => {
    const token = sign({
      sub: "u2",
      email: "u2@example.com",
      isAdmin: false,
      allowedEnvironments: ["QA"],
      unmaskEnvironments: ["QA"],
      writeEnvironments: ["QA"],
      approveEnvironments: [],
      jobEnvironments: [],
    });
    expect(await (await get("/api/whoami", token)).json()).toMatchObject({
      sub: "u2",
      email: "u2@example.com",
      isAdmin: false,
      allowedEnvironments: ["QA"],
      unmaskEnvironments: ["QA"],
      canUnmaskPhi: true,
      canWrite: true,
      canApprove: false,
    });
  });

  it("defaults absent lists: read to all envs, the rest to none", async () => {
    const token = sign({ sub: "u3", username: "u3@example.com", isAdmin: 0 });
    expect(await (await get("/api/whoami", token)).json()).toMatchObject({
      email: "u3@example.com",
      isAdmin: false,
      allowedEnvironments: ENVS,
      unmaskEnvironments: [],
      writeEnvironments: [],
      jobEnvironments: [],
    });
  });

  it("derives admin from a legacy role claim", async () => {
    const token = sign({ sub: "u4", role: "admin" });
    const user = await (await get("/api/whoami", token)).json();
    expect(user.isAdmin).toBe(true);
    expect(user.approveEnvironments).toEqual(ENVS);
  });

  it("lets a legacy phi_viewer unmask where it could read", async () => {
    const withList = sign({
      sub: "u5",
      role: "phi_viewer",
      allowedEnvironments: ["QA"],
    });
    expect(
      (await (await get("/api/whoami", withList)).json()).unmaskEnvironments,
    ).toEqual(["QA"]);
    const withoutList = sign({ sub: "u5", role: "phi_viewer" });
    expect(
      (await (await get("/api/whoami", withoutList)).json()).unmaskEnvironments,
    ).toEqual([]);
  });

  it("uses JWT_SECRET when the operator sets one", async () => {
    vi.resetModules();
    vi.stubEnv("JWT_SECRET", "operator-secret");
    const fresh = await import("./auth.js");
    vi.stubEnv("JWT_SECRET", "");
    const app = express();
    app.use(fresh.authMiddleware());
    app.get("/", (req, res) => res.json(req.user));
    const s = app.listen(0);
    await new Promise((r) => s.once("listening", r));
    const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}/`;
    const call = (t: string) =>
      fetch(url, { headers: { authorization: `Bearer ${t}` } });
    const ok = await call(jwt.sign({ sub: "u6" }, "operator-secret"));
    const dev = await call(sign({ sub: "u6" }));
    s.close();
    expect(ok.status).toBe(200);
    expect(dev.status).toBe(401);
  });
});

describe("handleMe / handleChangePassword / handleUpdateProfile", () => {
  const readerToken = () =>
    sign({ sub: "u-reader", email: "reader@example.com", isAdmin: false });

  it("returns the fresh profile, or the token's claims for a deleted user", async () => {
    const me = await (await get("/api/me", readerToken())).json();
    expect(me).toMatchObject({ id: "u-reader", name: "Reader" });
    const ghost = await (
      await get("/api/me", sign({ sub: "u-gone", email: "gone@example.com" }))
    ).json();
    expect(ghost).toMatchObject({ sub: "u-gone", email: "gone@example.com" });
  });

  it("validates and changes the password", async () => {
    const t = readerToken();
    expect((await post("/api/change-password", {}, t)).status).toBe(400);
    const short = await post(
      "/api/change-password",
      { currentPassword: "reader-pass", newPassword: "short" },
      t,
    );
    expect(await short.json()).toEqual({
      error: "New password must be at least 8 characters",
    });
    const wrong = await post(
      "/api/change-password",
      { currentPassword: "nope-nope", newPassword: "long-enough-1" },
      t,
    );
    expect(wrong.status).toBe(401);
    const ghost = await post(
      "/api/change-password",
      { currentPassword: "x", newPassword: "long-enough-1" },
      sign({ sub: "u-gone" }),
    );
    expect(ghost.status).toBe(401);
    const ok = await post(
      "/api/change-password",
      { currentPassword: "reader-pass", newPassword: "long-enough-1" },
      t,
    );
    expect(ok.status).toBe(200);
    expect((await login("reader@example.com", "long-enough-1")).status).toBe(
      200,
    );
    expect((await login("reader@example.com", "reader-pass")).status).toBe(401);
  });

  it("requires a non-blank display name and trims it", async () => {
    const t = readerToken();
    expect(
      (await post("/api/profile", { displayName: "  " }, t, "PUT")).status,
    ).toBe(400);
    expect((await post("/api/profile", {}, t, "PUT")).status).toBe(400);
    const res = await post(
      "/api/profile",
      { displayName: "  Renamed  " },
      t,
      "PUT",
    );
    expect((await res.json()).name).toBe("Renamed");
  });
});

describe("resolveReadableConnection and requireAdmin", () => {
  const reader = sign({
    sub: "r",
    isAdmin: false,
    allowedEnvironments: ["QA"],
  });

  it("400s without an id and 404s an unknown one", async () => {
    expect((await get("/api/conn", reader)).status).toBe(400);
    const missing = await get("/api/conn?id=nope", reader);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: "Connection 'nope' not found",
    });
  });

  it("403s an environment the user cannot read, and resolves one it can", async () => {
    const denied = await get("/api/conn?id=prod-core", reader);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({
      error: "You do not have access to PROD environment",
    });
    expect(await (await get("/api/conn?id=qa-core", reader)).json()).toEqual({
      id: "qa-core",
    });
    const admin = sign({ sub: "a", isAdmin: true });
    expect((await get("/api/conn?id=prod-core", admin)).status).toBe(200);
  });

  it("refuses a user whose token carries no read list at all", async () => {
    const res = {
      code: 0,
      body: undefined as unknown,
      status(c: number) {
        this.code = c;
        return this;
      },
      json(b: unknown) {
        this.body = b;
        return this;
      },
    };
    const req = { user: { sub: "n", isAdmin: false } } as any;
    expect(resolveReadableConnection(req, res as any, "qa-core")).toBeNull();
    expect(res.code).toBe(403);
  });

  it("gates admin routes, including when no user was attached", async () => {
    expect((await get("/api/admin", reader)).status).toBe(403);
    expect(
      (await get("/api/admin", sign({ sub: "a", isAdmin: true }))).status,
    ).toBe(200);
    const bare = await get("/bare/admin");
    expect(bare.status).toBe(403);
    expect(await bare.json()).toEqual({ error: "Admin access required" });
  });
});
