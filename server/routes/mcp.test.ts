import { describe, it, expect, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, parseBasicAuth } from "./mcp.js";
import type { DPilotApiClient } from "../services/mcp-client.js";

const basic = (raw: string) =>
  `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;

describe("parseBasicAuth", () => {
  it("reads a service account's credentials", () => {
    expect(parseBasicAuth(basic("agent@example.com:s3cret"))).toEqual({
      username: "agent@example.com",
      password: "s3cret",
    });
  });

  it("keeps colons in the password", () => {
    expect(parseBasicAuth(basic("agent:pa:ss:word"))).toEqual({
      username: "agent",
      password: "pa:ss:word",
    });
  });

  it("allows an empty password rather than silently trimming the pair", () => {
    expect(parseBasicAuth(basic("agent:"))).toEqual({
      username: "agent",
      password: "",
    });
  });

  it.each([
    ["no header", undefined],
    ["empty header", ""],
    ["a Bearer token", "Bearer some.jwt.value"],
    ["the wrong scheme", `Digest ${Buffer.from("a:b").toString("base64")}`],
    ["no separating colon", basic("agentexample")],
    ["an empty username", basic(":s3cret")],
    ["only a colon", basic(":")],
  ])("rejects %s", (_case, header) => {
    expect(parseBasicAuth(header)).toBeNull();
  });
});

/**
 * BASE_PATH and APP_BASE_URL are both read when their module is first imported,
 * so each case resets the module registry and imports mcp.ts fresh. That is the
 * only way to see what a *deployment* would produce rather than what this test
 * process happens to be configured for.
 */
async function linkFor(
  basePath: string | undefined,
  appBaseUrl: string | undefined,
) {
  vi.resetModules();
  vi.stubEnv("BASE_PATH", basePath);
  vi.stubEnv("APP_BASE_URL", appBaseUrl);
  const { appUrl, artifactUrl } = await import("./mcp.js");
  return { appUrl, artifactUrl };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("appUrl", () => {
  it("hands back a bare path when no origin is configured", async () => {
    const { appUrl } = await linkFor(undefined, undefined);
    expect(appUrl("/artifacts/42")).toBe("/artifacts/42");
  });

  it("uses the configured origin at a domain root", async () => {
    const { appUrl } = await linkFor(undefined, "https://d-pilot.internal");
    expect(appUrl("/artifacts/42")).toBe(
      "https://d-pilot.internal/artifacts/42",
    );
  });

  it("carries the sub-path in the bare-path fallback", async () => {
    const { appUrl } = await linkFor("/d-pilot", undefined);
    expect(appUrl("/artifacts/42")).toBe("/d-pilot/artifacts/42");
  });

  /**
   * The regression this matters for: APP_BASE_URL is documented as an origin, so
   * an operator sets it *and* BASE_PATH. Before the prefix was appended here the
   * link pointed at the domain root — whatever other app owns it — which is the
   * exact failure sub-path support exists to prevent, surviving in the one place
   * the URL gets pasted into a ticket.
   */
  it("appends the sub-path to a configured origin", async () => {
    const { appUrl } = await linkFor("/d-pilot", "https://intranet.example");
    expect(appUrl("/artifacts/42")).toBe(
      "https://intranet.example/d-pilot/artifacts/42",
    );
  });

  it("does not double a prefix the operator already spelled out", async () => {
    const { appUrl } = await linkFor(
      "/d-pilot",
      "https://intranet.example/d-pilot",
    );
    expect(appUrl("/artifacts/42")).toBe(
      "https://intranet.example/d-pilot/artifacts/42",
    );
  });

  it.each(["", "/"])(
    "treats an APP_BASE_URL of %o as unset rather than linking to the wrong origin",
    async (configured) => {
      const { appUrl } = await linkFor("/d-pilot", configured);
      expect(appUrl("/artifacts/42")).toBe("/d-pilot/artifacts/42");
    },
  );

  it("builds write-request links the same way", async () => {
    const { appUrl } = await linkFor("/d-pilot", "https://intranet.example");
    expect(appUrl("/write-requests/7")).toBe(
      "https://intranet.example/d-pilot/write-requests/7",
    );
  });

  it("artifactUrl is appUrl over the artifacts route", async () => {
    const { appUrl, artifactUrl } = await linkFor(
      "/d-pilot",
      "https://intranet.example",
    );
    expect(artifactUrl("42")).toBe(appUrl("/artifacts/42"));
  });
});

/**
 * Agents only learn to write rich artifacts from what `tools/list` hands them,
 * so both the tool that creates a page and the one that edits it must carry
 * the brief and the html/diagram vocabulary — an editor that never saw them
 * flattens a rich page back into markdown.
 */
describe("artifact tool descriptions", () => {
  it("teach html blocks, diagrams and the brief on create and update", async () => {
    // tools/list never touches the API, so the client is never called.
    const server = createMcpServer({} as DPilotApiClient);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const { tools } = await client.listTools();

    for (const name of ["create_artifact", "update_artifact"]) {
      const tool = tools.find((t) => t.name === name)!;
      const everything = JSON.stringify(tool);
      expect(tool.description).toContain("The short answer");
      expect(tool.description).toContain("inline-SVG diagram");
      expect(everything).toContain('{\\"type\\":\\"html\\"');
      expect(everything).toContain(".svg-box-spot");
      expect(everything).toContain("--spot");
    }
    const get = tools.find((t) => t.name === "get_artifact")!;
    expect(get.description).toContain("`html`");
    await client.close();
  });
});

/** An MCP client wired to a server whose API calls go to `api` instead of HTTP. */
async function connect(api: Partial<DPilotApiClient>) {
  const server = createMcpServer(api as DPilotApiClient);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    return { text: res.content[0].text, isError: !!res.isError };
  };
  return { client, call };
}

describe("tool call logging", () => {
  it("logs each call's size so output changes can be measured", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { client, call } = await connect({
      get: (async () => ({
        username: "agent",
        name: "Agent",
        isAdmin: false,
        allowedEnvironments: ["QA"],
      })) as any,
    });
    const { text } = await call("whoami");
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(
          `^\\[mcp\\] whoami ${text.length} chars \\(~\\d+ tokens\\) \\d+ms$`,
        ),
      ),
    );
    log.mockRestore();
    await client.close();
  });
});

describe("run_query output", () => {
  const execute = (result: Record<string, unknown>) => {
    const post = vi.fn(async () => ({
      executionTimeMs: 3,
      columns: [{ name: "id" }, { name: "status" }],
      ...result,
    }));
    return { post: post as any, calls: post.mock.calls as unknown[][] };
  };

  it("returns CSV under the status line, not pretty JSON", async () => {
    const api = execute({
      rows: [
        { id: 1, status: "shipped" },
        { id: 2, status: null },
      ],
      maskedFields: ["email"],
    });
    const { client, call } = await connect({ post: api.post });
    const { text } = await call("run_query", {
      connectionId: "qa-pg",
      sql: "SELECT id, status FROM orders",
    });
    expect(text).toBe(
      "2 row(s) in 3ms · PHI-tokenized columns: email\n\nid,status\n1,shipped\n2,",
    );
    await client.close();
  });

  it("still says when more rows exist, and asks for one extra to know", async () => {
    const api = execute({
      rows: [{ id: 1 }, { id: 2 }, { id: 3 }],
    });
    const { client, call } = await connect({ post: api.post });
    const { text } = await call("run_query", {
      connectionId: "qa-pg",
      sql: "SELECT id FROM orders",
      limit: 2,
    });
    expect(api.calls[0][1]).toMatchObject({ defaultLimit: 3 });
    expect(text).toMatch(
      /^2 row\(s\) in 3ms · more rows exist — stopped at the 2-row limit;/,
    );
    expect(text.split("\n\n")[1]).toBe("id,status\n1,\n2,");
    await client.close();
  });

  it("cuts long cells, says so, and lets the agent raise the cap", async () => {
    const api = execute({
      columns: [{ name: "payload" }],
      rows: [{ payload: "p".repeat(5000) }],
    });
    const { client, call } = await connect({ post: api.post });
    const capped = await call("run_query", {
      connectionId: "qa-pg",
      sql: "SELECT payload FROM t",
    });
    expect(capped.text).toContain("1 cell(s) cut to 300 chars");
    expect(capped.text).toContain("…[+4700 chars]");
    expect(capped.text.length).toBeLessThan(600);

    const whole = await call("run_query", {
      connectionId: "qa-pg",
      sql: "SELECT payload FROM t",
      maxCellChars: 10000,
    });
    expect(whole.text).toContain("p".repeat(5000));
    expect(whole.text).not.toContain("cut to");
    await client.close();
  });

  it("stops a result that would swamp the context, with advice", async () => {
    const api = execute({
      columns: [{ name: "id" }, { name: "pad" }],
      rows: Array.from({ length: 3000 }, (_, i) => ({
        id: i,
        pad: "x".repeat(200),
      })),
    });
    const { client, call } = await connect({ post: api.post });
    const { text } = await call("run_query", {
      connectionId: "qa-pg",
      sql: "SELECT * FROM big",
      limit: 3000,
    });
    expect(text.length).toBeLessThan(101_000);
    expect(text).toMatch(/3000 row\(s\) in 3ms · only the first \d+ are shown/);
    expect(text).toContain("aggregate in SQL");
    await client.close();
  });

  it("returns compact JSON when asked", async () => {
    const api = execute({ rows: [{ id: 1, status: "shipped" }] });
    const { client, call } = await connect({ post: api.post });
    const { text } = await call("run_query", {
      connectionId: "qa-pg",
      sql: "SELECT 1",
      format: "json",
    });
    expect(text.split("\n\n")[1]).toBe('[{"id":1,"status":"shipped"}]');
    await client.close();
  });
});

describe("schema and listing tools", () => {
  /** A fake API that answers GETs by path. */
  const answering = (routes: Record<string, unknown>) => {
    const get = vi.fn(async (path: string) => {
      if (!(path in routes)) throw new Error(`no route ${path}`);
      const value = routes[path];
      if (value instanceof Error) throw value;
      return value;
    });
    return { get: get as any, paths: () => get.mock.calls.map((c) => c[0]) };
  };

  const col = (name: string, over: Record<string, unknown> = {}) => ({
    name,
    dataType: "integer",
    nullable: true,
    isPrimaryKey: false,
    isForeignKey: false,
    defaultValue: null,
    isPhiField: false,
    ...over,
  });

  it("list_connections is one CSV line per connection", async () => {
    const api = answering({
      "/connections": [
        {
          id: "qa-pg",
          name: "Orders",
          env: "QA",
          type: "postgres",
          database: "app",
          schema: "app_core",
        },
        { id: "qa-mongo", name: "Docs, archived", env: "QA", type: "mongodb" },
        {
          id: "prod-pg",
          name: "Orders",
          env: "PROD",
          type: "postgres",
          database: "app",
          schema: "app_core",
        },
      ],
    });
    const { client, call } = await connect({ get: api.get });
    const { text } = await call("list_connections", { env: "QA" });
    expect(text).toBe(
      'id,env,type,database,defaultSchema,name\nqa-pg,QA,postgres,app,app_core,Orders\nqa-mongo,QA,mongodb,,,"Docs, archived"',
    );
    await client.close();
  });

  it("list_tables groups names under their schema", async () => {
    const api = answering({
      "/schema/qa-pg/tables": [
        { schema: "app_core", name: "orders", type: "TABLE" },
        { schema: "app_core", name: "order_totals", type: "VIEW" },
      ],
    });
    const { client, call } = await connect({ get: api.get });
    const { text } = await call("list_tables", { connectionId: "qa-pg" });
    expect(text).toBe("app_core (2): orders, order_totals (view)");
    await client.close();
  });

  it("list_tables withColumns reads the cached full schema once", async () => {
    const api = answering({
      "/schema/qa-pg/full?schema=app_core": {
        tables: [
          { name: "orders", type: "TABLE" },
          { name: "customers", type: "TABLE" },
        ],
        columns: {
          orders: [col("id"), col("customer_id")],
          customers: [col("id"), col("email")],
        },
      },
    });
    const { client, call } = await connect({ get: api.get });
    const { text } = await call("list_tables", {
      connectionId: "qa-pg",
      schema: "app_core",
      withColumns: true,
    });
    expect(text).toBe("orders: id, customer_id\ncustomers: id, email");
    expect(api.paths()).toEqual(["/schema/qa-pg/full?schema=app_core"]);
    await client.close();
  });

  it("describe_table writes schema text, not a JSON object per column", async () => {
    const api = answering({
      "/schema/qa-pg/tables/orders/columns": [
        col("id", {
          nullable: false,
          isPrimaryKey: true,
          defaultValue: "nextval('orders_id_seq')",
        }),
        col("customer_id", { isForeignKey: true, references: "customers.id" }),
        col("email", { dataType: "text", isPhiField: true }),
      ],
    });
    const { client, call } = await connect({ get: api.get });
    const { text } = await call("describe_table", {
      connectionId: "qa-pg",
      table: "orders",
    });
    expect(text).toBe(
      "orders\n  - id: integer [PK, NOT NULL]\n  - customer_id: integer [FK -> customers.id]\n  - email: text [PHI]",
    );
    await client.close();
  });

  it("describe_table covers several tables in one call, failures inline", async () => {
    const api = answering({
      "/schema/qa-pg/tables/orders/columns": [col("id")],
      "/schema/qa-pg/tables/customers/columns": [col("id")],
      "/schema/qa-pg/tables/nope/columns": [],
      "/schema/qa-pg/tables/locked/columns": new Error(
        "You do not have access",
      ),
    });
    const { client, call } = await connect({ get: api.get });
    const { text, isError } = await call("describe_table", {
      connectionId: "qa-pg",
      table: "orders",
      tables: ["orders", "customers", "nope", "locked"],
    });
    expect(isError).toBe(false);
    expect(text.split("\n\n")).toEqual([
      "orders\n  - id: integer",
      "customers\n  - id: integer",
      "nope\n  (no such table, or no columns)",
      "locked\n  Error: You do not have access",
    ]);
    await client.close();
  });

  it("describe_table shows every column, not the AI prompt's 80", async () => {
    const wide = Array.from({ length: 120 }, (_, i) => col(`c${i}`));
    const api = answering({ "/schema/qa-pg/tables/wide/columns": wide });
    const { client, call } = await connect({ get: api.get });
    const { text } = await call("describe_table", {
      connectionId: "qa-pg",
      table: "wide",
    });
    expect(text.split("\n")).toHaveLength(121);
    await client.close();
  });

  it("describe_table needs a table", async () => {
    const { client, call } = await connect({ get: vi.fn() as any });
    const res = await call("describe_table", { connectionId: "qa-pg" });
    expect(res).toEqual({
      text: "Error: Pass `table` or `tables`.",
      isError: true,
    });
    await client.close();
  });

  it("returns compact JSON elsewhere", async () => {
    const api = answering({
      "/auth/me": {
        username: "agent",
        name: "A",
        isAdmin: false,
        allowedEnvironments: ["QA"],
      },
    });
    const { client, call } = await connect({ get: api.get });
    const { text } = await call("whoami");
    expect(text).not.toContain("\n");
    expect(JSON.parse(text)).toMatchObject({
      username: "agent",
      readableEnvironments: ["QA"],
    });
    await client.close();
  });
});

describe("run_query across connections", () => {
  const perConnection = (results: Record<string, unknown>) => {
    const post = vi.fn(async (_path: string, body: any) => {
      const r = results[body.connectionId];
      if (r instanceof Error) throw r;
      return { executionTimeMs: 1, columns: [{ name: "n" }], ...(r as object) };
    });
    return {
      post: post as any,
      bodies: () => post.mock.calls.map((c) => c[1]),
    };
  };

  it("runs the same query on each, one labelled block per connection", async () => {
    const api = perConnection({
      "qa-pg": { rows: [{ n: 400 }] },
      "uat-pg": { rows: [{ n: 398 }] },
    });
    const { client, call } = await connect({ post: api.post });
    const { text, isError } = await call("run_query", {
      connectionIds: ["qa-pg", "uat-pg"],
      sql: "SELECT count(*) n FROM orders",
    });
    expect(isError).toBe(false);
    expect(text).toBe(
      "## qa-pg\n1 row(s) in 1ms\n\nn\n400\n\n## uat-pg\n1 row(s) in 1ms\n\nn\n398",
    );
    // One /query/execute each: capability checks, masking and audit per connection.
    expect(api.bodies().map((b: any) => b.connectionId)).toEqual([
      "qa-pg",
      "uat-pg",
    ]);
    await client.close();
  });

  it("reports a connection that fails without losing the others", async () => {
    const api = perConnection({
      "qa-pg": { rows: [{ n: 1 }] },
      "prod-pg": new Error("You do not have access to PROD environment"),
    });
    const { client, call } = await connect({ post: api.post });
    const { text, isError } = await call("run_query", {
      connectionId: "qa-pg",
      connectionIds: ["qa-pg", "prod-pg"],
      sql: "SELECT 1 n",
    });
    expect(isError).toBe(false);
    expect(api.bodies()).toHaveLength(2);
    expect(text).toContain(
      "## prod-pg\nError: You do not have access to PROD environment",
    );
    await client.close();
  });

  it("is an error when every connection fails", async () => {
    const api = perConnection({ a: new Error("down"), b: new Error("down") });
    const { client, call } = await connect({ post: api.post });
    const res = await call("run_query", {
      connectionIds: ["a", "b"],
      sql: "SELECT 1",
    });
    expect(res.isError).toBe(true);
    await client.close();
  });

  it("splits the result budget so a comparison stays one result's size", async () => {
    const rows = Array.from({ length: 2000 }, (_, i) => ({
      n: i,
      pad: "x".repeat(100),
    }));
    const api = perConnection({ a: { rows }, b: { rows }, c: { rows } });
    const { client, call } = await connect({ post: api.post });
    const { text } = await call("run_query", {
      connectionIds: ["a", "b", "c"],
      sql: "SELECT * FROM t",
      limit: 2000,
    });
    expect(text.length).toBeLessThan(102_000);
    expect(text.match(/only the first \d+ are shown/g)).toHaveLength(3);
    await client.close();
  });

  it("needs a connection", async () => {
    const { client, call } = await connect({ post: vi.fn() as any });
    expect(await call("run_query", { sql: "SELECT 1" })).toEqual({
      text: "Error: Pass `connectionId` or `connectionIds`.",
      isError: true,
    });
    await client.close();
  });
});
