import type { QueryTab, ResultViewMode } from "../types";

const STORAGE_KEY = "dbpilot_tabs";
const CURRENT_VERSION = 1;

interface PersistedTab {
  id: string;
  title: string;
  sql: string;
  connectionId: string | null;
  viewMode?: ResultViewMode;
}

interface PersistedTabData {
  version: number;
  tabs: PersistedTab[];
  activeTabId: string;
  activeConnectionId: string | null;
  sidebarOpen: boolean;
}

interface PersistableState {
  tabs: QueryTab[];
  activeTabId: string;
  activeConnectionId: string | null;
  sidebarOpen: boolean;
}

function sanitizeTab(tab: QueryTab): PersistedTab {
  return {
    id: tab.id,
    title: tab.title,
    sql: tab.sql,
    connectionId: tab.connectionId,
    viewMode: tab.viewMode,
  };
}

export function saveTabs(state: PersistableState): void {
  try {
    const data: PersistedTabData = {
      version: CURRENT_VERSION,
      tabs: state.tabs.map(sanitizeTab),
      activeTabId: state.activeTabId,
      activeConnectionId: state.activeConnectionId,
      sidebarOpen: state.sidebarOpen,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    console.warn("[tab-persistence] Failed to save tabs:", e);
  }
}

export function loadTabs(): PersistedTabData | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    const data = JSON.parse(raw) as PersistedTabData;

    if (data.version !== CURRENT_VERSION || !Array.isArray(data.tabs) || data.tabs.length === 0) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }

    return data;
  } catch {
    console.warn("[tab-persistence] Corrupted data, clearing.");
    localStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

export function clearPersistedTabs(): void {
  localStorage.removeItem(STORAGE_KEY);
}

interface DebouncedSave {
  (state: PersistableState): void;
  flush: () => void;
}

export function createDebouncedSave(delayMs = 500): DebouncedSave {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: PersistableState | null = null;

  const debouncedFn = ((state: PersistableState) => {
    pending = state;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (pending) saveTabs(pending);
      pending = null;
      timer = null;
    }, delayMs);
  }) as DebouncedSave;

  debouncedFn.flush = () => {
    if (timer) clearTimeout(timer);
    if (pending) saveTabs(pending);
    pending = null;
    timer = null;
  };

  return debouncedFn;
}
