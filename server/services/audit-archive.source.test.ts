import { describe, it, expect, vi, afterAll } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

/**
 * Archives on disk predate the `source` column. Archival copies by named
 * columns, so an archive without it must be migrated first, or every move
 * fails and old entries pile up in the live table forever.
 */
const dir = mkdtempSync(path.join(tmpdir(), "d-pilot-audit-archive-src-"));
vi.stubEnv("DATA_DIR", dir);
vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "");

const legacy = new Database(path.join(dir, "audit_archive.sqlite"));
legacy.exec(`CREATE TABLE audit_log (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, user_email TEXT NOT NULL,
  action TEXT NOT NULL, sql TEXT, connection_id TEXT, rows_returned INTEGER,
  execution_ms INTEGER, phi_accessed INTEGER NOT NULL DEFAULT 0,
  phi_fields_unmasked TEXT, phi_unmask_reason TEXT, phi_unmask_notes TEXT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')))`);
legacy.close();

const store = await import("./sqlite-store.js");
store.initDatabase();

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("archiving into a pre-source archive", () => {
  it("migrates the archive and keeps the source", () => {
    store
      .getDb()
      .prepare(
        `INSERT INTO audit_log (id, user_id, user_email, action, phi_accessed, source, timestamp)
         VALUES ('old-mcp', 'u1', 'u1@example.com', 'QUERY_EXECUTE', 0, 'mcp', '2020-01-02 03:04:05')`,
      )
      .run();

    expect(store.archiveOldAuditEntries(30)).toEqual({ archived: 1 });
    expect(store.queryArchive({})).toMatchObject([
      { id: "old-mcp", source: "mcp" },
    ]);
  });
});
