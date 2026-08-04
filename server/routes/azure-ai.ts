import { Router, Request, Response } from "express";
import { requireAdmin, resolveReadableConnection } from "../middleware/auth.js";
import {
  getCachedFullSchema,
  summarizeTables,
  tableCatalog,
  clearSchemaCache,
  type FullSchema,
} from "../services/schema-introspector.js";
import {
  logAiChat,
  getAiChatLog,
  getSavedQueries,
} from "../services/sqlite-store.js";
import {
  selectExampleQueries,
  extractReferencedTables,
} from "../services/query-examples.js";
import {
  getAzureConfig,
  azureChat,
  AzureOpenAIError,
  type AzureChatMessage,
  type AzureConfig,
} from "../services/azure-openai.js";
import type { DatabaseType, AiChatLogEntry } from "../types/index.js";

const router = Router();

// Only run the (extra) table-selection LLM pass when a schema is large enough
// to benefit; small schemas are sent whole. Cap how many tables ever go into
// one generation prompt.
const TABLE_SELECTION_THRESHOLD = 25;
const MAX_PROMPT_TABLES = 30;

// ── Test connection (admin only) ──
router.post("/test", requireAdmin, async (_req: Request, res: Response) => {
  const { config, missing } = getAzureConfig();
  if (!config) {
    res.status(400).json({
      success: false,
      message: `Missing environment variable(s): ${missing.join(", ")}`,
    });
    return;
  }

  try {
    const result = await azureChat(
      config,
      [{ role: "user", content: "ping" }],
      { maxTokens: 16, timeoutMs: 20000 },
    );
    res.json({
      success: true,
      message: "Successfully connected to Azure OpenAI",
      endpoint: config.endpoint,
      deployment: config.deployment,
      model: result.model || config.model,
    });
  } catch (err: any) {
    res.json({
      success: false,
      message: err?.message || "Failed to reach Azure OpenAI endpoint",
      endpoint: config.endpoint,
      deployment: config.deployment,
      model: config.model,
    });
  }
});

// ── Generate a query from natural language (any authenticated user) ──

/** Per-dialect guidance so the model emits a runnable, read-only query. */
function dialectGuidance(type: DatabaseType): string {
  switch (type) {
    case "postgres":
      return [
        "Target: PostgreSQL. Generate a single read-only SELECT statement.",
        "Use standard PostgreSQL syntax. Use LIMIT to cap rows when appropriate.",
        "Quote identifiers with double quotes only if they need it (mixed case / reserved words).",
      ].join(" ");
    case "mssql":
      return [
        "Target: Microsoft SQL Server (T-SQL). Generate a single read-only SELECT statement.",
        "Cap rows with TOP (n) or OFFSET/FETCH. Use square brackets for identifiers that need quoting.",
      ].join(" ");
    case "mongodb":
      return [
        "Target: MongoDB. Generate a single read-only shell expression such as",
        "db.<collection>.find({ ... }) or db.<collection>.aggregate([ ... ]).",
        "Use only read operations (find, findOne, aggregate, countDocuments, distinct).",
        "Return valid MongoDB extended JSON for the filter/pipeline.",
      ].join(" ");
    case "elasticsearch":
      return [
        "Target: Elasticsearch. Generate a single read-only request in the form",
        "GET /<index>/_search followed by a JSON query body, e.g.",
        'GET /my-index/_search\\n{ "query": { "match_all": {} }, "size": 100 }.',
      ].join(" ");
    default:
      return "Generate a single read-only query.";
  }
}

/** Per-dialect guidance for generating a single write (DML) statement. */
function writeDialectGuidance(type: DatabaseType): string {
  switch (type) {
    case "postgres":
      return "Target: PostgreSQL. Produce a single INSERT/UPDATE/DELETE with standard PostgreSQL syntax.";
    case "mssql":
      return "Target: Microsoft SQL Server (T-SQL). Produce a single INSERT/UPDATE/DELETE.";
    case "mongodb":
      return [
        "Target: MongoDB. Produce a single write shell expression such as",
        "db.<collection>.updateMany(filter, { $set: { ... } }), db.<collection>.deleteMany(filter),",
        "db.<collection>.updateOne(...), or db.<collection>.insertOne({ ... }). Use valid JSON for filters/updates.",
      ].join(" ");
    case "elasticsearch":
      return [
        "Target: Elasticsearch. Produce a single write request such as",
        'POST /<index>/_update_by_query { "query": {...}, "script": {...} } or POST /<index>/_delete_by_query { "query": {...} }.',
      ].join(" ");
    default:
      return "Produce a single write statement.";
  }
}

