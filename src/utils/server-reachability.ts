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
 * (CONNECTION_FAILED), which has its own message. D-Pilot never sends 502/504
 * itself, but a 502 with its JSON error body is still read as its answer, and
 * api-client checks a 504 with a health ping first (see PROXY_TIMEOUT_MESSAGE).
 */
export const isUnreachableStatus = (status: number): boolean =>
  status === 502 || status === 504;

/** D-Pilot's error shape, `{ error: string }` — not a proxy's HTML page. */
export const isDpilotErrorBody = (body: unknown): boolean =>
  typeof (body as { error?: unknown } | null)?.error === "string";

/**
 * A 504 is usually a proxy timing out one long query while D-Pilot is fine,
 * so it is an ordinary error; the banner waits for a health check to fail.
 */
export const PROXY_TIMEOUT_MESSAGE =
  "The request took too long and the proxy gave up. D-Pilot may still be running it.";

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

/** Sign-in's error line: the banner's text for an unreachable server (the banner isn't on that screen). */
export function loginErrorMessage(
  err: unknown,
  online: boolean,
  hint: string,
): string {
  if (isServerUnreachable(err)) return bannerMessage(online, hint);
  return (err as { message?: string } | null)?.message || "Invalid credentials";
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

/**
 * The banner's retry loop: ping every `intervalMs` and on the browser's
 * `online` event, one ping at a time, until one succeeds — then stop and call
 * `onRecovered`. Returns stop(), for the effect's cleanup.
 */
export function startReachabilityWatch(opts: {
  ping: () => Promise<boolean>;
  onRecovered?: () => void;
  intervalMs: number;
  addOnline: (cb: () => void) => void;
  removeOnline: (cb: () => void) => void;
}): () => void {
  let inFlight = false;
  let stopped = false;
  const check = async () => {
    if (inFlight || stopped) return;
    inFlight = true;
    try {
      if ((await opts.ping()) && !stopped) {
        stop();
        opts.onRecovered?.();
      }
    } finally {
      inFlight = false;
    }
  };
  const timer = setInterval(check, opts.intervalMs);
  opts.addOnline(check);
  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    opts.removeOnline(check);
  }
  return stop;
}
