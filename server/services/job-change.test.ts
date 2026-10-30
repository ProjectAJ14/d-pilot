import { describe, it, expect } from "vitest";
import {
  buildJobChangeSql,
  checkJobCommand,
  jobCommandRoutines,
  jobSnapshot,
  validateJobChange,
} from "./job-change.js";
import type { JobDetail } from "../types/index.js";

const agentJob: JobDetail = {
  id: "28741445-2c81-4de3-8fe9-bb30b243dd28",
  name: "recalc due dates",
  engine: "agent",
  enabled: true,
  stepCount: 3,
  database: "app_core",
  steps: [
    {
      id: 1,
      name: "run proc",
      subsystem: "TSQL",
      command: "EXEC app_core.refresh_order_totals",
      database: "app_core",
    },
    { id: 2, name: "cleanup", subsystem: "CmdExec", command: "del C:\\tmp\\*" },
  ],
  schedules: [
    {
      id: "8",
      name: "s",
      enabled: true,
      description: "",
      sharedWith: 0,
      editable: true,
    },
    {
      id: "10",
      name: "shared",
      enabled: true,
      description: "",
      sharedWith: 2,
      editable: true,
    },
    {
      id: "9",
      name: "r",
      enabled: true,
      description: "",
      sharedWith: 0,
      editable: false,
    },
  ],
  history: [],
};
/** The same job with a step that runs against another database. */
const foreignJob: JobDetail = {
  ...agentJob,
  steps: [
    ...agentJob.steps,
    {
      id: 3,
      name: "elsewhere",
      subsystem: "TSQL",
      command: "-- hidden",
      database: "billing",
    },
  ],
};
const cronJob: JobDetail = {
  ...agentJob,
  id: "12",
  engine: "pg_cron",
  steps: [
    {
      id: 1,
      name: "recalc",
      subsystem: "SQL",
      command: "CALL app_core.recalc()",
      database: "app_core",
    },
  ],
  schedules: [
    {
      id: "12",
      name: "*/30 * * * *",
      enabled: true,
      description: "",
      sharedWith: 0,
      editable: true,
      cron: "*/30 * * * *",
    },
  ],
};

