import { create } from "zustand";
import type { ConnectionInfo, QueryTab, SavedQuery } from "../types";
import { loadTabs, clearPersistedTabs, createDebouncedSave } from "../utils/tab-persistence";

interface AuthUser {
  id: string;
  username: string;
  email: string;
  name: string;
  role: string;
  isAdmin: boolean;
  canUnmaskPhi: boolean;
}

interface AppConfig {
  appName: string;
  logoUrl: string | null;
  lightLogoUrl: string | null;
  emailDomain: string | null;
  phiMaskedEnvironments: string[];
}

interface AppState {
  // Config
  config: AppConfig;
  setConfig: (config: AppConfig) => void;

  // Auth
  token: string | null;
  user: AuthUser | null;
  isAuthenticated: boolean;
  login: (token: string, user: AuthUser) => void;
  logout: () => void;

  // Connections
  connections: ConnectionInfo[];
  activeConnectionId: string | null;
  setConnections: (connections: ConnectionInfo[]) => void;
  setActiveConnection: (id: string) => void;

  // Tabs
  tabs: QueryTab[];
  activeTabId: string;
  addTab: (connectionId?: string | null) => void;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  updateTab: (id: string, updates: Partial<QueryTab>) => void;

  // PHI Shield
  phiEnabled: boolean;
  togglePhi: () => void;
  setPhi: (enabled: boolean) => void;

  // Query Limit
  defaultLimitEnabled: boolean;
  defaultLimitValue: number;
  setDefaultLimitEnabled: (enabled: boolean) => void;
  setDefaultLimitValue: (value: number) => void;

  // Saved Queries
  savedQueries: SavedQuery[];
  setSavedQueries: (queries: SavedQuery[]) => void;
  addSavedQuery: (query: SavedQuery) => void;
  updateSavedQuery: (query: SavedQuery) => void;
  removeSavedQuery: (id: string) => void;

  // Sidebar
  sidebarOpen: boolean;
  toggleSidebar: () => void;

  // PHI Config Panel
  phiPanelOpen: boolean;
  togglePhiPanel: () => void;
}

let tabCounter = 1;

function createTab(connectionId?: string | null): QueryTab {
  const id = `tab-${tabCounter++}`;
  return {
    id,
    title: `Query ${tabCounter - 1}`,
    sql: "",
    connectionId: connectionId ?? null,
    result: null,
    loading: false,
    error: null,
  };
}

const savedToken = localStorage.getItem("dbpilot_token");
const savedUser = localStorage.getItem("dbpilot_user");
const savedLimitEnabled = localStorage.getItem("dbpilot_limit_enabled") !== "false";
const savedLimitValue = parseInt(localStorage.getItem("dbpilot_limit_value") || "500", 10);

const persistedTabs = loadTabs();
const debouncedSave = createDebouncedSave(500);

if (persistedTabs) {
  tabCounter = Math.max(
    ...persistedTabs.tabs.map((t) => {
      const match = t.id.match(/^tab-(\d+)$/);
      return match ? parseInt(match[1], 10) : 0;
    }),
    0
  ) + 1;
}

const initialTabs: QueryTab[] = persistedTabs
  ? persistedTabs.tabs.map((t) => ({
      id: t.id,
      title: t.title,
      sql: t.sql,
      connectionId: t.connectionId,
      viewMode: t.viewMode,
      result: null,
      loading: false,
      error: null,
    }))
  : [createTab()];

const initialActiveTabId = persistedTabs?.activeTabId ?? initialTabs[0].id;
const initialActiveConnectionId = persistedTabs?.activeConnectionId ?? null;
const initialSidebarOpen = persistedTabs?.sidebarOpen ?? true;

function persistAfterSet() {
  const s = useStore.getState();
  debouncedSave({
    tabs: s.tabs,
    activeTabId: s.activeTabId,
    activeConnectionId: s.activeConnectionId,
    sidebarOpen: s.sidebarOpen,
  });
}

window.addEventListener("beforeunload", () => debouncedSave.flush());

