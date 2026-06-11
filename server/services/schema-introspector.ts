import pg from "pg";
import mssql from "mssql";
import { MongoClient } from "mongodb";
import { Client as EsClient } from "@elastic/elasticsearch";
import type { ConnectionConfig, TableInfo, ColumnInfo } from "../types/index.js";
import { findMatchingRule } from "./phi-masking.js";

export async function getTables(conn: ConnectionConfig): Promise<TableInfo[]> {
  switch (conn.type) {
    case "postgres":
      return getPostgresTables(conn);
    case "mssql":
      return getMssqlTables(conn);
    case "mongodb":
      return getMongoCollections(conn);
    case "elasticsearch":
      return getEsIndices(conn);
    default:
      return [];
  }
}

export async function getColumns(conn: ConnectionConfig, tableName: string): Promise<ColumnInfo[]> {
  switch (conn.type) {
    case "postgres":
      return getPostgresColumns(conn, tableName);
    case "mssql":
      return getMssqlColumns(conn, tableName);
    case "mongodb":
      return getMongoFields(conn, tableName);
    case "elasticsearch":
      return getEsFields(conn, tableName);
    default:
      return [];
  }
}

// --- PostgreSQL ---

async function getPostgresTables(conn: ConnectionConfig): Promise<TableInfo[]> {
  const pool = new pg.Pool({
    host: conn.host,
    port: conn.port || 5432,
    database: conn.database,
    user: conn.username,
    password: conn.password,
    max: 2,
  });

  try {
    const schema = conn.schema || "public";
    const result = await pool.query(
      `SELECT table_name, table_type
       FROM information_schema.tables
       WHERE table_schema = $1
       ORDER BY table_name`,
      [schema]
    );

    return result.rows.map((r) => ({
      schema,
      name: r.table_name,
      type: r.table_type === "VIEW" ? "VIEW" : "TABLE",
    }));
  } finally {
    await pool.end();
  }
}

async function getPostgresColumns(conn: ConnectionConfig, tableName: string): Promise<ColumnInfo[]> {
  const pool = new pg.Pool({
    host: conn.host,
    port: conn.port || 5432,
    database: conn.database,
    user: conn.username,
    password: conn.password,
    max: 2,
  });

  try {
    const schema = conn.schema || "public";

    const colResult = await pool.query(
      `SELECT c.column_name, c.data_type, c.is_nullable, c.column_default,
              CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END as is_pk,
              CASE WHEN fk.column_name IS NOT NULL THEN true ELSE false END as is_fk
       FROM information_schema.columns c
       LEFT JOIN (
         SELECT ku.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage ku ON tc.constraint_name = ku.constraint_name
         WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'PRIMARY KEY'
       ) pk ON c.column_name = pk.column_name
       LEFT JOIN (
         SELECT ku.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage ku ON tc.constraint_name = ku.constraint_name
         WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'FOREIGN KEY'
       ) fk ON c.column_name = fk.column_name
       WHERE c.table_schema = $1 AND c.table_name = $2
       ORDER BY c.ordinal_position`,
      [schema, tableName]
    );

    return colResult.rows.map((r) => ({
      name: r.column_name,
      dataType: r.data_type,
      nullable: r.is_nullable === "YES",
      isPrimaryKey: r.is_pk,
      isForeignKey: r.is_fk,
      defaultValue: r.column_default,
      isPhiField: !!findMatchingRule(r.column_name, conn.database, tableName),
    }));
  } finally {
    await pool.end();
  }
}

// --- SQL Server ---

async function getMssqlTables(conn: ConnectionConfig): Promise<TableInfo[]> {
  const pool = new mssql.ConnectionPool({
    server: conn.host || "localhost",
    port: conn.port || 1433,
    database: conn.database,
    user: conn.username,
    password: conn.password,
    options: { encrypt: false, trustServerCertificate: true },
  });

  try {
    await pool.connect();
    const result = await pool.request().query(
      `SELECT TABLE_NAME, TABLE_TYPE, TABLE_SCHEMA
       FROM INFORMATION_SCHEMA.TABLES
       ORDER BY TABLE_NAME`
    );

    return result.recordset.map((r: any) => ({
      schema: r.TABLE_SCHEMA,
      name: r.TABLE_NAME,
      type: r.TABLE_TYPE === "VIEW" ? "VIEW" : "TABLE",
    }));
  } finally {
    await pool.close();
  }
}

