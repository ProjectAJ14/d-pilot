import { Router, Request, Response } from "express";
import { getConnection } from "../config/connections.js";
import { getTables, getColumns } from "../services/schema-introspector.js";

const router = Router();

router.get("/:connectionId/tables", async (req: Request, res: Response) => {
  const conn = getConnection(req.params.connectionId as string);
  if (!conn) {
    res.status(404).json({ error: "Connection not found" });
    return;
  }

  try {
    const tables = await getTables(conn);
    res.json(tables);
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to fetch tables" });
  }
});

router.get("/:connectionId/tables/:tableName/columns", async (req: Request, res: Response) => {
  const conn = getConnection(req.params.connectionId as string);
  if (!conn) {
    res.status(404).json({ error: "Connection not found" });
    return;
  }

  try {
    const columns = await getColumns(conn, req.params.tableName as string);
    res.json(columns);
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to fetch columns" });
  }
});

export default router;
