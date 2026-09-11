/**
 * The sub-path D-Pilot is served under.
 *
 * D-Pilot normally owns a domain root (`https://d-pilot.internal/`), but it can
 * also be mounted under a prefix of a shared domain
 * (`https://intranet.example/d-pilot`) behind a reverse proxy. When it is, every
 * root-absolute URL the app emits — the JS bundle, the API calls, the router's
 * routes, the PWA manifest — has to carry that prefix, or it lands on whatever
 * else owns that domain's root instead. This module is where the prefix is
 * decided, once, from the `BASE_PATH` environment variable.
 *
 * There are deliberately two spellings of the same value, because the consumers
 * disagree about the trailing slash:
 *
 *   - `BASE_PATH`  — no trailing slash, EMPTY at the root: "" or "/d-pilot".
 *                    Concatenate onto a path: `${BASE_PATH}/api/health`.
 *                    Express mount points and string building want this.
 *   - `BASE_URL`   — always a trailing slash: "/" or "/d-pilot/".
 *                    Vite's `base`, `import.meta.env.BASE_URL` and the web
 *                    manifest's `scope`/`start_url` are all defined this way.
 *
 * Setting `BASE_PATH` is a BUILD-time decision for the client and a RUN-time one
 * for the server, because Vite bakes `base` into the emitted asset URLs. Both
 * must agree, which is why `npm run build` and `npm start` read the same
 * variable from the same `.env`. Changing it means rebuilding, not just
 * restarting — see README, "Serving under a sub-path".
 */

/**
 * Accepts anything an operator is likely to type — "d-pilot", "/d-pilot",
 * "/d-pilot/", " /d-pilot " — and returns the canonical no-trailing-slash form.
 * Unset, empty and "/" all mean "served at the domain root" and return "".
 */
export function normalizeBasePath(raw: string | undefined | null): string {
  const trimmed = (raw ?? "").trim();
  // `/^\/+$/`, not `=== "/"`: "//" would otherwise normalise to "/" and
  // toBaseUrl() would hand Vite a `base` of "//" — a protocol-relative URL, so
  // every asset href resolves against a host named "assets" instead of this one.
  if (!trimmed || /^\/+$/.test(trimmed)) return "";
  return "/" + trimmed.replace(/^\/+/, "").replace(/\/+$/, "");
}

/** The trailing-slash spelling. "" -> "/", "/d-pilot" -> "/d-pilot/". */
export function toBaseUrl(basePath: string): string {
  return `${basePath}/`;
}

/**
 * Prefix a root-absolute path with the base. Leaves absolute URLs
 * ("https://…", "//cdn…") and relative paths alone, so operator-supplied
 * branding values (`LOGO_URL`, `FAVICON_URL`) work whether they point at a file
 * in `public/` or at somebody else's CDN.
 */
export function withBase(
  basePath: string,
  url: string | null | undefined,
): string | null {
  if (!url) return null;
  if (!url.startsWith("/") || url.startsWith("//")) return url;
  return `${basePath}${url}`;
}

/**
 * The absolute base for links handed to a human — MCP tool output, mainly.
 *
 * `APP_BASE_URL` is documented as the *origin* users browse D-Pilot on
 * ("https://intranet.example"), so it carries no sub-path of its own and
 * `basePath` has to be appended, or the link lands on whatever owns the domain
 * root. That is the same failure the rest of this module exists to prevent,
 * except it happens in the one place the URL gets pasted into a ticket.
 *
 * An origin that already spells the prefix out is left alone: appending twice
 * is worse than not appending at all, and an operator who wrote the path meant
 * it. Empty, "/" and anything unparseable fall through unchanged — for the
 * first two that means the bare `basePath`, which is the relative-link
 * behaviour of an unset `APP_BASE_URL`.
 */
export function withBaseOrigin(
  origin: string | undefined | null,
  basePath: string,
): string {
  const trimmed = (origin ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) return basePath;
  let pathname: string;
  try {
    pathname = new URL(trimmed).pathname;
  } catch {
    // Not a URL we can reason about (no scheme, say). Leave the operator's
    // value exactly as written rather than guessing where its path starts.
    return trimmed;
  }
  return pathname === "/" ? `${trimmed}${basePath}` : trimmed;
}

/** Canonical base path for this process, e.g. "" or "/d-pilot". */
export const BASE_PATH = normalizeBasePath(process.env.BASE_PATH);

/** Canonical base URL for this process, e.g. "/" or "/d-pilot/". */
export const BASE_URL = toBaseUrl(BASE_PATH);
