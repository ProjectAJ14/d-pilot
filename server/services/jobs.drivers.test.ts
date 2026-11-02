import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ConnectionConfig } from "../types/index.js";

// Pools stand in for the drivers: each test sets what the server answers.
const h = vi.hoisted(() => ({
  ms: (_sql: string): any => ({ recordsets: [] }),
  pg: (_sql: string, _p?: unknown[]): any => ({ rows: [], rowCount: 0 }),
  log: [] as string[],
}));
vi.mock("./schema-introspector.js", () => ({
  introspectMssqlPool: () => ({
    connect: async () => h.log.push("connect"),
    close: async () => h.log.push("close"),
    request: () => ({
      input(name: string, _t: unknown, v: unknown) {
        h.log.push(`input ${name}=${v}`);
        return this;
      },
      query: async (sql: string) => h.ms(sql),
    }),
  }),
  introspectPgPool: () => ({
    query: async (sql: string, p?: unknown[]) => h.pg(sql, p),
    end: async () => h.log.push("end"),
  }),
}));

const {
  getJobs,
  getJobDetail,
  getJobsCalling,
  getJobDefinitions,
  JobAccessError,
  AGENT_GRANT,
  PG_CRON_GRANT,
  OTHER_DB_STEP,
} = await import("./jobs.js");

const ms = {
  id: "m",
  type: "mssql",
  env: "QA",
  database: "app_core",
} as ConnectionConfig;
const pg = {
  id: "p",
  type: "postgres",
  env: "QA",
  database: "app_core",
} as ConnectionConfig;
const mongo = { id: "x", type: "mongodb", env: "QA" } as ConnectionConfig;

const GUID = "28741445-2C81-4DE3-8FE9-BB30B243DD28";
const daily = {
  freq_type: 4,
  freq_interval: 1,
  freq_subday_type: 1,
  freq_subday_interval: 0,
  freq_relative_interval: 0,
  freq_recurrence_factor: 0,
  active_start_date: 20260101,
  active_start_time: 23000,
  active_end_time: 235959,
};
const pgWithCron = (
  answer: (sql: string, p?: unknown[]) => any,
  installed = true,
) => {
  h.pg = (sql, p) =>
    sql.includes("pg_extension")
      ? { rowCount: installed ? 1 : 0, rows: [] }
      : answer(sql, p);
};

beforeEach(() => {
  h.log = [];
});

