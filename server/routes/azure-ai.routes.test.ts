import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import express from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";

/**
 * The /azure-ai routes end to end on a bare Express app: Azure, the schema
 * introspector and the app store are mocked, so every branch of the
 * connection test, query generation (including the large-schema table
 * selection pass), the cache clear and the chat log can be driven directly.
 */

const CONFIG = {
  endpoint: "https://ai.example.com",
  apiKey: "k",
  deployment: "gen",
  model: "cfg-model",
  apiVersion: "v",
};

const h = vi.hoisted(() => ({
  conn: {
    id: "pg",
    name: "Local",
    env: "DEV",
    type: "postgres",
    database: "app_core",
  } as Record<string, unknown> | null,
  isAdmin: true,
  config: null as unknown,
  missing: [] as string[],
  azureChat: vi.fn(),
  logAiChat: vi.fn(),
  setSetting: vi.fn(),
  getAiChatLog: vi.fn(() => [{ id: "c1" }]),
  getSavedQueries: vi.fn((): unknown[] => []),
  selectExampleQueries: vi.fn((): { name: string; sql: string }[] => []),
  clearSchemaCache: vi.fn(() => ({ cleared: 3 })),
  tables: ["orders"] as string[],
  schemaError: null as unknown,
}));

vi.mock("../services/sqlite-store.js", async (orig) => ({
  ...(await orig<object>()),
  getSavedQueries: h.getSavedQueries,
  logAiChat: h.logAiChat,
  getAiChatLog: h.getAiChatLog,
  setSetting: h.setSetting,
  getAiColumnValuesEnabled: () => true,
}));
vi.mock("../services/query-examples.js", async (orig) => ({
  ...(await orig<object>()),
  selectExampleQueries: h.selectExampleQueries,
}));
vi.mock("../services/schema-introspector.js", async (orig) => ({
  ...(await orig<object>()),
  clearSchemaCache: h.clearSchemaCache,
  getCachedFullSchema: async () => {
    if (h.schemaError) throw h.schemaError;
    return {
      schema: {
        tables: h.tables.map((name) => ({ name, type: "TABLE" })),
        columns: Object.fromEntries(
          h.tables.map((n) => [n, [{ name: "id", type: "int" }]]),
        ),
      },
      cached: false,
      cachedAt: "2026-01-01T00:00:00Z",
      ttlHours: 24,
    };
  },
}));
vi.mock("../services/azure-openai.js", async (orig) => ({
  ...(await orig<object>()),
  getAzureConfig: () => ({ config: h.config, missing: h.missing }),
  azureChat: h.azureChat,
}));
vi.mock("../middleware/auth.js", async (orig) => ({
  ...(await orig<object>()),
  resolveReadableConnection: (_req: unknown, res: any) => {
    if (!h.conn) res.status(403).json({ error: "no read" });
    return h.conn;
  },
}));

const { buildGeneratePrompt } = await import("./azure-ai.js");

let server: Server;
let base = "";

beforeAll(async () => {
  const ai = (await import("./azure-ai.js")).default;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      sub: "u1",
      email: "dev@example.com",
      isAdmin: h.isAdmin,
    } as never;
    next();
  });
  app.use("/ai", ai);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
beforeEach(() => {
  vi.clearAllMocks();
  h.isAdmin = true;
  h.config = CONFIG;
  h.missing = [];
  h.tables = ["orders"];
  h.schemaError = null;
  h.conn = {
    id: "pg",
    name: "Local",
    env: "DEV",
    type: "postgres",
    database: "app_core",
  };
  h.getSavedQueries.mockImplementation(() => []);
  h.selectExampleQueries.mockImplementation(() => []);
  h.logAiChat.mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as any };
};
const generate = (body: Record<string, unknown> = {}) =>
  call("POST", "/ai/generate-query", {
    connectionId: "pg",
    prompt: "  list orders  ",
    ...body,
  });
const reply = (query: string, extra: Record<string, unknown> = {}) => ({
  content: JSON.stringify({ query, explanation: "why" }),
  ...extra,
});

