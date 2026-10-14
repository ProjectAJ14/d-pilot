import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({ conns: [] as { id: string }[] }));
vi.mock("./api-client", () => ({
  api: { getConnections: async () => h.conns },
}));

// The store reads persisted tabs at import; give it an empty storage.
vi.stubGlobal("localStorage", {
  getItem: () => null,
  setItem: () => {},
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

  it("clears the active connection once the last one is deleted", async () => {
    h.conns = [{ id: "dev-core" }];
    await loadConnections();
    h.conns = [];
    await loadConnections();
    expect(useStore.getState().activeConnectionId).toBeNull();
  });
});
