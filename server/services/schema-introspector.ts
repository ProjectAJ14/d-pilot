import pg from "pg";
import mssql from "mssql";
import { MongoClient } from "mongodb";
import { Client as EsClient } from "@elastic/elasticsearch";
import type { ConnectionConfig, TableInfo, ColumnInfo } from "../types/index.js";
import { findMatchingRule } from "./phi-masking.js";
import { scanSql } from "./sql-scan.js";

/** The default schema for a connection when none is explicitly selected. */
export function defaultSchema(conn: ConnectionConfig): string {
  if (conn.type === "postgres") return conn.schema || "public";
  if (conn.type === "mssql") return conn.schema || "dbo";
  return conn.schema || "";
}

/** Resolves an (optional) requested schema to a concrete one for Postgres/MSSQL. */
export function resolveSchema(conn: ConnectionConfig, schema?: string): string {
  const s = (schema ?? "").trim();
  return s || defaultSchema(conn);
}

export async function getTables(
  conn: ConnectionConfig,
  schema?: string
): Promise<TableInfo[]> {
  switch (conn.type) {
    case "postgres":
      return getPostgresTables(conn, resolveSchema(conn, schema));
    case "mssql":
      return getMssqlTables(conn, resolveSchema(conn, schema));
    case "mongodb":
      return getMongoCollections(conn);
    case "elasticsearch":
      return getEsIndices(conn);
    default:
      return [];
  }
}

export async function getColumns(
  conn: ConnectionConfig,
  tableName: string,
  schema?: string
): Promise<ColumnInfo[]> {
  switch (conn.type) {
    case "postgres":
      return getPostgresColumns(conn, tableName, resolveSchema(conn, schema));
    case "mssql":
      return getMssqlColumns(conn, tableName, resolveSchema(conn, schema));
    case "mongodb":
      return getMongoFields(conn, tableName);
    case "elasticsearch":
      return getEsFields(conn, tableName);
    default:
      return [];
  }
}

/**
 * Discovers the schemas a connection exposes (Postgres/MSSQL only). System
 * schemas are excluded. When the connection declares a `schemas` allowlist, the
 * result is intersected with it. Mongo/Elasticsearch return an empty list
 * (the concept doesn't apply the same way).
 */
export async function getSchemas(
  conn: ConnectionConfig
): Promise<{ schemas: string[]; default: string }> {
  let discovered: string[] = [];
  if (conn.type === "postgres") discovered = await getPostgresSchemas(conn);
  else if (conn.type === "mssql") discovered = await getMssqlSchemas(conn);
  else return { schemas: [], default: "" };

  const allow = conn.schemas?.length
    ? new Set(conn.schemas)
    : null;
  let schemas = allow ? discovered.filter((s) => allow.has(s)) : discovered;

  // Always surface the default schema, even if filtered/undiscovered.
  const def = defaultSchema(conn);
  if (def && !schemas.includes(def)) schemas = [def, ...schemas];

  return { schemas, default: def };
}

async function getPostgresSchemas(conn: ConnectionConfig): Promise<string[]> {
  const pool = new pg.Pool({
    host: conn.host,
    port: conn.port || 5432,
    database: conn.database,
    user: conn.username,
    password: conn.password,
    max: 2,
    connectionTimeoutMillis: 10000,
  });
  try {
    const res = await pool.query(
      `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name NOT LIKE 'pg_%' AND schema_name <> 'information_schema'
       ORDER BY schema_name`
    );
    return res.rows.map((r) => r.schema_name as string);
  } finally {
    await pool.end();
  }
}

