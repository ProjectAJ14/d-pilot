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