describe("POST /ai/test", () => {
  it("is admin only", async () => {
    h.isAdmin = false;
    expect((await call("POST", "/ai/test")).status).toBe(403);
    expect(h.azureChat).not.toHaveBeenCalled();
  });

  it("names the missing settings when unconfigured", async () => {
    h.config = null;
    h.missing = ["AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_KEY"];
    const r = await call("POST", "/ai/test");
    expect(r).toEqual({
      status: 400,
      body: {
        success: false,
        message:
          "Missing environment variable(s): AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_KEY",
      },
    });
  });

  it("reports the model the provider answered with", async () => {
    h.azureChat.mockResolvedValue({ content: "pong", model: "gpt-x" });
    const r = await call("POST", "/ai/test");
    expect(r.body).toEqual({
      success: true,
      message: "Successfully connected to Azure OpenAI",
      endpoint: CONFIG.endpoint,
      deployment: CONFIG.deployment,
      model: "gpt-x",
    });
    expect(h.azureChat.mock.calls[0][1]).toEqual([
      { role: "user", content: "ping" },
    ]);
  });

  it("falls back to the configured model", async () => {
    h.azureChat.mockResolvedValue({ content: "pong" });
    expect((await call("POST", "/ai/test")).body.model).toBe("cfg-model");
  });

  it("answers 200 with success:false and the error when the call fails", async () => {
    h.azureChat.mockRejectedValueOnce(new Error("401 bad key"));
    let r = await call("POST", "/ai/test");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: false, message: "401 bad key" });
    h.azureChat.mockRejectedValueOnce({});
    r = await call("POST", "/ai/test");
    expect(r.body.message).toBe("Failed to reach Azure OpenAI endpoint");
  });
});

describe("POST /ai/generate-query — input and config", () => {
  it("requires a prompt", async () => {
    for (const prompt of [undefined, "   "]) {
      const r = await generate({ prompt });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/prompt is required/);
    }
  });

  it("requires a connectionId", async () => {
    const r = await generate({ connectionId: undefined });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/connectionId is required/);
  });

  it("stops when the connection is not readable", async () => {
    h.conn = null;
    expect((await generate()).status).toBe(403);
    expect(h.logAiChat).not.toHaveBeenCalled();
  });

  it("is 503 and logged when Azure is unconfigured", async () => {
    h.config = null;
    h.missing = ["AZURE_OPENAI_KEY"];
    const r = await generate();
    expect(r).toEqual({
      status: 503,
      body: {
        error: "Azure OpenAI is not configured. Missing: AZURE_OPENAI_KEY",
      },
    });
    expect(h.logAiChat.mock.calls[0][0]).toMatchObject({
      status: "error",
      prompt: "list orders",
      connectionId: "pg",
      errorMessage: "Azure OpenAI not configured. Missing: AZURE_OPENAI_KEY",
    });
  });

  it("is 503 CONNECTION_FAILED when the database is unreachable", async () => {
    h.schemaError = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    const r = await generate();
    expect(r.status).toBe(503);
    expect(r.body.code).toBe("CONNECTION_FAILED");
    expect(h.azureChat).not.toHaveBeenCalled();
  });

  it("reports a non-Error introspection failure verbatim", async () => {
    h.schemaError = "socket hang-up";
    const r = await generate();
    expect(r).toEqual({
      status: 500,
      body: { error: "Failed to introspect schema: socket hang-up" },
    });
  });

  it("keeps generating when the chat log cannot be written", async () => {
    h.logAiChat.mockImplementation(() => {
      throw new Error("disk full");
    });
    h.azureChat.mockResolvedValue(reply("SELECT * FROM orders"));
    const r = await generate();
    expect(r.status).toBe(200);
    expect(r.body.query).toBe("SELECT * FROM orders");
    expect(console.error).toHaveBeenCalledWith(
      "Failed to write ai_chat_log entry:",
      expect.any(Error),
    );
  });
});

