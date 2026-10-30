import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { ConnectionConfig } from "../types/index.js";

/**
 * Job steps are judged on each engine's own reading of them: the real
 * Postgres parser (libpg-query) and SQL Server's SHOWPLAN XML. The plans here
 * were captured from SQL Server 2022 compiling each command under
 * SET SHOWPLAN_XML ON. Every case below once got past a text-pattern checker.
 */

const h = vi.hoisted(() => ({ userRoutines: [] as string[] }));
vi.mock("./schema-objects.js", () => ({
  isUserRoutine: vi.fn(async (_c: unknown, r: any) =>
    h.userRoutines.includes(
      typeof r === "string" ? r : `${r.schema}.${r.name}`,
    ),
  ),
}));

const { analyzePgStep, analyzeMssqlPlan, planStatements, checkJobStep } =
  await import("./job-step.js");

const plans: Record<string, { command: string; plans: string[] }> = JSON.parse(
  readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "__fixtures__/showplan.json",
    ),
    "utf8",
  ),
);
const mssqlWhy = (k: string) => {
  const a = analyzeMssqlPlan(plans[k].plans, "app_core");
  return "error" in a ? a.error : null;
};

const pg = { id: "p", type: "postgres", env: "QA" } as ConnectionConfig;

beforeEach(() => {
  h.userRoutines = ["app_core.recalc", "app_core.close_stale_orders"];
});

describe("Postgres steps, as Postgres parses them", () => {
  const why = async (cmd: string) => {
    const a = await analyzePgStep(cmd);
    return "error" in a ? a.error : null;
  };
  const routines = async (cmd: string) => {
    const a = await analyzePgStep(cmd);
    return "routines" in a
      ? a.routines.map((r) =>
          typeof r === "string" ? r : `${r.schema}.${r.name}`,
        )
      : a.error;
  };

  it("accepts calls, scoped writes and maintenance", async () => {
    for (const cmd of [
      "CALL app_core.recalc(7)",
      "SELECT app_core.recalc('2026-01-01'::date, p_days => 7)",
      "UPDATE app_core.orders SET placed_at = now(), notes = upper(trim(notes)) WHERE id = 1; DELETE FROM app_core.audit WHERE at < now() - interval '30 days'",
      "INSERT INTO app_core.audit (at, n) VALUES (now(), coalesce(1, 2))",
      "VACUUM ANALYZE app_core.orders",
      "REFRESH MATERIALIZED VIEW app_core.daily_revenue",
      "SELECT extract(epoch FROM now()), substring('abc' FROM 1 FOR 2)",
    ])
      expect(await why(cmd), cmd).toBeNull();
  });

  it("names every routine called, at any depth, for the catalog check", async () => {
    expect(
      await routines(
        "UPDATE app_core.orders SET notes = x.t FROM query_to_xml.wrap('q') AS x(t) WHERE id = app_core.pick(1)",
      ),
    ).toEqual(expect.arrayContaining(["query_to_xml.wrap", "app_core.pick"]));
    expect(
      await routines("CALL app_core.recalc(1::bool or app_core.other(1))"),
    ).toEqual(expect.arrayContaining(["app_core.recalc", "app_core.other"]));
  });

  it("refuses built-ins that run SQL handed to them, however they are written", async () => {
    for (const cmd of [
      "SELECT query_to_xml('select pg_terminate_backend(1)', true, true, '')",
      "SELECT pg_catalog.query_to_xml('select 1', true, true, '')",
      "SELECT app_core.recalc(pg_terminate_backend(1))",
      'SELECT app_core.recalc("pg_terminate_backend"(1))',
      "CALL app_core.recalc(1::bool or pg_terminate_backend(1))",
      "UPDATE app_core.orders SET notes = x.t FROM query_to_xml('q', true, true, '') AS x(t) WHERE id = 1",
      "SELECT set_config('role', 'postgres', false)",
      "CALL dblink_exec('dbname=app', 'DROP TABLE x')",
    ])
      expect(await why(cmd), cmd).toContain(
        "not one of this database's routines",
      );
  });

  it("sees a second statement where a text reader saw a string", async () => {
    // E'\'' is one quote character: the DROP is a statement of its own.
    expect(
      await why(
        "UPDATE app_core.orders SET notes = E'\\'' WHERE id = 1; DROP TABLE x; --'",
      ),
    ).toContain("can't run Drop statements");
  });

  it("refuses statements outside the rules, and unscoped writes at any depth", async () => {
    expect(await why("DO $$ BEGIN PERFORM 1; END $$")).toContain(
      "can't run Do",
    );
    expect(await why("COPY app_core.orders TO PROGRAM 'id'")).toContain(
      "can't run Copy",
    );
    expect(await why("SET ROLE postgres")).toContain("can't run VariableSet");
    expect(await why("UPDATE app_core.orders SET notes = 'x'")).toContain(
      "without a WHERE",
    );
    expect(
      await why(
        "WITH d AS (DELETE FROM app_core.orders RETURNING id) SELECT count(*) FROM d",
      ),
    ).toContain("DELETE without a WHERE");
    expect(
      await why("SELECT * INTO app_core.copy FROM app_core.orders"),
    ).toContain("SELECT … INTO");
    expect(await why("UPDATE app_core.orders SET")).toContain("can't parse");
    expect(await why("-- nothing")).toContain("empty");
  });
});

