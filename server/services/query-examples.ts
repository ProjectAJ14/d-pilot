// Selects example queries to include as few-shot hints in the AI prompt.
//
// Strategy: figure out which schema tables the user's request is about (by
// matching schema table names against the prompt), then pull the most recent
// saved queries that actually reference those tables — but only same-dialect
// ones, so the examples are runnable on this connection. Real, working queries
// teach the model this DB's naming, join patterns, and conventions.

import type { ConnectionConfig, DatabaseType, SavedQuery } from "../types/index.js";
import { getConnection } from "../config/connections.js";

const MAX_EXAMPLES = 3;

export interface ExampleQuery {
  name: string;
  sql: string;
}

/** Lowercase, strip quoting/brackets and any schema/db prefix → bare table name. */
function normalizeTable(raw: string): string {
  let t = raw.trim().replace(/["'`[\]]/g, "");
  const dot = t.lastIndexOf(".");
  if (dot >= 0) t = t.slice(dot + 1);
  return t.toLowerCase();
}

function singular(s: string): string {
  return s.endsWith("s") && s.length > 3 ? s.slice(0, -1) : s;
}

/** Tables/collections/indices referenced by a query, per dialect. */
export function extractReferencedTables(sql: string, type: DatabaseType): Set<string> {
  const out = new Set<string>();
  if (!sql) return out;

  if (type === "mongodb") {
    for (const m of sql.matchAll(/\bdb\.([A-Za-z0-9_]+)/g)) out.add(m[1].toLowerCase());
    return out;
  }
  if (type === "elasticsearch") {
    for (const m of sql.matchAll(/(?:GET|POST|PUT)\s+\/?([\w\-.*]+)\s*\/\s*_(?:search|count|doc)/gi)) {
      out.add(m[1].toLowerCase());
    }
    return out;
  }
  // SQL dialects (postgres, mssql): tables follow FROM / JOIN / INTO / UPDATE.
  for (const m of sql.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+("[^"]+"|\[[^\]]+\]|[A-Za-z_][\w.]*)/gi)) {
    out.add(normalizeTable(m[1]));
  }
  return out;
}

/** Schema tables that the user's prompt appears to be about (with plural tolerance). */
function candidateTablesFromPrompt(prompt: string, schemaTableNames: string[]): Set<string> {
  const tokens = new Set(
    prompt
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter(Boolean)
  );
  const singularTokens = new Set([...tokens].map(singular));

  const matched = new Set<string>();
  for (const raw of schemaTableNames) {
    const name = normalizeTable(raw);
    if (!name) continue;
    const last = name.split(/[_.]/).filter(Boolean).pop() || name; // entity part of snake_case
    if (
      tokens.has(name) ||
      singularTokens.has(singular(name)) ||
      (last.length >= 4 && (tokens.has(last) || singularTokens.has(singular(last))))
    ) {
      matched.add(name);
    }
  }
  return matched;
}

/**
 * Returns up to 3 recent saved queries that reference the tables the prompt is
 * about, restricted to the same dialect as `conn`. Empty when nothing matches.
 * `savedQueries` is expected newest-first (as `getSavedQueries` returns them).
 */
export function selectExampleQueries(
  conn: ConnectionConfig,
  prompt: string,
  schemaTableNames: string[],
  savedQueries: SavedQuery[]
): ExampleQuery[] {
  const candidates = candidateTablesFromPrompt(prompt, schemaTableNames);
  if (candidates.size === 0) return [];

  const examples: ExampleQuery[] = [];
  for (const q of savedQueries) {
    if (!q.sql || !q.connectionId) continue;
    // Same dialect only — an example must be runnable on this connection.
    const qConn = getConnection(q.connectionId);
    if (!qConn || qConn.type !== conn.type) continue;

    const refs = extractReferencedTables(q.sql, conn.type);
    let overlaps = false;
    for (const t of refs) {
      if (candidates.has(t)) { overlaps = true; break; }
    }
    if (!overlaps) continue;

    examples.push({ name: q.name, sql: q.sql });
    if (examples.length >= MAX_EXAMPLES) break;
  }
  return examples;
}
