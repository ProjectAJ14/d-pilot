import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

import { authMiddleware, handleLogin, handleMe, handleChangePassword, handleUpdateProfile, initAuthTables } from "./middleware/auth.js";
import { initDatabase, getPhiMaskedEnvs } from "./services/sqlite-store.js";
import queryRoutes from "./routes/query.js";
import connectionRoutes from "./routes/connections.js";
import savedQueryRoutes from "./routes/saved-queries.js";
import schemaRoutes from "./routes/schema.js";
import phiConfigRoutes from "./routes/phi-config.js";
import auditRoutes from "./routes/audit.js";
import exportRoutes from "./routes/export.js";
import userRoutes from "./routes/users.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "3101", 10);

const app = express();

// Middleware
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "1mb" }));

// Health check (no auth)
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", version: "1.0.0", service: "cep-db-pilot" });
});

// Public config (no auth) — non-sensitive settings for frontend
app.get("/api/config", (_req, res) => {
  res.json({
    appName: process.env.APP_NAME || "D-Pilot",
    logoUrl: process.env.LOGO_URL || null,
    lightLogoUrl: process.env.LIGHT_LOGO_URL || null,
    emailDomain: process.env.EMAIL_DOMAIN || null,
    phiMaskedEnvironments: getPhiMaskedEnvs(),
  });
});

// Auth routes (no auth required)
app.post("/api/auth/login", handleLogin);

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
app.use("/api/schema", schemaRoutes);
app.use("/api/phi-config", phiConfigRoutes);
app.use("/api/audit", auditRoutes);
app.use("/api/export", exportRoutes);
app.use("/api/users", userRoutes);

// Serve static frontend in production
if (process.env.NODE_ENV === "production") {
  const clientDir = path.join(__dirname, "../client");
  app.use(express.static(clientDir));
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
