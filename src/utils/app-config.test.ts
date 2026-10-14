import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({ conns: [] as { id: string }[] }));
vi.mock("./api-client", () => ({
  api: { getConnections: async () => h.conns },
}));

// The store reads persisted tabs at import; give it an empty storage.
const saved = vi.hoisted(() => ({ items: {} as Record<string, string> }));
vi.stubGlobal("localStorage", {
  getItem: () => null,
  setItem: (k: string, v: string) => (saved.items[k] = v),
  removeItem: () => {},
});
vi.stubGlobal("window", { addEventListener: () => {} });

const { useStore } = await import("../store");
const { loadConnections, tabTitle } = await import("./app-config");

describe("tabTitle", () => {
  it("adds the tagline when there is one", () => {
    expect(tabTitle("D-Pilot", "SQL explorer")).toBe("D-Pilot — SQL explorer");
  });
  it("is the bare app name when the tagline is empty", () => {
    expect(tabTitle("D-Pilot", "")).toBe("D-Pilot");
    expect(tabTitle("D-Pilot", undefined)).toBe("D-Pilot");
  });
});

describe("loadConnections", () => {
  it("keeps the active connection while it exists, else picks the first", async () => {
    h.conns = [{ id: "dev-core" }, { id: "qa-core" }];
    useStore.getState().setActiveConnection("qa-core");
    await loadConnections();
    expect(useStore.getState().activeConnectionId).toBe("qa-core");
    h.conns = [{ id: "dev-core" }];
    await loadConnections();
    expect(useStore.getState().activeConnectionId).toBe("dev-core");
  });

  it("clears the active connection, and tabs on it, once the last one is deleted", async () => {
    vi.useFakeTimers();
    h.conns = [{ id: "dev-core" }];
    await loadConnections();
    useStore.getState().addTab("dev-core");
    h.conns = [];
    await loadConnections();
    const s = useStore.getState();
    expect(s.activeConnectionId).toBeNull();
    expect(s.tabs.map((t) => t.connectionId)).toEqual(s.tabs.map(() => null));
    // ...and that is what a reload restores.
    await vi.advanceTimersByTimeAsync(1000);
    const persisted = JSON.parse(Object.values(saved.items).at(-1)!);
    expect(persisted.activeConnectionId).toBeNull();
    expect(
      persisted.tabs.every((t: { connectionId: unknown }) => !t.connectionId),
    ).toBe(true);
    vi.useRealTimers();
  });

  it("forgets the remembered schema of a deleted connection", async () => {
    h.conns = [{ id: "dev-core" }, { id: "qa-core" }];
    await loadConnections();
    useStore.getState().setSchemaForConnection("qa-core", "app_core");
    useStore.getState().setSchemaForConnection("dev-core", "public");
    h.conns = [{ id: "dev-core" }];
    await loadConnections();
    expect(useStore.getState().schemaByConnection).toEqual({
      "dev-core": "public",
    });
  });
});
