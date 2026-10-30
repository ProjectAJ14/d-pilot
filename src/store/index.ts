import {
  loadLastUsed,
  saveLastUsed,
  touch,
  type LastUsedByUser,
} from "@src/utils/connection-recency";
import {
  loadPins,
  savePins,
  movePin,
  togglePin,
  type PinsByUser,
} from "@src/utils/connection-pins";
import {
  loadNetworkHint,
  saveNetworkHint,
} from "@src/utils/server-reachability";
import { create } from "zustand";
import type {
  Artifact,
  ConnectionInfo,
  DbObjectInfo,
  QueryTab,
  SavedQuery,
} from "../types";
import {
  loadTabs,
  clearPersistedTabs,
  createDebouncedSave,
} from "../utils/tab-persistence";

interface AuthUser {
  id: string;
  username: string;
  email: string;
  name: string;
  isAdmin: boolean;
  canUnmaskPhi: boolean;
  allowedEnvironments?: string[];
  unmaskEnvironments?: string[];
  writeEnvironments?: string[];
  approveEnvironments?: string[];
  jobEnvironments?: string[];
  canWrite?: boolean;
  canApprove?: boolean;
}

interface AppConfig {
  appName: string;
  logoUrl: string | null;
  lightLogoUrl: string | null;
  faviconUrl: string | null;
  emailDomain: string | null;
  /** The two lines under the app name on the login page; "" hides one. */
  loginTagline: string;
  loginSubtitle: string;
  /** Deployment's advice when the server or a database is unreachable; "" = none. */
  networkHint: string;
  phiMaskedEnvironments: string[];
  /** Environments this deployment has, least → most sensitive (from the server). */
  environments: string[];
}

interface AppState {
  // Config
  config: AppConfig;
  setConfig: (config: AppConfig) => void;
  /** No response from the D-Pilot server (set/cleared by api-client); drives the banner. */
  serverUnreachable: boolean;
  setServerUnreachable: (v: boolean) => void;

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
  setActiveConnection: (id: string | null) => void;
  // Per-user "last picked in the explorer" times; only a deliberate pick counts
  // (setActiveConnection also runs for defaults and restores).
  connectionLastUsed: LastUsedByUser;
  markConnectionUsed: (id: string) => void;
  // Per-user pinned connection ids (display preference, localStorage only).
  connectionPins: PinsByUser;
  toggleConnectionPin: (id: string) => void;
  reorderConnectionPin: (fromId: string, toId: string) => void;

  // Selected schema per connection — single source of truth shared by the
  // sidebar explorer and the editor-toolbar schema dropdowns. Tabs on the
  // connection mirror it in `tab.schema`.
  schemaByConnection: Record<string, string>;
  setSchemaForConnection: (connectionId: string, schema: string) => void;

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

  // Editor keymap — opt-in vim keybindings across every SQL editor. Off by
  // default; set per-user from the Profile page and kept in localStorage.
  viModeEnabled: boolean;
  setViMode: (enabled: boolean) => void;

  // Saved Queries
  savedQueries: SavedQuery[];
  setSavedQueries: (queries: SavedQuery[]) => void;
  addSavedQuery: (query: SavedQuery) => void;
  updateSavedQuery: (query: SavedQuery) => void;
  removeSavedQuery: (id: string) => void;

  // Artifacts
  artifacts: Artifact[];
  setArtifacts: (artifacts: Artifact[]) => void;
  removeArtifact: (id: string) => void;
  /** Open an artifact as a tab, focusing it if it is already open. */
  openArtifactTab: (artifact: Pick<Artifact, "id" | "title">) => void;
  /** Open a procedure/function/view/trigger's definition as a tab, focusing it if open. */
  openObjectTab: (
    connectionId: string,
    object: DbObjectInfo,
    compareWith?: string,
  ) => void;

  /** Open a scheduled job as a tab, focusing it if open. */
  openJobTab: (connectionId: string, job: { id: string; name: string }) => void;

  // Sidebar
  sidebarOpen: boolean;
  toggleSidebar: () => void;

  // PHI Config Panel
  phiPanelOpen: boolean;
  togglePhiPanel: () => void;

  // AI Query Assistant Panel
  aiAssistantOpen: boolean;
  toggleAiAssistant: () => void;
  setAiAssistant: (open: boolean) => void;

