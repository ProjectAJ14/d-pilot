import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";

/**
 * Export re-runs the query server-side, so it must run it with the same limit
 * the user sees in the toolbar. It once dropped `defaultLimit` and every export
 * came back capped at 500 rows. Drive the real router; fake only what sits
 * behind it.
 */

const executeQuery = vi.fn(async () => ({
  columns: ["id"],
  rows: [{ id: 1 }],
  totalRows: 1,
  executionTimeMs: 1,
  truncated: false,
}));

vi.mock("../services/query-executor.js", () => ({
  validateQuery: () => ({ valid: true }),
  executeQuery,
}));
vi.mock("../middleware/auth.js", () => ({
  resolveReadableConnection: () => ({ id: "qa-core", env: "QA" }),
}));
vi.mock("../services/sqlite-store.js", () => ({
  logAudit: () => {},
  getPhiMaskedEnvs: () => [],
}));
vi.mock("../services/phi-masking.js", () => ({
  maskQueryResults: (columns: { name: string }[], rows: unknown[]) => ({
    maskedColumns: columns.map((c) =>
      typeof c === "string" ? { name: c } : c,
    ),
    maskedRows: rows,
  }),
}));

const { default: router } = await import("./export.js");

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { sub: "u1", email: "u1@example.com", isAdmin: true } as any;
    next();
  });
  app.use("/export", router);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

describe.each(["csv", "json"])("POST /export/%s", (format) => {
  it.each([
    ["the chosen limit", 2000],
    ["null when the checkbox is off", null],
  ])("forwards %s to executeQuery", async (_, defaultLimit) => {
    executeQuery.mockClear();
    const res = await fetch(`${base}/export/${format}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        connectionId: "qa-core",
        sql: "select 1",
        defaultLimit,
      }),
    });
    expect(res.status).toBe(200);
    expect(executeQuery).toHaveBeenCalledWith(
      expect.anything(),
      "select 1",
      defaultLimit,
    );
  });
});
