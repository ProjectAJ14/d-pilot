import type { ConnectionInfo } from "@src/types";

const KEY = "dbpilot_conn_last_used";

/** connection id → last-used epoch ms, for one user. */
export type LastUsed = Record<string, number>;
/** user id → that user's LastUsed. Keyed per user so a shared browser doesn't blend histories. */
export type LastUsedByUser = Record<string, LastUsed>;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function loadLastUsed(): LastUsedByUser {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) || "{}");
    return isObject(raw) ? (raw as LastUsedByUser) : {};
  } catch {
    return {};
  }
}

export function saveLastUsed(all: LastUsedByUser): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // storage blocked — recency is a convenience, not state
  }
}

export function touch(
  all: LastUsedByUser,
  userId: string,
  connId: string,
  now: number,
): LastUsedByUser {
  const mine = isObject(all[userId]) ? all[userId] : {};
  return { ...all, [userId]: { ...mine, [connId]: now } };
}

/** Most recently used first; never-used keep their original order (stable sort). */
export function sortByRecent(
  conns: ConnectionInfo[],
  lastUsed: LastUsed | undefined,
): ConnectionInfo[] {
  const m = isObject(lastUsed) ? lastUsed : {};
  return [...conns].sort((a, b) => (m[b.id] ?? 0) - (m[a.id] ?? 0));
}
