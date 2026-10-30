// Whether a command may become a job step. A step is SQL that runs later,
// unattended and repeatedly, so it is not read with text patterns: each
// engine parses it. Postgres's own parser (libpg-query) gives the statement
// tree; SQL Server compiles the batch under SET SHOWPLAN_XML, which runs
// nothing and reports every statement it would run. The rules below are
// applied to that answer, and each routine the step calls must be one of the
// database's own (isUserRoutine) — a built-in or an extension's function can
// run SQL it is handed as a string.

import mssql from "mssql";
import { parse } from "libpg-query";
import type { ConnectionConfig } from "../types/index.js";
import { introspectMssqlPool } from "./schema-introspector.js";
import { isUserRoutine } from "./schema-objects.js";
import { validateWriteQuery } from "./write-executor.js";

export const PATTERN_HINT =
  "Keep the logic in a procedure (changed through an object change) and have the step only EXEC/CALL it.";

/** A routine a step calls, as the engine resolved it. */
export type StepRoutine = { schema: string; name: string } | string;

type Analysis = { error: string } | { routines: StepRoutine[] };

// Built-ins that only compute a value. Postgres writes several SQL forms as
// pg_catalog calls (EXTRACT, TRIM, SUBSTRING, AT TIME ZONE…).
const PG_SAFE_FUNCTIONS = new Set(
  (
    "now clock_timestamp statement_timestamp transaction_timestamp timezone " +
    "date_trunc date_part extract make_interval make_date make_timestamp age " +
    "to_char to_date to_timestamp to_number lower upper btrim ltrim rtrim " +
    "length char_length substring left right replace concat concat_ws position " +
    "overlay abs round floor ceil ceiling trunc mod coalesce greatest least " +
    "count sum min max avg bool_and bool_or gen_random_uuid"
  ).split(" "),
);

// Postgres statements a step may be.
const PG_STATEMENTS: Record<string, string> = {
  CallStmt: "CALL",
  SelectStmt: "SELECT",
  InsertStmt: "INSERT",
  UpdateStmt: "UPDATE",
  DeleteStmt: "DELETE",
  VacuumStmt: "VACUUM/ANALYZE",
  RefreshMatViewStmt: "REFRESH MATERIALIZED VIEW",
};

const sval = (n: any): string => n?.String?.sval ?? "";

/**
 * Every node of a libpg-query tree, with its type. A field typed as one
 * node kind holds it unwrapped (CallStmt.funccall is a bare FuncCall), so a
 * function call is also recognised by its shape.
 */
function* nodes(tree: unknown): Generator<[string, any]> {
  if (Array.isArray(tree)) {
    for (const t of tree) yield* nodes(t);
  } else if (tree && typeof tree === "object") {
    if (Array.isArray((tree as any).funcname)) yield ["FuncCall", tree];
    for (const [k, v] of Object.entries(tree)) {
      if (/^[A-Z]/.test(k) && k !== "FuncCall") yield [k, v];
      yield* nodes(v);
    }
  }
}

const SYSTEM_SCHEMAS = /^(pg_catalog|information_schema|pg_.*)$/;

/** The rules over Postgres's parse of `command`; routines still need the catalog check. */
export async function analyzePgStep(command: string): Promise<Analysis> {
  let tree: any;
  try {
    tree = await parse(command);
  } catch (err: any) {
    return { error: `Postgres can't parse this step: ${err.message}` };
  }
  const stmts: any[] = tree.stmts ?? [];
  if (!stmts.length) return { error: "The command is empty." };
  for (const { stmt } of stmts) {
    const kind = Object.keys(stmt)[0];
    if (!PG_STATEMENTS[kind])
      return {
        error: `A job step can't run ${kind.replace(/Stmt$/, "")} statements — only CALL, SELECT, scoped INSERT/UPDATE/DELETE, VACUUM/ANALYZE or REFRESH MATERIALIZED VIEW. ${PATTERN_HINT}`,
      };
  }
  const routines: StepRoutine[] = [];
  for (const [kind, node] of nodes(stmts)) {
    // Anywhere in the tree, a WITH included.
    if ((kind === "UpdateStmt" || kind === "DeleteStmt") && !node.whereClause)
      return {
        error: `${kind === "UpdateStmt" ? "UPDATE" : "DELETE"} without a WHERE clause would change every row — refused, as it would be as a direct write.`,
      };
    if (kind === "SelectStmt" && node.intoClause)
      return { error: "SELECT … INTO creates a table — not in a job step." };
    if (kind !== "FuncCall") continue;
    const name: string[] = (node.funcname ?? []).map(sval);
    const fn = name[name.length - 1];
    if (
      (name.length === 1 || name[0] === "pg_catalog") &&
      PG_SAFE_FUNCTIONS.has(fn)
    )
      continue;
    if (name.length !== 2 || SYSTEM_SCHEMAS.test(name[0]))
      return {
        error: `${name.join(".")}() is not one of this database's routines or an allowed built-in — call your own routines as schema.name(…). ${PATTERN_HINT}`,
      };
    routines.push({ schema: name[0], name: fn });
  }
  return { routines };
}

