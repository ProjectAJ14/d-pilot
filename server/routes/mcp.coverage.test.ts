import {
  describe,
  it,
  expect,
  vi,
  afterEach,
  beforeAll,
  afterAll,
} from "vitest";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import mcpRouter, { createMcpServer, artifactUrl } from "./mcp.js";
import type { DPilotApiClient } from "../services/mcp-client.js";

/**
 * The tools' formatting edge cases (empty answers, optional fields, the job and
 * artifact tools) and the HTTP transport: Basic auth, the stateless POST, and
 * the 405s — with the D-Pilot API replaced by a fake.
 */

vi.spyOn(console, "log").mockImplementation(() => {});

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

/** A fake API whose GETs answer by path. */
const getting = (routes: Record<string, unknown>) =>
  vi.fn(async (path: string) => {
    if (!(path in routes)) throw new Error(`no route ${path}`);
    return routes[path];
  }) as any;

describe("list_connections", () => {
  it("filters by environment and says when nothing is left", async () => {
    const { client, call } = await connect({
      get: getting({
        "/connections": [
          { id: "qa-pg", env: "QA", type: "postgres", name: "QA core" },
        ],
      }),
    });
    expect((await call("list_connections", { env: "QA" })).text).toContain(
      "qa-pg",
    );
    expect((await call("list_connections", { env: "PROD" })).text).toBe(
      "No connections available in PROD for this account.",
    );
    await client.close();
    const empty = await connect({ get: getting({ "/connections": [] }) });
    expect((await empty.call("list_connections")).text).toBe(
      "No connections available for this account.",
    );
    await empty.client.close();
  });
});

describe("list_tables and list_objects", () => {
  it("says when there are no tables", async () => {
    const { client, call } = await connect({
      get: getting({
        "/schema/qa-pg/tables": [],
        "/schema/qa-pg/full": { tables: [], columns: {} },
      }),
    });
    expect((await call("list_tables", { connectionId: "qa-pg" })).text).toBe(
      "No tables.",
    );
    expect(
      (await call("list_tables", { connectionId: "qa-pg", withColumns: true }))
        .text,
    ).toBe("No tables.");
    await client.close();
  });

  it("labels objects without a schema, and triggers by their table", async () => {
    const { client, call } = await connect({
      get: getting({
        "/schema/qa-ms/objects": [
          { kind: "index", schema: "", name: "orders_idx" },
          {
            kind: "trigger",
            schema: "app_core",
            name: "orders_audit",
            parent: "orders",
          },
        ],
        "/schema/qa-ms/objects?kind=view": [],
      }),
    });
    expect((await call("list_objects", { connectionId: "qa-ms" })).text).toBe(
      "index: orders_idx\ntrigger: app_core.orders_audit on orders",
    );
    expect(
      (await call("list_objects", { connectionId: "qa-ms", kind: "view" }))
        .text,
    ).toBe("No objects.");
    await client.close();
  });
});

describe("get_object_definition and get_object_dependencies", () => {
  it("leaves out a migration form that is the definition itself", async () => {
    const { client, call } = await connect({
      get: getting({
        "/schema/qa-pg/objects/view/v/definition": {
          kind: "view",
          schema: "app_core",
          name: "v",
          definition: "CREATE OR REPLACE VIEW v AS SELECT 1",
          migration: "CREATE OR REPLACE VIEW v AS SELECT 1",
        },
        "/schema/qa-pg/objects/view/w/definition": {
          kind: "view",
          schema: "app_core",
          name: "w",
          definition: "CREATE VIEW w AS SELECT 1",
          migration: "CREATE OR REPLACE VIEW w AS SELECT 1",
        },
      }),
    });
    const same = await call("get_object_definition", {
      connectionId: "qa-pg",
      kind: "view",
      name: "v",
    });
    expect(same.text).toBe(
      "view app_core.v\n\nCREATE OR REPLACE VIEW v AS SELECT 1",
    );
    const other = await call("get_object_definition", {
      connectionId: "qa-pg",
      kind: "view",
      name: "w",
    });
    expect(other.text).toContain(
      "-- As a re-runnable script (start a create_write_request `object` change from this):\nCREATE OR REPLACE VIEW w AS SELECT 1",
    );
    await client.close();
  });

  it("says when nothing was found either way", async () => {
    const { client, call } = await connect({
      get: getting({
        "/schema/qa-pg/objects/view/v/dependencies": {
          uses: [],
          usedBy: [],
        },
      }),
    });
    expect(
      (
        await call("get_object_dependencies", {
          connectionId: "qa-pg",
          kind: "view",
          name: "v",
        })
      ).text,
    ).toBe("uses: nothing found\nused by: nothing found");
    await client.close();
  });
});