  // Read → Write bridge: seed the write composer (from the read section, the AI
  // assistant, or "Duplicate request").
  writeHandoff: {
    writeSql: string;
    selectSql?: string;
    connectionId?: string | null;
    title?: string;
    description?: string;
  } | null;
  setWriteHandoff: (
    h: {
      writeSql: string;
      selectSql?: string;
      connectionId?: string | null;
      title?: string;
      description?: string;
    } | null,
  ) => void;

  // Requests: count of items needing the current user's attention (badge).
  actionRequiredCount: number;
  setActionRequiredCount: (n: number) => void;
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
const savedLimitEnabled =
  localStorage.getItem("dbpilot_limit_enabled") !== "false";
const savedLimitValue = parseInt(
  localStorage.getItem("dbpilot_limit_value") || "500",
  10,
);
// Opt-in: absent means off, unlike the shield/limit settings which default on.
const savedViMode = localStorage.getItem("dbpilot_vi_mode") === "on";

const persistedTabs = loadTabs();
const debouncedSave = createDebouncedSave(500);

if (persistedTabs) {
  tabCounter =
    Math.max(
      ...persistedTabs.tabs.map((t) => {
        const match = t.id.match(/^tab-(\d+)$/);
        return match ? parseInt(match[1], 10) : 0;
      }),
      0,
    ) + 1;
}

const initialTabs: QueryTab[] = persistedTabs
  ? persistedTabs.tabs.map((t) => ({
      id: t.id,
      title: t.title,
      kind: t.kind,
      artifactId: t.artifactId,
      object: t.object,
      job: t.job,
      sql: t.sql,
      connectionId: t.connectionId,
      schema: t.schema,
      viewMode: t.viewMode,
      result: null,
      loading: false,
      error: null,
    }))
  : [createTab()];

// Seed the per-connection schema selection from persisted tabs so restored
// sessions keep their last-used schema on both dropdowns.
const initialSchemaByConnection: Record<string, string> = {};
for (const t of initialTabs) {
  if (t.connectionId && t.schema)
    initialSchemaByConnection[t.connectionId] = t.schema;
}

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
  config: {
    appName: "D-Pilot",
    logoUrl: null,
    lightLogoUrl: null,
    faviconUrl: null,
    emailDomain: null,
    // Server defaults, shown until /api/config answers.
    loginTagline: "Internal query tool",
    loginSubtitle: "HIPAA · PHI tokenized",
    // Last-known, so the unreachable banner has it when /api/config can't load.
    networkHint: loadNetworkHint(),
    phiMaskedEnvironments: ["PROD"],
    // Empty until /api/config answers — an env picker must never offer an
    // environment this deployment may not have.
    environments: [],
  },
  setConfig: (config) => {
    saveNetworkHint(config.networkHint);
    set({ config });
  },
  serverUnreachable: false,
  setServerUnreachable: (serverUnreachable) => set({ serverUnreachable }),

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
  // The server's list: a tab still on a connection that is gone (deleted in
  // Settings) is detached from it, rather than querying a dead id, and the
  // schema remembered for it is dropped.
  setConnections: (connections) => {
    const ids = new Set(connections.map((c) => c.id));
    const gone = (id: string | null) => id !== null && !ids.has(id);
    set((s) => ({
      connections,
      schemaByConnection: Object.fromEntries(
        Object.entries(s.schemaByConnection).filter(([id]) => ids.has(id)),
      ),
      tabs: s.tabs.some((t) => gone(t.connectionId))
        ? s.tabs.map((t) =>
            gone(t.connectionId)
              ? { ...t, connectionId: null, schema: undefined }
              : t,
          )
        : s.tabs,
    }));
    persistAfterSet();
  },
  connectionLastUsed: loadLastUsed(),
  markConnectionUsed: (id) => {
    const { user, connectionLastUsed } = get();
    if (!user) return;
    const next = touch(connectionLastUsed, user.id, id, Date.now());
    set({ connectionLastUsed: next });
    saveLastUsed(next);
  },
  connectionPins: loadPins(),
  toggleConnectionPin: (id) => {
    const { user, connectionPins } = get();
    if (!user) return;
    const next = togglePin(connectionPins, user.id, id);
    set({ connectionPins: next });
    savePins(next);
  },
  reorderConnectionPin: (fromId, toId) => {
    const { user, connectionPins } = get();
    if (!user) return;
    const next = movePin(connectionPins, user.id, fromId, toId);
    if (next === connectionPins) return;
    set({ connectionPins: next });
    savePins(next);
  },
  setActiveConnection: (id) => {
    set({ activeConnectionId: id });
    const { activeTabId, tabs, schemaByConnection } = get();
    set({
      // Carry the connection's remembered schema (undefined if never browsed —
      // the editor's default-seeding fills it in).
      // Object and job tabs show something read from one database, so they
      // stay on it; only the tab the user queries from follows the pick.
      tabs: tabs.map((t) =>
        t.id === activeTabId && t.kind !== "object" && t.kind !== "job"
          ? {
              ...t,
              connectionId: id,
              schema: id ? schemaByConnection[id] : undefined,
            }
          : t,
      ),
    });
    persistAfterSet();
  },

