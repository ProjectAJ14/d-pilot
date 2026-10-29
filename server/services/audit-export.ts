import type { Response } from "express";
import type { AuditEntry } from "../types/index.js";

/**
 * CSV export of audit entries — the admin audit log and a user's own query
 * history. Both are bounded the same way: a date range of at most
 * EXPORT_MAX_DAYS (inclusive), and at most EXPORT_MAX_ROWS rows. A range over
 * the row cap is refused rather than truncated, so a file never looks complete
 * when it is not.
 */
export const EXPORT_MAX_DAYS = 14;
export const EXPORT_MAX_ROWS = 10_000;

const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDay(value: unknown): number | null {
  if (typeof value !== "string" || !DATE_RE.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  // Date.parse rolls 2026-02-30 over to March; reject anything that moved.
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value)
    return null;
  return ms;
}

/**
 * Validate `from`/`to` (YYYY-MM-DD, UTC like the stored timestamps) and turn
 * them into bounds for `timestamp`, which SQLite stores as `YYYY-MM-DD HH:MM:SS`.
 */
export function parseExportRange(
  from: unknown,
  to: unknown,
): { from: string; to: string } | { error: string } {
  const start = parseDay(from);
  const end = parseDay(to);
  if (start === null || end === null) {
    return { error: "from and to are required dates (YYYY-MM-DD)" };
  }
  if (end < start) return { error: "to must not be before from" };
  if ((end - start) / DAY_MS + 1 > EXPORT_MAX_DAYS) {
    return {
      error: `Export range is limited to ${EXPORT_MAX_DAYS} days`,
    };
  }
  return { from: from as string, to: `${to as string} 23:59:59` };
}

export const AUDIT_COLUMNS: (keyof AuditEntry)[] = [
  "timestamp",
  "userEmail",
  "action",
  "connectionId",
  "sql",
  "rowsReturned",
  "executionMs",
  "phiAccessed",
  "phiFieldsUnmasked",
  "phiUnmaskReason",
  "phiUnmaskNotes",
  "userId",
  "id",
];

export const HISTORY_COLUMNS: (keyof AuditEntry)[] = [
  "timestamp",
  "connectionId",
  "sql",
  "rowsReturned",
  "executionMs",
];

/**
 * One CSV cell. Text starting with `= + - @` (or tab/CR) gets a leading `'` so a
 * spreadsheet opens it as text: the SQL in an audit row is typed by other
 * users, and the admin opening the file must not run a formula planted there.
 */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = Array.isArray(value) ? value.join("; ") : String(value);
  // Check the final text, not the input type: a joined array (PHI column names
  // come from the target database's schema) can start with `=` just as well.
  // Numbers and booleans are ours, and "-1" must stay a number.
  const ours = typeof value === "number" || typeof value === "boolean";
  if (!ours && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toAuditCsv(
  entries: AuditEntry[],
  columns: (keyof AuditEntry)[] = AUDIT_COLUMNS,
): string {
  const lines = [columns.join(",")];
  for (const e of entries)
    lines.push(columns.map((c) => csvCell(e[c])).join(","));
  return lines.join("\n");
}

export function sendCsv(res: Response, filename: string, csv: string): void {
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename=${filename}`);
  res.send(csv);
}

export const TOO_MANY_ROWS = `More than ${EXPORT_MAX_ROWS.toLocaleString("en-US")} entries in this range — narrow the dates or add a filter`;
