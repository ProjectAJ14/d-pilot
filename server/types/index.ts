export type DatabaseType = "postgres" | "mssql" | "mongodb" | "elasticsearch";
/**
 * Environment name. Deliberately an open `string`: the set of environments comes
 * from the configured connections at runtime (see `getEnvironments()`), so a
 * deployment can define its own (e.g. `SUPER_PROD`) without a code change.
 * `"PROD"` is still special-cased by the PROD safety rails.
 */
export type Environment = string;
export type MaskingType = "FULL" | "PARTIAL" | "HASH" | "REDACT";

// Machine-readable error codes returned by the API (body: { error, code? }).
export type ApiErrorCode = "CONNECTION_FAILED" | "OBJECT_NOT_FOUND";

export interface ApiErrorBody {
  error: string;
  code?: ApiErrorCode;
  /** Write routes, on a 503 CONNECTION_FAILED: the request as it now is (DRAFT or PENDING). */
  request?: WriteRequest;
}

export interface ConnectionConfig {
  id: string;
  name: string;
  env: Environment;
  type: DatabaseType;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
  /** Default schema (Postgres/MSSQL). For Elasticsearch this field holds the protocol. */
  schema?: string;
  /**
   * Optional allowlist of schemas this connection may expose (Postgres/MSSQL).
   * When set, schema discovery is intersected with this list; when omitted, all
   * non-system schemas discovered on the database are offered.
   */
  schemas?: string[];
  uri?: string; // for MongoDB
}

// --- Admin settings (/api/settings) -------------------------------------------
// Mirrored in src/types/index.ts — keep the two in sync.

/** Where a setting's effective value comes from: Settings, `.env`, or code. */
export type SettingSource = "db" | "env" | "default";

export interface AppSettingView {
  key: string;
  group: "ai" | "branding" | "limits";
  secret: boolean;
  source: SettingSource;
  /** Effective value; absent for secrets, which never leave the server. */
  value?: string | null;
  /** Secrets only: whether a value is configured. */
  set?: boolean;
  /** Numeric limits only: the highest value that may be saved (operator ceiling). */
  max?: number;
}

/** A connection as the admin API returns it — credentials replaced by flags. */
export interface ConnectionAdminView {
  id: string;
  name: string;
  env: Environment;
  type: DatabaseType;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  schema?: string;
  schemas?: string[];
  passwordSet: boolean;
  uriSet: boolean;
}

export interface QueryRequest {
  connectionId: string;
  sql: string;
  /** Active schema to run against (Postgres/MSSQL). Falls back to the connection default. */
  schema?: string;
  page?: number;
  pageSize?: number;
  defaultLimit?: number | null;
}

export interface QueryColumn {
  name: string;
  type: string;
  isMasked: boolean;
  maskingType?: MaskingType;
  /** FK target (`table.column`) when the column unambiguously maps to one. */
  references?: string;
}

export interface QueryResult {
  columns: QueryColumn[];
  rows: Record<string, unknown>[];
  totalRows: number;
  executionTimeMs: number;
  masked: boolean;
  maskedFields: string[];
  connectionId: string;
  truncated: boolean;
}

