import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The store reads localStorage and hooks window at import time, so each test
// stubs both and imports a fresh copy of the module.
const mem: Record<string, string> = {};
let unload: (() => void) | undefined;
vi.stubGlobal("localStorage", {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => (mem[k] = v),
  removeItem: (k: string) => delete mem[k],
});
vi.stubGlobal("window", {
  addEventListener: (type: string, fn: () => void) => {
    if (type === "beforeunload") unload = fn;
  },
});

async function freshStore() {
  vi.resetModules();
  return (await import("./index")).useStore;
}

const persisted = () => JSON.parse(mem.dbpilot_tabs ?? "null");

beforeEach(() => {
  for (const k of Object.keys(mem)) delete mem[k];
  unload = undefined;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("initial state", () => {
  it("defaults to one empty tab, no session, shield on, limit 500", async () => {
    const useStore = await freshStore();
    const s = useStore.getState();
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0]).toMatchObject({ id: "tab-1", title: "Query 1" });
    expect(s.activeTabId).toBe("tab-1");
    expect(s.activeConnectionId).toBeNull();
    expect(s.sidebarOpen).toBe(true);
    expect(s.token).toBeNull();
    expect(s.user).toBeNull();
    expect(s.isAuthenticated).toBe(false);
    expect(s.phiEnabled).toBe(true);
    expect(s.defaultLimitEnabled).toBe(true);
    expect(s.defaultLimitValue).toBe(500);
    expect(s.viModeEnabled).toBe(false);
    expect(s.schemaByConnection).toEqual({});
  });

  it("restores the session, settings and persisted tabs", async () => {
    mem.dbpilot_token = "tok";
    mem.dbpilot_user = JSON.stringify({ id: "u1", username: "ann" });
    mem.dbpilot_limit_enabled = "false";
    mem.dbpilot_limit_value = "not-a-number";
    mem.dbpilot_vi_mode = "on";
    mem.phi_shield = "off";
    mem.dbpilot_tabs = JSON.stringify({
      version: 2,
      tabs: [
        {
          id: "tab-7",
          title: "Orders",
          sql: "select 1",
          connectionId: "qa",
          schema: "app_core",
        },
        { id: "imported", title: "X", sql: "", connectionId: null },
      ],
      activeTabId: "imported",
      activeConnectionId: "qa",
      sidebarOpen: false,
    });
    const useStore = await freshStore();
    const s = useStore.getState();
    expect(s.token).toBe("tok");
    expect(s.user).toMatchObject({ id: "u1" });
    expect(s.isAuthenticated).toBe(true);
    expect(s.defaultLimitEnabled).toBe(false);
    expect(s.defaultLimitValue).toBe(500);
    expect(s.viModeEnabled).toBe(true);
    expect(s.phiEnabled).toBe(false);
    expect(s.tabs.map((t) => t.id)).toEqual(["tab-7", "imported"]);
    expect(s.tabs[0]).toMatchObject({ result: null, loading: false });
    expect(s.activeTabId).toBe("imported");
    expect(s.activeConnectionId).toBe("qa");
    expect(s.sidebarOpen).toBe(false);
    expect(s.schemaByConnection).toEqual({ qa: "app_core" });
    // The counter continues after the highest restored tab number.
    s.addTab();
    expect(useStore.getState().activeTabId).toBe("tab-8");
  });

  it("falls back to the first tab and defaults when persisted fields are absent", async () => {
    mem.dbpilot_tabs = JSON.stringify({
      version: 2,
      tabs: [{ id: "custom", title: "A", sql: "", connectionId: null }],
    });
    const useStore = await freshStore();
    const s = useStore.getState();
    expect(s.activeTabId).toBe("custom");
    expect(s.activeConnectionId).toBeNull();
    expect(s.sidebarOpen).toBe(true);
    s.addTab();
    expect(useStore.getState().activeTabId).toBe("tab-1");
  });
});