  schemaByConnection: initialSchemaByConnection,
  setSchemaForConnection: (connectionId, schema) => {
    set((s) => ({
      schemaByConnection: { ...s.schemaByConnection, [connectionId]: schema },
      // Keep every tab on this connection in sync so the editor-toolbar
      // dropdown always mirrors the sidebar (and vice versa).
      tabs: s.tabs.map((t) =>
        t.connectionId === connectionId && t.schema !== schema
          ? { ...t, schema }
          : t,
      ),
    }));
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

  // Editor keymap
  viModeEnabled: savedViMode,
  setViMode: (enabled) => {
    localStorage.setItem("dbpilot_vi_mode", enabled ? "on" : "off");
    set({ viModeEnabled: enabled });
  },

  // Saved Queries
  savedQueries: [],
  setSavedQueries: (queries) => set({ savedQueries: queries }),
  addSavedQuery: (query) =>
    set((s) => ({ savedQueries: [query, ...s.savedQueries] })),
  updateSavedQuery: (query) =>
    set((s) => ({
      savedQueries: s.savedQueries.map((q) => (q.id === query.id ? query : q)),
    })),
  removeSavedQuery: (id) =>
    set((s) => ({ savedQueries: s.savedQueries.filter((q) => q.id !== id) })),

  // Artifacts
  artifacts: [],
  setArtifacts: (artifacts) => set({ artifacts }),
  removeArtifact: (id) =>
    set((s) => ({ artifacts: s.artifacts.filter((a) => a.id !== id) })),
  openArtifactTab: (artifact) => {
    const existing = get().tabs.find(
      (t) => t.kind === "artifact" && t.artifactId === artifact.id,
    );
    if (existing) {
      set({ activeTabId: existing.id });
    } else {
      const tab: QueryTab = {
        ...createTab(null),
        kind: "artifact",
        artifactId: artifact.id,
        title: artifact.title,
      };
      set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
    }
    persistAfterSet();
  },

  openObjectTab: (connectionId, object, compareWith) => {
    const same = (o?: DbObjectInfo) =>
      !!o &&
      (["schema", "name", "kind", "args", "parent"] as const).every(
        (k) => o[k] === object[k],
      );
    const existing = get().tabs.find(
      (t) =>
        t.kind === "object" &&
        t.connectionId === connectionId &&
        same(t.object),
    );
    if (existing) {
      set({ activeTabId: existing.id });
    } else {
      const tab: QueryTab = {
        ...createTab(connectionId),
        kind: "object",
        object,
        compareWith,
        schema: object.schema,
        title: object.name,
      };
      set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
    }
    persistAfterSet();
  },

  openJobTab: (connectionId, job) => {
    const existing = get().tabs.find(
      (t) =>
        t.kind === "job" &&
        t.connectionId === connectionId &&
        t.job?.id === job.id,
    );
    if (existing) {
      set({ activeTabId: existing.id });
    } else {
      const tab: QueryTab = {
        ...createTab(connectionId),
        kind: "job",
        job,
        title: job.name,
      };
      set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
    }
    persistAfterSet();
  },

  // Sidebar
  sidebarOpen: initialSidebarOpen,
  toggleSidebar: () => {
    set((s) => ({ sidebarOpen: !s.sidebarOpen }));
    persistAfterSet();
  },

  // PHI Config Panel
  phiPanelOpen: false,
  togglePhiPanel: () => set((s) => ({ phiPanelOpen: !s.phiPanelOpen })),

  // AI Query Assistant Panel
  aiAssistantOpen: false,
  toggleAiAssistant: () =>
    set((s) => ({ aiAssistantOpen: !s.aiAssistantOpen })),
  setAiAssistant: (open) => set({ aiAssistantOpen: open }),

  // Read → Write bridge
  writeHandoff: null,
  setWriteHandoff: (h) => set({ writeHandoff: h }),

  // Requests badge
  actionRequiredCount: 0,
  setActionRequiredCount: (n) => set({ actionRequiredCount: n }),
}));
