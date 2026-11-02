import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";

/**
 * Schema browsing through the real router and the real read check
 * (resolveReadableConnection). Only the introspector, object and job services —
 * the parts that reach a target database — are faked. An unreachable database
 * must come back 503 CONNECTION_FAILED, anything else 500 with its message.
 */

const conns: Record<string, any> = {
  "qa-core": { id: "qa-core", name: "Core", type: "postgres", env: "QA" },
  "prod-core": { id: "prod-core", name: "Core", type: "postgres", env: "PROD" },
  "qa-ms": { id: "qa-ms", name: "Ops", type: "mssql", env: "QA" },
};
vi.mock("../config/connections.js", () => ({
  getConnection: (id: string) => conns[id],
  getEnvironments: () => ["QA", "PROD"],
}));
const logAudit = vi.fn();
vi.mock("../services/sqlite-store.js", () => ({
  logAudit,
  getDb: () => ({}),
  archiveIfDue: () => {},
}));
vi.mock("../config/settings.js", () => ({
  getConfig: () => undefined,
  jwtExpiresIn: () => "1h",
}));
const getCachedFullSchema = vi.fn();
const getSchemas = vi.fn();
const getTables = vi.fn();
const getColumns = vi.fn();
vi.mock("../services/schema-introspector.js", () => ({
  getCachedFullSchema,
  getSchemas,
  getTables,
  getColumns,
}));
const getObjects = vi.fn();
const getObjectDefinition = vi.fn();
const getObjectDependencies = vi.fn();
const getDrift = vi.fn();
vi.mock("../services/schema-objects.js", async (orig) => ({
  ...(await orig<typeof import("../services/schema-objects.js")>()),
  getObjects,
  getObjectDefinition,
  getObjectDependencies,
  getDrift,
}));
const getJobs = vi.fn();
const getJobDetail = vi.fn();
const getJobsCalling = vi.fn(async () => []);
vi.mock("../services/jobs.js", async (orig) => ({
  ...(await orig<typeof import("../services/jobs.js")>()),
  getJobs,
  getJobDetail,
  getJobsCalling,
}));

