import type { ConnectionConfig } from "../types/index.js";

let cachedConnections: ConnectionConfig[] | null = null;

export function loadConnections(): ConnectionConfig[] {
  if (cachedConnections) return cachedConnections;

  const raw = process.env.DBFORGE_CONNECTIONS;
  if (!raw) {
    console.warn("DBFORGE_CONNECTIONS not set, no database connections available");
    return [];
  }

  try {
    cachedConnections = JSON.parse(raw) as ConnectionConfig[];
    console.log(`Loaded ${cachedConnections.length} database connections`);
    return cachedConnections;
  } catch (err) {
    console.error("Failed to parse DBFORGE_CONNECTIONS:", err);
    return [];
  }
}

export function getConnection(id: string): ConnectionConfig | undefined {
  return loadConnections().find((c) => c.id === id);
}

/** Baseline order, least → most sensitive. Anything else goes after PROD. */
const KNOWN_ENV_ORDER = ["DEV", "QA", "UAT", "STG", "PROD"];

/**
 * The environments this deployment actually has, ordered least → most sensitive.
 * Derived from `DBFORGE_CONNECTIONS`, so adding a connection with a new `env`
 * (e.g. `SUPER_PROD`) is all it takes to make that environment appear in the
 * capability pickers, PHI settings, write policy and the connection tree.
 *
 * This is the single source of truth — routes and the client must not re-declare
 * an environment list. Unknown envs sort after PROD (treated as most sensitive);
 * PROD's own safety rails still key off the literal `"PROD"`.
 */
export function getEnvironments(): string[] {
  const found = new Set(loadConnections().map((c) => c.env));
  if (found.size === 0) return [...KNOWN_ENV_ORDER];
  const known = KNOWN_ENV_ORDER.filter((e) => found.has(e));
  const extra = [...found].filter((e) => !KNOWN_ENV_ORDER.includes(e)).sort();
  return [...known, ...extra];
}

export function getConnectionsByEnv(): Record<string, ConnectionConfig[]> {
  const connections = loadConnections();
  const grouped: Record<string, ConnectionConfig[]> = {};
  for (const conn of connections) {
    if (!grouped[conn.env]) grouped[conn.env] = [];
    grouped[conn.env].push(conn);
  }
  return grouped;
}