describe("jobs", () => {
  it("explains a connection without a scheduler, or without jobs", async () => {
    const { client, call } = await connect({
      get: getting({
        "/schema/a/jobs": { available: false },
        "/schema/b/jobs": { available: false, reason: "Grant SQLAgentReader" },
        "/schema/c/jobs": { available: true, jobs: [] },
        "/schema/d/jobs": {
          available: true,
          jobs: [
            {
              id: "1",
              name: "nightly",
              enabled: false,
            },
            {
              id: "2",
              name: "hourly",
              enabled: true,
              schedule: "every hour",
              lastRun: {
                status: "Succeeded",
                startedAt: "2026-01-01T00:00:00Z",
              },
              nextRunAt: "2026-01-01T01:00:00Z",
            },
          ],
        },
      }),
    });
    expect((await call("list_jobs", { connectionId: "a" })).text).toBe(
      "This connection has no job scheduler (pg_cron is not installed).",
    );
    expect((await call("list_jobs", { connectionId: "b" })).text).toBe(
      "Grant SQLAgentReader",
    );
    expect((await call("list_jobs", { connectionId: "c" })).text).toBe(
      "No jobs run against this database.",
    );
    expect((await call("list_jobs", { connectionId: "d" })).text).toBe(
      [
        "- nightly [id 1] DISABLED · no schedule · last: never run",
        "- hourly [id 2] enabled · every hour · last: Succeeded at 2026-01-01T00:00:00Z · next 2026-01-01T01:00:00Z",
      ].join("\n"),
    );
    await client.close();
  });

  it("reads a job with sparse fields", async () => {
    const { client, call } = await connect({
      get: getting({
        "/schema/qa/jobs/5": {
          id: "5",
          name: "cleanup",
          engine: "pg_cron",
          enabled: false,
          steps: [
            { id: 1, name: "vacuum", subsystem: "SQL", command: "VACUUM" },
          ],
          schedules: [{ description: "daily at 02:00", enabled: false }],
          history: [{ status: "Failed" }],
        },
        "/schema/qa/jobs/6": {
          id: "6",
          name: "nightly",
          engine: "agent",
          enabled: true,
          description: "Recalculates totals",
          nextRunAt: "2026-01-02T02:00:00Z",
          steps: [],
          schedules: [],
          history: [],
        },
      }),
    });
    expect((await call("get_job", { connectionId: "qa", jobId: "5" })).text)
      .toBe(`cleanup [pg_cron, id 5] DISABLED

last run: never run

steps:
1. vacuum (SQL) — last: never run
VACUUM

schedules:
- daily at 02:00 (disabled)

recent runs:
- Failed`);
    expect(
      (await call("get_job", { connectionId: "qa", jobId: "6" })).text,
    ).toContain("last run: never run; next 2026-01-02T02:00:00Z");
    await client.close();
  });
});

describe("run_query limits", () => {
  it("names the server default when no limit was asked for", async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => ({ id: i }));
    const post = vi.fn(async () => ({
      executionTimeMs: 1,
      columns: [{ name: "id" }],
      rows,
      truncated: true,
    }));
    const { client, call } = await connect({ post: post as any });
    const { text } = await call("run_query", {
      connectionId: "qa-pg",
      sql: "SELECT id FROM orders",
    });
    expect(text.split("\n")[0]).toMatch(
      /more rows exist — stopped at the \d+-row limit \(this server's default\)/,
    );
    await client.close();
  });
});

describe("run_query and MAX_ROWS", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("says the server's own cap applied when a truncated result reached it", async () => {
    vi.stubEnv("MAX_ROWS", "2");
    const post = vi.fn(async () => ({
      executionTimeMs: 1,
      columns: [{ name: "id" }],
      rows: [{ id: 1 }, { id: 2 }],
      truncated: true,
    }));
    const { client, call } = await connect({ post: post as any });
    const { text } = await call("run_query", {
      connectionId: "qa-pg",
      sql: "SELECT id FROM orders",
      limit: 5,
    });
    expect(text.split("\n")[0]).toContain(
      "the server's own MAX_ROWS cap also applied",
    );
    await client.close();
  });
});

describe("write-request tools", () => {
  it("reads a request, and edits only a draft", async () => {
    const get = getting({ "/write-requests/w%201": { id: "w 1" } });
    const post = vi.fn(async () => ({
      id: "w1",
      status: "DRAFT",
      env: "QA",
    }));
    const { client, call } = await connect({ get, post: post as any });
    expect((await call("get_write_request", { id: "w 1" })).text).toBe(
      '{"id":"w 1"}',
    );
    const res = JSON.parse(
      (await call("update_write_request", { id: "w1", title: "Better" })).text,
    );
    expect(res).toMatchObject({
      id: "w1",
      status: "DRAFT",
      url: "/write-requests/w1",
    });
    expect(post).toHaveBeenCalledWith("/write-requests/w1/revise", {
      title: "Better",
      draft: true,
    });
    await client.close();
  });
});

