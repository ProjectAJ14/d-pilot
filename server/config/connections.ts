import type { ConnectionConfig } from "../types/index.js";
import { listDbConnections } from "../services/sqlite-store.js";

let cachedConnections: ConnectionConfig[] | null = null;

/**
 * `DBFORGE_CONNECTIONS` parsed — the first-run seed for the `db_connections`
 * table (see `seedConnections` in sqlite-store). Unset → []; unparseable → null.
 */
export function parseEnvConnections(): ConnectionConfig[] | null {
  const raw = process.env.DBFORGE_CONNECTIONS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("not a JSON array");
    return parsed as ConnectionConfig[];
  } catch (err) {
    console.error("Failed to parse DBFORGE_CONNECTIONS:", err);
    return null;
  }
}

/**
 * The target-database connections. Once the app DB is up they come from its
 * `db_connections` table (admin-editable, seeded once from the env var); before
 * that — unit tests, scripts — straight from `DBFORGE_CONNECTIONS`.
 */
export function loadConnections(): ConnectionConfig[] {
  if (cachedConnections) return cachedConnections;
  cachedConnections = listDbConnections() ?? parseEnvConnections() ?? [];
  return cachedConnections;
}

/** Drop the memoized list; the store calls this on every connection write. */
export function invalidateConnections(): void {
  cachedConnections = null;
}

export function getConnection(id: string): ConnectionConfig | undefined {
  return loadConnections().find((c) => c.id === id);
}

/** Baseline order, least → most sensitive. Anything else goes after PROD. */
const KNOWN_ENV_ORDER = ["DEV", "QA", "UAT", "STG", "PROD"];

/**
 * The environments this deployment actually has, ordered least → most sensitive.
 * Derived from the configured connections, so adding a connection with a new `env`
 * (e.g. `SUPER_PROD`) is all it takes to make that environment appear in the
 * capability pickers, PHI settings, write policy and the connection tree.
 *
 * This is the single source of truth — routes and the client must not re-declare
 * an environment list. Unknown envs sort after PROD (treated as most sensitive).
 */
export function getEnvironments(): string[] {
  const found = new Set(loadConnections().map((c) => c.env));
  if (found.size === 0) return [...KNOWN_ENV_ORDER];
  const known = KNOWN_ENV_ORDER.filter((e) => found.has(e));
  const extra = [...found].filter((e) => !KNOWN_ENV_ORDER.includes(e)).sort();
  return [...known, ...extra];
}

/**
 * Whether an environment counts as production for the PHI safety rail. Any name
 * containing "prod" qualifies — `PROD`, `SUPER_PROD`, `PREPROD`, `PRODUCTION` —
 * so a deployment can't sidestep mandatory tokenization by naming a production
 * environment something new.
 */
export function isProductionEnv(env: string): boolean {
  return /prod/i.test(env);
}

/** Every production-like environment this deployment has. */
export function getProductionEnvs(): string[] {
  return getEnvironments().filter(isProductionEnv);
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
