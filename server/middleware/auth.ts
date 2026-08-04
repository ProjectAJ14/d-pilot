import { Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { AuthUser, ConnectionConfig } from "../types/index.js";
import { getDb, archiveIfDue } from "../services/sqlite-store.js";
import { getConnection } from "../config/connections.js";

// Extend Express Request to include user
declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

const JWT_SECRET =
  process.env.JWT_SECRET || "dbpilot-dev-secret-change-in-production";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "24h";

const ALL_ENVS = ["DEV", "QA", "UAT", "STG", "PROD"];

function parseEnvList(
  raw: string | null | undefined,
  fallback: string[],
): string[] {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Derives the full permission profile for a DB user row. Authority is a set of
 * capabilities: one global (Administrator ⇒ everything) plus four
 * environment-scoped lists (read, unmask-PHI, write, approve). Capabilities are
 * additive — a user can hold any combination.
 */
function deriveUserProfile(user: any) {
  const isAdmin = user.is_admin === 1 || user.is_admin === true;
  const scoped = (raw: string, fallback: string[] = []) =>
    isAdmin ? ALL_ENVS : parseEnvList(raw, fallback);
  const allowedEnvironments = scoped(user.allowed_environments, ALL_ENVS);
  const unmaskEnvironments = scoped(user.unmask_environments);
  const writeEnvironments = scoped(user.write_environments);
  const approveEnvironments = scoped(user.approve_environments);
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    name: user.display_name,
    isAdmin,
    allowedEnvironments,
    unmaskEnvironments,
    writeEnvironments,
    approveEnvironments,
    canUnmaskPhi: isAdmin || unmaskEnvironments.length > 0,
    canWrite: isAdmin || writeEnvironments.length > 0,
    canApprove: isAdmin || approveEnvironments.length > 0,
  };
}

// --- User Management (SQLite) ---

const USERS_SCHEMA = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    email TEXT,
    display_name TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_login TEXT,
    is_admin INTEGER NOT NULL DEFAULT 0,
    allowed_environments TEXT NOT NULL DEFAULT '["DEV","QA","UAT","STG","PROD"]',
    unmask_environments TEXT NOT NULL DEFAULT '[]',
    write_environments TEXT NOT NULL DEFAULT '[]',
    approve_environments TEXT NOT NULL DEFAULT '[]'
  );
`;

export function initAuthTables(): void {
  const db = getDb();
  const colNames = () =>
    (db.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map(
      (c) => c.name,
    );

  const tableExists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='users'",
    )
    .get();

  if (!tableExists) {
    db.exec(USERS_SCHEMA);
  } else {
    // Ensure every env/capability column exists before any backfill.
    const ensure = (name: string, ddl: string) => {
      if (!colNames().includes(name)) {
        db.exec(`ALTER TABLE users ADD COLUMN ${ddl}`);
        console.log(`Added ${name} column to users table`);
      }
    };
    ensure(
      "allowed_environments",
      `allowed_environments TEXT NOT NULL DEFAULT '["DEV","QA","UAT","STG","PROD"]'`,
    );
    ensure(
      "write_environments",
      `write_environments TEXT NOT NULL DEFAULT '[]'`,
    );
    ensure(
      "approve_environments",
      `approve_environments TEXT NOT NULL DEFAULT '[]'`,
    );
    ensure(
      "unmask_environments",
      `unmask_environments TEXT NOT NULL DEFAULT '[]'`,
    );
    ensure("is_admin", `is_admin INTEGER NOT NULL DEFAULT 0`);

    // One-time conversion from the legacy single-`role` model to capabilities,
    // then drop the `role` column entirely.
    if (colNames().includes("role")) {
      db.prepare("UPDATE users SET is_admin = 1 WHERE role = 'admin'").run();
      // A PHI viewer could de-tokenize on any environment it can read.
      db.prepare(
        "UPDATE users SET unmask_environments = allowed_environments WHERE role = 'phi_viewer'",
      ).run();

      db.exec(`
        ${USERS_SCHEMA.replace("CREATE TABLE users", "CREATE TABLE users_caps")}
        INSERT INTO users_caps (id, username, password_hash, email, display_name, created_at, last_login, is_admin, allowed_environments, unmask_environments, write_environments, approve_environments)
          SELECT id, username, password_hash, email, display_name, created_at, last_login, is_admin, allowed_environments, unmask_environments, write_environments, approve_environments FROM users;
        DROP TABLE users;
        ALTER TABLE users_caps RENAME TO users;
      `);
      console.log("Migrated users table from role model to capabilities");
    }
  }

  // Seed default admin user if no users exist
  const count = db.prepare("SELECT COUNT(*) as cnt FROM users").get() as {
    cnt: number;
  };
  if (count.cnt === 0) {
    const domain = process.env.EMAIL_DOMAIN || "example.com";
    const adminEmail = `admin@${domain}`;
    const adminPassword = process.env.DEFAULT_ADMIN_PASSWORD || "changeme123";
    const adminHash = bcrypt.hashSync(adminPassword, 10);
    const allEnvs = JSON.stringify(ALL_ENVS);

    db.prepare(
      `INSERT INTO users (id, username, password_hash, email, display_name, is_admin, allowed_environments, unmask_environments, write_environments, approve_environments)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    ).run(
      "usr-admin-001",
      adminEmail,
      adminHash,
      adminEmail,
      "Admin User",
      allEnvs,
      allEnvs,
      allEnvs,
      allEnvs,
    );

    console.log(`Seeded default admin user: ${adminEmail}`);
  }
}

// --- Login endpoint handler ---

