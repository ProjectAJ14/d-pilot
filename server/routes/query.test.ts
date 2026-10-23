import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";

/**
 * An unreachable database used to come back as a raw driver error with a 500,
 * so users and MCP agents rewrote correct SQL. It must be a 503 that says the
 * network, not the query, is the problem.
 */

const executeQuery = vi.fn();
const logAudit = vi.fn();

vi.mock("../services/query-executor.js", () => ({
  validateQuery: () => ({ valid: true }),
  executeQuery,
}));
vi.mock("../middleware/auth.js", () => ({
  resolveReadableConnection: () => ({
    id: "qa-core",
    name: "Orders",
    env: "QA",
  }),
}));
vi.mock("../services/sqlite-store.js", () => ({
  logAudit,
  getPhiMaskedEnvs: () => [],
  getQueryHistory: () => [],
}));
vi.mock("../config/settings.js", () => ({
  getConfig: (key: string) =>
    key === "NETWORK_HINT" ? "Connect to the VPN and retry." : undefined,
}));

const { default: router } = await import("./query.js");

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { sub: "u1", email: "u1@example.com", isAdmin: true } as any;
    next();
  });
  app.use("/query", router);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

const execute = () =>
  fetch(`${base}/query/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ connectionId: "qa-core", sql: "select 1" }),
  });

describe("POST /query/execute failures", () => {
  it("answers an unreachable database with 503 CONNECTION_FAILED", async () => {
    logAudit.mockClear();
    // pg's real shape for a refused localhost connect: empty message.
    executeQuery.mockRejectedValueOnce(
      Object.assign(new AggregateError([], ""), { code: "ECONNREFUSED" }),
    );
    const res = await execute();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("CONNECTION_FAILED");
    expect(body.error).toContain("D-Pilot is running");
    expect(body.error).toContain("Orders (QA)");
    expect(body.error).toContain("Connect to the VPN and retry.");
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "QUERY_ERROR" }),
    );
  });

  it("keeps a query error a 500 with the driver's message", async () => {
    executeQuery.mockRejectedValueOnce(
      Object.assign(new Error('relation "nope" does not exist'), {
        code: "42P01",
      }),
    );
    const res = await execute();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: 'relation "nope" does not exist',
      code: "42P01",
    });
  });
});
