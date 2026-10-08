import pg from "pg";
import mssql from "mssql";
import { EJSON } from "bson";
import { MongoClient } from "mongodb";
import { Client as EsClient } from "@elastic/elasticsearch";
import type { ConnectionConfig } from "../types/index.js";
import { CONNECTION_ERROR_PATTERN } from "./connection-errors.js";
import { scanSql } from "./sql-scan.js";

const MAX_ROWS = parseInt(process.env.MAX_ROWS || "10000", 10);
export const QUERY_TIMEOUT = parseInt(
  process.env.QUERY_TIMEOUT_MS || "90000",
  10,
);

// Connection pools
const pgPools = new Map<string, pg.Pool>();
const mssqlPools = new Map<string, mssql.ConnectionPool>();
const mongClients = new Map<string, MongoClient>();
const esClients = new Map<string, EsClient>();

// Last time each connection's pool was handed out (i.e. last query/schema/test).
const poolLastUsed = new Map<string, number>();

function touchPool(id: string): void {
  poolLastUsed.set(id, Date.now());
}

// DML/DDL patterns that should be blocked
const BLOCKED_PATTERNS = [
  /^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|EXEC|EXECUTE)\b/i,
];

const DEFAULT_SELECT_STAR_LIMIT = 500;

const isIntString = (v: unknown, bits: bigint) =>
  typeof v === "string" &&
  /^-?\d{1,20}$/.test(v) &&
  BigInt(v) >= -(2n ** (bits - 1n)) &&
  BigInt(v) < 2n ** (bits - 1n);
const has = (v: any, ...keys: string[]) =>
  !!v &&
  typeof v === "object" &&
  Object.keys(v).sort().join() === [...keys].sort().join();
const uint32 = (n: unknown) =>
  Number.isInteger(n) && (n as number) >= 0 && (n as number) < 2 ** 32;