async function getMssqlColumns(conn: ConnectionConfig, tableName: string): Promise<ColumnInfo[]> {
  const pool = new mssql.ConnectionPool({
    server: conn.host || "localhost",
    port: conn.port || 1433,
    database: conn.database,
    user: conn.username,
    password: conn.password,
    options: { encrypt: false, trustServerCertificate: true },
  });

  try {
    await pool.connect();
    const result = await pool.request().input("table", mssql.VarChar, tableName).query(
      `SELECT c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE, c.COLUMN_DEFAULT,
              CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END as is_pk,
              CASE WHEN fk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END as is_fk
       FROM INFORMATION_SCHEMA.COLUMNS c
       LEFT JOIN (
         SELECT ku.COLUMN_NAME
         FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
         JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
         WHERE tc.TABLE_NAME = @table AND tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
       ) pk ON c.COLUMN_NAME = pk.COLUMN_NAME
       LEFT JOIN (
         SELECT ku.COLUMN_NAME
         FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
         JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
         WHERE tc.TABLE_NAME = @table AND tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
       ) fk ON c.COLUMN_NAME = fk.COLUMN_NAME
       WHERE c.TABLE_NAME = @table
       ORDER BY c.ORDINAL_POSITION`
    );

    return result.recordset.map((r: any) => ({
      name: r.COLUMN_NAME,
      dataType: r.DATA_TYPE,
      nullable: r.IS_NULLABLE === "YES",
      isPrimaryKey: !!r.is_pk,
      isForeignKey: !!r.is_fk,
      defaultValue: r.COLUMN_DEFAULT,
      isPhiField: !!findMatchingRule(r.COLUMN_NAME, conn.database, tableName),
    }));
  } finally {
    await pool.close();
  }
}

// --- MongoDB ---

async function getMongoCollections(conn: ConnectionConfig): Promise<TableInfo[]> {
  const uri = conn.uri || `mongodb://${conn.username}:${conn.password}@${conn.host}:${conn.port || 27017}/${conn.database}`;
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });

  try {
    await client.connect();
    const dbName = conn.database || conn.uri?.split("/").pop()?.split("?")[0] || "test";
    const db = client.db(dbName);
    const collections = await db.listCollections().toArray();

    return collections.map((c) => ({
      schema: dbName,
      name: c.name,
      type: c.type === "view" ? "VIEW" : "TABLE",
    }));
  } finally {
    await client.close();
  }
}

async function getMongoFields(conn: ConnectionConfig, collectionName: string): Promise<ColumnInfo[]> {
  const uri = conn.uri || `mongodb://${conn.username}:${conn.password}@${conn.host}:${conn.port || 27017}/${conn.database}`;
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });

  try {
    await client.connect();
    const dbName = conn.database || conn.uri?.split("/").pop()?.split("?")[0] || "test";
    const db = client.db(dbName);

    // Sample documents to infer fields
    const sample = await db.collection(collectionName).find({}).limit(100).toArray();
    const fieldMap = new Map<string, string>();

    for (const doc of sample) {
      for (const [key, value] of Object.entries(doc)) {
        if (!fieldMap.has(key)) {
          fieldMap.set(key, typeof value);
        }
      }
    }

    return Array.from(fieldMap.entries()).map(([name, type]) => ({
      name,
      dataType: type,
      nullable: true,
      isPrimaryKey: name === "_id",
      isForeignKey: false,
      isPhiField: !!findMatchingRule(name, conn.database, collectionName),
    }));
  } finally {
    await client.close();
  }
}

// --- Elasticsearch ---

async function getEsIndices(conn: ConnectionConfig): Promise<TableInfo[]> {
  const protocol = conn.schema || "http";
  const node = conn.uri || `${protocol}://${conn.host}:${conn.port || 9200}`;
  const client = new EsClient({
    node,
    auth: conn.username && conn.password ? { username: conn.username, password: conn.password } : undefined,
    tls: { rejectUnauthorized: false },
    requestTimeout: 10000,
  });

  const indices = await client.cat.indices({ format: "json" });
  return (indices as any[])
    .filter((idx: any) => !idx.index.startsWith(".")) // hide system indices
    .sort((a: any, b: any) => a.index.localeCompare(b.index))
    .map((idx: any) => ({
      schema: "elasticsearch",
      name: idx.index,
      type: "INDEX",
      rowCount: parseInt(idx["docs.count"] || "0", 10),
    }));
}

