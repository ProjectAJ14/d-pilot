// The rules for an object_change write request: what text may stand in for a
// procedure, function, view or trigger, and how the deployed one is turned
// into something that can be re-run. Pure functions — the route does the I/O.

import { scanSql } from "./sql-scan.js";
import type {
  DatabaseType,
  DbObjectInfo,
  DbObjectKind,
} from "../types/index.js";

// The first CREATE of a programmable object in a script, found in the masked
// text (comments and strings blanked, same offsets) so a header comment that
// says "CREATE PROCEDURE" is never the match.
const CREATE_RE =
  /\bCREATE\s+(OR\s+(?:ALTER|REPLACE)\s+)?(PROC(?:EDURE)?|FUNCTION|MATERIALIZED\s+VIEW|VIEW|TRIGGER)\b/i;

const KIND_OF: Record<string, DbObjectKind> = {
  PROC: "procedure",
  PROCEDURE: "procedure",
  FUNCTION: "function",
  VIEW: "view",
  TRIGGER: "trigger",
};

/**
 * The deployed definition rewritten so running it can never fail with
 * "already exists": `CREATE` → `CREATE OR ALTER` on SQL Server, `CREATE OR
 * REPLACE` on Postgres. Null when the engine has no such form (a Postgres
 * materialized view must be dropped and re-created) or no CREATE is found.
 */
export function toIdempotent(
  definition: string,
  dbType: DatabaseType,
): string | null {
  const m = CREATE_RE.exec(scanSql(definition).masked);
  if (!m) return null;
  if (/MATERIALIZED/i.test(m[2])) return null;
  const orForm = dbType === "mssql" ? "OR ALTER" : "OR REPLACE";
  const keyword = definition.slice(
    m.index + m[0].length - m[2].length,
    m.index + m[0].length,
  );
  return `${definition.slice(0, m.index)}CREATE ${orForm} ${keyword}${definition.slice(m.index + m[0].length)}`;
}

const unquote = (id: string) => id.replace(/^[[""]|[\]""]$/g, "");
const IDENT = String.raw`(?:\[[^\]]+\]|"[^"]+"|[\w$#@]+)`;
const QUALIFIED = new RegExp(String.raw`^\s*(?:(${IDENT})\s*\.\s*)?(${IDENT})`);
const ON_TABLE = new RegExp(
  String.raw`\bON\s+(?:(${IDENT})\s*\.\s*)?(${IDENT})`,
  "i",
);

/**
 * An identifier as the engine resolves it, for comparing with a catalog name:
 * Postgres folds an unquoted name to lower case and keeps a quoted one as
 * written; SQL Server compares names case-insensitively (default collation).
 */
const resolveIdent = (id: string, dbType: DatabaseType, catalog = false) =>
  dbType === "mssql"
    ? unquote(id).toLowerCase()
    : catalog || id.startsWith('"')
      ? unquote(id)
      : id.toLowerCase();

/**
 * A Postgres argument list as one type per argument, ready for the database
 * to resolve (pgArgTypes): modes and defaults dropped, and a function's OUT
 * parameters too — they are not part of its identity. Each entry may still
 * start with the parameter's name; the resolver tries it with and without.
 */
export function splitPgArgs(list: string, isFunction: boolean): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  let quote: string | null = null;
  for (const ch of list) {
    // A default may be a string holding commas and parentheses.
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts
    .map((a) => a.trim().replace(/\s+/g, " "))
    .filter((a) => !(isFunction && /^out /i.test(a)))
    .map((a) =>
      a
        .replace(/ (DEFAULT\b|=)[\s\S]*$/i, "")
        .replace(/^(IN|OUT|INOUT|VARIADIC) /i, "")
        .trim(),
    );
}

/** The parenthesized list right after `from` in `masked`, or null. */
function argList(sql: string, masked: string, from: number): string | null {
  const open = masked.slice(from).search(/\S/);
  if (open < 0 || masked[from + open] !== "(") return null;
  let depth = 0;
  for (let i = from + open; i < masked.length; i++) {
    if (masked[i] === "(") depth++;
    else if (masked[i] === ")" && --depth === 0)
      return sql.slice(from + open + 1, i);
  }
  return null;
}

/**
 * Why `sql` is not an acceptable new definition for `object`, or null when it
 * is. It must be exactly one idempotent CREATE of the same kind and name (its
 * schema, when written, must match), and run as one batch: SQL Server requires
 * CREATE PROCEDURE/VIEW/TRIGGER/FUNCTION to open its batch, so `GO`
 * separators are refused rather than silently sent as text.
 */
