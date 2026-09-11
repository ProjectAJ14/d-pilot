/**
 * The sub-path this build is served under, on the client side.
 *
 * The value comes from Vite's `base`, which `vite.config.ts` sets from the
 * `BASE_PATH` environment variable at BUILD time — the same variable the server
 * reads at runtime (`server/config/base-path.ts`). Vite exposes it as
 * `import.meta.env.BASE_URL`, so there is no second environment variable to keep
 * in step and no way for the client's idea of the prefix to drift from the URLs
 * Vite baked into the bundle.
 *
 * Most code never needs these: anything Vite can see at build time (an `import`,
 * an asset URL, a `src` in index.html) is rewritten for you. They exist for the
 * handful of URLs that are assembled at RUNTIME, which Vite cannot rewrite:
 * the API client's base, the router's basename, and share links built from
 * `window.location.origin`.
 */

/** Always a trailing slash: "/" at the domain root, "/d-pilot/" under a prefix. */
export const BASE_URL = import.meta.env.BASE_URL;

/**
 * No trailing slash, and EMPTY at the domain root: "" or "/d-pilot".
 * The form to concatenate onto a root-absolute path — `${BASE_PATH}/artifacts/1`
 * is correct in both deployments, where `${BASE_URL}/artifacts/1` would give a
 * double slash at the root.
 */
export const BASE_PATH = BASE_URL.replace(/\/+$/, "");
