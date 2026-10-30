import { describe, it, expect, vi } from "vitest";
import type { ConnectionConfig } from "../types/index.js";

// Drivers that fail the way a login without the grant does.
const h = vi.hoisted(() => ({
  pgError: null as any,
  msError: null as any,
  msRecordsets: null as any[][] | null,
  msSql: "",
}));
vi.mock("./sqlite-store.js", () => ({
  getAiColumnValuesEnabled: () => false,
  getSetting: () => null,
}));
vi.mock("./phi-masking.js", () => ({ findMatchingRule: () => null }));
vi.mock("pg", async () => ({
  default: {
    Pool: class extends (await import("node:events")).EventEmitter {
      async query(sql: string) {
        if (sql.includes("pg_extension")) return { rowCount: 1, rows: [{}] };
        throw h.pgError;
      }
      async end() {}
    },
  },
}));
vi.mock("mssql", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    default: {
      UniqueIdentifier: "uuid",
      ConnectionPool: class extends EventEmitter {
        async connect() {}
        async close() {}
        request() {
          return {
            input() {
              return this;
            },
            query: async (sql: string) => {
              h.msSql = sql;
              if (h.msRecordsets)
                return {
                  recordsets: h.msRecordsets,
                  recordset: h.msRecordsets[0],
                };
              throw h.msError;
            },
          };
        }
      },
    },
  };
});

const {
  getJobs,
  getJobDetail,
  getJobsCalling,
  callsObject,
  validJobId,
  AGENT_GRANT,
  PG_CRON_GRANT,
  OTHER_DB_STEP,
} = await import("./jobs.js");

const ms = { id: "m", type: "mssql", env: "QA" } as ConnectionConfig;
const pg = { id: "p", type: "postgres", env: "QA" } as ConnectionConfig;

describe("getJobs", () => {
  it("names the msdb grant instead of passing the driver error on", async () => {
    h.msError = Object.assign(new Error("The SELECT permission was denied"), {
      number: 229,
    });
    expect(await getJobs(ms)).toEqual({
      available: false,
      reason: AGENT_GRANT,
      jobs: [],
    });
  });

  it("names the cron grant on insufficient_privilege", async () => {
    h.pgError = Object.assign(new Error("permission denied for schema cron"), {
      code: "42501",
    });
    expect(await getJobs(pg)).toEqual({
      available: false,
      reason: PG_CRON_GRANT,
      jobs: [],
    });
  });

  it("still throws anything else", async () => {
    h.pgError = new Error("connection reset");
    await expect(getJobs(pg)).rejects.toThrow("connection reset");
  });
});

describe("validJobId", () => {
  it("accepts only a GUID for Agent and an integer for pg_cron", () => {
    expect(validJobId(ms, "28741445-2c81-4de3-8fe9-bb30b243dd28")).toBe(true);
    expect(validJobId(ms, "28741445'; DROP TABLE x;--")).toBe(false);
    expect(validJobId(pg, "12")).toBe(true);
    expect(validJobId(pg, "12 OR 1=1")).toBe(false);
  });
});

describe("getJobDetail", () => {
  it("never returns the command of a step aimed at another database", async () => {
    h.msRecordsets = [
      [
        {
          job_id: "28741445-2C81-4DE3-8FE9-BB30B243DD28",
          name: "recalc",
          enabled: 1,
          step_count: 2,
        },
      ],
      [
        {
          step_id: 1,
          step_name: "here",
          subsystem: "TSQL",
          database_name: "app_core",
          other_db: 0,
          command: "EXEC app_core.refresh_order_totals",
        },
        {
          step_id: 2,
          step_name: "elsewhere",
          subsystem: "TSQL",
          database_name: "billing",
          other_db: 1,
          command: null,
          run_status: 0,
          message: null,
        },
      ],
      [],
      [],
    ];
    const job = await getJobDetail(ms, "28741445-2c81-4de3-8fe9-bb30b243dd28");
    expect(job!.steps.map((s) => s.command)).toEqual([
      "EXEC app_core.refresh_order_totals",
      OTHER_DB_STEP,
    ]);
    // The redaction happens in SQL, so the text never leaves the server.
    expect(h.msSql).toContain(
      "CASE WHEN (s.database_name IS NULL OR s.database_name = DB_NAME()) THEN s.command END",
    );
    h.msRecordsets = null;
  });
});

describe("getJobDetail access", () => {
  it("names the grant instead of passing the driver error on", async () => {
    h.msRecordsets = null;
    h.msError = Object.assign(new Error("SELECT permission denied"), {
      number: 229,
    });
    await expect(
      getJobDetail(ms, "28741445-2c81-4de3-8fe9-bb30b243dd28"),
    ).rejects.toThrow(AGENT_GRANT);
    h.pgError = Object.assign(new Error("permission denied"), {
      code: "42501",
    });
    await expect(getJobDetail(pg, "7")).rejects.toThrow(PG_CRON_GRANT);
  });
});

describe("getJobsCalling", () => {
  it("matches whole identifiers, bare, qualified or quoted", () => {
    for (const cmd of [
      "EXEC refresh_order_totals",
      "EXEC app_core.refresh_order_totals @days = 7",
      "EXEC [app_core].[refresh_order_totals]",
      'CALL "app_core"."refresh_order_totals"()',
      "exec APP_CORE.REFRESH_ORDER_TOTALS",
    ])
      expect(callsObject(cmd, "refresh_order_totals")).toBe(true);
    for (const cmd of [
      "EXEC app_core.refresh_order_totals_v2",
      "EXEC app_core.old_refresh_order_totals",
      "EXEC refreshXorder_totals",
    ])
      expect(callsObject(cmd, "refresh_order_totals")).toBe(false);
  });

  it("looks only at this database's T-SQL steps, and keeps whole-name matches", async () => {
    h.msRecordsets = [
      [
        {
          id: "28741445-2C81-4DE3-8FE9-BB30B243DD28",
          name: "recalc",
          command: "EXEC app_core.refresh_order_totals",
        },
        {
          id: "38741445-2C81-4DE3-8FE9-BB30B243DD28",
          name: "v2",
          command: "EXEC app_core.refresh_order_totals_v2",
        },
      ],
    ];
    expect(await getJobsCalling(ms, "refresh_order_totals")).toEqual([
      { id: "28741445-2c81-4de3-8fe9-bb30b243dd28", name: "recalc" },
    ]);
    expect(h.msSql).toContain(
      "s.database_name = DB_NAME() AND s.subsystem = 'TSQL'",
    );
    h.msRecordsets = null;
  });

  it("is empty, not an error, when jobs can't be read", async () => {
    h.msError = Object.assign(new Error("denied"), { number: 229 });
    expect(await getJobsCalling(ms, "x")).toEqual([]);
    h.pgError = Object.assign(new Error("denied"), { code: "42501" });
    expect(await getJobsCalling(pg, "x")).toEqual([]);
  });
});
