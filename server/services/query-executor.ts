import pg from "pg";
import mssql from "mssql";
import { MongoClient } from "mongodb";
import { Client as EsClient } from "@elastic/elasticsearch";
import type { ConnectionConfig } from "../types/index.js";

const MAX_ROWS = parseInt(process.env.MAX_ROWS || "10000", 10);
const QUERY_TIMEOUT = parseInt(process.env.QUERY_TIMEOUT_MS || "30000", 10);

// Connection pools
const pgPools = new Map<string, pg.Pool>();
const mssqlPools = new Map<string, mssql.ConnectionPool>();
const mongClients = new Map<string, MongoClient>();
const esClients = new Map<string, EsClient>();

// DML/DDL patterns that should be blocked
const BLOCKED_PATTERNS = [
  /^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|EXEC|EXECUTE)\b/i,
];

const DEFAULT_SELECT_STAR_LIMIT = 500;

export function validateQuery(sql: string): { valid: boolean; error?: string } {
  const trimmed = sql.trim();

  if (!trimmed) {
    return { valid: false, error: "Query cannot be empty" };
  }

  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(trimmed)) {
      const keyword = trimmed.match(/^\s*(\w+)/i)?.[1]?.toUpperCase();
      return {
        valid: false,
        error: `${keyword} statements are not allowed. This tool is read-only.`,
      };
    }
  }

  return { valid: true };
}

/**
 * Auto-injects LIMIT 500 for SELECT * queries that don't already have a LIMIT clause.
 */
export function applyDefaultLimit(sql: string): string {
  const trimmed = sql.trim().replace(/;\s*$/, "");

  // Only apply to SELECT statements
  if (!/^\s*SELECT\b/i.test(trimmed)) return trimmed;

  // Skip if already has LIMIT, TOP, or FETCH
  if (/\bLIMIT\s+\d/i.test(trimmed)) return trimmed;
  if (/\bTOP\s+\d/i.test(trimmed)) return trimmed;
  if (/\bFETCH\s+(FIRST|NEXT)\b/i.test(trimmed)) return trimmed;

  return `${trimmed} LIMIT ${DEFAULT_SELECT_STAR_LIMIT}`;
}

