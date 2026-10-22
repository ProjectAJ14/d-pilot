import { beforeEach, describe, expect, it, vi } from "vitest";

// The store reads localStorage at import time (loadPins), so stub it first.
const mem: Record<string, string> = {};
const setItem = vi.fn((k: string, v: string) => {
  mem[k] = v;
});
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem,
};
// ...and it registers a beforeunload hook on window.
(globalThis as { window?: unknown }).window = { addEventListener: () => {} };
const { useStore } = await import("./index");

const KEY = "dbpilot_conn_pins";
const as = (id: string | null) =>
  useStore.setState({
    user: id ? ({ id } as never) : null,
    connectionPins: {},
  });
const saved = () => JSON.parse(mem[KEY] ?? "null");

beforeEach(() => {
  for (const k of Object.keys(mem)) delete mem[k];
  setItem.mockClear();
});

describe("toggleConnectionPin", () => {
  it("is a no-op without a user", () => {
    as(null);
    const before = useStore.getState().connectionPins;
    useStore.getState().toggleConnectionPin("a");
    expect(useStore.getState().connectionPins).toBe(before);
    expect(setItem).not.toHaveBeenCalled();
  });
  it("updates state and persists", () => {
    as("u1");
    useStore.getState().toggleConnectionPin("a");
    useStore.getState().toggleConnectionPin("b");
    expect(useStore.getState().connectionPins).toEqual({ u1: ["a", "b"] });
    expect(saved()).toEqual({ u1: ["a", "b"] });
    useStore.getState().toggleConnectionPin("a");
    expect(saved()).toEqual({ u1: ["b"] });
  });
  it("keeps users separate", () => {
    as("u1");
    useStore.getState().toggleConnectionPin("a");
    useStore.setState({ user: { id: "u2" } as never });
    useStore.getState().toggleConnectionPin("b");
    expect(saved()).toEqual({ u1: ["a"], u2: ["b"] });
  });
});

describe("reorderConnectionPin", () => {
  it("is a no-op without a user", () => {
    as(null);
    useStore.getState().reorderConnectionPin("a", "b");
    expect(setItem).not.toHaveBeenCalled();
  });
  it("reorders and persists", () => {
    as("u1");
    for (const id of ["a", "b", "c"])
      useStore.getState().toggleConnectionPin(id);
    useStore.getState().reorderConnectionPin("a", "c");
    expect(useStore.getState().connectionPins.u1).toEqual(["b", "c", "a"]);
    expect(saved()).toEqual({ u1: ["b", "c", "a"] });
  });
  it("does not write storage or replace state when nothing moves", () => {
    as("u1");
    for (const id of ["a", "b"]) useStore.getState().toggleConnectionPin(id);
    setItem.mockClear();
    const before = useStore.getState().connectionPins;
    useStore.getState().reorderConnectionPin("a", "a");
    useStore.getState().reorderConnectionPin("a", "unpinned");
    useStore.getState().reorderConnectionPin("unpinned", "a");
    expect(useStore.getState().connectionPins).toBe(before);
    expect(setItem).not.toHaveBeenCalled();
  });
});
