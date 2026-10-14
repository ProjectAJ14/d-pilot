import type { ConnectionInfo } from "@src/types";

/** Normalised query: trimmed + lowercased ("" = no search). */
export const normalizeQuery = (raw: string) => raw.trim().toLowerCase();

export const nameMatches = (name: string, q: string) =>
  name.toLowerCase().includes(q);

/**
 * Keep connections whose name matches, or whose already-loaded tables match,
 * and drop environments left empty. `q === ""` returns the input untouched.
 * Tables are never fetched here — only the ones in `tableNamesOf` count.
 */
export function filterGroups(
  grouped: Record<string, ConnectionInfo[]>,
  q: string,
  tableNamesOf: (c: ConnectionInfo) => string[],
): Record<string, ConnectionInfo[]> {
  if (!q) return grouped;
  const out: Record<string, ConnectionInfo[]> = {};
  for (const [env, cs] of Object.entries(grouped)) {
    const kept = cs.filter(
      (c) =>
        nameMatches(c.name, q) ||
        tableNamesOf(c).some((t) => nameMatches(t, q)),
    );
    if (kept.length) out[env] = kept;
  }
  return out;
}

/** First preference still present in `visible`, else the first env. */
export function pickEnv(
  visible: Record<string, unknown>,
  ...prefs: (string | null | undefined)[]
): string | undefined {
  return prefs.find((e) => e && visible[e]) || Object.keys(visible)[0];
}
