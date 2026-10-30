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

/**
 * object_change requests: a new definition for a procedure, function, view or
 * trigger, reviewed against the version deployed when it was submitted, and
 * never run over a version nobody reviewed.
 */

const dir = mkdtempSync(path.join(tmpdir(), "d-pilot-object-change-"));
vi.stubEnv("DATA_DIR", dir);
vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "");

const h = vi.hoisted(() => ({
  executeMigration: vi.fn(),
  deployed: null as string | null | undefined,
}));
vi.mock("../services/write-executor.js", async (orig) => ({
  ...(await orig<typeof import("../services/write-executor.js")>()),
  executeMigration: h.executeMigration,
}));
vi.mock("../services/query-executor.js", async (orig) => ({
  ...(await orig<typeof import("../services/query-executor.js")>()),
  validateSqlSyntax: vi.fn(async () => ({})),
}));
// What the database holds for the object: undefined = no such object,
// null = present but hidden.
vi.mock("../services/schema-objects.js", async (orig) => ({
  ...(await orig<typeof import("../services/schema-objects.js")>()),
  getObjectDefinition: vi.fn(async (_c: unknown, o: any) =>
    h.deployed === undefined ? null : { ...o, definition: h.deployed },
  ),
}));

const store = await import("../services/sqlite-store.js");
const { default: writes } = await import("./write-requests.js");

store.initDatabase();
store.saveDbConnection({
  id: "qa-ms",
  name: "QA core",
  env: "QA",
  type: "mssql" as const,
  host: "db-a.example.com",
  database: "app_core",
  username: "app",
  password: "pw",
});

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const sub = req.headers["x-user"] as string;
    req.user = {
      sub,
      email: `${sub}@example.com`,
      isAdmin: false,
      allowedEnvironments: ["QA"],
      unmaskEnvironments: [],
      writeEnvironments: ["QA"],
      approveEnvironments: ["QA"],
    } as any;
    next();
  });
  app.use("/writes", writes);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/writes`;
});

afterAll(() => {
  server.close();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const V1 =
  "CREATE PROCEDURE app_core.refresh_order_totals AS\nBEGIN\n  SELECT 1;\nEND";
const V2 =
  "CREATE OR ALTER PROCEDURE app_core.refresh_order_totals AS\nBEGIN\n  UPDATE app_core.orders SET due_date = GETDATE() WHERE status = 'placed';\nEND";
const object = {
  schema: "app_core",
  name: "refresh_order_totals",
  kind: "procedure",
  stray: "dropped",
};

beforeEach(() => {
  h.deployed = V1;
  h.executeMigration.mockReset();
  h.executeMigration.mockResolvedValue({
    rowsAffected: 0,
    executionMs: 1,
    transactional: true,
  });
});

const call = async (user: string, url: string, payload: unknown = {}) => {
  const res = await fetch(`${base}${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-user": user },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: (await res.json()) as any };
};
const create = (writeSql = V2) =>
  call("author", "", {
    title: "Fix due dates",
    connectionId: "qa-ms",
    writeSql,
    object,
  });

describe("object_change", () => {
  it("stores the object and the deployed definition, and waits for approval", async () => {
    const { status, body } = await create();
    expect(status).toBe(201);
    expect(body).toMatchObject({
      kind: "object_change",
      status: "PENDING",
      isMigration: true,
      noTransaction: false,
      snapshot: V1,
      object: {
        schema: "app_core",
        name: "refresh_order_totals",
        kind: "procedure",
      },
    });
    expect(body.object).not.toHaveProperty("stray");
    expect(body.events[0].notes).toBe(
      "Changes procedure app_core.refresh_order_totals",
    );
    expect(h.executeMigration).not.toHaveBeenCalled();
  });

  it("refuses to run over a version changed since submit, and leaves it PENDING", async () => {
    const { body } = await create();
    h.deployed = V1.replace("SELECT 1", "SELECT 42"); // someone else's hotfix
    const res = await call("approver", `/${body.id}/approve`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("OBJECT_CHANGED");
    expect(h.executeMigration).not.toHaveBeenCalled();
    expect(store.getWriteRequest(body.id)!.status).toBe("PENDING");
  });

  it("runs when only line endings or trailing spaces differ", async () => {
    const { body } = await create();
    h.deployed = V1.replace(/\n/g, "  \r\n");
    const res = await call("approver", `/${body.id}/approve`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("EXECUTED");
    expect(h.executeMigration).toHaveBeenCalledWith(
      expect.objectContaining({ id: "qa-ms" }),
      V2,
      { noTransaction: false },
    );
  });

  it("guards a new object too: created meanwhile is drift", async () => {
    h.deployed = undefined;
    const { body } = await create();
    expect(body.snapshot).toBeNull();
    expect(body.events[0].notes).toMatch(/^Creates/);
    h.deployed = "CREATE PROCEDURE app_core.refresh_order_totals AS SELECT 0";
    expect((await call("approver", `/${body.id}/approve`)).status).toBe(409);
  });

  it("re-bases on what is deployed when revised", async () => {
    const { body } = await create();
    await call("approver", `/${body.id}/reject`, { notes: "drifted" });
    h.deployed = "CREATE PROCEDURE app_core.refresh_order_totals AS SELECT 42";
    const revised = await call("author", `/${body.id}/revise`, {
      writeSql: V2,
    });
    expect(revised.status).toBe(200);
    expect(revised.body.snapshot).toBe(h.deployed);
    expect((await call("approver", `/${body.id}/approve`)).status).toBe(200);
  });

  it.each([
    ["a hidden deployed definition", () => (h.deployed = null), V2, "hidden"],
    [
      "a definition for another object",
      () => {},
      V2.replace("refresh_order_totals", "drop_everything"),
      "must create app_core.refresh_order_totals",
    ],
    [
      "a plain CREATE",
      () => {},
      V2.replace("CREATE OR ALTER", "CREATE"),
      "CREATE OR ALTER",
    ],
  ])("refuses %s", async (_n, arrange, sql, why) => {
    arrange();
    const { status, body } = await create(sql);
    expect(status).toBe(400);
    expect(body.error).toContain(why);
  });

  it("flags a credential in the new definition", async () => {
    const { body } = await create(
      V2.replace("SELECT", "SELECT").replace(
        "UPDATE",
        "DECLARE @c nvarchar(99) = 'Server=x;Pwd=Hunter22';\n  UPDATE",
      ),
    );
    expect(body.warnings).toHaveLength(1);
  });
});