// Zone required whenever a time is given: a bare time would be read in the
// server's local zone.
const ISO_DATE =
  /^(\d{4})-(\d{2})-(\d{2})(?:T([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
function isIsoDate(v: unknown): boolean {
  const m = typeof v === "string" && v.match(ISO_DATE);
  if (!m) return false;
  // Date.parse rolls 2024-02-30 over to March 1st; the calendar must match.
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

const NUMBER_STRING = /^(-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?|-?Infinity|NaN)$/;

/** A decimal string as sign + significant digits + exponent, for exact comparison. */
function normDecimal(s: string): string {
  const m = s.match(/^(-?)(\d*)\.?(\d*)(?:[eE]([+-]?\d+))?$/);
  if (!m) return s; // Infinity / NaN
  const all = (m[2] + m[3]).replace(/^0+/, "");
  const digits = all.replace(/0+$/, "");
  if (!digits) return "0";
  const exp = Number(m[4] ?? 0) - m[3].length + all.length - digits.length;
  return `${m[1]}${digits}e${exp}`;
}

/**
 * Every Extended JSON type wrapper we accept, each with a strict check of its
 * value. bson's own parser coerces bad input instead of rejecting it —
 * `{"$numberLong": "12a"}` becomes 12, an out-of-range one wraps to another
 * number, `{"$date": 0}` or `{"$date": {...}}` becomes *now* — and any of those
 * in an approved write would silently hit, or write, something else.
 */
const EJSON_TYPES: Record<string, (v: any) => boolean> = {
  $oid: (v) => typeof v === "string" && /^[0-9a-fA-F]{24}$/.test(v),
  $numberInt: (v) => isIntString(v, 32n),
  $numberLong: (v) => isIntString(v, 64n),
  $numberDouble: (v) => typeof v === "string" && NUMBER_STRING.test(v),
  // Format only: out-of-precision/range values are caught after conversion.
  $numberDecimal: (v) => typeof v === "string" && NUMBER_STRING.test(v),
  $date: (v) =>
    isIsoDate(v) || (has(v, "$numberLong") && isIntString(v.$numberLong, 64n)),
  $binary: (v) =>
    has(v, "base64", "subType") &&
    typeof v.base64 === "string" &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      v.base64,
    ) &&
    typeof v.subType === "string" &&
    /^[0-9a-fA-F]{1,2}$/.test(v.subType),
  $uuid: (v) => typeof v === "string", // bson throws on a malformed UUID
  $timestamp: (v) => has(v, "t", "i") && uint32(v.t) && uint32(v.i),
  $regularExpression: (v) =>
    has(v, "pattern", "options") &&
    typeof v.pattern === "string" &&
    /^[imxslu]*$/.test(v.options),
  $minKey: (v) => v === 1,
  $maxKey: (v) => v === 1,
};
// Legacy/JS-code wrappers: nothing a filter or write needs.
const EJSON_REFUSED = [
  "$code",
  "$scope",
  "$symbol",
  "$dbPointer",
  "$undefined",
];

function reviveMongoJson(v: any): any {
  if (Array.isArray(v)) return v.map(reviveMongoJson);
  if (!v || typeof v !== "object") return v;
  const keys = Object.keys(v);
  const typeKey = keys.find(
    (k) => Object.hasOwn(EJSON_TYPES, k) || EJSON_REFUSED.includes(k),
  );
  if (!typeKey) {
    for (const k of keys) v[k] = reviveMongoJson(v[k]);
    return v;
  }
  // bson converts the whole object on its first type key and drops the rest,
  // so {"$regex": ..., "$nin": [...]} lost its $nin and widened the filter.
  // ($regex/$options are left alone: the server reads them as the operator.)
  if (keys.length !== 1)
    throw new Error(`${typeKey} cannot be combined with other keys`);
  if (!EJSON_TYPES[typeKey]?.(v[typeKey]))
    throw new Error(`Invalid ${typeKey} value: ${JSON.stringify(v[typeKey])}`);
  const out = EJSON.deserialize(v, { relaxed: false });
  if (out instanceof Date && Number.isNaN(out.getTime()))
    throw new Error(`$date out of range: ${JSON.stringify(v.$date)}`);
  // Decimal128 silently rounds past 34 digits and clamps the exponent.
  if (
    typeKey === "$numberDecimal" &&
    normDecimal(String(out)) !== normDecimal(v.$numberDecimal)
  )
    throw new Error(
      `$numberDecimal ${v.$numberDecimal} does not fit Decimal128 exactly`,
    );
  return out;
}

/**
 * Parses a MongoDB query/write argument as Extended JSON, so a filter can name
 * the BSON types plain JSON cannot — `{"$oid": ...}`, `{"$binary": ...}`,
 * `{"$date": ...}`. Without it no document is reachable by a non-string `_id`.
 *
 * Plain JSON parses exactly as `JSON.parse` does (numbers stay JS numbers, so
 * a field keeps the type the app writes); only the wrappers above become BSON
 * types, each validated strictly, so what a reviewer approves is what runs.
 */
export function parseMongoJson(text: string): any {
  // JSON.parse has already rounded a long integer by the time we see it, so
  // check the source text. Exponent/decimal literals are intended doubles.
  for (const [tok] of text.matchAll(/"(?:[^"\\]|\\.)*"|-?\d+(?![\d.eE])/g))
    if (tok[0] !== '"' && !Number.isSafeInteger(Number(tok)))
      throw new Error(
        `${tok} is past 2^53 and would be rounded — write it as {"$numberLong": "..."}`,
      );
  return reviveMongoJson(JSON.parse(text));
}

// Schema identifiers are interpolated into `SET search_path` (Postgres has no
// bind parameter for it), so they must be validated before use. Accept only
// ordinary unquoted identifiers; anything else (quotes, semicolons, dots) is
// rejected rather than executed.
const SAFE_SCHEMA_IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/**
 * Validates a schema name and returns it double-quoted for safe interpolation.
 * Throws if the name isn't a plain identifier.
 */
export function quoteSchemaIdent(schema: string): string {
  if (!SAFE_SCHEMA_IDENT.test(schema)) {
    throw new Error(`Invalid schema name: ${schema}`);
  }
  return `"${schema}"`;
}

/** The active schema for a request: explicit override, else the connection default. */
function activeSchema(
  conn: ConnectionConfig,
  schema?: string,
): string | undefined {
  const s = (schema ?? conn.schema ?? "").trim();
  return s || undefined;
}

export function validateQuery(sql: string): { valid: boolean; error?: string } {
  const trimmed = sql.trim();

  if (!trimmed) {
    return { valid: false, error: "Query cannot be empty" };
  }

  // Stacked statements must be rejected before the keyword check below, which
  // only looks at the *first* statement: `pg` and `mssql` both execute an entire
  // multi-statement string in one call, so `SELECT 1 LIMIT 1; DROP TABLE t`
  // would otherwise sail past a read-only guard. Scanning (rather than splitting
  // on ";") keeps semicolons inside string literals, comments and dollar-quoted
  // bodies from counting.
  const { statementCount, masked } = scanSql(trimmed);
  if (statementCount > 1) {
    return {
      valid: false,
      error:
        "Only one statement can be run at a time. Remove the extra statements after the ';'.",
    };
  }

  for (const pattern of BLOCKED_PATTERNS) {
    // Match against the masked script so a keyword sitting inside a string
    // literal ('%DELETE%') isn't mistaken for the statement's verb.
    if (pattern.test(masked)) {
      const keyword = masked.match(/^\s*(\w+)/i)?.[1]?.toUpperCase();
      return {
        valid: false,
        error: `${keyword} statements are not allowed. This tool is read-only.`,
      };
    }
  }

  return { valid: true };
}

/** True if `sql` is a positively-shaped read query for the given engine. */
export function isReadQuery(
  sql: string,
  dbType: ConnectionConfig["type"],
): boolean {
  const t = sql.trim();
  if (!t) return false;
  if (dbType === "postgres" || dbType === "mssql")
    return /^\s*(SELECT|WITH)\b/i.test(t);
  if (dbType === "mongodb")
    return /\.(find|findOne|aggregate|countDocuments|distinct)\s*\(/.test(t);
  if (dbType === "elasticsearch")
    return /_search|_count/i.test(t) || /^[\w\-.*]+$/.test(t);
  return true;
}

/**
 * Best-effort syntax/schema validation without executing the statement. Uses
 * PostgreSQL `EXPLAIN` (plans, never runs — safe for writes too) and SQL Server
 * `SET PARSEONLY`. Returns { checked:false } when the engine isn't supported or
 * the database is unreachable, so validation never blocks on connectivity.
 */
export async function validateSqlSyntax(
  conn: ConnectionConfig,
  sql: string,
  schema?: string,
): Promise<{ checked: boolean; error?: string }> {
  const stmt = sql.trim().replace(/;\s*$/, "");
  if (!stmt) return { checked: true, error: "Query cannot be empty" };
  try {
    if (conn.type === "postgres") {
      const pool = await getPgPool(conn);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const schemaName = activeSchema(conn, schema);
        if (schemaName)
          await client.query(
            `SET search_path TO ${quoteSchemaIdent(schemaName)}`,
          );
        await client.query(`EXPLAIN ${stmt}`);
        return { checked: true };
      } finally {
        try {
          await client.query("ROLLBACK");
        } catch {
          /* ignore */
        }
        client.release();
      }
    }
    if (conn.type === "mssql") {
      const pool = await getMssqlPool(conn);
      // PARSEONLY validates syntax without executing or binding objects.
      await pool
        .request()
        .batch(`SET PARSEONLY ON;\n${stmt}\n;SET PARSEONLY OFF;`);
      return { checked: true };
    }
    // Mongo/ES: parsed at execution time; only structural validation applies.
    return { checked: false };
  } catch (err: any) {
    const msg = String(err?.message || err);
    if (CONNECTION_ERROR_PATTERN.test(msg)) return { checked: false };
    return { checked: true, error: msg };
  }
}

/**
 * Auto-injects LIMIT for SELECT queries that don't already have a LIMIT clause.
 * @param defaultLimit null = skip injection, undefined = use DEFAULT_SELECT_STAR_LIMIT, number = use that value
 */
export function applyDefaultLimit(
  sql: string,
  defaultLimit?: number | null,
): string {
  const trimmed = sql.trim().replace(/;\s*$/, "");

  // Only apply to SELECT statements
  if (!/^\s*SELECT\b/i.test(trimmed)) return trimmed;

  // Skip if already has LIMIT, TOP, or FETCH
  if (/\bLIMIT\s+\d/i.test(trimmed)) return trimmed;
  if (/\bTOP\s+\d/i.test(trimmed)) return trimmed;
  if (/\bFETCH\s+(FIRST|NEXT)\b/i.test(trimmed)) return trimmed;

  // null = user explicitly disabled auto-limit
  if (defaultLimit === null) return trimmed;

  const limit = Math.min(defaultLimit ?? DEFAULT_SELECT_STAR_LIMIT, MAX_ROWS);
  return `${trimmed} LIMIT ${limit}`;
}

export async function getPgPool(conn: ConnectionConfig): Promise<pg.Pool> {
  touchPool(conn.id);
  const existing = pgPools.get(conn.id);
  if (existing) return existing;

  const pool = new pg.Pool({
    host: conn.host,
    port: conn.port || 5432,
    database: conn.database,
    user: conn.username,
    password: conn.password,
    max: 5,
    idleTimeoutMillis: 60000,
    connectionTimeoutMillis: 10000,
    statement_timeout: QUERY_TIMEOUT,
  });

  pgPools.set(conn.id, pool);
  return pool;
}

export async function getMssqlPool(
  conn: ConnectionConfig,
): Promise<mssql.ConnectionPool> {
  touchPool(conn.id);
  const existing = mssqlPools.get(conn.id);
  if (existing?.connected) return existing;

  const pool = new mssql.ConnectionPool({
    server: conn.host || "localhost",
    port: conn.port || 1433,
    database: conn.database,
    user: conn.username,
    password: conn.password,
    options: {
      encrypt: false,
      trustServerCertificate: true,
    },
    requestTimeout: QUERY_TIMEOUT,
    connectionTimeout: 10000,
    pool: { max: 5, min: 0, idleTimeoutMillis: 60000 },
  });

  await pool.connect();
  mssqlPools.set(conn.id, pool);
  return pool;
}

export async function getMongoClient(
  conn: ConnectionConfig,
): Promise<MongoClient> {
  touchPool(conn.id);
  const existing = mongClients.get(conn.id);
  if (existing) return existing;

  const uri =
    conn.uri ||
    `mongodb://${conn.username}:${conn.password}@${conn.host}:${conn.port || 27017}/${conn.database}`;
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: QUERY_TIMEOUT,
    // Match the pg/mssql pools: small cap, drop idle sockets. Without these the
    // driver defaults to maxPoolSize 100 and holds sockets indefinitely.
    maxPoolSize: 5,
    minPoolSize: 0,
    maxIdleTimeMS: 60000,
  });

  await client.connect();
  mongClients.set(conn.id, client);
  return client;
}

export interface RawQueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  totalRows: number;
  executionTimeMs: number;
  truncated: boolean;
}

