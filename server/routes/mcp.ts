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
 * Database writes are deliberately not exposed. They belong to the write-approval
 * workflow, where a human authors the paired verify SELECT and an approver signs
 * off; an agent holding one credential must not be able to do both.
 *
 * Artifacts are the one exception to "read-only", and only because they are not
 * database state: an artifact stores prose and *unexecuted* read queries in
 * D-Pilot's own SQLite, and an agent may only touch the ones its account owns.
 * The DB boundary is unchanged — nothing an agent writes here can reach a target
 * database without a human opening the artifact and running a block as themselves.
 * Nor can an agent destroy one: artifacts archive, they never delete.
 */
import { Router, Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { DPilotApiClient } from "../services/mcp-client.js";
import { blocksSchema } from "./artifacts.js";

const router = Router();

/**
 * Default rows returned per query; agents can raise it per call via `limit`.
 * A non-numeric value falls back to the default rather than becoming NaN, which
 * would silently truncate every result to zero rows.
 */
const MCP_MAX_ROWS = parseInt(process.env.MCP_MAX_ROWS || "", 10) || 1000;

/** Tools call this same process back over loopback — nothing to configure. */
const loopbackUrl = () => `http://127.0.0.1:${process.env.PORT || "3101"}`;

/**
 * The origin humans browse D-Pilot on, used to hand back a clickable artifact
 * link. Falls back to a bare path: an agent pasting `/artifacts/<id>` is mildly
 * annoying, inventing `localhost:3101` for a teammate on the VPN is worse.
 */
const artifactUrl = (id: string): string => {
  const base = process.env.APP_BASE_URL?.replace(/\/+$/, "");
  return `${base ?? ""}/artifacts/${id}`;
};

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
          .string()
          .optional()
          .describe(
            "Only return connections in this environment (e.g. DEV, QA, PROD — call whoami or list without a filter to see what this deployment has).",
          ),
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
      description:
        "Columns, types, nullability, primary keys and foreign keys for one table. FK columns carry a `references` field naming the `table.column` they point at — use it to join instead of guessing.",
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

  // --- Artifacts ---
  //
  // Not database access — these read and write D-Pilot's own document store, so
  // an agent can leave findings somewhere the whole org can open, instead of in
  // a chat only its author can see. `blocks` carry queries, never result rows.

  const writes = { readOnlyHint: false, openWorldHint: true };

  const blocksInput = blocksSchema.describe(
    'The document body, in order. `{"type":"text","body":"..."}` for prose — GitHub-flavoured **markdown**: use `##` headings to structure a long document, `**bold**`, bullet lists, and `|` tables for anything columnar (never hand-aligned ASCII columns, which reflow into mush). Raw HTML is escaped, not rendered. Use a fenced code block when you need monospace alignment preserved. Then `{"type":"sql","sql":"...","label":"short name","connectionId":"..."}` for a query the reader can run from the artifact. Put each query in its own block so it gets its own Run button; omit connectionId to inherit the artifact\'s. Write queries may be stored for discussion but are never runnable from an artifact — the reader is offered the write-approval workflow instead.',
  );

  server.registerTool(
    "create_artifact",
    {
      title: "Create an artifact",
      description:
        "Publishes a shareable D-Pilot document — prose plus runnable read queries — and returns its link. Use this instead of pasting a long analysis into chat: anyone who can log in to D-Pilot can open the link, re-run the queries under their own permissions, and see their own PHI masking. Store the queries, not the rows you read.",
      inputSchema: {
        title: z.string().describe("Short document title, shown on the tab."),
        blocks: blocksInput,
        description: z
          .string()
          .optional()
          .describe("One-line summary shown under the title."),
        connectionId: z
          .string()
          .optional()
          .describe(
            "Default connection for sql blocks that don't name one (see list_connections).",
          ),
        tags: z.array(z.string()).optional(),
      },
      annotations: writes,
    },
    (input) =>
      guard(async () => {
        const artifact = await client.post<any>("/artifacts", input);
        return json({
          id: artifact.id,
          url: artifactUrl(artifact.id),
          title: artifact.title,
          blocks: artifact.blocks.length,
        });
      }),
  );

  server.registerTool(
    "update_artifact",
    {
      title: "Update an artifact",
      description:
        "Edits an artifact this account created. Only the fields you pass change; `blocks` replaces the whole body, so call get_artifact first and send the full list back rather than just the part you changed.",
      inputSchema: {
        id: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        blocks: blocksSchema
          .optional()
          .describe("Replaces the entire document body when given."),
        connectionId: z.string().optional(),
        tags: z.array(z.string()).optional(),
        archived: z
          .boolean()
          .optional()
          .describe(
            "Archive (true) or restore (false) — see archive_artifact.",
          ),
      },
      annotations: writes,
    },
    ({ id, ...updates }) =>
      guard(async () => {
        const artifact = await client.put<any>(
          `/artifacts/${encodeURIComponent(id)}`,
          updates,
        );
        return json({
          id: artifact.id,
          url: artifactUrl(artifact.id),
          title: artifact.title,
          blocks: artifact.blocks.length,
          updatedAt: artifact.updatedAt,
        });
      }),
  );

  server.registerTool(
    "get_artifact",
    {
      title: "Read an artifact",
      description:
        "The full document — every block in order. Read this before update_artifact, which replaces the whole body.",
      inputSchema: { id: z.string() },
      annotations: readOnly,
    },
    ({ id }) =>
      guard(async () =>
        json(await client.get<unknown>(`/artifacts/${encodeURIComponent(id)}`)),
      ),
  );

  server.registerTool(
    "list_artifacts",
    {
      title: "List artifacts",
      description:
        "Artifacts visible to this account, newest first. Archived ones are hidden. Bodies are omitted — call get_artifact for one.",
      inputSchema: {
        search: z
          .string()
          .optional()
          .describe("Case-insensitive match on title and description."),
      },
      annotations: readOnly,
    },
    ({ search }) =>
      guard(async () => {
        const all = await client.get<any[]>("/artifacts");
        const needle = search?.toLowerCase();
        const matched = needle
          ? all.filter((a) =>
              `${a.title} ${a.description ?? ""}`
                .toLowerCase()
                .includes(needle),
            )
          : all;
        if (!matched.length) {
          return text(
            needle ? `No artifacts match "${search}".` : "No artifacts yet.",
          );
        }
        return json(
          matched.map((a) => ({
            id: a.id,
            url: artifactUrl(a.id),
            title: a.title,
            description: a.description,
            author: a.createdByEmail,
            blocks: a.blocks.length,
            updatedAt: a.updatedAt,
          })),
        );
      }),
  );

  server.registerTool(
    "archive_artifact",
    {
      title: "Archive or restore an artifact",
      description:
        "Archives an artifact this account created: it disappears from listings, but its link keeps working and shows it as archived. There is no delete — pass `archived: false` to restore it. Prefer update_artifact when the document is merely out of date.",
      inputSchema: {
        id: z.string(),
        archived: z
          .boolean()
          .optional()
          .describe(
            "Defaults to true. Pass false to restore an archived artifact.",
          ),
      },
      annotations: { ...writes, idempotentHint: true },
    },
    ({ id, archived }) =>
      guard(async () => {
        const next = archived ?? true;
        const artifact = await client.put<any>(
          `/artifacts/${encodeURIComponent(id)}`,
          { archived: next },
        );
        return text(
          `${next ? "Archived" : "Restored"} "${artifact.title}" — ${artifactUrl(artifact.id)}`,
        );
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
