import { describe, it, expect } from "vitest";
import { describeJobAction } from "./job-action.js";

const msdb = {
  freq_type: 4,
  freq_interval: 1,
  freq_subday_type: 1,
  freq_subday_interval: 0,
  freq_recurrence_factor: 0,
  active_start_time: 23000,
  active_end_time: 235959,
};

describe("describeJobAction", () => {
  it.each([
    [{ type: "set_enabled", enabled: true }, "Enables the job"],
    [{ type: "set_enabled", enabled: false }, "Disables the job"],
    [{ type: "rename", name: "nightly" }, 'Renames the job to "nightly"'],
    [
      { type: "set_description", description: "x" },
      "Changes the job's description",
    ],
    [
      { type: "edit_step", stepId: 2, command: "SELECT 1" },
      "Changes the command of step 2",
    ],
    [{ type: "add_step", name: "load", command: "x" }, 'Adds step "load"'],
    [{ type: "delete_step", stepId: 3 }, "Deletes step 3"],
    [
      { type: "set_schedule", scheduleId: "1", cron: "0 2 * * *" },
      "Changes the schedule to: 0 2 * * *",
    ],
    [
      { type: "set_schedule", scheduleId: "1", msdb },
      "Changes the schedule to: Daily, at 02:30",
    ],
    [{ type: "set_schedule", scheduleId: "1" }, "Changes the schedule to: ?"],
  ] as const)("%#: %s", (action, text) => {
    expect(describeJobAction(action)).toBe(text);
  });
});
