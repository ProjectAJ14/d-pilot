// Write executor — the ONLY code path allowed to mutate a target database.
//
// This is deliberately separate from query-executor.ts (which stays strictly
// read-only). Every write is validated to be a single DML statement, executed
// transactionally where the engine supports it, and returns the number of rows
// affected. Connection pools/clients are reused from query-executor.
import mssql from "mssql";
import type { ClientSession } from "mongodb";
import {
  getPgPool,
  getMssqlPool,
  getMongoClient,
  getEsClient,
} from "./query-executor.js";
import { scanSql } from "./sql-scan.js";
import type { ConnectionConfig, DatabaseType } from "../types/index.js";

// DML verbs permitted for SQL engines. DDL and everything else is blocked.
const SQL_WRITE_VERBS = ["INSERT", "UPDATE", "DELETE"];
const SQL_BLOCKED =
  /\b(DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|EXEC|EXECUTE|MERGE|CALL|ATTACH|DETACH|PRAGMA|VACUUM|COPY|BACKUP|RESTORE|SHUTDOWN|USE)\b/i;

const MONGO_WRITE_VERBS = [
  "updateOne",
  "updateMany",
  "insertOne",
  "insertMany",
  "deleteOne",
  "deleteMany",
  "replaceOne",
];
const MONGO_BLOCKED =
  /\b(drop|dropIndex|dropIndexes|dropDatabase|renameCollection|createIndex|bulkWrite|remove|save|findAndModify|mapReduce)\b/;

export interface WriteValidation {
  valid: boolean;
  error?: string;
  verb?: string;
  /** true when the statement scopes its effect (has a WHERE / filter). */
  scoped?: boolean;
}

export interface WriteResult {
  rowsAffected: number;
  executionMs: number;
  /** whether the write ran inside a real transaction (false for ES / non-RS Mongo). */
  transactional: boolean;
}

/**
 * Validates that `sql` is exactly one permitted write statement for `dbType`.
 * Rejects DDL, multi-statement/stacked queries, and read-executor bypasses.
 */