export const useStore = create<AppState>((set, get) => ({
  // Config
  config: { appName: "D-Pilot", logoUrl: null, lightLogoUrl: null, emailDomain: null, phiMaskedEnvironments: ["PROD"] },
  setConfig: (config) => set({ config }),

  // Auth
  token: savedToken,
  user: savedUser ? JSON.parse(savedUser) : null,
  isAuthenticated: !!savedToken,
  login: (token, user) => {
    localStorage.setItem("dbpilot_token", token);
    localStorage.setItem("dbpilot_user", JSON.stringify(user));
    set({ token, user, isAuthenticated: true });
  },
  logout: () => {
    localStorage.removeItem("dbpilot_token");
    localStorage.removeItem("dbpilot_user");
    clearPersistedTabs();
    set({ token: null, user: null, isAuthenticated: false });
  },

  // Connections
  connections: [],
  activeConnectionId: initialActiveConnectionId,
  setConnections: (connections) => set({ connections }),
  setActiveConnection: (id) => {
    set({ activeConnectionId: id });
    const { activeTabId, tabs } = get();
    set({
      tabs: tabs.map((t) =>
        t.id === activeTabId ? { ...t, connectionId: id } : t
      ),
    });
    persistAfterSet();
  },

  // Tabs
  tabs: initialTabs,
  activeTabId: initialActiveTabId,
  addTab: (connectionId) => {
    const tab = createTab(connectionId ?? get().activeConnectionId);
    set((s) => ({
      tabs: [...s.tabs, tab],
      activeTabId: tab.id,
    }));
    persistAfterSet();
  },
  closeTab: (id) => {
    set((s) => {
      const remaining = s.tabs.filter((t) => t.id !== id);
      if (remaining.length === 0) {
        const newTab = createTab(s.activeConnectionId);
        return { tabs: [newTab], activeTabId: newTab.id };
      }
      const newActive =
        s.activeTabId === id
          ? remaining[remaining.length - 1].id
          : s.activeTabId;
      return { tabs: remaining, activeTabId: newActive };
    });
    persistAfterSet();
  },
  setActiveTab: (id) => {
    set({ activeTabId: id });
    persistAfterSet();
  },
  updateTab: (id, updates) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...updates } : t)),
    }));
    persistAfterSet();
  },

  // PHI Shield
  phiEnabled: localStorage.getItem("phi_shield") !== "off",
  togglePhi: () =>
    set((s) => {
      const next = !s.phiEnabled;
      localStorage.setItem("phi_shield", next ? "on" : "off");
      return { phiEnabled: next };
    }),
  setPhi: (enabled) => {
    localStorage.setItem("phi_shield", enabled ? "on" : "off");
    if (enabled) {
      localStorage.removeItem("phi_unmask_reason");
      localStorage.removeItem("phi_unmask_notes");
    }
    set({ phiEnabled: enabled });
  },

  // Query Limit
  defaultLimitEnabled: savedLimitEnabled,
  defaultLimitValue: isNaN(savedLimitValue) ? 500 : savedLimitValue,
  setDefaultLimitEnabled: (enabled) => {
    localStorage.setItem("dbpilot_limit_enabled", String(enabled));
    set({ defaultLimitEnabled: enabled });
  },
  setDefaultLimitValue: (value) => {
    const clamped = Math.max(1, Math.min(value, 10000));
    localStorage.setItem("dbpilot_limit_value", String(clamped));
    set({ defaultLimitValue: clamped });
  },

  // Saved Queries
  savedQueries: [],
  setSavedQueries: (queries) => set({ savedQueries: queries }),
  addSavedQuery: (query) =>
    set((s) => ({ savedQueries: [query, ...s.savedQueries] })),
  updateSavedQuery: (query) =>
    set((s) => ({ savedQueries: s.savedQueries.map((q) => (q.id === query.id ? query : q)) })),
  removeSavedQuery: (id) =>
    set((s) => ({ savedQueries: s.savedQueries.filter((q) => q.id !== id) })),

  // Sidebar
  sidebarOpen: initialSidebarOpen,
  toggleSidebar: () => {
    set((s) => ({ sidebarOpen: !s.sidebarOpen }));
    persistAfterSet();
  },

  // PHI Config Panel
  phiPanelOpen: false,
  togglePhiPanel: () => set((s) => ({ phiPanelOpen: !s.phiPanelOpen })),
}));
