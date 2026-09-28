import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ConnectionConfig } from "../types/index.js";

/**
 * The `defaultLimit` contract every engine must honor — the toolbar's Limit
 * checkbox depends on all three states being distinct:
 *   number    → that many rows (capped at MAX_ROWS)
 *   null      → the user turned the limit off: MAX_ROWS
 *   undefined → no preference sent: the built-in 500
 * Mongo and Elasticsearch drivers are faked to record the limit that would
 * reach the database; the SQL engines are covered through the rewriters.
 */

// Read at import time, so pin it before loading the executor.
vi.stubEnv("MAX_ROWS", "1000");

const mongoLimits: number[] = [];
const cursor: any = {
  sort: () => cursor,
  skip: () => cursor,
  limit: (n: number) => (mongoLimits.push(n), cursor),
  toArray: async () => [],
};
vi.mock("mongodb", async (orig) => ({
  ...(await orig<typeof import("mongodb")>()),
  MongoClient: class {
    async connect() {}
    db() {
      return { collection: () => ({ find: () => cursor }) };
    }
  },
}));

const esSizes: (number | undefined)[] = [];
vi.mock("@elastic/elasticsearch", () => ({
  Client: class {
    async search(req: { size?: number }) {
      esSizes.push(req.size);
      return { hits: { hits: [], total: 0 } };
    }
  },
}));

const { executeQuery, applyDefaultLimit, applyDefaultLimitMssql } =
  await import("./query-executor.js");

const mongo = {
  id: "limit-mongo",
  type: "mongodb",
  env: "QA",
  uri: "mongodb://fake/app_core",
  database: "app_core",
} as ConnectionConfig;
const es = {
  id: "limit-es",
  type: "elasticsearch",
  env: "QA",
  uri: "http://fake:9200",
} as ConnectionConfig;

const CASES = [
  ["the chosen value", 200, 200],
  ["MAX_ROWS when the checkbox is off (null)", null, 1000],
  ["the built-in 500 when nothing is sent", undefined, 500],
  ["at most MAX_ROWS", 50000, 1000],
] as const;

beforeEach(() => {
  mongoLimits.length = 0;
  esSizes.length = 0;
});

describe.each(CASES)("defaultLimit → %s", (_, limit, rows) => {
  it("postgres appends LIMIT", () => {
    const sql = applyDefaultLimit("SELECT * FROM orders", limit);
    expect(sql).toBe(
      limit === null
        ? "SELECT * FROM orders"
        : `SELECT * FROM orders LIMIT ${rows}`,
    );
  });

  it("mssql injects TOP", () => {
    const sql = applyDefaultLimitMssql("SELECT * FROM orders", limit);
    expect(sql).toBe(
      limit === null
        ? "SELECT * FROM orders"
        : `SELECT TOP ${rows} * FROM orders`,
    );
  });

  it("mongo find limits the cursor", async () => {
    await executeQuery(mongo, 'db.orders.find({"status": 1})', limit);
    expect(mongoLimits).toEqual([rows]);
  });

  it("elasticsearch _search sets size", async () => {
    await executeQuery(
      es,
      'GET /orders/_search {"query":{"match_all":{}}}',
      limit,
    );
    expect(esSizes).toEqual([rows]);
  });

  it("elasticsearch bare index sets size", async () => {
    await executeQuery(es, "orders", limit);
    expect(esSizes).toEqual([rows]);
  });
});

describe("a limit written in the query wins over the checkbox", () => {
  it.each([
    ["postgres", applyDefaultLimit, "SELECT * FROM orders LIMIT 5"],
    [
      "postgres FETCH",
      applyDefaultLimit,
      "SELECT * FROM orders FETCH FIRST 5 ROWS ONLY",
    ],
    ["mssql", applyDefaultLimitMssql, "SELECT TOP 5 * FROM orders"],
  ])("%s", (_, apply, sql) => {
    expect(apply(sql, 200)).toBe(sql);
    expect(apply(sql, null)).toBe(sql);
  });

  it("mongo .limit(N)", async () => {
    await executeQuery(mongo, "db.orders.find({}).limit(5)", null);
    expect(mongoLimits).toEqual([5]);
  });

  it("mongo .limit(N) is still capped at MAX_ROWS", async () => {
    await executeQuery(mongo, "db.orders.find({}).limit(99999)", null);
    expect(mongoLimits).toEqual([1000]);
  });

  it("elasticsearch explicit size", async () => {
    await executeQuery(es, 'GET /orders/_search {"size": 5}', 200);
    expect(esSizes).toEqual([5]);
  });
});
