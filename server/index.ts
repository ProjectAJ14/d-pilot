import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

import {
  authMiddleware,
  handleLogin,
  handleMe,
  handleChangePassword,
  handleUpdateProfile,
  initAuthTables,
} from "./middleware/auth.js";
import { initDatabase, getPhiMaskedEnvs } from "./services/sqlite-store.js";
import { getEnvironments } from "./config/connections.js";
import { BASE_PATH, BASE_URL, withBase } from "./config/base-path.js";
import { loadCopyFormats } from "./config/copy-formats.js";
import queryRoutes from "./routes/query.js";
import connectionRoutes from "./routes/connections.js";
import savedQueryRoutes from "./routes/saved-queries.js";
import artifactRoutes from "./routes/artifacts.js";
import schemaRoutes from "./routes/schema.js";
import phiConfigRoutes from "./routes/phi-config.js";
import auditRoutes from "./routes/audit.js";
import exportRoutes from "./routes/export.js";
import userRoutes from "./routes/users.js";
import azureAiRoutes from "./routes/azure-ai.js";
import analyticsRoutes from "./routes/analytics.js";
import writeRequestRoutes from "./routes/write-requests.js";
import mcpRoutes from "./routes/mcp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "3101", 10);

const app = express();

// Middleware
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "1mb" }));

/**
 * Everything D-Pilot serves — the API, the web manifest and the built client —
 * hangs off this router, which is then mounted at BASE_PATH. At the domain root
 * that mount is "/" and this is exactly the app it has always been; under a
 * sub-path it means the server answers on /d-pilot/api/... itself.
 *
 * Mounting the server rather than having the proxy strip the prefix is the
 * deliberate choice: it keeps the reverse proxy a plain `proxy_pass` with no
 * path rewriting, so there is one place (BASE_PATH) that knows the prefix
 * instead of two that have to be kept in agreement. It also means a redirect or
 * a cookie path emitted here is already correct, rather than correct only after
 * something downstream rewrites it.
 */
const router = express.Router();

// Health check (no auth)
router.get("/api/health", (_req, res) => {
  res.json({ status: "ok", version: "1.0.0", service: "d-pilot" });
});

// Public config (no auth) — non-sensitive settings for frontend
router.get("/api/config", (_req, res) => {
  res.json({
    appName: process.env.APP_NAME || "D-Pilot",
    // Branding URLs are either a file the deployment dropped in public/
    // ("/logo/logo.png") or somebody else's CDN. withBase prefixes the first
    // kind and leaves the second alone, so a sub-path deployment does not ask
    // the domain root for its logo and get another app's 404 page.
    logoUrl: withBase(BASE_PATH, process.env.LOGO_URL),
    lightLogoUrl: withBase(BASE_PATH, process.env.LIGHT_LOGO_URL),
    faviconUrl: withBase(BASE_PATH, process.env.FAVICON_URL),
    emailDomain: process.env.EMAIL_DOMAIN || null,
    phiMaskedEnvironments: getPhiMaskedEnvs(),
    // The deployment's environments, derived from DBFORGE_CONNECTIONS. The
    // client renders its env pickers from this — never a hardcoded list.
    environments: getEnvironments(),
    // Results "Copy as" formats — from COPY_FORMATS env, else code defaults.
    copyFormats: loadCopyFormats(),
  });
});

