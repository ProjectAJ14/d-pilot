// What a job_change does, in words: for the timeline and the review page. Pure — the store reads it without pulling in
// the executors.

import { describeSchedule } from "./job-schedule.js";
import type { JobChangeAction } from "../types/index.js";

/** One line for the timeline and the review page: what the change does. */
export function describeJobAction(a: JobChangeAction): string {
  switch (a.type) {
    case "set_enabled":
      return a.enabled ? "Enables the job" : "Disables the job";
    case "rename":
      return `Renames the job to "${a.name}"`;
    case "set_description":
      return "Changes the job's description";
    case "edit_step":
      return `Changes the command of step ${a.stepId}`;
    case "add_step":
      return `Adds step "${a.name}"`;
    case "delete_step":
      return `Deletes step ${a.stepId}`;
    case "set_schedule":
      return `Changes the schedule to: ${a.cron ?? (a.msdb ? describeSchedule({ ...a.msdb, freq_relative_interval: 0 }) : "?")}`;
  }
}
