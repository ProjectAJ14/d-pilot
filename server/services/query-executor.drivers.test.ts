import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ConnectionConfig } from "../types/index.js";

/**
 * The read path end to end against faked drivers: each engine's executor,
 * the syntax check, the connection tester and the pool status. Every driver
 * records what would reach the database; nothing touches a network.
 */

const h = vi.hoisted(() => ({
  pgQuery: null as unknown as (sql: string) => unknown,
  pgClientQuery: null as unknown as (sql: string) => unknown,
  pgSent: [] as string[],
  pgReleased: 0,
  pgEnded: 0,
  msQuery: null as unknown as (sql: string) => unknown,
  msBatch: null as unknown as (sql: string) => unknown,
  msSent: [] as string[],
  msClosed: 0,
  msConnected: true,
  mongoRows: [] as Record<string, unknown>[],
  mongoDoc: null as Record<string, unknown> | null,
  mongoDistinct: [] as unknown[],
  mongoCount: 0,
  mongoCalls: [] as { op: string; args: unknown[] }[],
  mongoDbNames: [] as (string | undefined)[],
  mongoClosed: 0,
  mongoPinged: 0,
  esSearch: null as unknown as (req: any) => unknown,
  esCount: null as unknown as (req: any) => unknown,
  esCalls: [] as { op: string; req: any }[],
  esOptions: [] as any[],
  esClosed: 0,
}));

vi.mock("pg", async () => {
  const { EventEmitter } = await import("node:events");
  class Pool extends EventEmitter {
    totalCount = 3;
    idleCount = 2;
    async query(sql: string) {
      h.pgSent.push(sql);
      return h.pgQuery(sql);
    }
    async connect() {
      return {
        query: async (sql: string) => {
          h.pgSent.push(sql);
          return h.pgClientQuery(sql);
        },
        release: () => void h.pgReleased++,
      };
    }
    async end() {
      h.pgEnded++;
    }
  }
  return { default: { Pool } };
});

vi.mock("mssql", async () => {
  const { EventEmitter } = await import("node:events");
  class ConnectionPool extends EventEmitter {
    connected = h.msConnected;
    size = 4;
    available = 1;
    async connect() {
      return this;
    }
    async close() {
      h.msClosed++;
    }
    request() {
      return {
        query: async (sql: string) => (h.msSent.push(sql), h.msQuery(sql)),
        batch: async (sql: string) => (h.msSent.push(sql), h.msBatch(sql)),
      };
    }
  }
  return { default: { ConnectionPool } };
});

vi.mock("mongodb", async (orig) => {
  const cursor = (calls: { op: string; args: unknown[] }[]): any => ({
    sort: (...a: unknown[]) => (
      calls.push({ op: "sort", args: a }),
      cursor(calls)
    ),
    skip: (...a: unknown[]) => (
      calls.push({ op: "skip", args: a }),
      cursor(calls)
    ),
    limit: (...a: unknown[]) => (
      calls.push({ op: "limit", args: a }),
      cursor(calls)
    ),
    toArray: async () => h.mongoRows,
  });
  return {
    ...(await orig<typeof import("mongodb")>()),
    MongoClient: class {
      async connect() {
        return this;
      }
      async close() {
        h.mongoClosed++;
      }
      db(name?: string) {
        h.mongoDbNames.push(name);
        const c = h.mongoCalls;
        return {
          admin: () => ({ ping: async () => void h.mongoPinged++ }),
          collection: (coll: string) => ({
            find: (...a: unknown[]) => (
              c.push({ op: `find:${coll}`, args: a }),
              cursor(c)
            ),
            aggregate: (...a: unknown[]) => (
              c.push({ op: "aggregate", args: a }),
              cursor(c)
            ),
            countDocuments: async (...a: unknown[]) => (
              c.push({ op: "countDocuments", args: a }),
              h.mongoCount
            ),
            findOne: async (...a: unknown[]) => (
              c.push({ op: "findOne", args: a }),
              h.mongoDoc
            ),
            distinct: async (...a: unknown[]) => (
              c.push({ op: "distinct", args: a }),
              h.mongoDistinct
            ),
          }),
        };
      }
    },
  };
});

