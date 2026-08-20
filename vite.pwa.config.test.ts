import { describe, expect, it } from "vitest";
import { pwaOptions } from "./vite.pwa.config";

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

describe("service worker caching rules", () => {
  const workbox = pwaOptions.workbox!;

  it("never runtime-caches an API response", () => {
    for (const entry of workbox.runtimeCaching ?? []) {
      for (const path of API_PATHS) {
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
    for (const path of API_PATHS) {
      expect(
        denylist.some((pattern) => matches(pattern, path)),
        `${path} must fall through to Express, not the app shell`,
      ).toBe(true);
    }
  });

  it("still caches the app shell it needs to boot offline", () => {
    expect(workbox.globPatterns).toContain("**/*.{js,css,html,png}");
    // Mantine + AG Grid exceed Workbox's 2 MiB default; a lower cap would
    // silently drop the main chunk from the precache.
    expect(workbox.maximumFileSizeToCacheInBytes).toBeGreaterThan(
      2 * 1024 * 1024,
    );
  });

  // ~10 MB of editor payload. Precaching it would make every install pay for an
  // editor that cannot run a query offline anyway.
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
          matches(e.urlPattern, asset),
        ),
        `${asset} needs a runtime-caching rule once excluded from the precache`,
      ).toBe(true);
    }
  });

  it("caches both local and Monaco font faces", () => {
    for (const font of [
      "/fonts/Barlow/Barlow-Regular.ttf",
      "/assets/codicon-a1b2.ttf",
    ]) {
      expect(
        (workbox.runtimeCaching ?? []).some((e) => matches(e.urlPattern, font)),
        `${font} would otherwise be fetched on every load`,
      ).toBe(true);
    }
  });

  it("asks before activating a new worker", () => {
    // "autoUpdate" would reload the page under the user, losing open editor
    // tabs and any in-flight query.
    expect(pwaOptions.registerType).toBe("prompt");
  });
});
