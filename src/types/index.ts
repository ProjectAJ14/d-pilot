export type DatabaseType = "postgres" | "mssql" | "mongodb" | "elasticsearch";
/**
 * Environment name. Open `string` by design — the deployment's environments come
 * from the server (`/api/config` → `environments`), not from this union.
 * `"PROD"` is still special-cased by the PROD safety rails.
 */
export type Environment = string;
export type MaskingType = "FULL" | "PARTIAL" | "HASH" | "REDACT";
export type ResultViewMode = "table" | "json";

// --- Results "Copy as" formats ------------------------------------------------
// Deployment-configurable via the COPY_FORMATS env var, with code defaults. See
// server/config/copy-formats.ts (loader + defaults) and
// src/utils/data-extractors.ts (the renderer). Mirrored in server/types.

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
  /** Menu section (e.g. "Tabular", "List / SQL"). */
  group?: string;
  /** Short example shown under the label in the menu. */
  example?: string;
  /** Also offer this format on the per-column right-click menu. */
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

export interface ConnectionInfo {
  id: string;
  name: string;
  env: Environment;
  type: DatabaseType;
  host?: string;
  port?: number;
  database?: string;
  schema?: string;
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

export interface PhiFieldRule {
  id: string;
  pattern: string;
  maskingType: MaskingType;
  alwaysMasked: boolean;
  database?: string;
  table?: string;
}

export interface TableInfo {
  schema: string;
  name: string;
  type: string;
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

export interface QueryTab {
  id: string;
  title: string;
  /** "artifact" tabs render an Artifact document instead of the SQL editor. */
  kind?: "sql" | "artifact";
  /** Set on artifact tabs — the document is fetched fresh, never persisted. */
  artifactId?: string;
  sql: string;
  connectionId: string | null;
  /** Active schema for this tab (Postgres/MSSQL). Undefined = connection default. */
  schema?: string;
  result: QueryResult | null;
  loading: boolean;
  error: string | null;
  viewMode?: ResultViewMode;
}

export interface User {
  id: string;
  username: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
  allowedEnvironments?: string[];
  unmaskEnvironments?: string[];
  writeEnvironments?: string[];
  approveEnvironments?: string[];
  createdAt: string;
  lastLogin?: string;
}

export type WriteRequestStatus =
  | "DRAFT"
  | "PENDING"
  | "APPROVED"
  | "EXECUTED"
  | "FAILED"
  | "REJECTED"
  | "CANCELLED";

export interface WriteAiReview {
  verdict: "SAFE" | "CAUTION" | "DANGEROUS";
  /** Only meaningful for single-statement DML (a migration has no verify SELECT). */
  selectMatchesWrite?: boolean;
  /** Only meaningful for single-statement DML. */
  estimatedBlastRadius?: string;
  risks: string[];
  summary: string;
  recommendation: string;
  suggestedWriteSql?: string;
  suggestedSelectSql?: string;
  model?: string;
  reviewedAt?: string;
}

export interface WriteRequestEvent {
  id: string;
  requestId: string;
  actorId: string;
  actorEmail: string;
  event:
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
  viewerCanApprove?: boolean;
  viewerIsRequester?: boolean;
  viewerCanPreview?: boolean;
  /** Viewer may turn this saved DRAFT into a live request (write capability on its env). */
  viewerCanSubmit?: boolean;
  /** Submitting this request executes it immediately (direct-write environment). */
  submitRunsImmediately?: boolean;
}

export interface AiChatLogEntry {
  id: string;
  userId: string;
  userEmail: string;
  connectionId?: string;
  dbType?: string;
  prompt: string;
  systemPrompt?: string;
  userMessage?: string;
  responseRaw?: string;
  generatedQuery?: string;
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