export function handleLogin(req: Request, res: Response): void {
  const { username, password } = req.body;

  if (!username || !password) {
    res.status(400).json({ error: "Username and password are required" });
    return;
  }

  const db = getDb();
  const user = db
    .prepare("SELECT * FROM users WHERE username = ?")
    .get(username) as any;

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  // Update last_login
  db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(
    user.id,
  );

  // Archive old audit entries if 30+ days since last run
  archiveIfDue();

  const profile = deriveUserProfile(user);

  // Issue JWT
  const payload = {
    sub: profile.id,
    username: profile.username,
    email: profile.email,
    name: profile.name,
    isAdmin: profile.isAdmin,
    allowedEnvironments: profile.allowedEnvironments,
    unmaskEnvironments: profile.unmaskEnvironments,
    writeEnvironments: profile.writeEnvironments,
    approveEnvironments: profile.approveEnvironments,
  };

  const token = jwt.sign(payload, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
  } as jwt.SignOptions);

  res.json({ token, user: profile });
}

// --- Get current user ---

export function handleMe(req: Request, res: Response): void {
  const db = getDb();
  const user = db
    .prepare("SELECT * FROM users WHERE id = ?")
    .get(req.user!.sub) as any;
  if (!user) {
    res.json(req.user);
    return;
  }
  res.json(deriveUserProfile(user));
}

// --- Change password ---

export function handleChangePassword(req: Request, res: Response): void {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    res.status(400).json({ error: "Current and new password are required" });
    return;
  }

  if (newPassword.length < 8) {
    res
      .status(400)
      .json({ error: "New password must be at least 8 characters" });
    return;
  }

  const db = getDb();
  const user = db
    .prepare("SELECT * FROM users WHERE id = ?")
    .get(req.user!.sub) as any;

  if (!user || !bcrypt.compareSync(currentPassword, user.password_hash)) {
    res.status(401).json({ error: "Current password is incorrect" });
    return;
  }

  const newHash = bcrypt.hashSync(newPassword, 10);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(
    newHash,
    user.id,
  );

  res.json({ success: true, message: "Password updated successfully" });
}

// --- Update profile ---

export function handleUpdateProfile(req: Request, res: Response): void {
  const { displayName } = req.body;

  if (!displayName || !displayName.trim()) {
    res.status(400).json({ error: "Display name is required" });
    return;
  }

  const db = getDb();
  db.prepare("UPDATE users SET display_name = ? WHERE id = ?").run(
    displayName.trim(),
    req.user!.sub,
  );

  const updated = db
    .prepare("SELECT * FROM users WHERE id = ?")
    .get(req.user!.sub) as any;

  res.json(deriveUserProfile(updated));
}

// --- JWT validation middleware ---

export function authMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      res
        .status(401)
        .json({ error: "Missing or invalid Authorization header" });
      return;
    }

    const token = authHeader.slice(7);

    try {
      const payload = jwt.verify(token, JWT_SECRET) as any;

      // Backward-compatibility for tokens issued before the capability model:
      // derive admin/unmask from the legacy `role` claim when the new claims
      // are absent, so existing sessions keep working until they expire.
      const isAdmin =
        payload.isAdmin !== undefined
          ? !!payload.isAdmin
          : payload.role === "admin";
      const scoped = (list: string[] | undefined) =>
        isAdmin ? ALL_ENVS : list || [];
      const legacyUnmask =
        payload.role === "phi_viewer" ? payload.allowedEnvironments || [] : [];
      const unmaskEnvironments = scoped(
        payload.unmaskEnvironments ?? legacyUnmask,
      );
      const writeEnvironments = scoped(payload.writeEnvironments);
      const approveEnvironments = scoped(payload.approveEnvironments);

      req.user = {
        sub: payload.sub,
        email: payload.email || payload.username,
        name: payload.name,
        isAdmin,
        allowedEnvironments: isAdmin
          ? ALL_ENVS
          : payload.allowedEnvironments || ALL_ENVS,
        unmaskEnvironments,
        writeEnvironments,
        approveEnvironments,
        canUnmaskPhi: isAdmin || unmaskEnvironments.length > 0,
        canWrite: isAdmin || writeEnvironments.length > 0,
        canApprove: isAdmin || approveEnvironments.length > 0,
      };

      next();
    } catch (err: any) {
      if (err.name === "TokenExpiredError") {
        res.status(401).json({ error: "Token expired" });
      } else {
        res.status(401).json({ error: "Invalid token" });
      }
    }
  };
}

/**
 * Resolves a connection *and* enforces the caller's read capability for its
 * environment, writing the 400/404/403 response itself and returning null when
 * the request must not proceed.
 *
 * Every route that reaches a target database through a caller-supplied
 * connectionId must go through this — read access is environment-scoped, and a
 * bare `getConnection()` silently grants access to environments the user cannot
 * read. Routes with a *stronger* requirement (write, approve, unmask) do their
 * own check on top.
 */
export function resolveReadableConnection(
  req: Request,
  res: Response,
  connectionId?: string,
): ConnectionConfig | null {
  if (!connectionId) {
    res.status(400).json({ error: "connectionId is required" });
    return null;
  }

  const conn = getConnection(connectionId);
  if (!conn) {
    res.status(404).json({ error: `Connection '${connectionId}' not found` });
    return null;
  }

  const user = req.user!;
  if (!user.isAdmin && !(user.allowedEnvironments || []).includes(conn.env)) {
    res
      .status(403)
      .json({ error: `You do not have access to ${conn.env} environment` });
    return null;
  }

  return conn;
}

/**
 * Requires admin role for the route.
 */
export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!req.user?.isAdmin) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  next();
}