describe("checkJobCommand", () => {
  it.each([
    "EXEC app_core.refresh_order_totals",
    "EXEC app_core.refresh_order_totals @days = 7; EXEC app_core.notify",
    "UPDATE app_core.orders SET due_date = GETDATE() WHERE status = 'placed'",
    "INSERT INTO app_core.audit (at) VALUES (GETDATE()); DELETE FROM app_core.audit WHERE at < '2020-01-01'",
  ])("accepts %s", (cmd) => {
    expect(checkJobCommand(cmd, "mssql")).toBeNull();
  });

  it("accepts Postgres maintenance and CALL", () => {
    expect(
      checkJobCommand("VACUUM ANALYZE app_core.orders", "postgres"),
    ).toBeNull();
    expect(
      checkJobCommand(
        "REFRESH MATERIALIZED VIEW app_core.order_totals",
        "postgres",
      ),
    ).toBeNull();
    expect(checkJobCommand("CALL app_core.recalc()", "postgres")).toBeNull();
  });

  it("accepts one call with literal, variable, named and output arguments", () => {
    for (const cmd of [
      "EXEC [app_core].[refresh_order_totals] @days = 7, @note = N'it''s; -- fine', @out = @x OUTPUT",
      "EXECUTE @rc = app_core.refresh_order_totals 7, NULL, DEFAULT;",
      "SELECT app_core.recalc(1, 'a)b')",
    ])
      expect(checkJobCommand(cmd, "mssql")).toBeNull();
    expect(
      checkJobCommand("CALL app_core.recalc($$x$$, 2);", "postgres"),
    ).toBeNull();
  });

  it("refuses Postgres administration functions, nested calls and expressions", () => {
    const why = (cmd: string) => checkJobCommand(cmd, "postgres");
    expect(why("SELECT pg_terminate_backend(123)")).toContain("system");
    expect(why("SELECT pg_catalog.pg_read_file('/etc/passwd')")).toContain(
      "system",
    );
    expect(why("SELECT set_config('role', 'postgres', false)")).toContain(
      "system",
    );
    // Only literal arguments: nothing else can run inside the call.
    for (const cmd of [
      "SELECT app_core.f(pg_cancel_backend(1))",
      'SELECT app_core.f("pg_terminate_backend"(1))',
      "SELECT app_core.f(E'\\''||pg_terminate_backend(1)::text||E'\\'')",
      "SELECT app_core.f((SELECT 1))",
      "SELECT app_core.f(1 + 1)",
    ])
      expect(why(cmd)).toContain("literal arguments");
    // A Postgres job runs with its own search_path.
    expect(why("CALL recalc()")).toContain("Qualify");
    expect(
      why("CALL app_core.recalc('2026-01-01'::date, p_days => 7)"),
    ).toBeNull();
  });

  it("refuses a quoted name the checker and the engine would read differently", () => {
    expect(
      checkJobCommand("EXEC dbo.[get_order'];SHUTDOWN--']", "mssql"),
    ).toContain("can't be checked");
    expect(
      checkJobCommand(
        "UPDATE dbo.[t'] SET a = 1 WHERE id = 1; DROP TABLE x --']",
        "mssql",
      ),
    ).toContain("can't be checked");
    expect(
      checkJobCommand('CALL "app_core"."re""calc"()', "postgres"),
    ).toContain("can't be checked");
    // Bracketed names without such characters are fine.
    expect(
      checkJobCommand("EXEC [app_core].[refresh_order_totals] 7", "mssql"),
    ).toBeNull();
  });

  it("allows a cast only to a plain type name", () => {
    const why = (cmd: string) => checkJobCommand(cmd, "postgres");
    expect(
      why("SELECT app_core.f(1::bool or pg_terminate_backend(1))"),
    ).toContain("literal arguments");
    expect(
      why(
        "CALL app_core.f('2026-01-01'::timestamp with time zone, 'x'::character varying(10), '{1}'::int[])",
      ),
    ).toBeNull();
  });

  it("sends every non-trivial function a write calls to the catalog check", () => {
    expect(
      jobCommandRoutines(
        "UPDATE app_core.orders SET notes = query_to_xml('select 1', true, true, '') WHERE id = 1",
        "postgres",
      ),
    ).toEqual(["query_to_xml"]);
    expect(
      jobCommandRoutines(
        "UPDATE app_core.orders SET notes = OPENROWSET('SQLNCLI', 'x', 'select 1') WHERE id = 1",
        "mssql",
      ),
    ).toEqual(["OPENROWSET"]);
    expect(
      jobCommandRoutines(
        "INSERT INTO app_core.audit (at, n) VALUES (now(), coalesce(1, 2)); UPDATE app_core.orders SET due = DATEADD(day, 1, GETDATE()), total = app_core.total_for(id) WHERE id IN (1, 2) AND EXISTS (SELECT 1)",
        "mssql",
      ),
    ).toEqual(["app_core.total_for"]);
  });

  it("names the routines a command calls, for the catalog check", () => {
    expect(
      jobCommandRoutines(
        "EXEC [app_core].[refresh_order_totals] 7; EXEC dbo.sp_ProcessOrders",
        "mssql",
      ),
    ).toEqual(["[app_core].[refresh_order_totals]", "dbo.sp_ProcessOrders"]);
    expect(
      jobCommandRoutines("SELECT query_to_xml.x('q', true)", "postgres"),
    ).toEqual(["query_to_xml.x"]);
  });

  it("refuses SQL handed to a function as a string", () => {
    expect(
      checkJobCommand(
        "SELECT dblink_exec('dbname=app', 'UPDATE app_core.orders SET status = 1')",
        "postgres",
      ),
    ).toContain("not inside a call or a string");
  });

  it.each([
    ["UPDATE app_core.orders SET status = 'x'", "without a WHERE"],
    ["DELETE FROM app_core.orders", "without a WHERE"],
    ["TRUNCATE TABLE app_core.orders", "DDL"],
    ["EXEC app_core.p; DROP TABLE app_core.orders", "DDL"],
    [
      "EXEC app_core.p; UPDATE app_core.orders SET status = 'x' WHERE id = 1 UPDATE app_core.orders SET status = 'y'",
      "semicolon",
    ],
    [
      "EXEC sp_executesql N'UPDATE app_core.orders SET status = 1'",
      "Dynamic SQL",
    ],
    [
      "IF 1 = 1 UPDATE app_core.orders SET status = 'x' WHERE id = 1",
      "can't be checked",
    ],
    [
      "MERGE app_core.orders AS t USING src ON 1=1 WHEN MATCHED THEN DELETE;",
      "Only INSERT, UPDATE and DELETE",
    ],
    ["", "empty"],
    // A routine call is exactly one call: no trailing T-SQL statements, no
    // system or administration routines.
    ["EXEC master..xp_cmdshell 'whoami'", "system and administration"],
    ["EXECUTE AS LOGIN = 'sa'", "one routine with literal arguments"],
    [
      "EXEC dbo.refresh SHUTDOWN WITH NOWAIT",
      "one routine with literal arguments",
    ],
    ["EXEC app_core.p 'x' SHUTDOWN", "one routine with literal arguments"],
    ["SELECT 1 KILL 52", "one routine with literal arguments"],
    ["SELECT 1 DBCC SHRINKDATABASE(0)", "one routine with literal arguments"],
    [
      "EXEC dbo.p1 BACKUP DATABASE app_core TO DISK = 'x'",
      "one routine with literal arguments",
    ],
    [
      "SELECT * INTO dbo.copy FROM dbo.orders",
      "one routine with literal arguments",
    ],
    [
      "SELECT app_core.f(1) FROM app_core.orders",
      "one routine with literal arguments",
    ],
  ])("refuses %s", (cmd, why) => {
    expect(checkJobCommand(cmd, "mssql")).toContain(why);
  });
});

