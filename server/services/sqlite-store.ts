import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";
import { DEFAULT_PHI_RULES } from "../config/phi-defaults.js";
import type {
  SavedQuery,
  PhiFieldRule,
  AuditEntry,
  AiChatLogEntry,
  Environment,
  WriteRequest,
  WriteRequestEvent,
  WriteRequestEventType,
  WriteRequestStatus,
  WriteAiReview,
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

    CREATE TABLE IF NOT EXISTS ai_chat_log (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      user_email TEXT NOT NULL,
      connection_id TEXT,
      db_type TEXT,
      prompt TEXT NOT NULL,
      system_prompt TEXT,
      user_message TEXT,
      response_raw TEXT,
      generated_query TEXT,
      explanation TEXT,
      model TEXT,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      total_tokens INTEGER,
      latency_ms INTEGER,
      status TEXT NOT NULL,
      error_message TEXT,
      schema_truncated INTEGER,
      tables_provided INTEGER,
      total_tables INTEGER,
      timestamp TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS write_requests (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      connection_id TEXT NOT NULL,
      connection_name TEXT,
      env TEXT NOT NULL,
      db_type TEXT NOT NULL,
      select_sql TEXT,
      write_sql TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      requested_by TEXT NOT NULL,
      requested_by_email TEXT NOT NULL,
      requested_at TEXT NOT NULL DEFAULT (datetime('now')),
      reviewed_by TEXT,
      reviewed_by_email TEXT,
      reviewed_at TEXT,
      review_notes TEXT,
      executed_at TEXT,
      executed_by TEXT,
      executed_by_email TEXT,
      rows_affected INTEGER,
      execution_ms INTEGER,
      execution_error TEXT,
      transactional INTEGER,
      ai_verdict TEXT,
      ai_review_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS write_request_events (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      actor_email TEXT NOT NULL,
      event TEXT NOT NULL,
      notes TEXT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_write_requests_status ON write_requests(status);
    CREATE INDEX IF NOT EXISTS idx_write_requests_requested_by ON write_requests(requested_by);
    CREATE INDEX IF NOT EXISTS idx_write_requests_env ON write_requests(env);
    CREATE INDEX IF NOT EXISTS idx_write_request_events_req ON write_request_events(request_id);

    CREATE INDEX IF NOT EXISTS idx_ai_chat_timestamp ON ai_chat_log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_ai_chat_user ON ai_chat_log(user_id);

    CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_user_action ON audit_log(user_id, action);
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
  const existing = db
    .prepare("SELECT key FROM app_settings WHERE key = 'phi_masked_envs'")
    .get();
  if (!existing) {
    db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?)").run(
      "phi_masked_envs",
      '["PROD"]',
    );
  }

  // Seed write-mode settings: feature toggle + environments where an authorized
  // writer may execute directly (all other envs require a second-person approval).
  if (
    !db
      .prepare("SELECT key FROM app_settings WHERE key = 'write_mode_enabled'")
      .get()
  ) {
    db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?)").run(
      "write_mode_enabled",
      "true",
    );
  }
  if (
    !db
      .prepare("SELECT key FROM app_settings WHERE key = 'write_direct_envs'")
      .get()
  ) {
    db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?)").run(
      "write_direct_envs",
      '["DEV"]',
    );
  }

  seedPhiRules();
}

function seedPhiRules(): void {
  // Each default pattern is offered exactly once per install (tracked in
  // phi_seeded_patterns): defaults added in a future release still reach
  // existing installs, but rules an admin deleted or bulk-replaced (CSV
  // import) are never resurrected on restart.
  const offered = new Set<string>(
    JSON.parse(getSetting("phi_seeded_patterns") ?? "[]"),
  );
  const toOffer = DEFAULT_PHI_RULES.filter((r) => !offered.has(r.pattern));
  if (toOffer.length === 0) return;

  const existing = new Set(
    (
      db.prepare("SELECT pattern FROM phi_field_rules").all() as {
        pattern: string;
      }[]
    ).map((r) => r.pattern),
  );
  const toInsert = toOffer.filter((r) => !existing.has(r.pattern));

  if (toInsert.length > 0) {
    const insert = db.prepare(
      "INSERT INTO phi_field_rules (id, pattern, masking_type, always_masked) VALUES (?, ?, ?, ?)",
    );
    const insertMany = db.transaction(() => {
      for (const rule of toInsert) {
        insert.run(
          randomUUID(),
          rule.pattern,
          rule.maskingType,
          rule.alwaysMasked ? 1 : 0,
        );
      }
    });
    insertMany();
    console.log(`Seeded ${toInsert.length} PHI masking rules`);
  }

  for (const rule of toOffer) offered.add(rule.pattern);
  setSetting("phi_seeded_patterns", JSON.stringify([...offered]));
}