// --- Schema introspection for AI query generation ---
//
// We introspect the FULL schema (all tables + columns) once and cache it per
// connection with a configurable TTL, then format any subset of tables on
// demand. This lets us send only the tables relevant to a request (chosen by a
// cheap LLM pass) in full detail, instead of an arbitrary shallow cap.
// Only metadata (table/column names + types) is ever read — never row data.

/** Full structured schema for a connection: all tables and their columns. */
export interface FullSchema {
  tables: { name: string; type: string }[];
  columns: Record<string, ColumnInfo[]>;
}

/** Formatted, prompt-ready summary of a (possibly filtered) set of tables. */
export interface SchemaSummary {
  /** Human/LLM-readable compact description. */
  text: string;
  /** Total tables discovered on the connection. */
  totalTables: number;
  /** Tables actually rendered in `text`. */
  includedTables: number;
  /** True if some tables were left out of `text`. */
  truncated: boolean;
  /** Names of the tables rendered in `text` (for example-query matching). */
  tableNames: string[];
}

const MAX_TABLES_DEFAULT = 60;
const MAX_COLS_PER_TABLE = 80;
// Mongo/ES introspect columns per collection (one connection each), so bound
// the fan-out. SQL engines fetch all columns in one query — no bound needed.
const MAX_SAMPLED_TABLES = 120;

async function getFullSchema(conn: ConnectionConfig): Promise<FullSchema> {
  if (conn.type === "postgres") return getPostgresFullSchema(conn);
  if (conn.type === "mssql") return getMssqlFullSchema(conn);
  return getSampledFullSchema(conn);
}

/**
 * Formats a prompt-ready summary for the given table names. With no list, falls
 * back to all tables capped at `maxTables`. Pure — no DB access.
 */
export function summarizeTables(
  full: FullSchema,
  tableNames?: string[],
  maxTables = MAX_TABLES_DEFAULT
): SchemaSummary {
  const all = full.tables.map((t) => t.name);
  const typeOf = new Map(full.tables.map((t) => [t.name, t.type]));

  let names: string[];
  if (tableNames && tableNames.length) {
    const known = new Set(all);
    names = [...new Set(tableNames.filter((n) => known.has(n)))];
  } else {
    names = all.slice(0, maxTables);
  }

  const blocks = names.map((n) => formatTable(n, typeOf.get(n) || "TABLE", full.columns[n] || []));

  return {
    text: blocks.join("\n\n"),
    totalTables: all.length,
    includedTables: names.length,
    truncated: names.length < all.length,
    tableNames: names,
  };
}

/**
 * Compact catalog (table name + column names only) of every table, for the
 * table-selection pass. Much cheaper than the full summary (no types/flags).
 */
export function tableCatalog(full: FullSchema, maxColsPerTable = 40): string {
  return full.tables
    .map((t) => {
      const cols = full.columns[t.name] || [];
      const shown = cols.slice(0, maxColsPerTable).map((c) => c.name);
      const extra = cols.length > shown.length ? `, +${cols.length - shown.length} more` : "";
      const label = t.type === "VIEW" ? " (view)" : "";
      return `${t.name}${label}: ${shown.join(", ")}${extra}`;
    })
    .join("\n");
}

// --- Full-schema cache (TTL-based) ---
//
// Introspecting a live DB on every AI request is slow and load-heavy, and the
// schema rarely changes. Cache the full schema per connection with a
// configurable TTL (SCHEMA_CACHE_TTL_HOURS, default 24h; 0 disables), and
// de-duplicate concurrent introspections of the same connection.

export interface CachedFullSchema {
  schema: FullSchema;
  cached: boolean;
  cachedAt: string; // ISO
  ttlHours: number;
}

interface SchemaCacheRecord {
  schema: FullSchema;
  cachedAt: number;
  expiresAt: number;
}

const schemaCache = new Map<string, SchemaCacheRecord>();
const schemaInflight = new Map<string, Promise<FullSchema>>();

function getSchemaCacheTtlMs(): number {
  const hours = parseFloat(process.env.SCHEMA_CACHE_TTL_HOURS ?? "24");
  return Number.isFinite(hours) && hours >= 0 ? hours * 3_600_000 : 24 * 3_600_000;
}

/**
 * Returns the full schema for a connection, served from an in-memory TTL cache
 * when fresh. Concurrent misses for the same connection share one introspection.
 */
