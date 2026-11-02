import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryTab } from "../types";
import {
  clearPersistedTabs,
  createDebouncedSave,
  loadTabs,
  saveTabs,
} from "./tab-persistence";

const store = new Map<string, string>();
const storage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: vi.fn((k: string, v: string) => void store.set(k, v)),
  removeItem: (k: string) => void store.delete(k),
};
vi.stubGlobal("localStorage", storage);

const tab = (over: Partial<QueryTab> = {}) =>
  ({
    id: "t1",
    title: "Query 1",
    sql: "select 1",
    connectionId: "dev-core",
    results: { rows: [{ secret: "x" }] },
    ...over,
  }) as unknown as QueryTab;

const state = (tabs = [tab()]) => ({
  tabs,
  activeTabId: tabs[0]?.id ?? "",
  activeConnectionId: "dev-core",
  sidebarOpen: true,
});

beforeEach(() => store.clear());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("saveTabs / loadTabs", () => {
  it("round-trips the workspace but never the results", () => {
    saveTabs(state());
    const raw = store.get("dbpilot_tabs")!;
    expect(raw).not.toContain("secret");
    const data = loadTabs()!;
    expect(data.version).toBe(2);
    expect(data.tabs[0]).toMatchObject({ id: "t1", sql: "select 1" });
    expect(data.sidebarOpen).toBe(true);
  });

  it("returns null when nothing is stored", () => {
    expect(loadTabs()).toBeNull();
  });

  it("discards an old version, a non-array or an empty tab list", () => {
    for (const bad of [
      { version: 1, tabs: [tab()] },
      { version: 2, tabs: "nope" },
      { version: 2, tabs: [] },
    ]) {
      store.set("dbpilot_tabs", JSON.stringify(bad));
      expect(loadTabs()).toBeNull();
      expect(store.has("dbpilot_tabs")).toBe(false);
    }
  });

  it("clears corrupted JSON", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    store.set("dbpilot_tabs", "{not json");
    expect(loadTabs()).toBeNull();
    expect(store.has("dbpilot_tabs")).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it("warns instead of throwing when storage is full", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    storage.setItem.mockImplementationOnce(() => {
      throw new Error("QuotaExceeded");
    });
    expect(() => saveTabs(state())).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      "[tab-persistence] Failed to save tabs:",
      expect.any(Error),
    );
  });

  it("clearPersistedTabs removes the entry", () => {
    saveTabs(state());
    clearPersistedTabs();
    expect(store.has("dbpilot_tabs")).toBe(false);
  });
});

describe("createDebouncedSave", () => {
  it("saves only the latest state once the delay passes", () => {
    vi.useFakeTimers();
    const save = createDebouncedSave(100);
    save(state([tab({ sql: "a" })]));
    save(state([tab({ sql: "b" })]));
    vi.advanceTimersByTime(99);
    expect(store.has("dbpilot_tabs")).toBe(false);
    vi.advanceTimersByTime(1);
    expect(loadTabs()!.tabs[0].sql).toBe("b");
  });

  it("flush writes a pending save at once and cancels the timer", () => {
    vi.useFakeTimers();
    const save = createDebouncedSave();
    save(state([tab({ sql: "now" })]));
    save.flush();
    expect(loadTabs()!.tabs[0].sql).toBe("now");
    storage.setItem.mockClear();
    vi.advanceTimersByTime(1000);
    expect(storage.setItem).not.toHaveBeenCalled();
    // Nothing pending: flush is a no-op.
    save.flush();
    expect(storage.setItem).not.toHaveBeenCalled();
  });
});
