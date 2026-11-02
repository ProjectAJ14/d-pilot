import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { ConnectionConfig } from "../types/index.js";

// SQL Server compile path (SHOWPLAN session) and the plan/tree rules on
// synthetic input. The driver, the pool and libpg-query are stand-ins here;
// job-step.test.ts runs the real parser on real captured plans.

const SHOWPLAN_COLUMN = "Microsoft SQL Server 2005 XML Showplan";

const h = vi.hoisted(() => ({
  userRoutines: [] as string[],
  batches: [] as string[],
  answer: {} as Record<string, unknown>,
  rollbackFails: false,
  calls: [] as string[],
  parse: null as null | ((sql: string) => unknown),
}));

vi.mock("mssql", () => {
  class RequestError extends Error {}
  class Request {
    batch(sql: string) {
      h.batches.push(sql);
      const a = h.answer[sql] ?? h.answer["*"];
      if (a instanceof Error) return Promise.reject(a);
      return Promise.resolve(a ?? { recordsets: [] });
    }
  }
  return { default: { Request, RequestError } };
});
vi.mock("./schema-introspector.js", () => ({
  introspectMssqlPool: (_c: unknown, opts: unknown) => {
    h.calls.push(`pool ${JSON.stringify(opts)}`);
    return {
      connect: async () => h.calls.push("connect"),
      close: async () => h.calls.push("close"),
      transaction: () => ({
        begin: async () => h.calls.push("begin"),
        rollback: async () => {
          h.calls.push("rollback");
          if (h.rollbackFails) throw new Error("no tx");
        },
      }),
    };
  },
}));
vi.mock("./schema-objects.js", () => ({
  isUserRoutine: vi.fn(async (_c: unknown, r: any) =>
    h.userRoutines.includes(
      typeof r === "string" ? r : `${r.schema}.${r.name}`,
    ),
  ),
}));
vi.mock("libpg-query", async (orig) => {
  const real = await orig<typeof import("libpg-query")>();
  return {
    ...real,
    parse: (sql: string) => (h.parse ? h.parse(sql) : real.parse(sql)),
  };
});

const mssql = (await import("mssql")).default;
const { checkJobStep, analyzePgStep, analyzeMssqlPlan, planStatements } =
  await import("./job-step.js");

const fixtures: Record<string, { plans: string[] }> = JSON.parse(
  readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "__fixtures__/showplan.json",
    ),
    "utf8",
  ),
);

const ms = { id: "m", type: "mssql", env: "QA" } as ConnectionConfig;
const planSet = (plans: string[]) => ({
  recordsets: [
    Object.assign(
      plans.map((p) => ({ [SHOWPLAN_COLUMN]: p })),
      { columns: { [SHOWPLAN_COLUMN]: {} } },
    ),
  ],
});
const compileAs = (command: string, answer: unknown) => {
  h.answer = {
    "SELECT DB_NAME() AS db": { recordset: [{ db: "app_core" }] },
    [command]: answer,
  };
};

beforeEach(() => {
  h.userRoutines = ["dbo.recalc"];
  h.batches = [];
  h.calls = [];
  h.answer = {};
  h.rollbackFails = false;
  h.parse = null;
});

describe("checkJobStep on SQL Server", () => {
  it("compiles under SHOWPLAN on one held session, then checks the plan", async () => {
    compileAs("EXEC dbo.recalc", planSet(fixtures.exec_user_proc.plans));
    expect(await checkJobStep(ms, "EXEC dbo.recalc")).toBeNull();
    expect(h.batches).toEqual([
      "SELECT DB_NAME() AS db",
      "SET SHOWPLAN_XML ON",
      "EXEC dbo.recalc",
      "SET SHOWPLAN_XML OFF",
    ]);
    expect(h.calls).toEqual([
      'pool {"max":1}',
      "connect",
      "begin",
      "rollback",
      "close",
    ]);
  });

  it("names a procedure that is not the database's own", async () => {
    h.userRoutines = [];
    compileAs("EXEC dbo.recalc", planSet(fixtures.exec_user_proc.plans));
    expect(await checkJobStep(ms, "EXEC dbo.recalc")).toMatch(
      /^dbo\.recalc is not a procedure or function of this database/,
    );
  });

  it("returns the plan's own refusal", async () => {
    compileAs("SHUTDOWN", planSet(fixtures.exec_then_shutdown.plans));
    expect(await checkJobStep(ms, "SHUTDOWN")).toContain("can't run SHUTDOWN");
  });

  it("treats no result sets as an empty command, and ignores a failed rollback", async () => {
    h.rollbackFails = true;
    compileAs("-- nothing", {});
    expect(await checkJobStep(ms, "-- nothing")).toBe("The command is empty.");
    expect(h.calls).toContain("close");
  });

  it("refuses an answer that is not a plan, closing the pool", async () => {
    compileAs("SELECT 1", {
      recordsets: [Object.assign([{ x: 1 }], { columns: { x: {} } })],
    });
    await expect(checkJobStep(ms, "SELECT 1")).rejects.toThrow(
      "something other than a plan",
    );
    compileAs("SELECT 2", { recordsets: [[{ x: 1 }]] });
    await expect(checkJobStep(ms, "SELECT 2")).rejects.toThrow(
      "something other than a plan",
    );
    expect(h.calls.filter((c) => c === "close")).toHaveLength(2);
  });

  it("explains a missing SHOWPLAN permission, by either error shape", async () => {
    const msg = "Checking a job step needs SHOWPLAN permission";
    compileAs("x", Object.assign(new Error("denied"), { number: 262 }));
    expect(await checkJobStep(ms, "x")).toContain(msg);
    compileAs(
      "x",
      Object.assign(new Error("denied"), {
        originalError: { info: { number: 262 } },
      }),
    );
    expect(await checkJobStep(ms, "x")).toContain(msg);
  });

  it("reports a compile error and rethrows anything else", async () => {
    compileAs("EXEC nope", new mssql.RequestError("Could not find nope"));
    expect(await checkJobStep(ms, "EXEC nope")).toBe(
      "SQL Server can't compile this step: Could not find nope",
    );
    compileAs("x", new Error("socket closed"));
    await expect(checkJobStep(ms, "x")).rejects.toThrow("socket closed");
  });
});

