import type { ConnectionConfig } from "../types/index.js";
import { listDbConnections } from "../services/sqlite-store.js";

let cachedConnections: ConnectionConfig[] | null = null;

/**
 * The target-database connections, from the app database's `db_connections`
 * table (managed in Settings → Connections). None before the DB is open.
 */
export function loadConnections(): ConnectionConfig[] {
  if (cachedConnections) return cachedConnections;
  cachedConnections = listDbConnections() ?? [];
  return cachedConnections;
}

/** Drop the memoized list; the store calls this on every connection write. */
export function invalidateConnections(): void {
  cachedConnections = null;
}

export function getConnection(id: string): ConnectionConfig | undefined {
  return loadConnections().find((c) => c.id === id);
}

/** Sort order, least → most sensitive. Anything else goes after PROD. */
const KNOWN_ENV_ORDER = ["DEV", "QA", "UAT", "STG", "PROD"];

/**
 * The environments this deployment actually has, ordered least → most sensitive.
 * Derived from the configured connections, so adding a connection with a new `env`
 * (e.g. `SUPER_PROD`) is all it takes to make that environment appear in the
 * capability pickers, PHI settings, write policy and the connection tree.
 *
 * This is the single source of truth — routes and the client must not re-declare
 * an environment list. Unknown envs sort after PROD (treated as most sensitive).
 * No connections → no environments.
 */
export function getEnvironments(): string[] {
  const found = new Set(loadConnections().map((c) => c.env));
  const known = KNOWN_ENV_ORDER.filter((e) => found.has(e));
  const extra = [...found].filter((e) => !KNOWN_ENV_ORDER.includes(e)).sort();
  return [...known, ...extra];
}

/**
 * An edited env list as it should be saved: exactly `sent`, when each entry is
 * an env that exists now or one `current` already holds. Pickers show saved
 * envs that have no connection right now, so keeping one means sending it back
 * and leaving it out revokes it. Returns null for anything else — an env that
 * was never saved before cannot be granted until a connection defines it.
 */
export function validEnvEdit(
  sent: unknown,
  current: string[],
): string[] | null {
  const known = getEnvironments();
  if (
    !Array.isArray(sent) ||
    !sent.every(
      (e) =>
        typeof e === "string" && (known.includes(e) || current.includes(e)),
    )
  )
    return null;
  return [...new Set(sent as string[])];
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
