import { describe, it, expect } from "vitest";
import {
  decodeDuration,
  decodeRunDateTime,
  decodeRunStatus,
  decodeWeekdays,
  describeSchedule,
  isEditableSchedule,
  type MsdbSchedule,
} from "./job-schedule.js";

const sched = (over: Partial<MsdbSchedule>): MsdbSchedule => ({
  freq_type: 4,
  freq_interval: 1,
  freq_subday_type: 1,
  freq_subday_interval: 0,
  freq_relative_interval: 0,
  freq_recurrence_factor: 0,
  active_start_time: 0,
  active_end_time: 235959,
  ...over,
});

describe("msdb integer decoding", () => {
  it("reads run_date + run_time as local date and time", () => {
    expect(decodeRunDateTime(20261030, 61500)).toBe("2026-10-30 06:15:00");
    expect(decodeRunDateTime(20260101, 0)).toBe("2026-01-01 00:00:00");
    expect(decodeRunDateTime(0, 0)).toBeNull();
  });

  it("reads run_duration as HHMMSS, not seconds", () => {
    expect(decodeDuration(10203)).toBe(3723);
    expect(decodeDuration(59)).toBe(59);
    expect(decodeDuration(1000000)).toBe(360000); // 100 hours
    expect(decodeDuration(null)).toBeNull();
  });

  it("names every run_status", () => {
    expect([0, 1, 2, 3, 4, 9, null].map(decodeRunStatus)).toEqual([
      "failed",
      "succeeded",
      "retry",
      "cancelled",
      "running",
      null,
      null,
    ]);
  });

  it("decodes the weekday bitmask from Sunday = 1", () => {
    expect(decodeWeekdays(1 | 2 | 64)).toEqual(["Sun", "Mon", "Sat"]);
    expect(decodeWeekdays(62)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri"]);
  });
});

describe("describeSchedule", () => {
  it.each([
    [
      sched({
        freq_type: 8,
        freq_interval: 62,
        freq_recurrence_factor: 1,
        freq_subday_type: 4,
        freq_subday_interval: 30,
        active_start_time: 60000,
        active_end_time: 220000,
      }),
      "Weekly on Mon–Fri, every 30 minutes, 06:00–22:00",
    ],
    [sched({ active_start_time: 23000 }), "Daily, at 02:30"],
    [
      sched({ freq_interval: 3, freq_subday_type: 8, freq_subday_interval: 2 }),
      "Every 3 days, every 2 hours, 00:00–23:59",
    ],
    [
      sched({ freq_type: 8, freq_interval: 1 | 64, freq_recurrence_factor: 2 }),
      "Every 2 weeks on Sun, Sat, at 00:00",
    ],
    [
      sched({ freq_type: 16, freq_interval: 15, freq_recurrence_factor: 1 }),
      "Monthly on day 15, at 00:00",
    ],
    [
      sched({
        freq_type: 32,
        freq_interval: 6,
        freq_relative_interval: 16,
        freq_recurrence_factor: 1,
      }),
      "Monthly on the last Friday, at 00:00",
    ],
    [
      sched({
        freq_type: 1,
        active_start_date: 20261231,
        active_start_time: 233000,
      }),
      "Once, 2026-12-31 23:30",
    ],
    [sched({ freq_type: 64 }), "When SQL Server Agent starts"],
    [sched({ freq_type: 128 }), "When the computer is idle"],
  ])("%#: %s", (s, text) => {
    expect(describeSchedule(s)).toBe(text);
  });

  it("allows editing only daily/weekly/monthly schedules that run once or every N min/h", () => {
    expect(isEditableSchedule(sched({}))).toBe(true);
    expect(
      isEditableSchedule(sched({ freq_type: 8, freq_subday_type: 4 })),
    ).toBe(true);
    expect(isEditableSchedule(sched({ freq_type: 32 }))).toBe(false);
    expect(isEditableSchedule(sched({ freq_type: 1 }))).toBe(false);
    expect(isEditableSchedule(sched({ freq_type: 64 }))).toBe(false);
    expect(isEditableSchedule(sched({ freq_subday_type: 2 }))).toBe(false);
  });
});