// --- Saved Queries ---

export function getSavedQueries(userId: string): SavedQuery[] {
  const rows = db
    .prepare(
      "SELECT * FROM saved_queries WHERE is_shared = 1 OR created_by = ? ORDER BY updated_at DESC",
    )
    .all(userId) as any[];
  return rows.map(mapSavedQuery);
}

export function getSavedQueryById(
  id: string,
  userId: string,
): SavedQuery | null {
  const row = db
    .prepare(
      "SELECT * FROM saved_queries WHERE id = ? AND (is_shared = 1 OR created_by = ?)",
    )
    .get(id, userId);
  return row ? mapSavedQuery(row as any) : null;
}

export function createSavedQuery(
  query: Omit<SavedQuery, "id" | "createdAt" | "updatedAt">,
): SavedQuery {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO saved_queries (id, name, sql, description, connection_id, created_by, created_by_email, is_shared, tags, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    now,
  );
  return { ...query, id, createdAt: now, updatedAt: now };
}

export function updateSavedQuery(
  id: string,
  userId: string,
  updates: Partial<
    Pick<
      SavedQuery,
      "name" | "sql" | "description" | "connectionId" | "isShared" | "tags"
    >
  >,
): SavedQuery | null {
  const existing = db
    .prepare("SELECT * FROM saved_queries WHERE id = ? AND created_by = ?")
    .get(id, userId) as any;
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
     WHERE id = ?`,
  ).run(
    updates.name ?? null,
    updates.sql ?? null,
    updates.description ?? null,
    updates.connectionId ?? null,
    updates.isShared !== undefined ? (updates.isShared ? 1 : 0) : null,
    updates.tags ? JSON.stringify(updates.tags) : null,
    now,
    id,
  );

  return mapSavedQuery(
    db.prepare("SELECT * FROM saved_queries WHERE id = ?").get(id) as any,
  );
}

export function deleteSavedQuery(id: string, userId: string): boolean {
  const result = db
    .prepare("DELETE FROM saved_queries WHERE id = ? AND created_by = ?")
    .run(id, userId);
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
  const rows = db
    .prepare(
      "SELECT * FROM phi_field_rules ORDER BY always_masked DESC, pattern",
    )
    .all() as any[];
  return rows.map((r) => ({
    id: r.id,
    pattern: r.pattern,
    maskingType: r.masking_type,
    alwaysMasked: r.always_masked === 1,
    database: r.database_name,
    table: r.table_name,
  }));
}

export function upsertPhiRule(
  rule: Omit<PhiFieldRule, "id"> & { id?: string },
): PhiFieldRule {
  const id = rule.id || randomUUID();
  db.prepare(
    `INSERT INTO phi_field_rules (id, pattern, masking_type, always_masked, database_name, table_name)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       pattern = excluded.pattern,
       masking_type = excluded.masking_type,
       always_masked = excluded.always_masked,
       database_name = excluded.database_name,
       table_name = excluded.table_name`,
  ).run(
    id,
    rule.pattern,
    rule.maskingType,
    rule.alwaysMasked ? 1 : 0,
    rule.database ?? null,
    rule.table ?? null,
  );

  return { ...rule, id };
}

export function deletePhiRule(id: string): boolean {
  const result = db.prepare("DELETE FROM phi_field_rules WHERE id = ?").run(id);
  return result.changes > 0;
}

export function applyPhiRuleImport(
  inserts: Omit<PhiFieldRule, "id">[],
  updates: PhiFieldRule[],
): void {
  const insertStmt = db.prepare(
    `INSERT INTO phi_field_rules (id, pattern, masking_type, always_masked, database_name, table_name)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const updateStmt = db.prepare(
    `UPDATE phi_field_rules
     SET pattern = ?, masking_type = ?, always_masked = ?, database_name = ?, table_name = ?
     WHERE id = ?`,
  );
  db.transaction(() => {
    for (const r of inserts) {
      insertStmt.run(
        randomUUID(),
        r.pattern,
        r.maskingType,
        r.alwaysMasked ? 1 : 0,
        r.database ?? null,
        r.table ?? null,
      );
    }
    for (const r of updates) {
      updateStmt.run(
        r.pattern,
        r.maskingType,
        r.alwaysMasked ? 1 : 0,
        r.database ?? null,
        r.table ?? null,
        r.id,
      );
    }
  })();
}