export function validateWriteQuery(
  sql: string,
  dbType: DatabaseType,
): WriteValidation {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (!trimmed) return { valid: false, error: "Write query cannot be empty" };

  if (dbType === "postgres" || dbType === "mssql") {
    // Block stacked statements — reject any interior semicolon.
    if (/;/.test(trimmed)) {
      return {
        valid: false,
        error:
          "Multiple statements are not allowed. Submit exactly one write statement.",
      };
    }
    const first = trimmed.match(/^\s*(\w+)/)?.[1]?.toUpperCase();
    if (!first || !SQL_WRITE_VERBS.includes(first)) {
      return {
        valid: false,
        error: `Only INSERT, UPDATE and DELETE are allowed. Found "${first ?? "?"}".`,
      };
    }
    if (SQL_BLOCKED.test(trimmed)) {
      return {
        valid: false,
        error: "DDL and administrative statements are not allowed.",
      };
    }
    const scoped = first === "INSERT" ? true : /\bWHERE\b/i.test(trimmed);
    return { valid: true, verb: first, scoped };
  }

  if (dbType === "mongodb") {
    if (MONGO_BLOCKED.test(trimmed)) {
      return {
        valid: false,
        error: "That MongoDB operation is not permitted for writes.",
      };
    }
    const m = trimmed.match(/^(?:db\.)?(\w+)\.(\w+)\s*\(/s);
    if (!m) {
      return {
        valid: false,
        error:
          "MongoDB writes must be db.collection.updateOne/updateMany/insertOne/insertMany/deleteOne/deleteMany/replaceOne(...)",
      };
    }
    const verb = m[2];
    if (!MONGO_WRITE_VERBS.includes(verb)) {
      return {
        valid: false,
        error: `"${verb}" is not a permitted MongoDB write operation.`,
      };
    }
    return {
      valid: true,
      verb,
      scoped:
        /updateOne|deleteOne|replaceOne/.test(verb) ||
        /\{[\s\S]*\}/.test(trimmed),
    };
  }

  if (dbType === "elasticsearch") {
    const m = trimmed.match(/^(POST|PUT|DELETE)\s+\/?(\S+)/i);
    if (!m) {
      return {
        valid: false,
        error:
          "Elasticsearch writes must be POST/PUT/DELETE against an index endpoint.",
      };
    }
    const path = m[2];
    const allowed =
      /(_update_by_query|_delete_by_query|_doc(\/|$)|_create\/|_update\/)/i.test(
        path,
      );
    if (!allowed) {
      return {
        valid: false,
        error:
          "Only _doc, _create/{id}, _update/{id}, _update_by_query and _delete_by_query writes are allowed.",
      };
    }
    return { valid: true, verb: m[1].toUpperCase(), scoped: true };
  }

  return { valid: false, error: `Unsupported database type: ${dbType}` };
}

// ── Migration mode (multi-statement scripts, incl. DDL) ──
//
// A migration is a whole script — many statements, DDL allowed — run as ONE
// transaction so a mid-script failure rolls the entire thing back (PostgreSQL
// and SQL Server DDL is transactional). We never split it: the driver hands the
// full text to the engine, which is the authoritative SQL parser.
//
// The narrow denylist blocks only what would break that model or is
// catastrophic; ordinary DDL (CREATE/ALTER/RENAME/DROP TABLE|COLUMN|INDEX) is
// allowed — the AI review flags the risky ones. Statements that CANNOT run in a
// transaction (CREATE INDEX CONCURRENTLY, VACUUM, …) are rejected unless the
// author opts into the no-rollback escape hatch.

const MIGRATION_BLOCKED =
  /\bDROP\s+DATABASE\b|\bSHUTDOWN\b|\bUSE\s+\w|\\connect\b|\\c\b/i;
const NON_TX_PG =
  /\b(?:CREATE|DROP)\s+INDEX\s+CONCURRENTLY\b|\bVACUUM\b|\bREINDEX\b|\bCREATE\s+DATABASE\b|\bALTER\s+SYSTEM\b/i;
const NON_TX_MSSQL =
  /\bCREATE\s+DATABASE\b|\bALTER\s+DATABASE\b|\bBACKUP\b|\bRESTORE\b|\bCREATE\s+FULLTEXT\b/i;
const DDL_KEYWORDS =
  /\b(CREATE|ALTER|DROP|TRUNCATE|RENAME|GRANT|REVOKE|COMMENT\s+ON)\b/i;

export interface MigrationValidation {
  valid: boolean;
  error?: string;
  statementCount?: number;
  /** true when the script contains a statement that can't run inside a transaction. */
  requiresNoTransaction?: boolean;
  /** true when the script contains any DDL (drives migration AI-review mode). */
  hasDdl?: boolean;
}

/**
 * Validates a multi-statement migration script. Allows DDL and stacked
 * statements (unlike `validateWriteQuery`); blocks only DB/connection-level and
 * transaction-breaking statements. `opts.noTransaction` lets the caller opt into
 * running non-transactional statements without rollback.
 */
export function validateMigration(
  script: string,
  dbType: DatabaseType,
  opts: { noTransaction?: boolean } = {},
): MigrationValidation {
  const trimmed = script.trim();
  if (!trimmed)
    return { valid: false, error: "Migration script cannot be empty" };
  if (dbType !== "postgres" && dbType !== "mssql") {
    return {
      valid: false,
      error:
        "Multi-statement migrations are supported on PostgreSQL and SQL Server only.",
    };
  }

  const { statementCount, masked } = scanSql(trimmed);
  if (statementCount === 0)
    return { valid: false, error: "Migration script has no statements" };

  if (MIGRATION_BLOCKED.test(masked)) {
    return {
      valid: false,
      error:
        "Database/connection-level statements (DROP DATABASE, SHUTDOWN, USE, \\connect) are not allowed in a migration.",
    };
  }

  const requiresNoTransaction = (
    dbType === "postgres" ? NON_TX_PG : NON_TX_MSSQL
  ).test(masked);
  const hasDdl = DDL_KEYWORDS.test(masked);

  if (requiresNoTransaction && !opts.noTransaction) {
    return {
      valid: false,
      statementCount,
      requiresNoTransaction,
      hasDdl,
      error:
        'This script contains a statement that cannot run inside a transaction (e.g. CREATE INDEX CONCURRENTLY, VACUUM). Enable "Run without rollback" to submit it — statements are then committed individually and a mid-script failure will NOT be undone.',
    };
  }

  return { valid: true, statementCount, requiresNoTransaction, hasDdl };
}

/**
 * Classifies a write as single-DML vs. a migration (multiple statements or any
 * DDL). Mongo/ES are always single-op. Server-authoritative — never trust the
 * client to say whether something is a migration.
 */
export function classifyWrite(
  sql: string,
  dbType: DatabaseType,
): { isMigration: boolean; statementCount: number; hasDdl: boolean } {
  if (dbType !== "postgres" && dbType !== "mssql") {
    return { isMigration: false, statementCount: 1, hasDdl: false };
  }
  const { statementCount, masked } = scanSql(sql);
  const hasDdl = DDL_KEYWORDS.test(masked);
  return { isMigration: statementCount > 1 || hasDdl, statementCount, hasDdl };
}

/** Executes a validated migration script. Transactional unless opting out. */
export async function executeMigration(
  conn: ConnectionConfig,
  script: string,
  opts: { noTransaction?: boolean } = {},
): Promise<WriteResult> {
  const validation = validateMigration(script, conn.type, opts);
  if (!validation.valid)
    throw new Error(validation.error || "Invalid migration script");

  const start = performance.now();
  let result: { rowsAffected: number; transactional: boolean };
  switch (conn.type) {
    case "postgres":
      result = await executePgMigration(conn, script, !!opts.noTransaction);
      break;
    case "mssql":
      result = await executeMssqlMigration(conn, script, !!opts.noTransaction);
      break;
    default:
      throw new Error(`Migrations are not supported for ${conn.type}`);
  }
  return {
    ...result,
    executionMs: Math.round(performance.now() - start),
  };
}

/** Sums affected rows across a multi-statement pg result (array or single). */
function sumPgRowCount(result: any): number {
  if (Array.isArray(result))
    return result.reduce((a, r) => a + (r?.rowCount ?? 0), 0);
  return result?.rowCount ?? 0;
}

async function executePgMigration(
  conn: ConnectionConfig,
  script: string,
  noTransaction: boolean,
): Promise<{ rowsAffected: number; transactional: boolean }> {
  const pool = await getPgPool(conn);
  const client = await pool.connect();
  try {
    if (conn.schema) await client.query(`SET search_path TO ${conn.schema}`);

    if (!noTransaction) {
      // Whole script in one transaction — the engine parses it; any failure
      // rolls the entire migration back.
      await client.query("BEGIN");
      try {
        const result = await client.query(script);
        await client.query("COMMIT");
        return { rowsAffected: sumPgRowCount(result), transactional: true };
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          /* ignore rollback failure */
        }
        throw err;
      }
    }

    // No-rollback path: run each statement individually (a multi-statement
    // simple query is itself one implicit transaction, so CONCURRENTLY/VACUUM
    // only work standalone). Stop on first error — prior statements are already
    // committed and cannot be undone.
    const { statements } = scanSql(script);
    let rows = 0;
    for (let n = 0; n < statements.length; n++) {
      try {
        rows += sumPgRowCount(await client.query(statements[n]));
      } catch (err: any) {
        throw new Error(
          `Statement ${n + 1} of ${statements.length} failed (earlier statements were committed and cannot be rolled back): ${err?.message || err}`,
        );
      }
    }
    return { rowsAffected: rows, transactional: false };
  } finally {
    client.release();
  }
}

