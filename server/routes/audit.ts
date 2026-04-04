import { Router, Request, Response } from "express";
import { getAuditLog, archiveOldAuditEntries, queryArchive } from "../services/sqlite-store.js";
import { requireAdmin } from "../middleware/auth.js";

const router = Router();

// List audit entries with optional filters
router.get("/", requireAdmin, (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 100, 1000);
  const offset = parseInt(req.query.offset as string) || 0;
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;
  const action = req.query.action as string | undefined;
  const userId = req.query.userId as string | undefined;

  const entries = getAuditLog({ limit, offset, from, to, action, userId });
  res.json(entries);
});

// Query archived audit entries
router.get("/archive", requireAdmin, (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 100, 1000);
  const offset = parseInt(req.query.offset as string) || 0;
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;

  const entries = queryArchive({ limit, offset, from, to });
  res.json(entries);
});

// Trigger manual archival
router.post("/archive", requireAdmin, (_req: Request, res: Response) => {
  const result = archiveOldAuditEntries();
  res.json({
    archived: result.archived,
    message: result.archived > 0
      ? `Archived ${result.archived} entries older than 30 days`
      : "No entries to archive",
  });
});

export default router;
