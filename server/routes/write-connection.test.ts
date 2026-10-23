import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";

/**
 * A write request whose database can't be reached. The preview says so
 * (503 CONNECTION_FAILED) instead of passing the raw driver error through.
 */

const dir = mkdtempSync(path.join(tmpdir(), "d-pilot-write-connection-"));
vi.stubEnv("DATA_DIR", dir);
vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "");

const refused = () =>
  Object.assign(new AggregateError([], ""), { code: "ECONNREFUSED" });

const h = vi.hoisted(() => ({
  executeQuery: vi.fn(),
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

const call = async (user: string, url: string, body: unknown = {}) => {
  const res = await fetch(`${base}${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-user": user },
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