// PWA web manifest. Rendered per request rather than baked into the build so an
// installed app carries the deployment's own APP_NAME instead of the neutral
// fallback. The icons stay as the bundled PNGs on purpose: LOGO_URL/FAVICON_URL
// are arbitrary URLs (frequently SVG, often cross-origin) while installers
// require raster icons at the declared sizes. Regenerate them with
// `npm run icons:pwa`.
router.get("/manifest.webmanifest", (_req, res) => {
  const appName = process.env.APP_NAME || "D-Pilot";
  res.type("application/manifest+json");
  // Branding comes from env, so never let a proxy pin an old name.
  res.setHeader("Cache-Control", "no-cache");
  res.json({
    // All four of these are resolved against the origin, not against the
    // manifest's own URL, so they have to carry the base explicitly. A scope of
    // "/" on a sub-path deployment makes the installed app claim the whole
    // domain — every link to the app that owns the root would open inside
    // D-Pilot's window.
    id: BASE_URL,
    name: appName,
    short_name: appName,
    description: `${appName} — internal SQL explorer`,
    start_url: BASE_URL,
    scope: BASE_URL,
    // The installed window is the web app, unchanged — same layout, same routes.
    display: "standalone",
    // The paper ground's --bg and --ink. A manifest is JSON served before the
    // app boots, so these cannot be var()s — they are the one place outside
    // src/styles/tokens.css that restates a ground value, and the splash screen
    // an installed app shows is what they paint.
    background_color: "#f0ede6",
    theme_color: "#16150f",
    icons: [
      { src: `${BASE_PATH}/pwa-192.png`, sizes: "192x192", type: "image/png" },
      { src: `${BASE_PATH}/pwa-512.png`, sizes: "512x512", type: "image/png" },
      {
        src: `${BASE_PATH}/pwa-maskable-512.png`,
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  });
});

// Auth routes (no auth required)
router.post("/api/auth/login", handleLogin);

// MCP endpoint for AI agents. Mounted before authMiddleware because MCP clients
// present the service account's username/password as HTTP Basic rather than a
// JWT; the route exchanges those for a token itself (see routes/mcp.ts).
router.use("/api/mcp", mcpRoutes);

// Auth middleware for all other /api routes
router.use("/api", authMiddleware());

// Current user
router.get("/api/auth/me", handleMe);

// Auth actions (authenticated)
router.post("/api/auth/change-password", handleChangePassword);
router.put("/api/auth/profile", handleUpdateProfile);

// API routes
router.use("/api/query", queryRoutes);
router.use("/api/connections", connectionRoutes);
router.use("/api/saved-queries", savedQueryRoutes);
router.use("/api/artifacts", artifactRoutes);
router.use("/api/schema", schemaRoutes);
router.use("/api/phi-config", phiConfigRoutes);
router.use("/api/audit", auditRoutes);
router.use("/api/export", exportRoutes);
router.use("/api/users", userRoutes);
router.use("/api/azure-ai", azureAiRoutes);
router.use("/api/analytics", analyticsRoutes);
router.use("/api/write-requests", writeRequestRoutes);

// Serve static frontend in production
if (process.env.NODE_ENV === "production") {
  const clientDir = path.join(__dirname, "../client");
  router.use(
    express.static(clientDir, {
      setHeaders(res, filePath) {
        // The service worker and its runtime must never be served from a stale
        // cache: a proxy holding on to the previous sw.js pins clients to the
        // old build indefinitely. Hashed assets under /assets stay cacheable.
        const name = path.basename(filePath);
        if (name === "sw.js" || name.startsWith("workbox-")) {
          res.setHeader("Cache-Control", "no-cache");
        }
      },
    }),
  );
  router.get("*", (_req, res) => {
    res.sendFile(path.join(clientDir, "index.html"));
  });
}

// Mount everything under the configured sub-path. "" means the domain root, and
// Express wants "/" rather than "" for that.
app.use(BASE_PATH || "/", router);

// Initialize SQLite and auth tables, then start server
initDatabase();
initAuthTables();

app.listen(PORT, "0.0.0.0", () => {
  // Padded rather than hand-spaced: BASE_PATH makes this line variable-width,
  // and a sub-path deployment that silently shreds the box is a bad first
  // impression of whether the prefix took effect at all.
  const listeningOn = `Running on http://0.0.0.0:${PORT}${BASE_PATH}`;
  console.log(`
  ╔══════════════════════════════════════════╗
  ║   D-Pilot — Internal Query Tool          ║
  ║   ${listeningOn.padEnd(39)}║
  ║   PHI Masking: ENABLED                   ║
  ║   Auth: Local JWT                        ║
  ╚══════════════════════════════════════════╝
  `);
});

export default app;
