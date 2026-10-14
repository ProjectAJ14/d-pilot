import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";

/**
 * An approved write runs on the target it was submitted against, or not at
 * all: editing where a connection points (or deleting and re-creating it under
 * the same id) after submission must not redirect the approved statement.
 */

const dir = mkdtempSync(path.join(tmpdir(), "d-pilot-write-target-"));
vi.stubEnv("DATA_DIR", dir);
vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "");

const executeWrite = vi.fn(async () => ({
  rowsAffected: 1,
  executionMs: 1,
  transactional: true,
}));
vi.mock("../services/write-executor.js", async (orig) => ({
  ...(await orig<typeof import("../services/write-executor.js")>()),
  executeWrite,
}));
// Runs once during the next request's (awaited) SQL validation.
const h = vi.hoisted(() => ({
  duringValidation: undefined as (() => void) | undefined,
}));
vi.mock("../services/query-executor.js", async (orig) => ({
  ...(await orig<typeof import("../services/query-executor.js")>()),
  validateSqlSyntax: async () => {
    const edit = h.duringValidation;
    h.duringValidation = undefined;
    edit?.();
    return {};
  },
}));

const store = await import("../services/sqlite-store.js");
const { default: writes } = await import("./write-requests.js");

store.initDatabase();
const qa = {
  id: "qa-core",
  name: "QA core",
  env: "QA",
  type: "postgres" as const,
  host: "db-a.example.com",
  database: "app_core",
  username: "app",
  password: "pw",
};
store.saveDbConnection(qa);

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const sub = req.headers["x-user"] as string;
    const envs = ((req.headers["x-envs"] as string) || "QA").split(",");
    req.user = {
      sub,
      email: `${sub}@example.com`,
      isAdmin: false,
      allowedEnvironments: envs,
      unmaskEnvironments: [],
      writeEnvironments: envs,
      approveEnvironments: envs,
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

const call = async (
  user: string,
  url: string,
  body: unknown = {},
  envs = "QA",
) => {
  const res = await fetch(`${base}${url}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-user": user,
      "x-envs": envs,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};

const submit = async () => {
  const res = await call("author", "", {
    title: "Fix status",
    connectionId: "qa-core",
    selectSql: "SELECT * FROM orders WHERE id = 1",
    writeSql: "UPDATE orders SET status = 'placed' WHERE id = 1",
  });
  expect(res.body.status).toBe("PENDING");
  return res.body.id as string;
};
const approve = (id: string) => call("approver", `/${id}/approve`);

describe("approving a write bound to its connection target", () => {
  it("refuses once the host changed, and the request stays pending", async () => {
    const id = await submit();
    store.saveDbConnection({ ...qa, host: "db-b.example.com", password: "pw" });
    const res = await approve(id);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Connection qa-core changed since/);
    expect(executeWrite).not.toHaveBeenCalled();
    expect(store.getWriteRequest(id)!.status).toBe("PENDING");

    // Resubmitting binds it to the current target, after which it runs.
    await call("author", `/${id}/cancel`);
    await call("author", `/${id}/revise`, {});
    expect((await approve(id)).status).toBe(200);
    expect(executeWrite).toHaveBeenCalledOnce();
    store.saveDbConnection(qa);
    executeWrite.mockClear();
  });

  it("refuses once only the default schema changed", async () => {
    // Postgres writes run under `SET search_path`, so the default schema
    // decides which table an unqualified UPDATE hits.
    store.saveDbConnection({ ...qa, schema: "app_core" });
    const id = await submit();
    store.saveDbConnection({ ...qa, schema: "archive" }, { password: true });
    expect((await approve(id)).status).toBe(409);
    expect(executeWrite).not.toHaveBeenCalled();
    store.saveDbConnection(qa);
  });

  it("runs after a rename — the name is not part of the target", async () => {
    const id = await submit();
    store.saveDbConnection(
      { ...qa, name: "QA core (renamed)" },
      {
        password: true,
      },
    );
    const res = await approve(id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("EXECUTED");
    executeWrite.mockClear();
  });

  it("refuses after the connection is deleted and re-created under the same id", async () => {
    const id = await submit();
    store.deleteDbConnection("qa-core");
    expect((await approve(id)).status).toBe(409);
    store.saveDbConnection(qa);
    const res = await approve(id);
    expect(res.status).toBe(409);
    expect(executeWrite).not.toHaveBeenCalled();
  });

  it("binds requests pending before the upgrade to their connection as of the upgrade", async () => {
    const id = await submit();
    // A database from before the column existed: drop it and migrate again.
    store
      .getDb()
      .exec("ALTER TABLE write_requests DROP COLUMN target_fingerprint");
    store.initDatabase();
    expect(store.getWriteRequestTarget(id)).not.toBeNull();
    store.saveDbConnection({ ...qa, host: "db-b.example.com", password: "pw" });
    expect((await approve(id)).status).toBe(409);
    expect(executeWrite).not.toHaveBeenCalled();
    store.saveDbConnection(qa);
  });

  it("binds drafts saved before the upgrade too, so they can still be submitted", async () => {
    const draftBody = {
      title: "Old draft",
      connectionId: "qa-core",
      selectSql: "SELECT * FROM orders WHERE id = 1",
      writeSql: "UPDATE orders SET status = 'placed' WHERE id = 1",
      draft: true,
    };
    const ok = (await call("author", "", draftBody)).body.id;
    const moved = (await call("author", "", draftBody)).body.id;
    store
      .getDb()
      .exec("ALTER TABLE write_requests DROP COLUMN target_fingerprint");
    store.initDatabase();
    const submitted = await call("author", `/${ok}/submit`);
    expect(submitted.status).toBe(200);
    expect(submitted.body.status).toBe("PENDING");
    // Edited after the upgrade: the draft is bound, so this is caught.
    store.saveDbConnection({ ...qa, host: "db-b.example.com", password: "pw" });
    expect((await call("author", `/${moved}/submit`)).status).toBe(409);
    store.saveDbConnection(qa);
  });

  it("never runs a pre-upgrade request whose connection was already gone", async () => {
    const id = await submit();
    store.deleteDbConnection("qa-core");
    store
      .getDb()
      .exec("ALTER TABLE write_requests DROP COLUMN target_fingerprint");
    store.initDatabase();
    expect(store.getWriteRequestTarget(id)).toBeNull();
    store.saveDbConnection(qa);
    expect((await approve(id)).status).toBe(409);
    expect(executeWrite).not.toHaveBeenCalled();
  });
});

describe("the request's env follows its connection", () => {
  const body = {
    title: "Fix status",
    connectionId: "qa-core",
    selectSql: "SELECT * FROM orders WHERE id = 1",
    writeSql: "UPDATE orders SET status = 'placed' WHERE id = 1",
  };

  it("refuses to submit a draft whose connection moved since it was saved", async () => {
    const draft = await call("author", "", { ...body, draft: true });
    expect(draft.body.status).toBe("DRAFT");
    store.saveDbConnection({ ...qa, env: "PROD" }, { password: true });
    const res = await call("author", `/${draft.body.id}/submit`, {}, "QA,PROD");
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/revise it/);
    expect(store.getWriteRequest(draft.body.id)!.status).toBe("DRAFT");
    expect(executeWrite).not.toHaveBeenCalled();
    store.saveDbConnection(qa);
  });

  it("stores the new env on revise, so approval is judged there", async () => {
    const id = await submit();
    await call("author", `/${id}/cancel`);
    store.saveDbConnection({ ...qa, env: "PROD" }, { password: true });
    // A QA-only author can no longer revise it...
    expect((await call("author", `/${id}/revise`, {})).status).toBe(403);
    // ...one with PROD rights can, and the request is now a PROD request.
    const revised = await call("author", `/${id}/revise`, {}, "QA,PROD");
    expect(revised.status).toBe(200);
    expect(store.getWriteRequest(id)!.env).toBe("PROD");
    expect((await approve(id)).status).toBe(403);
    expect(executeWrite).not.toHaveBeenCalled();
    store.saveDbConnection(qa);
  });

  it("refuses when the connection is edited while the request is validated", async () => {
    // DEV is direct-write, so a create would run at once.
    const dev = { ...qa, id: "dev-core", env: "DEV" };
    store.saveDbConnection(dev);
    h.duringValidation = () =>
      store.saveDbConnection({ ...dev, host: "db-b.example.com" });
    const res = await call(
      "author",
      "",
      { ...body, connectionId: "dev-core" },
      "DEV",
    );
    expect(res.status).toBe(409);
    expect(executeWrite).not.toHaveBeenCalled();
    // Refused before the insert, so retrying cannot leave a duplicate.
    expect(
      store
        .getDb()
        .prepare(
          "SELECT COUNT(*) AS n FROM write_requests WHERE connection_id = ?",
        )
        .get("dev-core"),
    ).toEqual({ n: 0 });
    store.deleteDbConnection("dev-core");
  });
});
