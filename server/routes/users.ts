import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { requireAdmin } from "../middleware/auth.js";
import { getDb } from "../services/sqlite-store.js";

const router = Router();

// All routes require admin
router.use(requireAdmin);

// List all users
router.get("/", (_req: Request, res: Response) => {
  const db = getDb();
  const users = db.prepare(
    "SELECT id, username, email, display_name, role, created_at, last_login FROM users ORDER BY created_at DESC"
  ).all() as any[];

  res.json(
    users.map((u) => ({
      id: u.id,
      username: u.username,
      email: u.email,
      displayName: u.display_name,
      role: u.role,
      createdAt: u.created_at,
      lastLogin: u.last_login,
    }))
  );
});

// Create user
router.post("/", (req: Request, res: Response) => {
  const { email, displayName, role, password } = req.body;

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

  const validRoles = ["admin", "phi_viewer", "read"];
  const userRole = validRoles.includes(role) ? role : "read";

  const db = getDb();

  // Check if username already exists
  const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(email);
  if (existing) {
    res.status(409).json({ error: "A user with this email already exists" });
    return;
  }

  const id = `usr-${randomUUID().slice(0, 8)}`;
  const passwordHash = bcrypt.hashSync(password, 10);

  db.prepare(
    "INSERT INTO users (id, username, password_hash, email, display_name, role) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, email, passwordHash, email, displayName || email.split("@")[0], userRole);

  const created = db.prepare(
    "SELECT id, username, email, display_name, role, created_at, last_login FROM users WHERE id = ?"
  ).get(id) as any;

  res.status(201).json({
    id: created.id,
    username: created.username,
    email: created.email,
    displayName: created.display_name,
    role: created.role,
    createdAt: created.created_at,
    lastLogin: created.last_login,
  });
});

// Update user
router.put("/:id", (req: Request, res: Response) => {
  const { id } = req.params;
  const { displayName, role } = req.body;

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

  if (role !== undefined) {
    if (!["admin", "phi_viewer", "read"].includes(role)) {
      res.status(400).json({ error: "Role must be 'admin', 'phi_viewer', or 'read'" });
      return;
    }
    updates.push("role = ?");
    values.push(role);
  }

  if (updates.length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }

  values.push(id);
  db.prepare(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`).run(...values);

  const updated = db.prepare(
    "SELECT id, username, email, display_name, role, created_at, last_login FROM users WHERE id = ?"
  ).get(id) as any;

  res.json({
    id: updated.id,
    username: updated.username,
    email: updated.email,
    displayName: updated.display_name,
    role: updated.role,
    createdAt: updated.created_at,
    lastLogin: updated.last_login,
  });
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
    res.status(400).json({ error: "New password must be at least 8 characters" });
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
