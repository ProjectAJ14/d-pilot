import { beforeEach, describe, expect, it } from "vitest";
import type { ConnectionInfo } from "@src/types";
import {
  loadPins,
  movePin,
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

describe("movePin", () => {
  const base = { u1: ["a", "b", "c", "d"], u2: ["a", "b"] };
  it("moves forward and back", () => {
    expect(movePin(base, "u1", "a", "c").u1).toEqual(["b", "c", "a", "d"]);
    expect(movePin(base, "u1", "d", "b").u1).toEqual(["a", "d", "b", "c"]);
    expect(movePin(base, "u1", "b", "a").u1).toEqual(["b", "a", "c", "d"]);
  });
  it("is a no-op for same id, unpinned ids, unknown user", () => {
    expect(movePin(base, "u1", "a", "a")).toBe(base);
    expect(movePin(base, "u1", "x", "a")).toBe(base);
    expect(movePin(base, "u1", "a", "x")).toBe(base);
    expect(movePin(base, "nobody", "a", "b")).toBe(base);
  });
  it("does not mutate and leaves other users alone", () => {
    const snap = JSON.stringify(base);
    const next = movePin(base, "u1", "a", "d");
    expect(JSON.stringify(base)).toBe(snap);
    expect(next).not.toBe(base);
    expect(next.u1).not.toBe(base.u1);
    expect(next.u2).toBe(base.u2);
  });
  it("tolerates a corrupt per-user entry", () => {
    const bad = { u1: "oops" } as unknown as Record<string, string[]>;
    expect(movePin(bad, "u1", "a", "b")).toBe(bad);
    const mixed = { u1: ["a", 5, "b"] } as unknown as Record<string, string[]>;
    expect(movePin(mixed, "u1", "a", "b").u1).toEqual(["b", "a"]);
  });
});