// SQL Server statement types (as SHOWPLAN reports them) a step may be.
const MSSQL_STATEMENTS = new Set([
  "EXECUTE PROC",
  "INSERT",
  "UPDATE",
  "DELETE",
  "SELECT",
  "SELECT WITHOUT QUERY",
]);

const unescape = (s: string) =>
  s.replace(
    /&(apos|quot|lt|gt|amp|#x([0-9a-f]+)|#(\d+));/gi,
    (_, e, hex, dec) =>
      hex
        ? String.fromCharCode(parseInt(hex, 16))
        : dec
          ? String.fromCharCode(Number(dec))
          : { apos: "'", quot: '"', lt: "<", gt: ">", amp: "&" }[
              e.toLowerCase() as "apos"
            ]!,
  );

interface PlanStatement {
  type: string;
  text: string;
  proc?: string;
  remote?: boolean;
  /** Databases of the objects it touches, as the plan names them. */
  databases: string[];
  /** Functions it calls that SQL Server did not inline. */
  functions: string[];
}

/**
 * The statements SQL Server would run for a batch, from its SHOWPLAN XML: the
 * batch's own, not those inside a called procedure's or function's body
 * (that is the routine's code, changed through an object change).
 */
export function planStatements(plans: string[]): PlanStatement[] {
  const out: PlanStatement[] = [];
  const TAG = /<(\/?)([\w:]+)((?:\s+[\w:]+="[^"]*")*)\s*(\/?)>/g;
  for (const xml of plans) {
    const stack: string[] = [];
    let current: PlanStatement | null = null;
    let currentDepth = -1;
    let procDepth = -1;
    for (const m of xml.matchAll(TAG)) {
      const [, close, name, attrText, selfClose] = m;
      if (close) {
        stack.pop();
        if (stack.length === procDepth) procDepth = -1;
        if (stack.length === currentDepth) {
          current = null;
          currentDepth = -1;
        }
        continue;
      }
      const attr = (k: string) => {
        const a = new RegExp(`\\s${k}="([^"]*)"`).exec(attrText);
        return a ? unescape(a[1]) : undefined;
      };
      const inProc = procDepth >= 0;
      if (!inProc) {
        if (/^Stmt/.test(name) && !current) {
          current = {
            type: attr("StatementType") ?? name,
            text: attr("StatementText") ?? "",
            databases: [],
            functions: [],
          };
          out.push(current);
          currentDepth = stack.length;
        } else if (/^Stmt/.test(name) && current) {
          // A statement inside another (IF … UPDATE): its own entry too.
          out.push({
            type: attr("StatementType") ?? name,
            text: attr("StatementText") ?? "",
            databases: [],
            functions: [],
          });
        } else if (name === "StoredProc" && current) {
          current.proc ??= attr("ProcName");
          procDepth = stack.length;
        } else if (name === "UDF" && current) {
          // A called function's body, after the statement's plan: the
          // function's code, not the step's.
          procDepth = stack.length;
        } else if (name === "UserDefinedFunction" && current) {
          const fn = attr("FunctionName");
          if (fn) current.functions.push(fn);
        } else if (current && attr("Database")) {
          // An inlined function's tables show here too.
          current.databases.push(attr("Database")!);
        } else if (
          name === "RelOp" &&
          current &&
          /^Remote/.test(attr("PhysicalOp") ?? "")
        )
          current.remote = true;
      }
      if (!selfClose) stack.push(name);
    }
  }
  return out;
}

const unbracket = (s: string) => s.replace(/^\[|\]$/g, "").toLowerCase();

/**
 * The rules over SQL Server's plan of a step, compiled in `database`;
 * routines still need the catalog check.
 */
export function analyzeMssqlPlan(plans: string[], database: string): Analysis {
  const stmts = planStatements(plans);
  if (!stmts.length) return { error: "The command is empty." };
  const routines: StepRoutine[] = [];
  for (const s of stmts) {
    const text = s.text.trim();
    if (!MSSQL_STATEMENTS.has(s.type))
      return {
        error: `A job step can't run ${s.type} ("${text.slice(0, 60)}") — only EXEC of a procedure, scoped INSERT/UPDATE/DELETE or SELECT. ${PATTERN_HINT}`,
      };
    // Another database's tables or functions, three-part named: not this
    // connection's to change or read from a job (tempdb: temporary tables).
    const elsewhere = s.databases.find(
      (d) => ![database.toLowerCase(), "tempdb"].includes(unbracket(d)),
    );
    if (elsewhere)
      return {
        error: `"${text.slice(0, 60)}" reaches database ${elsewhere} — a job step works in this database only.`,
      };
    routines.push(...s.functions);
    if (s.remote)
      return {
        error: `"${text.slice(0, 60)}" reads outside this database (OPENROWSET, OPENQUERY, a linked server or a file) — not in a job step.`,
      };
    if (s.type === "EXECUTE PROC") {
      // Extended and system procedures (xp_cmdshell, sp_executesql) have
      // no body in the plan, so no name: never ours.
      if (!s.proc)
        return {
          error: `"${text.slice(0, 60)}" calls a system or extended procedure — a job step can only call this database's own. ${PATTERN_HINT}`,
        };
      routines.push(s.proc);
    } else if (s.type !== "SELECT" && s.type !== "SELECT WITHOUT QUERY") {
      const v = validateWriteQuery(text.replace(/^;\s*/, ""), "mssql");
      if (!v.valid) return { error: `${v.error} ${PATTERN_HINT}` };
      if (!v.scoped)
        return {
          error: `${v.verb} without a WHERE clause would change every row — refused, as it would be as a direct write.`,
        };
    }
  }
  return { routines };
}

/** SQL Server's plan of `command`, compiled under SHOWPLAN_XML — nothing runs. */
const SHOWPLAN_COLUMN = "Microsoft SQL Server 2005 XML Showplan";

/**
 * SQL Server's plan of `command`, compiled under SHOWPLAN_XML — nothing runs —
 * and the database it was compiled in. SHOWPLAN is a session setting, so the
 * whole check holds one connection through a transaction: if that connection
 * drops, the next request fails instead of running on a fresh session where
 * the setting is off. Anything back that is not a plan is an error.
 */
async function showplan(conn: ConnectionConfig, command: string) {
  const pool = introspectMssqlPool(conn, { max: 1 });
  try {
    await pool.connect();
    const tx = pool.transaction();
    await tx.begin();
    try {
      const q = (sql: string) => new mssql.Request(tx).batch(sql);
      const database = String(
        (await q("SELECT DB_NAME() AS db")).recordset[0].db,
      );
      await q("SET SHOWPLAN_XML ON");
      const r = await q(command);
      const sets = (r.recordsets ?? []) as any[];
      if (
        sets.some(
          (rs) => Object.keys(rs.columns ?? {}).join() !== SHOWPLAN_COLUMN,
        )
      )
        throw new Error(
          "SQL Server answered with something other than a plan.",
        );
      await q("SET SHOWPLAN_XML OFF");
      return {
        database,
        plans: sets.flat().map((row) => String(Object.values(row)[0])),
      };
    } finally {
      await tx.rollback().catch(() => {});
    }
  } finally {
    await pool.close();
  }
}

/**
 * Why `command` may not become a job step on `conn`, or null. The engine
 * parses it; anything it can't parse or compile is refused, as is anything
 * outside the rules or calling a routine that isn't the database's own.
 */
export async function checkJobStep(
  conn: ConnectionConfig,
  command: string,
): Promise<string | null> {
  if (!command.trim()) return "The command is empty.";
  let analysis: Analysis;
  if (conn.type === "postgres") analysis = await analyzePgStep(command);
  else if (conn.type === "mssql") {
    let compiled: { database: string; plans: string[] };
    try {
      compiled = await showplan(conn, command);
    } catch (err: any) {
      const number = err?.number ?? err?.originalError?.info?.number;
      if (number === 262)
        return "Checking a job step needs SHOWPLAN permission in this database for D-Pilot's login (GRANT SHOWPLAN).";
      // Unknown procedure, syntax error, SHOWPLAN switched off mid-batch…
      if (err instanceof mssql.RequestError)
        return `SQL Server can't compile this step: ${err.message}`;
      throw err;
    }
    analysis = analyzeMssqlPlan(compiled.plans, compiled.database);
  } else return `${conn.type} connections have no job steps.`;
  if ("error" in analysis) return analysis.error;
  for (const r of analysis.routines)
    if (!(await isUserRoutine(conn, r)))
      return `${typeof r === "string" ? r : `${r.schema}.${r.name}`} is not a procedure or function of this database — a job step can only call the database's own routines, never a built-in, an extension's or another database's.`;
  return null;
}