describe("validateJobChange", () => {
  it.each([
    [{ type: "edit_step", stepId: 2, command: "EXEC p" }, "CmdExec step"],
    [
      { type: "edit_step", stepId: 1, command: "DELETE FROM app_core.orders" },
      "without a WHERE",
    ],
    [{ type: "set_enabled", enabled: true }, "already enabled"],
    [{ type: "set_schedule", scheduleId: "9", msdb: {} }, "read-only"],
    [{ type: "set_schedule", scheduleId: "7", msdb: {} }, "not attached"],
    // Its other jobs may be another database's; their run time is not ours.
    [{ type: "set_schedule", scheduleId: "10", msdb: {} }, "shared with 2"],
    [
      {
        type: "set_schedule",
        scheduleId: "8",
        msdb: {
          freq_type: 8,
          freq_interval: 0,
          freq_subday_type: 1,
          freq_subday_interval: 0,
          freq_recurrence_factor: 1,
          active_start_time: 60000,
          active_end_time: 235959,
        },
      },
      "at least one weekday",
    ],
    [
      {
        type: "set_schedule",
        scheduleId: "8",
        msdb: {
          freq_type: 4,
          freq_interval: 1,
          freq_subday_type: 4,
          freq_subday_interval: 30,
          freq_recurrence_factor: 0,
          active_start_time: 66000,
          active_end_time: 220000,
        },
      },
      "HHMMSS",
    ],
  ])("refuses %j", (action, why) => {
    expect(validateJobChange(action as any, agentJob, "mssql")).toContain(why);
  });

  it("on a job that also runs on another database, allows only this database's own step edits", () => {
    for (const action of [
      { type: "set_enabled", enabled: false },
      { type: "rename", name: "x" },
      { type: "set_description", description: "x" },
      { type: "add_step", name: "n", command: "EXEC p" },
      { type: "delete_step", stepId: 1 },
      { type: "edit_step", stepId: 3, command: "EXEC p" },
    ])
      expect(validateJobChange(action as any, foreignJob, "mssql")).toContain(
        "another database",
      );
    expect(
      validateJobChange(
        { type: "edit_step", stepId: 1, command: "EXEC app_core.p" },
        foreignJob,
        "mssql",
      ),
    ).toBeNull();
  });

  it("treats a step database that differs only in case as this one", () => {
    const job = {
      ...agentJob,
      database: "AppCore",
      steps: agentJob.steps.map((st) =>
        st.database ? { ...st, database: "appcore" } : st,
      ),
    };
    expect(
      validateJobChange({ type: "rename", name: "x" }, job, "mssql"),
    ).toBeNull();
  });

  it("keeps pg_cron to what cron.alter_job can do", () => {
    expect(
      validateJobChange({ type: "rename", name: "x" }, cronJob, "postgres"),
    ).toContain("pg_cron");
    expect(
      validateJobChange(
        { type: "set_schedule", scheduleId: "12", cron: "every day" },
        cronJob,
        "postgres",
      ),
    ).toContain("cron expression");
    expect(
      validateJobChange(
        { type: "set_schedule", scheduleId: "12", cron: "0 2 * * 1-5" },
        cronJob,
        "postgres",
      ),
    ).toBeNull();
    expect(
      validateJobChange(
        { type: "set_schedule", scheduleId: "12", cron: "30 seconds" },
        cronJob,
        "postgres",
      ),
    ).toBeNull();
  });
});

