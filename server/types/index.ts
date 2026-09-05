export type DatabaseType = "postgres" | "mssql" | "mongodb" | "elasticsearch";
/**
 * Environment name. Deliberately an open `string`: the set of environments comes
 * from `DBFORGE_CONNECTIONS` at runtime (see `getEnvironments()`), so a
 * deployment can define its own (e.g. `SUPER_PROD`) without a code change.
 * `"PROD"` is still special-cased by the PROD safety rails.
 */
export type Environment = string;
export type MaskingType = "FULL" | "PARTIAL" | "HASH" | "REDACT";

// --- Results "Copy as" formats ------------------------------------------------
// Deployment-configurable via COPY_FORMATS (see config/copy-formats.ts).
// Mirrored in src/types/index.ts — keep the two in sync.

/** How a template extractor quotes each cell. */
export type CopyQuote = "none" | "single" | "double";

/** Built-in structural formatters a copy format can reference by name. */
export type CopyBuiltin = "csv" | "tsv" | "json" | "markdown" | "sql-insert";

/** Separator-based custom extractor (DataGrip-style). */
export interface CopyTemplate {
  columnSeparator: string;
  rowSeparator: string;
  quote?: CopyQuote;
  /** When false, the first column is emitted bare (e.g. `code "description"`). */
  quoteFirstColumn?: boolean;
  /** Text emitted for null/undefined cells (default ""). */
  nullText?: string;
  /** Prepend a row of column names. */
  header?: boolean;
  prefix?: string;
  suffix?: string;
}

/**
 * One entry in the results "Copy as" menu. Carries either a `builtin`
 * structural formatter or a separator `template` — never both.
 */
export interface CopyFormat {
  id: string;
  label: string;
  group?: string;
  example?: string;
  columnMenu?: boolean;
  builtin?: CopyBuiltin;
  template?: CopyTemplate;
}

// Machine-readable error codes returned by the API (body: { error, code? }).
export type ApiErrorCode = "CONNECTION_FAILED";

export interface ApiErrorBody {
  error: string;
  code?: ApiErrorCode;
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
 * is escaped, never rendered — see `artifact-view.tsx`.
 */
export type ArtifactBlock =
  | { type: "text"; body: string }
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
  | "REJECTED"
  | "RESUBMITTED"
  | "EXECUTED"
  | "FAILED"
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
