import mssql from "mssql";
import type {
  ConnectionConfig,
  DbObjectDefinition,
  DbObjectInfo,
  DbObjectKind,
} from "../types/index.js";
import {
  introspectMssqlPool,
  introspectPgPool,
  resolveSchema,
} from "./schema-introspector.js";

/**
 * Procedures, functions, views and triggers — the code that lives in a
 * database rather than its tables. Read live, never cached: a procedure edited
 * outside D-Pilot must show its new version on the next open.
 *
 * Every schema and name is a bound parameter; only fixed literals from this
 * file are ever spliced into SQL.
 */

export const OBJECT_KINDS: DbObjectKind[] = [
  "procedure",
  "function",
  "view",
  "trigger",
];

/** Engines that have programmable objects. Mongo/ES list none. */
export function supportsObjects(conn: ConnectionConfig): boolean {
  return conn.type === "postgres" || conn.type === "mssql";
}

/** A lookup the caller can't disambiguate (overloads, same-named triggers). */
export class AmbiguousObjectError extends Error {}

export interface ObjectRef {
  name: string;
  kind: DbObjectKind;
  schema?: string;
  args?: string;
  parent?: string;
}

export async function getObjects(
  conn: ConnectionConfig,
  schema?: string,
): Promise<DbObjectInfo[]> {
  const s = resolveSchema(conn, schema);
  if (conn.type === "postgres") return getPostgresObjects(conn, s);
  if (conn.type === "mssql") return getMssqlObjects(conn, s);
  return [];
}

/** The object's full definition, or null when it doesn't exist. */
export async function getObjectDefinition(
  conn: ConnectionConfig,
  ref: ObjectRef,
): Promise<DbObjectDefinition | null> {
  const r = { ...ref, schema: resolveSchema(conn, ref.schema) };
  if (conn.type === "postgres") return getPostgresDefinition(conn, r);
  if (conn.type === "mssql") return getMssqlDefinition(conn, r);
  return null;
}

/** One row for the lookup, or an error naming the keys that tell them apart. */
function single<T>(rows: T[], ref: ObjectRef, key: (r: T) => string): T | null {
  if (rows.length <= 1) return rows[0] ?? null;
  const hint = ref.kind === "trigger" ? "parent (its table)" : "args";
  throw new AmbiguousObjectError(
    `${ref.name} matches ${rows.length} ${ref.kind}s — pass ${hint}, one of: ${rows.map(key).join(" | ")}`,
  );
}

// --- PostgreSQL ---

// Extension-owned functions (pg_trgm, postgis, …) are skipped: they are
// hundreds of rows nobody on the team wrote.
const PG_NOT_EXTENSION = `NOT EXISTS (SELECT 1 FROM pg_depend d
  WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')`;

const PG_OBJECTS_SQL = `
SELECT p.proname AS name,
       CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END AS kind,
       pg_get_function_identity_arguments(p.oid) AS args, NULL AS parent
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = $1 AND p.prokind IN ('f', 'p') AND ${PG_NOT_EXTENSION}
UNION ALL
SELECT c.relname, 'view', NULL, NULL
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1 AND c.relkind IN ('v', 'm')
UNION ALL
SELECT t.tgname, 'trigger', NULL, c.relname
FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1 AND NOT t.tgisinternal
ORDER BY 1, 3`;

async function getPostgresObjects(
  conn: ConnectionConfig,
  schema: string,
): Promise<DbObjectInfo[]> {
  const pool = introspectPgPool(conn);
  try {
    const res = await pool.query(PG_OBJECTS_SQL, [schema]);
    return res.rows.map((r) => ({
      schema,
      name: r.name,
      kind: r.kind,
      ...(r.args != null && { args: r.args }),
      ...(r.parent != null && { parent: r.parent }),
    }));
  } finally {
    await pool.end();
  }
}

// $3 is optional: NULL matches any overload / any table, and single() then
// refuses to guess between several.
const PG_DEFINITION_SQL: Record<DbObjectKind, string> = {
  function: pgRoutineSql("'f'"),
  procedure: pgRoutineSql("'p'"),
  view: `
SELECT NULL AS args, NULL AS parent,
       format(CASE c.relkind WHEN 'm' THEN 'CREATE MATERIALIZED VIEW %I.%I AS'
              ELSE 'CREATE OR REPLACE VIEW %I.%I AS' END, n.nspname, c.relname)
         || E'\\n' || pg_get_viewdef(c.oid, true) AS definition
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('v', 'm')
  AND $3::text IS NULL`,
  trigger: `
SELECT NULL AS args, c.relname AS parent,
       pg_get_triggerdef(t.oid, true) || ';' AS definition
FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1 AND t.tgname = $2 AND NOT t.tgisinternal
  AND ($3::text IS NULL OR c.relname = $3)
ORDER BY c.relname`,
};