/**
 * Cheap LLM pass: given a catalog of all tables (names + column names), pick the
 * tables relevant to the request so the main prompt sends only those in full.
 * Returns validated table names (exact-cased), or null to fall back to all.
 */
async function selectRelevantTables(
  config: AzureConfig,
  dbType: DatabaseType,
  prompt: string,
  full: FullSchema,
): Promise<string[] | null> {
  try {
    const system = [
      "You select which database tables are needed to answer a data question.",
      "You are given a catalog of tables and their column names.",
      'Respond ONLY with JSON: {"tables": ["exact_table_name", ...]}.',
      "Include every table required, including any needed only for joins.",
      "Prefer precision — usually 1 to 8 tables. Use names exactly as written in the catalog.",
      `Database type: ${dbType}.`,
    ].join("\n");
    const userMsg = `Catalog:\n${tableCatalog(full)}\n\nQuestion: ${prompt}`;

    const result = await azureChat(
      config,
      [
        { role: "system", content: system },
        { role: "user", content: userMsg },
      ],
      { maxTokens: 600, jsonMode: true, timeoutMs: 30000 },
    );

    const cleaned = result.content
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    const parsed = JSON.parse(cleaned);
    const raw = Array.isArray(parsed?.tables) ? parsed.tables : [];

    const byLower = new Map(
      full.tables.map((t) => [t.name.toLowerCase(), t.name]),
    );
    const out: string[] = [];
    for (const n of raw) {
      if (typeof n !== "string") continue;
      const hit = byLower.get(n.toLowerCase());
      if (hit && !out.includes(hit)) out.push(hit);
    }
    return out.length ? out : null;
  } catch (e) {
    console.error("Table selection pass failed:", e);
    return null;
  }
}

