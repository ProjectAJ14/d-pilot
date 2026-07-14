import { Router, Request, Response } from "express";
import {
  getSavedQueries,
  getSavedQueryById,
  createSavedQuery,
  updateSavedQuery,
  deleteSavedQuery,
} from "../services/sqlite-store.js";

const router = Router();

router.get("/", (req: Request, res: Response) => {
  const queries = getSavedQueries(req.user!.sub);
  res.json(queries);
});

// Share-link target: a query is visible if it is shared or owned by the requester.
router.get("/:id", (req: Request, res: Response) => {
  const query = getSavedQueryById(req.params.id as string, req.user!.sub);
  if (!query) {
    res.status(404).json({ error: "Query not found or not shared with you" });
    return;
  }
  res.json(query);
});

router.post("/", (req: Request, res: Response) => {
  const user = req.user!;
  const { name, sql, description, connectionId, isShared, tags } = req.body;

  if (!name || !sql) {
    res.status(400).json({ error: "name and sql are required" });
    return;
  }

  const saved = createSavedQuery({
    name,
    sql,
    description,
    connectionId,
    createdBy: user.sub,
    createdByEmail: user.email,
    isShared: isShared ?? true,
    tags: tags ?? [],
  });

  res.status(201).json(saved);
});

router.put("/:id", (req: Request, res: Response) => {
  const updated = updateSavedQuery(req.params.id as string, req.user!.sub, req.body);
  if (!updated) {
    res.status(404).json({ error: "Query not found or not owned by you" });
    return;
  }
  res.json(updated);
});

router.delete("/:id", (req: Request, res: Response) => {
  const deleted = deleteSavedQuery(req.params.id as string, req.user!.sub);
  if (!deleted) {
    res.status(404).json({ error: "Query not found or not owned by you" });
    return;
  }
  res.json({ deleted: true });
});

export default router;
