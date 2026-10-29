import { describe, it, expect, vi, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

/**
 * Archival once copied rows with a positional `SELECT *`. The live table got
 * phi_unmask_reason/notes by ALTER (appended after `timestamp`), the archive
 * declares them before it, so values shifted, NOT NULL failed, INSERT OR IGNORE
 * skipped the row — and the DELETE still ran. Entries vanished.
 */

const dir = mkdtempSync(path.join(tmpdir(), "d-pilot-audit-archive-"));
vi.stubEnv("DATA_DIR", dir);
vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "");

const store = await import("./sqlite-store.js");
store.initDatabase();

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("archiveOldAuditEntries", () => {
  it("moves old entries intact and keeps recent ones live", () => {
    const old = "2020-01-02 03:04:05";
    const insert = store.getDb().prepare(
      `INSERT INTO audit_log (id, user_id, user_email, action, sql, phi_accessed,
         phi_fields_unmasked, phi_unmask_reason, phi_unmask_notes, timestamp)
       VALUES (?, 'u1', 'u1@example.com', ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run("plain", "QUERY_EXECUTE", "SELECT 1", 0, null, null, null, old);
    insert.run(
      "unmask",
      "PHI_UNMASK",
      null,
      1,
      '["email"]',
      "Support ticket",
      "case 42",
      old,
    );
    store.logAudit({
      userId: "u1",
      userEmail: "u1@example.com",
      action: "QUERY_EXECUTE",
      sql: "SELECT recent",
      phiAccessed: false,
    });

    expect(store.archiveOldAuditEntries(30)).toEqual({ archived: 2 });

    const archived = store.queryArchive({});
    expect(archived.map((e) => e.id).sort()).toEqual(["plain", "unmask"]);
    expect(archived.find((e) => e.id === "unmask")).toMatchObject({
      action: "PHI_UNMASK",
      phiAccessed: true,
      phiFieldsUnmasked: ["email"],
      phiUnmaskReason: "Support ticket",
      phiUnmaskNotes: "case 42",
      timestamp: old,
    });
    expect(archived.find((e) => e.id === "plain")?.timestamp).toBe(old);

    const live = store.getAuditLog({});
    expect(live.map((e) => e.sql)).toEqual(["SELECT recent"]);
  });
});