describe("artifact tools", () => {
  const artifact = {
    id: "a1",
    title: "Order totals",
    description: "Why totals drift",
    createdByEmail: "dev@example.com",
    blocks: [{ type: "text", body: "x" }],
    updatedAt: "2026-01-01",
  };

  it("creates, updates, reads, lists and archives", async () => {
    const post = vi.fn(async () => artifact);
    const put = vi.fn(async (_p: string, body: any) => ({
      ...artifact,
      ...body,
    }));
    const get = getting({
      "/artifacts/a1": artifact,
      "/artifacts": [
        artifact,
        { ...artifact, id: "a2", title: "Other", description: undefined },
      ],
    });
    const { client, call } = await connect({
      post: post as any,
      put: put as any,
      get,
    });

    const created = JSON.parse(
      (
        await call("create_artifact", {
          title: "Order totals",
          blocks: [{ type: "text", body: "x" }],
        })
      ).text,
    );
    expect(created).toEqual({
      id: "a1",
      url: artifactUrl("a1"),
      title: "Order totals",
      blocks: 1,
    });

    const updated = JSON.parse(
      (await call("update_artifact", { id: "a1", title: "Renamed" })).text,
    );
    expect(updated).toMatchObject({
      title: "Renamed",
      updatedAt: "2026-01-01",
    });
    expect(put).toHaveBeenLastCalledWith("/artifacts/a1", { title: "Renamed" });

    expect(JSON.parse((await call("get_artifact", { id: "a1" })).text).id).toBe(
      "a1",
    );

    const all = JSON.parse((await call("list_artifacts")).text);
    expect(all.map((a: any) => a.id)).toEqual(["a1", "a2"]);
    const drift = JSON.parse(
      (await call("list_artifacts", { search: "DRIFT" })).text,
    );
    expect(drift).toEqual([
      {
        id: "a1",
        url: artifactUrl("a1"),
        title: "Order totals",
        description: "Why totals drift",
        author: "dev@example.com",
        blocks: 1,
        updatedAt: "2026-01-01",
      },
    ]);
    expect((await call("list_artifacts", { search: "nope" })).text).toBe(
      'No artifacts match "nope".',
    );

    expect((await call("archive_artifact", { id: "a1" })).text).toBe(
      `Archived "Order totals" — ${artifactUrl("a1")}`,
    );
    expect(put).toHaveBeenLastCalledWith("/artifacts/a1", { archived: true });
    expect(
      (await call("archive_artifact", { id: "a1", archived: false })).text,
    ).toBe(`Restored "Order totals" — ${artifactUrl("a1")}`);
    await client.close();
  });

  it("says when there are no artifacts yet", async () => {
    const { client, call } = await connect({
      get: getting({ "/artifacts": [] }),
    });
    expect((await call("list_artifacts")).text).toBe("No artifacts yet.");
    await client.close();
  });
});

describe("HTTP transport", () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use("/mcp", mcpRouter);
    server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  });
  afterAll(() => server.close());
  afterEach(() => vi.restoreAllMocks());

  const basic = (raw: string) =>
    `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
  const initialize = (authorization?: string) =>
    fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(authorization && { authorization }),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "0" },
        },
      }),
    });

  it("asks for Basic credentials", async () => {
    const res = await initialize();
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      'Basic realm="D-Pilot MCP"',
    );
  });

  it("serves an initialize without logging in, reusing a client per credential", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    for (const port of [undefined, "4999"]) {
      vi.stubEnv("PORT", port);
      const res = await initialize(basic("agent@example.com:pw"));
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('"serverInfo"');
    }
    vi.unstubAllEnvs();
    // Enough distinct credentials to wrap the bounded client cache.
    for (let i = 0; i < 51; i++) {
      expect((await initialize(basic(`agent${i}:pw`))).status).toBe(200);
    }
  });

  it("answers 500 when the transport throws before responding", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(
      StreamableHTTPServerTransport.prototype,
      "handleRequest",
    ).mockRejectedValueOnce(new Error("boom"));
    const res = await initialize(basic("agent:pw"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "MCP request failed" });
    expect(err).toHaveBeenCalled();
  });

  it("leaves a response already sent alone when the transport throws after", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(
      StreamableHTTPServerTransport.prototype,
      "handleRequest",
    ).mockImplementationOnce(async (_req: any, res: any) => {
      res.status(202).end();
      throw new Error("late");
    });
    expect((await initialize(basic("agent:pw"))).status).toBe(202);
  });

  it("refuses GET and DELETE", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = await fetch(url, { method });
      expect(res.status).toBe(405);
      expect(await res.json()).toEqual({
        error: "Method not allowed. Use POST.",
      });
    }
  });
});