describe("POST /ai/generate-query — success", () => {
  it("returns the query and logs the full exchange", async () => {
    h.azureChat.mockResolvedValue(
      reply("SELECT * FROM orders", {
        model: "gpt-x",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      }),
    );
    const r = await generate({ currentQuery: "SELECT 1", refreshSchema: true });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      query: "SELECT * FROM orders",
      explanation: "why",
      model: "gpt-x",
      schemaTruncated: false,
      tablesProvided: 1,
      totalTables: 1,
      schemaCached: false,
      schemaCachedAt: "2026-01-01T00:00:00Z",
      examplesUsed: 0,
      relevantSelection: false,
    });
    // Small schema: one call, no table-selection pass.
    expect(h.azureChat).toHaveBeenCalledTimes(1);
    const [, messages, opts] = h.azureChat.mock.calls[0];
    expect(opts).toMatchObject({ jsonMode: true, maxTokens: 4096 });
    expect(messages[1].content).toContain("<current_query>\nSELECT 1");
    expect(h.logAiChat.mock.calls[0][0]).toMatchObject({
      status: "success",
      generatedQuery: "SELECT * FROM orders",
      model: "gpt-x",
      totalTokens: 15,
    });
  });

  it("uses write guidance in write mode and the configured model as fallback", async () => {
    h.azureChat.mockResolvedValue(
      reply("UPDATE orders SET status = 'x' WHERE id = 1"),
    );
    const r = await generate({ mode: "write" });
    expect(r.body.model).toBe("cfg-model");
    expect(h.azureChat.mock.calls[0][1][0].content).toContain(
      "Produce a single INSERT/UPDATE/DELETE with standard PostgreSQL syntax.",
    );
  });

  it("logs a usable-query miss with the configured model", async () => {
    h.azureChat.mockResolvedValue({
      content: "{}",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
    expect((await generate()).status).toBe(422);
    expect(h.logAiChat.mock.calls[0][0]).toMatchObject({
      status: "error",
      model: "cfg-model",
      totalTokens: 2,
      errorMessage: "Model did not return a usable query",
    });
  });

  it("falls back to a generic message for an error without one", async () => {
    h.azureChat.mockRejectedValue({});
    const r = await generate();
    expect(r).toEqual({
      status: 500,
      body: { error: "Query generation failed" },
    });
    expect(h.logAiChat.mock.calls[0][0].errorMessage).toBe(
      "Query generation failed",
    );
  });

  it("answers a content-filter refusal with 422 and tags the log", async () => {
    const { AzureOpenAIError } = await import("../services/azure-openai.js");
    h.azureChat.mockRejectedValue(new AzureOpenAIError("filtered", 400, true));
    expect((await generate()).status).toBe(422);
    expect(h.logAiChat.mock.calls[0][0].errorMessage).toBe(
      "Content filter: filtered",
    );
  });

  it("generates without examples when they cannot be loaded", async () => {
    h.getSavedQueries.mockImplementation(() => {
      throw new Error("db locked");
    });
    h.azureChat.mockResolvedValue(reply("SELECT * FROM orders"));
    const r = await generate();
    expect(r.status).toBe(200);
    expect(r.body.examplesUsed).toBe(0);
    expect(console.error).toHaveBeenCalledWith(
      "Failed to select example queries:",
      expect.any(Error),
    );
  });
});

describe("POST /ai/generate-query — large schemas", () => {
  const many = () => {
    h.tables = [
      "Orders",
      "customers",
      "invoices",
      ...Array.from({ length: 27 }, (_, i) => `t${i}`),
    ];
  };

  it("sends only the tables the selection pass picked, plus example tables", async () => {
    many();
    h.selectExampleQueries.mockImplementation(() => [
      {
        name: "Order invoices",
        sql: "SELECT * FROM orders o JOIN invoices i ON i.id = o.id JOIN ghost g ON 1=1",
      },
    ]);
    h.azureChat
      .mockResolvedValueOnce({
        content:
          '```json\n{"tables": ["orders", "ORDERS", "missing", 7, "customers"]}\n```',
      })
      .mockResolvedValueOnce(reply("SELECT * FROM orders"));
    const r = await generate();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      relevantSelection: true,
      examplesUsed: 1,
      tablesProvided: 3,
      totalTables: 30,
    });
    // The selection pass is the first call and sees the whole catalog.
    expect(h.azureChat.mock.calls[0][2]).toMatchObject({ maxTokens: 600 });
    expect(h.azureChat.mock.calls[0][1][1].content).toContain("t26");
    const schemaSent = h.azureChat.mock.calls[1][1][1].content as string;
    for (const t of ["Orders", "customers", "invoices"])
      expect(schemaSent).toContain(t);
    expect(schemaSent).not.toContain("t26");
  });

  it("falls back to the whole schema when the selection pass fails", async () => {
    many();
    h.azureChat
      .mockResolvedValueOnce({ content: "not json" })
      .mockResolvedValueOnce(reply("SELECT * FROM orders"));
    const r = await generate();
    expect(r.body.relevantSelection).toBe(false);
    expect(console.error).toHaveBeenCalledWith(
      "Table selection pass failed:",
      expect.any(SyntaxError),
    );
  });

  it("falls back when the selection names no known table", async () => {
    many();
    h.azureChat
      .mockResolvedValueOnce({ content: '{"tables": "orders"}' })
      .mockResolvedValueOnce(reply("SELECT * FROM orders"));
    expect((await generate()).body.relevantSelection).toBe(false);
  });
});

