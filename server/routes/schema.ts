import { Router, Request, Response } from "express";
import { resolveReadableConnection } from "../middleware/auth.js";
import {
  getTables,
  getColumns,
  getSchemas,
  getCachedFullSchema,
} from "../services/schema-introspector.js";
import {
  connectionFailedMessage,
  isConnectionError,
} from "../services/connection-errors.js";
import {
  AmbiguousObjectError,
  getDrift,
  getObjectDefinition,
  getObjectDependencies,
  getObjects,
  type ObjectRef,
  objectKindsFor,
  supportsObjects,
} from "../services/schema-objects.js";
import {
  getJobDetail,
  getJobs,
  getJobsCalling,
  JobAccessError,
  validJobId,
} from "../services/jobs.js";
import { toIdempotent } from "../services/object-change.js";
import { logAudit } from "../services/sqlite-store.js";
import type { ConnectionConfig, DbObjectKind } from "../types/index.js";

const router = Router();

// Connectivity failures (DNS, refused/timed-out connects) get a 503 with a
// stable code so the client can show a targeted "check your network" message.
function sendSchemaError(
  res: Response,
  conn: ConnectionConfig,
  err: any,
  fallback: string,
): void {
  if (isConnectionError(err)) {
    res.status(503).json({
      error: connectionFailedMessage(conn),
      code: "CONNECTION_FAILED",
    });
    return;
  }
  res.status(500).json({ error: err.message || fallback });
}

// Full schema (all tables + their columns) in one cached, de-duplicated call.
// Used by the editor's autocomplete instead of N per-table column requests.
router.get("/:connectionId/full", async (req: Request, res: Response) => {
  const conn = resolveReadableConnection(
    req,
    res,
    req.params.connectionId as string,
  );
  if (!conn) return;

  try {
    const schema = (req.query.schema as string) || undefined;
    const full = await getCachedFullSchema(conn, { schema });
    res.json(full.schema);
  } catch (err: any) {
    sendSchemaError(res, conn, err, "Failed to fetch schema");
  }
});

// Available schemas for a connection (Postgres/MSSQL). Empty for Mongo/ES.
router.get("/:connectionId/schemas", async (req: Request, res: Response) => {
  const conn = resolveReadableConnection(
    req,
    res,
    req.params.connectionId as string,
  );
  if (!conn) return;

  try {
    const result = await getSchemas(conn);
    res.json(result);
  } catch (err: any) {
    sendSchemaError(res, conn, err, "Failed to fetch schemas");
  }
});

router.get("/:connectionId/tables", async (req: Request, res: Response) => {
  const conn = resolveReadableConnection(
    req,
    res,
    req.params.connectionId as string,
  );
  if (!conn) return;

  try {
    const schema = (req.query.schema as string) || undefined;
    const tables = await getTables(conn, schema);
    res.json(tables);
  } catch (err: any) {
    sendSchemaError(res, conn, err, "Failed to fetch tables");
  }
});

router.get(
  "/:connectionId/tables/:tableName/columns",
  async (req: Request, res: Response) => {
    const conn = resolveReadableConnection(
      req,
      res,
      req.params.connectionId as string,
    );
    if (!conn) return;

    try {
      const schema = (req.query.schema as string) || undefined;
      const columns = await getColumns(
        conn,
        req.params.tableName as string,
        schema,
      );
      res.json(columns);
    } catch (err: any) {
      sendSchemaError(res, conn, err, "Failed to fetch columns");
    }
  },
);

// Procedures, functions, views and triggers. Empty for Mongo/ES.
router.get("/:connectionId/objects", async (req: Request, res: Response) => {
  const conn = resolveReadableConnection(
    req,
    res,
    req.params.connectionId as string,
  );
  if (!conn) return;

  try {
    const schema = (req.query.schema as string) || undefined;
    const kind = req.query.kind as string | undefined;
    const objects = await getObjects(conn, schema);
    res.json(kind ? objects.filter((o) => o.kind === kind) : objects);
  } catch (err: any) {
    sendSchemaError(res, conn, err, "Failed to fetch objects");
  }
});

/**
 * The object a `/objects/:kind/:name/...` request names, with the connection it
 * is read from — or null once the response has already said why not.
 * `args` picks a Postgres overload (an empty string is the zero-argument
 * one), `parent` a Postgres trigger's table.
 */
function objectTarget(
  req: Request,
  res: Response,
): { conn: ConnectionConfig; ref: ObjectRef } | null {
  const conn = resolveReadableConnection(
    req,
    res,
    req.params.connectionId as string,
  );
  if (!conn) return null;

  const kind = req.params.kind as DbObjectKind;
  const kinds = objectKindsFor(conn);
  if (!kinds.includes(kind)) {
    res.status(400).json({
      error: `A ${conn.type} connection has no '${kind}' objects — one of ${kinds.join(", ")}`,
    });
    return null;
  }
  const q = (k: string) => req.query[k] as string | undefined;
  return {
    conn,
    ref: {
      kind,
      name: req.params.name as string,
      schema: q("schema") || undefined,
      args: q("args"),
      argTypes: q("argTypes"),
      parent: q("parent") || undefined,
    },
  };
}