router.post("/generate-query", async (req: Request, res: Response) => {
  const {
    connectionId,
    prompt,
    currentQuery,
    refreshSchema,
    mode,
    schema: schemaOverride,
  } = req.body as {
    connectionId?: string;
    prompt?: string;
    currentQuery?: string;
    refreshSchema?: boolean;
    mode?: "read" | "write";
    schema?: string;
  };
  const writeMode = mode === "write";
  const user = req.user!;

  if (!prompt || !prompt.trim()) {
    res.status(400).json({ error: "A natural-language prompt is required" });
    return;
  }
  if (!connectionId) {
    res
      .status(400)
      .json({ error: "A connectionId is required for schema context" });
    return;
  }

  const conn = resolveReadableConnection(req, res, connectionId);
  if (!conn) return;

  // Records every AI interaction (request + response/error) for later prompt
  // tuning and optimization. Never throws — logging must not break generation.
  const record = (extra: Partial<Omit<AiChatLogEntry, "id" | "timestamp">>) => {
    try {
      logAiChat({
        userId: user.sub,
        userEmail: user.email,
        connectionId,
        dbType: conn.type,
        prompt: prompt.trim(),
        status: "error",
        ...extra,
      });
    } catch (e) {
      console.error("Failed to write ai_chat_log entry:", e);
    }
  };

  const { config, missing } = getAzureConfig();
  if (!config) {
    record({
      status: "error",
      errorMessage: `Azure OpenAI not configured. Missing: ${missing.join(", ")}`,
    });
    res.status(503).json({
      error: `Azure OpenAI is not configured. Missing: ${missing.join(", ")}`,
    });
    return;
  }

  // Introspect the full schema (cached, TTL-based; refreshSchema forces a fresh
  // pull), then send only the tables relevant to this request.
  let full;
  try {
    full = await getCachedFullSchema(conn, {
      forceRefresh: !!refreshSchema,
      schema: schemaOverride,
    });
  } catch (err: any) {
    record({
      status: "error",
      errorMessage: `Failed to introspect schema: ${err?.message || err}`,
    });
    res
      .status(502)
      .json({ error: `Failed to introspect schema: ${err?.message || err}` });
    return;
  }

  const allTableNames = full.schema.tables.map((t) => t.name);
  const knownLower = new Map(allTableNames.map((n) => [n.toLowerCase(), n]));

  // For large schemas, ask the model which tables are relevant so we can send
  // those in full detail instead of an arbitrary cap.
  let selectedTables: string[] | null = null;
  if (allTableNames.length > TABLE_SELECTION_THRESHOLD) {
    selectedTables = await selectRelevantTables(
      config,
      conn.type,
      prompt.trim(),
      full.schema,
    );
  }
  const selectionUsed = !!(selectedTables && selectedTables.length);

  // Few-shot examples from saved queries that touch the same tables (same
  // dialect only). Never blocks generation.
  let examples: { name: string; sql: string }[] = [];
  try {
    examples = selectExampleQueries(
      conn,
      prompt.trim(),
      allTableNames,
      getSavedQueries(user.sub),
    );
  } catch (e) {
    console.error("Failed to select example queries:", e);
  }

  // Final table set sent in full: the relevant selection plus any tables the
  // chosen examples reference (so example joins resolve), capped.
  let finalTables: string[] | undefined;
  if (selectionUsed && selectedTables) {
    const set = new Set(selectedTables);
    for (const ex of examples) {
      for (const t of extractReferencedTables(ex.sql, conn.type)) {
        const real = knownLower.get(t);
        if (real) set.add(real);
      }
    }
    finalTables = [...set].slice(0, MAX_PROMPT_TABLES);
  }

  const schema = summarizeTables(full.schema, finalTables);

  const systemPrompt = writeMode
    ? [
        "You are an expert database change author embedded in a data tool with a mandatory approval workflow.",
        "Given a database schema and a user's request in plain English, produce ONE write statement that accomplishes it.",
        writeDialectGuidance(conn.type),
        "Rules:",
        "- Exactly ONE statement, and it MUST be a single INSERT, UPDATE or DELETE. NEVER a bare SELECT, and NEVER DDL (DROP/ALTER/TRUNCATE/CREATE/GRANT/REVOKE) or stacked statements.",
        "- For UPDATE/DELETE, ALWAYS include a WHERE that scopes it to exactly the intended rows. NEVER a whole-table UPDATE/DELETE unless the user explicitly asks for it.",
        "- Only reference tables and columns that exist in the schema. Keep it minimal — SET only the columns the request mentions; do not restate unchanged columns.",
        "- Columns marked [PHI] contain protected health information; only write them when the request clearly requires it.",
        'Respond ONLY with a JSON object of the form {"query": "<the write statement>", "explanation": "<one short sentence>"}.',
        "Do not wrap the JSON in markdown fences.",
      ].join("\n")
    : [
        "You are an expert database query author embedded in a read-only data tool.",
        "Given a database schema and a user's request in plain English, produce ONE correct, efficient, read-only query.",
        dialectGuidance(conn.type),
        "Rules:",
        "- NEVER produce INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE, CREATE, GRANT, REVOKE, EXEC or any write/DDL statement.",
        "- Only reference tables and columns that exist in the provided schema.",
        "- Columns marked [PHI] contain protected health information; you may select them when asked, but never invent filters that expose them unnecessarily.",
        "- Favor concise, readable queries. Use `SELECT *` for a simple single-table lookup; only list explicit columns when the user asks for specific fields, or when joining/aggregating where specific columns are genuinely needed. NEVER enumerate every column just to avoid `*`.",
        "- Do not add filters, ordering, or limits the user did not ask for.",
        'Respond ONLY with a JSON object of the form {"query": "<the query>", "explanation": "<one short sentence>"}.',
        "Do not wrap the JSON in markdown fences.",
      ].join("\n");

  const exampleBlock = examples.length
    ? [
        "",
        "Example queries previously written and saved by users against these tables.",
        "Use them as a style/structure reference for naming, joins, and conventions — adapt, do not copy verbatim:",
        ...examples.map((e, i) => `-- Example ${i + 1}: ${e.name}\n${e.sql}`),
      ].join("\n")
    : "";

  const userParts = [
    `Database type: ${conn.type}`,
    conn.database ? `Database name: ${conn.database}` : "",
    "",
    "Schema:",
    schema.text || "(no tables found)",
    schema.truncated
      ? `\n(Note: schema truncated to ${schema.includedTables} of ${schema.totalTables} tables.)`
      : "",
    exampleBlock,
    "",
    currentQuery && currentQuery.trim()
      ? `The user is currently editing this query (use as context; refine it if relevant):\n${currentQuery.trim()}\n`
      : "",
    `User request: ${prompt.trim()}`,
  ].filter(Boolean);

  const userMessage = userParts.join("\n");
  const messages: AzureChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];

  // Context shared by every log entry below.
  const requestContext = {
    systemPrompt,
    userMessage,
    schemaTruncated: schema.truncated,
    tablesProvided: schema.includedTables,
    totalTables: schema.totalTables,
  };

  const startedAt = Date.now();
  try {
    const result = await azureChat(config, messages, {
      maxTokens: 4096,
      jsonMode: true,
      timeoutMs: 60000,
    });
    const latencyMs = Date.now() - startedAt;

    const { query, explanation } = parseGeneration(result.content);
    if (!query) {
      record({
        ...requestContext,
        status: "error",
        errorMessage: "Model did not return a usable query",
        responseRaw: result.content,
        model: result.model || config.model,
        latencyMs,
        promptTokens: result.usage?.promptTokens,
        completionTokens: result.usage?.completionTokens,
        totalTokens: result.usage?.totalTokens,
      });
      res.status(502).json({
        error:
          "The model did not return a usable query. Try rephrasing your request.",
      });
      return;
    }

    record({
      ...requestContext,
      status: "success",
      responseRaw: result.content,
      generatedQuery: query,
      explanation,
      model: result.model || config.model,
      latencyMs,
      promptTokens: result.usage?.promptTokens,
      completionTokens: result.usage?.completionTokens,
      totalTokens: result.usage?.totalTokens,
    });

    res.json({
      query,
      explanation,
      model: result.model || config.model,
      schemaTruncated: schema.truncated,
      tablesProvided: schema.includedTables,
      totalTables: schema.totalTables,
      schemaCached: full.cached,
      schemaCachedAt: full.cachedAt,
      examplesUsed: examples.length,
      relevantSelection: selectionUsed,
    });
  } catch (err: any) {
    record({
      ...requestContext,
      status: "error",
      errorMessage: err?.message || "Query generation failed",
      latencyMs: Date.now() - startedAt,
    });
    const status = err instanceof AzureOpenAIError && err.status ? 502 : 500;
    res
      .status(status)
      .json({ error: err?.message || "Query generation failed" });
  }
});

