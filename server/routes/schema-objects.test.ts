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
import type { AddressInfo } from "net";
import type { Server } from "http";

/**
 * The object routes go through the real resolveReadableConnection, so a user
 * without read rights on an environment is refused here exactly as for tables.
 * Only the database behind the introspector is faked.
 */

const conns: Record<string, any> = {
  "qa-core": { id: "qa-core", type: "postgres", env: "QA" },
  "prod-core": { id: "prod-core", type: "postgres", env: "PROD" },
  "qa-mongo": { id: "qa-mongo", type: "mongodb", env: "QA" },
  "qa-ms": { id: "qa-ms", type: "mssql", env: "QA" },
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
const getObjects = vi.fn();
const getObjectDefinition = vi.fn();
const getObjectDependencies = vi.fn(async () => ({
  uses: [],
  usedBy: [],
  bestEffort: false,
}));
const getDrift = vi.fn(async () => ({
  schema: "app_core",
  identical: 0,
  items: [],
}));
vi.mock("../services/schema-objects.js", async (orig) => ({
  ...(await orig<typeof import("../services/schema-objects.js")>()),
  getObjects,
  getObjectDefinition,
  getObjectDependencies,
  getDrift,
}));
vi.mock("../services/schema-introspector.js", () => ({}));
const getJobDetail = vi.fn();
vi.mock("../services/jobs.js", async (orig) => ({
  ...(await orig<typeof import("../services/jobs.js")>()),
  getJobs: vi.fn(async () => ({ available: true, jobs: [] })),
  getJobDetail,
  getJobsCalling: vi.fn(async () => [{ id: "7", name: "recalc due dates" }]),
}));

const { default: router } = await import("./schema.js");
const { AmbiguousObjectError } = await import("../services/schema-objects.js");

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
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
beforeEach(() => {
  logAudit.mockClear();
  getObjects.mockReset();
  getObjectDefinition.mockReset();
});

const get = (path: string) => fetch(`${base}/schema${path}`);

describe("object routes", () => {
  it("403s on an environment the user cannot read, before touching the database", async () => {
    for (const path of [
      "/prod-core/objects",
      "/prod-core/objects/procedure/refresh_order_totals/definition",
    ]) {
      expect((await get(path)).status).toBe(403);
    }
    expect(getObjects).not.toHaveBeenCalled();
    expect(getObjectDefinition).not.toHaveBeenCalled();
  });

  it("filters the list by kind", async () => {
    getObjects.mockResolvedValue([
      { schema: "app_core", name: "open_orders", kind: "view" },
      { schema: "app_core", name: "refresh_order_totals", kind: "procedure" },
    ]);
    const res = await get("/qa-core/objects?schema=app_core&kind=view");
    expect(await res.json()).toEqual([
      { schema: "app_core", name: "open_orders", kind: "view" },
    ]);
    expect(getObjects).toHaveBeenCalledWith(conns["qa-core"], "app_core");
  });

  it("passes an empty args through (a zero-argument overload) and audits the read", async () => {
    getObjectDefinition.mockResolvedValue({
      schema: "app_core",
      name: "refresh_order_totals",
      kind: "function",
      args: "",
      definition: "CREATE FUNCTION …",
    });
    const res = await get(
      "/qa-core/objects/function/refresh_order_totals/definition?schema=app_core&args=",
    );
    expect(res.status).toBe(200);
    expect(getObjectDefinition).toHaveBeenCalledWith(conns["qa-core"], {
      kind: "function",
      name: "refresh_order_totals",
      schema: "app_core",
      args: "",
      parent: undefined,
    });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "OBJECT_VIEW",
        sql: "function app_core.refresh_order_totals()",
        connectionId: "qa-core",
      }),
    );
  });

  it("gives no migration form for a MongoDB definition", async () => {
    getObjectDefinition.mockResolvedValue({
      schema: "app_core",
      name: "order_summary",
      kind: "view",
      definition: '{ "pipeline": "CREATE VIEW x" }',
    });
    const res = await get("/qa-mongo/objects/view/order_summary/definition");
    expect(res.status).toBe(200);
    expect((await res.json()).migration).toBeNull();
  });

  it("answers 404 for a missing object and 400 for an ambiguous one, auditing neither", async () => {
    getObjectDefinition.mockResolvedValueOnce(null);
    const missing = await get("/qa-core/objects/view/nope/definition");
    expect(missing.status).toBe(404);
    expect((await missing.json()).code).toBe("OBJECT_NOT_FOUND");

    getObjectDefinition.mockRejectedValueOnce(
      new AmbiguousObjectError("pass args"),
    );
    expect((await get("/qa-core/objects/function/f/definition")).status).toBe(
      400,
    );
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("400s on a kind the engine does not have", async () => {
    expect((await get("/qa-core/objects/table/orders/definition")).status).toBe(
      400,
    );
    // Each engine has its own kinds: MongoDB has views, not procedures.
    expect((await get("/qa-mongo/objects/procedure/p/definition")).status).toBe(
      400,
    );
    expect((await get("/qa-core/objects/ilm_policy/p/definition")).status).toBe(
      400,
    );
    expect(getObjectDefinition).not.toHaveBeenCalled();
  });

  it("checks read rights on both sides of a drift report", async () => {
    expect((await get("/qa-core/drift?against=prod-core")).status).toBe(403);
    expect((await get("/qa-core/drift")).status).toBe(400);
    expect((await get("/qa-core/drift?against=qa-ms")).status).toBe(400);
    expect(getDrift).not.toHaveBeenCalled();
    expect(
      (await get("/qa-core/drift?against=qa-core&schema=app_core")).status,
    ).toBe(200);
    expect(getDrift).toHaveBeenCalledWith(
      conns["qa-core"],
      conns["qa-core"],
      "app_core",
    );
  });

  it("refuses a malformed job id before it reaches SQL, and audits a job read", async () => {
    expect((await get("/qa-ms/jobs/1;DROP")).status).toBe(400);
    expect((await get("/qa-core/jobs/not-a-number")).status).toBe(400);
    expect((await get("/prod-core/jobs/1")).status).toBe(403);
    expect(getJobDetail).not.toHaveBeenCalled();

    getJobDetail.mockResolvedValueOnce({ id: "7", name: "recalc due dates" });
    expect((await get("/qa-core/jobs/7")).status).toBe(200);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "JOB_VIEW",
        sql: "job recalc due dates (7)",
      }),
    );
  });

  it("lists the jobs that run an object alongside its dependencies", async () => {
    const res = await get(
      "/qa-core/objects/procedure/refresh_order_totals/dependencies?schema=app_core",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      uses: [],
      usedBy: [],
      bestEffort: false,
      jobs: [{ id: "7", name: "recalc due dates" }],
    });
    expect(
      (await get("/prod-core/objects/procedure/x/dependencies?schema=app_core"))
        .status,
    ).toBe(403);
  });
});