describe("getJobs", () => {
  it("has no jobs on other engines", async () => {
    expect(await getJobs(mongo)).toEqual({ available: false, jobs: [] });
  });

  it("lists Agent jobs with their enabled schedules and last outcome", async () => {
    h.ms = () => ({
      recordsets: [
        [
          {
            job_id: GUID,
            name: "nightly",
            enabled: 1,
            description: "Recalculates totals",
            category: "Maintenance",
            step_count: 2,
            run_status: 1,
            run_date: 20261030,
            run_time: 20000,
            run_duration: 105,
            message: "ok",
            next_run: "2026-10-31 02:00:00",
          },
          {
            job_id: "AAAAAAAA-0000-0000-0000-000000000000",
            name: "idle",
            enabled: 0,
            description: "No description available.",
            category: "Uncategorized",
            step_count: 1,
            run_status: null,
            next_run: null,
          },
        ],
        [
          { job_id: GUID, ...daily },
          { job_id: GUID.toLowerCase(), ...daily, active_start_time: 140000 },
        ],
      ],
    });
    expect(await getJobs(ms)).toEqual({
      available: true,
      jobs: [
        {
          id: GUID.toLowerCase(),
          name: "nightly",
          engine: "agent",
          enabled: true,
          description: "Recalculates totals",
          category: "Maintenance",
          schedule: "Daily, at 02:30; Daily, at 14:00",
          lastRun: {
            status: "succeeded",
            startedAt: "2026-10-30 02:00:00",
            durationSec: 65,
            message: "ok",
          },
          nextRunAt: "2026-10-31 02:00:00",
          stepCount: 2,
        },
        {
          id: "aaaaaaaa-0000-0000-0000-000000000000",
          name: "idle",
          engine: "agent",
          enabled: false,
          category: "Uncategorized",
          lastRun: undefined,
          nextRunAt: null,
          stepCount: 1,
        },
      ],
    });
    expect(h.log).toEqual(["connect", "input job=null", "close"]);
  });

  it("names the grant when msdb is missing, by the nested error number too", async () => {
    h.ms = () => {
      throw Object.assign(new Error("Invalid object name"), {
        originalError: { info: { number: 208 } },
      });
    };
    expect((await getJobs(ms)).available).toBe(false);
    expect(h.log).toContain("close");
  });

  it("rethrows an Agent error that is not about access", async () => {
    h.ms = () => {
      throw new Error("socket closed");
    };
    await expect(getJobs(ms)).rejects.toThrow("socket closed");
  });

  it("lists pg_cron jobs, reading run states on Agent's scale", async () => {
    const t0 = new Date("2026-10-30T02:00:00.000Z");
    const t1 = new Date("2026-10-30T02:00:01.600Z");
    pgWithCron((_sql, p) => {
      expect(p).toEqual([null]);
      return {
        rows: [
          {
            jobid: 3,
            jobname: "recalc",
            schedule: "0 2 * * *",
            active: true,
            status: "succeeded",
            start_time: t0,
            end_time: t1,
            return_message: "CALL",
          },
          { jobid: 4, jobname: null, schedule: "@daily", active: false },
          {
            jobid: 5,
            jobname: "f",
            schedule: "x",
            active: true,
            status: "failed",
            start_time: t0,
            end_time: null,
          },
          {
            jobid: 6,
            jobname: "r",
            schedule: "x",
            active: true,
            status: "starting",
            start_time: null,
          },
        ],
      };
    });
    const res = await getJobs(pg);
    expect(res.available).toBe(true);
    expect(res.jobs[0]).toEqual({
      id: "3",
      name: "recalc",
      engine: "pg_cron",
      enabled: true,
      schedule: "0 2 * * *",
      lastRun: {
        status: "succeeded",
        startedAt: "2026-10-30 02:00:00",
        durationSec: 2,
        message: "CALL",
      },
      nextRunAt: null,
      stepCount: 1,
    });
    expect(res.jobs[1]).toMatchObject({
      id: "4",
      name: "job 4",
      enabled: false,
      lastRun: undefined,
    });
    expect(res.jobs[2].lastRun).toEqual({
      status: "failed",
      startedAt: "2026-10-30 02:00:00",
      durationSec: null,
    });
    expect(res.jobs[3].lastRun).toEqual({
      status: "running",
      startedAt: null,
      durationSec: null,
    });
    expect(h.log).toEqual(["end"]);
  });

  it("is unavailable, not an error, without the pg_cron extension", async () => {
    pgWithCron(() => {
      throw new Error("never asked");
    }, false);
    expect(await getJobs(pg)).toEqual({ available: false, jobs: [] });
    expect(h.log).toEqual(["end"]);
  });
});

