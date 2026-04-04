import { Router, Request, Response } from "express";
import { loadConnections, getConnectionsByEnv, getConnection } from "../config/connections.js";
import { testConnection } from "../services/query-executor.js";

const router = Router();

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
  const conn = getConnection(req.params.id as string);
  if (!conn) {
    res.status(404).json({ error: "Connection not found" });
    return;
  }

  const ok = await testConnection(conn);
  res.json({ connectionId: conn.id, connected: ok });
});

export default router;
