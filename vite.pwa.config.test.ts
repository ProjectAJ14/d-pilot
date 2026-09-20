import { describe, expect, it } from "vitest";
import { createPwaOptions } from "./vite.pwa.config";

// Paths that must never be served from Cache Storage: query results, schema
// listings, saved queries, exports and audit records all carry PHI, and the
// cache is unencrypted on disk and survives a logout.
const API_PATHS = [
  "/api/query",
  "/api/query/execute",
  "/api/schema/tables",
  "/api/saved-queries/42",
  "/api/export/csv",
  "/api/audit",
  "/api/write-requests/7",
  "/api/mcp",
  "/api/config",
];

const ORIGIN = "https://d-pilot.example.internal";

/** Mirrors how Workbox tests a RegExp route: against the full URL. */
function matches(pattern: unknown, path: string): boolean {
  if (pattern instanceof RegExp) return pattern.test(`${ORIGIN}${path}`);
  if (typeof pattern === "string") return pattern === path;
  // A function urlPattern cannot be checked statically — fail loudly rather
  // than let an unverifiable rule through.
  throw new Error(`unsupported urlPattern type: ${typeof pattern}`);
}

// Every rule is checked twice: once for a deployment that owns the domain root
// and once for one mounted under a prefix. The PHI rules above are the reason —
// a pattern written as `^/api/` instead of `/\/api\//` would keep passing at the
// root while silently caching query results under /d-pilot.
const DEPLOYMENTS = [
  { label: "at the domain root", baseUrl: "/", prefix: "" },
  { label: "under a sub-path", baseUrl: "/d-pilot/", prefix: "/d-pilot" },
];

describe.each(DEPLOYMENTS)(
  "service worker caching rules ($label)",
  ({ baseUrl, prefix }) => {
    const pwaOptions = createPwaOptions(baseUrl);
    const workbox = pwaOptions.workbox!;
    const apiPaths = API_PATHS.map((p) => `${prefix}${p}`);

    it("never runtime-caches an API response", () => {
      for (const entry of workbox.runtimeCaching ?? []) {
        for (const path of apiPaths) {
          expect(
            matches(entry.urlPattern, path),
            `${String(entry.options?.cacheName ?? entry.handler)} must not match ${path}`,
          ).toBe(false);
        }
      }
    });

    it("keeps API paths out of the SPA navigation fallback", () => {
      const denylist = workbox.navigateFallbackDenylist ?? [];
      expect(denylist.length).toBeGreaterThan(0);
      for (const path of apiPaths) {
        expect(
          denylist.some((pattern) => matches(pattern, path)),
          `${path} must fall through to Express, not the app shell`,
        ).toBe(true);
      }
    });

    it("falls back to the shell inside its own base, not the domain root", () => {
      // A worker registered under /d-pilot/ that falls back to "/index.html"
      // hands every deep link to whatever else owns the domain root.
      expect(workbox.navigateFallback).toBe(`${baseUrl}index.html`);
    });

    it("still caches the app shell it needs to boot offline", () => {
      expect(workbox.globPatterns).toContain("**/*.{js,css,html,png}");
      // Mantine + AG Grid exceed Workbox's 2 MiB default; a lower cap would
      // silently drop the main chunk from the precache.
      expect(workbox.maximumFileSizeToCacheInBytes).toBeGreaterThan(
        2 * 1024 * 1024,
      );
    });

    // ~10 MB of editor payload. Precaching it would make every install pay for
    // an editor that cannot run a query offline anyway.
    const LAZY_EDITOR_ASSETS = [
      "/assets/monaco-a1b2c3d4.js",
      "/assets/ts.worker-a1b2c3d4.js",
      "/assets/editor.worker-a1b2c3d4.js",
      "/assets/css.worker-a1b2c3d4.js",
      "/assets/html.worker-a1b2c3d4.js",
      "/assets/json.worker-a1b2c3d4.js",
    ];

    it("leaves the Monaco chunk and its workers to runtime caching", () => {
      const ignores = workbox.globIgnores ?? [];
      expect(ignores.some((g) => g.includes("monaco"))).toBe(true);
      expect(ignores.some((g) => g.includes("worker"))).toBe(true);

      for (const asset of LAZY_EDITOR_ASSETS) {
        expect(
          (workbox.runtimeCaching ?? []).some((e) =>
            matches(e.urlPattern, `${prefix}${asset}`),
          ),
          `${asset} needs a runtime-caching rule once excluded from the precache`,
        ).toBe(true);
      }
    });

    it("caches every self-hosted font face, whatever the format", () => {
      for (const font of [
        // The app's own faces are variable woff2. A .ttf-only rule silently
        // misses them, which is exactly how this regressed once already —
        // hence a format-based pattern rather than one naming the families,
        // which would have gone stale when they changed.
        "/fonts/Archivo/Archivo-latin.woff2",
        "/fonts/Inter/Inter-latin.woff2",
        "/fonts/JetBrainsMono/JetBrainsMono-latin.woff2",
        // Monaco's codicon face still ships as .ttf.
        "/assets/codicon-a1b2.ttf",
      ]) {
        expect(
          (workbox.runtimeCaching ?? []).some((e) =>
            matches(e.urlPattern, `${prefix}${font}`),
          ),
          `${font} would otherwise be fetched on every load`,
        ).toBe(true);
      }
    });

    it("asks before activating a new worker", () => {
      // "autoUpdate" would reload the page under the user, losing open editor
      // tabs and any in-flight query.
      expect(pwaOptions.registerType).toBe("prompt");
    });
  },
);
