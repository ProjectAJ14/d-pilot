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

export function getConnectionsByEnv(): Record<string, ConnectionConfig[]> {
  const connections = loadConnections();
  const grouped: Record<string, ConnectionConfig[]> = {};
  for (const conn of connections) {
    if (!grouped[conn.env]) grouped[conn.env] = [];
    grouped[conn.env].push(conn);
  }
  return grouped;
}
