import { Router, Request, Response } from "express";
import { getAnalytics } from "../services/sqlite-store.js";
import { requireAdmin } from "../middleware/auth.js";

const router = Router();

// Aggregate usage analytics derived from users, audit_log, ai_chat_log, saved_queries
router.get("/", requireAdmin, (_req: Request, res: Response) => {
  res.json(getAnalytics());
});

export default router;
