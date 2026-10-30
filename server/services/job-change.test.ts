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