function sendObjectError(
  res: Response,
  conn: ConnectionConfig,
  err: any,
  fallback: string,
): void {
  if (err instanceof AmbiguousObjectError) {
    res.status(400).json({ error: err.message });
    return;
  }
  sendSchemaError(res, conn, err, fallback);
}

// One object's definition, read live. Audited: a definition is code someone
// read, and may hold literals worth knowing who saw.
router.get(
  "/:connectionId/objects/:kind/:name/definition",
  async (req: Request, res: Response) => {
    const target = objectTarget(req, res);
    if (!target) return;
    const { conn, ref } = target;
    try {
      const obj = await getObjectDefinition(conn, ref);
      if (!obj) {
        res.status(404).json({
          error: `No ${ref.kind} named ${ref.name} on this connection`,
          code: "OBJECT_NOT_FOUND",
        });
        return;
      }
      logAudit({
        userId: req.user!.sub,
        userEmail: req.user!.email,
        action: "OBJECT_VIEW",
        phiAccessed: false,
        sql: `${ref.kind} ${obj.schema}.${obj.name}${obj.args != null ? `(${obj.args})` : ""}`,
        connectionId: conn.id,
      });
      res.json({
        ...obj,
        // Only SQL has a re-runnable form; a MongoDB/Elasticsearch definition
        // is JSON that may merely mention "CREATE VIEW".
        migration:
          obj.definition == null || !supportsObjects(conn)
            ? null
            : toIdempotent(obj.definition, conn.type),
      });
    } catch (err: any) {
      sendObjectError(res, conn, err, "Failed to fetch definition");
    }
  },
);

// What an object reads and what reads it (objects, and jobs whose steps name
// it) — shown before anyone changes it.
router.get(
  "/:connectionId/objects/:kind/:name/dependencies",
  async (req: Request, res: Response) => {
    const target = objectTarget(req, res);
    if (!target) return;
    try {
      const [deps, jobs] = await Promise.all([
        getObjectDependencies(target.conn, target.ref),
        getJobsCalling(target.conn, target.ref.name),
      ]);
      res.json({ ...deps, jobs });
    } catch (err: any) {
      sendObjectError(res, target.conn, err, "Failed to fetch dependencies");
    }
  },
);

// Every object that differs between this connection and `against`, by hash of
// the normalized definition. Read rights are checked on both connections;
// only names come back, never a definition.
router.get("/:connectionId/drift", async (req: Request, res: Response) => {
  const left = resolveReadableConnection(
    req,
    res,
    req.params.connectionId as string,
  );
  if (!left) return;
  const right = resolveReadableConnection(
    req,
    res,
    req.query.against as string | undefined,
  );
  if (!right) return;
  if (left.type !== right.type) {
    res.status(400).json({
      error: "A drift report compares two connections of the same engine",
    });
    return;
  }
  try {
    const schema = (req.query.schema as string) || undefined;
    res.json(await getDrift(left, right, schema));
  } catch (err: any) {
    sendSchemaError(res, left, err, "Failed to compare connections");
  }
});

// Scheduled jobs that run against this connection's database: SQL Server
// Agent (msdb) or pg_cron. `available: false` + `reason` when the
// connection's login lacks the grant to read them.
router.get("/:connectionId/jobs", async (req: Request, res: Response) => {
  const conn = resolveReadableConnection(
    req,
    res,
    req.params.connectionId as string,
  );
  if (!conn) return;
  try {
    res.json(await getJobs(conn));
  } catch (err: any) {
    sendSchemaError(res, conn, err, "Failed to fetch jobs");
  }
});

// One job's steps (with their commands), schedules and recent runs. Audited
// like a definition read: step commands are code, sometimes with literals.
router.get(
  "/:connectionId/jobs/:jobId",
  async (req: Request, res: Response) => {
    const conn = resolveReadableConnection(
      req,
      res,
      req.params.connectionId as string,
    );
    if (!conn) return;
    const id = req.params.jobId as string;
    if (!validJobId(conn, id)) {
      res.status(400).json({
        error:
          conn.type === "mssql"
            ? "A SQL Server Agent job id is a GUID"
            : "A pg_cron job id is an integer",
      });
      return;
    }
    try {
      const job = await getJobDetail(conn, id);
      if (!job) {
        res.status(404).json({ error: `No job ${id} on this connection` });
        return;
      }
      logAudit({
        userId: req.user!.sub,
        userEmail: req.user!.email,
        action: "JOB_VIEW",
        phiAccessed: false,
        sql: `job ${job.name} (${job.id})`,
        connectionId: conn.id,
      });
      res.json(job);
    } catch (err: any) {
      if (err instanceof JobAccessError) {
        res.status(403).json({ error: err.message });
        return;
      }
      sendSchemaError(res, conn, err, "Failed to fetch job");
    }
  },
);

export default router;