async function executeMssqlMigration(
  conn: ConnectionConfig,
  script: string,
  noTransaction: boolean,
): Promise<{ rowsAffected: number; transactional: boolean }> {
  const pool = await getMssqlPool(conn);
  const sumAffected = (affected: number | number[] | undefined) =>
    Array.isArray(affected)
      ? affected.reduce((a, b) => a + b, 0)
      : (affected ?? 0);

  if (noTransaction) {
    // No wrapping transaction — SQL Server autocommits each statement in the
    // batch. A mid-batch failure leaves earlier statements committed.
    const result = await pool.request().query(script);
    return {
      rowsAffected: sumAffected(result.rowsAffected),
      transactional: false,
    };
  }

  const tx = new mssql.Transaction(pool);
  await tx.begin();
  try {
    const result = await new mssql.Request(tx).query(script);
    await tx.commit();
    return {
      rowsAffected: sumAffected(result.rowsAffected),
      transactional: true,
    };
  } catch (err) {
    try {
      await tx.rollback();
    } catch {
      /* ignore rollback failure */
    }
    throw err;
  }
}

/** Executes a validated write statement, transactionally where supported. */
export async function executeWrite(
  conn: ConnectionConfig,
  sql: string,
): Promise<WriteResult> {
  const validation = validateWriteQuery(sql, conn.type);
  if (!validation.valid)
    throw new Error(validation.error || "Invalid write statement");

  const start = performance.now();
  let rowsAffected = 0;
  let transactional = true;

  switch (conn.type) {
    case "postgres":
      rowsAffected = await executePgWrite(conn, sql);
      break;
    case "mssql":
      rowsAffected = await executeMssqlWrite(conn, sql);
      break;
    case "mongodb": {
      const r = await executeMongoWrite(conn, sql);
      rowsAffected = r.rowsAffected;
      transactional = r.transactional;
      break;
    }
    case "elasticsearch":
      rowsAffected = await executeEsWrite(conn, sql);
      transactional = false;
      break;
    default:
      throw new Error(`Unsupported database type: ${conn.type}`);
  }

  return {
    rowsAffected,
    executionMs: Math.round(performance.now() - start),
    transactional,
  };
}

