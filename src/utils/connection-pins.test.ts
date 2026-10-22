import { beforeEach, describe, expect, it } from "vitest";
import type { ConnectionInfo } from "@src/types";
import {
  loadPins,
  savePins,
  sortPinnedFirst,
  togglePin,
} from "./connection-pins";

const c = (id: string) => ({ id, name: id }) as unknown as ConnectionInfo;
const ids = (l: ConnectionInfo[]) => l.map((x) => x.id);

const store: Record<string, string> = {};
beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => (store[k] = v),
  };
});

describe("togglePin", () => {
  it("appends on pin and removes on unpin", () => {
    let s = togglePin({}, "u1", "a");
    s = togglePin(s, "u1", "b");
    expect(s.u1).toEqual(["a", "b"]);
    expect(togglePin(s, "u1", "a").u1).toEqual(["b"]);
  });
  it("isolates users", () => {
    const s = togglePin(togglePin({}, "u1", "a"), "u2", "b");
    expect(s).toEqual({ u1: ["a"], u2: ["b"] });
  });
  it("does not mutate its input", () => {
    const s = { u1: ["a"] };
    togglePin(s, "u1", "b");
    expect(s.u1).toEqual(["a"]);
  });
  it("recovers from a corrupt per-user entry", () => {
    const bad = { u1: "nope" } as unknown as Record<string, string[]>;
    expect(togglePin(bad, "u1", "a").u1).toEqual(["a"]);
  });
});

describe("sortPinnedFirst", () => {
  const conns = [c("a"), c("b"), c("c"), c("d")];
  it("puts pinned first in pin order, rest keep incoming order", () => {
    expect(ids(sortPinnedFirst(conns, ["c", "a"]))).toEqual([
      "c",
      "a",
      "b",
      "d",
    ]);
  });
  it("ignores stale ids and duplicates", () => {
    expect(ids(sortPinnedFirst(conns, ["gone", "b", "b"]))).toEqual([
      "b",
      "a",
      "c",
      "d",
    ]);
  });
  it("is a no-op with no pins", () => {
    expect(ids(sortPinnedFirst(conns, undefined))).toEqual(ids(conns));
    expect(ids(sortPinnedFirst(conns, []))).toEqual(ids(conns));
  });
});

describe("storage", () => {
  it("round-trips", () => {
    savePins({ u1: ["a"] });
    expect(loadPins()).toEqual({ u1: ["a"] });
  });
  it.each(["{not json", "[]", "null", '"x"'])("tolerates corrupt %s", (raw) => {
    localStorage.setItem("dbpilot_conn_pins", raw);
    expect(loadPins()).toEqual({});
  });
});
