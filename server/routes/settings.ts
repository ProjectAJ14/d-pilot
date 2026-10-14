import { Router, Request, Response } from "express";
import { z } from "zod";
import { requireAdmin } from "../middleware/auth.js";
import {
  deleteDbConnection,
  logAudit,
  saveDbConnection,
  storedConnectionSecrets,
} from "../services/sqlite-store.js";
import {
  getConnection,
  isProductionEnv,
  loadConnections,
} from "../config/connections.js";
import {
  getConfigNumber,
  isSettingKey,
  listSettings,
  resetSetting,
  updateSettings,
  type SettingKey,
} from "../config/settings.js";
import {
  closeAllConnections,
  closeConnectionPool,
  testConnectionConfig,
} from "../services/query-executor.js";
import { clearSchemaCache } from "../services/schema-introspector.js";
import type { ConnectionAdminView, ConnectionConfig } from "../types/index.js";

/**
 * Admin-only runtime configuration: the `.env`-seeded settings (see
 * config/settings.ts) and the target-database connections. Secrets go in, never
 * come out — reads report `set`/`passwordSet`, an empty secret on update
 * keeps the stored one, and `clearPassword`/`clearUri` remove it. Every change is audited by key/field name, never value.
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

/**
 * Caches that captured a setting's old value. `timeoutBefore` is the query
 * timeout in force before the change — how long the retired pools' in-flight
 * queries may still run.
 */
function applySettingChange(keys: SettingKey[], timeoutBefore: number): void {
  // Pools carry the timeout they were created with; they reconnect lazily.
  if (keys.includes("QUERY_TIMEOUT_MS")) closeAllConnections(timeoutBefore);
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
  const timeoutBefore = getConfigNumber("QUERY_TIMEOUT_MS");
  let written: SettingKey[];
  try {
    written = updateSettings(body.data.values);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }
  if (written.length > 0) {
    applySettingChange(written, timeoutBefore);
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
  const timeoutBefore = getConfigNumber("QUERY_TIMEOUT_MS");
  const reset = resetSetting(key);
  if (reset.length > 0) {
    applySettingChange(reset, timeoutBefore);
    audit(req, "SETTINGS_RESET", `Reset settings: ${reset.join(", ")}`);
  }
  res.json(listSettings());
});

// --- Connections ---

// "Set" means stored, not decryptable — see storedConnectionSecrets.
const toView = ({
  password: _password,
  uri: _uri,
  ...rest
}: ConnectionConfig): ConnectionAdminView => {
  const stored = storedConnectionSecrets(rest.id);
  return { ...rest, passwordSet: stored.password, uriSet: stored.uri };
};

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

// Clearing is explicit: an empty secret on update means "keep", not "remove".
const connectionUpdateBody = connectionFields.extend({
  clearPassword: z.boolean().optional(),
  clearUri: z.boolean().optional(),
});
type ConnectionUpdate = z.infer<typeof connectionUpdateBody>;
// Testing takes the update body, plus the id of the connection being edited.
const connectionTestBody = connectionUpdateBody.extend({
  id: createBody.shape.id.optional(),
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

/**
 * The connection an update would produce, stored secrets filled in where the
 * body leaves them blank — or why that is refused. PUT and the pre-save test
 * share it, so a test can never use a stored secret a save could not.
 */
function mergeUpdate(
  existing: ConnectionConfig,
  data: ConnectionUpdate,
):
  | { next: ConnectionConfig; keep: { password: boolean; uri: boolean } }
  | { error: string } {
  const { clearPassword, clearUri, ...fields } = data;
  // An omitted or empty secret keeps the stored one — the client never had it.
  // Clearing drops the secret (nothing is kept, so nothing can be redirected).
  // A kept secret keeps its stored ciphertext, even one that no longer decrypts.
  const keep = {
    password: !fields.password && !clearPassword,
    uri: !fields.uri && !clearUri,
  };
  const next: ConnectionConfig = {
    ...fields,
    id: existing.id,
    password: clearPassword ? undefined : fields.password || existing.password,
    uri: clearUri ? undefined : fields.uri || existing.uri,
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
    keep.password &&
    storedConnectionSecrets(existing.id).password &&
    target(next) !== target(existing)
  ) {
    return {
      error: "Re-enter the password when changing where the connection points",
    };
  }
  return { next, keep };
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
  const body = connectionUpdateBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: zodError(body.error) });
    return;
  }
  // Production rail: the env name is what forces PHI masking and blocks direct
  // writes, so relabelling a production connection would lift both at once.
  if (isProductionEnv(existing.env) && !isProductionEnv(body.data.env)) {
    res.status(422).json({
      error: `env: ${existing.env} is production — a production connection can't move to a non-production environment (${body.data.env}). Production PHI stays tokenized and production writes stay two-person.`,
    });
    return;
  }
  const merged = mergeUpdate(existing, body.data);
  if ("error" in merged) {
    res.status(400).json({ error: merged.error });
    return;
  }
  const { next, keep } = merged;
  const changed = (Object.keys(next) as (keyof ConnectionConfig)[]).filter(
    (k) => JSON.stringify(next[k]) !== JSON.stringify(existing[k]),
  );
  saveDbConnection(next, keep);
  await dropConnectionState(id);
  audit(
    req,
    "CONNECTION_UPDATE",
    `Updated connection ${id}: ${changed.join(", ") || "no changes"}`,
    id,
  );
  res.json(toView(getConnection(id)!));
});

// Try the form's values before saving. Builds a throwaway client — the pools
// and the saved connection are untouched — and runs the same check as
// GET /api/connections/:id/test.
router.post("/connections/test", async (req: Request, res: Response) => {
  const body = connectionTestBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: zodError(body.error) });
    return;
  }
  const { id, ...data } = body.data;
  const existing = id ? getConnection(id) : undefined;
  let conn: ConnectionConfig;
  let usesStoredSecret = false;
  if (existing) {
    const merged = mergeUpdate(existing, data);
    if ("error" in merged) {
      res.status(400).json({ error: merged.error });
      return;
    }
    conn = merged.next;
    const stored = storedConnectionSecrets(existing.id);
    usesStoredSecret =
      (merged.keep.password && stored.password) ||
      (merged.keep.uri && stored.uri);
  } else {
    const { clearPassword: _p, clearUri: _u, ...fields } = data;
    conn = { ...fields, id: id ?? "unsaved" };
  }
  let error: string | undefined;
  try {
    await testConnectionConfig(conn);
  } catch (err) {
    error = (err as Error).message || String(err);
    // A driver may echo a stored secret in any encoding (percent-encoded in a
    // Mongo URI, a fragment of a stored URI) — masking cannot catch them all.
    // So when the test used a secret the admin never saw, return no driver
    // text; when every secret came from the form, they typed it themselves.
    if (usesStoredSecret) {
      console.error(`Connection test for ${existing!.id} failed:`, error);
      error =
        "Could not connect using the stored credentials — the driver error is in the server log.";
    }
  }
  audit(
    req,
    "CONNECTION_TEST",
    `Tested ${existing ? `connection ${existing.id}` : "unsaved connection"} (${conn.env}, ${conn.type}): ${error ? "failed" : "ok"}`,
    existing?.id,
  );
  res.json(error ? { ok: false, error } : { ok: true });
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