export async function executeQuery(
  conn: ConnectionConfig,
  sql: string,
  defaultLimit?: number | null,
  schema?: string,
): Promise<RawQueryResult> {
  const start = performance.now();

  // Auto-inject LIMIT for SELECT queries without one, and translate LIMIT→TOP for MSSQL
  let safeSql = conn.type === "mssql" ? convertLimitToTop(sql) : sql;
  safeSql =
    conn.type === "mssql"
      ? applyDefaultLimitMssql(safeSql, defaultLimit)
      : applyDefaultLimit(safeSql, defaultLimit);

  switch (conn.type) {
    case "postgres":
      return executePostgres(conn, safeSql, start, schema);
    case "mssql":
      return executeMssql(conn, safeSql, start);
    case "mongodb":
      return executeMongo(conn, sql, start, defaultLimit);
    case "elasticsearch":
      return executeElasticsearch(conn, sql, start, defaultLimit);
    default:
      throw new Error(`Unsupported database type: ${conn.type}`);
  }
}

/**
 * Converts PostgreSQL-style LIMIT N to SQL Server TOP N.
 * Handles: SELECT ... LIMIT 100  →  SELECT TOP 100 ...
 */
function convertLimitToTop(sql: string): string {
  const trimmed = sql.trim().replace(/;\s*$/, "");

  // Only for SELECT statements that have LIMIT but no TOP
  if (!/^\s*SELECT\b/i.test(trimmed)) return trimmed;
  if (/\bTOP\s+\d/i.test(trimmed)) return trimmed;

  const limitMatch = trimmed.match(/\bLIMIT\s+(\d+)\s*$/i);
  if (!limitMatch) return trimmed;

  const limitVal = limitMatch[1];
  // Remove LIMIT clause from end and inject TOP after SELECT
  const withoutLimit = trimmed.replace(/\s+LIMIT\s+\d+\s*$/i, "");
  return withoutLimit.replace(/^(\s*SELECT)\b/i, `$1 TOP ${limitVal}`);
}