describe("getJobDetail", () => {
  it("returns null on other engines and for a job not found", async () => {
    expect(await getJobDetail(mongo, "1")).toBeNull();
    h.ms = () => ({ recordsets: [[], [], [], []] });
    expect(await getJobDetail(ms, GUID)).toBeNull();
    pgWithCron(() => ({ rows: [] }));
    expect(await getJobDetail(pg, "9")).toBeNull();
    pgWithCron(() => ({ rows: [] }), false);
    expect(await getJobDetail(pg, "9")).toBeNull();
  });

  it("reads an Agent job's steps, schedules and history", async () => {
    h.ms = () => ({
      recordsets: [
        [
          {
            job_id: GUID,
            name: "nightly",
            enabled: 1,
            description: null,
            category: "c",
            step_count: 2,
            run_status: 0,
            run_date: 20261030,
            run_time: 0,
            run_duration: 1,
            message: null,
          },
        ],
        [
          {
            step_id: 1,
            step_name: "run",
            subsystem: "TSQL",
            database_name: "app_core",
            other_db: 0,
            command: "EXEC dbo.recalc",
            run_status: null,
          },
          {
            step_id: 2,
            step_name: "shell",
            subsystem: "CmdExec",
            database_name: null,
            other_db: 0,
            command: "dir",
            run_status: 1,
            run_date: 20261030,
            run_time: 10,
            run_duration: 0,
          },
        ],
        [
          {
            schedule_id: 8,
            name: "s",
            enabled: 1,
            shared_with: 0,
            ...daily,
          },
          {
            schedule_id: 9,
            name: "off",
            enabled: 0,
            shared_with: 1,
            ...daily,
            freq_type: 64,
          },
        ],
        [{ run_status: 1, run_date: 20261029, run_time: 0, run_duration: 2 }],
      ],
    });
    const job = await getJobDetail(ms, GUID);
    expect(job).toMatchObject({
      id: GUID.toLowerCase(),
      schedule: "Daily, at 02:30",
      database: "app_core",
      lastRun: { status: "failed", durationSec: 1 },
      history: [
        {
          status: "succeeded",
          startedAt: "2026-10-29 00:00:00",
          durationSec: 2,
        },
      ],
    });
    expect(job!.description).toBeUndefined();
    expect(job!.steps).toEqual([
      {
        id: 1,
        name: "run",
        subsystem: "TSQL",
        command: "EXEC dbo.recalc",
        database: "app_core",
        lastRun: undefined,
      },
      {
        id: 2,
        name: "shell",
        subsystem: "CmdExec",
        command: "dir",
        lastRun: {
          status: "succeeded",
          startedAt: "2026-10-30 00:00:10",
          durationSec: 0,
        },
      },
    ]);
    expect(job!.schedules).toEqual([
      {
        id: "8",
        name: "s",
        enabled: true,
        description: "Daily, at 02:30",
        sharedWith: 0,
        editable: true,
        msdb: daily,
      },
      {
        id: "9",
        name: "off",
        enabled: false,
        description: "When SQL Server Agent starts",
        sharedWith: 1,
        editable: false,
        msdb: { ...daily, freq_type: 64 },
      },
    ]);
    expect(h.log).toContain(`input job=${GUID}`);
  });

  it("reads a pg_cron job as one step with one schedule", async () => {
    const t = new Date("2026-10-30T02:00:00.000Z");
    pgWithCron((sql, p) => {
      expect(p).toEqual(["7"]);
      return sql.includes("LIMIT 20")
        ? {
            rows: [
              { status: "succeeded", start_time: t, end_time: t },
              { status: null },
            ],
          }
        : {
            rows: [
              {
                jobid: 7,
                jobname: null,
                schedule: "*/5 * * * *",
                command: "CALL app_core.recalc()",
                database: "app_core",
                active: false,
              },
            ],
          };
    });
    expect(await getJobDetail(pg, "7")).toEqual({
      id: "7",
      name: "job 7",
      engine: "pg_cron",
      enabled: false,
      schedule: "*/5 * * * *",
      lastRun: undefined,
      nextRunAt: null,
      stepCount: 1,
      database: "app_core",
      steps: [
        {
          id: 1,
          name: "command",
          subsystem: "SQL",
          command: "CALL app_core.recalc()",
          database: "app_core",
          lastRun: undefined,
        },
      ],
      schedules: [
        {
          id: "7",
          name: "*/5 * * * *",
          enabled: false,
          description: "*/5 * * * *",
          sharedWith: 0,
          editable: true,
          cron: "*/5 * * * *",
        },
      ],
      history: [
        {
          status: "succeeded",
          startedAt: "2026-10-30 02:00:00",
          durationSec: 0,
        },
        undefined,
      ],
    });
  });

  it("names a step by its job when pg_cron has one", async () => {
    pgWithCron((sql) =>
      sql.includes("LIMIT 20")
        ? { rows: [] }
        : { rows: [{ jobid: 7, jobname: "recalc", schedule: "x" }] },
    );
    expect((await getJobDetail(pg, "7"))!.steps[0].name).toBe("recalc");
  });

  it("rethrows errors that are not about access", async () => {
    pgWithCron(() => {
      throw new Error("boom");
    });
    await expect(getJobDetail(pg, "7")).rejects.toThrow("boom");
    h.ms = () => {
      throw Object.assign(new Error("denied"), { code: "42501" });
    };
    await expect(getJobDetail(ms, GUID)).rejects.not.toBeInstanceOf(
      JobAccessError,
    );
    h.ms = () => {
      throw undefined;
    };
    await expect(getJobDetail(ms, GUID)).rejects.toBeUndefined();
  });
});

describe("getJobsCalling", () => {
  it("escapes LIKE wildcards for SQL Server", async () => {
    h.ms = () => ({ recordset: [] });
    expect(await getJobsCalling(ms, "order_[x]%")).toEqual([]);
    expect(h.log).toContain("input like=%order[_][[]x[]][%]%");
  });

  it("finds pg_cron jobs by name, and none without the extension", async () => {
    pgWithCron((_sql, p) => {
      expect(p).toEqual(["recalc"]);
      return {
        rows: [
          { id: "3", name: "a", command: "CALL app_core.recalc()" },
          { id: "4", name: "b", command: "CALL app_core.recalc_all()" },
        ],
      };
    });
    expect(await getJobsCalling(pg, "recalc")).toEqual([
      { id: "3", name: "a" },
    ]);
    pgWithCron(() => ({ rows: [] }), false);
    expect(await getJobsCalling(pg, "recalc")).toEqual([]);
    expect(await getJobsCalling(mongo, "recalc")).toEqual([]);
  });
});

