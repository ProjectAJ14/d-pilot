import { describe, expect, it } from "vitest";
import { datetimeParts, isIsoDateTime } from "./datetime";

describe("isIsoDateTime", () => {
  it("accepts datetimes with a time part, with or without a zone", () => {
    expect(isIsoDateTime("2026-07-04T11:20:01.850Z")).toBe(true);
    expect(isIsoDateTime(" 2026-07-04 11:20 ")).toBe(true);
    expect(isIsoDateTime("2026-07-04T11:20:01+05:30")).toBe(true);
  });

  it("rejects date-only strings and non-strings", () => {
    expect(isIsoDateTime("2026-07-04")).toBe(false);
    expect(isIsoDateTime(1720000000)).toBe(false);
    expect(isIsoDateTime(null)).toBe(false);
  });
});

describe("datetimeParts", () => {
  it("labels a Z value as UTC and converts it", () => {
    const p = datetimeParts("2026-07-04T11:20:01.850Z")!;
    expect(p.source).toBe("2026-07-04T11:20:01.850Z");
    expect(p.sourceLabel).toBe("Source (UTC)");
    expect(p.naive).toBe(false);
    expect(p.local).toContain("2026");
  });

  it("labels an offset value plainly, and a zoneless one as naive", () => {
    expect(datetimeParts("2026-07-04T11:20:01+0530")).toMatchObject({
      sourceLabel: "Source",
      naive: false,
    });
    // Second call reuses the cached formatter.
    expect(datetimeParts(" 2026-07-04T11:20 ")).toMatchObject({
      source: "2026-07-04T11:20",
      sourceLabel: "Source",
      naive: true,
    });
  });

  it("returns null for non-datetimes and impossible dates", () => {
    expect(datetimeParts("hello")).toBeNull();
    expect(datetimeParts("2026-13-45T99:99")).toBeNull();
  });
});
