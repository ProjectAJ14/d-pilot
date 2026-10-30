import { createHash } from "node:crypto";
import mssql from "mssql";
import type {
  ConnectionConfig,
  DbObjectDefinition,
  DbObjectDependencies,
  DbObjectInfo,
  DbObjectKind,
  DbObjectReference,
  SqlObjectKind,
  DriftItem,
  DriftReport,
} from "../types/index.js";
import {
  introspectMssqlPool,
  introspectPgPool,
  resolveSchema,
} from "./schema-introspector.js";
import {
  ES_OBJECT_KINDS,
  getDocumentObjects,
  MONGO_OBJECT_KINDS,
} from "./document-objects.js";

/**
 * Procedures, functions, views and triggers — the code that lives in a
 * database rather than its tables. Read live, never cached: a procedure edited
 * outside D-Pilot must show its new version on the next open.
 *
 * Every schema and name is a bound parameter; only fixed literals from this
 * file are ever spliced into SQL.
 */

export const SQL_OBJECT_KINDS: SqlObjectKind[] = [
  "procedure",
  "function",
  "view",
  "trigger",
];

/** The kinds each engine has; the routes refuse any other. */
export function objectKindsFor(conn: ConnectionConfig): DbObjectKind[] {
  if (conn.type === "mongodb") return MONGO_OBJECT_KINDS;
  if (conn.type === "elasticsearch") return ES_OBJECT_KINDS;
  return SQL_OBJECT_KINDS;
}

/** Engines whose objects are SQL code: dependencies, edits and the SQL kinds. */
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
  argTypes?: string;
  parent?: string;
}

export async function getObjects(
  conn: ConnectionConfig,
  schema?: string,
): Promise<DbObjectInfo[]> {
  const list = await listObjects(conn, resolveSchema(conn, schema), false);
  // Mongo/ES read definitions with the list; the list itself is names only.
  return list.map(({ definition: _d, ...o }) => o);
}

function listObjects(
  conn: ConnectionConfig,
  schema: string,
  withDefinitions: boolean,
): Promise<DbObjectDefinition[]> {
  if (conn.type === "postgres")
    return getPostgresObjects(conn, schema, withDefinitions);
  if (conn.type === "mssql")
    return getMssqlObjects(conn, schema, withDefinitions);
  // Mongo/ES definitions are small JSON documents read in the same calls
  // that list them, so they always come back.
  return getDocumentObjects(conn);
}

/** The key that identifies "the same object" on two connections. */
export const objectKey = (o: DbObjectInfo) =>
  `${o.kind}:${o.name}(${o.argTypes ?? o.args ?? ""})@${o.parent ?? ""}`;

/**
 * A definition with the noise two deployments of the same code differ by
 * removed: line endings and trailing whitespace.
 */
export function normalizeDefinition(def: string): string {
  return def
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .trim();
}

export const definitionHash = (def: string | null) =>
  def == null
    ? null
    : createHash("sha256").update(normalizeDefinition(def)).digest("hex");

/**
 * Every object in `schema` that differs between two connections. Definitions
 * are hashed after normalizing, so only hashes are compared and nothing is
 * returned but names. A definition hidden on either side counts as different —
 * it can't be shown to be the same.
 */
export async function getDrift(
  left: ConnectionConfig,
  right: ConnectionConfig,
  schema?: string,
): Promise<DriftReport> {
  const s = resolveSchema(left, schema);
  const [l, r] = await Promise.all([
    listObjects(left, s, true),
    listObjects(right, s, true),
  ]);
  return compareDefinitions(s, l, r);
}

export function compareDefinitions(
  schema: string,
  left: DbObjectDefinition[],
  right: DbObjectDefinition[],
): DriftReport {
  const index = (list: DbObjectDefinition[]) =>
    new Map(list.map((o) => [objectKey(o), o]));
  const l = index(left);
  const r = index(right);
  const items: DriftItem[] = [];
  let identical = 0;
  const info = ({ definition: _d, ...o }: DbObjectDefinition) => o;
  for (const [key, o] of l) {
    const other = r.get(key);
    if (!other) items.push({ ...info(o), status: "only_left" });
    else {
      const a = definitionHash(o.definition);
      if (a != null && a === definitionHash(other.definition)) identical++;
      else items.push({ ...info(o), status: "different" });
    }
  }
  for (const [key, o] of r)
    if (!l.has(key)) items.push({ ...info(o), status: "only_right" });
  items.sort((a, b) => objectKey(a).localeCompare(objectKey(b)));
  return { schema, identical, items };
}