export interface SavedQuery {
  id: string;
  name: string;
  sql: string;
  description?: string;
  connectionId?: string;
  createdBy: string;
  createdByEmail: string;
  isShared: boolean;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * One block of an artifact document. `text` is GitHub-flavoured markdown
 * (headings, bold, lists, tables); `sql` is a read query the viewer can run from
 * the artifact tab, against their own capabilities. Raw HTML inside a text block
 * is escaped, never rendered — see `artifact-view.tsx`. `html` is a rich page
 * (CSS, inline SVG) shown only in a sandboxed iframe — see `utils/artifact-html.ts`.
 */
export type ArtifactBlock =
  | { type: "text"; body: string }
  | { type: "html"; body: string }
  | { type: "sql"; sql: string; label?: string; connectionId?: string };

/**
 * A shareable document that lives next to the data it talks about: prose plus
 * runnable read queries. Stores queries, never rows — so every viewer's results
 * come back through their own masking and audit trail.
 */
export interface Artifact {
  id: string;
  title: string;
  description?: string;
  blocks: ArtifactBlock[];
  /** Fallback connection for `sql` blocks that don't name their own. */
  connectionId?: string;
  createdBy: string;
  createdByEmail: string;
  isShared: boolean;
  tags: string[];
  /** Set when archived. Artifacts are never deleted, only archived. */
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PhiFieldRule {
  id: string;
  pattern: string; // glob pattern for column names
  maskingType: MaskingType;
  alwaysMasked: boolean;
  database?: string; // optional: limit to specific database
  table?: string; // optional: limit to specific table
}

/** Which client made an audited request — see services/request-source.ts. */
export type RequestSource = "ui" | "mcp" | "api";

export interface AuditEntry {
  id: string;
  userId: string;
  userEmail: string;
  action: string;
  sql?: string;
  connectionId?: string;
  rowsReturned?: number;
  executionMs?: number;
  phiAccessed: boolean;
  phiFieldsUnmasked?: string[];
  phiUnmaskReason?: string;
  phiUnmaskNotes?: string;
  /** Absent on entries written before it was recorded. */
  source?: RequestSource;
  timestamp: string;
}

export interface AiChatLogEntry {
  id: string;
  userId: string;
  userEmail: string;
  connectionId?: string;
  dbType?: string;
  prompt: string; // the user's natural-language request
  systemPrompt?: string; // full system message sent to the model
  userMessage?: string; // full user message (schema context + request)
  responseRaw?: string; // raw model output
  generatedQuery?: string; // parsed query from the response
  explanation?: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  latencyMs?: number;
  status: "success" | "error";
  errorMessage?: string;
  schemaTruncated?: boolean;
  tablesProvided?: number;
  totalTables?: number;
  timestamp: string;
}

export interface TableInfo {
  schema: string;
  name: string;
  type: string; // TABLE, VIEW
  rowCount?: number;
}

/** Programmable objects the object browser lists (Postgres/SQL Server). */
export type DbObjectKind = "procedure" | "function" | "view" | "trigger";

export interface DbObjectInfo {
  schema: string;
  name: string;
  kind: DbObjectKind;
  /**
   * Postgres routines only: identity argument types, e.g. `integer, text`.
   * Overloads share a name, so this is part of the object's key.
   */
  args?: string;
  /** Triggers only: the table it fires on (Postgres trigger names are per table). */
  parent?: string;
}

export interface DbObjectDefinition extends DbObjectInfo {
  /** Null when the engine hides it: encrypted, or no VIEW DEFINITION permission. */
  definition: string | null;
}

/** One side of a dependency edge. `kind` is null when the engine can't resolve it. */
export interface DbObjectReference {
  schema?: string;
  name: string;
  /** procedure | function | view | trigger | table, or null for an unresolved reference. */
  kind: DbObjectKind | "table" | null;
  /** Set on a cross-database reference (SQL Server). */
  database?: string;
}

export interface DbObjectDependencies {
  uses: DbObjectReference[];
  usedBy: DbObjectReference[];
  /** True when part of the answer came from scanning bodies for names (Postgres functions). */
  bestEffort: boolean;
}

/** One object whose definition differs between two connections, or exists on one only. */
export interface DriftItem extends DbObjectInfo {
  status: "different" | "only_left" | "only_right";
}

export interface DriftReport {
  schema: string;
  /** Objects present on both sides with the same normalized definition. */
  identical: number;
  items: DriftItem[];
}

/** SQL Server Agent's run_status, decoded; pg_cron's status mapped onto it. */
export type JobRunStatus =
  | "failed"
  | "succeeded"
  | "retry"
  | "cancelled"
  | "running";

export interface JobRun {
  status: JobRunStatus | null;
  /** Server-local time, `YYYY-MM-DD HH:MM:SS` (msdb records no zone). */
  startedAt: string | null;
  durationSec: number | null;
  message?: string;
}

/** A scheduled job: a SQL Server Agent job, or a pg_cron job. */
export interface JobInfo {
  id: string;
  name: string;
  engine: "agent" | "pg_cron";
  enabled: boolean;
  description?: string;
  category?: string;
  /** Plain-language schedule summary (Agent) or the cron expression (pg_cron). */
  schedule?: string;
  lastRun?: JobRun;
  nextRunAt?: string | null;
  stepCount: number;
}

export interface JobStep {
  id: number;
  name: string;
  /** TSQL, CmdExec, PowerShell, SSIS, … — `SQL` for pg_cron. */
  subsystem: string;
  command: string;
  database?: string;
  lastRun?: JobRun;
}

export interface JobSchedule {
  id: string;
  name: string;
  enabled: boolean;
  /** "Every 30 minutes, 06:00–22:00, Mon–Fri", or the cron expression. */
  description: string;
  /** Other jobs that share this schedule — editing it changes them too. */
  sharedWith: number;
  /** Whether a job_change may edit it (daily/weekly/monthly; once or every N min/h). */
  editable: boolean;
  /** pg_cron: the cron expression. */
  cron?: string;
  /** Agent: the msdb columns, for an edit form. */
  msdb?: Record<string, number>;
}

export interface JobDetail extends JobInfo {
  steps: JobStep[];
  schedules: JobSchedule[];
  /** Most recent job-level outcomes, newest first. */
  history: JobRun[];
}

export interface JobList {
  /** False when the connection can't read jobs; `reason` names the missing grant. */
  available: boolean;
  reason?: string;
  jobs: JobInfo[];
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  /** FK target as `table.column` (schema-qualified when it differs), when known. */
  references?: string;
  defaultValue?: string;
  isPhiField: boolean;
  /** Every distinct value of a short, low-cardinality, non-PHI text column (AI context). */
  values?: string[];
}

export interface AuthUser {
  sub: string;
  email: string;
  name?: string;
  isAdmin: boolean;
  canUnmaskPhi: boolean;
  allowedEnvironments: string[];
  unmaskEnvironments: string[];
  writeEnvironments: string[];
  approveEnvironments: string[];
  canWrite: boolean;
  canApprove: boolean;
}

// ── Write mode / approval workflow ──

export type WriteRequestStatus =
  | "DRAFT"
  | "PENDING"
  | "APPROVED"
  | "EXECUTED"
  | "FAILED"
  | "REJECTED"
  | "CANCELLED";

export type WriteRequestEventType =
  | "SAVED"
  | "SUBMITTED"
  | "AI_REVIEWED"
  | "APPROVED"
  | "AUTO_APPROVED"
  | "OVERRIDDEN"
  | "REJECTED"
  | "RESUBMITTED"
  | "EXECUTED"
  | "FAILED"
  | "NOT_RUN"
  | "CANCELLED";

/** Structured AI safety assessment of a write request. */
export interface WriteAiReview {
  verdict: "SAFE" | "CAUTION" | "DANGEROUS";
  /** Only meaningful for single-statement DML (a migration has no verify SELECT). */
  selectMatchesWrite?: boolean;
  /** Only meaningful for single-statement DML. */
  estimatedBlastRadius?: string;
  risks: string[];
  summary: string;
  recommendation: string;
  /** A corrected WRITE statement when the current one is unsafe/incorrect. */
  suggestedWriteSql?: string;
  /** A verify SELECT that previews exactly the rows the (suggested) WRITE affects. */
  suggestedSelectSql?: string;
  model?: string;
  reviewedAt?: string;
}

export interface WriteRequestEvent {
  id: string;
  requestId: string;
  actorId: string;
  actorEmail: string;
  event: WriteRequestEventType;
  notes?: string;
  timestamp: string;
}

export interface WriteRequest {
  id: string;
  title: string;
  description?: string;
  connectionId: string;
  connectionName?: string;
  env: Environment;
  dbType: DatabaseType;
  selectSql: string;
  writeSql: string;
  status: WriteRequestStatus;
  requestedBy: string;
  requestedByEmail: string;
  requestedAt: string;
  reviewedBy?: string;
  reviewedByEmail?: string;
  reviewedAt?: string;
  reviewNotes?: string;
  executedAt?: string;
  executedBy?: string;
  executedByEmail?: string;
  rowsAffected?: number;
  executionMs?: number;
  executionError?: string;
  transactional?: boolean;
  /** Multi-statement migration script (vs. a single DML statement). */
  isMigration?: boolean;
  /** Migration opted out of the transaction wrapper (no rollback on failure). */
  noTransaction?: boolean;
  aiVerdict?: string;
  aiReview?: WriteAiReview;
  createdAt: string;
  updatedAt: string;
  events?: WriteRequestEvent[];
}

/** Admin AI settings (`/api/azure-ai/settings`). */
export interface AiSettings {
  /** Include distinct values of short, non-PHI text columns in AI schema context. */
  columnValues: boolean;
}