async function getPgPool(conn: ConnectionConfig): Promise<pg.Pool> {
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

async function getMssqlPool(conn: ConnectionConfig): Promise<mssql.ConnectionPool> {
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

async function getMongoClient(conn: ConnectionConfig): Promise<MongoClient> {
  const existing = mongClients.get(conn.id);
  if (existing) return existing;

  const uri = conn.uri || `mongodb://${conn.username}:${conn.password}@${conn.host}:${conn.port || 27017}/${conn.database}`;
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: QUERY_TIMEOUT,
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
  sql: string
): Promise<RawQueryResult> {
  const start = performance.now();

  // Auto-inject LIMIT for SELECT queries without one, and translate LIMIT→TOP for MSSQL
  let safeSql = conn.type === "mssql" ? convertLimitToTop(sql) : sql;
  safeSql = conn.type === "mssql" ? applyDefaultLimitMssql(safeSql) : applyDefaultLimit(safeSql);

  // Block MongoDB write operations before connecting
  if (conn.type === "mongodb") {
    const MONGO_WRITE_OPS = /\b(updateOne|updateMany|insertOne|insertMany|deleteOne|deleteMany|replaceOne|drop|rename|createIndex|dropIndex|forEach|bulkWrite|findOneAndUpdate|findOneAndDelete|findOneAndReplace|save|remove)\b/;
    const writeMatch = sql.match(MONGO_WRITE_OPS);
    if (writeMatch) {
      throw new Error(
        `'${writeMatch[1]}' is a write operation and is not allowed. This tool is read-only.`
      );
    }
  }

  switch (conn.type) {
    case "postgres":
      return executePostgres(conn, safeSql, start);
    case "mssql":
      return executeMssql(conn, safeSql, start);
    case "mongodb":
      return executeMongo(conn, sql, start);
    case "elasticsearch":
      return executeElasticsearch(conn, sql, start);
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
 * MSSQL variant: injects TOP 500 instead of LIMIT.
 */
function applyDefaultLimitMssql(sql: string): string {
  const trimmed = sql.trim().replace(/;\s*$/, "");

  if (!/^\s*SELECT\b/i.test(trimmed)) return trimmed;
  if (/\bTOP\s+\d/i.test(trimmed)) return trimmed;
  if (/\bLIMIT\s+\d/i.test(trimmed)) return trimmed;
  if (/\bFETCH\s+(FIRST|NEXT)\b/i.test(trimmed)) return trimmed;

  // Insert TOP after SELECT
  return trimmed.replace(/^(\s*SELECT)\b/i, `$1 TOP ${DEFAULT_SELECT_STAR_LIMIT}`);
}

async function executePostgres(
  conn: ConnectionConfig,
  sql: string,
  start: number
): Promise<RawQueryResult> {
  const pool = await getPgPool(conn);

  // Set search_path if schema specified
  let finalSql = sql;
  if (conn.schema) {
    finalSql = `SET search_path TO ${conn.schema}; ${sql}`;
  }

  const result = await pool.query(finalSql);
  const elapsed = performance.now() - start;

  // pg returns multiple results if we set search_path
  const queryResult = Array.isArray(result) ? result[result.length - 1] : result;
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
  start: number
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
  start: number
): Promise<RawQueryResult> {
  const client = await getMongoClient(conn);
  const dbName = conn.database || conn.uri?.split("/").pop()?.split("?")[0] || "test";
  const db = client.db(dbName);

  // Block write operations
  const MONGO_WRITE_OPS = /\b(updateOne|updateMany|insertOne|insertMany|deleteOne|deleteMany|replaceOne|drop|rename|createIndex|dropIndex|forEach|bulkWrite|findOneAndUpdate|findOneAndDelete|findOneAndReplace|save|remove)\b/;
  const writeMatch = sql.match(MONGO_WRITE_OPS);
  if (writeMatch) {
    throw new Error(
      `'${writeMatch[1]}' is a write operation and is not allowed. This tool is read-only.\n\n` +
      "Supported read operations:\n" +
      "  db.collection.find({...})\n" +
      "  db.collection.find({...}).limit(100).sort({field: -1})\n" +
      "  db.collection.aggregate([...])\n" +
      "  db.collection.countDocuments({...})\n" +
      "  db.collection.distinct(\"field\", {...})"
    );
  }

  // Parse MongoDB commands with optional chained .limit(), .sort(), .skip()
  // Uses a balanced-paren approach to extract the arguments
  const opMatch = sql.match(/(?:db\.)?(\w+)\.(find|aggregate|countDocuments|distinct|findOne)\(/s);
  let mongoMatch: RegExpMatchArray | null = null;

  if (opMatch) {
    const argsStart = (opMatch.index ?? 0) + opMatch[0].length;
    // Find the matching closing paren by counting depth
    let depth = 1;
    let i = argsStart;
    while (i < sql.length && depth > 0) {
      if (sql[i] === "(" || sql[i] === "{" || sql[i] === "[") depth++;
      else if (sql[i] === ")" || sql[i] === "}" || sql[i] === "]") depth--;
      i++;
    }
    const argsStr = sql.slice(argsStart, i - 1);
    const chainStr = sql.slice(i);
    mongoMatch = [sql, opMatch[1], opMatch[2], argsStr, chainStr] as unknown as RegExpMatchArray;
  }

  if (!mongoMatch) {
    throw new Error(
      "MongoDB queries must be in format:\n" +
      "  db.collection.find({...})\n" +
      "  db.collection.find({...}).limit(100)\n" +
      "  db.collection.find({...}).sort({field: -1}).limit(50)\n" +
      "  db.collection.aggregate([...])\n" +
      "  db.collection.countDocuments({...})\n" +
      "  db.collection.distinct(\"field\", {...})\n" +
      "  db.collection.findOne({...})"
    );
  }

  const [, collectionName, operation, argsStr, chainStr] = mongoMatch;
  const collection = db.collection(collectionName);

  let args: any;
  try {
    args = argsStr?.trim() ? JSON.parse(argsStr) : {};
  } catch {
    throw new Error(`Invalid JSON in query arguments: ${argsStr}`);
  }

  // Parse chained methods: .limit(N), .sort({...}), .skip(N)
  const limitMatch = chainStr?.match(/\.limit\((\d+)\)/);
  const sortMatch = chainStr?.match(/\.sort\(({[^)]+})\)/);
  const skipMatch = chainStr?.match(/\.skip\((\d+)\)/);

  const userLimit = limitMatch ? parseInt(limitMatch[1], 10) : null;
  const limit = Math.min(userLimit ?? DEFAULT_SELECT_STAR_LIMIT, MAX_ROWS);
  const sort = sortMatch ? JSON.parse(sortMatch[1]) : undefined;
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
    case "aggregate":
      rows = (await collection.aggregate(Array.isArray(args) ? args : [args]).toArray()) as Record<string, unknown>[];
      break;
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
      if (!distinctMatch) throw new Error("distinct requires a field name: db.collection.distinct(\"field\", {query})");
      const field = distinctMatch[1];
      const filter = distinctMatch[2]?.trim() ? JSON.parse(distinctMatch[2]) : {};
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

function getEsClient(conn: ConnectionConfig): EsClient {
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
  start: number
): Promise<RawQueryResult> {
  const client = getEsClient(conn);
  const trimmed = sql.trim();

  // Support multiple query formats:
  // 1. GET /index/_search { ... }    — raw ES query DSL
  // 2. index._search { ... }         — shorthand
  // 3. Plain JSON on an index        — auto-detect

  // Format: GET /index/_search { query JSON }
  const restMatch = trimmed.match(
    /^(?:GET|POST)?\s*\/?(\S+?)\/(_search|_count)\s*([\s\S]*)?$/i
  );

  if (restMatch) {
    const [, index, endpoint, bodyStr] = restMatch;
    const body = bodyStr?.trim() ? JSON.parse(bodyStr) : { query: { match_all: {} } };

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
    if (!body.size && body.size !== 0) body.size = 500;
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

    const totalHits = typeof result.hits.total === "number" ? result.hits.total : result.hits.total?.value ?? rows.length;

    return {
      columns,
      rows,
      totalRows: rows.length,
      executionTimeMs: Math.round(elapsed),
      truncated: rows.length < totalHits,
    };
  }

  // Format: just an index name — list first 500 docs
  if (/^[\w\-.*]+$/.test(trimmed)) {
    const result = await client.search({
      index: trimmed,
      size: 500,
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

    const totalHits2 = typeof result.hits.total === "number" ? result.hits.total : result.hits.total?.value ?? rows.length;

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
    "  GET /index/_search { \"query\": {...} }   — search with DSL\n" +
    "  GET /index/_count { \"query\": {...} }    — count docs"
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

export async function closeAllConnections(): Promise<void> {
  for (const pool of pgPools.values()) await pool.end();
  for (const pool of mssqlPools.values()) await pool.close();
  for (const client of mongClients.values()) await client.close();
  for (const client of esClients.values()) await client.close();
  pgPools.clear();
  mssqlPools.clear();
  mongClients.clear();
  esClients.clear();
}