describe("checkJobStep guards", () => {
  it("refuses an empty command and engines without jobs", async () => {
    expect(await checkJobStep(ms, "  ")).toBe("The command is empty.");
    expect(
      await checkJobStep({ ...ms, type: "mongodb" } as ConnectionConfig, "x"),
    ).toBe("mongodb connections have no job steps.");
  });

  it("returns a Postgres refusal", async () => {
    expect(
      await checkJobStep(
        { ...ms, type: "postgres" } as ConnectionConfig,
        "DROP TABLE app_core.orders",
      ),
    ).toContain("can't run Drop statements");
  });
});

describe("analyzePgStep on unusual trees", () => {
  it("treats a tree without stmts as empty", async () => {
    h.parse = () => ({});
    expect(await analyzePgStep("x")).toEqual({
      error: "The command is empty.",
    });
  });

  it("reads a name part that is not a String node as empty", async () => {
    h.parse = () => ({
      stmts: [
        { stmt: { SelectStmt: { targetList: [{ funcname: [{}, {}] }] } } },
      ],
    });
    expect(await analyzePgStep("x")).toEqual({
      routines: [{ schema: "", name: "" }],
    });
  });
});

describe("planStatements on synthetic plans", () => {
  it("falls back to the tag name and empty text, and decodes numeric entities", () => {
    const xml =
      '<ShowPlanXML><StmtSimple/><StmtSimple StatementType="SELECT" StatementText="&#x41;&#66;&amp;"><RelOp/><UserDefinedFunction/></StmtSimple></ShowPlanXML>';
    expect(planStatements([xml])).toEqual([
      { type: "StmtSimple", text: "", databases: [], functions: [] },
      { type: "SELECT", text: "AB&", databases: [], functions: [] },
    ]);
  });

  it("lists a nested statement without type or text by its tag", () => {
    const xml =
      '<B><StmtCond StatementType="COND"><Then><StmtSimple/></Then></StmtCond></B>';
    expect(planStatements([xml]).map((s) => [s.type, s.text])).toEqual([
      ["COND", ""],
      ["StmtSimple", ""],
    ]);
  });
});

describe("analyzeMssqlPlan on synthetic plans", () => {
  const stmt = (type: string, text: string) =>
    `<B><StmtSimple StatementType="${type}" StatementText="${text}"></StmtSimple></B>`;

  it("refuses an empty plan list", () => {
    expect(analyzeMssqlPlan([], "app_core")).toEqual({
      error: "The command is empty.",
    });
  });

  it("refuses a write the direct-write rules refuse", () => {
    const a = analyzeMssqlPlan([stmt("INSERT", "TRUNCATE TABLE orders")], "x");
    expect("error" in a && a.error).toMatch(
      /^Only INSERT, UPDATE and DELETE are allowed\. Found "TRUNCATE"\. Keep the logic/,
    );
  });

  it("accepts a SELECT WITHOUT QUERY and an INSERT", () => {
    expect(
      analyzeMssqlPlan(
        [
          stmt("SELECT WITHOUT QUERY", "DECLARE @x int"),
          stmt("INSERT", "; INSERT INTO orders (id) VALUES (1)"),
        ],
        "app_core",
      ),
    ).toEqual({ routines: [] });
  });
});