describe("getJobDefinitions", () => {
  it("has none on other engines", async () => {
    expect(await getJobDefinitions(mongo)).toEqual({
      available: false,
      jobs: [],
    });
  });

  it("writes each Agent job as its enabled schedules and steps, hiding another database's command", async () => {
    let sql = "";
    h.ms = (q) => {
      sql = q;
      return {
        recordsets: [
          [
            {
              job_id: GUID,
              name: "nightly",
              step_id: 1,
              step_name: "recalc",
              subsystem: "TSQL",
              other_db: 0,
              command: "EXEC app_core.refresh_order_totals",
            },
            {
              job_id: GUID,
              name: "nightly",
              step_id: 2,
              step_name: "archive",
              subsystem: "TSQL",
              other_db: 1,
              command: null,
            },
            {
              job_id: "AAAAAAAA-0000-0000-0000-000000000000",
              name: "adhoc",
              step_id: 1,
              step_name: "run",
              subsystem: "TSQL",
              other_db: 0,
              command: "SELECT 1",
            },
          ],
          // Listed in either order, a job's schedules read the same.
          [
            { job_id: GUID, ...daily, active_start_time: 140000 },
            { job_id: GUID.toLowerCase(), ...daily },
          ],
        ],
      };
    };
    expect(await getJobDefinitions(ms)).toEqual({
      available: true,
      jobs: [
        {
          id: GUID.toLowerCase(),
          name: "nightly",
          definition: `schedule: Daily, at 02:30; Daily, at 14:00\n\nstep 1 recalc [TSQL]\nEXEC app_core.refresh_order_totals\n\nstep 2 archive [TSQL]\n${OTHER_DB_STEP}`,
        },
        {
          id: "aaaaaaaa-0000-0000-0000-000000000000",
          name: "adhoc",
          definition: "schedule: \n\nstep 1 run [TSQL]\nSELECT 1",
        },
      ],
    });
    // Only jobs on this database, and only enabled schedules.
    expect(sql).toContain("x.database_name = DB_NAME()");
    expect(sql).toContain("sc.enabled = 1");
    expect(sql).toContain(
      "x.job_id = js.job_id AND x.database_name = DB_NAME()",
    );
    expect(h.log).toEqual(["connect", "close"]);
  });

  it("names the msdb grant, and rethrows anything else", async () => {
    h.ms = () => {
      throw Object.assign(new Error("denied"), { number: 229 });
    };
    expect(await getJobDefinitions(ms)).toEqual({
      available: false,
      reason: AGENT_GRANT,
      jobs: [],
    });
    h.ms = () => {
      throw new Error("timeout");
    };
    await expect(getJobDefinitions(ms)).rejects.toThrow("timeout");
  });

  it("writes each pg_cron job as its schedule and command", async () => {
    pgWithCron((sql) => {
      expect(sql).toContain("database = current_database()");
      return {
        rows: [
          {
            jobid: 7,
            jobname: "vacuum",
            schedule: "0 3 * * *",
            command: "VACUUM orders",
          },
          {
            jobid: 8,
            jobname: null,
            schedule: "*/5 * * * *",
            command: "SELECT 1",
          },
        ],
      };
    });
    expect(await getJobDefinitions(pg)).toEqual({
      available: true,
      jobs: [
        {
          id: "7",
          name: "vacuum",
          definition: "schedule: 0 3 * * *\n\nVACUUM orders",
        },
        {
          id: "8",
          name: "(unnamed) SELECT 1",
          definition: "schedule: */5 * * * *\n\nSELECT 1",
        },
      ],
    });
  });

  it("has none without pg_cron, names its grant, and rethrows anything else", async () => {
    pgWithCron(() => ({ rows: [] }), false);
    expect(await getJobDefinitions(pg)).toEqual({ available: false, jobs: [] });
    pgWithCron(() => {
      throw Object.assign(new Error("denied"), { code: "42501" });
    });
    expect(await getJobDefinitions(pg)).toEqual({
      available: false,
      reason: PG_CRON_GRANT,
      jobs: [],
    });
    pgWithCron(() => {
      throw new Error("reset");
    });
    await expect(getJobDefinitions(pg)).rejects.toThrow("reset");
  });
});
