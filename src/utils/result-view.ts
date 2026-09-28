import type { DatabaseType, ResultViewMode } from "../types";

/**
 * How a result opens before the user picks a view. Document stores return
 * nested documents, which a table flattens into unreadable JSON-in-a-cell, so
 * they open as JSON; everything else opens as a table. Every surface that shows
 * results (query tabs, artifact blocks, write previews) goes through this.
 */
export function defaultViewMode(dbType?: DatabaseType | null): ResultViewMode {
  return dbType === "mongodb" || dbType === "elasticsearch" ? "json" : "table";
}
