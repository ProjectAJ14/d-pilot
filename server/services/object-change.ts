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

  const name = QUALIFIED.exec(sql.slice(m.index + m[0].length));
  const schema = name?.[1] ? unquote(name[1]) : defaultSchema;
  if (
    !name ||
    unquote(name[2]).toLowerCase() !== object.name.toLowerCase() ||
    schema.toLowerCase() !== object.schema.toLowerCase()
  )
    return `The definition must create ${object.schema}.${object.name}, not ${name ? `${schema}.${unquote(name[2])}` : "something else"}.`;

  if (dbType === "mssql") {
    if (/^\s*GO\s*$/im.test(masked))
      return "Remove the GO separators — an object change runs as one batch.";
  } else if (statementCount > 1) {
    return "An object change is one statement — put anything else in a separate request.";
  }
  return null;
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
