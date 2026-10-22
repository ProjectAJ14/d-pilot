import { beforeEach, describe, expect, it } from "vitest";
import type { ConnectionInfo } from "@src/types";
import {
  canDropPin,
  dropEdge,
  loadPins,
  nudgeTarget,
  movePin,
  savePins,
  sortPinnedFirst,
  togglePin,
} from "./connection-pins";

const c = (id: string) => ({ id, name: id }) as unknown as ConnectionInfo;
const ids = (l: ConnectionInfo[]) => l.map((x) => x.id);

const KEY = "dbpilot_conn_pins";
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

describe("loadPins / savePins with a hostile localStorage", () => {
  const stub = (ls: unknown) =>
    ((globalThis as { localStorage?: unknown }).localStorage = ls);

  it("returns {} when getItem throws", () => {
    stub({
      getItem: () => {
        throw new Error("denied");
      },
    });
    expect(loadPins()).toEqual({});
  });
  it("swallows setItem failures (quota / blocked)", () => {
    stub({
      getItem: () => null,
      setItem: () => {
        throw new DOMException("full", "QuotaExceededError");
      },
    });
    expect(() => savePins({ u1: ["a"] })).not.toThrow();
  });
  it("returns {} when nothing is stored", () => {
    expect(loadPins()).toEqual({});
  });
  it.each(["", "0", "42", "true"])("tolerates non-object JSON %j", (raw) => {
    store[KEY] = raw;
    expect(loadPins()).toEqual({});
  });
  it("passes per-user junk through for the pure helpers to sanitise", () => {
    store[KEY] = JSON.stringify({
      u1: "str",
      u2: { a: 1 },
      u3: ["a", 1, null],
    });
    const all = loadPins();
    expect(togglePin(all, "u1", "x").u1).toEqual(["x"]);
    expect(togglePin(all, "u2", "x").u2).toEqual(["x"]);
    expect(togglePin(all, "u3", "x").u3).toEqual(["a", "x"]);
  });
  it("saves exactly the JSON of what it is given under the pins key", () => {
    savePins({ u1: ["a", "b"] });
    expect(JSON.parse(store[KEY])).toEqual({ u1: ["a", "b"] });
  });
});

describe("pin helpers, extra edges", () => {
  it("togglePin pins into an empty list and an unknown user", () => {
    expect(togglePin({}, "u1", "a")).toEqual({ u1: ["a"] });
    expect(togglePin({ u1: [] }, "u1", "a")).toEqual({ u1: ["a"] });
  });
  it("togglePin unpinning the last id leaves an empty list, not a missing user", () => {
    expect(togglePin({ u1: ["a"] }, "u1", "a")).toEqual({ u1: [] });
  });
  it("togglePin unpin removes every duplicate of a stored id", () => {
    expect(togglePin({ u1: ["a", "a", "b"] }, "u1", "a").u1).toEqual(["b"]);
  });
  it("togglePin drops non-string entries and does not mutate nested arrays", () => {
    const inner = ["a", 7 as unknown as string];
    const all = { u1: inner, u2: ["z"] };
    const next = togglePin(all, "u1", "b");
    expect(next.u1).toEqual(["a", "b"]);
    expect(inner).toEqual(["a", 7]);
    expect(next.u2).toBe(all.u2);
  });
  it("movePin first->last and last->first", () => {
    const base = { u1: ["a", "b", "c"] };
    expect(movePin(base, "u1", "a", "c").u1).toEqual(["b", "c", "a"]);
    expect(movePin(base, "u1", "c", "a").u1).toEqual(["c", "a", "b"]);
  });
  it("movePin with an empty list or two pins", () => {
    const empty = { u1: [] as string[] };
    expect(movePin(empty, "u1", "a", "b")).toBe(empty);
    expect(movePin({ u1: ["a", "b"] }, "u1", "a", "b").u1).toEqual(["b", "a"]);
  });
  it("movePin with duplicate stored ids uses the first occurrence", () => {
    // Duplicates can't be produced by togglePin; this just pins down behaviour.
    expect(movePin({ u1: ["a", "b", "a"] }, "u1", "b", "a").u1).toEqual([
      "b",
      "a",
      "a",
    ]);
  });
  it("movePin adds the user key only when it actually moves", () => {
    const base = { u1: ["a", "b"] };
    expect(movePin(base, "u1", "a", "a")).toBe(base);
    expect(Object.keys(movePin(base, "u1", "a", "b"))).toEqual(["u1"]);
  });
  it("sortPinnedFirst on an empty list", () => {
    expect(sortPinnedFirst([], ["a"])).toEqual([]);
  });
  it("sortPinnedFirst returns the same element objects and a new array", () => {
    const list = [c("a"), c("b")];
    const out = sortPinnedFirst(list, ["b"]);
    expect(out).not.toBe(list);
    expect(out[0]).toBe(list[1]);
    expect(out[1]).toBe(list[0]);
  });
  it("sortPinnedFirst never mutates its inputs", () => {
    const list = [c("a"), c("b"), c("c")];
    const pins = ["c", "a"];
    sortPinnedFirst(list, pins);
    expect(ids(list)).toEqual(["a", "b", "c"]);
    expect(pins).toEqual(["c", "a"]);
  });
  it("sortPinnedFirst ignores non-array pins and non-string entries", () => {
    const list = [c("a"), c("b")];
    expect(ids(sortPinnedFirst(list, "b" as unknown as string[]))).toEqual([
      "a",
      "b",
    ]);
    expect(ids(sortPinnedFirst(list, [5, null, "b"] as never))).toEqual([
      "b",
      "a",
    ]);
  });
  it("sortPinnedFirst collapses duplicate connection ids for a pinned id", () => {
    // Connection ids are unique in practice; with a dup, the pinned id keeps
    // only the last entry (Map semantics) while unpinned dups are untouched.
    const first = c("a");
    const last = c("a");
    const out = sortPinnedFirst([first, c("b"), c("b"), last], ["a"]);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(last);
    expect(ids(out)).toEqual(["a", "b", "b"]);
  });
});

