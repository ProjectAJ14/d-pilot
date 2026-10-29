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
import { AzureOpenAIError } from "../services/azure-openai.js";

/**
 * The AI routes, the AI settings route and the PHI-rule deletes, mounted on a
 * bare Express app with the database, Azure and introspection mocked — enough
 * to check status codes, validation and side effects without a real stack.
 */

const h = vi.hoisted(() => ({
  conn: {
    id: "local-pg",
    name: "Local",
    env: "DEV",
    type: "postgres",
    database: "app_db",
    schema: "app_core",
  },
  isAdmin: true,
  azureChat: vi.fn(),
  setSetting: vi.fn(),
  logAiChat: vi.fn(),
  clearSchemaCache: vi.fn(() => ({ cleared: 0 })),
  schemaError: null as unknown,
}));

vi.mock("../config/connections.js", async (orig) => ({
  ...(await orig<object>()),
  getConnection: () => h.conn,
}));
vi.mock("../services/sqlite-store.js", async (orig) => ({
  ...(await orig<object>()),
  getPhiRules: () => [],
  getSavedQueries: () => [],
  logAiChat: h.logAiChat,
  setSetting: h.setSetting,
  getAiColumnValuesEnabled: () => true,
  getWriteRequest: () => ({
    id: "wr1",
    connectionId: "local-pg",
    env: "DEV",
    requestedBy: "u",
    selectSql: "SELECT * FROM orders WHERE id = 1",
    writeSql: "DELETE FROM orders WHERE id = 1",
  }),
  deletePhiRule: () => true,
  deleteAllPhiRules: () => ({ deleted: 2, kept: 0 }),
  logAudit: () => {},
}));
vi.mock("../services/schema-introspector.js", async (orig) => ({
  ...(await orig<object>()),
  clearSchemaCache: h.clearSchemaCache,
  getCachedFullSchema: async () => {
    if (h.schemaError) throw h.schemaError;
    return {
      schema: { tables: [{ name: "orders", type: "TABLE" }], columns: {} },
      cached: true,
      cachedAt: "x",
      ttlHours: 24,
    };
  },
}));
vi.mock("../services/azure-openai.js", async (orig) => ({
  ...(await orig<object>()),
  getAzureConfig: () => ({
    config: { endpoint: "e", apiKey: "k", deployment: "d", apiVersion: "v" },
    missing: [],
  }),
  azureChat: h.azureChat,
}));
vi.mock("../middleware/auth.js", async (orig) => ({
  ...(await orig<object>()),
  resolveReadableConnection: () => h.conn,
}));

let server: Server;
let base = "";

beforeAll(async () => {
  const ai = (await import("./azure-ai.js")).default;
  const wr = (await import("./write-requests.js")).default;
  const phi = (await import("./phi-config.js")).default;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      sub: "u",
      email: "admin@example.com",
      isAdmin: h.isAdmin,
      allowedEnvironments: [],
      unmaskEnvironments: [],
      writeEnvironments: [],
      approveEnvironments: [],
    } as never;
    next();
  });
  app.use("/ai", ai);
  app.use("/wr", wr);
  app.use("/phi", phi);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
beforeEach(() => {
  h.isAdmin = true;
  h.schemaError = null;
  vi.clearAllMocks();
});

const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

describe("PUT /azure-ai/settings", () => {
  it("rejects a non-boolean columnValues", async () => {
    for (const body of [{}, { columnValues: "false" }, { columnValues: 0 }]) {
      const r = await call("PUT", "/ai/settings", body);
      expect(r.status).toBe(400);
    }
    expect(h.setSetting).not.toHaveBeenCalled();
  });

  it("stores the setting and clears the schema cache", async () => {
    const r = await call("PUT", "/ai/settings", { columnValues: false });
    expect(r.status).toBe(200);
    expect(h.setSetting).toHaveBeenCalledWith(
      "ai_column_values_enabled",
      "false",
    );
    expect(h.clearSchemaCache).toHaveBeenCalled();
  });

  it("is admin only", async () => {
    h.isAdmin = false;
    expect(
      (await call("PUT", "/ai/settings", { columnValues: true })).status,
    ).toBe(403);
    expect((await call("GET", "/ai/settings")).status).toBe(403);
  });
});

