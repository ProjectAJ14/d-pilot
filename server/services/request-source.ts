/**
 * Which client an API request came from — the D-Pilot UI, an AI agent on the
 * MCP endpoint, or anything else calling the API — so the audit log can tell
 * them apart.
 *
 * The MCP tools reach the API over loopback (`mcp-client.ts`), which sends
 * `X-DPilot-Source: mcp`; the SPA's api-client sends `ui`. A request with
 * neither (a script holding a JWT) is `api`, not mislabelled as a person. The value is held in
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
  const header = req.get(SOURCE_HEADER);
  store.run(header === "mcp" || header === "ui" ? header : "api", next);
}
