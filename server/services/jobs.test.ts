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
              if (h.msRecordsets) return { recordsets: h.msRecordsets };
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
