import type { WriteRequest } from "../types";
import { ApiError } from "./api-client";

/**
 * A write route's 503 CONNECTION_FAILED with `request`: the write never
 * reached its database, so nothing ran. The request is back where it was —
 * DRAFT after create/submit/revise, PENDING after approve/override — and that
 * is the state to show, not "failed" or "executed".
 */
export function notReachedRequest(err: unknown): WriteRequest | null {
  return err instanceof ApiError && err.code === "CONNECTION_FAILED"
    ? (err.request ?? null)
    : null;
}

/** The toast title over the server's connection message. */
export const notReachedTitle = (wr: WriteRequest): string =>
  wr.status === "DRAFT"
    ? "Not run: saved as a draft"
    : "Not run: still pending approval";
