import { Router, Request, Response } from "express";
import { getConnection } from "../config/connections.js";
import { validateQuery, executeQuery } from "../services/query-executor.js";
import { maskQueryResults } from "../services/phi-masking.js";
import { logAudit } from "../services/sqlite-store.js";

const router = Router();

router.post("/csv", async (req: Request, res: Response) => {
  const user = req.user!;
  const { connectionId, sql } = req.body;

  if (!connectionId || !sql) {
    res.status(400).json({ error: "connectionId and sql are required" });
    return;
  }

  const conn = getConnection(connectionId);
  if (!conn) {
    res.status(404).json({ error: "Connection not found" });
    return;
  }

  const validation = validateQuery(sql);
  if (!validation.valid) {
    res.status(400).json({ error: validation.error });
    return;
  }

  try {
    const rawResult = await executeQuery(conn, sql);
    const phiEnabled = req.headers["x-phi-shield"] !== "off";
    const { maskedRows, maskedColumns } = maskQueryResults(
      rawResult.columns,
      rawResult.rows,
      { phiEnabled, isAdmin: user.isAdmin, database: conn.database }
    );

    // Build CSV
    const headers = maskedColumns.map((c) => c.name);
    const csvLines = [headers.join(",")];

    for (const row of maskedRows) {
      const values = headers.map((h) => {
        const val = row[h];
        if (val === null || val === undefined) return "";
        const str = String(val);
        return str.includes(",") || str.includes('"') || str.includes("\n")
          ? `"${str.replace(/"/g, '""')}"`
          : str;
      });
      csvLines.push(values.join(","));
    }

    logAudit({
      userId: user.sub,
      userEmail: user.email,
      action: "EXPORT_CSV",
      sql,
      connectionId,
      rowsReturned: maskedRows.length,
      phiAccessed: !phiEnabled,
    });

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=query-export.csv");
    res.send(csvLines.join("\n"));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/json", async (req: Request, res: Response) => {
  const user = req.user!;
  const { connectionId, sql } = req.body;

  if (!connectionId || !sql) {
    res.status(400).json({ error: "connectionId and sql are required" });
    return;
  }

  const conn = getConnection(connectionId);
  if (!conn) {
    res.status(404).json({ error: "Connection not found" });
    return;
  }

  const validation = validateQuery(sql);
  if (!validation.valid) {
    res.status(400).json({ error: validation.error });
    return;
  }

  try {
    const rawResult = await executeQuery(conn, sql);
    const phiEnabled = req.headers["x-phi-shield"] !== "off";
    const { maskedRows } = maskQueryResults(
      rawResult.columns,
      rawResult.rows,
      { phiEnabled, isAdmin: user.isAdmin, database: conn.database }
    );

    logAudit({
      userId: user.sub,
      userEmail: user.email,
      action: "EXPORT_JSON",
      sql,
      connectionId,
      rowsReturned: maskedRows.length,
      phiAccessed: !phiEnabled,
    });

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", "attachment; filename=query-export.json");
    res.json(maskedRows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
