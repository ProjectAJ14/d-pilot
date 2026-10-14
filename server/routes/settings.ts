import { Router, Request, Response } from "express";
import { z } from "zod";
import { requireAdmin } from "../middleware/auth.js";
import {
  deleteDbConnection,
  logAudit,
  saveDbConnection,
} from "../services/sqlite-store.js";
import { getConnection, loadConnections } from "../config/connections.js";
import {
  isSettingKey,
  listSettings,
  resetSetting,
  updateSettings,
  type SettingKey,
} from "../config/settings.js";
import {
  closeAllConnections,
  closeConnectionPool,
} from "../services/query-executor.js";
import { clearSchemaCache } from "../services/schema-introspector.js";
import type { ConnectionAdminView, ConnectionConfig } from "../types/index.js";

/**
 * Admin-only runtime configuration: the `.env`-seeded settings (see
 * config/settings.ts) and the target-database connections. Secrets go in, never
 * come out — reads report `set`/`passwordSet`, and an empty secret on update
 * keeps the stored one. Every change is audited by key/field name, never value.
 * Testing a saved connection is the existing `GET /api/connections/:id/test`.
 */
const router = Router();
router.use(requireAdmin);

function audit(
  req: Request,
  action: string,
  sql: string,
  connectionId?: string,
) {
  logAudit({
    userId: req.user!.sub,
    userEmail: req.user!.email,
    action,
    sql,
    connectionId,
    phiAccessed: false,
  });
}

/** Caches that captured a setting's old value. */
async function applySettingChange(keys: SettingKey[]): Promise<void> {
  // Pools carry the timeout they were created with; they reconnect lazily.
  if (keys.includes("QUERY_TIMEOUT_MS")) await closeAllConnections();
  // Cached entries carry the expiry computed under the old TTL.
  if (keys.includes("SCHEMA_CACHE_TTL_HOURS")) clearSchemaCache();
}

// --- Settings ---

router.get("/", (_req: Request, res: Response) => {
  res.json(listSettings());
});

const updateBody = z.object({
  values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});

router.put("/", async (req: Request, res: Response) => {
  const body = updateBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Body must be { values: { KEY: value } }" });
    return;
  }
  let written: SettingKey[];
  try {
    written = updateSettings(body.data.values);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }
  if (written.length > 0) {
    await applySettingChange(written);
    audit(req, "SETTINGS_UPDATE", `Updated settings: ${written.join(", ")}`);
  }
  res.json(listSettings());
});

// Reset to `.env` / built-in default by deleting the stored value.
router.delete("/:key", async (req: Request, res: Response) => {
  const key = req.params.key as string;
  if (!isSettingKey(key)) {
    res.status(404).json({ error: `Unknown setting: ${key}` });
    return;
  }
  const reset = resetSetting(key);
  if (reset.length > 0) {
    await applySettingChange(reset);
    audit(req, "SETTINGS_RESET", `Reset settings: ${reset.join(", ")}`);
  }
  res.json(listSettings());
});

// --- Connections ---

const toView = ({
  password,
  uri,
  ...rest
}: ConnectionConfig): ConnectionAdminView => ({
  ...rest,
  passwordSet: !!password,
  uriSet: !!uri,
});

const optionalText = z.string().trim().max(2000).optional();
const connectionFields = z.object({
  name: z.string().trim().min(1).max(200),
  // Free-form on purpose — a new env name is how a deployment adds an
  // environment (see getEnvironments). Production rails key off the name.
  env: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,32}$/, "env must be letters, digits, _ or -"),
  type: z.enum(["postgres", "mssql", "mongodb", "elasticsearch"]),
  host: optionalText,
  port: z.number().int().min(1).max(65535).optional(),
  database: optionalText,
  username: optionalText,
  password: z.string().max(2000).optional(),
  schema: optionalText,
  schemas: z.array(z.string().trim().min(1)).optional(),
  uri: z.string().max(2000).optional(),
});
const createBody = connectionFields.extend({
  id: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,64}$/, "id must be letters, digits, _ or -"),
});

function zodError(err: z.ZodError): string {
  const issue = err.issues[0];
  return issue
    ? `${issue.path.join(".") || "body"}: ${issue.message}`
    : "Invalid body";
}

/** Pools and cached schemas were built from the old definition. */
async function dropConnectionState(id: string): Promise<void> {
  await closeConnectionPool(id);
  clearSchemaCache(id);
}

router.get("/connections", (_req: Request, res: Response) => {
  res.json(loadConnections().map(toView));
});

router.post("/connections", async (req: Request, res: Response) => {
  const body = createBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: zodError(body.error) });
    return;
  }
  if (getConnection(body.data.id)) {
    res
      .status(409)
      .json({ error: `Connection ${body.data.id} already exists` });
    return;
  }
  saveDbConnection(body.data);
  await dropConnectionState(body.data.id);
  audit(
    req,
    "CONNECTION_CREATE",
    `Created connection ${body.data.id} (${body.data.env}, ${body.data.type})`,
    body.data.id,
  );
  res.status(201).json(toView(getConnection(body.data.id)!));
});

router.put("/connections/:id", async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const existing = getConnection(id);
  if (!existing) {
    res.status(404).json({ error: "Connection not found" });
    return;
  }
  const body = connectionFields.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: zodError(body.error) });
    return;
  }
  // An omitted or empty secret keeps the stored one — the client never had it.
  const next: ConnectionConfig = {
    ...body.data,
    id,
    password: body.data.password || existing.password,
    uri: body.data.uri || existing.uri,
  };
  // ...but a kept password must not follow the connection somewhere the admin
  // picks — that would hand them a secret the API never shows. Drivers splice
  // most fields into the destination (Mongo builds a URI from username and
  // database; Elasticsearch takes its protocol from `schema`), so list what is
  // safe to change rather than what is dangerous: anything else needs the
  // password typed again.
  const target = ({
    name: _name,
    env: _env,
    schemas: _schemas,
    password: _password,
    ...rest
  }: ConnectionConfig) =>
    JSON.stringify(
      Object.entries({
        ...rest,
        schema: rest.type === "elasticsearch" ? rest.schema : undefined,
      })
        .filter(([, v]) => v !== undefined && v !== "")
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  if (
    existing.password &&
    !body.data.password &&
    target(next) !== target(existing)
  ) {
    res.status(400).json({
      error: "Re-enter the password when changing where the connection points",
    });
    return;
  }
  const changed = (Object.keys(next) as (keyof ConnectionConfig)[]).filter(
    (k) => JSON.stringify(next[k]) !== JSON.stringify(existing[k]),
  );
  saveDbConnection(next);
  await dropConnectionState(id);
  audit(
    req,
    "CONNECTION_UPDATE",
    `Updated connection ${id}: ${changed.join(", ") || "no changes"}`,
    id,
  );
  res.json(toView(getConnection(id)!));
});

router.delete("/connections/:id", async (req: Request, res: Response) => {
  const id = req.params.id as string;
  if (!deleteDbConnection(id)) {
    res.status(404).json({ error: "Connection not found" });
    return;
  }
  await dropConnectionState(id);
  audit(req, "CONNECTION_DELETE", `Deleted connection ${id}`, id);
  res.json({ deleted: true });
});

export default router;
