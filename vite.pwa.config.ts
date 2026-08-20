import type { VitePWAOptions } from "vite-plugin-pwa";

/**
 * Service-worker / PWA configuration, kept out of `vite.config.ts` so the
 * caching rules can be unit-tested (`vite.pwa.config.test.ts`).
 *
 * **Security rule — the service worker must never cache anything under `/api`.**
 * Query results, schema listings, saved queries and audit records carry PHI, and
 * Cache Storage is unencrypted on disk and outlives a logout, so a cached
 * response would leak masked-by-policy data to anyone with the device. Only the
 * app shell (JS/CSS/HTML/icons/fonts) is cached; every API call goes to the
 * network every time. This mirrors the rule `utils/tab-persistence.ts` already
 * follows for localStorage: persist the workspace, never the results.
 *
 * Offline queueing of writes is deliberately absent for the same reason: it
 * would reorder the governed write workflow's audit trail.
 */

/** Matches every API path, wherever it appears in a URL. */
const API_ROUTE_PATTERN = /\/api\//;

const YEAR_IN_SECONDS = 60 * 60 * 24 * 365;

export const pwaOptions: Partial<VitePWAOptions> = {
  // "prompt", not "autoUpdate": an unattended reload would discard the editor
  // tabs and any in-flight query, so the user is asked instead. The prompt
  // lives in `src/components/layout/pwa-prompts.tsx`.
  registerType: "prompt",

  // The app registers the worker itself (see the same component), so no inline
  // registration script is injected into index.html.
  injectRegister: null,

  // No build-time manifest: Express serves `/manifest.webmanifest` per request
  // so each deployment's APP_NAME reaches its installed app instead of a name
  // baked in at build time (see server/index.ts).
  manifest: false,

  workbox: {
    globPatterns: ["**/*.{js,css,html,png}"],

    // Monaco is a multi-megabyte chunk of its own (see the manualChunks note in
    // vite.config.ts) and ships five language workers on top — ts.worker alone
    // is ~7 MB, and all of them together are ~9 MB. The editor is useless
    // offline anyway (running a query needs the network), so this payload is
    // fetched on first use and cached then, rather than making every install
    // pay ~10 MB up front. Both are runtime-cached below.
    globIgnores: ["**/monaco-*.js", "**/*.worker-*.js"],

    // The main chunk (Mantine + AG Grid) exceeds Workbox's 2 MiB default, which
    // would silently drop it from the precache and leave an installed app that
    // cannot boot offline.
    maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,

    cleanupOutdatedCaches: true,

    // Client-side routing: unknown paths are served the shell, exactly as the
    // Express catch-all does in production.
    navigateFallback: "/index.html",

    // ...except API paths. A direct hit on an export or MCP URL must reach the
    // server, never be answered with the SPA shell.
    navigateFallbackDenylist: [API_ROUTE_PATTERN],

    // Every entry below is app-shell or third-party static assets. Adding an
    // `/api` entry here would break the security rule at the top of this file.
    runtimeCaching: [
      {
        urlPattern: /\/assets\/monaco-[^/]*\.js$/,
        handler: "CacheFirst",
        options: {
          cacheName: "dpilot-monaco",
          // Two chunks match (the editor and monaco-vim), and names are
          // content-hashed so a deploy adds entries rather than replacing them.
          // Room for a few generations, then Workbox evicts the oldest.
          expiration: { maxEntries: 6, purgeOnQuotaError: true },
          cacheableResponse: { statuses: [200] },
        },
      },
      {
        // The language workers Monaco loads on demand (ts / css / html / json /
        // editor), kept out of the precache above.
        urlPattern: /\/assets\/[^/]*\.worker-[^/]*\.js$/,
        handler: "CacheFirst",
        options: {
          cacheName: "dpilot-monaco-workers",
          expiration: { maxEntries: 12, purgeOnQuotaError: true },
          cacheableResponse: { statuses: [200] },
        },
      },
      {
        // Barlow (public/fonts) plus Monaco's codicon face in /assets. Scoped to
        // .ttf so it cannot shadow the gstatic rule below, which serves woff2.
        urlPattern: /\.ttf$/i,
        handler: "CacheFirst",
        options: {
          cacheName: "dpilot-fonts",
          expiration: { maxEntries: 24, maxAgeSeconds: YEAR_IN_SECONDS },
          cacheableResponse: { statuses: [200] },
        },
      },
      {
        // IBM Plex Mono is the one font still loaded from Google (index.html);
        // the stylesheet is revalidated in the background.
        urlPattern: /^https:\/\/fonts\.googleapis\.com\//,
        handler: "StaleWhileRevalidate",
        options: { cacheName: "google-fonts-stylesheets" },
      },
      {
        urlPattern: /^https:\/\/fonts\.gstatic\.com\//,
        handler: "CacheFirst",
        options: {
          cacheName: "google-fonts-webfonts",
          expiration: { maxEntries: 20, maxAgeSeconds: YEAR_IN_SECONDS },
          // Font files come back opaque (no CORS), hence status 0.
          cacheableResponse: { statuses: [0, 200] },
        },
      },
    ],
  },

  // A service worker in `npm run dev` caches stale modules and makes HMR lie.
  // Verify the PWA against a production build (`npm run build && npm start`).
  devOptions: { enabled: false },
};