export function validateObjectChange(
  sql: string,
  dbType: DatabaseType,
  object: DbObjectInfo,
  defaultSchema: string,
): string | null {
  if (dbType !== "postgres" && dbType !== "mssql")
    return "Object changes are supported on PostgreSQL and SQL Server only.";
  const { masked, statementCount } = scanSql(sql);
  const m = CREATE_RE.exec(masked);
  if (!m || masked.slice(0, m.index).trim())
    return `The definition must start with CREATE ${dbType === "mssql" ? "OR ALTER" : "OR REPLACE"} ${object.kind.toUpperCase()}.`;
  if (!m[1])
    return `Use CREATE ${dbType === "mssql" ? "OR ALTER" : "OR REPLACE"} so the change can't fail with "already exists".`;
  if (/MATERIALIZED/i.test(m[2]))
    return "A materialized view can't be replaced in place — change it with a migration that drops and re-creates it.";
  const kind = KIND_OF[m[2].toUpperCase()];
  if (kind !== object.kind)
    return `This request changes a ${object.kind}, but the definition creates a ${kind}.`;

  const afterKind = m.index + m[0].length;
  const name = QUALIFIED.exec(sql.slice(afterKind));
  if (!name)
    return `The definition must create ${object.schema}.${object.name}.`;
  const id = (s: string) => resolveIdent(s, dbType);
  const want = (s: string) => resolveIdent(s, dbType, true);

  // A trigger belongs to its table; a Postgres trigger name can't be
  // qualified, so its schema is the table's.
  let schemaWritten: string | undefined = name[1];
  if (kind === "trigger") {
    const at = afterKind + name[0].length;
    const on = ON_TABLE.exec(masked.slice(at));
    const table = on && ON_TABLE.exec(sql.slice(at + on.index));
    if (dbType === "postgres") schemaWritten = table?.[1];
    if (object.parent && (!table || id(table[2]) !== want(object.parent)))
      return `The definition must keep ${object.name} on ${object.parent}${table ? `, not ${unquote(table[2])}` : ""}.`;
  }
  const schema = schemaWritten ? id(schemaWritten) : want(defaultSchema);
  if (id(name[2]) !== want(object.name) || schema !== want(object.schema))
    return `The definition must create ${object.schema}.${object.name}, not ${schemaWritten ? unquote(schemaWritten) : defaultSchema}.${unquote(name[2])}.`;

  // A Postgres routine is one overload: CREATE OR REPLACE with another
  // argument list would create or replace a different one, never
  // snapshotted. Here the list must exist; the route has the database
  // resolve both lists' types and compare them (proposedArgList).
  if (dbType === "postgres" && (kind === "function" || kind === "procedure")) {
    if (object.args == null)
      return "Say which overload this changes (its argument list).";
    if (argList(sql, masked, afterKind + name[0].length) == null)
      return `The definition must keep the argument list (${object.args}).`;
  }

  if (dbType === "mssql") {
    if (/^\s*GO\s*$/im.test(masked))
      return "Remove the GO separators — an object change runs as one batch.";
  } else if (statementCount > 1) {
    return "An object change is one statement — put anything else in a separate request.";
  }
  return null;
}

/** The argument list of the CREATE in `sql` (Postgres routines), or null. */
export function proposedArgList(sql: string): string | null {
  const { masked } = scanSql(sql);
  const m = CREATE_RE.exec(masked);
  if (!m) return null;
  const after = m.index + m[0].length;
  const name = QUALIFIED.exec(sql.slice(after));
  return name ? argList(sql, masked, after + name[0].length) : null;
}

// key = value / key: value for names that usually hold a secret, plus
// credentials embedded in a URL.
const SECRET_RE = [
  /\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?key|token)\b\s*[=:]\s*['"]?[^\s'";,)]{4,}/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"]+:[^\s/@'"]+@/i,
];

/**
 * Warnings for text that looks like a credential, e.g. a connection string
 * pasted into a procedure. Never blocks — a reviewer decides — but the author
 * and approver both see it.
 */
export function credentialWarnings(sql: string): string[] {
  return SECRET_RE.some((re) => re.test(sql))
    ? [
        "This definition looks like it contains a credential (a password, key, token or a URL with a password). Definitions are readable by everyone with read access — move secrets out of the code.",
      ]
    : [];
}