async function executePgWrite(
  conn: ConnectionConfig,
  sql: string,
): Promise<number> {
  const pool = await getPgPool(conn);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (conn.schema) await client.query(`SET search_path TO ${conn.schema}`);
    const result = await client.query(sql);
    await client.query("COMMIT");
    return result.rowCount ?? 0;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore rollback failure */
    }
    throw err;
  } finally {
    client.release();
  }
}

async function executeMssqlWrite(
  conn: ConnectionConfig,
  sql: string,
): Promise<number> {
  const pool = await getMssqlPool(conn);
  const tx = new mssql.Transaction(pool);
  await tx.begin();
  try {
    const request = new mssql.Request(tx);
    const result = await request.query(sql);
    await tx.commit();
    const affected = result.rowsAffected;
    return Array.isArray(affected)
      ? affected.reduce((a, b) => a + b, 0)
      : (affected ?? 0);
  } catch (err) {
    try {
      await tx.rollback();
    } catch {
      /* ignore rollback failure */
    }
    throw err;
  }
}

/** Splits a MongoDB argument list into top-level JSON values (respects nesting/strings). */
function splitTopLevelArgs(argsStr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString: string | null = null;
  let current = "";
  for (let i = 0; i < argsStr.length; i++) {
    const ch = argsStr[i];
    if (inString) {
      current += ch;
      if (ch === inString && argsStr[i - 1] !== "\\") inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      current += ch;
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseMongoArgs(sql: string): {
  collection: string;
  verb: string;
  args: any[];
} {
  const opMatch = sql.match(/(?:db\.)?(\w+)\.(\w+)\(/s);
  if (!opMatch) throw new Error("Could not parse MongoDB write expression");
  const argsStart = (opMatch.index ?? 0) + opMatch[0].length;
  let depth = 1;
  let i = argsStart;
  while (i < sql.length && depth > 0) {
    const ch = sql[i];
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    i++;
  }
  const argsStr = sql.slice(argsStart, i - 1);
  const rawParts = splitTopLevelArgs(argsStr);
  const args = rawParts.map((p, idx) => {
    try {
      return JSON.parse(p);
    } catch {
      throw new Error(`Invalid JSON in argument ${idx + 1}: ${p}`);
    }
  });
  return { collection: opMatch[1], verb: opMatch[2], args };
}

async function runMongoOp(
  collection: any,
  verb: string,
  args: any[],
  session?: ClientSession,
): Promise<number> {
  const opts = (extra: any = {}) => (session ? { ...extra, session } : extra);
  switch (verb) {
    case "updateOne": {
      const r = await collection.updateOne(
        args[0] ?? {},
        args[1] ?? {},
        opts(args[2]),
      );
      return r.modifiedCount ?? 0;
    }
    case "updateMany": {
      const r = await collection.updateMany(
        args[0] ?? {},
        args[1] ?? {},
        opts(args[2]),
      );
      return r.modifiedCount ?? 0;
    }
    case "replaceOne": {
      const r = await collection.replaceOne(
        args[0] ?? {},
        args[1] ?? {},
        opts(args[2]),
      );
      return r.modifiedCount ?? 0;
    }
    case "deleteOne": {
      const r = await collection.deleteOne(args[0] ?? {}, opts());
      return r.deletedCount ?? 0;
    }
    case "deleteMany": {
      const r = await collection.deleteMany(args[0] ?? {}, opts());
      return r.deletedCount ?? 0;
    }
    case "insertOne": {
      await collection.insertOne(args[0] ?? {}, opts());
      return 1;
    }
    case "insertMany": {
      const docs = Array.isArray(args[0]) ? args[0] : [args[0]];
      const r = await collection.insertMany(docs, opts());
      return r.insertedCount ?? docs.length;
    }
    default:
      throw new Error(`Unsupported MongoDB write verb: ${verb}`);
  }
}

async function executeMongoWrite(
  conn: ConnectionConfig,
  sql: string,
): Promise<{ rowsAffected: number; transactional: boolean }> {
  const client = await getMongoClient(conn);
  const dbName =
    conn.database || conn.uri?.split("/").pop()?.split("?")[0] || "test";
  const db = client.db(dbName);
  const { collection: collName, verb, args } = parseMongoArgs(sql);
  const collection = db.collection(collName);

  // Prefer a real transaction; fall back to a direct op if the deployment is not
  // a replica set (transactions require one).
  const session = client.startSession();
  try {
    let rows = 0;
    await session.withTransaction(async () => {
      rows = await runMongoOp(collection, verb, args, session);
    });
    return { rowsAffected: rows, transactional: true };
  } catch (err: any) {
    const msg = String(err?.message || err);
    if (
      /replica set|Transaction numbers|Transactions are not supported|not supported.*transaction/i.test(
        msg,
      )
    ) {
      const rows = await runMongoOp(collection, verb, args);
      return { rowsAffected: rows, transactional: false };
    }
    throw err;
  } finally {
    await session.endSession();
  }
}

async function executeEsWrite(
  conn: ConnectionConfig,
  sql: string,
): Promise<number> {
  const client = getEsClient(conn);
  const m = sql.trim().match(/^(POST|PUT|DELETE)\s+\/?(\S+)\s*([\s\S]*)?$/i);
  if (!m) throw new Error("Could not parse Elasticsearch write request");
  const [, method, path, bodyStr] = m;
  const body = bodyStr?.trim() ? JSON.parse(bodyStr) : undefined;
  const segments = path.split("/").filter(Boolean);
  const index = segments[0];
  const endpoint = segments[1];
  const id = segments[2];

  if (endpoint === "_update_by_query") {
    const r = await client.updateByQuery({ index, ...(body || {}) });
    return (r.updated as number) ?? 0;
  }
  if (endpoint === "_delete_by_query") {
    const r = await client.deleteByQuery({ index, ...(body || {}) });
    return (r.deleted as number) ?? 0;
  }
  if (endpoint === "_update" && id) {
    await client.update({ index, id, ...(body || {}) });
    return 1;
  }
  if (endpoint === "_create" && id) {
    await client.create({ index, id, document: body });
    return 1;
  }
  if (endpoint === "_doc") {
    if (method.toUpperCase() === "DELETE") {
      if (!id) throw new Error("DELETE /index/_doc requires a document id");
      await client.delete({ index, id });
      return 1;
    }
    await client.index({ index, id, document: body });
    return 1;
  }
  throw new Error(`Unsupported Elasticsearch write endpoint: ${endpoint}`);
}
