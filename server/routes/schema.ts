import { Router, Request, Response } from "express";
import { resolveReadableConnection } from "../middleware/auth.js";
import {
  getTables,
  getColumns,
  getSchemas,
  getCachedFullSchema,
} from "../services/schema-introspector.js";
import { isConnectionError } from "../services/connection-errors.js";

const router = Router();

// Connectivity failures (DNS, refused/timed-out connects) get a 503 with a
// stable code so the client can show a targeted "check your network" message.
function sendSchemaError(res: Response, err: any, fallback: string): void {
  if (isConnectionError(err)) {
    res.status(503).json({
      error: "Unable to connect to the database. Check your network connection.",
      code: "CONNECTION_FAILED",
    });
    return;
  }
  res.status(500).json({ error: err.message || fallback });
}

// Full schema (all tables + their columns) in one cached, de-duplicated call.
// Used by the editor's autocomplete instead of N per-table column requests.
router.get("/:connectionId/full", async (req: Request, res: Response) => {
  const conn = resolveReadableConnection(
    req,
    res,
    req.params.connectionId as string,
  );
  if (!conn) return;

  try {
    const schema = (req.query.schema as string) || undefined;
    const full = await getCachedFullSchema(conn, { schema });
    res.json(full.schema);
  } catch (err: any) {
    sendSchemaError(res, err, "Failed to fetch schema");
  }
});

// Available schemas for a connection (Postgres/MSSQL). Empty for Mongo/ES.
router.get("/:connectionId/schemas", async (req: Request, res: Response) => {
  const conn = resolveReadableConnection(
    req,
    res,
    req.params.connectionId as string,
  );
  if (!conn) return;

  try {
    const result = await getSchemas(conn);
    res.json(result);
  } catch (err: any) {
    sendSchemaError(res, err, "Failed to fetch schemas");
  }
});

router.get("/:connectionId/tables", async (req: Request, res: Response) => {
  const conn = resolveReadableConnection(
    req,
    res,
    req.params.connectionId as string,
  );
  if (!conn) return;

  try {
    const schema = (req.query.schema as string) || undefined;
    const tables = await getTables(conn, schema);
    res.json(tables);
  } catch (err: any) {
    sendSchemaError(res, err, "Failed to fetch tables");
  }
});

router.get("/:connectionId/tables/:tableName/columns", async (req: Request, res: Response) => {
  const conn = resolveReadableConnection(
    req,
    res,
    req.params.connectionId as string,
  );
  if (!conn) return;

  try {
    const schema = (req.query.schema as string) || undefined;
    const columns = await getColumns(conn, req.params.tableName as string, schema);
    res.json(columns);
  } catch (err: any) {
    sendSchemaError(res, err, "Failed to fetch columns");
  }
});

export default router;