describe("persistence", () => {
  it("debounces tab saves and flushes them on unload", async () => {
    const useStore = await freshStore();
    useStore.getState().updateTab("tab-1", { sql: "select 2" });
    expect(persisted()).toBeNull();
    unload!();
    expect(persisted().tabs[0].sql).toBe("select 2");

    useStore.getState().setActiveTab("tab-1");
    vi.advanceTimersByTime(500);
    expect(persisted().activeTabId).toBe("tab-1");
  });
});

describe("config and auth", () => {
  it("setConfig persists the network hint", async () => {
    const useStore = await freshStore();
    const config = {
      ...useStore.getState().config,
      networkHint: "Connect to the VPN.",
    };
    useStore.getState().setConfig(config);
    expect(useStore.getState().config).toBe(config);
    expect(mem.dbpilot_network_hint).toBe("Connect to the VPN.");
  });

  it("setServerUnreachable flips the flag", async () => {
    const useStore = await freshStore();
    useStore.getState().setServerUnreachable(true);
    expect(useStore.getState().serverUnreachable).toBe(true);
  });

  it("login stores the session; logout clears it and the saved tabs", async () => {
    const useStore = await freshStore();
    const user = { id: "u1", username: "ann" } as never;
    useStore.getState().login("tok", user);
    expect(mem.dbpilot_token).toBe("tok");
    expect(JSON.parse(mem.dbpilot_user)).toEqual(user);
    expect(useStore.getState().isAuthenticated).toBe(true);

    mem.dbpilot_tabs = "{}";
    useStore.getState().logout();
    expect(mem.dbpilot_token).toBeUndefined();
    expect(mem.dbpilot_user).toBeUndefined();
    expect(mem.dbpilot_tabs).toBeUndefined();
    expect(useStore.getState()).toMatchObject({
      token: null,
      user: null,
      isAuthenticated: false,
    });
  });
});

describe("connections", () => {
  it("setConnections detaches tabs and schemas of deleted connections", async () => {
    const useStore = await freshStore();
    const s = useStore.getState();
    s.setActiveConnection("gone");
    s.setSchemaForConnection("gone", "app_core");
    s.setSchemaForConnection("kept", "sales");
    s.addTab("kept");
    s.setConnections([{ id: "kept" } as never]);
    const after = useStore.getState();
    expect(after.schemaByConnection).toEqual({ kept: "sales" });
    expect(after.tabs[0]).toMatchObject({
      connectionId: null,
      schema: undefined,
    });
    expect(after.tabs[1].connectionId).toBe("kept");

    // Nothing gone: the tabs array is left as is.
    const tabs = after.tabs;
    after.setConnections([{ id: "kept" } as never]);
    expect(useStore.getState().tabs).toBe(tabs);
  });

  it("markConnectionUsed records per user, and only with a user", async () => {
    const useStore = await freshStore();
    useStore.getState().markConnectionUsed("qa");
    expect(useStore.getState().connectionLastUsed).toEqual({});
    expect(mem.dbpilot_conn_last_used).toBeUndefined();

    vi.setSystemTime(1234);
    useStore.setState({ user: { id: "u1" } as never });
    useStore.getState().markConnectionUsed("qa");
    expect(useStore.getState().connectionLastUsed).toEqual({
      u1: { qa: 1234 },
    });
    expect(JSON.parse(mem.dbpilot_conn_last_used)).toEqual({
      u1: { qa: 1234 },
    });
  });

  it("setActiveConnection carries the remembered schema, or none", async () => {
    const useStore = await freshStore();
    const s = useStore.getState();
    s.setSchemaForConnection("qa", "app_core");
    s.setActiveConnection("qa");
    expect(useStore.getState().tabs[0]).toMatchObject({
      connectionId: "qa",
      schema: "app_core",
    });
    s.addTab();
    s.setActiveConnection(null);
    const tabs = useStore.getState().tabs;
    expect(tabs[0].connectionId).toBe("qa");
    expect(tabs[1]).toMatchObject({ connectionId: null, schema: undefined });
  });

  it("setSchemaForConnection syncs only tabs on that connection", async () => {
    const useStore = await freshStore();
    const s = useStore.getState();
    s.addTab("qa");
    s.addTab("dev");
    s.setSchemaForConnection("qa", "sales");
    const before = useStore.getState().tabs;
    // Same schema again: the matching tab object is reused.
    s.setSchemaForConnection("qa", "sales");
    const tabs = useStore.getState().tabs;
    expect(tabs[1]).toBe(before[1]);
    expect(tabs.map((t) => t.schema)).toEqual([undefined, "sales", undefined]);
  });
});

