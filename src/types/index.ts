export type DatabaseType = "postgres" | "mssql" | "mongodb" | "elasticsearch";
export type Environment = "DEV" | "QA" | "STG" | "PROD";
export type MaskingType = "FULL" | "PARTIAL" | "HASH" | "REDACT";

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
  result: QueryResult | null;
  loading: boolean;
  error: string | null;
}

export interface User {
  id: string;
  username: string;
  email: string;
  displayName: string;
  role: "admin" | "read";
  createdAt: string;
  lastLogin?: string;
}
