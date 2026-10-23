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
 * Execute-once while a direct write is in flight. The statement takes time on
 * the database; nothing anyone does meanwhile may run it a second time or
 * leave the request in a state that contradicts what happened.
 */

const dir = mkdtempSync(path.join(tmpdir(), "d-pilot-write-race-"));
vi.stubEnv("DATA_DIR", dir);
vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "");

const h = vi.hoisted(() => ({
  executeWrite: vi.fn(),
  validateSqlSyntax: vi.fn(async () => ({})),
}));
vi.mock("../services/write-executor.js", async (orig) => ({
  ...(await orig<typeof import("../services/write-executor.js")>()),
  executeWrite: h.executeWrite,
}));
vi.mock("../services/query-executor.js", async (orig) => ({
  ...(await orig<typeof import("../services/query-executor.js")>()),
  validateSqlSyntax: h.validateSqlSyntax,
}));

const store = await import("../services/sqlite-store.js");
const { default: writes } = await import("./write-requests.js");

store.initDatabase();
// DEV is direct-write by default: create, submit and revise run at once.
store.saveDbConnection({
  id: "dev-core",
  name: "DEV core",
  env: "DEV",
  type: "postgres" as const,
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
      isAdmin: sub === "admin",
      allowedEnvironments: ["DEV"],
      unmaskEnvironments: [],
      writeEnvironments: ["DEV"],
      approveEnvironments: ["DEV"],
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

beforeEach(() => {
  h.executeWrite.mockReset();
  h.executeWrite.mockResolvedValue(ok);
});

const ok = { rowsAffected: 1, executionMs: 1, transactional: true };
const body = {
  title: "Fix status",
  connectionId: "dev-core",
  selectSql: "SELECT * FROM orders WHERE id = 1",
  writeSql: "UPDATE orders SET status = 'placed' WHERE id = 1",
};
const refusedAtConnect = () =>
  Object.assign(new AggregateError([], ""), {
    code: "ECONNREFUSED",
    preConnect: true,
  });

const call = async (user: string, url: string, payload: unknown = {}) => {
  const res = await fetch(`${base}${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-user": user },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: (await res.json()) as any };
};

/** Makes the next write hang until the test settles it. */
function holdNextWrite() {
  let settle!: { resolve: (v: unknown) => void; reject: (e: unknown) => void };
  h.executeWrite.mockImplementationOnce(
    () => new Promise((resolve, reject) => (settle = { resolve, reject })),
  );
  return () => settle;
}

/** Starts a direct-write create and waits until its statement is in flight. */
async function createInFlight() {
  const held = holdNextWrite();
  const pending = call("author", "", body);
  await vi.waitFor(() => expect(h.executeWrite).toHaveBeenCalledTimes(1));
  const { id } = store
    .getDb()
    .prepare("SELECT id FROM write_requests ORDER BY rowid DESC")
    .get() as { id: string };
  return { id, pending, settle: held() };
}

const status = (id: string) => store.getWriteRequest(id)!.status;

describe("a direct write in flight", () => {
  it.each([
    ["approve", "approver", {}],
    ["override", "admin", { notes: "hotfix" }],
  ])("%s gets 409 and the write runs once", async (action, who, payload) => {
    const run = await createInFlight();
    const res = await call(who, `/${run.id}/${action}`, payload);
    expect(res.status).toBe(409);
    run.settle.resolve(ok);
    expect((await run.pending).status).toBe(201);
    expect(h.executeWrite).toHaveBeenCalledTimes(1);
    expect(status(run.id)).toBe("EXECUTED");
  });

  it("cancel gets 409 and the request ends EXECUTED", async () => {
    const run = await createInFlight();
    const res = await call("author", `/${run.id}/cancel`);
    expect(res.status).toBe(409);
    run.settle.resolve(ok);
    await run.pending;
    expect(status(run.id)).toBe("EXECUTED");
    const events = store.getWriteRequestEvents(run.id).map((e) => e.event);
    expect(events).not.toContain("CANCELLED");
  });

  it("a pre-connect failure still comes back a DRAFT with NOT_RUN", async () => {
    const run = await createInFlight();
    run.settle.reject(refusedAtConnect());
    const res = await run.pending;
    expect(res.status).toBe(503);
    expect(res.body.request.status).toBe("DRAFT");
    expect(status(run.id)).toBe("DRAFT");
    expect(store.getWriteRequestEvents(run.id)[0].event).toBe("NOT_RUN");
  });

  it("a release that loses its claim is not reported as a clean NOT_RUN", async () => {
    const run = await createInFlight();
    // Whatever moves the row meanwhile, the author must not be told "not run,
    // back to draft" about a request that is not a draft.
    store
      .getDb()
      .prepare("UPDATE write_requests SET status = 'REJECTED' WHERE id = ?")
      .run(run.id);
    run.settle.reject(refusedAtConnect());
    const res = await run.pending;
    expect(res.status).toBe(409);
    expect(res.body.request.status).toBe("REJECTED");
  });
});