export async function getCachedFullSchema(
  conn: ConnectionConfig,
  opts: { forceRefresh?: boolean } = {}
): Promise<CachedFullSchema> {
  const ttlMs = getSchemaCacheTtlMs();
  const ttlHours = ttlMs / 3_600_000;
  const key = conn.id;
  const now = Date.now();

  if (!opts.forceRefresh && ttlMs > 0) {
    const hit = schemaCache.get(key);
    if (hit && hit.expiresAt > now) {
      return { schema: hit.schema, cached: true, cachedAt: new Date(hit.cachedAt).toISOString(), ttlHours };
    }
  }

  // De-dupe concurrent introspections (skip sharing when forcing a refresh).
  let pending = opts.forceRefresh ? undefined : schemaInflight.get(key);
  if (!pending) {
    pending = getFullSchema(conn)
      .then((schema) => {
        if (ttlMs > 0) {
          const ts = Date.now();
          schemaCache.set(key, { schema, cachedAt: ts, expiresAt: ts + ttlMs });
        }
        return schema;
      })
      .finally(() => {
        if (schemaInflight.get(key) === pending) schemaInflight.delete(key);
      });
    schemaInflight.set(key, pending);
  }

  const schema = await pending;
  const rec = schemaCache.get(key);
  return { schema, cached: false, cachedAt: new Date(rec?.cachedAt ?? now).toISOString(), ttlHours };
}

/** Clears cached schemas. Pass a connectionId to clear just that one. */
export function clearSchemaCache(connectionId?: string): { cleared: number } {
  if (!connectionId) {
    const n = schemaCache.size;
    schemaCache.clear();
    return { cleared: n };
  }
  return { cleared: schemaCache.delete(connectionId) ? 1 : 0 };
}

function formatTable(
  name: string,
  type: string,
  cols: ColumnInfo[]
): string {
  const shown = cols.slice(0, MAX_COLS_PER_TABLE);
  const lines = shown.map((c) => {
    const flags: string[] = [];
    if (c.isPrimaryKey) flags.push("PK");
    if (c.isForeignKey) flags.push("FK");
    if (!c.nullable) flags.push("NOT NULL");
    if (c.isPhiField) flags.push("PHI");
    const suffix = flags.length ? ` [${flags.join(", ")}]` : "";
    return `  - ${c.name}: ${c.dataType}${suffix}`;
  });
  if (cols.length > shown.length) {
    lines.push(`  - ...(${cols.length - shown.length} more columns)`);
  }
  const label = type === "VIEW" ? " (view)" : "";
  return `${name}${label}\n${lines.join("\n")}`;
}

async function getPostgresFullSchema(conn: ConnectionConfig): Promise<FullSchema> {
  const pool = new pg.Pool({
    host: conn.host,
    port: conn.port || 5432,
    database: conn.database,
    user: conn.username,
    password: conn.password,
    max: 2,
  });

  try {
    const schema = conn.schema || "public";

    const [tablesRes, colsRes, pkRes, fkRes] = await Promise.all([
      pool.query(
        `SELECT table_name, table_type FROM information_schema.tables
         WHERE table_schema = $1 ORDER BY table_name`,
        [schema]
      ),
      pool.query(
        `SELECT table_name, column_name, data_type, is_nullable, ordinal_position
         FROM information_schema.columns WHERE table_schema = $1
         ORDER BY table_name, ordinal_position`,
        [schema]
      ),
      pool.query(
        `SELECT tc.table_name, ku.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage ku ON tc.constraint_name = ku.constraint_name
         WHERE tc.table_schema = $1 AND tc.constraint_type = 'PRIMARY KEY'`,
        [schema]
      ),
      pool.query(
        `SELECT tc.table_name, ku.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage ku ON tc.constraint_name = ku.constraint_name
         WHERE tc.table_schema = $1 AND tc.constraint_type = 'FOREIGN KEY'`,
        [schema]
      ),
    ]);

    const pkSet = new Set(pkRes.rows.map((r) => `${r.table_name}.${r.column_name}`));
    const fkSet = new Set(fkRes.rows.map((r) => `${r.table_name}.${r.column_name}`));

    const columns: Record<string, ColumnInfo[]> = {};
    for (const r of colsRes.rows) {
      (columns[r.table_name] ||= []).push({
        name: r.column_name,
        dataType: r.data_type,
        nullable: r.is_nullable === "YES",
        isPrimaryKey: pkSet.has(`${r.table_name}.${r.column_name}`),
        isForeignKey: fkSet.has(`${r.table_name}.${r.column_name}`),
        isPhiField: !!findMatchingRule(r.column_name, conn.database, r.table_name),
      });
    }

    const tables = tablesRes.rows.map((t) => ({
      name: t.table_name as string,
      type: t.table_type === "VIEW" ? "VIEW" : "TABLE",
    }));
    return { tables, columns };
  } finally {
    await pool.end();
  }
}

