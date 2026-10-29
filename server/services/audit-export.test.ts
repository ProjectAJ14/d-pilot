import { describe, it, expect } from "vitest";
import {
  parseExportRange,
  toAuditCsv,
  HISTORY_COLUMNS,
} from "./audit-export.js";
import type { AuditEntry } from "../types/index.js";

describe("parseExportRange", () => {
  it("turns dates into inclusive timestamp bounds", () => {
    expect(parseExportRange("2026-01-01", "2026-01-14")).toEqual({
      from: "2026-01-01",
      to: "2026-01-14 23:59:59",
    });
  });

  it("allows a single day and exactly 14 days", () => {
    expect(parseExportRange("2026-01-05", "2026-01-05")).not.toHaveProperty(
      "error",
    );
    expect(parseExportRange("2026-02-20", "2026-03-05")).not.toHaveProperty(
      "error",
    );
  });

  it("refuses a 15th day", () => {
    expect(parseExportRange("2026-01-01", "2026-01-15")).toEqual({
      error: "Export range is limited to 14 days",
    });
  });

  it.each([
    [undefined, "2026-01-02"],
    ["2026-01-01", undefined],
    ["2026-1-1", "2026-01-02"],
    ["2026-02-30", "2026-03-01"],
    ["2026-01-01T00:00", "2026-01-02"],
    [["2026-01-01"], "2026-01-02"],
  ])("refuses malformed dates (%j, %j)", (from, to) => {
    expect(parseExportRange(from, to)).toHaveProperty("error");
  });

  it("refuses a reversed range", () => {
    expect(parseExportRange("2026-01-10", "2026-01-01")).toEqual({
      error: "to must not be before from",
    });
  });
});

const entry = (over: Partial<AuditEntry>): AuditEntry => ({
  id: "a1",
  userId: "u1",
  userEmail: "u1@example.com",
  action: "QUERY_EXECUTE",
  phiAccessed: false,
  timestamp: "2026-01-02 10:00:00",
  ...over,
});

describe("toAuditCsv", () => {
  it("writes a header and one line per entry", () => {
    const csv = toAuditCsv(
      [entry({ sql: "SELECT 1", rowsReturned: 1, executionMs: 3 })],
      HISTORY_COLUMNS,
    );
    expect(csv).toBe(
      "timestamp,connectionId,sql,rowsReturned,executionMs\n2026-01-02 10:00:00,,SELECT 1,1,3",
    );
  });

  it("quotes commas, quotes and newlines", () => {
    const csv = toAuditCsv(
      [entry({ sql: 'SELECT a, "b"\nFROM orders' })],
      ["sql"],
    );
    expect(csv).toBe('sql\n"SELECT a, ""b""\nFROM orders"');
  });

  it("neutralises spreadsheet formulas in user-supplied text", () => {
    const csv = toAuditCsv(
      [
        entry({ sql: '=HYPERLINK("http://x")' }),
        entry({ sql: "@SUM(A1)" }),
        entry({ sql: "+1" }),
        entry({ sql: "-- note" }),
      ],
      ["sql"],
    );
    expect(csv.split("\n").slice(1)).toEqual([
      `"'=HYPERLINK(""http://x"")"`,
      "'@SUM(A1)",
      "'+1",
      "'-- note",
    ]);
  });

  it("leaves numbers alone and flattens arrays and booleans", () => {
    const csv = toAuditCsv(
      [
        entry({
          executionMs: -1,
          phiAccessed: true,
          phiFieldsUnmasked: ["email", "phone"],
        }),
      ],
      ["executionMs", "phiAccessed", "phiFieldsUnmasked"],
    );
    expect(csv.split("\n")[1]).toBe("-1,true,email; phone");
  });
});