export function deleteAllPhiRules(includeLocked: boolean): {
  deleted: number;
  kept: number;
} {
  if (includeLocked) {
    const result = db.prepare("DELETE FROM phi_field_rules").run();
    return { deleted: result.changes, kept: 0 };
  }
  const result = db
    .prepare("DELETE FROM phi_field_rules WHERE always_masked = 0")
    .run();
  const kept = (
    db.prepare("SELECT COUNT(*) AS c FROM phi_field_rules").get() as {
      c: number;
    }
  ).c;
  return { deleted: result.changes, kept };
}

// --- App Settings ---

export function getSetting(key: string): string | null {
  const row = db
    .prepare("SELECT value FROM app_settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value);
}

export function getPhiMaskedEnvs(): Environment[] {
  const val = getSetting("phi_masked_envs");
  let envs: Environment[];
  if (!val) {
    envs = ["PROD"];
  } else {
    try {
      const parsed = JSON.parse(val);
      envs = Array.isArray(parsed) ? parsed : ["PROD"];
    } catch {
      envs = ["PROD"];
    }
  }
  // Production PHI is always tokenized — guarantee PROD is masked, regardless
  // of what's stored.
  return envs.includes("PROD") ? envs : ["PROD", ...envs];
}

export function getWriteModeEnabled(): boolean {
  return getSetting("write_mode_enabled") !== "false";
}

export function getWriteDirectEnvs(): Environment[] {
  const val = getSetting("write_direct_envs");
  let envs: Environment[];
  if (!val) {
    envs = ["DEV"];
  } else {
    try {
      const parsed = JSON.parse(val);
      envs = Array.isArray(parsed) ? parsed : ["DEV"];
    } catch {
      envs = ["DEV"];
    }
  }
  // Production is never a direct-write environment — it always requires the
  // two-person rule. Strip it defensively, regardless of what's stored.
  return envs.filter((e) => e !== "PROD");
}

// --- Audit Log ---

export function logAudit(entry: Omit<AuditEntry, "id" | "timestamp">): void {
  db.prepare(
    `INSERT INTO audit_log (id, user_id, user_email, action, sql, connection_id, rows_returned, execution_ms, phi_accessed, phi_fields_unmasked, phi_unmask_reason, phi_unmask_notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    entry.phiUnmaskNotes ?? null,
  );
}

export function getAuditLog(
  options: {
    limit?: number;
    offset?: number;
    from?: string;
    to?: string;
    action?: string;
    userId?: string;
  } = {},
): AuditEntry[] {
  const limit = Math.min(options.limit ?? 100, 1000);
  const offset = options.offset ?? 0;

  const conditions: string[] = [];
  const params: any[] = [];

  if (options.from) {
    conditions.push("timestamp >= ?");
    params.push(options.from);
  }
  if (options.to) {
    conditions.push("timestamp <= ?");
    params.push(options.to);
  }
  if (options.action) {
    conditions.push("action = ?");
    params.push(options.action);
  }
  if (options.userId) {
    conditions.push("user_id = ?");
    params.push(options.userId);
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `SELECT * FROM audit_log ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const rows = db.prepare(sql).all(...params) as any[];
  return rows.map(mapAuditRow);
}

// --- Analytics ---

function lastNDates(n: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i),
    );
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function mapByDay(rows: any[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const r of rows) m[r.d] = r.c;
  return m;
}

export function getAnalytics(): any {
  const scalar = (sql: string, ...params: any[]): number => {
    const row = db.prepare(sql).get(...params) as { v: number } | undefined;
    return row?.v ?? 0;
  };

  // ── Users ──
  const totalUsers = scalar("SELECT COUNT(*) v FROM users");
  const activeUsers = scalar(
    "SELECT COUNT(*) v FROM users WHERE last_login >= datetime('now','-30 days')",
  );
  const neverLoggedIn = scalar(
    "SELECT COUNT(*) v FROM users WHERE last_login IS NULL",
  );
  // Capability distribution (a user can appear in more than one bucket).
  const capabilityDistribution = [
    {
      capability: "admin",
      count: scalar("SELECT COUNT(*) v FROM users WHERE is_admin = 1"),
    },
    {
      capability: "unmask_phi",
      count: scalar(
        "SELECT COUNT(*) v FROM users WHERE is_admin = 1 OR (unmask_environments IS NOT NULL AND unmask_environments != '[]')",
      ),
    },
    {
      capability: "write",
      count: scalar(
        "SELECT COUNT(*) v FROM users WHERE is_admin = 1 OR (write_environments IS NOT NULL AND write_environments != '[]')",
      ),
    },
    {
      capability: "approve",
      count: scalar(
        "SELECT COUNT(*) v FROM users WHERE is_admin = 1 OR (approve_environments IS NOT NULL AND approve_environments != '[]')",
      ),
    },
    {
      capability: "read",
      count: scalar(
        "SELECT COUNT(*) v FROM users WHERE is_admin = 1 OR (allowed_environments IS NOT NULL AND allowed_environments != '[]')",
      ),
    },
  ];

  // ── Query activity ──
  const queriesToday = scalar(
    "SELECT COUNT(*) v FROM audit_log WHERE action='QUERY_EXECUTE' AND date(timestamp)=date('now')",
  );
  const queries30d = scalar(
    "SELECT COUNT(*) v FROM audit_log WHERE action='QUERY_EXECUTE' AND timestamp>=datetime('now','-30 days')",
  );
  const queriesTotal = scalar(
    "SELECT COUNT(*) v FROM audit_log WHERE action='QUERY_EXECUTE'",
  );

  // ── Engagement (distinct active users) ──
  const dauToday = scalar(
    "SELECT COUNT(DISTINCT user_id) v FROM audit_log WHERE date(timestamp)=date('now')",
  );
  const wau = scalar(
    "SELECT COUNT(DISTINCT user_id) v FROM audit_log WHERE timestamp>=datetime('now','-7 days')",
  );
  const mau = scalar(
    "SELECT COUNT(DISTINCT user_id) v FROM audit_log WHERE timestamp>=datetime('now','-30 days')",
  );

  // ── Quality / PHI / perf (30d) ──
  const phiUnmask30d = scalar(
    "SELECT COUNT(*) v FROM audit_log WHERE action='PHI_UNMASK' AND timestamp>=datetime('now','-30 days')",
  );
  const phiDenied30d = scalar(
    "SELECT COUNT(*) v FROM audit_log WHERE action='PHI_UNMASK_DENIED' AND timestamp>=datetime('now','-30 days')",
  );
  const errors30d = scalar(
    "SELECT COUNT(*) v FROM audit_log WHERE action='QUERY_ERROR' AND timestamp>=datetime('now','-30 days')",
  );
  const exports30d = scalar(
    "SELECT COUNT(*) v FROM audit_log WHERE action IN ('EXPORT_CSV','EXPORT_JSON') AND timestamp>=datetime('now','-30 days')",
  );
  const avgLatencyMs = Math.round(
    scalar(
      "SELECT COALESCE(AVG(execution_ms),0) v FROM audit_log WHERE action='QUERY_EXECUTE' AND execution_ms IS NOT NULL AND timestamp>=datetime('now','-30 days')",
    ),
  );
  const totalRows30d = scalar(
    "SELECT COALESCE(SUM(rows_returned),0) v FROM audit_log WHERE action='QUERY_EXECUTE' AND timestamp>=datetime('now','-30 days')",
  );

  // ── AI usage (30d) ──
  const aiGenerations30d = scalar(
    "SELECT COUNT(*) v FROM ai_chat_log WHERE timestamp>=datetime('now','-30 days')",
  );
  const aiSuccess30d = scalar(
    "SELECT COUNT(*) v FROM ai_chat_log WHERE status='success' AND timestamp>=datetime('now','-30 days')",
  );
  const aiTokens30d = scalar(
    "SELECT COALESCE(SUM(total_tokens),0) v FROM ai_chat_log WHERE timestamp>=datetime('now','-30 days')",
  );

  const savedQueries = scalar("SELECT COUNT(*) v FROM saved_queries");

  // ── Daily series (last 30 days, zero-filled) ──
  const qByDay = mapByDay(
    db
      .prepare(
        "SELECT date(timestamp) d, COUNT(*) c FROM audit_log WHERE action='QUERY_EXECUTE' AND timestamp>=datetime('now','-29 days') GROUP BY d",
      )
      .all(),
  );
  const auByDay = mapByDay(
    db
      .prepare(
        "SELECT date(timestamp) d, COUNT(DISTINCT user_id) c FROM audit_log WHERE timestamp>=datetime('now','-29 days') GROUP BY d",
      )
      .all(),
  );
  const aiByDay = mapByDay(
    db
      .prepare(
        "SELECT date(timestamp) d, COUNT(*) c FROM ai_chat_log WHERE timestamp>=datetime('now','-29 days') GROUP BY d",
      )
      .all(),
  );
  const daily = lastNDates(30).map((date) => ({
    date,
    queries: qByDay[date] ?? 0,
    activeUsers: auByDay[date] ?? 0,
    aiQueries: aiByDay[date] ?? 0,
  }));

  // ── Breakdowns (30d) ──
  const actionBreakdown = (
    db
      .prepare(
        "SELECT action, COUNT(*) c FROM audit_log WHERE timestamp>=datetime('now','-30 days') GROUP BY action ORDER BY c DESC",
      )
      .all() as any[]
  ).map((a) => ({ action: a.action, count: a.c }));

  const topUsers = (
    db
      .prepare(
        `SELECT user_email email, COUNT(*) queries, MAX(timestamp) lastActive
     FROM audit_log WHERE action='QUERY_EXECUTE' AND timestamp>=datetime('now','-30 days')
     GROUP BY user_id ORDER BY queries DESC LIMIT 8`,
      )
      .all() as any[]
  ).map((u) => ({
    email: u.email,
    queries: u.queries,
    lastActive: u.lastActive,
  }));

  const byConnection = (
    db
      .prepare(
        `SELECT COALESCE(connection_id,'(none)') connectionId, COUNT(*) c
     FROM audit_log WHERE action='QUERY_EXECUTE' AND timestamp>=datetime('now','-30 days')
     GROUP BY connection_id ORDER BY c DESC LIMIT 8`,
      )
      .all() as any[]
  ).map((c) => ({ connectionId: c.connectionId, count: c.c }));

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      totalUsers,
      activeUsers,
      neverLoggedIn,
      queriesToday,
      queries30d,
      queriesTotal,
      dauToday,
      wau,
      mau,
      phiUnmask30d,
      phiDenied30d,
      errors30d,
      exports30d,
      avgLatencyMs,
      totalRows30d,
      aiGenerations30d,
      aiSuccess30d,
      aiTokens30d,
      savedQueries,
    },
    capabilityDistribution,
    daily,
    actionBreakdown,
    topUsers,
    byConnection,
  };
}