async function getMssqlFullSchema(conn: ConnectionConfig): Promise<FullSchema> {
  const pool = new mssql.ConnectionPool({
    server: conn.host || "localhost",
    port: conn.port || 1433,
    database: conn.database,
    user: conn.username,
    password: conn.password,
    options: { encrypt: false, trustServerCertificate: true },
  });

  try {
    await pool.connect();
    const tablesRes = await pool.request().query(
      `SELECT TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES ORDER BY TABLE_NAME`
    );
    const colsRes = await pool.request().query(
      `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE, ORDINAL_POSITION
       FROM INFORMATION_SCHEMA.COLUMNS ORDER BY TABLE_NAME, ORDINAL_POSITION`
    );
    const pkRes = await pool.request().query(
      `SELECT tc.TABLE_NAME, ku.COLUMN_NAME
       FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
       JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
       WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'`
    );
    const fkRes = await pool.request().query(
      `SELECT tc.TABLE_NAME, ku.COLUMN_NAME
       FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
       JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
       WHERE tc.CONSTRAINT_TYPE = 'FOREIGN KEY'`
    );

    const pkSet = new Set(pkRes.recordset.map((r: any) => `${r.TABLE_NAME}.${r.COLUMN_NAME}`));
    const fkSet = new Set(fkRes.recordset.map((r: any) => `${r.TABLE_NAME}.${r.COLUMN_NAME}`));

    const columns: Record<string, ColumnInfo[]> = {};
    for (const r of colsRes.recordset as any[]) {
      (columns[r.TABLE_NAME] ||= []).push({
        name: r.COLUMN_NAME,
        dataType: r.DATA_TYPE,
        nullable: r.IS_NULLABLE === "YES",
        isPrimaryKey: pkSet.has(`${r.TABLE_NAME}.${r.COLUMN_NAME}`),
        isForeignKey: fkSet.has(`${r.TABLE_NAME}.${r.COLUMN_NAME}`),
        isPhiField: !!findMatchingRule(r.COLUMN_NAME, conn.database, r.TABLE_NAME),
      });
    }

    const tables = (tablesRes.recordset as any[]).map((t) => ({
      name: t.TABLE_NAME as string,
      type: t.TABLE_TYPE === "VIEW" ? "VIEW" : "TABLE",
    }));
    return { tables, columns };
  } finally {
    await pool.close();
  }
}

/** Fallback for Mongo/Elasticsearch: sample fields per collection/index. */
async function getSampledFullSchema(conn: ConnectionConfig): Promise<FullSchema> {
  const tableInfos = await getTables(conn);
  // Each getColumns opens its own client; bound the fan-out for huge schemas.
  const toIntrospect = tableInfos.slice(0, MAX_SAMPLED_TABLES);

  const columns: Record<string, ColumnInfo[]> = {};
  await Promise.all(
    toIntrospect.map(async (t) => {
      try {
        columns[t.name] = await getColumns(conn, t.name);
      } catch {
        columns[t.name] = [];
      }
    })
  );

  const tables = tableInfos.map((t) => ({ name: t.name, type: t.type }));
  return { tables, columns };
}

async function getEsFields(conn: ConnectionConfig, indexName: string): Promise<ColumnInfo[]> {
  const protocol = conn.schema || "http";
  const node = conn.uri || `${protocol}://${conn.host}:${conn.port || 9200}`;
  const client = new EsClient({
    node,
    auth: conn.username && conn.password ? { username: conn.username, password: conn.password } : undefined,
    tls: { rejectUnauthorized: false },
    requestTimeout: 10000,
  });

  const mapping = await client.indices.getMapping({ index: indexName });
  const properties = (mapping as any)[indexName]?.mappings?.properties || {};

  function flattenProps(props: Record<string, any>, prefix = ""): ColumnInfo[] {
    const result: ColumnInfo[] = [];
    for (const [name, def] of Object.entries(props) as [string, any][]) {
      const fullName = prefix ? `${prefix}.${name}` : name;
      result.push({
        name: fullName,
        dataType: def.type || "object",
        nullable: true,
        isPrimaryKey: false,
        isForeignKey: false,
        isPhiField: !!findMatchingRule(fullName, undefined, indexName),
      });
      if (def.properties) {
        result.push(...flattenProps(def.properties, fullName));
      }
    }
    return result;
  }

  return flattenProps(properties);
}