describe("content-filter refusals", () => {
  const filtered = () =>
    h.azureChat.mockRejectedValue(
      new AzureOpenAIError(
        "Azure OpenAI returned 400: filtered by the content management policy",
        400,
        true,
      ),
    );
  const FRIENDLY =
    "The AI provider's content filter blocked this request. Try rephrasing it.";

  it("generate-query answers 422 and logs an identifiable error", async () => {
    filtered();
    const r = await call("POST", "/ai/generate-query", {
      connectionId: "local-pg",
      prompt: "list orders",
    });
    expect(r).toEqual({ status: 422, body: { error: FRIENDLY } });
    const logged = h.logAiChat.mock.calls.at(-1)?.[0];
    expect(logged.status).toBe("error");
    expect(logged.errorMessage).toMatch(/^Content filter: /);
  });

  it.each([
    [
      "/wr/ai-review",
      { connectionId: "local-pg", writeSql: "DELETE FROM orders WHERE id = 1" },
    ],
    [
      "/wr/suggest-write",
      { connectionId: "local-pg", selectSql: "SELECT * FROM orders" },
    ],
    [
      "/wr/suggest-select",
      { connectionId: "local-pg", writeSql: "DELETE FROM orders WHERE id = 1" },
    ],
    ["/wr/wr1/ai-review", {}],
  ])("%s answers 422", async (path, body) => {
    filtered();
    expect(await call("POST", path, body)).toEqual({
      status: 422,
      body: { error: FRIENDLY },
    });
  });

  // 502 is a proxy saying D-Pilot is down; the browser shows the
  // "can't reach the D-Pilot server" banner for it. D-Pilot never sends one.
  it("other Azure errors are a 500, not a 502", async () => {
    h.azureChat.mockRejectedValue(new AzureOpenAIError("boom", 500));
    const r = await call("POST", "/wr/suggest-write", {
      connectionId: "local-pg",
      selectSql: "SELECT * FROM orders",
    });
    expect(r).toEqual({ status: 500, body: { error: "boom" } });
  });
});

describe("generate-query failures D-Pilot reports itself", () => {
  const generate = () =>
    call("POST", "/ai/generate-query", {
      connectionId: "local-pg",
      prompt: "list orders",
    });

  it("an unreachable database during introspection is 503 CONNECTION_FAILED", async () => {
    h.schemaError = Object.assign(new Error("getaddrinfo ENOTFOUND db"), {
      code: "ENOTFOUND",
    });
    const r = await generate();
    expect(r.status).toBe(503);
    expect(r.body.code).toBe("CONNECTION_FAILED");
    expect(r.body.error).toContain("the Local (DEV) database");
    expect(h.logAiChat.mock.calls.at(-1)?.[0].status).toBe("error");
  });

  it("any other introspection failure is a 500", async () => {
    h.schemaError = new Error("permission denied for schema app_core");
    const r = await generate();
    expect(r).toEqual({
      status: 500,
      body: {
        error:
          "Failed to introspect schema: permission denied for schema app_core",
      },
    });
  });

  it("a reply with no usable query is a 422 asking to rephrase", async () => {
    h.azureChat.mockResolvedValue({ content: "{}" });
    const r = await generate();
    expect(r.status).toBe(422);
    expect(r.body.error).toMatch(/Try rephrasing/);
  });
});

describe("PHI rule deletes", () => {
  it("clear the schema cache (one rule)", async () => {
    expect((await call("DELETE", "/phi/r1")).status).toBe(200);
    expect(h.clearSchemaCache).toHaveBeenCalled();
  });

  it("clear the schema cache (all rules)", async () => {
    expect((await call("DELETE", "/phi")).status).toBe(200);
    expect(h.clearSchemaCache).toHaveBeenCalled();
  });
});
