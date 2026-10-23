import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";

/**
 * A write request whose database can't be reached. The preview says so
 * (503 CONNECTION_FAILED) instead of passing the raw driver error through, and
 * a write that never reached the database is not FAILED: it stays runnable.
 * One that may have run (a timeout or reset after connecting) is FAILED.
 */

const dir = mkdtempSync(path.join(tmpdir(), "d-pilot-write-connection-"));
vi.stubEnv("DATA_DIR", dir);
vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "");

const refused = () =>
  Object.assign(new AggregateError([], ""), { code: "ECONNREFUSED" });

const h = vi.hoisted(() => ({
  executeQuery: vi.fn(),
  executeWrite: vi.fn(),
}));
vi.mock("../services/write-executor.js", async (orig) => ({
  ...(await orig<typeof import("../services/write-executor.js")>()),
  executeWrite: h.executeWrite,
}));
vi.mock("../services/query-executor.js", async (orig) => ({
  ...(await orig<typeof import("../services/query-executor.js")>()),
  validateSqlSyntax: async () => ({}),
  executeQuery: h.executeQuery,
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
    const envs = ["QA", "DEV"];
    req.user = {
      sub,
      email: `${sub}@example.com`,
      isAdmin: sub === "admin",
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

const call = async (user: string, url: string, body: unknown = {}) => {
  const res = await fetch(`${base}${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-user": user },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};

const submit = async (connectionId = "qa-core") => {
  const res = await call("author", "", {
    title: "Fix status",
    connectionId,
    selectSql: "SELECT * FROM orders WHERE id = 1",
    writeSql: "UPDATE orders SET status = 'placed' WHERE id = 1",
  });
  expect(res.body.status).toBe("PENDING");
  return res.body.id as string;
};

describe("POST /:id/preview against an unreachable database", () => {
  it("answers 503 CONNECTION_FAILED", async () => {
    const id = await submit();
    h.executeQuery.mockRejectedValueOnce(refused());
    const res = await call("approver", `/${id}/preview`);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("CONNECTION_FAILED");
    expect(res.body.error).toContain("the QA core (QA) database");
  });

  it("keeps a query error a 500", async () => {
    const id = await submit();
    h.executeQuery.mockRejectedValueOnce(new Error("column x does not exist"));
    const res = await call("approver", `/${id}/preview`);
    expect(res).toEqual({
      status: 500,
      body: { error: "column x does not exist" },
    });
  });
});

const ok = { rowsAffected: 1, executionMs: 1, transactional: true };
const status = (id: string) => store.getWriteRequest(id)!.status;
const auditCount = () =>
  store.getAuditLog({ action: "WRITE_EXECUTE_ERROR", limit: 1000 }).length;

describe("a write that never reached its database", () => {
  it.each([
    ["approve", "approver", {}],
    ["override", "admin", { notes: "hotfix" }],
  ])(
    "%s: stays PENDING, answers 503, is audited, and runs on the next try",
    async (action, who, body) => {
      const id = await submit();
      const audited = auditCount();
      h.executeWrite.mockRejectedValueOnce(refused());
      const res = await call(who, `/${id}/${action}`, body);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe("CONNECTION_FAILED");
      expect(res.body.error).toContain("the QA core (QA) database");
      expect(res.body.request.status).toBe("PENDING");
      expect(status(id)).toBe("PENDING");
      expect(auditCount()).toBe(audited + 1);

      h.executeWrite.mockResolvedValueOnce(ok);
      const retry = await call(who, `/${id}/${action}`, body);
      expect(retry.status).toBe(200);
      expect(status(id)).toBe("EXECUTED");
    },
  );

  it("a timeout after connecting is FAILED: it may have run", async () => {
    const id = await submit();
    const audited = auditCount();
    h.executeWrite.mockRejectedValueOnce(
      Object.assign(new Error("Query read timeout"), { afterSend: true }),
    );
    const res = await call("approver", `/${id}/approve`);
    expect(res.status).toBe(500);
    expect(status(id)).toBe("FAILED");
    expect(auditCount()).toBe(audited + 1);
  });

  it("even a refused connect is FAILED when raised after the statement was sent", async () => {
    const id = await submit();
    h.executeWrite.mockRejectedValueOnce(
      Object.assign(refused(), { afterSend: true }),
    );
    expect((await call("approver", `/${id}/approve`)).status).toBe(500);
    expect(status(id)).toBe("FAILED");
  });

  describe("on a direct-write environment", () => {
    // DEV is direct-write by default: create, submit and revise run at once.
    const dev = { ...qa, id: "dev-core", name: "DEV core", env: "DEV" };
    store.saveDbConnection(dev);
    const body = {
      title: "Fix status",
      connectionId: "dev-core",
      selectSql: "SELECT * FROM orders WHERE id = 1",
      writeSql: "UPDATE orders SET status = 'placed' WHERE id = 1",
    };

    it("create: comes back a DRAFT its author submits again to retry", async () => {
      const audited = auditCount();
      h.executeWrite.mockRejectedValueOnce(refused());
      const res = await call("author", "", body);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe("CONNECTION_FAILED");
      expect(res.body.error).toContain("the DEV core (DEV) database");
      const id = res.body.request.id as string;
      expect(status(id)).toBe("DRAFT");
      expect(auditCount()).toBe(audited + 1);

      h.executeWrite.mockResolvedValueOnce(ok);
      const retry = await call("author", `/${id}/submit`);
      expect(retry.status).toBe(200);
      expect(status(id)).toBe("EXECUTED");
    });

    it("submit: the draft stays a draft", async () => {
      const draft = await call("author", "", { ...body, draft: true });
      h.executeWrite.mockRejectedValueOnce(refused());
      const res = await call("author", `/${draft.body.id}/submit`);
      expect(res.status).toBe(503);
      expect(status(draft.body.id)).toBe("DRAFT");
    });

    it("revise: comes back a DRAFT too", async () => {
      h.executeWrite.mockRejectedValueOnce(new Error("syntax error"));
      const failed = await call("author", "", body);
      expect(failed.body.status).toBe("FAILED");
      h.executeWrite.mockRejectedValueOnce(refused());
      const res = await call("author", `/${failed.body.id}/revise`, {});
      expect(res.status).toBe(503);
      expect(status(failed.body.id)).toBe("DRAFT");
    });

    it("a reset after connecting is FAILED, as before", async () => {
      h.executeWrite.mockRejectedValueOnce(
        Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
      );
      const res = await call("author", "", body);
      expect(res.status).toBe(201);
      expect(res.body.status).toBe("FAILED");
    });
  });
});
