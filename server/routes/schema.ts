import { Router, Request, Response } from "express";
import { getConnection } from "../config/connections.js";
import {
  getTables,
  getColumns,
  getSchemas,
  getCachedFullSchema,
} from "../services/schema-introspector.js";

const router = Router();

// Full schema (all tables + their columns) in one cached, de-duplicated call.
// Used by the editor's autocomplete instead of N per-table column requests.
router.get("/:connectionId/full", async (req: Request, res: Response) => {
  const conn = getConnection(req.params.connectionId as string);
  if (!conn) {
    res.status(404).json({ error: "Connection not found" });
    return;
  }

  try {
    const schema = (req.query.schema as string) || undefined;
    const full = await getCachedFullSchema(conn, { schema });
    res.json(full.schema);
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to fetch schema" });
  }
});

// Available schemas for a connection (Postgres/MSSQL). Empty for Mongo/ES.
router.get("/:connectionId/schemas", async (req: Request, res: Response) => {
  const conn = getConnection(req.params.connectionId as string);
  if (!conn) {
    res.status(404).json({ error: "Connection not found" });
    return;
  }

  try {
    const result = await getSchemas(conn);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to fetch schemas" });
  }
});

router.get("/:connectionId/tables", async (req: Request, res: Response) => {
  const conn = getConnection(req.params.connectionId as string);
  if (!conn) {
    res.status(404).json({ error: "Connection not found" });
    return;
  }

  try {
    const schema = (req.query.schema as string) || undefined;
    const tables = await getTables(conn, schema);
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
    const schema = (req.query.schema as string) || undefined;
    const columns = await getColumns(conn, req.params.tableName as string, schema);
    res.json(columns);
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to fetch columns" });
  }
});

export default router;