describe("buildGeneratePrompt dialects", () => {
  const prompt = (mode: "read" | "write", dbType: string) =>
    buildGeneratePrompt({
      mode,
      dbType: dbType as never,
      schemaText: "",
      examples: [],
      request: "x",
    }).systemPrompt;

  it.each([
    ["mssql", "Microsoft SQL Server (T-SQL). Generate a single read-only"],
    ["mongodb", "Target: MongoDB. Generate a single read-only shell"],
    ["elasticsearch", "Target: Elasticsearch. Generate a single read-only"],
    ["oracle", "Generate a single read-only query."],
  ])("read guidance for %s", (type, text) => {
    expect(prompt("read", type)).toContain(text);
  });

  it.each([
    ["mssql", "Microsoft SQL Server (T-SQL). Produce a single INSERT"],
    ["mongodb", "Target: MongoDB. Produce a single write shell"],
    ["elasticsearch", "_update_by_query"],
    ["oracle", "Produce a single write statement."],
  ])("write guidance for %s", (type, text) => {
    expect(prompt("write", type)).toContain(text);
  });
});

describe("admin maintenance routes", () => {
  it("GET /settings reports the column-values switch", async () => {
    expect(await call("GET", "/ai/settings")).toEqual({
      status: 200,
      body: { columnValues: true },
    });
  });

  it("PUT /settings stores the switch and clears cached schemas", async () => {
    const r = await call("PUT", "/ai/settings", { columnValues: true });
    expect(r).toEqual({ status: 200, body: { columnValues: true } });
    expect(h.setSetting).toHaveBeenCalledWith(
      "ai_column_values_enabled",
      "true",
    );
    expect(h.clearSchemaCache).toHaveBeenCalledWith();
  });

  it("PUT /settings refuses a request with no body at all", async () => {
    // Mounted without a body parser, req.body is undefined rather than {}.
    const ai = (await import("./azure-ai.js")).default;
    const bare = express();
    bare.use((req, _res, next) => {
      req.user = { sub: "u1", isAdmin: true } as never;
      next();
    });
    bare.use("/ai", ai);
    const s = bare.listen(0);
    await new Promise((r) => s.once("listening", r));
    try {
      const port = (s.address() as AddressInfo).port;
      const r = await fetch(`http://127.0.0.1:${port}/ai/settings`, {
        method: "PUT",
      });
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({
        error: "columnValues must be a boolean",
      });
      expect(h.clearSchemaCache).not.toHaveBeenCalled();
    } finally {
      s.close();
    }
  });

  it("clears one connection's cache from the body or query, else all", async () => {
    let r = await call("POST", "/ai/schema-cache/clear", {
      connectionId: "pg",
    });
    expect(r.body).toEqual({ cleared: 3, scope: "pg" });
    expect(h.clearSchemaCache).toHaveBeenLastCalledWith("pg");
    r = await call("POST", "/ai/schema-cache/clear?connectionId=qa", {});
    expect(r.body.scope).toBe("qa");
    expect(h.clearSchemaCache).toHaveBeenLastCalledWith("qa");
    r = await call("POST", "/ai/schema-cache/clear");
    expect(r.body.scope).toBe("all");
    expect(h.clearSchemaCache).toHaveBeenLastCalledWith(undefined);
  });

  it("refuses non-admins", async () => {
    h.isAdmin = false;
    expect((await call("POST", "/ai/schema-cache/clear")).status).toBe(403);
    expect((await call("GET", "/ai/chat-log")).status).toBe(403);
    expect(h.clearSchemaCache).not.toHaveBeenCalled();
  });

  it("passes chat-log filters through, parsing paging as numbers", async () => {
    const r = await call(
      "GET",
      "/ai/chat-log?limit=5&offset=10&from=a&to=b&status=error&userId=u2",
    );
    expect(r.body).toEqual([{ id: "c1" }]);
    expect(h.getAiChatLog).toHaveBeenCalledWith({
      limit: 5,
      offset: 10,
      from: "a",
      to: "b",
      status: "error",
      userId: "u2",
    });
    await call("GET", "/ai/chat-log");
    expect(h.getAiChatLog).toHaveBeenLastCalledWith({
      limit: undefined,
      offset: undefined,
      from: undefined,
      to: undefined,
      status: undefined,
      userId: undefined,
    });
  });
});
