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

// Health check (no auth)
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", version: "1.0.0", service: "d-pilot" });
});

// Public config (no auth) — non-sensitive settings for frontend
app.get("/api/config", (_req, res) => {
  res.json({
    appName: process.env.APP_NAME || "D-Pilot",
    logoUrl: process.env.LOGO_URL || null,
    lightLogoUrl: process.env.LIGHT_LOGO_URL || null,
    faviconUrl: process.env.FAVICON_URL || null,
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
app.get("/manifest.webmanifest", (_req, res) => {
  const appName = process.env.APP_NAME || "D-Pilot";
  res.type("application/manifest+json");
  // Branding comes from env, so never let a proxy pin an old name.
  res.setHeader("Cache-Control", "no-cache");
  res.json({
    id: "/",
    name: appName,
    short_name: appName,
    description: `${appName} — internal SQL explorer`,
    start_url: "/",
    scope: "/",
    // The installed window is the web app, unchanged — same layout, same routes.
    display: "standalone",
    // Mirrors --bg and --accent4 in src/styles/global.css.
    background_color: "#f3f6f7",
    theme_color: "#0c2340",
    icons: [
      { src: "/pwa-192.png", sizes: "192x192", type: "image/png" },
      { src: "/pwa-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/pwa-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  });
});

// Auth routes (no auth required)
app.post("/api/auth/login", handleLogin);

// MCP endpoint for AI agents. Mounted before authMiddleware because MCP clients
// present the service account's username/password as HTTP Basic rather than a
// JWT; the route exchanges those for a token itself (see routes/mcp.ts).
app.use("/api/mcp", mcpRoutes);

// Auth middleware for all other /api routes
app.use("/api", authMiddleware());

// Current user
app.get("/api/auth/me", handleMe);

// Auth actions (authenticated)
app.post("/api/auth/change-password", handleChangePassword);
app.put("/api/auth/profile", handleUpdateProfile);

// API routes
app.use("/api/query", queryRoutes);
app.use("/api/connections", connectionRoutes);
app.use("/api/saved-queries", savedQueryRoutes);
app.use("/api/artifacts", artifactRoutes);
app.use("/api/schema", schemaRoutes);
app.use("/api/phi-config", phiConfigRoutes);
app.use("/api/audit", auditRoutes);
app.use("/api/export", exportRoutes);
app.use("/api/users", userRoutes);
app.use("/api/azure-ai", azureAiRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/write-requests", writeRequestRoutes);

// Serve static frontend in production
if (process.env.NODE_ENV === "production") {
  const clientDir = path.join(__dirname, "../client");
  app.use(
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
  app.get("*", (_req, res) => {
    res.sendFile(path.join(clientDir, "index.html"));
  });
}

// Initialize SQLite and auth tables, then start server
initDatabase();
initAuthTables();

app.listen(PORT, "0.0.0.0", () => {
  console.log(`
  ╔══════════════════════════════════════════╗
  ║   BG D-Pilot — Internal Query Tool      ║
  ║   Running on http://0.0.0.0:${PORT}        ║
  ║   PHI Masking: ENABLED                   ║
  ║   Auth: Local JWT                        ║
  ╚══════════════════════════════════════════╝
  `);
});

export default app;
