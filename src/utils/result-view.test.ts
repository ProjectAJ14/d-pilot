import { describe, expect, it } from "vitest";
import { defaultViewMode } from "./result-view";

describe("defaultViewMode", () => {
  it("opens document stores as JSON", () => {
    expect(defaultViewMode("mongodb")).toBe("json");
    expect(defaultViewMode("elasticsearch")).toBe("json");
  });

  it("opens SQL engines, and an unknown connection, as a table", () => {
    expect(defaultViewMode("postgres")).toBe("table");
    expect(defaultViewMode("mssql")).toBe("table");
    expect(defaultViewMode(undefined)).toBe("table");
    expect(defaultViewMode(null)).toBe("table");
  });
});