describe("buildJobChangeSql", () => {
  it("quotes every value and inlines only validated ids", () => {
    expect(
      buildJobChangeSql(
        {
          type: "edit_step",
          stepId: 1,
          command: "EXEC app_core.p @note = 'it''s'",
        },
        agentJob,
      ),
    ).toBe(
      "EXEC msdb.dbo.sp_update_jobstep @job_id = N'28741445-2c81-4de3-8fe9-bb30b243dd28', @step_id = 1, @command = N'EXEC app_core.p @note = ''it''''s''';",
    );
    expect(
      buildJobChangeSql(
        { type: "rename", name: "x'; DROP TABLE t;--" },
        agentJob,
      ),
    ).toBe(
      "EXEC msdb.dbo.sp_update_job @job_id = N'28741445-2c81-4de3-8fe9-bb30b243dd28', @new_name = N'x''; DROP TABLE t;--';",
    );
    expect(
      buildJobChangeSql(
        { type: "add_step", name: "n", command: "EXEC p" },
        agentJob,
      ),
    ).toContain("@subsystem = N'TSQL', @database_name = N'app_core'");
  });

  it("drives pg_cron through cron.alter_job", () => {
    expect(
      buildJobChangeSql({ type: "set_enabled", enabled: false }, cronJob),
    ).toBe("SELECT cron.alter_job(job_id := 12, active := false);");
    expect(
      buildJobChangeSql(
        { type: "edit_step", stepId: 1, command: "CALL app_core.recalc('x')" },
        cronJob,
      ),
    ).toBe(
      "SELECT cron.alter_job(job_id := 12, command := 'CALL app_core.recalc(''x'')');",
    );
  });
});

describe("jobSnapshot", () => {
  it("changes when anything a change could collide with changes", () => {
    const a = jobSnapshot(agentJob);
    expect(
      jobSnapshot({
        ...agentJob,
        history: [{ status: "failed", startedAt: null, durationSec: 1 }],
      }),
    ).toBe(a);
    expect(jobSnapshot({ ...agentJob, enabled: false })).not.toBe(a);
    expect(
      jobSnapshot({
        ...agentJob,
        steps: agentJob.steps.map((s) => ({ ...s, command: s.command + " " })),
      }),
    ).not.toBe(a);
  });
});
