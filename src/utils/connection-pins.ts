import type { ConnectionInfo } from "@src/types";

const KEY = "dbpilot_conn_pins";

/** user id → that user's pinned connection ids, in pin order. Per user so a shared browser doesn't blend pins. */
export type PinsByUser = Record<string, string[]>;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const mineOf = (all: PinsByUser, userId: string): string[] =>
  Array.isArray(all[userId])
    ? all[userId].filter((x) => typeof x === "string")
    : [];

export function loadPins(): PinsByUser {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) || "{}");
    return isObject(raw) ? (raw as PinsByUser) : {};
  } catch {
    return {};
  }
}

export function savePins(all: PinsByUser): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // storage blocked — pins are a display preference, not state
  }
}

/** Append on pin, remove on unpin. */
export function togglePin(
  all: PinsByUser,
  userId: string,
  connId: string,
): PinsByUser {
  const mine = mineOf(all, userId);
  const next = mine.includes(connId)
    ? mine.filter((id) => id !== connId)
    : [...mine, connId];
  return { ...all, [userId]: next };
}

/** Move `fromId` to `toId`'s slot within the user's pins. No-op unless both are pinned and differ. */
export function movePin(
  all: PinsByUser,
  userId: string,
  fromId: string,
  toId: string,
): PinsByUser {
  const mine = mineOf(all, userId);
  const from = mine.indexOf(fromId);
  const to = mine.indexOf(toId);
  if (from < 0 || to < 0 || from === to) return all;
  const next = [...mine];
  next.splice(to, 0, next.splice(from, 1)[0]);
  return { ...all, [userId]: next };
}

/** Pinned first, in pin order; the rest keep their incoming order. Stale ids are ignored. */
export function sortPinnedFirst(
  conns: ConnectionInfo[],
  pinnedIds: string[] | undefined,
): ConnectionInfo[] {
  const ids = Array.isArray(pinnedIds) ? pinnedIds : [];
  const byId = new Map(conns.map((c) => [c.id, c]));
  const pinned = [...new Set(ids)].flatMap((id) => byId.get(id) ?? []);
  const set = new Set(pinned.map((c) => c.id));
  return [...pinned, ...conns.filter((c) => !set.has(c.id))];
}