// ── Clear cached schema summaries (admin only) ──
router.post(
  "/schema-cache/clear",
  requireAdmin,
  (req: Request, res: Response) => {
    const connectionId = (req.body?.connectionId || req.query.connectionId) as
      | string
      | undefined;
    const result = clearSchemaCache(connectionId);
    res.json({ ...result, scope: connectionId || "all" });
  },
);

// ── Read the AI chat log (admin only) ──
router.get("/chat-log", requireAdmin, (req: Request, res: Response) => {
  const { limit, offset, from, to, status, userId } = req.query;
  const entries = getAiChatLog({
    limit: limit ? parseInt(limit as string, 10) : undefined,
    offset: offset ? parseInt(offset as string, 10) : undefined,
    from: from as string | undefined,
    to: to as string | undefined,
    status: status as string | undefined,
    userId: userId as string | undefined,
  });
  res.json(entries);
});

/** Robustly extracts {query, explanation} from the model's text output. */
function parseGeneration(content: string): {
  query: string;
  explanation: string;
} {
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    const obj = JSON.parse(cleaned);
    return {
      query: typeof obj.query === "string" ? obj.query.trim() : "",
      explanation:
        typeof obj.explanation === "string" ? obj.explanation.trim() : "",
    };
  } catch {
    // Fallback: maybe the model returned a bare query or a fenced code block.
    const fenceMatch = content.match(
      /```(?:sql|json|javascript)?\s*([\s\S]*?)```/i,
    );
    if (fenceMatch) return { query: fenceMatch[1].trim(), explanation: "" };
    return { query: cleaned, explanation: "" };
  }
}

export default router;