describe("canDropPin", () => {
  const group = ["a", "b", "x"]; // x is unpinned
  const pins = ["b", "a", "other-env"]; // other-env is pinned but not in group
  it("allows pinned -> pinned in the same group", () => {
    expect(canDropPin("a", "b", group, pins)).toBe(true);
    expect(canDropPin("b", "a", group, pins)).toBe(true);
  });
  it("ignores nothing being dragged", () => {
    expect(canDropPin(null, "a", group, pins)).toBe(false);
  });
  it("ignores dropping on itself", () => {
    expect(canDropPin("a", "a", group, pins)).toBe(false);
  });
  it("ignores dropping on an unpinned row", () => {
    expect(canDropPin("a", "x", group, pins)).toBe(false);
  });
  it("ignores dragging an unpinned id (stale drag)", () => {
    expect(canDropPin("x", "a", group, pins)).toBe(false);
  });
  it("ignores a dragged pin from another env group", () => {
    expect(canDropPin("other-env", "a", group, pins)).toBe(false);
  });
  it("ignores a drag id that is no longer anywhere", () => {
    expect(canDropPin("gone", "a", group, pins)).toBe(false);
  });
  it("ignores everything when nothing is pinned", () => {
    expect(canDropPin("a", "b", group, [])).toBe(false);
  });
});

describe("nudgeTarget", () => {
  const pins = ["c", "a", "b"];
  const group = ["c", "a", "x", "b"]; // visible order, x unpinned in between
  it("moves among pinned rows only, skipping unpinned ones", () => {
    expect(nudgeTarget(group, pins, "a", 1)).toBe("b");
    expect(nudgeTarget(group, pins, "b", -1)).toBe("a");
    expect(nudgeTarget(group, pins, "a", -1)).toBe("c");
  });
  it("clamps at both ends", () => {
    expect(nudgeTarget(group, pins, "c", -1)).toBeNull();
    expect(nudgeTarget(group, pins, "b", 1)).toBeNull();
  });
  it("is null for a single pinned row", () => {
    expect(nudgeTarget(["a", "x"], ["a"], "a", 1)).toBeNull();
    expect(nudgeTarget(["a", "x"], ["a"], "a", -1)).toBeNull();
  });
  it("is null for an unpinned row or a group with no pins", () => {
    expect(nudgeTarget(group, pins, "x", 1)).toBeNull();
    expect(nudgeTarget(group, [], "a", 1)).toBeNull();
  });
  it("is null when the id is not in the group (stale id)", () => {
    expect(nudgeTarget(group, pins, "gone", 1)).toBeNull();
    expect(nudgeTarget(group, [...pins, "gone"], "gone", -1)).toBeNull();
    expect(nudgeTarget([], pins, "a", 1)).toBeNull();
  });
  it("ignores pinned ids that are not in the group", () => {
    expect(nudgeTarget(["a", "b"], ["z", "a", "b"], "a", -1)).toBeNull();
  });
  it("follows the visible (search-filtered) order, skipping hidden pins", () => {
    // Pin order is c,a,b but search hides "a": the user sees c then b, so
    // Alt+Down on c targets b, not the hidden a.
    expect(nudgeTarget(["c", "b"], pins, "c", 1)).toBe("b");
    expect(nudgeTarget(["c", "b"], pins, "b", -1)).toBe("c");
  });
  it("uses the group's order, not the stored pin order, when they differ", () => {
    expect(nudgeTarget(["a", "b", "c"], ["c", "a", "b"], "a", 1)).toBe("b");
    expect(nudgeTarget(["a", "b", "c"], ["c", "a", "b"], "a", -1)).toBeNull();
  });
  it("the target it picks reorders the way the user expects", () => {
    const all = { u1: pins };
    const to = nudgeTarget(["c", "b"], pins, "c", 1)!;
    // c lands in b's slot, past the hidden a.
    expect(movePin(all, "u1", "c", to).u1).toEqual(["a", "b", "c"]);
  });
});

describe("dropEdge", () => {
  const pins = ["a", "b", "c"];
  it("dragging up lands above the hovered row", () => {
    expect(dropEdge("c", "a", pins)).toBe("above");
    expect(dropEdge("b", "a", pins)).toBe("above");
  });
  it("dragging down lands below the hovered row", () => {
    expect(dropEdge("a", "c", pins)).toBe("below");
    expect(dropEdge("a", "b", pins)).toBe("below");
  });
});