/**
 * MSSQL variant: injects TOP N instead of LIMIT.
 * @param defaultLimit null = skip injection, undefined = use DEFAULT_SELECT_STAR_LIMIT, number = use that value
 */
export function applyDefaultLimitMssql(
  sql: string,
  defaultLimit?: number | null,
): string {
  const trimmed = sql.trim().replace(/;\s*$/, "");

  if (!/^\s*SELECT\b/i.test(trimmed)) return trimmed;
  if (/\bTOP\s+\d/i.test(trimmed)) return trimmed;
  if (/\bLIMIT\s+\d/i.test(trimmed)) return trimmed;
  if (/\bFETCH\s+(FIRST|NEXT)\b/i.test(trimmed)) return trimmed;

  // null = user explicitly disabled auto-limit
  if (defaultLimit === null) return trimmed;

  const limit = Math.min(defaultLimit ?? DEFAULT_SELECT_STAR_LIMIT, MAX_ROWS);
  // Insert TOP after SELECT
  return trimmed.replace(/^(\s*SELECT)\b/i, `$1 TOP ${limit}`);
}

async function executePostgres(
  conn: ConnectionConfig,
  sql: string,
  start: number,
  schema?: string,
): Promise<RawQueryResult> {
  const pool = await getPgPool(conn);

  // Set search_path to the active schema (validated + quoted) when present.
  let finalSql = sql;
  const schemaName = activeSchema(conn, schema);
  if (schemaName) {
    finalSql = `SET search_path TO ${quoteSchemaIdent(schemaName)}; ${sql}`;
  }

  const result = await pool.query(finalSql);
  const elapsed = performance.now() - start;

  // pg returns multiple results if we set search_path
  const queryResult = Array.isArray(result)
    ? result[result.length - 1]
    : result;
  const rows = queryResult.rows || [];
  const columns = queryResult.fields?.map((f: any) => f.name) || [];
  const truncated = rows.length >= MAX_ROWS;

  return {
    columns,
    rows: rows.slice(0, MAX_ROWS),
    totalRows: rows.length,
    executionTimeMs: Math.round(elapsed),
    truncated,
  };
}

