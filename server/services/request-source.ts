/**
 * Which client an API request came from — the D-Pilot UI or an AI agent on the
 * MCP endpoint — so the audit log can tell the two apart.
 *
 * The MCP tools reach the API over loopback (`mcp-client.ts`), which sends
 * `X-DPilot-Source: mcp`; everything else is the UI. The value is held in
 * AsyncLocalStorage for the life of the request, so `logAudit` can read it
 * without every one of its callers threading it through.
 *
 * Self-reported and informational: a caller can mislabel its own requests, and
 * the entry still records who made them. Never gate access on it.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response } from "express";
import type { RequestSource } from "../types/index.js";

export const SOURCE_HEADER = "X-DPilot-Source";

const store = new AsyncLocalStorage<RequestSource>();

/** The current request's source, or undefined outside a request. */
export const currentSource = (): RequestSource | undefined => store.getStore();

export function requestSource(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  store.run(req.get(SOURCE_HEADER) === "mcp" ? "mcp" : "ui", next);
}
