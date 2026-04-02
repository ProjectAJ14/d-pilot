import { Router, Request, Response } from "express";
import { getAuditLog } from "../services/sqlite-store.js";
import { requireAdmin } from "../middleware/auth.js";

const router = Router();

router.get("/", requireAdmin, (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 100, 1000);
  const offset = parseInt(req.query.offset as string) || 0;
  const entries = getAuditLog(limit, offset);
  res.json(entries);
});

export default router;