async function executeMssql(
  conn: ConnectionConfig,
  sql: string,
  start: number,
): Promise<RawQueryResult> {
  const pool = await getMssqlPool(conn);
  const result = await pool.request().query(sql);
  const elapsed = performance.now() - start;

  const rows = result.recordset || [];
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  const truncated = rows.length >= MAX_ROWS;

  return {
    columns,
    rows: rows.slice(0, MAX_ROWS),
    totalRows: rows.length,
    executionTimeMs: Math.round(elapsed),
    truncated,
  };
}

async function executeMongo(
  conn: ConnectionConfig,
  sql: string,
  start: number,
  defaultLimit?: number | null,
): Promise<RawQueryResult> {
  // Block write operations before connecting
  const MONGO_WRITE_OPS =
    /\b(updateOne|updateMany|insertOne|insertMany|deleteOne|deleteMany|replaceOne|drop|rename|createIndex|dropIndex|forEach|bulkWrite|findOneAndUpdate|findOneAndDelete|findOneAndReplace|save|remove)\b/;
  // String literals are blanked first so a value like "save" or "remove" in a
  // filter is not mistaken for the operation.
  const writeMatch = sql
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .match(MONGO_WRITE_OPS);
  if (writeMatch) {
    throw new Error(
      `'${writeMatch[1]}' is a write operation and is not allowed. This tool is read-only.\n\n` +
        "Supported read operations:\n" +
        "  db.collection.find({...})\n" +
        "  db.collection.find({...}).limit(100).sort({field: -1})\n" +
        "  db.collection.aggregate([...])\n" +
        "  db.collection.countDocuments({...})\n" +
        '  db.collection.distinct("field", {...})',
    );
  }

  const client = await getMongoClient(conn);
  const dbName =
    conn.database || conn.uri?.split("/").pop()?.split("?")[0] || "test";
  const db = client.db(dbName);

  // Parse MongoDB commands with optional chained .limit(), .sort(), .skip()
  // Uses a balanced-paren approach to extract the arguments
  const opMatch = sql.match(
    /(?:db\.)?(\w+)\.(find|aggregate|countDocuments|distinct|findOne)\(/s,
  );
  let mongoMatch: RegExpMatchArray | null = null;

  if (opMatch) {
    const argsStart = (opMatch.index ?? 0) + opMatch[0].length;
    // Find the matching closing paren by counting depth. Brackets inside a
    // string are data — `{"note": "smile :)"}` must not end the arguments.
    let depth = 1;
    let i = argsStart;
    let inString = false;
    while (i < sql.length && depth > 0) {
      const ch = sql[i];
      if (inString) {
        if (ch === "\\") i++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === "(" || ch === "{" || ch === "[") depth++;
      else if (ch === ")" || ch === "}" || ch === "]") depth--;
      i++;
    }
    const argsStr = sql.slice(argsStart, i - 1);
    const chainStr = sql.slice(i);
    mongoMatch = [
      sql,
      opMatch[1],
      opMatch[2],
      argsStr,
      chainStr,
    ] as unknown as RegExpMatchArray;
  }

  if (!mongoMatch) {
    throw new Error(
      "MongoDB queries must be in format:\n" +
        "  db.collection.find({...})\n" +
        "  db.collection.find({...}).limit(100)\n" +
        "  db.collection.find({...}).sort({field: -1}).limit(50)\n" +
        "  db.collection.aggregate([...])\n" +
        "  db.collection.countDocuments({...})\n" +
        '  db.collection.distinct("field", {...})\n' +
        "  db.collection.findOne({...})",
    );
  }

  const [, collectionName, operation, argsStr, chainStr] = mongoMatch;
  const collection = db.collection(collectionName);

  let args: any;
  try {
    args = argsStr?.trim() ? parseMongoJson(argsStr) : {};
  } catch (err: any) {
    throw new Error(`Invalid query arguments (${err.message}): ${argsStr}`);
  }

  // Parse chained methods: .limit(N), .sort({...}), .skip(N)
  const limitMatch = chainStr?.match(/\.limit\((\d+)\)/);
  const sortMatch = chainStr?.match(/\.sort\(({[^)]+})\)/);
  const skipMatch = chainStr?.match(/\.skip\((\d+)\)/);

  const userLimit = limitMatch ? parseInt(limitMatch[1], 10) : null;
  const effectiveDefault =
    defaultLimit === null
      ? MAX_ROWS
      : (defaultLimit ?? DEFAULT_SELECT_STAR_LIMIT);
  const limit = Math.min(userLimit ?? effectiveDefault, MAX_ROWS);
  const sort = sortMatch ? parseMongoJson(sortMatch[1]) : undefined;
  const skip = skipMatch ? parseInt(skipMatch[1], 10) : undefined;

  let rows: Record<string, unknown>[];

  switch (operation) {
    case "find": {
      let cursor = collection.find(args);
      if (sort) cursor = cursor.sort(sort);
      if (skip) cursor = cursor.skip(skip);
      rows = (await cursor.limit(limit).toArray()) as Record<string, unknown>[];
      break;
    }
    case "aggregate": {
      const pipeline = Array.isArray(args) ? args : [args];
      // $out and $merge write the pipeline's output into a collection — the one
      // way a "read" can mutate. Checked on the parsed stages, i.e. exactly what
      // is sent, so a write request's verify preview can never change data.
      if (pipeline.some((s) => s && ("$out" in s || "$merge" in s)))
        throw new Error(
          "$out and $merge write to a collection and are not allowed. This tool is read-only.",
        );
      rows = (await collection.aggregate(pipeline).toArray()) as Record<
        string,
        unknown
      >[];
      break;
    }
    case "countDocuments":
      rows = [{ count: await collection.countDocuments(args) }];
      break;
    case "findOne": {
      const doc = await collection.findOne(args);
      rows = doc ? [doc as Record<string, unknown>] : [];
      break;
    }
    case "distinct": {
      // distinct("field", query) — argsStr contains both field and query
      const distinctMatch = argsStr.match(/^"([^"]+)"(?:\s*,\s*([\s\S]+))?$/);
      if (!distinctMatch)
        throw new Error(
          'distinct requires a field name: db.collection.distinct("field", {query})',
        );
      const field = distinctMatch[1];
      const filter = distinctMatch[2]?.trim()
        ? parseMongoJson(distinctMatch[2])
        : {};
      const values = await collection.distinct(field, filter);
      rows = values.map((v: any) => ({ [field]: v }));
      break;
    }
    default:
      throw new Error(`Unsupported MongoDB operation: ${operation}`);
  }

  const elapsed = performance.now() - start;
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  const truncated = rows.length >= limit;

  return {
    columns,
    rows: rows.slice(0, MAX_ROWS),
    totalRows: rows.length,
    executionTimeMs: Math.round(elapsed),
    truncated,
  };
}

