/**
 * Telling "the D-Pilot server can't be reached" apart from every other API
 * failure. Behind a VPN, the PWA shell still loads from the service worker
 * with the VPN off, and then every /api call fails at once; the app shows one
 * banner for that (`server-unreachable-banner.tsx`) instead of a toast per call.
 */

export const SERVER_UNREACHABLE_MESSAGE = "Can't reach the D-Pilot server.";

/**
 * 502/504: a reverse proxy answered, but D-Pilot behind it did not. Not 503 —
 * that is D-Pilot itself saying a target *database* is unreachable
 * (CONNECTION_FAILED), which has its own message.
 */
export const isUnreachableStatus = (status: number): boolean =>
  status === 502 || status === 504;

/** A rejected fetch got no HTTP response at all — unless we aborted it ourselves. */
export const isUnreachableRejection = (err: unknown): boolean =>
  (err as { name?: unknown } | null)?.name !== "AbortError";

/** True for the ApiError the client throws when the server is unreachable. */
export const isServerUnreachable = (err: unknown): boolean =>
  (err as { code?: unknown } | null)?.code === "SERVER_UNREACHABLE";

/** The banner's text. `hint` is the deployment's NETWORK_HINT ("" = none). */
export function bannerMessage(online: boolean, hint: string): string {
  if (!online)
    return "You're offline. D-Pilot will reconnect when your connection is back.";
  return `${SERVER_UNREACHABLE_MESSAGE} ${hint.trim() || "Check your network or VPN connection."}`;
}

/**
 * The last-known hint, kept in localStorage: it is public config (served by
 * /api/config to anyone), and the moment it is needed is exactly when
 * /api/config can't be fetched. Storage can throw (private mode, blocked).
 */
const HINT_KEY = "dbpilot_network_hint";

export function loadNetworkHint(): string {
  try {
    return localStorage.getItem(HINT_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveNetworkHint(hint: string): void {
  try {
    if (hint) localStorage.setItem(HINT_KEY, hint);
    else localStorage.removeItem(HINT_KEY);
  } catch {
    // Not persisted; the banner falls back to the generic advice.
  }
}
