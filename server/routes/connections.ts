import { Router, Request, Response } from "express";
import { loadConnections, getConnectionsByEnv, getConnection } from "../config/connections.js";
import { testConnection } from "../services/query-executor.js";

const router = Router();

router.get("/", (_req: Request, res: Response) => {
  const connections = loadConnections().map((c) => ({
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

router.get("/grouped", (_req: Request, res: Response) => {
  const grouped = getConnectionsByEnv();
  const safe: Record<string, any[]> = {};
  for (const [env, conns] of Object.entries(grouped)) {
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
