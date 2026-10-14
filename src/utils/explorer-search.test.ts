import { describe, expect, it } from "vitest";
import type { ConnectionInfo } from "@src/types";
import { filterGroups, normalizeQuery, pickEnv } from "./explorer-search";

const c = (id: string, name: string, env = "DEV") =>
  ({ id, name, env }) as ConnectionInfo;
const grouped = {
  DEV: [c("1", "Orders DB"), c("2", "Billing DB")],
  QA: [c("3", "Orders QA", "QA")],
};
const tables: Record<string, string[]> = { "2": ["invoices", "payments"] };
const tablesOf = (x: ConnectionInfo) => tables[x.id] ?? [];

describe("filterGroups", () => {
  it("returns the input unchanged without a query", () => {
    expect(filterGroups(grouped, "", tablesOf)).toBe(grouped);
  });
  it("matches connection names case-insensitively across envs", () => {
    const out = filterGroups(grouped, normalizeQuery("  ORDERS "), tablesOf);
    expect(out.DEV.map((x) => x.id)).toEqual(["1"]);
    expect(out.QA.map((x) => x.id)).toEqual(["3"]);
  });
  it("keeps a connection whose loaded table matches, drops empty envs", () => {
    const out = filterGroups(grouped, "invoice", tablesOf);
    expect(Object.keys(out)).toEqual(["DEV"]);
    expect(out.DEV.map((x) => x.id)).toEqual(["2"]);
  });
  it("does not match tables that are not loaded", () => {
    expect(filterGroups(grouped, "invoice", () => [])).toEqual({});
  });
});

describe("pickEnv", () => {
  const visible = { DEV: [], QA: [] };
  it("takes the first preference that is visible", () => {
    expect(pickEnv(visible, "PROD", "QA")).toBe("QA");
    expect(pickEnv(visible, null, "DEV", "QA")).toBe("DEV");
  });
  it("falls back to the first env, or undefined when none", () => {
    expect(pickEnv(visible, "PROD")).toBe("DEV");
    expect(pickEnv({}, "DEV")).toBeUndefined();
  });
});