function pgRoutineSql(prokind: string): string {
  return `
SELECT pg_get_function_identity_arguments(p.oid) AS args, NULL AS parent,
       pg_get_functiondef(p.oid) AS definition
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = $1 AND p.proname = $2 AND p.prokind = ${prokind}
  AND ($3::text IS NULL OR pg_get_function_identity_arguments(p.oid) = $3)
ORDER BY 1`;
}

async function getPostgresDefinition(
  conn: ConnectionConfig,
  ref: ObjectRef & { schema: string },
): Promise<DbObjectDefinition | null> {
  const pool = introspectPgPool(conn);
  try {
    const key =
      ref.kind === "trigger"
        ? ref.parent
        : ref.kind === "view"
          ? undefined
          : ref.args;
    const res = await pool.query(PG_DEFINITION_SQL[ref.kind], [
      ref.schema,
      ref.name,
      key ?? null,
    ]);
    const row = single(res.rows, ref, (r) =>
      ref.kind === "trigger" ? r.parent : `(${r.args})`,
    );
    if (!row) return null;
    return {
      schema: ref.schema,
      name: ref.name,
      kind: ref.kind,
      ...(row.args != null && { args: row.args }),
      ...(row.parent != null && { parent: row.parent }),
      definition: row.definition ?? null,
    };
  } finally {
    await pool.end();
  }
}

// --- SQL Server ---

const MSSQL_TYPES: Record<DbObjectKind, string[]> = {
  procedure: ["P"],
  function: ["FN", "IF", "TF"],
  view: ["V"],
  trigger: ["TR"],
};

const mssqlKind = (type: string): DbObjectKind =>
  OBJECT_KINDS.find((k) => MSSQL_TYPES[k].includes(type.trim()))!;

const sqlList = (types: string[]) => types.map((t) => `'${t}'`).join(", ");

// DML triggers carry their table's schema_id, so they list under it. Database
// DDL triggers have no schema and are out of scope here.
const MSSQL_OBJECTS_SQL = `
SELECT o.name, o.type,
       CASE WHEN o.type = 'TR' THEN OBJECT_NAME(o.parent_object_id) END AS parent
FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE s.name = @schema AND o.is_ms_shipped = 0
  AND o.type IN (${sqlList(Object.values(MSSQL_TYPES).flat())})
ORDER BY o.name`;

async function getMssqlObjects(
  conn: ConnectionConfig,
  schema: string,
): Promise<DbObjectInfo[]> {
  const pool = introspectMssqlPool(conn);
  try {
    await pool.connect();
    const res = await pool
      .request()
      .input("schema", mssql.NVarChar, schema)
      .query(MSSQL_OBJECTS_SQL);
    return (res.recordset as any[]).map((r) => ({
      schema,
      name: r.name,
      kind: mssqlKind(r.type),
      ...(r.parent != null && { parent: r.parent }),
    }));
  } finally {
    await pool.close();
  }
}

async function getMssqlDefinition(
  conn: ConnectionConfig,
  ref: ObjectRef & { schema: string },
): Promise<DbObjectDefinition | null> {
  const pool = introspectMssqlPool(conn);
  try {
    await pool.connect();
    // Object names are unique per schema on SQL Server, so no overload key.
    const res = await pool
      .request()
      .input("schema", mssql.NVarChar, ref.schema)
      .input("name", mssql.NVarChar, ref.name)
      .query(
        `SELECT OBJECT_DEFINITION(o.object_id) AS definition,
                CASE WHEN o.type = 'TR' THEN OBJECT_NAME(o.parent_object_id) END AS parent
         FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
         WHERE s.name = @schema AND o.name = @name AND o.is_ms_shipped = 0
           AND o.type IN (${sqlList(MSSQL_TYPES[ref.kind])})`,
      );
    const row = (res.recordset as any[])[0];
    if (!row) return null;
    return {
      schema: ref.schema,
      name: ref.name,
      kind: ref.kind,
      ...(row.parent != null && { parent: row.parent }),
      definition: row.definition ?? null,
    };
  } finally {
    await pool.close();
  }
}
