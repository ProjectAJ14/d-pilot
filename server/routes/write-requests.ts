import { Router, Request, Response, NextFunction } from "express";
import { getConnection } from "../config/connections.js";
import {
  executeQuery,
  validateQuery,
  isReadQuery,
  validateSqlSyntax,
} from "../services/query-executor.js";
import {
  executeWrite,
  validateWriteQuery,
} from "../services/write-executor.js";
import { maskQueryResults } from "../services/phi-masking.js";
import {
  getCachedFullSchema,
  summarizeTables,
} from "../services/schema-introspector.js";
import { extractReferencedTables } from "../services/query-examples.js";
import {
  getAzureConfig,
  azureChat,
  AzureOpenAIError,
} from "../services/azure-openai.js";
import { requireAdmin } from "../middleware/auth.js";
import {
  createWriteRequest,
  getWriteRequest,
  listWriteRequests,
  updateWriteRequest,
  reviseWriteRequest,
  claimWriteRequestForApproval,
  addWriteRequestEvent,
  getWriteModeEnabled,
  getWriteDirectEnvs,
  getPhiMaskedEnvs,
  setSetting,
  logAudit,
} from "../services/sqlite-store.js";
import type {
  AuthUser,
  Environment,
  QueryResult,
  WriteAiReview,
  WriteRequest,
} from "../types/index.js";

const router = Router();

const ALL_ENVS: Environment[] = ["DEV", "QA", "UAT", "STG", "PROD"];
const MAX_PROMPT_TABLES = 30;

// ── Access helpers ──
function canAuthorEnv(user: AuthUser, env: string): boolean {
  return user.isAdmin || user.writeEnvironments.includes(env);
}
// Reading actual target-env rows (e.g. the verification preview) requires the
// read allowlist — approve rights alone do NOT confer blanket read access.
function canReadEnv(user: AuthUser, env: string): boolean {
  return user.isAdmin || user.allowedEnvironments.includes(env);
}
function canApproveEnv(user: AuthUser, env: string): boolean {
  return user.isAdmin || user.approveEnvironments.includes(env);
}
function canViewRequest(user: AuthUser, wr: WriteRequest): boolean {
  return (
    user.isAdmin || wr.requestedBy === user.sub || canApproveEnv(user, wr.env)
  );
}

/** Blocks mutating write-workflow actions when the feature is globally disabled. */
function requireWriteMode(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!getWriteModeEnabled()) {
    res
      .status(403)
      .json({ error: "Write mode is currently disabled by an administrator." });
    return;
  }
  next();
}

// Statuses a requester may edit and resubmit from.
const REVISABLE_STATUSES = ["REJECTED", "CANCELLED", "FAILED"];

/**
 * Validates the verify-SELECT + WRITE pair for a request. The verify SELECT is
 * REQUIRED, must be a read-only SELECT, and both statements are syntax-checked
 * against the database (best-effort — skipped if the DB is unreachable).
 * Returns an error message, or null when the pair is acceptable.
 */
async function validateRequestQueries(
  conn: NonNullable<ReturnType<typeof getConnection>>,
  selectSql: string | undefined,
  writeSql: string,
): Promise<string | null> {
  // The write must be a single, permitted DML statement.
  const writeValidation = validateWriteQuery(writeSql, conn.type);
  if (!writeValidation.valid)
    return writeValidation.error || "Invalid write statement";

  // A verify SELECT is required and must be a read-only SELECT.
  const select = selectSql?.trim();
  if (!select) {
    return "A verify SELECT is required — it previews the rows the write will affect.";
  }
  const readOnly = validateQuery(select);
  if (!readOnly.valid) {
    return `Verify SELECT must be read-only: ${readOnly.error}`;
  }
  if (!isReadQuery(select, conn.type)) {
    return "Verify SELECT must be a SELECT query that reads the affected rows.";
  }

  // Best-effort database syntax validation (never blocks on connectivity).
  const selSyntax = await validateSqlSyntax(conn, select);
  if (selSyntax.error)
    return `Verify SELECT is not valid SQL: ${selSyntax.error}`;
  const wrSyntax = await validateSqlSyntax(conn, writeSql.trim());
  if (wrSyntax.error)
    return `Write statement is not valid SQL: ${wrSyntax.error}`;

  return null;
}

/**
 * Executes a request immediately on a DIRECT-policy environment (an authorized
 * author self-serves), transitioning it to EXECUTED or FAILED and recording the
 * events + audit. Used by both create and revise.
 */