// --- Elasticsearch ---

export function getEsClient(conn: ConnectionConfig): EsClient {
  touchPool(conn.id);
  const existing = esClients.get(conn.id);
  if (existing) return existing;

  const protocol = conn.schema || "http"; // reuse schema field for protocol
  const node = conn.uri || `${protocol}://${conn.host}:${conn.port || 9200}`;

  const client = new EsClient({
    node,
    auth:
      conn.username && conn.password
        ? { username: conn.username, password: conn.password }
        : undefined,
    tls: { rejectUnauthorized: false },
    requestTimeout: QUERY_TIMEOUT,
  });

  esClients.set(conn.id, client);
  return client;
}

async function executeElasticsearch(
  conn: ConnectionConfig,
  sql: string,
  start: number,
  defaultLimit?: number | null,
): Promise<RawQueryResult> {
  const client = getEsClient(conn);
  const trimmed = sql.trim();

  // Support multiple query formats:
  // 1. GET /index/_search { ... }    — raw ES query DSL
  // 2. index._search { ... }         — shorthand
  // 3. Plain JSON on an index        — auto-detect

  // Format: GET /index/_search { query JSON }
  const restMatch = trimmed.match(
    /^(?:GET|POST)?\s*\/?(\S+?)\/(_search|_count)\s*([\s\S]*)?$/i,
  );

  if (restMatch) {
    const [, index, endpoint, bodyStr] = restMatch;
    const body = bodyStr?.trim()
      ? JSON.parse(bodyStr)
      : { query: { match_all: {} } };

    if (endpoint === "_count") {
      const result = await client.count({ index, ...body });
      const elapsed = performance.now() - start;
      return {
        columns: ["count"],
        rows: [{ count: result.count }],
        totalRows: 1,
        executionTimeMs: Math.round(elapsed),
        truncated: false,
      };
    }

    // _search
    if (!body.size && body.size !== 0) {
      const esLimit =
        defaultLimit === null
          ? MAX_ROWS
          : (defaultLimit ?? DEFAULT_SELECT_STAR_LIMIT);
      body.size = Math.min(esLimit, MAX_ROWS);
    }
    const result = await client.search({ index, ...body });
    const elapsed = performance.now() - start;
    const hits = result.hits.hits || [];

    const rows: Record<string, unknown>[] = hits.map((hit: any) => ({
      _id: hit._id,
      _index: hit._index,
      _score: hit._score,
      ...hit._source,
    }));

    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

    const totalHits =
      typeof result.hits.total === "number"
        ? result.hits.total
        : (result.hits.total?.value ?? rows.length);

    return {
      columns,
      rows,
      totalRows: rows.length,
      executionTimeMs: Math.round(elapsed),
      truncated: rows.length < totalHits,
    };
  }

  // Format: just an index name — list first N docs
  if (/^[\w\-.*]+$/.test(trimmed)) {
    const esLimit =
      defaultLimit === null
        ? MAX_ROWS
        : (defaultLimit ?? DEFAULT_SELECT_STAR_LIMIT);
    const result = await client.search({
      index: trimmed,
      size: Math.min(esLimit, MAX_ROWS),
      query: { match_all: {} },
    });
    const elapsed = performance.now() - start;
    const hits = result.hits.hits || [];
    const rows: Record<string, unknown>[] = hits.map((hit: any) => ({
      _id: hit._id,
      _score: hit._score,
      ...hit._source,
    }));
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

    const totalHits2 =
      typeof result.hits.total === "number"
        ? result.hits.total
        : (result.hits.total?.value ?? rows.length);

    return {
      columns,
      rows,
      totalRows: rows.length,
      executionTimeMs: Math.round(elapsed),
      truncated: rows.length < totalHits2,
    };
  }

  throw new Error(
    "Elasticsearch queries must be in format:\n" +
      "  index_name                              — list docs\n" +
      '  GET /index/_search { "query": {...} }   — search with DSL\n' +
      '  GET /index/_count { "query": {...} }    — count docs',
  );
}

