import type { Request } from "express";

/**
 * Free text in a header. The client sends `X-PHI-Unmask-Reason`/`-Notes`
 * through `encodeURIComponent`, since a header can only carry Latin-1 and the
 * notes are whatever the user typed (an em dash, a name, a newline). An older
 * client sent them raw: when that raw value isn't a valid escape sequence
 * ("100% sure") it is kept as-is. Empty or absent is undefined.
 */
export function decodeHeaderText(
  raw: string | string[] | undefined,
): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** The unmask reason and notes a request carries, decoded for the audit log. */
export function unmaskHeaders(req: Request): {
  reason?: string;
  notes?: string;
} {
  return {
    reason: decodeHeaderText(req.headers["x-phi-unmask-reason"]),
    notes: decodeHeaderText(req.headers["x-phi-unmask-notes"]),
  };
}
