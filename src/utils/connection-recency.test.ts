import { beforeEach, describe, expect, it } from "vitest";
import type { ConnectionInfo } from "@src/types";
import { loadLastUsed, sortByRecent, touch } from "./connection-recency";

const c = (id: string) => ({ id }) as ConnectionInfo;

describe("sortByRecent", () => {
  it("puts most recently used first and keeps unused in original order", () => {
    const out = sortByRecent([c("a"), c("b"), c("c"), c("d")], { c: 5, b: 9 });
    expect(out.map((x) => x.id)).toEqual(["b", "c", "a", "d"]);
  });
  it("tolerates missing or corrupt history", () => {
    const list = [c("a"), c("b")];
    expect(sortByRecent(list, undefined).map((x) => x.id)).toEqual(["a", "b"]);
    expect(sortByRecent(list, null as never).map((x) => x.id)).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("touch", () => {
  it("records per user without touching other users", () => {
    const a = touch({}, "u1", "x", 1);
    const b = touch(a, "u2", "x", 2);
    expect(b).toEqual({ u1: { x: 1 }, u2: { x: 2 } });
    expect(touch(b, "u1", "y", 3).u1).toEqual({ x: 1, y: 3 });
  });
});

describe("loadLastUsed", () => {
  const store: Record<string, string> = {};
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => (store[k] = v),
    };
  });
  it.each(["null", "[1]", "not json", '"str"'])("falls back for %s", (raw) => {
    store.dbpilot_conn_last_used = raw;
    expect(loadLastUsed()).toEqual({});
  });
  it("reads a valid map", () => {
    store.dbpilot_conn_last_used = '{"u1":{"x":1}}';
    expect(loadLastUsed()).toEqual({ u1: { x: 1 } });
  });
});