describe("SQL Server steps, as SHOWPLAN compiles them", () => {
  it("finds the batch's own statements, not the called procedure's body", () => {
    expect(
      planStatements(plans.exec_then_shutdown.plans).map((s) => [
        s.type,
        s.proc,
      ]),
    ).toEqual([
      ["EXECUTE PROC", "dbo.recalc"],
      ["SHUTDOWN", undefined],
    ]);
  });

  it("accepts a call of the database's own procedure, scoped writes and SELECT", () => {
    for (const k of [
      "exec_user_proc",
      "update_scoped",
      "two_updates",
      "select_udf",
    ])
      expect(mssqlWhy(k), k).toBeNull();
    const a = analyzeMssqlPlan(plans.exec_user_proc.plans, "app_core");
    expect("routines" in a && a.routines).toEqual(["dbo.recalc"]);
  });

  it("refuses what the engine says the batch would also run", () => {
    expect(mssqlWhy("exec_then_shutdown")).toContain("can't run SHUTDOWN");
    expect(mssqlWhy("exec_string")).toContain("can't run EXECUTE STRING");
    expect(mssqlWhy("if_update")).toContain("can't run COND");
    expect(mssqlWhy("xp_cmdshell")).toContain("system or extended procedure");
    expect(mssqlWhy("openquery")).toContain("reads outside this database");
    expect(mssqlWhy("update_unscoped")).toContain("without a WHERE");
  });

  it("stays in its own database, even through a function SQL Server inlined", () => {
    expect(mssqlWhy("other_db_table")).toContain("reaches database [other_db]");
    expect(mssqlWhy("other_db_function")).toContain(
      "reaches database [other_db]",
    );
  });

  it("compares database names exactly: one differing in case may be another database", () => {
    const a = analyzeMssqlPlan(plans.update_scoped.plans, "APP_CORE");
    expect("error" in a && a.error).toContain("reaches database [app_core]");
  });

  it("sends the functions a write calls to the catalog check", () => {
    const a = analyzeMssqlPlan(plans.udf_in_update.plans, "app_core");
    expect("routines" in a && a.routines).toEqual([
      "[app_core].[dbo].[total_for]",
    ]);
  });
});

describe("checkJobStep", () => {
  it("passes only when every routine is the database's own", async () => {
    expect(await checkJobStep(pg, "CALL app_core.recalc(7)")).toBeNull();
    h.userRoutines = [];
    expect(await checkJobStep(pg, "CALL app_core.recalc(7)")).toContain(
      "not a procedure or function of this database",
    );
  });
});
