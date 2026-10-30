import { describe, it, expect } from "vitest";

// The store reads localStorage and hooks window at import time.
const mem: Record<string, string> = {};
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => (mem[k] = v),
};
(globalThis as { window?: unknown }).window = { addEventListener: () => {} };
const { useStore } = await import("./index");

/**
 * An object or job tab shows something read from one database. Picking another
 * connection in the explorer re-points the active SQL tab, and once re-pointed
 * an open definition too — which then 404'd, or showed a same-named object
 * from a different database under the old one's title.
 */
describe("bound tabs", () => {
  it("keeps an active object or job tab on its own connection", () => {
    const s = useStore.getState();
    s.openObjectTab("qa-pg", {
      schema: "app_core",
      name: "refresh_order_totals",
      kind: "function",
      args: "integer",
    });
    useStore.getState().setActiveConnection("qa-ms");
    const objectTab = useStore
      .getState()
      .tabs.find((t) => t.id === useStore.getState().activeTabId)!;
    expect(objectTab.kind).toBe("object");
    expect(objectTab.connectionId).toBe("qa-pg");

    useStore.getState().openJobTab("qa-ms", { id: "7", name: "nightly" });
    useStore.getState().setActiveConnection("qa-pg");
    const jobTab = useStore
      .getState()
      .tabs.find((t) => t.id === useStore.getState().activeTabId)!;
    expect(jobTab.connectionId).toBe("qa-ms");
    expect(useStore.getState().activeConnectionId).toBe("qa-pg");
  });

  it("still re-points an active SQL tab", () => {
    useStore.getState().addTab("qa-pg");
    useStore.getState().setActiveConnection("qa-ms");
    const tab = useStore
      .getState()
      .tabs.find((t) => t.id === useStore.getState().activeTabId)!;
    expect(tab.connectionId).toBe("qa-ms");
  });
});