async function getMssqlSchemas(conn: ConnectionConfig): Promise<string[]> {
  const pool = new mssql.ConnectionPool({
    server: conn.host || "localhost",
    port: conn.port || 1433,
    database: conn.database,
    user: conn.username,
    password: conn.password,
    options: { encrypt: false, trustServerCertificate: true },
    connectionTimeout: 10000,
  });
  try {
    await pool.connect();
    const res = await pool.request().query(
      `SELECT name FROM sys.schemas
       WHERE name NOT IN ('sys','INFORMATION_SCHEMA','guest','db_owner',
         'db_accessadmin','db_securityadmin','db_ddladmin','db_backupoperator',
         'db_datareader','db_datawriter','db_denydatareader','db_denydatawriter')
         AND name NOT LIKE 'db_%'
       ORDER BY name`
    );
    return (res.recordset as any[]).map((r) => r.name as string);
  } finally {
    await pool.close();
  }
}

// --- PostgreSQL ---

async function getPostgresTables(
  conn: ConnectionConfig,
  schema: string
): Promise<TableInfo[]> {
  const pool = new pg.Pool({
    host: conn.host,
    port: conn.port || 5432,
    database: conn.database,
    user: conn.username,
    password: conn.password,
    max: 2,
    connectionTimeoutMillis: 10000,
  });

  try {
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

/** `table.column` for an FK target, schema-qualified only when it crosses schemas. */
function fkTarget(schema: string, refSchema: string, refTable: string, refColumn: string): string {
  const prefix = refSchema && refSchema !== schema ? `${refSchema}.` : "";
  return `${prefix}${refTable}.${refColumn}`;
}

/** Postgres FK targets for a schema (optionally one table): keyed `table.column`. */
const PG_FK_SQL = `SELECT ku.table_name, ku.column_name,
          tgt.table_schema AS ref_schema, tgt.table_name AS ref_table, tgt.column_name AS ref_column
   FROM information_schema.table_constraints tc
   JOIN information_schema.key_column_usage ku
     ON tc.constraint_name = ku.constraint_name AND tc.constraint_schema = ku.constraint_schema
   JOIN information_schema.referential_constraints rc
     ON tc.constraint_name = rc.constraint_name AND tc.constraint_schema = rc.constraint_schema
   JOIN information_schema.key_column_usage tgt
     ON rc.unique_constraint_name = tgt.constraint_name
    AND rc.unique_constraint_schema = tgt.constraint_schema
    AND tgt.ordinal_position = ku.position_in_unique_constraint
   WHERE tc.table_schema = $1 AND tc.constraint_type = 'FOREIGN KEY'`;

/**
 * SQL Server FK targets. INFORMATION_SCHEMA.KEY_COLUMN_USAGE has no
 * POSITION_IN_UNIQUE_CONSTRAINT here, so the sys catalog views are the only way
 * to pair each FK column with the column it points at.
 */
const MSSQL_FK_SQL = `SELECT tp.name AS table_name, cp.name AS column_name,
          rs.name AS ref_schema, tr.name AS ref_table, cr.name AS ref_column
   FROM sys.foreign_key_columns fkc
   JOIN sys.tables tp ON fkc.parent_object_id = tp.object_id
   JOIN sys.schemas ps ON tp.schema_id = ps.schema_id
   JOIN sys.columns cp ON fkc.parent_object_id = cp.object_id AND fkc.parent_column_id = cp.column_id
   JOIN sys.tables tr ON fkc.referenced_object_id = tr.object_id
   JOIN sys.schemas rs ON tr.schema_id = rs.schema_id
   JOIN sys.columns cr ON fkc.referenced_object_id = cr.object_id AND fkc.referenced_column_id = cr.column_id
   WHERE ps.name = @schema`;

/** Maps `table.column` -> rendered FK target for rows of either query above. */
function fkMap(rows: any[], schema: string): Map<string, string> {
  return new Map(
    rows.map((r) => [
      `${r.table_name}.${r.column_name}`,
      fkTarget(schema, r.ref_schema, r.ref_table, r.ref_column),
    ])
  );
}

async function getPostgresColumns(
  conn: ConnectionConfig,
  tableName: string,
  schema: string
): Promise<ColumnInfo[]> {
  const pool = new pg.Pool({
    host: conn.host,
    port: conn.port || 5432,
    database: conn.database,
    user: conn.username,
    password: conn.password,
    max: 2,
    connectionTimeoutMillis: 10000,
  });

  try {
    const [colResult, fkResult] = await Promise.all([
      pool.query(
        `SELECT c.column_name, c.data_type, c.is_nullable, c.column_default,
              CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END as is_pk
       FROM information_schema.columns c
       LEFT JOIN (
         SELECT ku.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage ku ON tc.constraint_name = ku.constraint_name
         WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'PRIMARY KEY'
       ) pk ON c.column_name = pk.column_name
       WHERE c.table_schema = $1 AND c.table_name = $2
       ORDER BY c.ordinal_position`,
        [schema, tableName]
      ),
      pool.query(`${PG_FK_SQL} AND tc.table_name = $2`, [schema, tableName]),
    ]);

    const fks = fkMap(fkResult.rows, schema);

    return colResult.rows.map((r) => ({
      name: r.column_name,
      dataType: r.data_type,
      nullable: r.is_nullable === "YES",
      isPrimaryKey: r.is_pk,
      isForeignKey: fks.has(`${tableName}.${r.column_name}`),
      references: fks.get(`${tableName}.${r.column_name}`),
      defaultValue: r.column_default,
      isPhiField: !!findMatchingRule(r.column_name, conn.database, tableName),
    }));
  } finally {
    await pool.end();
  }
}

// --- SQL Server ---

async function getMssqlTables(
  conn: ConnectionConfig,
  schema: string
): Promise<TableInfo[]> {
  const pool = new mssql.ConnectionPool({
    server: conn.host || "localhost",
    port: conn.port || 1433,
    database: conn.database,
    user: conn.username,
    password: conn.password,
    options: { encrypt: false, trustServerCertificate: true },
    connectionTimeout: 10000,
  });

  try {
    await pool.connect();
    const result = await pool
      .request()
      .input("schema", mssql.VarChar, schema)
      .query(
        `SELECT TABLE_NAME, TABLE_TYPE, TABLE_SCHEMA
         FROM INFORMATION_SCHEMA.TABLES
         WHERE TABLE_SCHEMA = @schema
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

async function getMssqlColumns(
  conn: ConnectionConfig,
  tableName: string,
  schema: string
): Promise<ColumnInfo[]> {
  const pool = new mssql.ConnectionPool({
    server: conn.host || "localhost",
    port: conn.port || 1433,
    database: conn.database,
    user: conn.username,
    password: conn.password,
    options: { encrypt: false, trustServerCertificate: true },
    connectionTimeout: 10000,
  });

  try {
    await pool.connect();
    const req = () =>
      pool
        .request()
        .input("table", mssql.VarChar, tableName)
        .input("schema", mssql.VarChar, schema);
    const result = await req().query(
      `SELECT c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE, c.COLUMN_DEFAULT,
              CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END as is_pk
       FROM INFORMATION_SCHEMA.COLUMNS c
       LEFT JOIN (
         SELECT ku.COLUMN_NAME
         FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
         JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
         WHERE tc.TABLE_NAME = @table AND tc.TABLE_SCHEMA = @schema AND tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
       ) pk ON c.COLUMN_NAME = pk.COLUMN_NAME
       WHERE c.TABLE_NAME = @table AND c.TABLE_SCHEMA = @schema
       ORDER BY c.ORDINAL_POSITION`
    );
    const fkRes = await req().query(`${MSSQL_FK_SQL} AND tp.name = @table`);
    const fks = fkMap(fkRes.recordset as any[], schema);

    return result.recordset.map((r: any) => ({
      name: r.COLUMN_NAME,
      dataType: r.DATA_TYPE,
      nullable: r.IS_NULLABLE === "YES",
      isPrimaryKey: !!r.is_pk,
      isForeignKey: fks.has(`${tableName}.${r.COLUMN_NAME}`),
      references: fks.get(`${tableName}.${r.COLUMN_NAME}`),
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

async function getFullSchema(
  conn: ConnectionConfig,
  schema: string
): Promise<FullSchema> {
  if (conn.type === "postgres") return getPostgresFullSchema(conn, schema);
  if (conn.type === "mssql") return getMssqlFullSchema(conn, schema);
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
  opts: { forceRefresh?: boolean; schema?: string } = {}
): Promise<CachedFullSchema> {
  const ttlMs = getSchemaCacheTtlMs();
  const ttlHours = ttlMs / 3_600_000;
  const schemaName = resolveSchema(conn, opts.schema);
  // Cache per (connection, schema) so switching schemas doesn't collide.
  const key = `${conn.id}:${schemaName}`;
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
    pending = getFullSchema(conn, schemaName)
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

/**
 * Fresh cached schema, or undefined when the cache is cold — in which case the
 * introspection is kicked off in the background so the next caller has it. Lets
 * the query path label FK columns without ever paying introspection latency.
 */
export function peekCachedFullSchema(
  conn: ConnectionConfig,
  schema?: string
): FullSchema | undefined {
  const key = `${conn.id}:${resolveSchema(conn, schema)}`;
  const hit = schemaCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.schema;
  void getCachedFullSchema(conn, { schema }).catch(() => {});
  return undefined;
}

/**
 * Table names read by a query.
 *
 * The FROM/JOIN keywords are located in the *masked* script (literals and
 * comments blanked) so a "join" inside a string can't be mistaken for a real
 * one, but the name itself is read from the raw SQL at the same offset —
 * masking blanks char-for-char, and a double-quoted identifier looks like a
 * string literal to the scanner.
 */
function referencedTables(sql: string): string[] {
  const masked = scanSql(sql).masked;
  const names = new Set<string>();
  for (const m of masked.matchAll(/\b(?:from|join)\s+/gi)) {
    const ident = sql.slice(m.index + m[0].length).match(/^[A-Za-z0-9_."[\]]+/);
    // Keep the bare table name — the cache is already scoped to one schema.
    const bare = ident?.[0].replace(/["[\]]/g, "").split(".").pop();
    if (bare) names.add(bare.toLowerCase());
  }
  return [...names];
}

/**
 * FK targets for result column names, keyed by column name.
 *
 * Only unambiguous matches are returned: every table the query reads that has a
 * column of that name must agree on the same FK target, so a `JOIN` where both
 * sides carry an `id` never gets labelled with the wrong parent. Aliased select
 * items (`customer_id AS cid`) simply don't match and stay unlabelled. Empty
 * when the schema cache is cold.
 */
export function fkTargetsForColumns(
  conn: ConnectionConfig,
  sql: string,
  columnNames: string[],
  schema?: string
): Map<string, string> {
  const full = peekCachedFullSchema(conn, schema);
  return full ? matchFkTargets(full, sql, columnNames) : new Map();
}

/** Cache-free core of `fkTargetsForColumns` — see its doc comment for the rules. */
export function matchFkTargets(
  full: FullSchema,
  sql: string,
  columnNames: string[]
): Map<string, string> {
  const tables = new Set(referencedTables(sql));
  const byTable = Object.entries(full.columns).filter(([name]) =>
    tables.has(name.toLowerCase())
  );
  if (!byTable.length) return new Map();

  const out = new Map<string, string>();
  for (const wanted of columnNames) {
    const matches = byTable.flatMap(([, cols]) =>
      cols.filter((c) => c.name.toLowerCase() === wanted.toLowerCase())
    );
    const targets = new Set(matches.map((c) => c.references ?? ""));
    // One column, one agreed target, no plain-column namesake to confuse it.
    if (targets.size === 1) {
      const [target] = targets;
      if (target) out.set(wanted, target);
    }
  }
  return out;
}

/** Clears cached schemas. Pass a connectionId to clear all of its schemas. */
export function clearSchemaCache(connectionId?: string): { cleared: number } {
  if (!connectionId) {
    const n = schemaCache.size;
    schemaCache.clear();
    return { cleared: n };
  }
  // Cache keys are `${connectionId}:${schema}` — clear every schema for this conn.
  const prefix = `${connectionId}:`;
  let cleared = 0;
  for (const key of schemaCache.keys()) {
    if (key === connectionId || key.startsWith(prefix)) {
      if (schemaCache.delete(key)) cleared++;
    }
  }
  return { cleared };
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
    if (c.isForeignKey) flags.push(c.references ? `FK -> ${c.references}` : "FK");
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

async function getPostgresFullSchema(
  conn: ConnectionConfig,
  schema: string
): Promise<FullSchema> {
  const pool = new pg.Pool({
    host: conn.host,
    port: conn.port || 5432,
    database: conn.database,
    user: conn.username,
    password: conn.password,
    max: 2,
    connectionTimeoutMillis: 10000,
  });

  try {
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
      pool.query(PG_FK_SQL, [schema]),
    ]);

    const pkSet = new Set(pkRes.rows.map((r) => `${r.table_name}.${r.column_name}`));
    const fks = fkMap(fkRes.rows, schema);

    const columns: Record<string, ColumnInfo[]> = {};
    for (const r of colsRes.rows) {
      (columns[r.table_name] ||= []).push({
        name: r.column_name,
        dataType: r.data_type,
        nullable: r.is_nullable === "YES",
        isPrimaryKey: pkSet.has(`${r.table_name}.${r.column_name}`),
        isForeignKey: fks.has(`${r.table_name}.${r.column_name}`),
        references: fks.get(`${r.table_name}.${r.column_name}`),
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

async function getMssqlFullSchema(
  conn: ConnectionConfig,
  schema: string
): Promise<FullSchema> {
  const pool = new mssql.ConnectionPool({
    server: conn.host || "localhost",
    port: conn.port || 1433,
    database: conn.database,
    user: conn.username,
    password: conn.password,
    options: { encrypt: false, trustServerCertificate: true },
    connectionTimeout: 10000,
  });

  try {
    await pool.connect();
    const req = () => pool.request().input("schema", mssql.VarChar, schema);
    const tablesRes = await req().query(
      `SELECT TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = @schema ORDER BY TABLE_NAME`
    );
    const colsRes = await req().query(
      `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE, ORDINAL_POSITION
       FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @schema
       ORDER BY TABLE_NAME, ORDINAL_POSITION`
    );
    const pkRes = await req().query(
      `SELECT tc.TABLE_NAME, ku.COLUMN_NAME
       FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
       JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
       WHERE tc.TABLE_SCHEMA = @schema AND tc.CONSTRAINT_TYPE = 'PRIMARY KEY'`
    );
    const fkRes = await req().query(MSSQL_FK_SQL);

    const pkSet = new Set(pkRes.recordset.map((r: any) => `${r.TABLE_NAME}.${r.COLUMN_NAME}`));
    const fks = fkMap(fkRes.recordset as any[], schema);

    const columns: Record<string, ColumnInfo[]> = {};
    for (const r of colsRes.recordset as any[]) {
      (columns[r.TABLE_NAME] ||= []).push({
        name: r.COLUMN_NAME,
        dataType: r.DATA_TYPE,
        nullable: r.IS_NULLABLE === "YES",
        isPrimaryKey: pkSet.has(`${r.TABLE_NAME}.${r.COLUMN_NAME}`),
        isForeignKey: fks.has(`${r.TABLE_NAME}.${r.COLUMN_NAME}`),
        references: fks.get(`${r.TABLE_NAME}.${r.COLUMN_NAME}`),
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
