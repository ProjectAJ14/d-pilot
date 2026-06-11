export type DatabaseType = "postgres" | "mssql" | "mongodb" | "elasticsearch";
export type Environment = "DEV" | "QA" | "UAT" | "STG" | "PROD";
export type MaskingType = "FULL" | "PARTIAL" | "HASH" | "REDACT";

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
  schema?: string;
  uri?: string; // for MongoDB
}

export interface QueryRequest {
  connectionId: string;
  sql: string;
  page?: number;
  pageSize?: number;
  defaultLimit?: number | null;
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
  defaultValue?: string;
  isPhiField: boolean;
}

export interface AuthUser {
  sub: string;
  email: string;
  name?: string;
  roles: string[];
  isAdmin: boolean;
  canUnmaskPhi: boolean;
  allowedEnvironments: string[];
}