/** The object's full definition, or null when it doesn't exist. */
export async function getObjectDefinition(
  conn: ConnectionConfig,
  ref: ObjectRef,
): Promise<DbObjectDefinition | null> {
  const r = { ...ref, schema: resolveSchema(conn, ref.schema) };
  if (conn.type === "postgres") return getPostgresDefinition(conn, r);
  if (conn.type === "mssql") return getMssqlDefinition(conn, r);
  const all = await getDocumentObjects(conn);
  return (
    all.find(
      (o) =>
        o.kind === ref.kind &&
        o.name === ref.name &&
        (ref.parent == null || o.parent === ref.parent),
    ) ?? null
  );
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

// A trigger on a partitioned table is cloned onto every partition. The clones
// (a partition dependency on the parent trigger; tgparentid needs PG 13) are
// that one trigger, not objects of their own.
const PG_NOT_CLONE = `NOT EXISTS (SELECT 1 FROM pg_depend pd
  WHERE pd.classid = 'pg_trigger'::regclass AND pd.objid = t.oid
    AND pd.refclassid = 'pg_trigger'::regclass AND pd.deptype = 'P')`;

// The bodies (the last column) are only fetched for a drift report.
const pgObjectsSql = (defs: boolean) => `
SELECT p.proname AS name,
       CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END AS kind,
       pg_get_function_identity_arguments(p.oid) AS args, NULL AS parent,
       ${defs ? "pg_get_functiondef(p.oid)" : "NULL"} AS definition,
       oidvectortypes(p.proargtypes) AS arg_types
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = $1 AND p.prokind IN ('f', 'p') AND ${PG_NOT_EXTENSION}
UNION ALL
SELECT c.relname, 'view', NULL, NULL,
       ${defs ? "pg_get_viewdef(c.oid, true)" : "NULL"}, NULL
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1 AND c.relkind IN ('v', 'm')
UNION ALL
SELECT t.tgname, 'trigger', NULL, c.relname,
       ${defs ? "pg_get_triggerdef(t.oid, true)" : "NULL"}, NULL
FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1 AND NOT t.tgisinternal AND ${PG_NOT_CLONE}
ORDER BY 1, 3`;

async function getPostgresObjects(
  conn: ConnectionConfig,
  schema: string,
  withDefinitions: boolean,
): Promise<DbObjectDefinition[]> {
  const pool = introspectPgPool(conn);
  try {
    const res = await pool.query(pgObjectsSql(withDefinitions), [schema]);
    return res.rows.map((r) => ({
      schema,
      name: r.name,
      kind: r.kind,
      ...(r.args != null && { args: r.args }),
      // Drift and "Compare with…" match overloads by argument types, so a
      // renamed parameter reads as "different", not as missing.
      ...(r.arg_types != null && { argTypes: r.arg_types }),
      ...(r.parent != null && { parent: r.parent }),
      ...(withDefinitions && { definition: r.definition ?? null }),
    })) as DbObjectDefinition[];
  } finally {
    await pool.end();
  }
}

// $3 is optional: NULL matches any overload / any table, and single() then
// refuses to guess between several.
const PG_DEFINITION_SQL: Record<SqlObjectKind, string> = {
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
  AND ${PG_NOT_CLONE} AND ($3::text IS NULL OR c.relname = $3)
ORDER BY c.relname`,
};

function pgRoutineSql(prokind: string): string {
  return `
SELECT pg_get_function_identity_arguments(p.oid) AS args, NULL AS parent,
       pg_get_functiondef(p.oid) AS definition,
       oidvectortypes(p.proargtypes) AS arg_types
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = $1 AND p.proname = $2 AND p.prokind = ${prokind}
  AND ($3::text IS NULL OR pg_get_function_identity_arguments(p.oid) = $3
       OR oidvectortypes(p.proargtypes) = $4)
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
    const routine = ref.kind === "function" || ref.kind === "procedure";
    const res = await pool.query(PG_DEFINITION_SQL[ref.kind as SqlObjectKind], [
      ref.schema,
      ref.name,
      key ?? null,
      // The same overload in another environment may name its parameters
      // differently: its argument types still match.
      ...(routine ? [ref.argTypes ?? null] : []),
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
      ...(row.arg_types != null && { argTypes: row.arg_types }),
      ...(row.parent != null && { parent: row.parent }),
      definition: row.definition ?? null,
    };
  } finally {
    await pool.end();
  }
}

// --- SQL Server ---

const MSSQL_TYPES: Record<SqlObjectKind, string[]> = {
  procedure: ["P"],
  function: ["FN", "IF", "TF"],
  view: ["V"],
  trigger: ["TR"],
};

const mssqlKind = (type: string): SqlObjectKind =>
  SQL_OBJECT_KINDS.find((k) => MSSQL_TYPES[k].includes(type.trim()))!;

/** Like mssqlKind, for either end of a dependency: tables too, null if unresolved. */
const mssqlRefKind = (type: string | null): DbObjectReference["kind"] =>
  type == null
    ? null
    : type.trim() === "U"
      ? "table"
      : (mssqlKind(type) ?? null);

const sqlList = (types: string[]) => types.map((t) => `'${t}'`).join(", ");

// DML triggers carry their table's schema_id, so they list under it. Database
// DDL triggers have no schema and are out of scope here.
const mssqlObjectsSql = (defs: boolean) => `
SELECT o.name, o.type,
       CASE WHEN o.type = 'TR' THEN OBJECT_NAME(o.parent_object_id) END AS parent,
       ${defs ? "OBJECT_DEFINITION(o.object_id)" : "NULL"} AS definition
FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE s.name = @schema AND o.is_ms_shipped = 0
  AND o.type IN (${sqlList(Object.values(MSSQL_TYPES).flat())})
ORDER BY o.name`;

async function getMssqlObjects(
  conn: ConnectionConfig,
  schema: string,
  withDefinitions: boolean,
): Promise<DbObjectDefinition[]> {
  const pool = introspectMssqlPool(conn);
  try {
    await pool.connect();
    const res = await pool
      .request()
      .input("schema", mssql.NVarChar, schema)
      .query(mssqlObjectsSql(withDefinitions));
    return (res.recordset as any[]).map((r) => ({
      schema,
      name: r.name,
      kind: mssqlKind(r.type),
      ...(r.parent != null && { parent: r.parent }),
      ...(withDefinitions && { definition: r.definition ?? null }),
    })) as DbObjectDefinition[];
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
           AND o.type IN (${sqlList(MSSQL_TYPES[ref.kind as SqlObjectKind])})`,
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

// --- Dependencies ---

/**
 * What an object reads (`uses`) and what reads it (`usedBy`) — so a change
 * can say "this view is used by 3 procedures" before it is made.
 *
 * SQL Server answers from sys.sql_expression_dependencies with a LEFT JOIN,
 * so a reference to a dropped, late-bound or cross-database object stays in
 * the list as unresolved (kind null) instead of silently disappearing.
 * Postgres tracks views and triggers exactly; function bodies are opaque to
 * it, so for those the answer comes from matching names in the source and
 * `bestEffort` says so.
 */
export async function getObjectDependencies(
  conn: ConnectionConfig,
  ref: ObjectRef,
): Promise<DbObjectDependencies> {
  const r = { ...ref, schema: resolveSchema(conn, ref.schema) };
  if (conn.type === "postgres") return getPostgresDependencies(conn, r);
  if (conn.type === "mssql") return getMssqlDependencies(conn, r);
  return { uses: [], usedBy: [], bestEffort: false };
}

const MSSQL_DEPS_SQL = `
DECLARE @id int = OBJECT_ID(QUOTENAME(@schema) + '.' + QUOTENAME(@name));
SELECT 'uses' AS dir, d.referenced_database_name AS db,
       COALESCE(d.referenced_schema_name, OBJECT_SCHEMA_NAME(d.referenced_id)) AS sch,
       d.referenced_entity_name AS name, o.type
FROM sys.sql_expression_dependencies d
LEFT JOIN sys.objects o ON o.object_id = d.referenced_id
WHERE d.referencing_id = @id
UNION ALL
SELECT 'usedBy', NULL, OBJECT_SCHEMA_NAME(d.referencing_id),
       OBJECT_NAME(d.referencing_id), o.type
FROM sys.sql_expression_dependencies d
JOIN sys.objects o ON o.object_id = d.referencing_id
WHERE d.referenced_id = @id
   OR (d.referenced_id IS NULL AND d.referenced_database_name IS NULL
       AND d.referenced_entity_name = @name
       AND COALESCE(d.referenced_schema_name, @schema) = @schema)`;

async function getMssqlDependencies(
  conn: ConnectionConfig,
  ref: ObjectRef & { schema: string },
): Promise<DbObjectDependencies> {
  const pool = introspectMssqlPool(conn);
  try {
    await pool.connect();
    const res = await pool
      .request()
      .input("schema", mssql.NVarChar, ref.schema)
      .input("name", mssql.NVarChar, ref.name)
      .query(MSSQL_DEPS_SQL);
    const out: DbObjectDependencies = {
      uses: [],
      usedBy: [],
      bestEffort: false,
    };
    for (const r of res.recordset as any[]) {
      out[r.dir as "uses" | "usedBy"].push({
        ...(r.sch != null && { schema: r.sch }),
        name: r.name,
        kind: mssqlRefKind(r.type),
        ...(r.db != null && { database: r.db }),
      });
    }
    return dedupe(out);
  } finally {
    await pool.close();
  }
}

const PG_RELKIND = `CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'view' ELSE 'table' END`;
// A name as a whole word in a body; the name is escaped for the regex in SQL.
const pgWordMatch = (body: string, name: string) =>
  `${body} ~* ('\\m' || regexp_replace(${name}, '([^a-zA-Z0-9_])', '\\\\\\1', 'g') || '\\M')`;

/** Relations a view's rewrite rule depends on, or that depend on a relation. */
const PG_VIEW_DEPS = `
SELECT 'uses' AS dir, rn.nspname AS sch, c.relname AS name, ${PG_RELKIND} AS kind,
       NULL::text AS args, NULL::text AS parent
FROM pg_class v JOIN pg_namespace vn ON vn.oid = v.relnamespace
JOIN pg_rewrite r ON r.ev_class = v.oid
JOIN pg_depend d ON d.classid = 'pg_rewrite'::regclass AND d.objid = r.oid
  AND d.refclassid = 'pg_class'::regclass
JOIN pg_class c ON c.oid = d.refobjid AND c.oid <> v.oid
JOIN pg_namespace rn ON rn.oid = c.relnamespace
WHERE vn.nspname = $1 AND v.relname = $2 AND $3::text = 'view'
UNION
SELECT 'usedBy', vn.nspname, v.relname, 'view', NULL, NULL
FROM pg_class t JOIN pg_namespace tn ON tn.oid = t.relnamespace
JOIN pg_depend d ON d.refobjid = t.oid AND d.classid = 'pg_rewrite'::regclass
  AND d.refclassid = 'pg_class'::regclass
JOIN pg_rewrite r ON r.oid = d.objid
JOIN pg_class v ON v.oid = r.ev_class AND v.oid <> t.oid
JOIN pg_namespace vn ON vn.oid = v.relnamespace
WHERE tn.nspname = $1 AND t.relname = $2 AND $3::text = 'view'`;

/** A trigger uses its table and the function it executes. */
const PG_TRIGGER_DEPS = `
SELECT 'uses' AS dir, n.nspname AS sch, c.relname AS name, 'table' AS kind,
       NULL::text AS args, NULL::text AS parent
FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1 AND t.tgname = $2 AND ${PG_NOT_CLONE}
  AND ($3::text IS NULL OR c.relname = $3)
UNION
SELECT 'uses', fn.nspname, p.proname, 'function',
       pg_get_function_identity_arguments(p.oid), NULL
FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_proc p ON p.oid = t.tgfoid JOIN pg_namespace fn ON fn.oid = p.pronamespace
WHERE n.nspname = $1 AND t.tgname = $2 AND ${PG_NOT_CLONE}
  AND ($3::text IS NULL OR c.relname = $3)`;

/** Relations named in a routine's body, and the triggers that run it. */
const PG_ROUTINE_DEPS = `
WITH f AS (
  SELECT p.oid, p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = $1 AND p.proname = $2
    AND ($3::text IS NULL OR pg_get_function_identity_arguments(p.oid) = $3)
)
SELECT DISTINCT 'uses' AS dir, n.nspname AS sch, c.relname AS name, ${PG_RELKIND} AS kind,
       NULL::text AS args, NULL::text AS parent
FROM f, pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'v', 'm', 'p', 'f')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
  AND ${pgWordMatch("f.prosrc", "c.relname")}
UNION
SELECT 'usedBy', n.nspname, t.tgname, 'trigger', NULL, c.relname
FROM f JOIN pg_trigger t ON t.tgfoid = f.oid
JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE NOT t.tgisinternal AND ${PG_NOT_CLONE}`;

/** Routines whose body names this object — Postgres keeps no record of it. */
const PG_BODY_USED_BY = `
SELECT DISTINCT 'usedBy' AS dir, n.nspname AS sch, p.proname AS name,
       CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END AS kind,
       pg_get_function_identity_arguments(p.oid) AS args, NULL::text AS parent
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.prokind IN ('f', 'p') AND ${PG_NOT_EXTENSION}
  AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
  AND NOT (n.nspname = $1 AND p.proname = $2)
  AND ${pgWordMatch("p.prosrc", "$2")}`;

async function getPostgresDependencies(
  conn: ConnectionConfig,
  ref: ObjectRef & { schema: string },
): Promise<DbObjectDependencies> {
  const pool = introspectPgPool(conn);
  try {
    const [exact, key] =
      ref.kind === "view"
        ? [PG_VIEW_DEPS, "view"]
        : ref.kind === "trigger"
          ? [PG_TRIGGER_DEPS, ref.parent ?? null]
          : [PG_ROUTINE_DEPS, ref.args ?? null];
    const [a, b] = await Promise.all([
      pool.query(exact, [ref.schema, ref.name, key]),
      // A trigger is never named in a body; everything else may be.
      ref.kind === "trigger"
        ? { rows: [] }
        : pool.query(PG_BODY_USED_BY, [ref.schema, ref.name]),
    ]);
    const out: DbObjectDependencies = {
      uses: [],
      usedBy: [],
      bestEffort: ref.kind !== "trigger",
    };
    for (const r of [...a.rows, ...b.rows])
      out[r.dir as "uses" | "usedBy"].push({
        schema: r.sch,
        name: r.name,
        kind: r.kind,
        // Enough to open the exact overload, or the trigger on its table.
        ...(r.args != null && { args: r.args }),
        ...(r.parent != null && { parent: r.parent }),
      });
    return dedupe(out);
  } finally {
    await pool.end();
  }
}

function dedupe(d: DbObjectDependencies): DbObjectDependencies {
  const uniq = (list: DbObjectReference[]) => [
    ...new Map(
      list.map((r) => [
        `${r.database}.${r.schema}.${r.name}.${r.kind}(${r.args})@${r.parent}`,
        r,
      ]),
    ).values(),
  ];
  return { ...d, uses: uniq(d.uses), usedBy: uniq(d.usedBy) };
}

/**
 * Whether `name` (schema.routine, or routine on SQL Server) is a procedure or
 * function this database's team wrote: not built in, not owned by an
 * extension (dblink, pg_cron, …), not in a system schema. A job step may only
 * call one of those — a built-in can run SQL handed to it as a string.
 */
export async function isUserRoutine(
  conn: ConnectionConfig,
  name: string,
): Promise<boolean> {
  if (conn.type === "postgres") {
    // Resolved as Postgres would: unquoted folds to lower case.
    const [schema, routine] = (name.match(/"[^"]+"|[^.]+/g) ?? []).map((p) =>
      p.startsWith('"') ? p.slice(1, -1) : p.trim().toLowerCase(),
    );
    if (!routine) return false;
    const pool = introspectPgPool(conn);
    try {
      const res = await pool.query(
        `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = $1 AND p.proname = $2 AND p.prokind IN ('f', 'p')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
  AND ${PG_NOT_EXTENSION} LIMIT 1`,
        [schema, routine],
      );
      return res.rows.length > 0;
    } finally {
      await pool.end();
    }
  }
  if (conn.type === "mssql") {
    const pool = introspectMssqlPool(conn);
    try {
      await pool.connect();
      // sys.objects holds only this database's objects, and not the system
      // ones (sp_*, xp_* live in sys.system_objects / master).
      const res = await pool
        .request()
        .input("name", mssql.NVarChar, name)
        .query(
          `SELECT 1 AS ok FROM sys.objects
WHERE object_id = OBJECT_ID(@name) AND is_ms_shipped = 0
  AND type IN ('P', 'PC', 'FN', 'IF', 'TF', 'FS', 'FT')`,
        );
      return res.recordset.length > 0;
    } finally {
      await pool.close();
    }
  }
  return false;
}

/**
 * The canonical type of each Postgres argument (from splitPgArgs), resolved
 * by the database so int / int4 / integer, varchar(50) / character varying
 * and public.my_type / my_type compare equal; null for one it can't resolve.
 * An entry may begin with the parameter name, so the part after the first
 * word is tried before the whole ("p_ts timestamp", "double precision").
 */
export async function pgArgTypes(
  conn: ConnectionConfig,
  args: string[],
): Promise<(string | null)[]> {
  const pool = introspectPgPool(conn);
  const resolve = async (t: string) => {
    try {
      const r = await pool.query("SELECT to_regtype($1)::text AS t", [t]);
      return (r.rows[0]?.t as string | null) ?? null;
    } catch {
      return null; // not a type name at all
    }
  };
  try {
    const out: (string | null)[] = [];
    for (const a of args) {
      const tail = a.includes(" ") ? a.slice(a.indexOf(" ") + 1) : null;
      out.push((tail && (await resolve(tail))) || (await resolve(a)));
    }
    return out;
  } finally {
    await pool.end();
  }
}