describe("tabs", () => {
  it("addTab falls back to the active connection", async () => {
    const useStore = await freshStore();
    useStore.setState({ activeConnectionId: "qa" });
    useStore.getState().addTab();
    useStore.getState().addTab("dev");
    const tabs = useStore.getState().tabs;
    expect(tabs.map((t) => t.connectionId)).toEqual([null, "qa", "dev"]);
    expect(tabs[2]).toMatchObject({ id: "tab-3", title: "Query 3" });
    expect(useStore.getState().activeTabId).toBe("tab-3");
  });

  it("closeTab keeps or moves focus, and never leaves zero tabs", async () => {
    const useStore = await freshStore();
    const s = useStore.getState();
    s.addTab();
    s.addTab();
    s.setActiveTab("tab-2");
    s.closeTab("tab-3"); // inactive tab: focus stays
    expect(useStore.getState().activeTabId).toBe("tab-2");
    s.closeTab("tab-2"); // active tab: focus moves to the last remaining
    expect(useStore.getState().activeTabId).toBe("tab-1");
    useStore.setState({ activeConnectionId: "qa" });
    s.closeTab("tab-1"); // last tab: a fresh one replaces it
    const after = useStore.getState();
    expect(after.tabs).toHaveLength(1);
    expect(after.tabs[0]).toMatchObject({ id: "tab-4", connectionId: "qa" });
    expect(after.activeTabId).toBe("tab-4");
  });

  it("updateTab changes only the named tab", async () => {
    const useStore = await freshStore();
    useStore.getState().addTab();
    useStore.getState().updateTab("tab-2", { title: "Renamed" });
    expect(useStore.getState().tabs.map((t) => t.title)).toEqual([
      "Query 1",
      "Renamed",
    ]);
  });

  it("openArtifactTab opens once, then focuses", async () => {
    const useStore = await freshStore();
    useStore.getState().openArtifactTab({ id: "a1", title: "Report" });
    const tab = useStore.getState().tabs[1];
    expect(tab).toMatchObject({
      kind: "artifact",
      artifactId: "a1",
      title: "Report",
      connectionId: null,
    });
    useStore.getState().setActiveTab("tab-1");
    useStore.getState().openArtifactTab({ id: "a1", title: "Report" });
    expect(useStore.getState().tabs).toHaveLength(2);
    expect(useStore.getState().activeTabId).toBe(tab.id);
  });

  it("openObjectTab focuses an open one, bumping compareSeq per comparison", async () => {
    const useStore = await freshStore();
    const o = { schema: "app_core", name: "orders_v", kind: "view" as const };
    useStore.getState().openObjectTab("qa", o);
    const id = useStore.getState().activeTabId;
    const tab = () => useStore.getState().tabs.find((t) => t.id === id)!;
    expect(tab()).toMatchObject({
      kind: "object",
      title: "orders_v",
      schema: "app_core",
      connectionId: "qa",
    });

    useStore.getState().setActiveTab("tab-1");
    const tabs = useStore.getState().tabs;
    useStore.getState().openObjectTab("qa", { ...o });
    expect(useStore.getState().activeTabId).toBe(id);
    expect(useStore.getState().tabs).toBe(tabs);

    useStore.getState().openObjectTab("qa", o, "prod");
    expect(tab()).toMatchObject({ compareWith: "prod", compareSeq: 1 });
    useStore.getState().openObjectTab("qa", o, "prod");
    expect(tab().compareSeq).toBe(2);

    // Same object on another connection is a different tab.
    useStore.getState().openObjectTab("dev", o);
    expect(useStore.getState().tabs).toHaveLength(3);
  });

  it("openJobTab opens once per connection and job", async () => {
    const useStore = await freshStore();
    const s = useStore.getState();
    s.openJobTab("qa", { id: "7", name: "nightly" });
    const id = useStore.getState().activeTabId;
    expect(useStore.getState().tabs[1]).toMatchObject({
      kind: "job",
      title: "nightly",
      job: { id: "7", name: "nightly" },
    });
    s.setActiveTab("tab-1");
    s.openJobTab("qa", { id: "7", name: "nightly" });
    expect(useStore.getState().activeTabId).toBe(id);
    s.openJobTab("qa", { id: "8", name: "weekly" });
    expect(useStore.getState().tabs).toHaveLength(3);
  });
});