async function runDirectExecution(
  id: string,
  conn: NonNullable<ReturnType<typeof getConnection>>,
  writeSql: string,
  user: AuthUser,
): Promise<void> {
  const now = new Date().toISOString();
  addWriteRequestEvent(
    id,
    user.sub,
    user.email,
    "AUTO_APPROVED",
    `Direct write (${conn.env})`,
  );
  try {
    const result = await executeWrite(conn, writeSql);
    updateWriteRequest(id, {
      status: "EXECUTED",
      executedAt: now,
      executedBy: user.sub,
      executedByEmail: user.email,
      rowsAffected: result.rowsAffected,
      executionMs: result.executionMs,
      transactional: result.transactional,
    });
    addWriteRequestEvent(
      id,
      user.sub,
      user.email,
      "EXECUTED",
      `${result.rowsAffected} row(s) affected`,
    );
    logAudit({
      userId: user.sub,
      userEmail: user.email,
      action: "WRITE_EXECUTE",
      sql: writeSql,
      connectionId: conn.id,
      rowsReturned: result.rowsAffected,
      executionMs: result.executionMs,
      phiAccessed: false,
    });
  } catch (err: any) {
    updateWriteRequest(id, {
      status: "FAILED",
      executionError: err?.message || "Write failed",
    });
    addWriteRequestEvent(id, user.sub, user.email, "FAILED", err?.message);
    logAudit({
      userId: user.sub,
      userEmail: user.email,
      action: "WRITE_EXECUTE_ERROR",
      sql: writeSql,
      connectionId: conn.id,
      phiAccessed: false,
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// Policy settings (must be declared before "/:id" routes)
// ═══════════════════════════════════════════════════════════════

router.get("/policy", (_req: Request, res: Response) => {
  res.json({
    writeModeEnabled: getWriteModeEnabled(),
    directEnvs: getWriteDirectEnvs(),
  });
});

router.put("/policy", requireAdmin, (req: Request, res: Response) => {
  const { writeModeEnabled, directEnvs } = req.body as {
    writeModeEnabled?: boolean;
    directEnvs?: string[];
  };
  if (typeof writeModeEnabled === "boolean") {
    setSetting("write_mode_enabled", writeModeEnabled ? "true" : "false");
  }
  if (Array.isArray(directEnvs)) {
    if (!directEnvs.every((e) => ALL_ENVS.includes(e as Environment))) {
      res.status(400).json({ error: "Invalid environment in directEnvs" });
      return;
    }
    setSetting("write_direct_envs", JSON.stringify(directEnvs));
  }
  res.json({
    writeModeEnabled: getWriteModeEnabled(),
    directEnvs: getWriteDirectEnvs(),
  });
});

// ═══════════════════════════════════════════════════════════════
// Create + list
// ═══════════════════════════════════════════════════════════════

router.post("/", requireWriteMode, async (req: Request, res: Response) => {
  const user = req.user!;
  const { title, description, connectionId, selectSql, writeSql } =
    req.body as {
      title?: string;
      description?: string;
      connectionId?: string;
      selectSql?: string;
      writeSql?: string;
    };

  if (!title?.trim() || !connectionId || !writeSql?.trim()) {
    res
      .status(400)
      .json({ error: "title, connectionId and writeSql are required" });
    return;
  }

  const conn = getConnection(connectionId);
  if (!conn) {
    res.status(404).json({ error: `Connection '${connectionId}' not found` });
    return;
  }

  if (!canAuthorEnv(user, conn.env)) {
    res
      .status(403)
      .json({ error: `You are not allowed to author writes in ${conn.env}` });
    return;
  }

  const queryError = await validateRequestQueries(conn, selectSql, writeSql);
  if (queryError) {
    res.status(400).json({ error: queryError });
    return;
  }

  const direct = getWriteDirectEnvs().includes(conn.env as Environment);

  const wr = createWriteRequest({
    title: title.trim(),
    description: description?.trim() || undefined,
    connectionId,
    connectionName: conn.name,
    env: conn.env,
    dbType: conn.type,
    selectSql: selectSql?.trim() || undefined,
    writeSql: writeSql.trim(),
    status: "PENDING",
    requestedBy: user.sub,
    requestedByEmail: user.email,
  });

  addWriteRequestEvent(wr.id, user.sub, user.email, "SUBMITTED");
  logAudit({
    userId: user.sub,
    userEmail: user.email,
    action: "WRITE_SUBMIT",
    sql: writeSql.trim(),
    connectionId,
    phiAccessed: false,
  });

  // DIRECT-policy environments: an authorized author executes immediately.
  if (direct) {
    await runDirectExecution(wr.id, conn, writeSql.trim(), user);
  }

  res.status(201).json(getWriteRequest(wr.id));
});

router.get("/", (req: Request, res: Response) => {
  const user = req.user!;
  const envs = user.isAdmin ? ALL_ENVS : user.approveEnvironments;
  const requests = listWriteRequests({
    requestedBy: user.sub,
    envs,
    limit: 1000,
  });
  res.json(
    requests.map((wr) => ({
      ...wr,
      viewerCanApprove:
        canApproveEnv(user, wr.env) && wr.requestedBy !== user.sub,
      viewerIsRequester: wr.requestedBy === user.sub,
    })),
  );
});

// ═══════════════════════════════════════════════════════════════
// Stateless AI helpers for the composer (used before a request exists)
// ═══════════════════════════════════════════════════════════════

// AI safety review of an ad-hoc SELECT + WRITE pair (not yet persisted).
router.post("/ai-review", async (req: Request, res: Response) => {
  const user = req.user!;
  const { connectionId, selectSql, writeSql } = req.body as {
    connectionId?: string;
    selectSql?: string;
    writeSql?: string;
  };
  if (!connectionId || !writeSql?.trim()) {
    res.status(400).json({ error: "connectionId and writeSql are required" });
    return;
  }
  const conn = getConnection(connectionId);
  if (!conn) {
    res.status(404).json({ error: "Connection not found" });
    return;
  }
  if (!canAuthorEnv(user, conn.env) && !canApproveEnv(user, conn.env)) {
    res
      .status(403)
      .json({ error: `You do not have write access to ${conn.env}` });
    return;
  }
  const { config, missing } = getAzureConfig();
  if (!config) {
    res.status(503).json({
      error: `Azure OpenAI is not configured. Missing: ${missing.join(", ")}`,
    });
    return;
  }
  try {
    const review = await computeWriteAiReview(
      config,
      conn,
      selectSql || "",
      writeSql,
    );
    res.json(review);
  } catch (err: any) {
    const status = err instanceof AzureOpenAIError && err.status ? 502 : 500;
    res.status(status).json({ error: err?.message || "AI review failed" });
  }
});

// Suggest a candidate WRITE statement from the verification SELECT + intent.
router.post("/suggest-write", async (req: Request, res: Response) => {
  const user = req.user!;
  const { connectionId, selectSql, intent, currentWrite } = req.body as {
    connectionId?: string;
    selectSql?: string;
    intent?: string;
    currentWrite?: string;
  };
  if (!connectionId || !selectSql?.trim()) {
    res.status(400).json({ error: "connectionId and selectSql are required" });
    return;
  }
  const conn = getConnection(connectionId);
  if (!conn) {
    res.status(404).json({ error: "Connection not found" });
    return;
  }
  if (!canAuthorEnv(user, conn.env)) {
    res
      .status(403)
      .json({ error: `You are not allowed to author writes in ${conn.env}` });
    return;
  }
  const { config, missing } = getAzureConfig();
  if (!config) {
    res.status(503).json({
      error: `Azure OpenAI is not configured. Missing: ${missing.join(", ")}`,
    });
    return;
  }
  try {
    const out = await computeWriteSuggestion(
      config,
      conn,
      selectSql,
      intent,
      currentWrite,
    );
    res.json(out);
  } catch (err: any) {
    const status = err instanceof AzureOpenAIError && err.status ? 502 : 500;
    res.status(status).json({ error: err?.message || "Suggestion failed" });
  }
});

// Suggest a verify SELECT from the WRITE statement (write-first flow).
router.post("/suggest-select", async (req: Request, res: Response) => {
  const user = req.user!;
  const { connectionId, writeSql, intent, currentSelect } = req.body as {
    connectionId?: string;
    writeSql?: string;
    intent?: string;
    currentSelect?: string;
  };
  if (!connectionId || !writeSql?.trim()) {
    res.status(400).json({ error: "connectionId and writeSql are required" });
    return;
  }
  const conn = getConnection(connectionId);
  if (!conn) {
    res.status(404).json({ error: "Connection not found" });
    return;
  }
  if (!canAuthorEnv(user, conn.env)) {
    res
      .status(403)
      .json({ error: `You are not allowed to author writes in ${conn.env}` });
    return;
  }
  const { config, missing } = getAzureConfig();
  if (!config) {
    res.status(503).json({
      error: `Azure OpenAI is not configured. Missing: ${missing.join(", ")}`,
    });
    return;
  }
  try {
    const out = await computeSelectSuggestion(
      config,
      conn,
      writeSql,
      intent,
      currentSelect,
    );
    res.json(out);
  } catch (err: any) {
    const status = err instanceof AzureOpenAIError && err.status ? 502 : 500;
    res.status(status).json({ error: err?.message || "Suggestion failed" });
  }
});

// ═══════════════════════════════════════════════════════════════
// Single request
// ═══════════════════════════════════════════════════════════════

router.get("/:id", (req: Request, res: Response) => {
  const user = req.user!;
  const wr = getWriteRequest(req.params.id as string);
  if (!wr) {
    res.status(404).json({ error: "Write request not found" });
    return;
  }
  if (!canViewRequest(user, wr)) {
    res
      .status(403)
      .json({ error: "You do not have access to this write request" });
    return;
  }
  res.json({
    ...wr,
    viewerCanApprove:
      canApproveEnv(user, wr.env) && wr.requestedBy !== user.sub,
    viewerIsRequester: wr.requestedBy === user.sub,
    viewerCanPreview: canReadEnv(user, wr.env),
  });
});

// Run the verification SELECT to preview current DB state (masked per PHI rules).
router.post("/:id/preview", async (req: Request, res: Response) => {
  const user = req.user!;
  const wr = getWriteRequest(req.params.id as string, false);
  if (!wr) {
    res.status(404).json({ error: "Write request not found" });
    return;
  }
  if (!canViewRequest(user, wr)) {
    res
      .status(403)
      .json({ error: "You do not have access to this write request" });
    return;
  }
  if (!wr.selectSql) {
    res
      .status(400)
      .json({ error: "This request has no verification SELECT query" });
    return;
  }

  const conn = getConnection(wr.connectionId);
  if (!conn) {
    res.status(404).json({ error: "Connection not found" });
    return;
  }

  // Running the preview materializes real rows from the target environment, so
  // it requires the read allowlist — approve rights alone are not sufficient.
  if (!canReadEnv(user, conn.env)) {
    res
      .status(403)
      .json({ error: `You do not have read access to ${conn.env}` });
    return;
  }

  // The preview path must never mutate — enforce the read-only guard on the
  // verification SELECT (executeQuery does not validate SQL engines by itself).
  const readOnly = validateQuery(wr.selectSql);
  if (!readOnly.valid) {
    res
      .status(400)
      .json({ error: `Preview query must be read-only: ${readOnly.error}` });
    return;
  }

  try {
    const raw = await executeQuery(conn, wr.selectSql, req.body?.defaultLimit);

    const maskedEnvs = getPhiMaskedEnvs();
    const envRequiresMasking = maskedEnvs.includes(conn.env as Environment);
    const clientRequestsUnmask = req.headers["x-phi-shield"] === "off";
    const unmaskReason = req.headers["x-phi-unmask-reason"] as
      | string
      | undefined;

    const canUnmaskHere =
      user.isAdmin || user.unmaskEnvironments.includes(conn.env);
    let phiEnabled = true;
    if (clientRequestsUnmask && canUnmaskHere) {
      if (!(envRequiresMasking && !unmaskReason)) phiEnabled = false;
    }

    const { maskedRows, maskedColumns, maskedFieldNames } = maskQueryResults(
      raw.columns,
      raw.rows,
      {
        phiEnabled,
        isAdmin: user.isAdmin,
        database: conn.database,
      },
    );

    const result: QueryResult = {
      columns: maskedColumns,
      rows: maskedRows,
      totalRows: raw.totalRows,
      executionTimeMs: raw.executionTimeMs,
      masked: maskedFieldNames.length > 0,
      maskedFields: maskedFieldNames,
      connectionId: wr.connectionId,
      truncated: raw.truncated,
    };

    logAudit({
      userId: user.sub,
      userEmail: user.email,
      action: "WRITE_PREVIEW",
      sql: wr.selectSql,
      connectionId: wr.connectionId,
      rowsReturned: raw.totalRows,
      executionMs: raw.executionTimeMs,
      phiAccessed: !phiEnabled && maskedFieldNames.length > 0,
    });

    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Preview query failed" });
  }
});

// AI safety review of the SELECT + WRITE pair.
router.post("/:id/ai-review", async (req: Request, res: Response) => {
  const user = req.user!;
  const wr = getWriteRequest(req.params.id as string, false);
  if (!wr) {
    res.status(404).json({ error: "Write request not found" });
    return;
  }
  if (!canViewRequest(user, wr)) {
    res
      .status(403)
      .json({ error: "You do not have access to this write request" });
    return;
  }

  const conn = getConnection(wr.connectionId);
  if (!conn) {
    res.status(404).json({ error: "Connection not found" });
    return;
  }

  const { config, missing } = getAzureConfig();
  if (!config) {
    res.status(503).json({
      error: `Azure OpenAI is not configured. Missing: ${missing.join(", ")}`,
    });
    return;
  }

  try {
    const review = await computeWriteAiReview(
      config,
      conn,
      wr.selectSql,
      wr.writeSql,
    );
    updateWriteRequest(wr.id, { aiVerdict: review.verdict, aiReview: review });
    addWriteRequestEvent(
      wr.id,
      user.sub,
      user.email,
      "AI_REVIEWED",
      `Verdict: ${review.verdict}`,
    );
    logAudit({
      userId: user.sub,
      userEmail: user.email,
      action: "WRITE_AI_REVIEW",
      sql: wr.writeSql,
      connectionId: wr.connectionId,
      phiAccessed: false,
    });
    res.json(review);
  } catch (err: any) {
    const status = err instanceof AzureOpenAIError && err.status ? 502 : 500;
    res.status(status).json({ error: err?.message || "AI review failed" });
  }
});

// ═══════════════════════════════════════════════════════════════
// Decisions: approve (execute), reject, cancel
// ═══════════════════════════════════════════════════════════════

router.post(
  "/:id/approve",
  requireWriteMode,
  async (req: Request, res: Response) => {
    const user = req.user!;
    const notes = (req.body?.notes as string | undefined)?.trim() || undefined;
    const wr = getWriteRequest(req.params.id as string, false);
    if (!wr) {
      res.status(404).json({ error: "Write request not found" });
      return;
    }
    if (wr.status !== "PENDING") {
      res.status(409).json({
        error: `Request is ${wr.status} and can no longer be approved`,
      });
      return;
    }
    if (!canApproveEnv(user, wr.env)) {
      res
        .status(403)
        .json({ error: `You are not allowed to approve writes in ${wr.env}` });
      return;
    }
    if (wr.requestedBy === user.sub) {
      res
        .status(403)
        .json({ error: "You cannot approve your own write request" });
      return;
    }

    const conn = getConnection(wr.connectionId);
    if (!conn) {
      res.status(404).json({ error: "Connection not found" });
      return;
    }

    // Defensive re-validation at execution time.
    const validation = validateWriteQuery(wr.writeSql, conn.type);
    if (!validation.valid) {
      res
        .status(400)
        .json({ error: `Write is no longer valid: ${validation.error}` });
      return;
    }

    // Atomically claim the request (PENDING -> APPROVED). If another approver
    // already claimed it, this returns false and we refuse — execute-once.
    if (!claimWriteRequestForApproval(wr.id)) {
      res
        .status(409)
        .json({ error: "This request was already actioned by someone else." });
      return;
    }

    const now = new Date().toISOString();
    addWriteRequestEvent(wr.id, user.sub, user.email, "APPROVED", notes);
    logAudit({
      userId: user.sub,
      userEmail: user.email,
      action: "WRITE_APPROVE",
      sql: wr.writeSql,
      connectionId: wr.connectionId,
      phiAccessed: false,
    });

    try {
      const result = await executeWrite(conn, wr.writeSql);
      const updated = updateWriteRequest(wr.id, {
        status: "EXECUTED",
        reviewedBy: user.sub,
        reviewedByEmail: user.email,
        reviewedAt: now,
        reviewNotes: notes,
        executedAt: now,
        executedBy: user.sub,
        executedByEmail: user.email,
        rowsAffected: result.rowsAffected,
        executionMs: result.executionMs,
        transactional: result.transactional,
      });
      addWriteRequestEvent(
        wr.id,
        user.sub,
        user.email,
        "EXECUTED",
        `${result.rowsAffected} row(s) affected`,
      );
      logAudit({
        userId: user.sub,
        userEmail: user.email,
        action: "WRITE_EXECUTE",
        sql: wr.writeSql,
        connectionId: wr.connectionId,
        rowsReturned: result.rowsAffected,
        executionMs: result.executionMs,
        phiAccessed: false,
      });
      res.json(getWriteRequest(updated!.id));
    } catch (err: any) {
      updateWriteRequest(wr.id, {
        status: "FAILED",
        reviewedBy: user.sub,
        reviewedByEmail: user.email,
        reviewedAt: now,
        reviewNotes: notes,
        executionError: err?.message || "Write failed",
      });
      addWriteRequestEvent(wr.id, user.sub, user.email, "FAILED", err?.message);
      logAudit({
        userId: user.sub,
        userEmail: user.email,
        action: "WRITE_EXECUTE_ERROR",
        sql: wr.writeSql,
        connectionId: wr.connectionId,
        phiAccessed: false,
      });
      res.status(500).json({
        error: err?.message || "Write execution failed",
        request: getWriteRequest(wr.id),
      });
    }
  },
);

router.post("/:id/reject", requireWriteMode, (req: Request, res: Response) => {
  const user = req.user!;
  const notes = (req.body?.notes as string | undefined)?.trim() || undefined;
  const wr = getWriteRequest(req.params.id as string, false);
  if (!wr) {
    res.status(404).json({ error: "Write request not found" });
    return;
  }
  if (wr.status !== "PENDING") {
    res
      .status(409)
      .json({ error: `Request is ${wr.status} and can no longer be rejected` });
    return;
  }
  if (!canApproveEnv(user, wr.env)) {
    res
      .status(403)
      .json({ error: `You are not allowed to review writes in ${wr.env}` });
    return;
  }
  if (wr.requestedBy === user.sub) {
    res.status(403).json({ error: "Use cancel to withdraw your own request" });
    return;
  }

  updateWriteRequest(wr.id, {
    status: "REJECTED",
    reviewedBy: user.sub,
    reviewedByEmail: user.email,
    reviewedAt: new Date().toISOString(),
    reviewNotes: notes,
  });
  addWriteRequestEvent(wr.id, user.sub, user.email, "REJECTED", notes);
  logAudit({
    userId: user.sub,
    userEmail: user.email,
    action: "WRITE_REJECT",
    sql: wr.writeSql,
    connectionId: wr.connectionId,
    phiAccessed: false,
  });
  res.json(getWriteRequest(wr.id));
});

router.post("/:id/cancel", (req: Request, res: Response) => {
  const user = req.user!;
  const wr = getWriteRequest(req.params.id as string, false);
  if (!wr) {
    res.status(404).json({ error: "Write request not found" });
    return;
  }
  if (wr.requestedBy !== user.sub && !user.isAdmin) {
    res
      .status(403)
      .json({ error: "Only the requester can cancel this request" });
    return;
  }
  if (wr.status !== "PENDING" && wr.status !== "DRAFT") {
    res.status(409).json({
      error: `Request is ${wr.status} and can no longer be cancelled`,
    });
    return;
  }
  updateWriteRequest(wr.id, { status: "CANCELLED" });
  addWriteRequestEvent(wr.id, user.sub, user.email, "CANCELLED");
  res.json(getWriteRequest(wr.id));
});

// Edit the query on a rejected/cancelled/failed request and resubmit it for a
// fresh review round (keeps the same id/share link; history is preserved).
router.post(
  "/:id/revise",
  requireWriteMode,
  async (req: Request, res: Response) => {
    const user = req.user!;
    const wr = getWriteRequest(req.params.id as string, false);
    if (!wr) {
      res.status(404).json({ error: "Write request not found" });
      return;
    }
    if (wr.requestedBy !== user.sub && !user.isAdmin) {
      res
        .status(403)
        .json({ error: "Only the requester can revise this request" });
      return;
    }
    if (!REVISABLE_STATUSES.includes(wr.status)) {
      res.status(409).json({
        error: `A ${wr.status} request cannot be revised. Only rejected, cancelled or failed requests can be edited and resubmitted.`,
      });
      return;
    }

    const { title, description, selectSql, writeSql, note } = req.body as {
      title?: string;
      description?: string;
      selectSql?: string;
      writeSql?: string;
      note?: string;
    };

    const conn = getConnection(wr.connectionId);
    if (!conn) {
      res.status(404).json({ error: "Connection not found" });
      return;
    }
    if (!canAuthorEnv(user, conn.env)) {
      res
        .status(403)
        .json({ error: `You are not allowed to author writes in ${conn.env}` });
      return;
    }

    const newTitle = (title ?? wr.title).trim();
    const newWrite = (writeSql ?? wr.writeSql).trim();
    const newSelect = (selectSql ?? wr.selectSql)?.trim() || undefined;
    const newDescription =
      description !== undefined
        ? description.trim() || undefined
        : wr.description;

    if (!newTitle || !newWrite) {
      res.status(400).json({ error: "title and writeSql are required" });
      return;
    }

    const queryError = await validateRequestQueries(conn, newSelect, newWrite);
    if (queryError) {
      res.status(400).json({ error: queryError });
      return;
    }

    reviseWriteRequest(wr.id, {
      title: newTitle,
      description: newDescription,
      selectSql: newSelect,
      writeSql: newWrite,
    });
    addWriteRequestEvent(
      wr.id,
      user.sub,
      user.email,
      "RESUBMITTED",
      note?.trim() || undefined,
    );
    logAudit({
      userId: user.sub,
      userEmail: user.email,
      action: "WRITE_RESUBMIT",
      sql: newWrite,
      connectionId: wr.connectionId,
      phiAccessed: false,
    });

    // A DIRECT-policy environment re-runs immediately on resubmit.
    if (getWriteDirectEnvs().includes(conn.env as Environment)) {
      await runDirectExecution(wr.id, conn, newWrite, user);
    }

    res.json(getWriteRequest(wr.id));
  },
);

/** Prompt-ready summary of the tables referenced by the given statements. */
async function buildWriteSchemaText(
  conn: NonNullable<ReturnType<typeof getConnection>>,
  sqls: (string | undefined)[],
): Promise<string> {
  try {
    const full = await getCachedFullSchema(conn);
    const referenced = new Set<string>();
    const known = new Map(
      full.schema.tables.map((t) => [t.name.toLowerCase(), t.name]),
    );
    for (const sql of sqls) {
      if (!sql) continue;
      for (const t of extractReferencedTables(sql, conn.type)) {
        const real = known.get(t.toLowerCase());
        if (real) referenced.add(real);
      }
    }
    const tableList = referenced.size
      ? [...referenced].slice(0, MAX_PROMPT_TABLES)
      : undefined;
    return summarizeTables(full.schema, tableList).text;
  } catch {
    return "(schema unavailable)";
  }
}

/** Runs the AI safety review over a SELECT + WRITE pair. Throws on Azure error. */
async function computeWriteAiReview(
  config: Parameters<typeof azureChat>[0],
  conn: NonNullable<ReturnType<typeof getConnection>>,
  selectSql: string,
  writeSql: string,
): Promise<WriteAiReview> {
  const schemaText = await buildWriteSchemaText(conn, [selectSql, writeSql]);
  const systemPrompt = [
    "You are a database change-safety reviewer embedded in an approval workflow.",
    "The WRITE statement expresses the user's intent and is authoritative. The verify SELECT should preview EXACTLY the rows the WRITE affects (same table, same WHERE/filter) so a reviewer can eyeball them before approving.",
    "Assess correctness and risk. Key checks:",
    "- Does the verify SELECT return exactly the rows the WRITE will change (same table, same filter, no more, no fewer)?",
    "- Missing/absent WHERE on UPDATE/DELETE means it affects the WHOLE table — that is UNBOUNDED and DANGEROUS.",
    "- Wrong table/column, type mismatches, touching [PHI] columns, and whether the change is irreversible on this engine.",
    `Database type: ${conn.type}. Elasticsearch and multi-document MongoDB writes cannot be rolled back.`,
    "",
    "ALSO produce corrected statements the user can apply with one click:",
    "- suggestedWriteSql: a corrected WRITE only if the current WRITE is unsafe or wrong (e.g. add a missing WHERE, fix a wrong column/type). If the WRITE is already correct and safe, set it to null.",
    "- suggestedSelectSql: a CONCISE read-only SELECT that previews EXACTLY the rows the effective WRITE (suggestedWriteSql if present, otherwise the current WRITE) affects — same table and WHERE. Choose columns by verb: DELETE → `SELECT *`; UPDATE → primary key plus only the column(s) being set; INSERT → rows that would conflict on a key. NEVER enumerate every column — prefer `SELECT *` over a long column list. Set to null only if the current verify SELECT is already correct and concise.",
    "CRITICAL: the two suggestions MUST be mutually consistent — if the user applies them, a fresh review of that pair MUST yield verdict SAFE and selectMatchesWrite=true. Never suggest an unsafe statement (e.g. never a WHERE-less UPDATE/DELETE).",
    'Respond ONLY with JSON of the form: {"verdict":"SAFE|CAUTION|DANGEROUS","selectMatchesWrite":true|false,"estimatedBlastRadius":"single row|bounded|UNBOUNDED","risks":["..."],"summary":"...","recommendation":"approve|review carefully|reject","suggestedWriteSql":"..."|null,"suggestedSelectSql":"..."|null}.',
    "Do not wrap the JSON in markdown fences.",
  ].join("\n");
  const userMessage = [
    `Database type: ${conn.type}`,
    conn.database ? `Database: ${conn.database}` : "",
    "",
    "Schema (relevant tables):",
    schemaText || "(no schema)",
    "",
    "WRITE statement (the user's intent, authoritative):",
    writeSql,
    "",
    "Verify SELECT provided (may be empty, wrong, or mismatched):",
    selectSql || "(none provided)",
  ]
    .filter(Boolean)
    .join("\n");

  const result = await azureChat(
    config,
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    { maxTokens: 1400, jsonMode: true, timeoutMs: 60000 },
  );
  const parsed = parseAiReview(result.content);
  return {
    ...parsed,
    model: result.model || config.model,
    reviewedAt: new Date().toISOString(),
  };
}

/** Per-dialect hint for generating a single write statement from a SELECT. */
function writeDialectHint(type: string): string {
  switch (type) {
    case "mongodb":
      return "Target MongoDB: produce db.<collection>.updateMany(filter, update) or db.<collection>.deleteMany(filter) using the same filter as the find(). Use valid JSON.";
    case "elasticsearch":
      return "Target Elasticsearch: produce POST /<index>/_update_by_query or POST /<index>/_delete_by_query with the same query as the SELECT.";
    default:
      return "Target SQL: produce a single INSERT/UPDATE/DELETE. The WHERE clause MUST match the SELECT so the same rows (and no more) are affected.";
  }
}

/** Suggests a candidate WRITE statement derived from the verification SELECT. */
async function computeWriteSuggestion(
  config: Parameters<typeof azureChat>[0],
  conn: NonNullable<ReturnType<typeof getConnection>>,
  selectSql: string,
  intent?: string,
  currentWrite?: string,
): Promise<{ query: string; explanation: string }> {
  const schemaText = await buildWriteSchemaText(conn, [
    selectSql,
    currentWrite,
  ]);
  const systemPrompt = [
    "You convert a verification SELECT into ONE clean, minimal write (DML) statement that affects exactly the rows the SELECT returns.",
    writeDialectHint(conn.type),
    "Rules:",
    "- Exactly ONE statement. Only INSERT, UPDATE or DELETE. NEVER DDL (no DROP/ALTER/CREATE/TRUNCATE) and no stacked statements.",
    "- The WHERE/filter MUST mirror the SELECT so it never affects more rows than the SELECT returns.",
    "- If the user's intent describes an update, produce an UPDATE that SETs only the columns the intent mentions. Otherwise produce the DELETE that removes exactly those rows.",
    "- Keep it concise and readable — reference only the columns that are actually needed; do not restate unchanged columns.",
    '- Respond ONLY with JSON {"query":"<the statement>","explanation":"<one short sentence>"}. No markdown fences.',
  ].join("\n");
  const userMessage = [
    `Database type: ${conn.type}`,
    conn.database ? `Database: ${conn.database}` : "",
    "",
    "Schema (relevant tables):",
    schemaText || "(no schema)",
    "",
    "Verification SELECT (identifies the target rows):",
    selectSql,
    intent?.trim() ? `\nUser intent: ${intent.trim()}` : "",
    currentWrite?.trim()
      ? `\nCurrent draft write (refine if relevant): ${currentWrite.trim()}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const result = await azureChat(
    config,
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    { maxTokens: 1200, jsonMode: true, timeoutMs: 60000 },
  );
  const cleaned = result.content
    .trim()
    .replace(/^```(?:json|sql)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    const o = JSON.parse(cleaned);
    return {
      query: typeof o.query === "string" ? o.query.trim() : "",
      explanation:
        typeof o.explanation === "string" ? o.explanation.trim() : "",
    };
  } catch {
    const fence = result.content.match(/```(?:sql|json)?\s*([\s\S]*?)```/i);
    return { query: fence ? fence[1].trim() : cleaned, explanation: "" };
  }
}

/** Per-dialect hint for generating a verify SELECT from a WRITE statement. */
function selectDialectHint(type: string): string {
  switch (type) {
    case "mongodb":
      return "Target MongoDB: produce db.<collection>.find(filter) using the SAME collection and filter as the update/delete. For deletes, no projection (show the whole document). For updates, project the _id plus the fields being set.";
    case "elasticsearch":
      return "Target Elasticsearch: produce GET /<index>/_search with the SAME query as the _update_by_query / _delete_by_query. For updates, use _source to limit to the changed fields.";
    default:
      return "Target SQL: a single read-only SELECT with the SAME FROM table and WHERE as the WRITE.";
  }
}

/** Suggests a verify SELECT derived from the WRITE statement (write-first flow). */
async function computeSelectSuggestion(
  config: Parameters<typeof azureChat>[0],
  conn: NonNullable<ReturnType<typeof getConnection>>,
  writeSql: string,
  intent?: string,
  currentSelect?: string,
): Promise<{ query: string; explanation: string }> {
  const schemaText = await buildWriteSchemaText(conn, [
    writeSql,
    currentSelect,
  ]);
  const systemPrompt = [
    "You convert a WRITE (DML) statement into ONE concise read-only SELECT that previews EXACTLY the rows the WRITE will affect, so a reviewer can verify them before approving.",
    selectDialectHint(conn.type),
    "Rules:",
    "- Read-only ONLY. Never INSERT/UPDATE/DELETE or any DDL. A single statement, no stacked statements.",
    "- Use the SAME target table and the SAME WHERE/filter as the WRITE — return exactly the affected rows, no more and no fewer.",
    "- Keep it minimal and readable. Choose the column list by the write's verb:",
    "  • DELETE → use `SELECT *` (the reviewer wants to see the whole rows being removed).",
    "  • UPDATE → select only the primary key (or the WHERE key) plus the column(s) the UPDATE sets, so the reviewer sees the before-values.",
    "  • INSERT → select the rows that would conflict on a unique/primary key, or `SELECT 1 WHERE false` if nothing to preview.",
    "- NEVER enumerate every column of the table. If in doubt, prefer `SELECT *` over a long column list.",
    "- Output one clean line (or lightly wrapped); do not over-format.",
    '- Respond ONLY with JSON {"query":"<the SELECT>","explanation":"<one short sentence>"}. No markdown fences.',
  ].join("\n");
  const userMessage = [
    `Database type: ${conn.type}`,
    conn.database ? `Database: ${conn.database}` : "",
    "",
    "Schema (relevant tables):",
    schemaText || "(no schema)",
    "",
    "WRITE statement (derive the preview from this):",
    writeSql,
    intent?.trim() ? `\nUser intent: ${intent.trim()}` : "",
    currentSelect?.trim()
      ? `\nCurrent verify SELECT (refine if relevant): ${currentSelect.trim()}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const result = await azureChat(
    config,
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    { maxTokens: 1200, jsonMode: true, timeoutMs: 60000 },
  );
  const cleaned = result.content
    .trim()
    .replace(/^```(?:json|sql)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    const o = JSON.parse(cleaned);
    return {
      query: typeof o.query === "string" ? o.query.trim() : "",
      explanation:
        typeof o.explanation === "string" ? o.explanation.trim() : "",
    };
  } catch {
    const fence = result.content.match(/```(?:sql|json)?\s*([\s\S]*?)```/i);
    return { query: fence ? fence[1].trim() : cleaned, explanation: "" };
  }
}

/** Robustly parses the AI review JSON, defaulting to a cautious verdict. */
function parseAiReview(
  content: string,
): Omit<WriteAiReview, "model" | "reviewedAt"> {
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const cleanSql = (v: unknown): string | undefined => {
    if (typeof v !== "string") return undefined;
    const s = v.trim();
    return s && s.toLowerCase() !== "null" ? s : undefined;
  };
  try {
    const o = JSON.parse(cleaned);
    const verdict = ["SAFE", "CAUTION", "DANGEROUS"].includes(o.verdict)
      ? o.verdict
      : "CAUTION";
    return {
      verdict,
      selectMatchesWrite: !!o.selectMatchesWrite,
      estimatedBlastRadius:
        typeof o.estimatedBlastRadius === "string"
          ? o.estimatedBlastRadius
          : "unknown",
      risks: Array.isArray(o.risks) ? o.risks.map(String) : [],
      summary: typeof o.summary === "string" ? o.summary : "",
      recommendation:
        typeof o.recommendation === "string"
          ? o.recommendation
          : "review carefully",
      suggestedWriteSql: cleanSql(o.suggestedWriteSql),
      suggestedSelectSql: cleanSql(o.suggestedSelectSql),
    };
  } catch {
    return {
      verdict: "CAUTION",
      selectMatchesWrite: false,
      estimatedBlastRadius: "unknown",
      risks: ["Could not parse AI response"],
      summary: content.slice(0, 400),
      recommendation: "review carefully",
    };
  }
}

export default router;