// --- Query History ---

export function getQueryHistory(userId: string, limit = 50): AuditEntry[] {
  const rows = db
    .prepare(
      `SELECT * FROM audit_log
       WHERE user_id = ? AND action = 'QUERY_EXECUTE' AND sql IS NOT NULL
       ORDER BY timestamp DESC LIMIT ?`,
    )
    .all(userId, limit) as any[];
  return rows.map(mapAuditRow);
}

export function mapAuditRow(r: any): AuditEntry {
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
    phiFieldsUnmasked: r.phi_fields_unmasked
      ? JSON.parse(r.phi_fields_unmasked)
      : [],
    phiUnmaskReason: r.phi_unmask_reason ?? undefined,
    phiUnmaskNotes: r.phi_unmask_notes ?? undefined,
    timestamp: r.timestamp,
  };
}

// --- AI Chat Log ---

export function logAiChat(
  entry: Omit<AiChatLogEntry, "id" | "timestamp">,
): void {
  db.prepare(
    `INSERT INTO ai_chat_log (
       id, user_id, user_email, connection_id, db_type, prompt, system_prompt,
       user_message, response_raw, generated_query, explanation, model,
       prompt_tokens, completion_tokens, total_tokens, latency_ms, status,
       error_message, schema_truncated, tables_provided, total_tables
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    entry.userId,
    entry.userEmail,
    entry.connectionId ?? null,
    entry.dbType ?? null,
    entry.prompt,
    entry.systemPrompt ?? null,
    entry.userMessage ?? null,
    entry.responseRaw ?? null,
    entry.generatedQuery ?? null,
    entry.explanation ?? null,
    entry.model ?? null,
    entry.promptTokens ?? null,
    entry.completionTokens ?? null,
    entry.totalTokens ?? null,
    entry.latencyMs ?? null,
    entry.status,
    entry.errorMessage ?? null,
    entry.schemaTruncated == null ? null : entry.schemaTruncated ? 1 : 0,
    entry.tablesProvided ?? null,
    entry.totalTables ?? null,
  );
}

export function getAiChatLog(
  options: {
    limit?: number;
    offset?: number;
    from?: string;
    to?: string;
    status?: string;
    userId?: string;
  } = {},
): AiChatLogEntry[] {
  const limit = Math.min(options.limit ?? 100, 1000);
  const offset = options.offset ?? 0;

  const conditions: string[] = [];
  const params: any[] = [];

  if (options.from) {
    conditions.push("timestamp >= ?");
    params.push(options.from);
  }
  if (options.to) {
    conditions.push("timestamp <= ?");
    params.push(options.to);
  }
  if (options.status) {
    conditions.push("status = ?");
    params.push(options.status);
  }
  if (options.userId) {
    conditions.push("user_id = ?");
    params.push(options.userId);
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `SELECT * FROM ai_chat_log ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const rows = db.prepare(sql).all(...params) as any[];
  return rows.map(mapAiChatRow);
}

function mapAiChatRow(r: any): AiChatLogEntry {
  return {
    id: r.id,
    userId: r.user_id,
    userEmail: r.user_email,
    connectionId: r.connection_id ?? undefined,
    dbType: r.db_type ?? undefined,
    prompt: r.prompt,
    systemPrompt: r.system_prompt ?? undefined,
    userMessage: r.user_message ?? undefined,
    responseRaw: r.response_raw ?? undefined,
    generatedQuery: r.generated_query ?? undefined,
    explanation: r.explanation ?? undefined,
    model: r.model ?? undefined,
    promptTokens: r.prompt_tokens ?? undefined,
    completionTokens: r.completion_tokens ?? undefined,
    totalTokens: r.total_tokens ?? undefined,
    latencyMs: r.latency_ms ?? undefined,
    status: r.status,
    errorMessage: r.error_message ?? undefined,
    schemaTruncated:
      r.schema_truncated == null ? undefined : r.schema_truncated === 1,
    tablesProvided: r.tables_provided ?? undefined,
    totalTables: r.total_tables ?? undefined,
    timestamp: r.timestamp,
  };
}

// --- Audit Archival ---

const AUDIT_LOG_SCHEMA = `
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
    phi_unmask_reason TEXT,
    phi_unmask_notes TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_archive_timestamp ON audit_log(timestamp);
  CREATE INDEX IF NOT EXISTS idx_archive_user ON audit_log(user_id);
`;

let archiveLock = false;

export function archiveOldAuditEntries(daysToKeep = 30): { archived: number } {
  if (archiveLock) {
    // Another call is already running — skip silently
    return { archived: 0 };
  }

  archiveLock = true;
  try {
    const dataDir = path.resolve(process.cwd(), "data");
    const archivePath = path.join(dataDir, "audit_archive.sqlite");

    // Ensure archive DB exists with correct schema
    const archiveDb = new Database(archivePath);
    archiveDb.pragma("journal_mode = WAL");
    archiveDb.exec(AUDIT_LOG_SCHEMA);
    archiveDb.close();

    // Use ATTACH to move rows atomically
    const absArchivePath = path.resolve(archivePath);
    db.exec(`ATTACH DATABASE '${absArchivePath}' AS archive`);

    try {
      const cutoff = db
        .prepare(`SELECT datetime('now', ?) as cutoff`)
        .get(`-${daysToKeep} days`) as { cutoff: string };

      const move = db.transaction(() => {
        const insertResult = db
          .prepare(
            `INSERT OR IGNORE INTO archive.audit_log SELECT * FROM main.audit_log WHERE timestamp < ?`,
          )
          .run(cutoff.cutoff);

        db.prepare(`DELETE FROM main.audit_log WHERE timestamp < ?`).run(
          cutoff.cutoff,
        );

        return insertResult.changes;
      });

      const archived = move();

      if (archived > 0) {
        console.log(
          `Archived ${archived} audit entries older than ${daysToKeep} days`,
        );
      }

      setSetting("last_audit_archive", new Date().toISOString());
      return { archived };
    } finally {
      db.exec("DETACH DATABASE archive");
    }
  } finally {
    archiveLock = false;
  }
}

/**
 * Checks if archival is due (30+ days since last run) and triggers it if so.
 * Called on user login — lightweight check, heavy work only when needed.
 * Safe to call concurrently: the lock in archiveOldAuditEntries prevents double execution.
 */
export function archiveIfDue(): void {
  if (archiveLock) return;

  const lastRun = getSetting("last_audit_archive");
  if (!lastRun) {
    archiveOldAuditEntries();
    return;
  }

  const daysSince =
    (Date.now() - new Date(lastRun).getTime()) / (1000 * 60 * 60 * 24);
  if (daysSince >= 30) {
    archiveOldAuditEntries();
  }
}

export function queryArchive(
  options: {
    limit?: number;
    offset?: number;
    from?: string;
    to?: string;
  } = {},
): AuditEntry[] {
  const dataDir = path.resolve(process.cwd(), "data");
  const archivePath = path.join(dataDir, "audit_archive.sqlite");

  if (!fs.existsSync(archivePath)) return [];

  const archiveDb = new Database(archivePath, { readonly: true });

  try {
    const limit = Math.min(options.limit ?? 100, 1000);
    const offset = options.offset ?? 0;

    const conditions: string[] = [];
    const params: any[] = [];

    if (options.from) {
      conditions.push("timestamp >= ?");
      params.push(options.from);
    }
    if (options.to) {
      conditions.push("timestamp <= ?");
      params.push(options.to);
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `SELECT * FROM audit_log ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = archiveDb.prepare(sql).all(...params) as any[];
    return rows.map(mapAuditRow);
  } finally {
    archiveDb.close();
  }
}

// --- Write Requests ---

export interface NewWriteRequest {
  title: string;
  description?: string;
  connectionId: string;
  connectionName?: string;
  env: string;
  dbType: string;
  selectSql?: string;
  writeSql: string;
  status: WriteRequestStatus;
  requestedBy: string;
  requestedByEmail: string;
}

export function createWriteRequest(req: NewWriteRequest): WriteRequest {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO write_requests
      (id, title, description, connection_id, connection_name, env, db_type,
       select_sql, write_sql, status, requested_by, requested_by_email,
       requested_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    req.title,
    req.description ?? null,
    req.connectionId,
    req.connectionName ?? null,
    req.env,
    req.dbType,
    req.selectSql ?? null,
    req.writeSql,
    req.status,
    req.requestedBy,
    req.requestedByEmail,
    now,
    now,
    now,
  );
  return getWriteRequest(id)!;
}

export function getWriteRequest(
  id: string,
  withEvents = true,
): WriteRequest | null {
  const row = db
    .prepare("SELECT * FROM write_requests WHERE id = ?")
    .get(id) as any;
  if (!row) return null;
  const wr = mapWriteRequest(row);
  if (withEvents) wr.events = getWriteRequestEvents(id);
  return wr;
}

export function listWriteRequests(
  options: {
    requestedBy?: string;
    envs?: string[];
    statuses?: WriteRequestStatus[];
    limit?: number;
  } = {},
): WriteRequest[] {
  const conditions: string[] = [];
  const params: any[] = [];

  // Visibility: own requests OR requests in the viewer's approvable environments.
  const orParts: string[] = [];
  if (options.requestedBy) {
    orParts.push("requested_by = ?");
    params.push(options.requestedBy);
  }
  if (options.envs && options.envs.length > 0) {
    orParts.push(`env IN (${options.envs.map(() => "?").join(",")})`);
    params.push(...options.envs);
  }
  if (orParts.length > 0) {
    conditions.push(`(${orParts.join(" OR ")})`);
  }

  if (options.statuses && options.statuses.length > 0) {
    conditions.push(`status IN (${options.statuses.map(() => "?").join(",")})`);
    params.push(...options.statuses);
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(options.limit ?? 200, 1000);
  const rows = db
    .prepare(
      `SELECT * FROM write_requests ${where} ORDER BY requested_at DESC LIMIT ?`,
    )
    .all(...params, limit) as any[];
  return rows.map(mapWriteRequest);
}

export function updateWriteRequest(
  id: string,
  updates: Partial<{
    status: WriteRequestStatus;
    reviewedBy: string;
    reviewedByEmail: string;
    reviewedAt: string;
    reviewNotes: string;
    executedAt: string;
    executedBy: string;
    executedByEmail: string;
    rowsAffected: number;
    executionMs: number;
    executionError: string;
    transactional: boolean;
    aiVerdict: string;
    aiReview: WriteAiReview;
  }>,
): WriteRequest | null {
  const sets: string[] = [];
  const params: any[] = [];
  const map: Record<string, any> = {
    status: updates.status,
    reviewed_by: updates.reviewedBy,
    reviewed_by_email: updates.reviewedByEmail,
    reviewed_at: updates.reviewedAt,
    review_notes: updates.reviewNotes,
    executed_at: updates.executedAt,
    executed_by: updates.executedBy,
    executed_by_email: updates.executedByEmail,
    rows_affected: updates.rowsAffected,
    execution_ms: updates.executionMs,
    execution_error: updates.executionError,
    transactional:
      updates.transactional === undefined
        ? undefined
        : updates.transactional
          ? 1
          : 0,
    ai_verdict: updates.aiVerdict,
    ai_review_json:
      updates.aiReview === undefined
        ? undefined
        : JSON.stringify(updates.aiReview),
  };
  for (const [col, val] of Object.entries(map)) {
    if (val !== undefined) {
      sets.push(`${col} = ?`);
      params.push(val);
    }
  }
  if (sets.length === 0) return getWriteRequest(id);
  sets.push("updated_at = ?");
  params.push(new Date().toISOString());
  params.push(id);
  db.prepare(`UPDATE write_requests SET ${sets.join(", ")} WHERE id = ?`).run(
    ...params,
  );
  return getWriteRequest(id);
}

/**
 * Atomically transitions a request from PENDING to APPROVED, returning true only
 * for the caller that won the claim. Prevents double execution when two approvers
 * act on the same request concurrently.
 */
export function claimWriteRequestForApproval(id: string): boolean {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      "UPDATE write_requests SET status = 'APPROVED', updated_at = ? WHERE id = ? AND status = 'PENDING'",
    )
    .run(now, id);
  return result.changes === 1;
}

/**
 * Applies an edited query to a revisable request and resets it to a fresh
 * PENDING state — clearing the prior review, AI verdict, and execution outcome
 * (the history is preserved in write_request_events). Used to resubmit after a
 * rejection / cancellation / failed run.
 */
export function reviseWriteRequest(
  id: string,
  fields: {
    title: string;
    description?: string;
    selectSql?: string;
    writeSql: string;
  },
): WriteRequest | null {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE write_requests SET
       title = ?, description = ?, select_sql = ?, write_sql = ?,
       status = 'PENDING',
       reviewed_by = NULL, reviewed_by_email = NULL, reviewed_at = NULL, review_notes = NULL,
       executed_at = NULL, executed_by = NULL, executed_by_email = NULL,
       rows_affected = NULL, execution_ms = NULL, execution_error = NULL, transactional = NULL,
       ai_verdict = NULL, ai_review_json = NULL,
       updated_at = ?
     WHERE id = ?`,
  ).run(
    fields.title,
    fields.description ?? null,
    fields.selectSql ?? null,
    fields.writeSql,
    now,
    id,
  );
  return getWriteRequest(id);
}

export function addWriteRequestEvent(
  requestId: string,
  actorId: string,
  actorEmail: string,
  event: WriteRequestEventType,
  notes?: string,
): void {
  db.prepare(
    `INSERT INTO write_request_events (id, request_id, actor_id, actor_email, event, notes)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), requestId, actorId, actorEmail, event, notes ?? null);
}

export function getWriteRequestEvents(requestId: string): WriteRequestEvent[] {
  // Newest first for the detail-page activity timeline. timestamp is only
  // second-precision, so rowid breaks ties by insertion order (also descending).
  const rows = db
    .prepare(
      "SELECT * FROM write_request_events WHERE request_id = ? ORDER BY timestamp DESC, rowid DESC",
    )
    .all(requestId) as any[];
  return rows.map((r) => ({
    id: r.id,
    requestId: r.request_id,
    actorId: r.actor_id,
    actorEmail: r.actor_email,
    event: r.event,
    notes: r.notes ?? undefined,
    timestamp: r.timestamp,
  }));
}

function mapWriteRequest(r: any): WriteRequest {
  let aiReview: WriteAiReview | undefined;
  if (r.ai_review_json) {
    try {
      aiReview = JSON.parse(r.ai_review_json);
    } catch {
      aiReview = undefined;
    }
  }
  return {
    id: r.id,
    title: r.title,
    description: r.description ?? undefined,
    connectionId: r.connection_id,
    connectionName: r.connection_name ?? undefined,
    env: r.env,
    dbType: r.db_type,
    selectSql: r.select_sql ?? "",
    writeSql: r.write_sql,
    status: r.status,
    requestedBy: r.requested_by,
    requestedByEmail: r.requested_by_email,
    requestedAt: r.requested_at,
    reviewedBy: r.reviewed_by ?? undefined,
    reviewedByEmail: r.reviewed_by_email ?? undefined,
    reviewedAt: r.reviewed_at ?? undefined,
    reviewNotes: r.review_notes ?? undefined,
    executedAt: r.executed_at ?? undefined,
    executedBy: r.executed_by ?? undefined,
    executedByEmail: r.executed_by_email ?? undefined,
    rowsAffected: r.rows_affected ?? undefined,
    executionMs: r.execution_ms ?? undefined,
    executionError: r.execution_error ?? undefined,
    transactional: r.transactional == null ? undefined : r.transactional === 1,
    aiVerdict: r.ai_verdict ?? undefined,
    aiReview,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function getWriteAnalytics(): {
  totals: Record<string, number>;
  pendingQueue: number;
} {
  const scalar = (sql: string): number => {
    const row = db.prepare(sql).get() as { v: number } | undefined;
    return row?.v ?? 0;
  };
  return {
    totals: {
      submitted30d: scalar(
        "SELECT COUNT(*) v FROM write_requests WHERE requested_at >= datetime('now','-30 days')",
      ),
      executed30d: scalar(
        "SELECT COUNT(*) v FROM write_requests WHERE status='EXECUTED' AND requested_at >= datetime('now','-30 days')",
      ),
      rejected30d: scalar(
        "SELECT COUNT(*) v FROM write_requests WHERE status='REJECTED' AND requested_at >= datetime('now','-30 days')",
      ),
      failed30d: scalar(
        "SELECT COUNT(*) v FROM write_requests WHERE status='FAILED' AND requested_at >= datetime('now','-30 days')",
      ),
      rowsAffected30d: scalar(
        "SELECT COALESCE(SUM(rows_affected),0) v FROM write_requests WHERE status='EXECUTED' AND requested_at >= datetime('now','-30 days')",
      ),
    },
    pendingQueue: scalar(
      "SELECT COUNT(*) v FROM write_requests WHERE status='PENDING'",
    ),
  };
}

export function getDb(): Database.Database {
  return db;
}