const { default: router } = await import("./schema.js");
const { JobAccessError } = await import("../services/jobs.js");

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use((req, _res, next) => {
    req.user = {
      sub: "u1",
      email: "u1@example.com",
      isAdmin: false,
      allowedEnvironments: ["QA"],
    } as any;
    next();
  });
  app.use("/schema", router);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/schema`;
});

afterAll(() => server.close());

async function get(path: string) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
}

const refused = () =>
  Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:5432"), {
    code: "ECONNREFUSED",
  });

describe("schema listings", () => {
  it("returns the cached full schema, scoped by ?schema when given", async () => {
    getCachedFullSchema.mockResolvedValue({ schema: { orders: ["id"] } });
    expect(await get("/qa-core/full")).toEqual({
      status: 200,
      body: { orders: ["id"] },
    });
    expect(getCachedFullSchema).toHaveBeenLastCalledWith(conns["qa-core"], {
      schema: undefined,
    });
    await get("/qa-core/full?schema=app_core");
    expect(getCachedFullSchema).toHaveBeenLastCalledWith(conns["qa-core"], {
      schema: "app_core",
    });
  });

  it("lists schemas, tables and columns", async () => {
    getSchemas.mockResolvedValue(["app_core"]);
    getTables.mockResolvedValue([{ name: "orders" }]);
    getColumns.mockResolvedValue([{ name: "id" }]);
    expect((await get("/qa-core/schemas")).body).toEqual(["app_core"]);
    expect((await get("/qa-core/tables")).body).toEqual([{ name: "orders" }]);
    expect(getTables).toHaveBeenLastCalledWith(conns["qa-core"], undefined);
    await get("/qa-core/tables?schema=app_core");
    expect(getTables).toHaveBeenLastCalledWith(conns["qa-core"], "app_core");
    expect((await get("/qa-core/tables/orders/columns")).body).toEqual([
      { name: "id" },
    ]);
    expect(getColumns).toHaveBeenLastCalledWith(
      conns["qa-core"],
      "orders",
      undefined,
    );
    await get("/qa-core/tables/orders/columns?schema=app_core");
    expect(getColumns).toHaveBeenLastCalledWith(
      conns["qa-core"],
      "orders",
      "app_core",
    );
  });

  it("refuses an environment the user cannot read, for every listing", async () => {
    for (const path of [
      "/prod-core/full",
      "/prod-core/schemas",
      "/prod-core/tables",
      "/prod-core/tables/orders/columns",
      "/prod-core/objects",
      "/prod-core/jobs",
      "/prod-core/jobs/1",
    ])
      expect((await get(path)).status).toBe(403);
    expect((await get("/nope/objects/view/v/definition")).status).toBe(404);
  });

  it("answers an unreachable database with 503 CONNECTION_FAILED", async () => {
    getCachedFullSchema.mockRejectedValueOnce(refused());
    getSchemas.mockRejectedValueOnce(refused());
    getTables.mockRejectedValueOnce(refused());
    getColumns.mockRejectedValueOnce(refused());
    for (const path of [
      "/qa-core/full",
      "/qa-core/schemas",
      "/qa-core/tables",
      "/qa-core/tables/orders/columns",
    ]) {
      const res = await get(path);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe("CONNECTION_FAILED");
      expect(res.body.error).toContain("Core (QA)");
    }
  });

  it("keeps any other failure a 500, with a fallback for an empty message", async () => {
    getSchemas.mockRejectedValueOnce(new Error('permission denied for "x"'));
    expect(await get("/qa-core/schemas")).toEqual({
      status: 500,
      body: { error: 'permission denied for "x"' },
    });
    getTables.mockRejectedValueOnce(new Error(""));
    expect((await get("/qa-core/tables")).body).toEqual({
      error: "Failed to fetch tables",
    });
    getColumns.mockRejectedValueOnce(new Error(""));
    expect((await get("/qa-core/tables/t/columns")).body).toEqual({
      error: "Failed to fetch columns",
    });
    getCachedFullSchema.mockRejectedValueOnce(new Error(""));
    expect((await get("/qa-core/full")).body).toEqual({
      error: "Failed to fetch schema",
    });
  });
});

describe("objects", () => {
  it("lists every kind unless one is asked for", async () => {
    getObjects.mockResolvedValue([
      { kind: "view", name: "v" },
      { kind: "function", name: "f" },
    ]);
    expect((await get("/qa-core/objects")).body).toHaveLength(2);
    expect(getObjects).toHaveBeenLastCalledWith(conns["qa-core"], undefined);
  });

  it("maps failures of the list, definition and dependencies", async () => {
    getObjects.mockRejectedValueOnce(new Error("boom"));
    expect(await get("/qa-core/objects")).toEqual({
      status: 500,
      body: { error: "boom" },
    });
    getObjectDefinition.mockRejectedValueOnce(refused());
    expect((await get("/qa-core/objects/view/v/definition")).status).toBe(503);
    getObjectDependencies.mockRejectedValueOnce(new Error(""));
    expect(await get("/qa-core/objects/view/v/dependencies")).toEqual({
      status: 500,
      body: { error: "Failed to fetch dependencies" },
    });
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("gives no migration form when the definition is hidden", async () => {
    getObjectDefinition.mockResolvedValueOnce({
      kind: "view",
      schema: "app_core",
      name: "v",
      definition: null,
    });
    const res = await get("/qa-core/objects/view/v/definition");
    expect(res.body.migration).toBeNull();
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "OBJECT_VIEW",
        sql: "view app_core.v",
      }),
    );
  });
});

describe("drift", () => {
  it("refuses an unreadable left side before the right", async () => {
    expect((await get("/prod-core/drift?against=qa-core")).status).toBe(403);
    expect(getDrift).not.toHaveBeenCalled();
  });

  it("maps a drift failure", async () => {
    getDrift.mockRejectedValueOnce(refused());
    const res = await get("/qa-core/drift?against=qa-core");
    expect(res.status).toBe(503);
    expect(getDrift).toHaveBeenCalledWith(
      conns["qa-core"],
      conns["qa-core"],
      undefined,
    );
  });
});

describe("jobs", () => {
  it("lists jobs and maps a failure", async () => {
    getJobs.mockResolvedValueOnce({ available: true, jobs: [] });
    expect((await get("/qa-core/jobs")).body).toEqual({
      available: true,
      jobs: [],
    });
    getJobs.mockRejectedValueOnce(refused());
    expect((await get("/qa-core/jobs")).status).toBe(503);
  });

  it("names the id format per engine", async () => {
    expect((await get("/qa-ms/jobs/7")).body).toEqual({
      error: "A SQL Server Agent job id is a GUID",
    });
    expect((await get("/qa-core/jobs/x")).body).toEqual({
      error: "A pg_cron job id is an integer",
    });
  });

  it("404s a missing job without auditing a read", async () => {
    logAudit.mockClear();
    getJobDetail.mockResolvedValueOnce(null);
    expect(await get("/qa-core/jobs/9")).toEqual({
      status: 404,
      body: { error: "No job 9 on this connection" },
    });
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("403s a missing grant and maps other failures", async () => {
    getJobDetail.mockRejectedValueOnce(
      new JobAccessError("needs SQLAgentReaderRole"),
    );
    expect(await get("/qa-core/jobs/9")).toEqual({
      status: 403,
      body: { error: "needs SQLAgentReaderRole" },
    });
    getJobDetail.mockRejectedValueOnce(new Error(""));
    expect(await get("/qa-core/jobs/9")).toEqual({
      status: 500,
      body: { error: "Failed to fetch job" },
    });
  });
});