vi.mock("@elastic/elasticsearch", () => ({
  Client: class {
    constructor(opts: any) {
      h.esOptions.push(opts);
    }
    async search(req: any) {
      h.esCalls.push({ op: "search", req });
      return h.esSearch(req);
    }
    async count(req: any) {
      h.esCalls.push({ op: "count", req });
      return h.esCount(req);
    }
    async ping() {}
    async close() {
      h.esClosed++;
    }
  },
}));

const {
  executeQuery,
  validateSqlSyntax,
  isReadQuery,
  applyDefaultLimit,
  applyDefaultLimitMssql,
  testConnection,
  testConnectionConfig,
  getPoolStatus,
  getMssqlPool,
  holdClient,
  closeConnectionPool,
  parseMongoJson,
} = await import("./query-executor.js");

let seq = 0;
const conn = (over: Partial<ConnectionConfig>): ConnectionConfig => ({
  id: `drv-${++seq}`,
  name: "test",
  env: "DEV",
  type: "postgres",
  host: "127.0.0.1",
  database: "app_core",
  ...over,
});

beforeEach(() => {
  h.pgQuery = () => ({ rows: [], fields: [] });
  h.pgClientQuery = () => ({ rows: [] });
  h.pgSent.length = 0;
  h.pgReleased = 0;
  h.pgEnded = 0;
  h.msQuery = () => ({ recordset: [] });
  h.msBatch = () => ({});
  h.msSent.length = 0;
  h.msClosed = 0;
  h.msConnected = true;
  h.mongoRows = [];
  h.mongoDoc = null;
  h.mongoDistinct = [];
  h.mongoCount = 0;
  h.mongoCalls.length = 0;
  h.mongoDbNames.length = 0;
  h.mongoClosed = 0;
  h.mongoPinged = 0;
  h.esSearch = () => ({ hits: { hits: [], total: 0 } });
  h.esCount = () => ({ count: 0 });
  h.esCalls.length = 0;
  h.esOptions.length = 0;
  h.esClosed = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("isReadQuery", () => {
  it("accepts only SELECT/WITH on the SQL engines", () => {
    expect(isReadQuery("  ", "postgres")).toBe(false);
    expect(isReadQuery("SELECT 1", "postgres")).toBe(true);
    expect(isReadQuery("with x as (select 1) select * from x", "mssql")).toBe(
      true,
    );
    expect(isReadQuery("UPDATE orders SET a = 1", "mssql")).toBe(false);
  });

  it("accepts only read operations on Mongo", () => {
    expect(isReadQuery("db.orders.find({})", "mongodb")).toBe(true);
    expect(isReadQuery("db.orders.distinct ('a')", "mongodb")).toBe(true);
    expect(isReadQuery("db.orders.deleteMany({})", "mongodb")).toBe(false);
  });

  it("accepts search/count or a bare index name on Elasticsearch", () => {
    expect(isReadQuery("GET /orders/_search {}", "elasticsearch")).toBe(true);
    expect(isReadQuery("orders/_COUNT", "elasticsearch")).toBe(true);
    expect(isReadQuery("orders-2024.*", "elasticsearch")).toBe(true);
    expect(isReadQuery("POST /orders/_doc {}", "elasticsearch")).toBe(false);
  });

  it("does not judge an engine it has no rule for", () => {
    expect(isReadQuery("anything", "other" as never)).toBe(true);
  });
});

describe("applyDefaultLimit", () => {
  it("leaves a query that already has TOP alone", () => {
    expect(applyDefaultLimit("SELECT TOP 5 * FROM orders")).toBe(
      "SELECT TOP 5 * FROM orders",
    );
  });
});

describe("applyDefaultLimitMssql", () => {
  it("injects TOP into a SELECT without one", () => {
    expect(applyDefaultLimitMssql("SELECT * FROM orders;", 20)).toBe(
      "SELECT TOP 20 * FROM orders",
    );
    expect(applyDefaultLimitMssql("SELECT * FROM orders")).toBe(
      "SELECT TOP 500 * FROM orders",
    );
  });

  it("leaves non-SELECTs, existing limits and an opted-out limit alone", () => {
    for (const sql of [
      "WITH x AS (SELECT 1 a) SELECT * FROM x",
      "SELECT TOP 3 * FROM orders",
      "SELECT * FROM orders LIMIT 3",
      "SELECT * FROM orders ORDER BY id OFFSET 0 ROWS FETCH NEXT 5 ROWS ONLY",
    ])
      expect(applyDefaultLimitMssql(sql, 10)).toBe(sql);
    expect(applyDefaultLimitMssql("SELECT * FROM orders", null)).toBe(
      "SELECT * FROM orders",
    );
  });
});

describe("validateSqlSyntax", () => {
  it("refuses an empty statement without connecting", async () => {
    expect(await validateSqlSyntax(conn({}), " ; ")).toEqual({
      checked: true,
      error: "Query cannot be empty",
    });
    expect(h.pgSent).toEqual([]);
  });

  it("EXPLAINs on Postgres inside a rolled-back transaction", async () => {
    const r = await validateSqlSyntax(conn({}), "SELECT * FROM orders;");
    expect(r).toEqual({ checked: true });
    expect(h.pgSent).toEqual([
      "BEGIN",
      "EXPLAIN SELECT * FROM orders",
      "ROLLBACK",
    ]);
    expect(h.pgReleased).toBe(1);
  });

  it("sets the active schema first: the override, else the connection's", async () => {
    await validateSqlSyntax(conn({ schema: "sales" }), "SELECT 1", "billing");
    expect(h.pgSent[1]).toBe('SET search_path TO "billing"');
    h.pgSent.length = 0;
    await validateSqlSyntax(conn({ schema: " sales " }), "SELECT 1");
    expect(h.pgSent[1]).toBe('SET search_path TO "sales"');
    h.pgSent.length = 0;
    // A blank schema means "no schema", not an empty identifier.
    await validateSqlSyntax(conn({ schema: "  " }), "SELECT 1");
    expect(h.pgSent).toEqual(["BEGIN", "EXPLAIN SELECT 1", "ROLLBACK"]);
  });

  it("reports the parser's error and still releases when ROLLBACK fails", async () => {
    h.pgClientQuery = (sql) => {
      if (sql.startsWith("EXPLAIN"))
        throw new Error('relation "nope" does not exist');
      if (sql === "ROLLBACK") throw new Error("connection gone");
      return {};
    };
    expect(await validateSqlSyntax(conn({}), "SELECT * FROM nope")).toEqual({
      checked: true,
      error: 'relation "nope" does not exist',
    });
    expect(h.pgReleased).toBe(1);
  });

  it("reports a non-Error throw as text", async () => {
    h.pgClientQuery = (sql) => {
      if (sql.startsWith("EXPLAIN")) throw "bad syntax";
      return {};
    };
    expect(await validateSqlSyntax(conn({}), "SELEC 1")).toEqual({
      checked: true,
      error: "bad syntax",
    });
  });

  it("does not block on an unreachable database", async () => {
    h.pgClientQuery = () => {
      throw Object.assign(new Error("connect ECONNREFUSED"), {
        code: "ECONNREFUSED",
      });
    };
    expect(await validateSqlSyntax(conn({}), "SELECT 1")).toEqual({
      checked: false,
    });
  });

  it("uses PARSEONLY on SQL Server", async () => {
    const r = await validateSqlSyntax(
      conn({ type: "mssql" }),
      "SELECT * FROM orders",
    );
    expect(r).toEqual({ checked: true });
    expect(h.msSent).toEqual([
      "SET PARSEONLY ON;\nSELECT * FROM orders\n;SET PARSEONLY OFF;",
    ]);
  });

  it("leaves Mongo and Elasticsearch to execution time", async () => {
    expect(
      await validateSqlSyntax(conn({ type: "mongodb" }), "db.orders.find({})"),
    ).toEqual({ checked: false });
  });
});

describe("executeQuery (postgres)", () => {
  it("injects the default limit and returns columns and rows", async () => {
    h.pgQuery = () => ({
      rows: [{ id: 1 }, { id: 2 }],
      fields: [{ name: "id" }],
    });
    const r = await executeQuery(conn({}), "SELECT id FROM orders", 10);
    expect(h.pgSent).toEqual(["SELECT id FROM orders LIMIT 10"]);
    expect(r).toMatchObject({
      columns: ["id"],
      rows: [{ id: 1 }, { id: 2 }],
      totalRows: 2,
      truncated: false,
    });
  });

  it("prefixes search_path and reads the last result of the batch", async () => {
    h.pgQuery = () => [
      { rows: [], fields: [] },
      { rows: [{ name: "a" }], fields: [{ name: "name" }] },
    ];
    const r = await executeQuery(
      conn({}),
      "SELECT name FROM customers",
      null,
      "sales",
    );
    expect(h.pgSent).toEqual([
      'SET search_path TO "sales"; SELECT name FROM customers',
    ]);
    expect(r.rows).toEqual([{ name: "a" }]);
  });

  it("refuses an unsafe schema name instead of interpolating it", async () => {
    await expect(
      executeQuery(conn({}), "SELECT 1", null, 'x"; DROP TABLE orders; --'),
    ).rejects.toThrow(/Invalid schema name/);
    expect(h.pgSent).toEqual([]);
  });

  it("tolerates a result with no rows or fields", async () => {
    h.pgQuery = () => ({});
    const r = await executeQuery(conn({}), "SELECT 1");
    expect(r).toMatchObject({ columns: [], rows: [], totalRows: 0 });
  });

  it("caps rows at MAX_ROWS and flags the result truncated", async () => {
    vi.stubEnv("MAX_ROWS", "2");
    try {
      h.pgQuery = () => ({
        rows: [{ id: 1 }, { id: 2 }, { id: 3 }],
        fields: [{ name: "id" }],
      });
      const r = await executeQuery(conn({}), "SELECT id FROM orders LIMIT 3");
      expect(r.rows).toHaveLength(2);
      expect(r.truncated).toBe(true);
      expect(r.totalRows).toBe(3);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("executeQuery (mssql)", () => {
  it("translates a trailing LIMIT to TOP", async () => {
    h.msQuery = () => ({ recordset: [{ id: 1, name: "a" }] });
    const r = await executeQuery(
      conn({ type: "mssql" }),
      "SELECT id, name FROM orders LIMIT 7;",
    );
    expect(h.msSent).toEqual(["SELECT TOP 7 id, name FROM orders"]);
    expect(r).toMatchObject({ columns: ["id", "name"], totalRows: 1 });
  });

  it("injects TOP when there is no limit, and leaves TOP or non-SELECTs alone", async () => {
    const c = conn({ type: "mssql" });
    await executeQuery(c, "SELECT * FROM orders", 5);
    await executeQuery(c, "SELECT TOP 2 * FROM orders LIMIT 9");
    await executeQuery(c, "SELECT * FROM orders WHERE id > 0 ");
    await executeQuery(c, "WITH x AS (SELECT 1 a) SELECT * FROM x");
    expect(h.msSent).toEqual([
      "SELECT TOP 5 * FROM orders",
      "SELECT TOP 2 * FROM orders LIMIT 9",
      "SELECT TOP 500 * FROM orders WHERE id > 0",
      "WITH x AS (SELECT 1 a) SELECT * FROM x",
    ]);
  });

  it("tolerates a result with no recordset", async () => {
    h.msQuery = () => ({});
    const r = await executeQuery(conn({ type: "mssql" }), "SELECT 1");
    expect(r).toMatchObject({ columns: [], rows: [], totalRows: 0 });
  });

  it("defaults the server to localhost:1433", async () => {
    const { default: mssql } = await import("mssql");
    const seen: any[] = [];
    const Orig = mssql.ConnectionPool;
    vi.spyOn(mssql, "ConnectionPool").mockImplementation(function (cfg: any) {
      seen.push(cfg);
      return new Orig(cfg);
    } as any);
    await executeQuery(
      conn({ type: "mssql", host: undefined, port: undefined }),
      "SELECT 1",
    );
    expect(seen[0]).toMatchObject({ server: "localhost", port: 1433 });
  });

  it("reuses a connected pool and reconnects a dropped one", async () => {
    const c = conn({ type: "mssql" });
    const first = await getMssqlPool(c);
    expect(await getMssqlPool(c)).toBe(first);
    (first as { connected: boolean }).connected = false;
    expect(await getMssqlPool(c)).not.toBe(first);
  });
});

describe("executeQuery (unsupported engine)", () => {
  it("throws rather than guessing", async () => {
    await expect(
      executeQuery(conn({ type: "oracle" as never }), "SELECT 1"),
    ).rejects.toThrow("Unsupported database type: oracle");
  });
});

describe("executeQuery (mongodb)", () => {
  it("names the database from the connection, the URI, or 'test'", async () => {
    await executeQuery(conn({ type: "mongodb" }), "db.orders.find({})");
    await executeQuery(
      conn({
        type: "mongodb",
        database: undefined,
        uri: "mongodb://h:27017/customers?tls=true",
      }),
      "db.orders.find({})",
    );
    await executeQuery(
      conn({ type: "mongodb", database: undefined, uri: "mongodb://h/" }),
      "db.orders.find({})",
    );
    await executeQuery(
      conn({ type: "mongodb", database: undefined, host: "h" }),
      "db.orders.find({})",
    );
    expect(h.mongoDbNames).toEqual(["app_core", "customers", "test", "test"]);
  });

  it("refuses text that is not a supported operation", async () => {
    await expect(
      executeQuery(conn({ type: "mongodb" }), "show collections"),
    ).rejects.toThrow(/MongoDB queries must be in format/);
  });

  it("applies sort, skip and limit to find, and reports columns", async () => {
    h.mongoRows = [{ _id: 1, status: "open" }];
    const r = await executeQuery(
      conn({ type: "mongodb" }),
      'db.orders.find().sort({"created": -1}).skip(20).limit(5)',
    );
    expect(h.mongoCalls).toEqual([
      { op: "find:orders", args: [{}, undefined] },
      { op: "sort", args: [{ created: -1 }] },
      { op: "skip", args: [20] },
      { op: "limit", args: [5] },
    ]);
    expect(r.columns).toEqual(["_id", "status"]);
    expect(r.truncated).toBe(false);
  });

  it("wraps a single aggregate stage in a pipeline", async () => {
    await executeQuery(
      conn({ type: "mongodb" }),
      'db.orders.aggregate({"$match": {"status": "open"}})',
    );
    expect(h.mongoCalls[0]).toEqual({
      op: "aggregate",
      args: [[{ $match: { status: "open" } }]],
    });
  });

  it("counts documents", async () => {
    h.mongoCount = 42;
    const r = await executeQuery(
      conn({ type: "mongodb" }),
      'db.orders.countDocuments({"status": "open"})',
    );
    expect(r.rows).toEqual([{ count: 42 }]);
    expect(r.columns).toEqual(["count"]);
  });

  it("returns the one document findOne finds", async () => {
    h.mongoDoc = { _id: 7, total: 10 };
    const r = await executeQuery(
      conn({ type: "mongodb" }),
      'db.orders.findOne({"_id": 7})',
    );
    expect(r.rows).toEqual([{ _id: 7, total: 10 }]);
  });

  it("returns distinct values as one-column rows", async () => {
    h.mongoDistinct = ["open", "closed"];
    const r = await executeQuery(
      conn({ type: "mongodb" }),
      'db.orders.distinct("status")',
    );
    expect(r.rows).toEqual([{ status: "open" }, { status: "closed" }]);
  });

  it("requires distinct's field to be a non-empty string", async () => {
    for (const q of [
      "db.orders.distinct({})",
      'db.orders.distinct("")',
      "db.orders.distinct()",
    ])
      await expect(executeQuery(conn({ type: "mongodb" }), q)).rejects.toThrow(
        /distinct requires a field name/,
      );
  });
});

describe("executeQuery (elasticsearch)", () => {
  const es = (over: Partial<ConnectionConfig> = {}) =>
    conn({ type: "elasticsearch", port: undefined, ...over });

  it("counts with _count", async () => {
    h.esCount = () => ({ count: 9 });
    const r = await executeQuery(
      es(),
      'GET /orders/_count {"query": {"term": {"status": "open"}}}',
    );
    expect(h.esCalls).toEqual([
      {
        op: "count",
        req: { index: "orders", query: { term: { status: "open" } } },
      },
    ]);
    expect(r).toMatchObject({ rows: [{ count: 9 }], truncated: false });
  });

  it("searches with match_all and the default size when no body is given", async () => {
    h.esSearch = () => ({
      hits: {
        hits: [{ _id: "1", _index: "orders", _score: 1, _source: { a: 1 } }],
        total: { value: 3 },
      },
    });
    const r = await executeQuery(es(), "orders/_search", 25);
    expect(h.esCalls[0].req).toEqual({
      index: "orders",
      query: { match_all: {} },
      size: 25,
    });
    expect(r.columns).toEqual(["_id", "_index", "_score", "a"]);
    expect(r.truncated).toBe(true);
  });

  it("keeps a size the body sets, including 0", async () => {
    await executeQuery(es(), 'POST /orders/_search {"size": 0}');
    await executeQuery(es(), 'GET /orders/_search {"size": 3}');
    expect(h.esCalls.map((c) => c.req.size)).toEqual([0, 3]);
  });

  it("falls back to the hit count when the total is missing", async () => {
    h.esSearch = () => ({ hits: { hits: undefined } });
    const r = await executeQuery(es(), "GET /orders/_search");
    expect(r).toMatchObject({ rows: [], columns: [], truncated: false });
    h.esSearch = () => ({ hits: { hits: [{ _id: "1" }], total: 1 } });
    const r2 = await executeQuery(es(), "GET /orders/_search");
    expect(r2.truncated).toBe(false);
  });

  it("lists the first documents of a bare index name", async () => {
    h.esSearch = () => ({
      hits: { hits: [{ _id: "1", _score: 1, _source: { b: 2 } }], total: 5 },
    });
    const r = await executeQuery(es(), "orders-*", 50);
    expect(h.esCalls[0].req).toEqual({
      index: "orders-*",
      size: 50,
      query: { match_all: {} },
    });
    expect(r).toMatchObject({
      columns: ["_id", "_score", "b"],
      truncated: true,
    });
  });

  it("reads total as an object or falls back to the rows for a bare index", async () => {
    h.esSearch = () => ({ hits: { hits: undefined, total: undefined } });
    expect(await executeQuery(es(), "orders")).toMatchObject({
      rows: [],
      columns: [],
      truncated: false,
    });
    h.esSearch = () => ({ hits: { hits: [], total: { value: 4 } } });
    expect((await executeQuery(es(), "orders")).truncated).toBe(true);
  });

  it("refuses an unrecognised format", async () => {
    await expect(executeQuery(es(), "PUT /orders/_doc/1 {}")).rejects.toThrow(
      /Elasticsearch queries must be in format/,
    );
  });

  it("builds the node from the URI or protocol/host/port, with basic auth", async () => {
    await executeQuery(
      es({ uri: "https://es.local:9243", username: "u", password: "p" }),
      "orders",
    );
    await executeQuery(es({ schema: "https", port: 9201 }), "orders");
    await executeQuery(es({ username: "u" }), "orders");
    expect(h.esOptions.map((o) => [o.node, o.auth])).toEqual([
      ["https://es.local:9243", { username: "u", password: "p" }],
      ["https://127.0.0.1:9201", undefined],
      ["http://127.0.0.1:9200", undefined],
    ]);
  });
});

describe("testConnection / testConnectionConfig", () => {
  it("pings every engine on a throwaway client and closes it", async () => {
    await testConnectionConfig(conn({}));
    expect(h.pgSent).toEqual(["SELECT 1"]);
    expect(h.pgEnded).toBe(1);

    await testConnectionConfig(conn({ type: "mssql" }));
    expect(h.msSent).toEqual(["SELECT 1"]);
    expect(h.msClosed).toBe(1);

    await testConnectionConfig(conn({ type: "mongodb" }));
    expect(h.mongoPinged).toBe(1);
    expect(h.mongoClosed).toBe(1);

    await testConnectionConfig(conn({ type: "elasticsearch" }));
    expect(h.esClosed).toBe(1);
  });

  it("never caches a throwaway client", async () => {
    const c = conn({ type: "mssql" });
    await testConnectionConfig(c);
    expect(getPoolStatus(c.id).live).toBe(false);
  });

  it("pings the pooled client and keeps it", async () => {
    const pg = conn({});
    const ms = conn({ type: "mssql" });
    const mongo = conn({ type: "mongodb" });
    expect(await testConnection(pg)).toBe(true);
    expect(await testConnection(ms)).toBe(true);
    expect(await testConnection(mongo)).toBe(true);
    expect(h.pgEnded + h.msClosed + h.mongoClosed).toBe(0);
    expect(getPoolStatus(mongo.id).live).toBe(true);
  });

  it("reports a failed ping as false, and throws it from the config test", async () => {
    h.pgQuery = () => {
      throw new Error("password authentication failed");
    };
    expect(await testConnection(conn({}))).toBe(false);
    await expect(testConnectionConfig(conn({}))).rejects.toThrow(
      "password authentication failed",
    );
    // The throwaway pool is closed even though the ping failed.
    expect(h.pgEnded).toBe(1);
  });

  it("swallows a failing close", async () => {
    h.msClosed = 0;
    const c = conn({ type: "mssql" });
    const { default: mssql } = await import("mssql");
    vi.spyOn(mssql.ConnectionPool.prototype, "close").mockRejectedValueOnce(
      new Error("already closed"),
    );
    await expect(testConnectionConfig(c)).resolves.toBeUndefined();
  });

  it("refuses an unknown engine", async () => {
    await expect(
      testConnectionConfig(conn({ type: "oracle" as never })),
    ).rejects.toThrow("Unsupported connection type: oracle");
    expect(await testConnection(conn({ type: "oracle" as never }))).toBe(false);
  });
});

describe("getPoolStatus", () => {
  it("reports socket counts for pg and mssql pools", async () => {
    const pg = conn({});
    const ms = conn({ type: "mssql" });
    await executeQuery(pg, "SELECT 1");
    await executeQuery(ms, "SELECT 1");
    expect(getPoolStatus(pg.id)).toMatchObject({
      live: true,
      totalSockets: 3,
      idleSockets: 2,
      lastUsedAt: expect.any(String),
    });
    expect(getPoolStatus(ms.id)).toMatchObject({
      live: true,
      totalSockets: 4,
      idleSockets: 1,
    });
  });

  it("reports an unknown connection as not live, never used", () => {
    expect(getPoolStatus("never-used")).toEqual({
      live: false,
      lastUsedAt: undefined,
    });
  });
});

describe("holdClient", () => {
  it("keeps a retired client open until every nested write is done", async () => {
    const c = conn({ type: "mssql" });
    const pool = await getMssqlPool(c);
    vi.useFakeTimers();
    let a!: () => void;
    let b!: () => void;
    const w1 = holdClient(pool, () => new Promise<void>((r) => (a = r)));
    const w2 = holdClient(pool, () => new Promise<void>((r) => (b = r)));
    closeConnectionPool(c.id, 0);
    await vi.advanceTimersByTimeAsync(5000);
    a();
    await w1;
    await vi.advanceTimersByTimeAsync(0);
    expect(h.msClosed).toBe(0);
    b();
    await w2;
    await vi.advanceTimersByTimeAsync(0);
    expect(h.msClosed).toBe(1);
  });

  it("closes only once when the hard cap fired before the write ended", async () => {
    const c = conn({ type: "mssql" });
    const pool = await getMssqlPool(c);
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let finish!: () => void;
    const w = holdClient(pool, () => new Promise<void>((r) => (finish = r)));
    // A grace period longer than the 6h cap: the cap closes it first.
    closeConnectionPool(c.id, 10 * 3_600_000);
    await vi.advanceTimersByTimeAsync(6 * 3_600_000 + 1);
    expect(h.msClosed).toBe(1);
    finish();
    await w;
    await vi.advanceTimersByTimeAsync(5 * 3_600_000);
    expect(h.msClosed).toBe(1);
  });
});

describe("closeConnectionPool", () => {
  it("retires pg, mssql and Elasticsearch clients", async () => {
    const pg = conn({});
    const ms = conn({ type: "mssql" });
    const es = conn({ type: "elasticsearch" });
    await executeQuery(pg, "SELECT 1");
    await executeQuery(ms, "SELECT 1");
    await executeQuery(es, "orders");
    vi.useFakeTimers();
    for (const c of [pg, ms, es])
      expect(closeConnectionPool(c.id, 0)).toBe(true);
    expect(h.pgEnded).toBe(1);
    for (const c of [pg, ms, es]) expect(getPoolStatus(c.id).live).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.msClosed).toBe(1);
    expect(h.esClosed).toBe(1);
  });
});

describe("parseMongoJson (remaining Extended JSON types)", () => {
  it("accepts well-formed $uuid, $timestamp, $regularExpression, $minKey and $maxKey", () => {
    expect(
      parseMongoJson('{"$uuid": "6f1c5a64-2b0d-4c3c-8d2c-3f6a0e1b2c3d"}')
        ._bsontype,
    ).toBe("Binary");
    expect(parseMongoJson('{"$timestamp": {"t": 1, "i": 2}}')._bsontype).toBe(
      "Timestamp",
    );
    expect(
      parseMongoJson(
        '{"$regularExpression": {"pattern": "^a", "options": "i"}}',
      )._bsontype,
    ).toBe("BSONRegExp");
    expect(parseMongoJson('{"$minKey": 1}')._bsontype).toBe("MinKey");
    expect(parseMongoJson('{"$maxKey": 1}')._bsontype).toBe("MaxKey");
  });

  it("rejects malformed ones instead of letting bson coerce them", () => {
    for (const bad of [
      '{"$uuid": 5}',
      '{"$timestamp": {"t": -1, "i": 2}}',
      '{"$timestamp": {"t": 1, "i": 1.5}}',
      '{"$timestamp": {"t": 1}}',
      '{"$regularExpression": {"pattern": 1, "options": ""}}',
      '{"$regularExpression": {"pattern": "a", "options": "z"}}',
      '{"$minKey": 0}',
      '{"$maxKey": true}',
    ])
      expect(() => parseMongoJson(bad), bad).toThrow(/Invalid \$/);
  });

  it("rejects a $date past what a Date can hold", () => {
    expect(() =>
      parseMongoJson('{"$date": {"$numberLong": "9000000000000000000"}}'),
    ).toThrow(/\$date out of range/);
  });
});
