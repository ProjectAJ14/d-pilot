import { Router, Request, Response } from "express";
import {
  getAuditLog,
  archiveOldAuditEntries,
  queryArchive,
  logAudit,
  type AuditFilter,
} from "../services/sqlite-store.js";
import {
  EXPORT_MAX_ROWS,
  TOO_MANY_ROWS,
  parseExportRange,
  sendCsv,
  toAuditCsv,
} from "../services/audit-export.js";
import { requireAdmin } from "../middleware/auth.js";

const router = Router();

// Filters shared by the list, archive and export routes. `phi=1` selects PHI
// access of any kind, so paging over it stays server-side.
function auditFilter(req: Request): AuditFilter {
  return {
    action: (req.query.action as string) || undefined,
    userId: (req.query.userId as string) || undefined,
    phiOnly: req.query.phi === "1",
  };
}

function pageOf(req: Request): AuditFilter {
  return {
    ...auditFilter(req),
    limit: Math.min(parseInt(req.query.limit as string) || 100, 1000),
    offset: parseInt(req.query.offset as string) || 0,
    from: req.query.from as string | undefined,
    to: req.query.to as string | undefined,
  };
}

// List audit entries with optional filters
router.get("/", requireAdmin, (req: Request, res: Response) => {
  res.json(getAuditLog(pageOf(req)));
});

// Query archived audit entries
router.get("/archive", requireAdmin, (req: Request, res: Response) => {
  res.json(queryArchive(pageOf(req)));
});

// CSV export of a date range (≤ 14 days, ≤ 10,000 rows). Audited.
router.get("/export", requireAdmin, (req: Request, res: Response) => {
  const range = parseExportRange(req.query.from, req.query.to);
  if ("error" in range) {
    res.status(400).json({ error: range.error });
    return;
  }
  const source = req.query.source === "archive" ? "archive" : "live";
  const filter = { ...auditFilter(req), ...range, limit: EXPORT_MAX_ROWS + 1 };
  const entries =
    source === "archive" ? queryArchive(filter) : getAuditLog(filter);
  if (entries.length > EXPORT_MAX_ROWS) {
    res.status(422).json({ error: TOO_MANY_ROWS });
    return;
  }

  const scope = [
    filter.action && `action=${filter.action}`,
    filter.userId && `userId=${filter.userId}`,
    filter.phiOnly && "PHI only",
  ].filter(Boolean);
  logAudit({
    userId: req.user!.sub,
    userEmail: req.user!.email,
    action: "AUDIT_EXPORT",
    sql: `Exported ${entries.length} ${source} audit entries, ${req.query.from} to ${req.query.to}${scope.length ? ` (${scope.join(", ")})` : ""}`,
    rowsReturned: entries.length,
    phiAccessed: false,
  });
  sendCsv(
    res,
    `audit-log-${source}-${req.query.from}-to-${req.query.to}.csv`,
    toAuditCsv(entries),
  );
});

// Trigger manual archival
router.post("/archive", requireAdmin, (_req: Request, res: Response) => {
  const result = archiveOldAuditEntries();
  res.json({
    archived: result.archived,
    message:
      result.archived > 0
        ? `Archived ${result.archived} entries older than 30 days`
        : "No entries to archive",
  });
});

export default router;
