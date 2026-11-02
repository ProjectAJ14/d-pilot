import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import type { AuthUser, JobDetail } from "../types/index.js";

/**
 * The write-request routes over HTTP, end to end against a real app store:
 * every refusal (capability, state, drift, connection moved), every way a
 * direct execution can end, and the AI helpers — with the target database,
 * the job/object readers and Azure OpenAI mocked out.
 */

const dir = mkdtempSync(path.join(tmpdir(), "d-pilot-write-routes-"));
vi.stubEnv("DATA_DIR", dir);
vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "");

const h = vi.hoisted(() => ({
  syntaxErrors: {} as Record<string, string>,
  /** Runs once during the next syntax check (a mid-validation edit). */
  duringValidation: undefined as (() => void) | undefined,
  executeQuery: vi.fn(),
  executeWrite: vi.fn(),
  executeMigration: vi.fn(),
  getObjectDefinition: vi.fn(),
  getObjectDependencies: vi.fn(),
  pgArgTypes: vi.fn(),
  getJobDetail: vi.fn(),
  checkJobStep: vi.fn(),
  getCachedFullSchema: vi.fn(),
  getAzureConfig: vi.fn(),
  azureChat: vi.fn(),
}));

vi.mock("../services/query-executor.js", async (orig) => ({
  ...(await orig<typeof import("../services/query-executor.js")>()),
  executeQuery: h.executeQuery,
  validateSqlSyntax: vi.fn(async (_c: unknown, sql: string) => {
    const edit = h.duringValidation;
    h.duringValidation = undefined;
    edit?.();
    return { checked: true, error: h.syntaxErrors[sql] };
  }),
}));
// The validators stay real; a test can make one fail without saying why.
vi.mock("../services/write-executor.js", async (orig) => {
  const m = await orig<typeof import("../services/write-executor.js")>();
  return {
    ...m,
    executeWrite: h.executeWrite,
    executeMigration: h.executeMigration,
    validateWriteQuery: vi.fn(m.validateWriteQuery),
    validateMigration: vi.fn(m.validateMigration),
  };
});
vi.mock("../services/object-change.js", async (orig) => {
  const m = await orig<typeof import("../services/object-change.js")>();
  return {
    ...m,
    proposedArgList: vi.fn(m.proposedArgList),
    validateObjectChange: vi.fn(m.validateObjectChange),
  };
});
vi.mock("../services/schema-objects.js", async (orig) => ({
  ...(await orig<typeof import("../services/schema-objects.js")>()),
  getObjectDefinition: h.getObjectDefinition,
  getObjectDependencies: h.getObjectDependencies,
  pgArgTypes: h.pgArgTypes,
}));
vi.mock("../services/jobs.js", async (orig) => ({
  ...(await orig<typeof import("../services/jobs.js")>()),
  getJobDetail: h.getJobDetail,
}));
vi.mock("../services/job-step.js", () => ({ checkJobStep: h.checkJobStep }));
vi.mock("../services/schema-introspector.js", async (orig) => ({
  ...(await orig<typeof import("../services/schema-introspector.js")>()),
  getCachedFullSchema: h.getCachedFullSchema,
}));
vi.mock("../services/azure-openai.js", async (orig) => ({
  ...(await orig<typeof import("../services/azure-openai.js")>()),
  getAzureConfig: h.getAzureConfig,
  azureChat: h.azureChat,
}));
// The claims stay real; a test can make one lose (someone else got there first).
vi.mock("../services/sqlite-store.js", async (orig) => {
  const m = await orig<typeof import("../services/sqlite-store.js")>();
  return {
    ...m,
    claimWriteRequestForApproval: vi.fn(m.claimWriteRequestForApproval),
    claimWriteRequestStatus: vi.fn(m.claimWriteRequestStatus),
    reviseWriteRequest: vi.fn(m.reviseWriteRequest),
    getWriteRequest: vi.fn(m.getWriteRequest),
  };
});

const store = await import("../services/sqlite-store.js");
const writeExecutor = await import("../services/write-executor.js");
const objectChange = await import("../services/object-change.js");
const { default: writes } = await import("./write-requests.js");
const { markPreConnect } = await import("../services/connection-errors.js");
const { AmbiguousObjectError } = await import("../services/schema-objects.js");
const { JobAccessError } = await import("../services/jobs.js");
const { AzureOpenAIError } = await import("../services/azure-openai.js");

store.initDatabase();

const base = (id: string, env: string, type: string) => ({
  id,
  name: `${env} ${type}`,
  env,
  type: type as any,
  host: "db-a.example.com",
  database: "app_core",
  username: "app",
  password: "pw",
});
const CONNS = {
  qaPg: base("qa-pg", "QA", "postgres"),
  devPg: base("dev-pg", "DEV", "postgres"),
  prodPg: base("prod-pg", "PROD", "postgres"),
  qaMs: base("qa-ms", "QA", "mssql"),
  devMs: base("dev-ms", "DEV", "mssql"),
  qaMongo: base("qa-mongo", "QA", "mongodb"),
  qaEs: base("qa-es", "QA", "elasticsearch"),
  qaEsNoDb: { ...base("qa-es-nodb", "QA", "elasticsearch"), database: "" },
};
for (const c of Object.values(CONNS)) store.saveDbConnection(c);

const ALL = ["QA", "DEV", "PROD"];
const USERS: Record<string, Partial<AuthUser>> = {
  author: {
    allowedEnvironments: ALL,
    writeEnvironments: ALL,
    unmaskEnvironments: ["QA"],
    jobEnvironments: ALL,
  },
  author2: { allowedEnvironments: ALL, writeEnvironments: ALL },
  approver: { allowedEnvironments: ALL, approveEnvironments: ALL },
  admin: { isAdmin: true },
  // May write and approve QA, but not read it.
  blind: {
    writeEnvironments: ["QA"],
    approveEnvironments: ["QA"],
    jobEnvironments: ["QA"],
  },
  // Writes and reads QA, but has no job capability.
  dataonly: { allowedEnvironments: ["QA"], writeEnvironments: ["QA"] },
  nobody: {},
  // A session from before the job capability existed: no jobEnvironments.
  legacy: {
    allowedEnvironments: ["QA"],
    writeEnvironments: ["QA"],
    jobEnvironments: undefined,
  },
};

