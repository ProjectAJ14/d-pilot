import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";
import { DEFAULT_PHI_RULES } from "../config/phi-defaults.js";
import type {
  SavedQuery,
  PhiFieldRule,
  AuditEntry,
  Environment,
} from "../types/index.js";

let db: Database.Database;

export function initDatabase(): void {
  const dataDir = path.resolve(process.cwd(), "data");
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  db = new Database(path.join(dataDir, "dbpilot.sqlite"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS saved_queries (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sql TEXT NOT NULL,
      description TEXT,
      connection_id TEXT,
      created_by TEXT NOT NULL,
      created_by_email TEXT NOT NULL,
      is_shared INTEGER NOT NULL DEFAULT 0,
      tags TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS phi_field_rules (
      id TEXT PRIMARY KEY,
      pattern TEXT NOT NULL,
      masking_type TEXT NOT NULL CHECK(masking_type IN ('FULL','PARTIAL','HASH','REDACT')),
      always_masked INTEGER NOT NULL DEFAULT 0,
      database_name TEXT,
      table_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      user_email TEXT NOT NULL,
      action TEXT NOT NULL,
      sql TEXT,
      connection_id TEXT,
      rows_returned INTEGER,
      execution_ms INTEGER,
      phi_accessed INTEGER NOT NULL DEFAULT 0,
      phi_fields_unmasked TEXT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
    CREATE INDEX IF NOT EXISTS idx_saved_queries_shared ON saved_queries(is_shared);
  `);

  // Migrate audit_log: add reason/notes columns if missing
  const auditCols = db.pragma("table_info(audit_log)") as { name: string }[];
  const auditColNames = new Set(auditCols.map((c) => c.name));
  if (!auditColNames.has("phi_unmask_reason")) {
    db.exec("ALTER TABLE audit_log ADD COLUMN phi_unmask_reason TEXT");
  }
  if (!auditColNames.has("phi_unmask_notes")) {
    db.exec("ALTER TABLE audit_log ADD COLUMN phi_unmask_notes TEXT");
  }

  // Seed default masked environments setting
  const existing = db.prepare("SELECT key FROM app_settings WHERE key = 'phi_masked_envs'").get();
  if (!existing) {
    db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?)").run("phi_masked_envs", '["PROD"]');
  }

  seedPhiRules();
}

function seedPhiRules(): void {
  const existing = db.prepare("SELECT pattern FROM phi_field_rules").all() as { pattern: string }[];
  const existingPatterns = new Set(existing.map((r) => r.pattern));

  const missing = DEFAULT_PHI_RULES.filter((r) => !existingPatterns.has(r.pattern));
  if (missing.length === 0) return;

  const insert = db.prepare(
    "INSERT INTO phi_field_rules (id, pattern, masking_type, always_masked) VALUES (?, ?, ?, ?)"
  );

  const insertMany = db.transaction(() => {
    for (const rule of missing) {
      insert.run(randomUUID(), rule.pattern, rule.maskingType, rule.alwaysMasked ? 1 : 0);
    }
  });

  insertMany();
  console.log(`Seeded ${missing.length} PHI masking rules`);
}

// --- Saved Queries ---

export function getSavedQueries(userId: string): SavedQuery[] {
  const rows = db
    .prepare("SELECT * FROM saved_queries WHERE is_shared = 1 OR created_by = ? ORDER BY updated_at DESC")
    .all(userId) as any[];
  return rows.map(mapSavedQuery);
}

export function createSavedQuery(
  query: Omit<SavedQuery, "id" | "createdAt" | "updatedAt">
): SavedQuery {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO saved_queries (id, name, sql, description, connection_id, created_by, created_by_email, is_shared, tags, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    query.name,
    query.sql,
    query.description ?? null,
    query.connectionId ?? null,
    query.createdBy,
    query.createdByEmail,
    query.isShared ? 1 : 0,
    JSON.stringify(query.tags),
    now,
    now
  );
  return { ...query, id, createdAt: now, updatedAt: now };
}

export function updateSavedQuery(
  id: string,
  userId: string,
  updates: Partial<Pick<SavedQuery, "name" | "sql" | "description" | "connectionId" | "isShared" | "tags">>
): SavedQuery | null {
  const existing = db.prepare("SELECT * FROM saved_queries WHERE id = ? AND created_by = ?").get(id, userId) as any;
  if (!existing) return null;

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE saved_queries SET
      name = COALESCE(?, name),
      sql = COALESCE(?, sql),
      description = COALESCE(?, description),
      connection_id = COALESCE(?, connection_id),
      is_shared = COALESCE(?, is_shared),
      tags = COALESCE(?, tags),
      updated_at = ?
     WHERE id = ?`
  ).run(
    updates.name ?? null,
    updates.sql ?? null,
    updates.description ?? null,
    updates.connectionId ?? null,
    updates.isShared !== undefined ? (updates.isShared ? 1 : 0) : null,
    updates.tags ? JSON.stringify(updates.tags) : null,
    now,
    id
  );

  return mapSavedQuery(db.prepare("SELECT * FROM saved_queries WHERE id = ?").get(id) as any);
}

export function deleteSavedQuery(id: string, userId: string): boolean {
  const result = db.prepare("DELETE FROM saved_queries WHERE id = ? AND created_by = ?").run(id, userId);
  return result.changes > 0;
}

function mapSavedQuery(row: any): SavedQuery {
  return {
    id: row.id,
    name: row.name,
    sql: row.sql,
    description: row.description,
    connectionId: row.connection_id,
    createdBy: row.created_by,
    createdByEmail: row.created_by_email,
    isShared: row.is_shared === 1,
    tags: JSON.parse(row.tags || "[]"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// --- PHI Field Rules ---

export function getPhiRules(): PhiFieldRule[] {
  const rows = db.prepare("SELECT * FROM phi_field_rules ORDER BY always_masked DESC, pattern").all() as any[];
  return rows.map((r) => ({
    id: r.id,
    pattern: r.pattern,
    maskingType: r.masking_type,
    alwaysMasked: r.always_masked === 1,
    database: r.database_name,
    table: r.table_name,
  }));
}

export function upsertPhiRule(rule: Omit<PhiFieldRule, "id"> & { id?: string }): PhiFieldRule {
  const id = rule.id || randomUUID();
  db.prepare(
    `INSERT INTO phi_field_rules (id, pattern, masking_type, always_masked, database_name, table_name)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       pattern = excluded.pattern,
       masking_type = excluded.masking_type,
       always_masked = excluded.always_masked,
       database_name = excluded.database_name,
       table_name = excluded.table_name`
  ).run(id, rule.pattern, rule.maskingType, rule.alwaysMasked ? 1 : 0, rule.database ?? null, rule.table ?? null);

  return { ...rule, id };
}

export function deletePhiRule(id: string): boolean {
  const result = db.prepare("DELETE FROM phi_field_rules WHERE id = ?").run(id);
  return result.changes > 0;
}

// --- App Settings ---

export function getSetting(key: string): string | null {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value);
}

export function getPhiMaskedEnvs(): Environment[] {
  const val = getSetting("phi_masked_envs");
  if (!val) return ["PROD"];
  try {
    return JSON.parse(val);
  } catch {
    return ["PROD"];
  }
}

// --- Audit Log ---

export function logAudit(entry: Omit<AuditEntry, "id" | "timestamp">): void {
  db.prepare(
    `INSERT INTO audit_log (id, user_id, user_email, action, sql, connection_id, rows_returned, execution_ms, phi_accessed, phi_fields_unmasked, phi_unmask_reason, phi_unmask_notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    randomUUID(),
    entry.userId,
    entry.userEmail,
    entry.action,
    entry.sql ?? null,
    entry.connectionId ?? null,
    entry.rowsReturned ?? null,
    entry.executionMs ?? null,
    entry.phiAccessed ? 1 : 0,
    entry.phiFieldsUnmasked ? JSON.stringify(entry.phiFieldsUnmasked) : null,
    entry.phiUnmaskReason ?? null,
    entry.phiUnmaskNotes ?? null
  );
}

export function getAuditLog(limit = 100, offset = 0): AuditEntry[] {
  const rows = db
    .prepare("SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ? OFFSET ?")
    .all(limit, offset) as any[];
  return rows.map(mapAuditRow);
}

// --- Query History ---

export function getQueryHistory(userId: string, limit = 50): AuditEntry[] {
  const rows = db
    .prepare(
      `SELECT * FROM audit_log
       WHERE user_id = ? AND action = 'QUERY_EXECUTE' AND sql IS NOT NULL
       ORDER BY timestamp DESC LIMIT ?`
    )
    .all(userId, limit) as any[];
  return rows.map(mapAuditRow);
}

function mapAuditRow(r: any): AuditEntry {
  return {
    id: r.id,
    userId: r.user_id,
    userEmail: r.user_email,
    action: r.action,
    sql: r.sql,
    connectionId: r.connection_id,
    rowsReturned: r.rows_returned,
    executionMs: r.execution_ms,
    phiAccessed: r.phi_accessed === 1,
    phiFieldsUnmasked: r.phi_fields_unmasked ? JSON.parse(r.phi_fields_unmasked) : [],
    phiUnmaskReason: r.phi_unmask_reason ?? undefined,
    phiUnmaskNotes: r.phi_unmask_notes ?? undefined,
    timestamp: r.timestamp,
  };
}

export function getDb(): Database.Database {
  return db;
}
