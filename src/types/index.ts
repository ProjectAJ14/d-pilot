export type DatabaseType = "postgres" | "mssql" | "mongodb" | "elasticsearch";
export type Environment = "DEV" | "QA" | "UAT" | "STG" | "PROD";
export type MaskingType = "FULL" | "PARTIAL" | "HASH" | "REDACT";
export type ResultViewMode = "table" | "json";

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
  defaultValue?: string;
  isPhiField: boolean;
}

export interface QueryTab {
  id: string;
  title: string;
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
  selectMatchesWrite: boolean;
  estimatedBlastRadius: string;
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
  aiVerdict?: string;
  aiReview?: WriteAiReview;
  createdAt: string;
  updatedAt: string;
  events?: WriteRequestEvent[];
  viewerCanApprove?: boolean;
  viewerIsRequester?: boolean;
  viewerCanPreview?: boolean;
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