describe("settings", () => {
  it("togglePhi and setPhi persist; turning the shield on drops the reason", async () => {
    const useStore = await freshStore();
    useStore.getState().togglePhi();
    expect(useStore.getState().phiEnabled).toBe(false);
    expect(mem.phi_shield).toBe("off");
    useStore.getState().togglePhi();
    expect(mem.phi_shield).toBe("on");

    mem.phi_unmask_reason = "audit";
    mem.phi_unmask_notes = "n";
    useStore.getState().setPhi(false);
    expect(mem.phi_shield).toBe("off");
    expect(mem.phi_unmask_reason).toBe("audit");
    useStore.getState().setPhi(true);
    expect(useStore.getState().phiEnabled).toBe(true);
    expect(mem.phi_unmask_reason).toBeUndefined();
    expect(mem.phi_unmask_notes).toBeUndefined();
  });

  it("clamps the default limit to 1..10000", async () => {
    const useStore = await freshStore();
    const s = useStore.getState();
    s.setDefaultLimitEnabled(false);
    expect(mem.dbpilot_limit_enabled).toBe("false");
    expect(useStore.getState().defaultLimitEnabled).toBe(false);
    s.setDefaultLimitValue(0);
    expect(useStore.getState().defaultLimitValue).toBe(1);
    s.setDefaultLimitValue(50000);
    expect(useStore.getState().defaultLimitValue).toBe(10000);
    expect(mem.dbpilot_limit_value).toBe("10000");
  });

  it("setViMode persists on/off", async () => {
    const useStore = await freshStore();
    useStore.getState().setViMode(true);
    expect(mem.dbpilot_vi_mode).toBe("on");
    useStore.getState().setViMode(false);
    expect(mem.dbpilot_vi_mode).toBe("off");
    expect(useStore.getState().viModeEnabled).toBe(false);
  });
});

describe("lists and panels", () => {
  it("manages saved queries", async () => {
    const useStore = await freshStore();
    const s = useStore.getState();
    const q = (id: string, name: string) => ({ id, name }) as never;
    s.setSavedQueries([q("1", "a")]);
    s.addSavedQuery(q("2", "b"));
    s.updateSavedQuery(q("1", "a2"));
    expect(
      useStore.getState().savedQueries.map((x: { name: string }) => x.name),
    ).toEqual(["b", "a2"]);
    s.removeSavedQuery("2");
    expect(useStore.getState().savedQueries).toEqual([q("1", "a2")]);
  });

  it("manages artifacts", async () => {
    const useStore = await freshStore();
    useStore.getState().setArtifacts([{ id: "a" }, { id: "b" }] as never);
    useStore.getState().removeArtifact("a");
    expect(useStore.getState().artifacts).toEqual([{ id: "b" }]);
  });

  it("toggles panels and holds the handoff and badge count", async () => {
    const useStore = await freshStore();
    const s = useStore.getState();
    s.toggleSidebar();
    expect(useStore.getState().sidebarOpen).toBe(false);
    s.togglePhiPanel();
    expect(useStore.getState().phiPanelOpen).toBe(true);
    s.toggleAiAssistant();
    expect(useStore.getState().aiAssistantOpen).toBe(true);
    s.setAiAssistant(false);
    expect(useStore.getState().aiAssistantOpen).toBe(false);
    s.setWriteHandoff({ writeSql: "update t set x = 1" });
    expect(useStore.getState().writeHandoff).toEqual({
      writeSql: "update t set x = 1",
    });
    s.setActionRequiredCount(3);
    expect(useStore.getState().actionRequiredCount).toBe(3);
  });
});
