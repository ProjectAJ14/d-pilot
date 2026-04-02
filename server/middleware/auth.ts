import { Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { AuthUser } from "../types/index.js";
import { getDb } from "../services/sqlite-store.js";

// Extend Express Request to include user
declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

const JWT_SECRET = process.env.JWT_SECRET || "dbpilot-dev-secret-change-in-production";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "24h";

// --- User Management (SQLite) ---

export function initAuthTables(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      email TEXT,
      display_name TEXT,
      role TEXT NOT NULL DEFAULT 'read' CHECK(role IN ('admin', 'read')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_login TEXT
    );
  `);

  // Migrate legacy 'viewer' role to 'read'
  db.prepare("UPDATE users SET role = 'read' WHERE role = 'viewer'").run();

  // Seed default admin user if no users exist
  const count = db.prepare("SELECT COUNT(*) as cnt FROM users").get() as { cnt: number };
  if (count.cnt === 0) {
    const domain = process.env.EMAIL_DOMAIN || "example.com";
    const adminEmail = `admin@${domain}`;
    const adminPassword = process.env.DEFAULT_ADMIN_PASSWORD || "changeme123";
    const adminHash = bcrypt.hashSync(adminPassword, 10);

    db.prepare(
      "INSERT INTO users (id, username, password_hash, email, display_name, role) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("usr-admin-001", adminEmail, adminHash, adminEmail, "Admin User", "admin");

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
  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username) as any;

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  // Update last_login
  db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(user.id);

  // Issue JWT
  const payload = {
    sub: user.id,
    username: user.username,
    email: user.email,
    name: user.display_name,
    role: user.role,
  };

  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN } as jwt.SignOptions);

  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      name: user.display_name,
      role: user.role,
      isAdmin: user.role === "admin",
    },
  });
}

// --- Get current user ---

export function handleMe(req: Request, res: Response): void {
  res.json(req.user);
}

// --- Change password ---

export function handleChangePassword(req: Request, res: Response): void {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    res.status(400).json({ error: "Current and new password are required" });
    return;
  }

  if (newPassword.length < 8) {
    res.status(400).json({ error: "New password must be at least 8 characters" });
    return;
  }

  const db = getDb();
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user!.sub) as any;

  if (!user || !bcrypt.compareSync(currentPassword, user.password_hash)) {
    res.status(401).json({ error: "Current password is incorrect" });
    return;
  }

  const newHash = bcrypt.hashSync(newPassword, 10);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(newHash, user.id);

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
  db.prepare("UPDATE users SET display_name = ? WHERE id = ?").run(displayName.trim(), req.user!.sub);

  const updated = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user!.sub) as any;

  res.json({
    id: updated.id,
    username: updated.username,
    email: updated.email,
    displayName: updated.display_name,
    role: updated.role,
    isAdmin: updated.role === "admin",
  });
}

// --- JWT validation middleware ---

export function authMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Missing or invalid Authorization header" });
      return;
    }

    const token = authHeader.slice(7);

    try {
      const payload = jwt.verify(token, JWT_SECRET) as any;

      req.user = {
        sub: payload.sub,
        email: payload.email || payload.username,
        name: payload.name,
        roles: [payload.role],
        isAdmin: payload.role === "admin",
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
 * Requires admin role for the route.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user?.isAdmin) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  next();
}