export async function testConnection(conn: ConnectionConfig): Promise<boolean> {
  try {
    switch (conn.type) {
      case "postgres": {
        const pool = await getPgPool(conn);
        await pool.query("SELECT 1");
        return true;
      }
      case "mssql": {
        const pool = await getMssqlPool(conn);
        await pool.request().query("SELECT 1");
        return true;
      }
      case "mongodb": {
        const client = await getMongoClient(conn);
        await client.db().admin().ping();
        return true;
      }
      case "elasticsearch": {
        const client = getEsClient(conn);
        await client.ping();
        return true;
      }
      default:
        return false;
    }
  } catch {
    return false;
  }
}

export interface PoolStatus {
  live: boolean;
  /** Open sockets, where the driver exposes it (pg/mssql). */
  totalSockets?: number;
  idleSockets?: number;
  lastUsedAt?: string; // ISO
}

/** Live-pool status for a connection ID — no I/O, just reads pool state. */
export function getPoolStatus(id: string): PoolStatus {
  const lastUsed = poolLastUsed.get(id);
  const lastUsedAt = lastUsed ? new Date(lastUsed).toISOString() : undefined;

  const pgPool = pgPools.get(id);
  if (pgPool) {
    return {
      live: true,
      totalSockets: pgPool.totalCount,
      idleSockets: pgPool.idleCount,
      lastUsedAt,
    };
  }
  const msPool = mssqlPools.get(id);
  if (msPool) {
    return {
      live: true,
      totalSockets: msPool.size,
      idleSockets: msPool.available,
      lastUsedAt,
    };
  }
  if (mongClients.has(id) || esClients.has(id))
    return { live: true, lastUsedAt };
  return { live: false, lastUsedAt };
}

/** Closes and evicts the pool for one connection; it reconnects lazily on next use. */
export async function closeConnectionPool(id: string): Promise<boolean> {
  let closed = false;
  const pgPool = pgPools.get(id);
  if (pgPool) {
    pgPools.delete(id);
    await pgPool.end();
    closed = true;
  }
  const msPool = mssqlPools.get(id);
  if (msPool) {
    mssqlPools.delete(id);
    await msPool.close();
    closed = true;
  }
  const mongo = mongClients.get(id);
  if (mongo) {
    mongClients.delete(id);
    await mongo.close();
    closed = true;
  }
  const es = esClients.get(id);
  if (es) {
    esClients.delete(id);
    await es.close();
    closed = true;
  }
  poolLastUsed.delete(id);
  return closed;
}

export async function closeAllConnections(): Promise<void> {
  for (const pool of pgPools.values()) await pool.end();
  for (const pool of mssqlPools.values()) await pool.close();
  for (const client of mongClients.values()) await client.close();
  for (const client of esClients.values()) await client.close();
  pgPools.clear();
  mssqlPools.clear();
  mongClients.clear();
  esClients.clear();
  poolLastUsed.clear();
}
