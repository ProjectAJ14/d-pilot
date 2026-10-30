// What a job_change does, in words: for the timeline, the review page and
// the warnings a reviewer sees. Pure — the store reads it without pulling in
// the executors.

import { describeSchedule } from "./job-schedule.js";
import type { JobChangeAction, JobDetail } from "../types/index.js";

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

/** What a reviewer should know beyond the SQL: a shared schedule changes other jobs too. */
export function jobChangeWarnings(
  action: JobChangeAction,
  job: Pick<JobDetail, "schedules">,
): string[] {
  if (action.type !== "set_schedule") return [];
  const sch = job.schedules.find((s) => s.id === String(action.scheduleId));
  return sch?.sharedWith
    ? [
        `This schedule is shared with ${sch.sharedWith} other job${sch.sharedWith > 1 ? "s" : ""} — changing it changes when they run too.`,
      ]
    : [];
}
