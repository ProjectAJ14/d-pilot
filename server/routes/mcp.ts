/**
 * MCP endpoint — read-only database access for AI agents.
 *
 * Mounted at `/api/mcp` *before* `authMiddleware`, because MCP clients cannot
 * perform D-Pilot's username/password login themselves: they present the service
 * account's credentials as HTTP Basic on every request instead. Those credentials
 * are exchanged for a normal JWT over loopback (see `services/mcp-client.ts`), so
 * from there on an agent's request is an ordinary authenticated API call —
 * environment capabilities, PHI masking, row caps and audit logging all apply
 * unchanged.
 *
 * Writes are deliberately not exposed. They belong to the write-approval
 * workflow, where a human authors the paired verify SELECT and an approver signs
 * off; an agent holding one credential must not be able to do both.
 */
import { Router, Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { DPilotApiClient } from "../services/mcp-client.js";

const router = Router();

/**
 * Default rows returned per query; agents can raise it per call via `limit`.
 * A non-numeric value falls back to the default rather than becoming NaN, which
 * would silently truncate every result to zero rows.
 */
const MCP_MAX_ROWS = parseInt(process.env.MCP_MAX_ROWS || "", 10) || 1000;

/** Tools call this same process back over loopback — nothing to configure. */
const loopbackUrl = () => `http://127.0.0.1:${process.env.PORT || "3101"}`;

// --- Credentials ---

interface BasicCredentials {
  username: string;
  password: string;
}

/** Exported for tests — this is the endpoint's only authentication gate. */
export function parseBasicAuth(header?: string): BasicCredentials | null {
  if (!header?.startsWith("Basic ")) return null;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const sep = decoded.indexOf(":");
  if (sep < 1) return null;
  return { username: decoded.slice(0, sep), password: decoded.slice(sep + 1) };
}

/**
 * One client per credential pair, so the JWT (and therefore the bcrypt login)
 * is reused across an agent's requests. Capped because the key comes straight
 * from a request header — a client that sprays credentials must not grow this
 * without bound.
 */
const clientCache = new Map<string, DPilotApiClient>();
const MAX_CACHED_CLIENTS = 50;

function clientFor(key: string, creds: BasicCredentials): DPilotApiClient {
  const cached = clientCache.get(key);
  if (cached) return cached;

  if (clientCache.size >= MAX_CACHED_CLIENTS) clientCache.clear();
  const client = new DPilotApiClient({ baseUrl: loopbackUrl(), ...creds });
  clientCache.set(key, client);
  return client;
}

// --- Tool result helpers ---

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

const text = (value: string): ToolResult => ({
  content: [{ type: "text", text: value }],
});

const json = (value: unknown): ToolResult =>
  text(JSON.stringify(value, null, 2));

/**
 * Turns an API failure into readable tool output rather than a protocol error:
 * the server's own messages ("Only read queries are allowed", "You do not have
 * access to PROD environment") are exactly the feedback an agent needs to
 * correct itself.
 */
async function guard(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (err: any) {
    return { ...text(`Error: ${err.message}`), isError: true };
  }
}

const qs = (params: Record<string, string | undefined>): string => {
  const entries = Object.entries(params).filter(([, v]) => v);
  return entries.length
    ? `?${entries.map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join("&")}`
    : "";
};

// --- Tools ---

const readOnly = { readOnlyHint: true, openWorldHint: true };

function createMcpServer(client: DPilotApiClient): McpServer {
  const server = new McpServer({ name: "d-pilot", version: "1.0.0" });

  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description:
        "The authenticated D-Pilot account, the environments it may read, and this server's default row limit. Call this first to learn what is in scope.",
      annotations: readOnly,
    },
    () =>
      guard(async () => {
        const me = await client.get<any>("/auth/me");
        return json({
          username: me.username,
          name: me.name,
          isAdmin: me.isAdmin,
          readableEnvironments: me.allowedEnvironments,
          defaultRowLimit: MCP_MAX_ROWS,
          rowLimitNote: `run_query returns at most ${MCP_MAX_ROWS} rows unless you pass a larger \`limit\`.`,
        });
      }),
  );

  server.registerTool(
    "list_connections",
    {
      title: "List databases",
      description:
        "Databases this account can query, one entry per environment+database. Use the returned `id` as `connectionId` for the other tools.",
      inputSchema: {
        env: z
          .enum(["DEV", "QA", "UAT", "STG", "PROD"])
          .optional()
          .describe("Only return connections in this environment."),
      },
      annotations: readOnly,
    },
    ({ env }) =>
      guard(async () => {
        const connections = await client.get<any[]>("/connections");
        const filtered = env
          ? connections.filter((c) => c.env === env)
          : connections;
        if (!filtered.length) {
          return text(
            env
              ? `No connections available in ${env} for this account.`
              : "No connections available for this account.",
          );
        }
        return json(
          filtered.map((c) => ({
            id: c.id,
            name: c.name,
            env: c.env,
            type: c.type,
            database: c.database,
            defaultSchema: c.schema,
          })),
        );
      }),
  );

  server.registerTool(
    "list_schemas",
    {
      title: "List schemas",
      description:
        "Schemas available on a connection (Postgres/SQL Server). Empty for MongoDB and Elasticsearch.",
      inputSchema: { connectionId: z.string() },
      annotations: readOnly,
    },
    ({ connectionId }) =>
      guard(async () =>
        json(
          await client.get<unknown>(
            `/schema/${encodeURIComponent(connectionId)}/schemas`,
          ),
        ),
      ),
  );

  server.registerTool(
    "list_tables",
    {
      title: "List tables",
      description:
        "Tables on a connection. For MongoDB and Elasticsearch this lists collections and indices.",
      inputSchema: {
        connectionId: z.string(),
        schema: z
          .string()
          .optional()
          .describe("Defaults to the connection's schema."),
      },
      annotations: readOnly,
    },
    ({ connectionId, schema }) =>
      guard(async () =>
        json(
          await client.get<unknown>(
            `/schema/${encodeURIComponent(connectionId)}/tables${qs({ schema })}`,
          ),
        ),
      ),
  );

  server.registerTool(
    "describe_table",
    {
      title: "Describe table",
      description: "Columns, types and nullability for one table.",
      inputSchema: {
        connectionId: z.string(),
        table: z.string(),
        schema: z.string().optional(),
      },
      annotations: readOnly,
    },
    ({ connectionId, table, schema }) =>
      guard(async () =>
        json(
          await client.get<unknown>(
            `/schema/${encodeURIComponent(connectionId)}/tables/${encodeURIComponent(table)}/columns${qs({ schema })}`,
          ),
        ),
      ),
  );

  server.registerTool(
    "run_query",
    {
      title: "Run a read-only query",
      description: `Executes a read-only query and returns the rows. At most ${MCP_MAX_ROWS} rows come back by default — pass a larger \`limit\` when you need more, and check the first line of the result, which says when the limit truncated the answer. Writes (INSERT/UPDATE/DELETE) and DDL are rejected — those go through D-Pilot's write-approval workflow in the UI. PHI columns come back tokenized; the result names which ones. SQL for Postgres/SQL Server; for MongoDB and Elasticsearch use the same query syntax the D-Pilot UI accepts.`,
      inputSchema: {
        connectionId: z.string(),
        sql: z.string().describe("The read-only query to run."),
        schema: z
          .string()
          .optional()
          .describe("Schema to run against (Postgres/SQL Server)."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            `Maximum rows to return. Defaults to ${MCP_MAX_ROWS} on this server; raise it to read more of a large result (the server's own MAX_ROWS setting is the final ceiling).`,
          ),
      },
      annotations: readOnly,
    },
    ({ connectionId, sql, schema, limit }) =>
      guard(async () => {
        const maxRows = limit ?? MCP_MAX_ROWS;
        const result = await client.post<any>("/query/execute", {
          connectionId,
          sql,
          schema,
          // Ask for one row past the cap: getting it back proves more rows exist,
          // which turns "there may be more" into a definite statement without a
          // second count query. The extra row is dropped below.
          defaultLimit: maxRows + 1,
        });

        // A LIMIT is injected only when the query lacks one, so an explicit
        // `LIMIT 5000` still lands here in full — cap it before it reaches the
        // agent's context window.
        const hasMore = result.rows.length > maxRows;
        const rows = result.rows.slice(0, maxRows);

        // Always say when the cap truncated the answer, and name the knob —
        // otherwise an agent reads a slice as the whole result.
        const notes = [
          `${rows.length} row(s) in ${result.executionTimeMs}ms`,
          hasMore
            ? `more rows exist — stopped at the ${maxRows}-row limit${
                limit ? "" : ` (this server's default)`
              }; call again with a larger \`limit\``
            : null,
          result.truncated
            ? `the server's own MAX_ROWS cap also applied`
            : null,
          result.maskedFields?.length
            ? `PHI-tokenized columns: ${result.maskedFields.join(", ")}`
            : null,
        ].filter(Boolean);

        return text(`${notes.join(" · ")}\n\n${JSON.stringify(rows, null, 2)}`);
      }),
  );

  return server;
}

// --- Transport ---

// Stateless: every request carries its own credentials and gets a fresh
// server + transport, so there is no session state to store or expire.
router.post("/", async (req: Request, res: Response) => {
  const header = req.headers.authorization;
  const creds = parseBasicAuth(header);
  if (!creds) {
    res.status(401).set("WWW-Authenticate", 'Basic realm="D-Pilot MCP"').json({
      error:
        "D-Pilot MCP requires HTTP Basic credentials for a service account.",
    });
    return;
  }

  const server = createMcpServer(clientFor(header!, creds));
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err: any) {
    console.error("MCP request failed:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "MCP request failed" });
    }
  }
});

// Stateless mode has no server-initiated stream and no session to delete.
const methodNotAllowed = (_req: Request, res: Response) => {
  res.status(405).json({ error: "Method not allowed. Use POST." });
};
router.get("/", methodNotAllowed);
router.delete("/", methodNotAllowed);

export default router;
