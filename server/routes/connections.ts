import { Router, Request, Response } from "express";
import { loadConnections, getConnectionsByEnv, getConnection } from "../config/connections.js";
import {
  testConnection,
  getPoolStatus,
  closeConnectionPool,
} from "../services/query-executor.js";
import { requireAdmin, resolveReadableConnection } from "../middleware/auth.js";

const router = Router();

// Live pool status per configured connection (admin — powers the analytics card).
router.get("/status", requireAdmin, (_req: Request, res: Response) => {
  const statuses = loadConnections().map((c) => ({
    id: c.id,
    name: c.name,
    env: c.env,
    type: c.type,
    database: c.database,
    ...getPoolStatus(c.id),
  }));
  res.json(statuses);
});

// Force-close a connection's pool; it reconnects lazily on next use.
router.post("/:id/disconnect", requireAdmin, async (req: Request, res: Response) => {
  const conn = getConnection(req.params.id as string);
  if (!conn) {
    res.status(404).json({ error: "Connection not found" });
    return;
  }
  const closed = await closeConnectionPool(conn.id);
  res.json({ connectionId: conn.id, closed });
});

router.get("/", (req: Request, res: Response) => {
  const allowed = req.user?.allowedEnvironments || [];
  const isAdmin = req.user?.isAdmin;
  const connections = loadConnections()
    .filter((c) => isAdmin || allowed.includes(c.env))
    .map((c) => ({
      id: c.id,
      name: c.name,
      env: c.env,
      type: c.type,
      host: c.host,
      port: c.port,
      database: c.database,
      schema: c.schema,
      // Never expose credentials
    }));
  res.json(connections);
});

// Connections the user may author write requests against (write-scoped envs).
router.get("/writable", (req: Request, res: Response) => {
  const writeEnvs = req.user?.writeEnvironments || [];
  const isAdmin = req.user?.isAdmin;
  const connections = loadConnections()
    .filter((c) => isAdmin || writeEnvs.includes(c.env))
    .map((c) => ({
      id: c.id,
      name: c.name,
      env: c.env,
      type: c.type,
      host: c.host,
      port: c.port,
      database: c.database,
      schema: c.schema,
    }));
  res.json(connections);
});

router.get("/grouped", (req: Request, res: Response) => {
  const allowed = req.user?.allowedEnvironments || [];
  const isAdmin = req.user?.isAdmin;
  const grouped = getConnectionsByEnv();
  const safe: Record<string, any[]> = {};
  for (const [env, conns] of Object.entries(grouped)) {
    if (!isAdmin && !allowed.includes(env)) continue;
    safe[env] = conns.map((c) => ({
      id: c.id,
      name: c.name,
      env: c.env,
      type: c.type,
      host: c.host,
      port: c.port,
      database: c.database,
      schema: c.schema,
    }));
  }
  res.json(safe);
});

router.get("/:id/test", async (req: Request, res: Response) => {
  const conn = resolveReadableConnection(req, res, req.params.id as string);
  if (!conn) return;

  const ok = await testConnection(conn);
  res.json({ connectionId: conn.id, connected: ok });
});

export default router;
