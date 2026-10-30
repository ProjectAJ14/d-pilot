// SQL Server Agent keeps dates, times and durations in msdb as integers, and
// schedules as a handful of coded columns. Everything that reads them goes
// through these pure functions, so the encoding is decoded in one place.

import type { JobRunStatus } from "../types/index.js";

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * `run_date` (YYYYMMDD) + `run_time` (HHMMSS) as `YYYY-MM-DD HH:MM:SS`, in the
 * SQL Server's own local time — msdb records no zone. Null for 0 / missing,
 * which is how msdb says "never".
 */
export function decodeRunDateTime(
  runDate: number | null | undefined,
  runTime: number | null | undefined,
): string | null {
  if (!runDate) return null;
  const y = Math.floor(runDate / 10000);
  const mo = Math.floor(runDate / 100) % 100;
  const d = runDate % 100;
  return `${y}-${pad(mo)}-${pad(d)} ${decodeTimeOfDay(runTime ?? 0)}`;
}

/** An HHMMSS integer as `HH:MM:SS`. */
export function decodeTimeOfDay(hhmmss: number): string {
  return `${pad(Math.floor(hhmmss / 10000))}:${pad(Math.floor(hhmmss / 100) % 100)}:${pad(hhmmss % 100)}`;
}

/**
 * `run_duration` in seconds. It is HHMMSS, not seconds: 10203 is 1 h 2 min 3 s.
 * Hours are not capped at 99, so a 100-hour run is 1000000.
 */
export function decodeDuration(
  hhmmss: number | null | undefined,
): number | null {
  if (hhmmss == null) return null;
  return (
    Math.floor(hhmmss / 10000) * 3600 +
    (Math.floor(hhmmss / 100) % 100) * 60 +
    (hhmmss % 100)
  );
}

export function decodeRunStatus(
  code: number | null | undefined,
): JobRunStatus | null {
  return code == null
    ? null
    : ((["failed", "succeeded", "retry", "cancelled", "running"] as const)[
        code
      ] ?? null);
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The `freq_interval` weekday bitmask (Sunday 1, Monday 2, … Saturday 64). */
export function decodeWeekdays(mask: number): string[] {
  return DAYS.filter((_, i) => mask & (1 << i));
}

/** Weekdays as a run where they form one: Mon–Fri, not Mon, Tue, Wed, Thu, Fri. */
function weekdayText(mask: number): string {
  const days = decodeWeekdays(mask);
  if (days.length === 7) return "every day";
  const idx = days.map((d) => DAYS.indexOf(d));
  const run =
    idx.length > 2 && idx.every((v, i) => i === 0 || v === idx[i - 1] + 1);
  return run ? `${days[0]}–${days[days.length - 1]}` : days.join(", ");
}

export interface MsdbSchedule {
  freq_type: number;
  freq_interval: number;
  freq_subday_type: number;
  freq_subday_interval: number;
  freq_relative_interval: number;
  freq_recurrence_factor: number;
  active_start_date?: number;
  active_start_time: number;
  active_end_time: number;
}

const ORDINAL: Record<number, string> = {
  1: "first",
  2: "second",
  4: "third",
  8: "fourth",
  16: "last",
};
const RELATIVE_DAY: Record<number, string> = {
  1: "Sunday",
  2: "Monday",
  3: "Tuesday",
  4: "Wednesday",
  5: "Thursday",
  6: "Friday",
  7: "Saturday",
  8: "day",
  9: "weekday",
  10: "weekend day",
};

const hm = (hhmmss: number) => decodeTimeOfDay(hhmmss).slice(0, 5);
const plural = (n: number, unit: string) => (n === 1 ? unit : `${n} ${unit}s`);

/**
 * A schedule in plain language: "Every 30 minutes, 06:00–22:00, Mon–Fri".
 * Covers every freq_type msdb defines; codes it doesn't know are named, not
 * guessed at.
 */
export function describeSchedule(s: MsdbSchedule): string {
  const every = Math.max(1, s.freq_recurrence_factor || 1);
  // Within a day: once at the start time, or every N minutes/hours in a window.
  const inDay =
    s.freq_subday_type === 4 ||
    s.freq_subday_type === 8 ||
    s.freq_subday_type === 2
      ? `every ${plural(s.freq_subday_interval, { 2: "second", 4: "minute", 8: "hour" }[s.freq_subday_type]!)}, ${hm(s.active_start_time)}–${hm(s.active_end_time)}`
      : `at ${hm(s.active_start_time)}`;

  let text: string;
  switch (s.freq_type) {
    case 1:
      return `Once, ${decodeRunDateTime(s.active_start_date, s.active_start_time)?.slice(0, 16) ?? `at ${hm(s.active_start_time)}`}`;
    case 4:
      text = `${s.freq_interval > 1 ? `Every ${s.freq_interval} days` : "Daily"}, ${inDay}`;
      break;
    case 8:
      text = `${every > 1 ? `Every ${every} weeks` : "Weekly"} on ${weekdayText(s.freq_interval)}, ${inDay}`;
      break;
    case 16:
      text = `${every > 1 ? `Every ${every} months` : "Monthly"} on day ${s.freq_interval}, ${inDay}`;
      break;
    case 32:
      text = `${every > 1 ? `Every ${every} months` : "Monthly"} on the ${ORDINAL[s.freq_relative_interval] ?? "?"} ${RELATIVE_DAY[s.freq_interval] ?? "?"}, ${inDay}`;
      break;
    case 64:
      return "When SQL Server Agent starts";
    case 128:
      return "When the computer is idle";
    default:
      return `Unknown schedule (freq_type ${s.freq_type})`;
  }
  return text;
}

/**
 * Whether a schedule is one this version lets a job_change edit: daily,
 * weekly or monthly, once a day or every N minutes/hours. One-time,
 * monthly-relative, "Agent starts" and "idle" schedules are shown but not
 * editable.
 */
export const isEditableSchedule = (s: MsdbSchedule) =>
  [4, 8, 16].includes(s.freq_type) && [1, 4, 8].includes(s.freq_subday_type);
