import { describe, it, expect } from "vitest";
import {
  buildJobChangeSql,
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

describe("validateJobChange", () => {
  it.each([
    [{ type: "edit_step", stepId: 2, command: "EXEC p" }, "CmdExec step"],
    // What a command runs is the engine's to check (job-step.ts); here only
    // that there is one.
    [{ type: "edit_step", stepId: 1, command: "  " }, "empty"],
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
    expect(validateJobChange(action as any, agentJob)).toContain(why);
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
      expect(validateJobChange(action as any, foreignJob)).toContain(
        "another database",
      );
    expect(
      validateJobChange(
        { type: "edit_step", stepId: 1, command: "EXEC app_core.p" },
        foreignJob,
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
    expect(validateJobChange({ type: "rename", name: "x" }, job)).toBeNull();
  });

  it("keeps pg_cron to what cron.alter_job can do", () => {
    expect(validateJobChange({ type: "rename", name: "x" }, cronJob)).toContain(
      "pg_cron",
    );
    expect(
      validateJobChange(
        { type: "set_schedule", scheduleId: "12", cron: "every day" },
        cronJob,
      ),
    ).toContain("cron expression");
    expect(
      validateJobChange(
        { type: "set_schedule", scheduleId: "12", cron: "0 2 * * 1-5" },
        cronJob,
      ),
    ).toBeNull();
    expect(
      validateJobChange(
        { type: "set_schedule", scheduleId: "12", cron: "30 seconds" },
        cronJob,
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
      "EXEC msdb.dbo.sp_update_jobstep @job_id = N'28741445-2c81-4de3-8fe9-bb30b243dd28', @step_id = 1, @database_name = N'app_core', @command = N'EXEC app_core.p @note = ''it''''s''';",
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

const ms = (over: Record<string, unknown> = {}) => ({
  freq_type: 4,
  freq_interval: 1,
  freq_subday_type: 1,
  freq_subday_interval: 0,
  freq_recurrence_factor: 0,
  active_start_time: 60000,
  active_end_time: 235959,
  ...over,
});
const sched = (msdb: unknown) =>
  validateJobChange(
    { type: "set_schedule", scheduleId: "8", msdb } as never,
    agentJob,
  );

describe("validateJobChange: SQL Server Agent schedules", () => {
  it("accepts a valid daily, weekly or monthly schedule", () => {
    expect(sched(ms())).toBeNull();
    expect(
      sched(ms({ freq_type: 8, freq_interval: 62, freq_recurrence_factor: 1 })),
    ).toBeNull();
    expect(
      sched(
        ms({
          freq_type: 16,
          freq_interval: 31,
          freq_recurrence_factor: 2,
          freq_subday_type: 8,
          freq_subday_interval: 23,
        }),
      ),
    ).toBeNull();
  });

  it.each([
    [undefined, "needs its msdb fields"],
    [ms({ freq_interval: 1.5 }), "must be integers"],
    [ms({ freq_type: 32 }), "Only daily, weekly or monthly"],
    [ms({ freq_interval: 0 }), "every 1–365 days"],
    [ms({ freq_interval: 366 }), "every 1–365 days"],
    [ms({ freq_type: 8, freq_interval: 128 }), "at least one weekday"],
    [ms({ freq_type: 16, freq_interval: 0 }), "a day from 1 to 31"],
    [ms({ freq_type: 16, freq_interval: 32 }), "a day from 1 to 31"],
    [
      ms({ freq_type: 16, freq_interval: 1, freq_recurrence_factor: 0 }),
      "Repeat every 1 or more",
    ],
    [
      ms({ freq_subday_type: 4, freq_subday_interval: 0 }),
      "Every 1–1439 minutes",
    ],
    [
      ms({ freq_subday_type: 4, freq_subday_interval: 1440 }),
      "Every 1–1439 minutes",
    ],
    [ms({ freq_subday_type: 8, freq_subday_interval: 0 }), "Every 1–23 hours"],
    [ms({ freq_subday_type: 8, freq_subday_interval: 24 }), "Every 1–23 hours"],
    [ms({ active_start_time: -1 }), "HHMMSS"],
    [ms({ active_start_time: 240000 }), "HHMMSS"],
    [ms({ active_end_time: 235960 }), "HHMMSS"],
  ])("refuses %j", (msdb, why) => {
    expect(sched(msdb)).toContain(why);
  });

  it("says 'job' for a schedule shared with one other", () => {
    const job = {
      ...agentJob,
      schedules: [{ ...agentJob.schedules[0], sharedWith: 1 }],
    };
    expect(
      validateJobChange(
        { type: "set_schedule", scheduleId: "8", msdb: ms() },
        job,
      ),
    ).toContain("shared with 1 other job, so");
  });
});

describe("validateJobChange: actions", () => {
  it("checks set_enabled", () => {
    expect(
      validateJobChange({ type: "set_enabled", enabled: false }, agentJob),
    ).toBeNull();
    expect(
      validateJobChange(
        { type: "set_enabled", enabled: false },
        { ...agentJob, enabled: false },
      ),
    ).toBe("The job is already disabled.");
    expect(
      validateJobChange(
        { type: "set_enabled", enabled: "yes" } as never,
        agentJob,
      ),
    ).toBe("enabled must be true or false.");
  });

  it("checks rename and set_description", () => {
    expect(validateJobChange({ type: "rename", name: "x" }, agentJob)).toBe(
      null,
    );
    expect(validateJobChange({ type: "rename", name: " " }, agentJob)).toBe(
      "A name is required.",
    );
    expect(validateJobChange({ type: "rename" } as never, agentJob)).toBe(
      "A name is required.",
    );
    expect(
      validateJobChange({ type: "set_description", description: "" }, agentJob),
    ).toBeNull();
    expect(
      validateJobChange({ type: "set_description" } as never, agentJob),
    ).toBe("A description is required.");
    expect(
      validateJobChange({ type: "set_description", description: "x" }, cronJob),
    ).toContain("pg_cron");
  });

  it("checks delete_step", () => {
    expect(
      validateJobChange({ type: "delete_step", stepId: 1 }, cronJob),
    ).toContain("pg_cron");
    expect(
      validateJobChange({ type: "delete_step", stepId: 9 }, agentJob),
    ).toBe("Step 9 does not exist.");
    expect(
      validateJobChange({ type: "delete_step", stepId: 1 }, agentJob),
    ).toBeNull();
    expect(
      validateJobChange(
        { type: "delete_step", stepId: 1 },
        { ...agentJob, steps: [agentJob.steps[0]] },
      ),
    ).toBe("A job needs at least one step.");
    // A job with no own database: any step database is another one.
    expect(
      validateJobChange(
        { type: "delete_step", stepId: 1 },
        { ...agentJob, database: undefined, steps: [] },
      ),
    ).toBe("Step 1 does not exist.");
    expect(
      validateJobChange(
        { type: "rename", name: "x" },
        { ...agentJob, database: undefined },
      ),
    ).toContain("another database");
  });

  it("refuses deleting or editing a step on another database once the job is otherwise local", () => {
    // Not reached via `foreign` (which blocks first), so stub find: a step
    // whose database differs but the job-level check sees none.
    let calls = 0;
    const steps = [agentJob.steps[0]];
    const tricky = {
      ...agentJob,
      steps: Object.assign([...steps], {
        some: () => false,
        find: () => (calls++, { ...steps[0], database: "billing" }),
      }),
    } as unknown as JobDetail;
    expect(validateJobChange({ type: "delete_step", stepId: 1 }, tricky)).toBe(
      "That step runs against another database.",
    );
    expect(
      validateJobChange({ type: "edit_step", stepId: 1, command: "x" }, tricky),
    ).toBe("That step runs against another database.");
    expect(calls).toBe(2);
  });

  it("checks add_step and edit_step", () => {
    expect(
      validateJobChange({ type: "add_step", name: "n", command: "x" }, cronJob),
    ).toContain("pg_cron");
    expect(
      validateJobChange(
        { type: "add_step", name: " ", command: "x" },
        agentJob,
      ),
    ).toBe("A step name is required.");
    expect(
      validateJobChange({ type: "add_step", command: "x" } as never, agentJob),
    ).toBe("A step name is required.");
    expect(
      validateJobChange({ type: "add_step", name: "n" } as never, agentJob),
    ).toBe("The command is empty.");
    expect(
      validateJobChange(
        { type: "edit_step", stepId: 9, command: "x" },
        agentJob,
      ),
    ).toBe("Step 9 does not exist.");
    expect(
      validateJobChange(
        { type: "edit_step", stepId: 1, command: "x" },
        cronJob,
      ),
    ).toBeNull();
  });

  it("checks a pg_cron schedule and refuses unknown actions", () => {
    expect(
      validateJobChange({ type: "set_schedule", scheduleId: "12" }, cronJob),
    ).toContain("Not a cron expression");
    expect(
      validateJobChange(
        { type: "set_schedule", scheduleId: "12", cron: "@daily" },
        cronJob,
      ),
    ).toBeNull();
    expect(validateJobChange({ type: "nope" } as never, agentJob)).toBe(
      "Unknown job change.",
    );
  });
});

describe("buildJobChangeSql: every action", () => {
  const J = "@job_id = N'28741445-2c81-4de3-8fe9-bb30b243dd28'";
  it("writes each SQL Server Agent call", () => {
    expect(
      buildJobChangeSql({ type: "set_enabled", enabled: true }, agentJob),
    ).toBe(`EXEC msdb.dbo.sp_update_job ${J}, @enabled = 1;`);
    expect(
      buildJobChangeSql({ type: "set_enabled", enabled: false }, agentJob),
    ).toBe(`EXEC msdb.dbo.sp_update_job ${J}, @enabled = 0;`);
    expect(
      buildJobChangeSql(
        { type: "set_description", description: "it's" },
        agentJob,
      ),
    ).toBe(`EXEC msdb.dbo.sp_update_job ${J}, @description = N'it''s';`);
    expect(
      buildJobChangeSql({ type: "delete_step", stepId: 2 }, agentJob),
    ).toBe(`EXEC msdb.dbo.sp_delete_jobstep ${J}, @step_id = 2;`);
    expect(
      buildJobChangeSql(
        { type: "set_schedule", scheduleId: "8", msdb: ms() as never },
        agentJob,
      ),
    ).toBe(
      "EXEC msdb.dbo.sp_update_schedule @schedule_id = 8, @freq_type = 4, @freq_interval = 1, @freq_subday_type = 1, @freq_subday_interval = 0, @freq_recurrence_factor = 0, @active_start_time = 60000, @active_end_time = 235959;",
    );
  });

  it("sets a pg_cron schedule and refuses what alter_job can't do", () => {
    expect(
      buildJobChangeSql(
        { type: "set_schedule", scheduleId: "12", cron: " 0 2 * * * " },
        cronJob,
      ),
    ).toBe("SELECT cron.alter_job(job_id := 12, schedule := '0 2 * * *');");
    expect(() =>
      buildJobChangeSql({ type: "rename", name: "x" }, cronJob),
    ).toThrow("rename is not a pg_cron change");
  });
});

describe("jobSnapshot nulls", () => {
  it("writes missing optional fields as null", () => {
    const snap = JSON.parse(jobSnapshot(cronJob));
    expect(snap.description).toBeNull();
    expect(snap.schedules[0]).toEqual({
      id: "12",
      enabled: true,
      msdb: null,
      cron: "*/30 * * * *",
      sharedWith: 0,
    });
    const withMsdb = JSON.parse(
      jobSnapshot({
        ...agentJob,
        description: "d",
        schedules: [{ ...agentJob.schedules[0], msdb: ms() as never }],
      }),
    );
    expect(withMsdb.description).toBe("d");
    expect(withMsdb.schedules[0].msdb).toEqual(ms());
    expect(withMsdb.schedules[0].cron).toBeNull();
    expect(withMsdb.steps[1].database).toBeNull();
  });
});
