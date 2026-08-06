import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { requireAdmin } from "../middleware/auth.js";
import { getDb } from "../services/sqlite-store.js";
import { getEnvironments } from "../config/connections.js";

const router = Router();

// All routes require admin
router.use(requireAdmin);

// List all users
router.get("/", (_req: Request, res: Response) => {
  const db = getDb();
  const users = db
    .prepare("SELECT * FROM users ORDER BY created_at DESC")
    .all() as any[];

  res.json(users.map(mapUserRow));
});

function parseEnvs(raw: string | null | undefined): string[] {
  try {
    const p = JSON.parse(raw || "[]");
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
}

function sanitizeEnvs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const allowed = getEnvironments();
  return value.filter((e) => typeof e === "string" && allowed.includes(e));
}

function mapUserRow(u: any) {
  const isAdmin = u.is_admin === 1 || u.is_admin === true;
  const scoped = (raw: string) => (isAdmin ? getEnvironments() : parseEnvs(raw));
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    displayName: u.display_name,
    isAdmin,
    allowedEnvironments: scoped(u.allowed_environments),
    unmaskEnvironments: scoped(u.unmask_environments),
    writeEnvironments: scoped(u.write_environments),
    approveEnvironments: scoped(u.approve_environments),
    createdAt: u.created_at,
    lastLogin: u.last_login,
  };
}

// Create user
router.post("/", (req: Request, res: Response) => {
  const {
    email,
    displayName,
    password,
    isAdmin,
    allowedEnvironments,
    unmaskEnvironments,
    writeEnvironments,
    approveEnvironments,
  } = req.body;

  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }

  const domain = process.env.EMAIL_DOMAIN;
  if (domain) {
    if (!email.endsWith(`@${domain}`)) {
      res.status(400).json({ error: `Email must be a @${domain} address` });
      return;
    }
  } else if (!email.includes("@")) {
    res.status(400).json({ error: "A valid email address is required" });
    return;
  }

  if (password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }

  const db = getDb();

  // Check if username already exists
  const existing = db
    .prepare("SELECT id FROM users WHERE username = ?")
    .get(email);
  if (existing) {
    res.status(409).json({ error: "A user with this email already exists" });
    return;
  }

  const admin = !!isAdmin;
  const id = `usr-${randomUUID().slice(0, 8)}`;
  const passwordHash = bcrypt.hashSync(password, 10);
  // Admin implies all capabilities; otherwise use the supplied per-env lists.
  const read = admin ? getEnvironments() : sanitizeEnvs(allowedEnvironments);
  const unmask = admin ? getEnvironments() : sanitizeEnvs(unmaskEnvironments);
  const write = admin ? getEnvironments() : sanitizeEnvs(writeEnvironments);
  const approve = admin ? getEnvironments() : sanitizeEnvs(approveEnvironments);

  db.prepare(
    "INSERT INTO users (id, username, password_hash, email, display_name, is_admin, allowed_environments, unmask_environments, write_environments, approve_environments) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    email,
    passwordHash,
    email,
    displayName || email.split("@")[0],
    admin ? 1 : 0,
    JSON.stringify(read),
    JSON.stringify(unmask),
    JSON.stringify(write),
    JSON.stringify(approve),
  );

  const created = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as any;
  res.status(201).json(mapUserRow(created));
});

// Update user
router.put("/:id", (req: Request, res: Response) => {
  const { id } = req.params;
  const {
    displayName,
    isAdmin,
    allowedEnvironments,
    unmaskEnvironments,
    writeEnvironments,
    approveEnvironments,
  } = req.body;

  const db = getDb();
  const existing = db.prepare("SELECT id FROM users WHERE id = ?").get(id);
  if (!existing) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const updates: string[] = [];
  const values: any[] = [];

  if (displayName !== undefined) {
    updates.push("display_name = ?");
    values.push(displayName);
  }
  if (isAdmin !== undefined) {
    updates.push("is_admin = ?");
    values.push(isAdmin ? 1 : 0);
  }
  if (allowedEnvironments !== undefined) {
    updates.push("allowed_environments = ?");
    values.push(JSON.stringify(sanitizeEnvs(allowedEnvironments)));
  }
  if (unmaskEnvironments !== undefined) {
    updates.push("unmask_environments = ?");
    values.push(JSON.stringify(sanitizeEnvs(unmaskEnvironments)));
  }
  if (writeEnvironments !== undefined) {
    updates.push("write_environments = ?");
    values.push(JSON.stringify(sanitizeEnvs(writeEnvironments)));
  }
  if (approveEnvironments !== undefined) {
    updates.push("approve_environments = ?");
    values.push(JSON.stringify(sanitizeEnvs(approveEnvironments)));
  }

  if (updates.length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }

  values.push(id);
  db.prepare(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`).run(
    ...values,
  );

  const updated = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as any;
  res.json(mapUserRow(updated));
});

// Delete user
router.delete("/:id", (req: Request, res: Response) => {
  const { id } = req.params;

  // Cannot delete yourself
  if (req.user!.sub === id) {
    res.status(400).json({ error: "You cannot delete your own account" });
    return;
  }

  const db = getDb();
  const result = db.prepare("DELETE FROM users WHERE id = ?").run(id);

  if (result.changes === 0) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json({ deleted: true });
});

// Reset password (admin resets another user's password)
router.post("/:id/reset-password", (req: Request, res: Response) => {
  const { id } = req.params;
  const { newPassword } = req.body;

  if (!newPassword || newPassword.length < 8) {
    res
      .status(400)
      .json({ error: "New password must be at least 8 characters" });
    return;
  }

  const db = getDb();
  const existing = db.prepare("SELECT id FROM users WHERE id = ?").get(id);
  if (!existing) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, id);

  res.json({ success: true, message: "Password reset successfully" });
});

export default router;
