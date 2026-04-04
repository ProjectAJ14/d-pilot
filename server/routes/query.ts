import { Router, Request, Response } from "express";
import { getConnection } from "../config/connections.js";
import { validateQuery, executeQuery } from "../services/query-executor.js";
import { maskQueryResults } from "../services/phi-masking.js";
import { logAudit, getQueryHistory, getPhiMaskedEnvs } from "../services/sqlite-store.js";
import type { QueryRequest, QueryResult, Environment } from "../types/index.js";

const router = Router();

router.post("/execute", async (req: Request, res: Response) => {
  const user = req.user!;
  const { connectionId, sql } = req.body as QueryRequest;

  if (!connectionId || !sql) {
    res.status(400).json({ error: "connectionId and sql are required" });
    return;
  }

  const conn = getConnection(connectionId);
  if (!conn) {
    res.status(404).json({ error: `Connection '${connectionId}' not found` });
    return;
  }

  // Check environment access
  const allowed = user.allowedEnvironments || [];
  if (!user.isAdmin && !allowed.includes(conn.env)) {
    res.status(403).json({ error: `You do not have access to ${conn.env} environment` });
    return;
  }

  // Validate query (block DML/DDL)
  const validation = validateQuery(sql);
  if (!validation.valid) {
    res.status(400).json({ error: validation.error });
    return;
  }

  try {
    const rawResult = await executeQuery(conn, sql);

    // Server-side PHI enforcement
    const maskedEnvs = getPhiMaskedEnvs();
    const envRequiresMasking = maskedEnvs.includes(conn.env as Environment);
    const clientRequestsUnmask = req.headers["x-phi-shield"] === "off";
    const unmaskReason = req.headers["x-phi-unmask-reason"] as string | undefined;
    const unmaskNotes = req.headers["x-phi-unmask-notes"] as string | undefined;

    let phiEnabled = true; // default: masked
    if (clientRequestsUnmask) {
      if (!user.canUnmaskPhi) {
        // Unauthorized unmask attempt — silently ignore, keep masked, log denial
        logAudit({
          userId: user.sub,
          userEmail: user.email,
          action: "PHI_UNMASK_DENIED",
          connectionId,
          phiAccessed: false,
        });
      } else if (envRequiresMasking && !unmaskReason) {
        // Masked env requires a reason — keep masked
        phiEnabled = true;
      } else {
        // User has permission — unmask
        phiEnabled = false;
      }
    }

    const { maskedRows, maskedColumns, maskedFieldNames } = maskQueryResults(
      rawResult.columns,
      rawResult.rows,
      {
        phiEnabled,
        isAdmin: user.isAdmin,
        database: conn.database,
      }
    );

    const result: QueryResult = {
      columns: maskedColumns,
      rows: maskedRows,
      totalRows: rawResult.totalRows,
      executionTimeMs: rawResult.executionTimeMs,
      masked: maskedFieldNames.length > 0,
      maskedFields: maskedFieldNames,
      connectionId,
      truncated: rawResult.truncated,
    };

    // Audit log
    logAudit({
      userId: user.sub,
      userEmail: user.email,
      action: "QUERY_EXECUTE",
      sql,
      connectionId,
      rowsReturned: rawResult.totalRows,
      executionMs: rawResult.executionTimeMs,
      phiAccessed: !phiEnabled && maskedFieldNames.length > 0,
      phiFieldsUnmasked: !phiEnabled ? maskedFieldNames : [],
      phiUnmaskReason: !phiEnabled ? unmaskReason : undefined,
      phiUnmaskNotes: !phiEnabled ? unmaskNotes : undefined,
    });

    res.json(result);
  } catch (err: any) {
    logAudit({
      userId: user.sub,
      userEmail: user.email,
      action: "QUERY_ERROR",
      sql,
      connectionId,
      phiAccessed: false,
    });

    res.status(500).json({
      error: err.message || "Query execution failed",
      code: err.code,
    });
  }
});

router.get("/history", (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const history = getQueryHistory(req.user!.sub, limit);
  res.json(history);
});

export default router;