let server: Server;
let url: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const sub = req.headers["x-user"] as string;
    req.user = {
      sub,
      email: `${sub}@example.com`,
      isAdmin: false,
      allowedEnvironments: [],
      unmaskEnvironments: [],
      writeEnvironments: [],
      approveEnvironments: [],
      jobEnvironments: [],
      ...USERS[sub],
    } as AuthUser;
    next();
  });
  app.use("/writes", writes);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/writes`;
});

afterAll(() => {
  server.close();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const AZURE = {
  endpoint: "https://ai.example.com",
  apiKey: "k",
  deployment: "d",
  model: "configured-model",
  apiVersion: "v",
};
const REVIEW = {
  verdict: "SAFE",
  selectMatchesWrite: true,
  estimatedBlastRadius: "single row",
  risks: ["none"],
  summary: "Updates one order.",
  recommendation: "approve",
  suggestedWriteSql: null,
  suggestedSelectSql: "null",
};
const JOB_TARGET = {
  jobId: "28741445-2c81-4de3-8fe9-bb30b243dd28",
  jobName: "recalc due dates",
  engine: "agent",
  action: { type: "set_enabled", enabled: false },
};
const ok = { rowsAffected: 1, executionMs: 2, transactional: true };
const preConnect = () =>
  markPreConnect(
    Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:5432"), {
      code: "ECONNREFUSED",
    }),
  );

beforeEach(() => {
  h.syntaxErrors = {};
  h.duringValidation = undefined;
  for (const f of [
    h.executeQuery,
    h.executeWrite,
    h.executeMigration,
    h.getObjectDefinition,
    h.getObjectDependencies,
    h.pgArgTypes,
    h.getJobDetail,
    h.checkJobStep,
    h.getCachedFullSchema,
    h.getAzureConfig,
    h.azureChat,
  ])
    f.mockReset();
  h.executeWrite.mockResolvedValue(ok);
  h.executeMigration.mockResolvedValue(ok);
  h.checkJobStep.mockResolvedValue(null);
  h.getAzureConfig.mockReturnValue({ config: AZURE, missing: [] });
  h.azureChat.mockResolvedValue({
    content: JSON.stringify(REVIEW),
    model: "reply-model",
  });
  h.getCachedFullSchema.mockResolvedValue({
    schema: {
      tables: [{ name: "orders", type: "TABLE" }],
      columns: {
        orders: [{ name: "status", type: "text", nullable: true }],
      },
    },
  });
  store.setSetting("write_mode_enabled", "true");
  store.setSetting("write_direct_envs", JSON.stringify(["DEV"]));
  store.setSetting("phi_masked_envs", JSON.stringify([]));
  for (const c of Object.values(CONNS)) store.saveDbConnection(c);
});

const req = async (
  user: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) => {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-user": user, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};
const post = (user: string, path: string, body: unknown = {}, hd = {}) =>
  req(user, "POST", path, body, hd);

const SELECT = "SELECT * FROM orders WHERE id = 1";
const UPDATE = "UPDATE orders SET status = 'placed' WHERE id = 1";

const create = (over: Record<string, unknown> = {}, user = "author") =>
  post(user, "", {
    title: "Fix status",
    connectionId: "qa-pg",
    selectSql: SELECT,
    writeSql: UPDATE,
    ...over,
  });

/** A request put straight into the store, bound to its connection. */
const seed = (
  over: Partial<Parameters<typeof store.createWriteRequest>[0]>,
) => {
  const wr = store.createWriteRequest({
    title: "Seeded",
    connectionId: "qa-pg",
    env: "QA",
    dbType: "postgres",
    selectSql: SELECT,
    writeSql: UPDATE,
    status: "PENDING",
    requestedBy: "author",
    requestedByEmail: "author@example.com",
    ...over,
  });
  const c = Object.values(CONNS).find((x) => x.id === wr.connectionId);
  if (c) store.setWriteRequestTarget(wr.id, store.connectionTarget(c as any));
  return wr.id;
};

const audits = (action: string) =>
  store.getAuditLog({ action, limit: 1000 }).length;

describe("policy", () => {
  it("reads the policy", async () => {
    const res = await req("author", "GET", "/policy");
    expect(res.body).toEqual({ writeModeEnabled: true, directEnvs: ["DEV"] });
  });

  it("lets an admin turn write mode off, which blocks every mutating route", async () => {
    const off = await req("admin", "PUT", "/policy", {
      writeModeEnabled: false,
    });
    expect(off.body.writeModeEnabled).toBe(false);
    const res = await create();
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Write mode is currently disabled/);
    const on = await req("admin", "PUT", "/policy", { writeModeEnabled: true });
    expect(on.body.writeModeEnabled).toBe(true);
  });

  it("refuses an unknown environment and a production direct-write env", async () => {
    expect(
      (await req("admin", "PUT", "/policy", { directEnvs: ["NOPE"] })).status,
    ).toBe(400);
    const prod = await req("admin", "PUT", "/policy", {
      directEnvs: ["DEV", "PROD"],
    });
    expect(prod.status).toBe(422);
    expect(prod.body.error).toMatch(/^PROD can't be a direct-write/);
    const qa = await req("admin", "PUT", "/policy", { directEnvs: ["QA"] });
    expect(qa.body.directEnvs).toEqual(["QA"]);
  });

  it("is admin-only to change", async () => {
    expect((await req("author", "PUT", "/policy", {})).status).toBe(403);
  });
});

describe("POST / — create", () => {
  it("validates input, connection and write rights", async () => {
    expect((await create({ title: " " })).status).toBe(400);
    expect((await create({ connectionId: "gone" })).status).toBe(404);
    const forbidden = await create({}, "approver");
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error).toMatch(/not allowed to author writes in QA/);
    const badObject = await create({ object: { name: 1 } });
    expect(badObject.status).toBe(400);
    expect(badObject.body.error).toMatch(/object must be/);
  });

  it("refuses a pair that isn't a valid write + read-only verify SELECT", async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ writeSql: "SELECT 1" }, /./],
      [{ selectSql: " " }, /A verify SELECT is required/],
      [{ selectSql: "DELETE FROM orders" }, /Verify SELECT must be read-only/],
      [{ selectSql: "VALUES (1)" }, /must be a SELECT query/],
    ];
    for (const [over, error] of cases) {
      const res = await create(over);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(error);
    }
    h.syntaxErrors[SELECT] = "column nope does not exist";
    expect((await create()).body.error).toBe(
      "Verify SELECT is not valid SQL: column nope does not exist",
    );
    h.syntaxErrors = { [UPDATE]: "syntax error at SET" };
    expect((await create()).body.error).toBe(
      "Write statement is not valid SQL: syntax error at SET",
    );
  });

  it("names a failed check that gives no reason", async () => {
    vi.mocked(writeExecutor.validateWriteQuery).mockReturnValueOnce({
      valid: false,
    } as any);
    expect((await create()).body).toEqual({
      error: "Invalid write statement",
    });
    vi.mocked(writeExecutor.validateMigration).mockReturnValueOnce({
      valid: false,
    } as any);
    const res = await create({ writeSql: "CREATE TABLE t (a int); SELECT 1" });
    expect(res).toMatchObject({
      status: 400,
      body: { error: "Invalid migration script" },
    });
  });

  it("refuses an invalid migration script", async () => {
    const res = await create({ writeSql: "DROP DATABASE app_core; SELECT 1" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/DROP DATABASE/);
  });

  it("keeps a migration's no-rollback opt-in", async () => {
    const res = await create({
      writeSql:
        "CREATE INDEX CONCURRENTLY orders_status ON orders (status); VACUUM orders",
      noTransaction: true,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      isMigration: true,
      noTransaction: true,
      status: "PENDING",
    });
    expect(res.body.selectSql).toBeFalsy();
  });

  it("runs on a direct-write environment and records it", async () => {
    const before = audits("WRITE_EXECUTE");
    const res = await create({ connectionId: "dev-pg" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: "EXECUTED", rowsAffected: 1 });
    expect(h.executeWrite).toHaveBeenCalledOnce();
    expect(audits("WRITE_EXECUTE")).toBe(before + 1);
  });

  it("marks a write that failed after reaching the database FAILED", async () => {
    h.executeWrite.mockRejectedValueOnce(new Error("deadlock detected"));
    const res = await create({ connectionId: "dev-pg" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: "FAILED",
      executionError: "deadlock detected",
    });
  });

  it("falls back to a generic message for an error without one", async () => {
    h.executeWrite.mockRejectedValueOnce({});
    const res = await create({ connectionId: "dev-pg" });
    expect(res.body.executionError).toBe("Write failed");
  });

  it("hands a write that never reached the database back as a draft", async () => {
    h.executeWrite.mockRejectedValueOnce(preConnect());
    const res = await create({ connectionId: "dev-pg" });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("CONNECTION_FAILED");
    expect(res.body.request.status).toBe("DRAFT");
    expect(res.body.request.events[0].event).toBe("NOT_RUN");
  });

  it("says so when someone else claimed it before the direct run", async () => {
    vi.mocked(store.claimWriteRequestForApproval).mockReturnValueOnce(false);
    const res = await create({ connectionId: "dev-pg" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already actioned by someone else/);
    expect(h.executeWrite).not.toHaveBeenCalled();
  });

  it("never calls it a draft when the release back to DRAFT lost its claim", async () => {
    h.executeWrite.mockRejectedValueOnce(preConnect());
    vi.mocked(store.claimWriteRequestStatus).mockReturnValueOnce(false);
    const res = await create({ connectionId: "dev-pg" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/changed by someone else while it was/);
    expect(res.body.request.status).toBe("APPROVED");
    expect(res.body.request.events[0].event).toBe("NOT_RUN");
  });
});

describe("object changes", () => {
  const FN = {
    schema: "app_core",
    name: "open_order_count",
    kind: "function",
    args: "integer",
    parent: "ignored-but-kept",
  };
  const FN_SQL =
    "CREATE OR REPLACE FUNCTION app_core.open_order_count(p integer) RETURNS int LANGUAGE sql AS $$SELECT 1$$";

  it("refuses an engine without objects", async () => {
    const res = await create({
      connectionId: "qa-mongo",
      selectSql: "db.orders.find({})",
      writeSql: 'db.orders.updateOne({"_id": 1}, {"$set": {"a": 1}})',
      object: { schema: "app_core", name: "p", kind: "procedure" },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("mongodb connections have no procedures.");
  });

  it("keeps a Postgres function's argument types", async () => {
    h.pgArgTypes
      .mockResolvedValueOnce(["text"])
      .mockResolvedValueOnce(["integer"]);
    const changed = await create({ writeSql: FN_SQL, object: FN });
    expect(changed.status).toBe(400);
    expect(changed.body.error).toMatch(
      /must keep the argument types \(integer\)/,
    );

    h.pgArgTypes.mockResolvedValueOnce([null]).mockResolvedValueOnce([]);
    expect((await create({ writeSql: FN_SQL, object: FN })).status).toBe(400);

    h.pgArgTypes.mockResolvedValue(["integer"]);
    h.getObjectDefinition.mockResolvedValue({ ...FN, definition: "old" });
    const same = await create({ writeSql: FN_SQL, object: FN });
    expect(same.status).toBe(201);
    expect(same.body).toMatchObject({ kind: "object_change", snapshot: "old" });
    expect(same.body.events[0].notes).toBe(
      "Changes function app_core.open_order_count",
    );
  });

  it("compares no arguments when neither list can be read", async () => {
    // Both are guaranteed by validateObjectChange; past it, an absent list
    // is compared as empty rather than crashing the route.
    vi.mocked(objectChange.validateObjectChange).mockReturnValueOnce(null);
    vi.mocked(objectChange.proposedArgList).mockReturnValueOnce(null);
    h.pgArgTypes.mockResolvedValue([]);
    h.getObjectDefinition.mockResolvedValue({ ...FN, definition: "old" });
    const { args: _args, ...noArgs } = FN;
    const res = await create({ writeSql: FN_SQL, object: noArgs });
    expect(res.body.error).toBeUndefined();
    expect(res.status).toBe(201);
    expect(h.pgArgTypes.mock.calls.map((c) => c[1])).toEqual([[], []]);
  });

  it("handles a function with no args recorded", async () => {
    h.pgArgTypes.mockResolvedValue([]);
    h.getObjectDefinition.mockResolvedValue(null);
    const res = await create({
      writeSql:
        "CREATE OR REPLACE PROCEDURE app_core.close_stale_orders() LANGUAGE sql AS $$ SELECT 1 $$",
      object: {
        schema: "app_core",
        name: "close_stale_orders",
        kind: "procedure",
        args: "",
      },
    });
    expect(res.body.error).toBeUndefined();
    expect(res.body.events[0].notes).toBe(
      "Creates procedure app_core.close_stale_orders",
    );
  });

  it("answers a failed read of the deployed definition", async () => {
    h.pgArgTypes.mockResolvedValue(["integer"]);
    h.getObjectDefinition.mockRejectedValueOnce(
      new AmbiguousObjectError("two overloads"),
    );
    const amb = await create({ writeSql: FN_SQL, object: FN });
    expect(amb).toMatchObject({
      status: 400,
      body: { error: "two overloads" },
    });

    h.getObjectDefinition.mockRejectedValueOnce(preConnect());
    const down = await create({ writeSql: FN_SQL, object: FN });
    expect(down.status).toBe(503);
    expect(down.body.code).toBe("CONNECTION_FAILED");

    h.getObjectDefinition.mockRejectedValueOnce({});
    const other = await create({ writeSql: FN_SQL, object: FN });
    expect(other).toMatchObject({
      status: 500,
      body: { error: "Could not read the target" },
    });
  });
});

describe("job changes", () => {
  const JOB_ID = "28741445-2c81-4de3-8fe9-bb30b243dd28";
  const job = (): JobDetail => ({
    id: JOB_ID,
    name: "recalc due dates",
    engine: "agent",
    enabled: true,
    stepCount: 1,
    database: "app_core",
    steps: [
      {
        id: 1,
        name: "run proc",
        subsystem: "TSQL",
        command: "EXEC app_core.refresh_order_totals",
        database: "app_core",
      },
    ],
    schedules: [],
    history: [],
  });
  const raise = (
    action: unknown,
    over: Record<string, unknown> = {},
    user = "author",
  ) =>
    post(user, "", {
      title: "Job",
      connectionId: "qa-ms",
      jobChange: { jobId: JOB_ID, action },
      ...over,
    });

  beforeEach(() => h.getJobDetail.mockResolvedValue(job()));

  it("validates the request before anything else", async () => {
    expect((await raise({ type: "rename" }, { title: "" })).status).toBe(400);
    expect(
      (await raise({ type: "rename" }, { connectionId: "gone" })).status,
    ).toBe(404);
  });

  it("raises each kind of action, refusing what the job can't take", async () => {
    const rename = await raise({ type: "rename", name: "recalc v2" });
    expect(rename.status).toBe(201);
    expect(rename.body.kind).toBe("job_change");
    expect(
      (await raise({ type: "set_description", description: "nightly" })).status,
    ).toBe(201);
    expect((await raise({ type: "rename", name: 7 })).body.error).toBeTruthy();
    expect(
      (await raise({ type: "set_description", description: 7 })).status,
    ).toBe(201);
    const add = await raise({
      type: "add_step",
      name: "again",
      command: "EXEC app_core.refresh_order_totals",
    });
    expect(add.status).toBe(201);
    expect(h.checkJobStep).toHaveBeenCalledWith(
      expect.objectContaining({ id: "qa-ms" }),
      "EXEC app_core.refresh_order_totals",
    );
    expect((await raise({ type: "add_step" })).status).toBe(400);
    expect((await raise({ type: "delete_step", stepId: 1 })).status).toBe(400);
    expect((await raise({ type: "delete_step", stepId: "1" })).status).toBe(
      400,
    );
    const unknown = await raise({ type: "drop_job" });
    expect(unknown).toMatchObject({
      status: 400,
      body: { error: "Unknown job change" },
    });
  });

  it("refuses an engine without jobs, and a malformed job id", async () => {
    const before = audits("JOB_CHANGE_REFUSED");
    const mongo = await raise(
      { type: "rename", name: "x" },
      {
        connectionId: "qa-mongo",
      },
    );
    expect(mongo.body.error).toBe("mongodb connections have no scheduled jobs");
    const guid = await raise(
      { type: "rename", name: "x" },
      {
        jobChange: { jobId: "12", action: { type: "rename", name: "x" } },
      },
    );
    expect(guid.body.error).toBe("A SQL Server Agent job id is a GUID");
    const pg = await raise(
      { type: "rename", name: "x" },
      {
        connectionId: "qa-pg",
      },
    );
    expect(pg.body.error).toBe("A pg_cron job id is an integer");
    const noId = await raise(
      { type: "rename", name: "x" },
      {
        jobChange: { action: { type: "rename", name: "x" } },
      },
    );
    expect(noId.status).toBe(400);
    expect(audits("JOB_CHANGE_REFUSED")).toBe(before + 4);
  });

  it("answers a failed read of the job or its step check", async () => {
    h.getJobDetail.mockRejectedValueOnce(new JobAccessError("no msdb access"));
    expect(await raise({ type: "rename", name: "x" })).toMatchObject({
      status: 403,
      body: { error: "no msdb access" },
    });
    h.checkJobStep.mockRejectedValueOnce(preConnect());
    const down = await raise({
      type: "edit_step",
      stepId: 1,
      command: "EXEC app_core.refresh_order_totals",
    });
    expect(down.status).toBe(503);
    h.checkJobStep.mockResolvedValueOnce("DROP is not allowed");
    const refused = await raise({
      type: "edit_step",
      stepId: 1,
      command: "DROP TABLE orders",
    });
    expect(refused.body.error).toBe("DROP is not allowed");
  });

  it("refuses when the connection moved while the step was checked", async () => {
    h.checkJobStep.mockImplementationOnce(async () => {
      store.saveDbConnection({ ...CONNS.qaMs, host: "db-b.example.com" });
      return null;
    });
    const res = await raise({
      type: "edit_step",
      stepId: 1,
      command: "EXEC app_core.refresh_order_totals",
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/changed while this request was being/);
  });

  it("runs on a direct-write environment, and hands back an unreachable one", async () => {
    const ran = await raise(
      { type: "rename", name: "x" },
      {
        connectionId: "dev-ms",
      },
    );
    expect(ran.status).toBe(201);
    expect(ran.body.status).toBe("EXECUTED");
    expect(h.executeMigration).toHaveBeenCalledOnce();

    h.executeMigration.mockRejectedValueOnce(preConnect());
    const down = await raise(
      { type: "rename", name: "y" },
      {
        connectionId: "dev-ms",
      },
    );
    expect(down.status).toBe(503);
    expect(down.body.request.status).toBe("DRAFT");
  });

  it("saves a drafted job change without running it", async () => {
    const res = await raise(
      { type: "rename", name: "x" },
      {
        connectionId: "dev-ms",
        draft: true,
        description: "  rename it  ",
      },
    );
    expect(res.body).toMatchObject({
      status: "DRAFT",
      description: "rename it",
    });
    expect(h.executeMigration).not.toHaveBeenCalled();
  });
});

describe("GET / and GET /:id", () => {
  it("lists what each viewer may act on", async () => {
    const id = seed({ status: "DRAFT" });
    const mine = await req("author", "GET", "/");
    const row = mine.body.find((r: any) => r.id === id);
    expect(row).toMatchObject({
      viewerIsRequester: true,
      viewerCanApprove: false,
      viewerCanSubmit: true,
    });
    const admin = await req("admin", "GET", "/");
    expect(admin.body.find((r: any) => r.id === id)).toMatchObject({
      viewerCanApprove: true,
      viewerIsRequester: false,
    });
  });

  it("hides another environment's object snapshot from someone who can't read it", async () => {
    const id = seed({
      kind: "object_change",
      target: { schema: "app_core", name: "p", kind: "procedure" },
      snapshot: "deployed body",
    });
    const blind = await req("blind", "GET", `/${id}`);
    expect(blind.status).toBe(200);
    expect(blind.body.snapshot).toBeUndefined();
    expect(blind.body.viewerCanPreview).toBe(false);
    const list = await req("blind", "GET", "/");
    expect(list.body.find((r: any) => r.id === id).snapshot).toBeUndefined();
    const author = await req("author", "GET", `/${id}`);
    expect(author.body.snapshot).toBe("deployed body");
  });

  it("answers 404 and 403", async () => {
    expect((await req("author", "GET", "/missing")).status).toBe(404);
    const id = seed({});
    expect((await req("nobody", "GET", `/${id}`)).status).toBe(403);
    const admin = await req("admin", "GET", `/${id}`);
    expect(admin.body).toMatchObject({
      viewerCanOverride: true,
      submitRunsImmediately: false,
    });
  });
});

describe("POST /analyze", () => {
  it("classifies a draft write", async () => {
    expect((await post("author", "/analyze", {})).status).toBe(400);
    expect(
      (await post("author", "/analyze", { connectionId: "x", writeSql: "a" }))
        .status,
    ).toBe(404);
    expect(
      (
        await post("approver", "/analyze", {
          connectionId: "qa-pg",
          writeSql: UPDATE,
        })
      ).status,
    ).toBe(403);
    const dml = await post("author", "/analyze", {
      connectionId: "qa-pg",
      writeSql: UPDATE,
    });
    expect(dml.body).toMatchObject({
      isMigration: false,
      requiresNoTransaction: false,
    });
    expect(dml.body.blocked).toBeUndefined();
    const noTx = await post("author", "/analyze", {
      connectionId: "qa-pg",
      writeSql: "VACUUM orders; ANALYZE orders",
    });
    expect(noTx.body).toMatchObject({
      isMigration: true,
      requiresNoTransaction: true,
    });
    const blocked = await post("author", "/analyze", {
      connectionId: "qa-pg",
      writeSql: "DROP DATABASE app_core; SELECT 1",
    });
    expect(blocked.body.blocked).toMatch(/DROP DATABASE/);
  });
});

describe("stateless AI helpers", () => {
  const routes = [
    ["/ai-review", { writeSql: UPDATE, selectSql: SELECT }],
    ["/suggest-write", { selectSql: SELECT }],
    ["/suggest-select", { writeSql: UPDATE }],
  ] as const;

  it("refuse missing input, connection, rights and AI config", async () => {
    for (const [path, body] of routes) {
      expect((await post("author", path, {})).status).toBe(400);
      expect(
        (await post("author", path, { ...body, connectionId: "gone" })).status,
      ).toBe(404);
      expect(
        (await post("nobody", path, { ...body, connectionId: "qa-pg" })).status,
      ).toBe(403);
      h.getAzureConfig.mockReturnValueOnce({
        config: null,
        missing: ["AZURE_OPENAI_ENDPOINT"],
      });
      const off = await post("author", path, {
        ...body,
        connectionId: "qa-pg",
      });
      expect(off.status).toBe(503);
      expect(off.body.error).toMatch(/Missing: AZURE_OPENAI_ENDPOINT/);
      h.azureChat.mockRejectedValueOnce(new Error("quota exceeded"));
      const fail = await post("author", path, {
        ...body,
        connectionId: "qa-pg",
      });
      expect(fail).toMatchObject({
        status: 500,
        body: { error: "quota exceeded" },
      });
      h.azureChat.mockRejectedValueOnce({});
      const blank = await post("author", path, {
        ...body,
        connectionId: "qa-pg",
      });
      expect(blank.body.error).toMatch(/failed$/);
    }
    const filtered = new AzureOpenAIError("filtered", 400);
    (filtered as any).contentFiltered = true;
    h.azureChat.mockRejectedValueOnce(filtered);
    expect(
      (
        await post("author", "/ai-review", {
          ...routes[0][1],
          connectionId: "qa-pg",
        })
      ).status,
    ).toBe(422);
  });

  it("lets an approver review but not suggest", async () => {
    const res = await post("approver", "/ai-review", {
      connectionId: "qa-pg",
      writeSql: UPDATE,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      verdict: "SAFE",
      model: "reply-model",
    });
    expect(res.body.suggestedSelectSql).toBeUndefined();
    const [, messages] = h.azureChat.mock.calls[0];
    expect(messages[1].content).toContain("(none provided)");
    expect(messages[1].content).toContain("name: app_core");
    expect(messages[1].content).toContain("orders");
  });

  it("reviews a migration as a whole script", async () => {
    h.azureChat.mockResolvedValueOnce({
      content: "```json\n" + JSON.stringify(REVIEW) + "\n```",
      model: "",
    });
    const res = await post("author", "/ai-review", {
      connectionId: "qa-pg",
      writeSql:
        "ALTER TABLE orders ADD COLUMN note text; UPDATE orders SET note = ''",
    });
    expect(res.body).toMatchObject({
      verdict: "SAFE",
      model: "configured-model",
    });
    expect(res.body.selectMatchesWrite).toBeUndefined();
    expect(h.azureChat.mock.calls[0][1][0].content).toContain(
      "LOCKING / TABLE REWRITE",
    );
  });

  it("reviews a DML-only migration for unbounded writes", async () => {
    await post("author", "/ai-review", {
      connectionId: "qa-pg",
      writeSql: "UPDATE orders SET a = 1 WHERE id = 1; UPDATE orders SET b = 2",
    });
    expect(h.azureChat.mock.calls[0][1][0].content).toContain("BOUNDED WRITES");
  });

  it("defaults to caution on a reply it can't use", async () => {
    h.azureChat.mockResolvedValueOnce({ content: "not json", model: "m" });
    const bad = await post("author", "/ai-review", {
      connectionId: "qa-pg",
      writeSql: UPDATE,
    });
    expect(bad.body).toMatchObject({
      verdict: "CAUTION",
      risks: ["Could not parse AI response"],
      summary: "not json",
    });
    h.azureChat.mockResolvedValueOnce({
      content: JSON.stringify({
        verdict: "MAYBE",
        risks: "x",
        suggestedWriteSql: " UPDATE t SET a=1 WHERE b=1 ",
      }),
      model: "m",
    });
    const odd = await post("author", "/ai-review", {
      connectionId: "qa-pg",
      writeSql: UPDATE,
    });
    expect(odd.body).toMatchObject({
      verdict: "CAUTION",
      selectMatchesWrite: false,
      estimatedBlastRadius: "unknown",
      risks: [],
      summary: "",
      recommendation: "review carefully",
      suggestedWriteSql: "UPDATE t SET a=1 WHERE b=1",
    });
  });

  it("works without a schema", async () => {
    h.getCachedFullSchema.mockRejectedValueOnce(new Error("down"));
    await post("author", "/ai-review", {
      connectionId: "qa-pg",
      writeSql: UPDATE,
    });
    expect(h.azureChat.mock.calls[0][1][1].content).toContain(
      "(schema unavailable)",
    );
  });

  it("summarizes every table when the statements name none it knows", async () => {
    h.getCachedFullSchema.mockResolvedValueOnce({
      schema: { tables: [], columns: {} },
    });
    await post("author", "/ai-review", {
      connectionId: "qa-pg",
      writeSql: "UPDATE customers SET a = 1 WHERE id = 1",
    });
    expect(h.azureChat.mock.calls[0][1][1].content).toContain("(no schema)");
  });

  it("suggests statements in each dialect", async () => {
    const gen = { content: '{"query":"Q","explanation":"E"}', model: "m" };
    const cases = [
      [
        "qa-pg",
        "Target SQL: produce a single",
        "Target SQL: a single read-only",
      ],
      [
        "qa-mongo",
        "Target MongoDB: produce db.<collection>.updateMany",
        "Target MongoDB: produce db.<collection>.find",
      ],
      ["qa-es", "_update_by_query or POST", "GET /<index>/_search"],
    ];
    for (const [connectionId, writeHint, selectHint] of cases) {
      h.azureChat.mockReset();
      h.azureChat.mockResolvedValue(gen);
      const w = await post("author", "/suggest-write", {
        connectionId,
        selectSql: SELECT,
        intent: " set status ",
        currentWrite: " UPDATE x ",
      });
      expect(w.body).toEqual({ query: "Q", explanation: "E" });
      const wPrompt = h.azureChat.mock.calls[0][1];
      expect(wPrompt[0].content).toContain(writeHint);
      expect(wPrompt[1].content).toContain("<user_intent>");
      expect(wPrompt[1].content).toContain("<current_draft>");
      const s = await post("author", "/suggest-select", {
        connectionId,
        writeSql: UPDATE,
      });
      expect(s.body.query).toBe("Q");
      const sPrompt = h.azureChat.mock.calls[1][1];
      expect(sPrompt[0].content).toContain(selectHint);
      expect(sPrompt[1].content).not.toContain("<user_intent>");
    }
    const s = await post("author", "/suggest-select", {
      connectionId: "qa-pg",
      writeSql: UPDATE,
      intent: "x",
      currentSelect: "SELECT 1",
    });
    expect(s.status).toBe(200);
    expect(h.azureChat.mock.calls.at(-1)![1][1].content).toContain(
      "<current_draft>",
    );
  });
});

describe("POST /:id/preview", () => {
  const rows = {
    columns: [{ name: "ssn", type: "text" }],
    rows: [{ ssn: "123-45-6789" }],
    totalRows: 1,
    executionTimeMs: 3,
    truncated: false,
  };
  beforeEach(() => {
    h.executeQuery.mockResolvedValue(rows);
    store.upsertPhiRule({
      id: "ssn-rule",
      pattern: "ssn",
      maskingType: "FULL",
      alwaysMasked: false,
    } as any);
  });

  it("refuses what the viewer can't see or run", async () => {
    expect((await post("author", "/missing/preview")).status).toBe(404);
    const id = seed({});
    expect((await post("nobody", `/${id}/preview`)).status).toBe(403);
    expect((await post("blind", `/${id}/preview`)).status).toBe(403);
    const migration = seed({ selectSql: undefined, isMigration: true });
    expect((await post("author", `/${migration}/preview`)).status).toBe(400);
    const unsafe = seed({ selectSql: "DELETE FROM orders" });
    const res = await post("author", `/${unsafe}/preview`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must be read-only/);
    const orphan = seed({ connectionId: "qa-orphan" });
    expect((await post("author", `/${orphan}/preview`)).status).toBe(404);
    expect(h.executeQuery).not.toHaveBeenCalled();
  });

  it("previews and audits, unmasking only with the right and a reason where masked", async () => {
    const id = seed({});
    const plain = await post("author", `/${id}/preview`, { defaultLimit: 5 });
    expect(plain.status).toBe(200);
    expect(plain.body).toMatchObject({ totalRows: 1, connectionId: "qa-pg" });
    expect(h.executeQuery).toHaveBeenCalledWith(
      expect.objectContaining({ id: "qa-pg" }),
      SELECT,
      5,
    );

    const off = { "x-phi-shield": "off" };
    const unmasked = await post("author", `/${id}/preview`, {}, off);
    expect(unmasked.status).toBe(200);

    store.setSetting("phi_masked_envs", JSON.stringify(["QA"]));
    const noReason = await post("author", `/${id}/preview`, {}, off);
    expect(noReason.status).toBe(200);
    const withReason = await post(
      "author",
      `/${id}/preview`,
      {},
      {
        ...off,
        "x-phi-unmask-reason": "Support",
        "x-phi-unmask-notes": "ticket",
      },
    );
    expect(withReason.status).toBe(200);
    // No unmask right on DEV-less approver path: approver can't unmask QA.
    expect((await post("approver", `/${id}/preview`, {}, off)).status).toBe(
      200,
    );
    const log = store.getAuditLog({ action: "WRITE_PREVIEW", limit: 50 });
    expect(log.some((e: any) => e.phiUnmaskReason === "Support")).toBe(true);
  });

  it("answers a connection failure 503 and anything else 500", async () => {
    const id = seed({});
    h.executeQuery.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    const down = await post("author", `/${id}/preview`);
    expect(down).toMatchObject({
      status: 503,
      body: { code: "CONNECTION_FAILED" },
    });
    h.executeQuery.mockRejectedValueOnce(new Error("relation missing"));
    expect((await post("author", `/${id}/preview`)).body.error).toBe(
      "relation missing",
    );
    h.executeQuery.mockRejectedValueOnce({});
    expect((await post("author", `/${id}/preview`)).body.error).toBe(
      "Preview query failed",
    );
  });
});

describe("POST /:id/ai-review", () => {
  it("refuses what the viewer can't see", async () => {
    expect((await post("author", "/missing/ai-review")).status).toBe(404);
    const id = seed({});
    expect((await post("nobody", `/${id}/ai-review`)).status).toBe(403);
    const obj = seed({
      kind: "object_change",
      isMigration: true,
      selectSql: undefined,
      target: { schema: "app_core", name: "p", kind: "procedure" },
    });
    const blind = await post("blind", `/${obj}/ai-review`);
    expect(blind.status).toBe(403);
    expect(blind.body.error).toMatch(/not allowed to read objects in QA/);
    const orphan = seed({ connectionId: "qa-orphan" });
    expect((await post("author", `/${orphan}/ai-review`)).status).toBe(404);
    h.getAzureConfig.mockReturnValueOnce({ config: null, missing: ["X"] });
    expect((await post("author", `/${id}/ai-review`)).status).toBe(503);
    h.azureChat.mockRejectedValueOnce(new Error("boom"));
    expect((await post("author", `/${id}/ai-review`)).status).toBe(500);
  });

  it("stores the verdict on the request and audits it", async () => {
    const id = seed({});
    const before = audits("WRITE_AI_REVIEW");
    const res = await post("approver", `/${id}/ai-review`);
    expect(res.body.verdict).toBe("SAFE");
    const wr = store.getWriteRequest(id)!;
    expect(wr.aiVerdict).toBe("SAFE");
    expect(wr.events![0]).toMatchObject({
      event: "AI_REVIEWED",
      notes: "Verdict: SAFE",
    });
    expect(audits("WRITE_AI_REVIEW")).toBe(before + 1);
  });

  it("gives an object change's review the deployed version and its dependents", async () => {
    const target = { schema: "app_core", name: "p", kind: "procedure" };
    h.getObjectDependencies.mockResolvedValueOnce({
      usedBy: [
        { database: "app_core", schema: "app_core", name: "v", kind: "view" },
        { name: "caller" },
      ],
    });
    const id = seed({
      kind: "object_change",
      isMigration: true,
      selectSql: undefined,
      writeSql:
        "CREATE OR REPLACE PROCEDURE app_core.p() LANGUAGE sql AS $$ SELECT 1 $$",
      target,
      snapshot: "OLD BODY",
    });
    await post("author", `/${id}/ai-review`);
    const user = h.azureChat.mock.calls[0][1][1].content;
    expect(user).toContain("OLD BODY");
    expect(user).toContain("app_core.app_core.v (view)");
    expect(user).toContain("caller (unresolved)");

    h.getObjectDependencies.mockRejectedValueOnce(new Error("no access"));
    const created = seed({
      kind: "object_change",
      isMigration: true,
      selectSql: undefined,
      writeSql:
        "CREATE OR REPLACE PROCEDURE app_core.p() LANGUAGE sql AS $$ SELECT 1 $$",
      target,
      snapshot: null,
    });
    await post("author", `/${created}/ai-review`);
    const second = h.azureChat.mock.calls[1][1][1].content;
    expect(second).toContain("(none — this change creates the object)");
    expect(second).toContain("(nothing found)");
  });

  it("reviews a job change (stored as a migration) as a script", async () => {
    const id = seed({
      kind: "job_change",
      target: JOB_TARGET,
      isMigration: true,
      selectSql: undefined,
      writeSql: "EXEC msdb.dbo.sp_update_job @job_name = N'x', @enabled = 0",
      connectionId: "qa-ms",
      dbType: "mssql",
    });
    const res = await post("author", `/${id}/ai-review`);
    expect(res.status).toBe(200);
    expect(h.azureChat.mock.calls[0][1][0].content).toContain(
      "MIGRATION SCRIPT",
    );
  });
});

describe("approve / override", () => {
  it("refuses an unknown request and a missing or moved connection", async () => {
    expect((await post("approver", "/missing/approve")).status).toBe(404);
    const orphan = seed({ connectionId: "qa-orphan" });
    const gone = await post("approver", `/${orphan}/approve`);
    expect(gone.status).toBe(409);
    expect(gone.body.error).toMatch(/no longer exists/);
  });

  it("refuses when the connection moved while drift was checked", async () => {
    h.getObjectDefinition.mockImplementationOnce(
      async (_c: unknown, o: any) => {
        store.saveDbConnection({ ...CONNS.qaPg, host: "db-b.example.com" });
        return { ...o, definition: "BODY" };
      },
    );
    const id = seed({
      kind: "object_change",
      isMigration: true,
      selectSql: undefined,
      writeSql: "CREATE OR REPLACE VIEW app_core.v AS SELECT 1",
      target: { schema: "app_core", name: "v", kind: "view" },
      snapshot: "BODY",
    });
    const res = await post("approver", `/${id}/approve`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/changed while this request was being/);
    expect(store.getWriteRequest(id)!.status).toBe("PENDING");
  });

  it("re-validates the statement at execution time", async () => {
    const id = seed({ writeSql: "SELECT 1" });
    const res = await post("approver", `/${id}/approve`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/^Write is no longer valid/);
  });

  it("runs exactly once", async () => {
    const id = seed({});
    vi.mocked(store.claimWriteRequestForApproval).mockReturnValueOnce(false);
    const res = await post("approver", `/${id}/approve`);
    expect(res.status).toBe(409);
    expect(h.executeWrite).not.toHaveBeenCalled();
  });

  it("releases the claim when the database was never reached", async () => {
    const id = seed({});
    h.executeWrite.mockRejectedValueOnce(preConnect());
    const res = await post("approver", `/${id}/approve`, { notes: " ok " });
    expect(res.status).toBe(503);
    expect(res.body.request.status).toBe("PENDING");
  });

  it("marks a failed run FAILED with a generic message when the error has none", async () => {
    const id = seed({});
    h.executeWrite.mockRejectedValueOnce({});
    const res = await post("approver", `/${id}/approve`);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Write execution failed");
    expect(res.body.request).toMatchObject({
      status: "FAILED",
      executionError: "Write failed",
    });
  });

  it("runs a migration through the migration path", async () => {
    const id = seed({
      isMigration: true,
      selectSql: undefined,
      writeSql:
        "UPDATE orders SET a = 1 WHERE id = 1; UPDATE orders SET b = 2 WHERE id = 1",
    });
    const res = await post("admin", `/${id}/override`, { notes: "urgent" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("EXECUTED");
    expect(h.executeMigration).toHaveBeenCalledOnce();
    expect(audits("WRITE_OVERRIDE")).toBeGreaterThan(0);
  });
});

describe("POST /:id/reject", () => {
  it("walks every refusal, then rejects", async () => {
    expect((await post("approver", "/missing/reject")).status).toBe(404);
    const done = seed({ status: "EXECUTED" });
    expect((await post("approver", `/${done}/reject`)).status).toBe(409);
    const id = seed({});
    expect((await post("author2", `/${id}/reject`)).status).toBe(403);
    const own = await post(
      "admin",
      `/${seed({ requestedBy: "admin" })}/reject`,
    );
    expect(own.body.error).toBe("Use cancel to withdraw your own request");
    vi.mocked(store.claimWriteRequestStatus).mockReturnValueOnce(false);
    expect((await post("approver", `/${id}/reject`)).status).toBe(409);
    const before = audits("WRITE_REJECT");
    const res = await post("approver", `/${id}/reject`, { notes: " no " });
    expect(res.body).toMatchObject({ status: "REJECTED", reviewNotes: "no" });
    expect(audits("WRITE_REJECT")).toBe(before + 1);
    const bare = await post("approver", `/${seed({})}/reject`, { notes: " " });
    expect(bare.body.reviewNotes).toBeUndefined();
  });
});

describe("POST /:id/submit", () => {
  it("refuses an unknown draft, a moved connection and missing rights", async () => {
    expect((await post("author", "/missing/submit")).status).toBe(404);
    const moved = seed({ status: "DRAFT" });
    store.saveDbConnection({ ...CONNS.qaPg, host: "db-b.example.com" });
    expect((await post("author", `/${moved}/submit`)).status).toBe(409);
    store.saveDbConnection(CONNS.qaPg);
    const id = seed({ status: "DRAFT" });
    expect((await post("approver", `/${id}/submit`)).status).toBe(403);
    const obj = seed({
      status: "DRAFT",
      kind: "object_change",
      target: { schema: "app_core", name: "v", kind: "view" },
    });
    const blind = await post("blind", `/${obj}/submit`);
    expect(blind.body.error).toMatch(/not allowed to read objects/);
    const job = seed({
      status: "DRAFT",
      kind: "job_change",
      target: JOB_TARGET,
    });
    const noJobs = await post("dataonly", `/${job}/submit`);
    expect(noJobs.status).toBe(403);
    expect(noJobs.body.error).toMatch(/not allowed to change jobs in QA/);
  });

  it("re-validates the draft and re-checks the connection", async () => {
    const bad = seed({ status: "DRAFT", writeSql: "SELECT 1" });
    expect((await post("author", `/${bad}/submit`)).status).toBe(400);
    const id = seed({ status: "DRAFT" });
    h.duringValidation = () =>
      store.saveDbConnection({ ...CONNS.qaPg, host: "db-b.example.com" });
    const res = await post("author", `/${id}/submit`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/changed while this request was being/);
    expect(store.getWriteRequest(id)!.status).toBe("DRAFT");
  });

  it("loses a race to submit cleanly", async () => {
    const id = seed({ status: "DRAFT" });
    vi.mocked(store.claimWriteRequestStatus).mockReturnValueOnce(false);
    const res = await post("author", `/${id}/submit`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already submitted by someone else/);
  });

  it("takes ownership of someone else's draft", async () => {
    const id = seed({ status: "DRAFT" });
    const res = await post("author2", `/${id}/submit`);
    expect(res.body).toMatchObject({
      status: "PENDING",
      requestedBy: "author2",
    });
    expect(res.body.events[0].notes).toBe(
      "Submitted a draft raised by author@example.com",
    );
  });

  it("runs on a direct-write env, and reports a run that never happened", async () => {
    const id = seed({ status: "DRAFT", connectionId: "dev-pg", env: "DEV" });
    const ran = await post("author", `/${id}/submit`);
    expect(ran.body.status).toBe("EXECUTED");
    const later = seed({ status: "DRAFT", connectionId: "dev-pg", env: "DEV" });
    vi.mocked(store.claimWriteRequestForApproval).mockReturnValueOnce(false);
    expect((await post("author", `/${later}/submit`)).status).toBe(409);
  });
});

describe("POST /:id/cancel", () => {
  it("refuses an unknown request and someone else's", async () => {
    expect((await post("author", "/missing/cancel")).status).toBe(404);
    const id = seed({});
    expect((await post("author2", `/${id}/cancel`)).status).toBe(403);
    expect((await post("admin", `/${id}/cancel`)).body.status).toBe(
      "CANCELLED",
    );
  });

  it("reports the status a lost claim found, or the one read when it is gone", async () => {
    const id = seed({});
    vi.mocked(store.claimWriteRequestStatus).mockImplementationOnce(() => {
      store.deleteWriteRequest(id);
      return false;
    });
    const res = await post("author", `/${id}/cancel`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(
      "Request is PENDING and can no longer be cancelled",
    );
  });
});

describe("DELETE /:id", () => {
  it("deletes only a finished request of one's own, and audits it", async () => {
    expect((await req("author", "DELETE", "/missing")).status).toBe(404);
    const id = seed({ status: "CANCELLED" });
    expect((await req("author2", "DELETE", `/${id}`)).status).toBe(403);
    const executed = await req(
      "admin",
      "DELETE",
      `/${seed({ status: "EXECUTED" })}`,
    );
    expect(executed.status).toBe(409);
    expect(executed.body.error).toMatch(/executed request cannot be deleted/);
    const pending = await req("author", "DELETE", `/${seed({})}`);
    expect(pending.body.error).toBe(
      "A PENDING request cannot be deleted — cancel it first.",
    );
    const before = audits("WRITE_DELETE");
    expect((await req("author", "DELETE", `/${id}`)).body).toEqual({
      deleted: true,
    });
    expect(store.getWriteRequest(id)).toBeNull();
    expect(audits("WRITE_DELETE")).toBe(before + 1);
  });
});

describe("POST /:id/revise", () => {
  it("refuses an unknown request, a job change and a missing connection", async () => {
    expect((await post("author", "/missing/revise")).status).toBe(404);
    const job = seed({
      status: "REJECTED",
      kind: "job_change",
      target: JOB_TARGET,
    });
    expect((await post("author", `/${job}/revise`)).status).toBe(400);
    const orphan = seed({ status: "REJECTED", connectionId: "qa-orphan" });
    expect((await post("author", `/${orphan}/revise`)).status).toBe(404);
    const live = seed({});
    expect((await post("author", `/${live}/revise`)).status).toBe(409);
  });

  it("requires a title and a valid statement", async () => {
    const id = seed({ status: "REJECTED" });
    expect((await post("author", `/${id}/revise`, { title: " " })).status).toBe(
      400,
    );
    const bad = await post("author", `/${id}/revise`, { writeSql: "SELECT 1" });
    expect(bad.status).toBe(400);
    h.duringValidation = () =>
      store.saveDbConnection({ ...CONNS.qaPg, host: "db-b.example.com" });
    expect((await post("author", `/${id}/revise`)).status).toBe(409);
    expect(store.getWriteRequest(id)!.status).toBe("REJECTED");
  });

  it("resubmits with edits, clearing a blanked description", async () => {
    const id = seed({ status: "REJECTED", description: "old" });
    const res = await post("author", `/${id}/revise`, {
      title: " New ",
      description: "  ",
      note: " fixed ",
    });
    expect(res.body).toMatchObject({ status: "PENDING", title: "New" });
    expect(res.body.description).toBeUndefined();
    expect(res.body.events[0]).toMatchObject({
      event: "RESUBMITTED",
      notes: "fixed",
    });
  });

  it("re-bases an object change, and passes on a refusal", async () => {
    const target = { schema: "app_core", name: "v", kind: "view" };
    const sql = "CREATE OR REPLACE VIEW app_core.v AS SELECT 1";
    const id = seed({
      status: "REJECTED",
      kind: "object_change",
      isMigration: true,
      selectSql: undefined,
      writeSql: sql,
      target,
      snapshot: "OLD",
    });
    h.getObjectDefinition.mockResolvedValueOnce({
      ...target,
      definition: "NOW",
    });
    const res = await post("author", `/${id}/revise`, { noTransaction: true });
    expect(res.body).toMatchObject({ snapshot: "NOW", noTransaction: false });

    const again = seed({
      status: "REJECTED",
      kind: "object_change",
      isMigration: true,
      selectSql: undefined,
      writeSql: sql,
      target,
    });
    h.getObjectDefinition.mockRejectedValueOnce(preConnect());
    expect((await post("author", `/${again}/revise`)).status).toBe(503);
  });

  it("refuses when the row moved under the revise", async () => {
    const id = seed({ status: "CANCELLED" });
    vi.mocked(store.reviseWriteRequest).mockReturnValueOnce(null as any);
    const res = await post("author", `/${id}/revise`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/changed by someone else meanwhile/);
  });

  it("re-runs a resubmit on a direct-write env, and reports a run that did not happen", async () => {
    const id = seed({ status: "FAILED", connectionId: "dev-pg", env: "DEV" });
    const ran = await post("author", `/${id}/revise`);
    expect(ran.body.status).toBe("EXECUTED");
    const next = seed({ status: "FAILED", connectionId: "dev-pg", env: "DEV" });
    h.executeWrite.mockRejectedValueOnce(preConnect());
    const down = await post("author", `/${next}/revise`);
    expect(down.status).toBe(503);
    expect(down.body.request.status).toBe("DRAFT");
  });

  it("keeps a migration's no-rollback flag on resubmit", async () => {
    const id = seed({ status: "REJECTED" });
    const res = await post("author", `/${id}/revise`, {
      writeSql: "VACUUM orders; ANALYZE orders",
      noTransaction: true,
    });
    expect(res.body).toMatchObject({
      isMigration: true,
      noTransaction: true,
      status: "PENDING",
    });
    expect(res.body.selectSql).toBeFalsy();
  });
});

describe("remaining branches", () => {
  const JOB_ID = JOB_TARGET.jobId;
  const job = (over: Partial<JobDetail> = {}): JobDetail => ({
    id: JOB_ID,
    name: "recalc due dates",
    engine: "agent",
    enabled: true,
    stepCount: 1,
    database: "app_core",
    steps: [
      {
        id: 1,
        name: "run proc",
        subsystem: "TSQL",
        command: "EXEC app_core.refresh_order_totals",
        database: "app_core",
      },
    ],
    schedules: [
      {
        id: "8",
        name: "s",
        enabled: true,
        description: "",
        sharedWith: 0,
        editable: true,
        msdb: {},
      },
    ],
    history: [],
    ...over,
  });
  const raise = (action: unknown, user = "author", connectionId = "qa-ms") =>
    post(user, "", {
      title: "Job",
      connectionId,
      jobChange: { jobId: JOB_ID, action },
    });

  it("treats a session without a job list as having no job rights", async () => {
    h.getJobDetail.mockResolvedValue(job());
    const res = await raise({ type: "rename", name: "x" }, "legacy");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("You are not allowed to change jobs in QA");
  });

  it("answers a job that isn't there", async () => {
    h.getJobDetail.mockResolvedValue(null);
    const res = await raise({ type: "rename", name: "x" });
    expect(res).toMatchObject({
      status: 404,
      body: { error: `No job ${JOB_ID} on this connection` },
    });
  });

  it("keeps only the fields each action has", async () => {
    h.getJobDetail.mockResolvedValue(job());
    const noCommand = await raise({ type: "edit_step", stepId: 1 });
    expect(noCommand.status).toBe(400);
    const msdb = await raise({
      type: "set_schedule",
      scheduleId: 8,
      msdb: {
        freq_type: 4,
        freq_interval: 1,
        freq_subday_type: 1,
        freq_subday_interval: 0,
        freq_recurrence_factor: 0,
        active_start_time: 10000,
        active_end_time: 235959,
        stray: "dropped",
      },
    });
    expect(msdb.status).toBe(201);
    expect(msdb.body.jobChange.action).toEqual({
      type: "set_schedule",
      scheduleId: "8",
      msdb: {
        freq_type: 4,
        freq_interval: 1,
        freq_subday_type: 1,
        freq_subday_interval: 0,
        freq_recurrence_factor: 0,
        active_start_time: 10000,
        active_end_time: 235959,
      },
    });
    h.getJobDetail.mockResolvedValue({
      ...job({ engine: "pg_cron" as any }),
      id: "42",
      schedules: [
        {
          id: "42",
          name: "s",
          enabled: true,
          description: "",
          sharedWith: 0,
          editable: true,
          cron: "0 * * * *",
        } as any,
      ],
    });
    const cron = await post("author", "", {
      title: "Job",
      connectionId: "qa-pg",
      jobChange: {
        jobId: "42",
        action: { type: "set_schedule", cron: "*/5 * * * *" },
      },
    });
    // No scheduleId sent: it is kept as "" and refused, never guessed.
    expect(cron.body.error).toBe("Schedule  is not attached to this job.");
  });

  it("never runs a job change over a job that changed or went away", async () => {
    h.getJobDetail.mockResolvedValue(job());
    const raised = await raise({ type: "rename", name: "renamed" });
    expect(raised.status).toBe(201);
    h.getJobDetail.mockResolvedValueOnce(job({ name: "edited meanwhile" }));
    const changed = await post("approver", `/${raised.body.id}/approve`);
    expect(changed.status).toBe(409);
    expect(changed.body).toMatchObject({ code: "OBJECT_CHANGED" });
    expect(changed.body.error).toMatch(/was changed by someone else/);
    h.getJobDetail.mockResolvedValueOnce(null);
    const gone = await post("approver", `/${raised.body.id}/approve`);
    expect(gone.body.error).toBe(
      "Job recalc due dates no longer exists — nothing ran.",
    );
    expect(store.getWriteRequest(raised.body.id)!.status).toBe("PENDING");
  });

  it("treats a job change that lost its job reference as a job gone", async () => {
    h.getJobDetail.mockResolvedValue(job());
    const raised = await raise({ type: "rename", name: "renamed" });
    const real = store.getWriteRequest(raised.body.id)!;
    vi.mocked(store.getWriteRequest).mockReturnValueOnce({
      ...real,
      jobChange: undefined,
    });
    h.getJobDetail.mockClear();
    const res = await post("approver", `/${raised.body.id}/approve`);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: "OBJECT_CHANGED",
      error: "Job  no longer exists — nothing ran.",
    });
    expect(h.getJobDetail).not.toHaveBeenCalled();
    expect(store.getWriteRequest(raised.body.id)!.status).toBe("PENDING");
  });

  it("treats an object created since a 'creates it' request as drift, and one still absent as none", async () => {
    const target = { schema: "app_core", name: "v", kind: "view" };
    const id = seed({
      kind: "object_change",
      isMigration: true,
      selectSql: undefined,
      writeSql: "CREATE OR REPLACE VIEW app_core.v AS SELECT 1",
      target,
      snapshot: "WAS THERE",
    });
    h.getObjectDefinition.mockResolvedValueOnce(null);
    const res = await post("approver", `/${id}/approve`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("OBJECT_CHANGED");
  });

  it("keeps a draft a draft when it is edited", async () => {
    const id = seed({ status: "DRAFT", connectionId: "dev-pg", env: "DEV" });
    const before = audits("WRITE_SAVE");
    const res = await post("author", `/${id}/revise`, { draft: true });
    expect(res.body.status).toBe("DRAFT");
    expect(res.body.events[0].event).toBe("SAVED");
    expect(h.executeWrite).not.toHaveBeenCalled();
    expect(audits("WRITE_SAVE")).toBe(before + 1);
  });

  it("leaves the database name out of the prompt when the connection has none", async () => {
    h.azureChat.mockResolvedValueOnce({
      content: JSON.stringify(REVIEW),
      model: "",
    });
    const res = await post("author", "/ai-review", {
      connectionId: "qa-es-nodb",
      selectSql: "GET /orders/_search",
      writeSql: 'POST /orders/_update_by_query {"query":{"match_all":{}}}',
    });
    expect(res.body.model).toBe("configured-model");
    const user = h.azureChat.mock.calls[0][1][1].content;
    expect(user).toContain("type: elasticsearch");
    expect(user).not.toContain("name:");
  });
});
