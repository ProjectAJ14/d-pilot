import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ConnectionConfig } from "../types/index.js";

/**
 * Every engine's write and migration path against recording fakes: what is
 * validated, what reaches the driver, how affected rows are counted, and that
 * a failure rolls back (even when the rollback itself fails).
 */

const s = vi.hoisted(() => ({
  sent: [] as string[],
  released: 0,
  pgResult: (_sql: string): unknown => ({ rowCount: 1 }),
  msRequest: (_sql: string): unknown => ({ rowsAffected: [1] }),
  msTx: (_sql: string): unknown => ({ rowsAffected: [1] }),
  msRollbackFails: false,
  msCommitted: 0,
  msRolledBack: 0,
  mongo: { calls: [] as { verb: string; args: any[] }[], result: {} as any },
  mongoTxError: null as unknown,
  mongoDbNames: [] as string[],
  es: { calls: [] as { api: string; params: any }[], result: {} as any },
}));

vi.mock("mssql", () => ({
  default: {
    Transaction: class {
      async begin() {}
      async commit() {
        s.msCommitted++;
      }
      async rollback() {
        s.msRolledBack++;
        if (s.msRollbackFails) throw new Error("no transaction is active");
      }
    },
    Request: class {
      async query(sql: string) {
        s.sent.push(sql);
        return s.msTx(sql);
      }
    },
  },
}));

vi.mock("./query-executor.js", async (orig) => ({
  ...(await orig<typeof import("./query-executor.js")>()),
  getPgPool: async () => ({
    connect: async () => ({
      query: async (sql: string) => (s.sent.push(sql), s.pgResult(sql)),
      release: () => void s.released++,
    }),
  }),
  getMssqlPool: async () => ({
    request: () => ({
      query: async (sql: string) => (s.sent.push(sql), s.msRequest(sql)),
    }),
  }),
  getMongoClient: async () => ({
    db: (name: string) => {
      s.mongoDbNames.push(name);
      return {
        command: async () => ({ ok: 1 }),
        collection: () =>
          new Proxy(
            {},
            {
              get:
                (_t, verb: string) =>
                async (...args: any[]) => {
                  s.mongo.calls.push({ verb, args });
                  return s.mongo.result;
                },
            },
          ),
      };
    },
    startSession: () => ({
      withTransaction: async (fn: () => Promise<void>) => {
        if (s.mongoTxError) throw s.mongoTxError;
        await fn();
      },
      endSession: async () => {},
    }),
  }),
  getEsClient: () =>
    new Proxy(
      {},
      {
        get: (_t, api: string) => async (params: any) => {
          s.es.calls.push({ api, params });
          return s.es.result;
        },
      },
    ),
}));

const { validateWriteQuery, validateMigration, classifyWrite } =
  await import("./write-executor.js");
const { executeWrite, executeMigration } = await import("./write-executor.js");

const pg = { id: "pg-p", type: "postgres", env: "QA" } as ConnectionConfig;
const ms = { id: "ms-p", type: "mssql", env: "QA" } as ConnectionConfig;
const mongo = {
  id: "mongo-p",
  type: "mongodb",
  env: "QA",
  database: "app_core",
} as ConnectionConfig;
const es = { id: "es-p", type: "elasticsearch", env: "QA" } as ConnectionConfig;

beforeEach(() => {
  s.sent.length = 0;
  s.released = 0;
  s.pgResult = () => ({ rowCount: 1 });
  s.msRequest = () => ({ rowsAffected: [1] });
  s.msTx = () => ({ rowsAffected: [1] });
  s.msRollbackFails = false;
  s.msCommitted = 0;
  s.msRolledBack = 0;
  s.mongo.calls.length = 0;
  s.mongo.result = {};
  s.mongoTxError = null;
  s.mongoDbNames.length = 0;
  s.es.calls.length = 0;
  s.es.result = {};
});

describe("validateWriteQuery (SQL)", () => {
  it("rejects stacked statements", () => {
    expect(
      validateWriteQuery(
        "DELETE FROM orders WHERE id = 1; SELECT 1",
        "postgres",
      ).error,
    ).toMatch(/Multiple statements/);
  });

  it("rejects anything that is not INSERT/UPDATE/DELETE", () => {
    expect(validateWriteQuery("SELECT * FROM orders", "mssql").error).toBe(
      'Only INSERT, UPDATE and DELETE are allowed. Found "SELECT".',
    );
    expect(validateWriteQuery("(DELETE FROM orders)", "mssql").error).toBe(
      'Only INSERT, UPDATE and DELETE are allowed. Found "?".',
    );
  });

  it("rejects DDL or admin keywords anywhere in the statement", () => {
    expect(
      validateWriteQuery("INSERT INTO orders EXEC load_orders", "mssql").error,
    ).toMatch(/DDL and administrative/);
  });

  it("calls an INSERT scoped, and an UPDATE/DELETE only with a WHERE", () => {
    expect(
      validateWriteQuery("insert into orders (id) values (1);", "postgres"),
    ).toEqual({ valid: true, verb: "INSERT", scoped: true });
    expect(
      validateWriteQuery("UPDATE orders SET a = 1", "postgres").scoped,
    ).toBe(false);
    expect(
      validateWriteQuery("DELETE FROM orders WHERE id = 1", "mssql").scoped,
    ).toBe(true);
  });

  it("rejects an empty statement", () => {
    expect(validateWriteQuery("  ;  ", "postgres").error).toMatch(/empty/);
  });
});

describe("validateWriteQuery (elasticsearch / other)", () => {
  it("requires a write method against an index endpoint", () => {
    expect(
      validateWriteQuery("GET orders/_search", "elasticsearch").error,
    ).toMatch(/must be POST\/PUT\/DELETE/);
    expect(
      validateWriteQuery("POST orders/_bulk {}", "elasticsearch").error,
    ).toMatch(/Only _doc/);
    expect(validateWriteQuery("put orders/_doc/1 {}", "elasticsearch")).toEqual(
      {
        valid: true,
        verb: "PUT",
        scoped: true,
      },
    );
  });

  it("refuses an engine it does not know", () => {
    expect(validateWriteQuery("x", "oracle" as never).error).toBe(
      "Unsupported database type: oracle",
    );
  });
});

describe("validateMigration", () => {
  it("rejects an empty script and non-SQL engines", () => {
    expect(validateMigration("  ", "postgres").error).toMatch(/empty/);
    expect(validateMigration("db.orders.drop()", "mongodb").error).toMatch(
      /PostgreSQL and SQL Server only/,
    );
  });

  it("rejects a script that is only comments", () => {
    expect(validateMigration("-- nothing to do\n", "postgres").error).toBe(
      "Migration script has no statements",
    );
  });

  it("blocks database/connection-level statements", () => {
    for (const sql of ["DROP DATABASE app_core", "USE app_core; SELECT 1"])
      expect(validateMigration(sql, "mssql").error).toMatch(/connection-level/);
  });

  it("does not trip on a blocked word inside a string literal", () => {
    expect(
      validateMigration(
        "UPDATE orders SET note = 'DROP DATABASE later'",
        "postgres",
      ),
    ).toEqual({
      valid: true,
      statementCount: 1,
      requiresNoTransaction: false,
      hasDdl: false,
    });
  });

  it("needs the no-rollback opt-in for statements that cannot run in a transaction", () => {
    const pgScript = "VACUUM orders;\nALTER TABLE orders ADD COLUMN n int;";
    const r = validateMigration(pgScript, "postgres");
    expect(r).toMatchObject({
      valid: false,
      statementCount: 2,
      requiresNoTransaction: true,
      hasDdl: true,
    });
    expect(r.error).toMatch(/Run without rollback/);
    expect(
      validateMigration(pgScript, "postgres", { noTransaction: true }).valid,
    ).toBe(true);
    // SQL Server has its own list.
    expect(
      validateMigration("BACKUP LOG app_core TO DISK = 'x'", "mssql")
        .requiresNoTransaction,
    ).toBe(true);
    expect(
      validateMigration("VACUUM orders", "mssql").requiresNoTransaction,
    ).toBe(false);
  });
});

describe("classifyWrite", () => {
  it("treats Mongo and Elasticsearch as single operations", () => {
    expect(classifyWrite("anything; at all", "mongodb")).toEqual({
      isMigration: false,
      statementCount: 1,
      hasDdl: false,
    });
    expect(classifyWrite("x", "elasticsearch").isMigration).toBe(false);
  });

  it("calls multiple statements or any DDL a migration", () => {
    expect(classifyWrite("UPDATE orders SET a = 1", "postgres")).toEqual({
      isMigration: false,
      statementCount: 1,
      hasDdl: false,
    });
    expect(
      classifyWrite(
        "UPDATE orders SET a = 1; UPDATE customers SET b = 2",
        "mssql",
      ),
    ).toMatchObject({ isMigration: true, statementCount: 2, hasDdl: false });
    expect(
      classifyWrite("ALTER TABLE orders ADD COLUMN n int", "postgres"),
    ).toMatchObject({ isMigration: true, statementCount: 1, hasDdl: true });
  });
});

describe("executeMigration (postgres)", () => {
  const script =
    "ALTER TABLE orders ADD COLUMN n int;\nUPDATE orders SET n = 1;";

  it("runs the whole script in one transaction and sums affected rows", async () => {
    s.pgResult = (sql) =>
      sql === script ? [{ rowCount: null }, { rowCount: 4 }, null] : {};
    const r = await executeMigration(pg, script);
    expect(r).toMatchObject({ rowsAffected: 4, transactional: true });
    expect(s.sent).toEqual(["BEGIN", script, "COMMIT"]);
    expect(s.released).toBe(1);
  });

  it("counts a single result, or none", async () => {
    s.pgResult = (sql) => (sql === script ? { rowCount: 3 } : {});
    expect((await executeMigration(pg, script)).rowsAffected).toBe(3);
    s.pgResult = () => undefined;
    expect((await executeMigration(pg, script)).rowsAffected).toBe(0);
  });

  it("rolls back and rethrows, even when the rollback fails", async () => {
    const boom = new Error('column "n" already exists');
    s.pgResult = (sql) => {
      if (sql === script) throw boom;
      if (sql === "ROLLBACK") throw new Error("connection lost");
      return {};
    };
    await expect(executeMigration(pg, script)).rejects.toBe(boom);
    expect(s.sent).toEqual(["BEGIN", script, "ROLLBACK"]);
    expect(s.released).toBe(1);
  });

  it("without rollback, sends each statement on its own and sums them", async () => {
    const nonTx =
      "CREATE INDEX CONCURRENTLY i ON orders (n);\nUPDATE orders SET n = 2;";
    s.pgResult = (sql) => ({ rowCount: sql.startsWith("UPDATE") ? 5 : null });
    const r = await executeMigration(pg, nonTx, { noTransaction: true });
    expect(r).toMatchObject({ rowsAffected: 5, transactional: false });
    expect(s.sent).toEqual([
      "CREATE INDEX CONCURRENTLY i ON orders (n)",
      "UPDATE orders SET n = 2",
    ]);
  });

  it("without rollback, names the statement that failed", async () => {
    s.pgResult = (sql) => {
      if (sql.startsWith("UPDATE")) throw new Error("deadlock detected");
      if (sql.startsWith("DELETE")) throw "plain text failure";
      return { rowCount: 0 };
    };
    await expect(
      executeMigration(pg, "VACUUM orders; UPDATE orders SET n = 3", {
        noTransaction: true,
      }),
    ).rejects.toThrow(
      "Statement 2 of 2 failed (earlier statements were committed and cannot be rolled back): deadlock detected",
    );
    await expect(
      executeMigration(pg, "DELETE FROM orders WHERE n = 1; VACUUM orders", {
        noTransaction: true,
      }),
    ).rejects.toThrow(/Statement 1 of 2 failed .*: plain text failure/);
  });

  it("refuses an invalid script before connecting", async () => {
    await expect(
      executeMigration(pg, "DROP DATABASE app_core"),
    ).rejects.toThrow(/connection-level/);
    await expect(executeMigration(mongo, "db.orders.drop()")).rejects.toThrow(
      /PostgreSQL and SQL Server only/,
    );
    expect(s.sent).toEqual([]);
  });
});

describe("executeMigration (mssql)", () => {
  const script =
    "ALTER TABLE orders ADD n int;\nUPDATE orders SET n = 1 WHERE id > 0;";

  it("runs in a transaction and sums rowsAffected", async () => {
    s.msTx = () => ({ rowsAffected: [0, 6] });
    const r = await executeMigration(ms, script);
    expect(r).toMatchObject({ rowsAffected: 6, transactional: true });
    expect(s.msCommitted).toBe(1);
  });

  it("accepts a plain or missing rowsAffected", async () => {
    s.msTx = () => ({ rowsAffected: 2 });
    expect((await executeMigration(ms, script)).rowsAffected).toBe(2);
    s.msTx = () => ({});
    expect((await executeMigration(ms, script)).rowsAffected).toBe(0);
  });

  it("rolls back on failure and rethrows, ignoring a failed rollback", async () => {
    const boom = new Error("Invalid column name 'n'");
    s.msTx = () => {
      throw boom;
    };
    s.msRollbackFails = true;
    await expect(executeMigration(ms, script)).rejects.toBe(boom);
    expect(s.msRolledBack).toBe(1);
    expect(s.msCommitted).toBe(0);
  });

  it("without rollback, sends the batch outside any transaction", async () => {
    s.msRequest = () => ({ rowsAffected: [2, 3] });
    const r = await executeMigration(ms, script, { noTransaction: true });
    expect(r).toMatchObject({ rowsAffected: 5, transactional: false });
    expect(s.sent).toEqual([script]);
    expect(s.msCommitted).toBe(0);
    s.msRequest = () => ({});
    expect(
      (await executeMigration(ms, script, { noTransaction: true }))
        .rowsAffected,
    ).toBe(0);
  });
});

describe("executeWrite (postgres / mssql)", () => {
  const update = "UPDATE orders SET status = 'x' WHERE id = 1";

  it("pg: a null rowCount counts as zero", async () => {
    s.pgResult = () => ({ rowCount: null });
    expect(await executeWrite(pg, update)).toMatchObject({
      rowsAffected: 0,
      transactional: true,
    });
    expect(s.sent).toEqual(["BEGIN", update, "COMMIT"]);
  });

  it("pg: rolls back and rethrows, even when the rollback fails", async () => {
    const boom = new Error("violates check constraint");
    s.pgResult = (sql) => {
      if (sql === update) throw boom;
      if (sql === "ROLLBACK") throw new Error("gone");
      return {};
    };
    await expect(executeWrite(pg, update)).rejects.toBe(boom);
    expect(s.released).toBe(1);
  });

  it("mssql: sums rowsAffected, or takes it plain, or zero", async () => {
    s.msTx = () => ({ rowsAffected: [2, 1] });
    expect((await executeWrite(ms, update)).rowsAffected).toBe(3);
    s.msTx = () => ({ rowsAffected: 4 });
    expect((await executeWrite(ms, update)).rowsAffected).toBe(4);
    s.msTx = () => ({});
    expect((await executeWrite(ms, update)).rowsAffected).toBe(0);
    expect(s.msCommitted).toBe(3);
  });

  it("mssql: rolls back on failure, ignoring a failed rollback", async () => {
    const boom = new Error("deadlock victim");
    s.msTx = () => {
      throw boom;
    };
    s.msRollbackFails = true;
    await expect(executeWrite(ms, update)).rejects.toBe(boom);
    expect(s.msRolledBack).toBe(1);
  });
});

describe("executeWrite (mongodb)", () => {
  it("passes each verb's arguments through, defaulting missing ones to {}", async () => {
    s.mongo.result = { modifiedCount: 1, upsertedCount: 1, deletedCount: 2 };
    expect(
      (
        await executeWrite(
          mongo,
          'db.orders.updateMany({"a": 1}, {"$set": {"b": 2}})',
        )
      ).rowsAffected,
    ).toBe(2);
    expect(
      (await executeWrite(mongo, 'db.orders.replaceOne({"a": 1}, {"a": 2})'))
        .rowsAffected,
    ).toBe(2);
    expect(
      (await executeWrite(mongo, "db.orders.deleteOne()")).rowsAffected,
    ).toBe(2);
    expect(s.mongo.calls.map((c) => [c.verb, c.args.slice(0, 2)])).toEqual([
      ["updateMany", [{ a: 1 }, { $set: { b: 2 } }]],
      ["replaceOne", [{ a: 1 }, { a: 2 }]],
      [
        "deleteOne",
        [{}, expect.objectContaining({ session: expect.anything() })],
      ],
    ]);
  });

  it("counts zero when the driver reports no counts", async () => {
    s.mongo.result = {};
    for (const q of [
      "db.orders.updateOne()",
      "db.orders.updateMany()",
      "db.orders.replaceOne()",
      "db.orders.deleteOne()",
      "db.orders.deleteMany()",
    ])
      expect((await executeWrite(mongo, q)).rowsAffected, q).toBe(0);
    for (const c of s.mongo.calls) expect(c.args[0]).toEqual({});
  });

  it("inserts one document, or wraps a lone document for insertMany", async () => {
    s.mongo.result = {};
    expect(
      (await executeWrite(mongo, "db.orders.insertOne()")).rowsAffected,
    ).toBe(1);
    expect(
      (await executeWrite(mongo, 'db.orders.insertMany({"a": 1})'))
        .rowsAffected,
    ).toBe(1);
    expect(s.mongo.calls[0].args[0]).toEqual({});
    expect(s.mongo.calls[1].args[0]).toEqual([{ a: 1 }]);
  });

  it("names the database from the connection, the URI, or 'test'", async () => {
    await executeWrite(mongo, "db.orders.deleteOne()");
    await executeWrite(
      { ...mongo, database: undefined, uri: "mongodb://h/customers?ssl=true" },
      "db.orders.deleteOne()",
    );
    await executeWrite(
      { ...mongo, database: undefined },
      "db.orders.deleteOne()",
    );
    expect(s.mongoDbNames).toEqual(["app_core", "customers", "test"]);
  });

  it("rethrows a non-Error transaction failure as is", async () => {
    s.mongoTxError = "write conflict";
    await expect(executeWrite(mongo, "db.orders.deleteOne()")).rejects.toBe(
      "write conflict",
    );
    expect(s.mongo.calls).toEqual([]);
  });

  it("falls back to a direct write when transactions are unsupported", async () => {
    s.mongoTxError = new Error(
      "Transactions are not supported by this deployment",
    );
    s.mongo.result = { deletedCount: 1 };
    expect(await executeWrite(mongo, "db.orders.deleteMany()")).toMatchObject({
      rowsAffected: 1,
      transactional: false,
    });
    // The direct write carries no session.
    expect(s.mongo.calls[0].args[1]).toEqual({});
  });
});

describe("executeWrite (elasticsearch)", () => {
  it("counts by-query results, defaulting to zero", async () => {
    s.es.result = {};
    expect(
      (await executeWrite(es, "POST orders/_update_by_query")).rowsAffected,
    ).toBe(0);
    expect(
      (await executeWrite(es, "POST /orders/_delete_by_query")).rowsAffected,
    ).toBe(0);
    s.es.result = { updated: 7, deleted: 2 };
    expect(
      (await executeWrite(es, 'POST orders/_update_by_query {"query": {}}'))
        .rowsAffected,
    ).toBe(7);
    expect(
      (await executeWrite(es, "POST orders/_delete_by_query")).rowsAffected,
    ).toBe(2);
    expect(s.es.calls[0].params).toEqual({ index: "orders" });
    expect(s.es.calls[2].params).toEqual({ index: "orders", query: {} });
  });

  it("updates without a body, and indexes a document under an id", async () => {
    await executeWrite(es, "POST orders/_update/9");
    await executeWrite(es, 'PUT orders/_doc/5 {"a": 1}');
    expect(s.es.calls).toEqual([
      { api: "update", params: { index: "orders", id: "9" } },
      {
        api: "index",
        params: { index: "orders", id: "5", document: { a: 1 } },
      },
    ]);
    expect((await executeWrite(es, "PUT orders/_doc/6")).transactional).toBe(
      false,
    );
  });

  it("requires a document id to DELETE", async () => {
    await expect(executeWrite(es, "DELETE orders/_doc")).rejects.toThrow(
      "DELETE /index/_doc requires a document id",
    );
    expect(s.es.calls).toEqual([]);
  });

  it("refuses an _update/_create path with no id", async () => {
    await expect(executeWrite(es, "POST orders/_create/ {}")).rejects.toThrow(
      "Unsupported Elasticsearch write endpoint: _create",
    );
    await expect(executeWrite(es, "POST orders/_update/ {}")).rejects.toThrow(
      "Unsupported Elasticsearch write endpoint: _update",
    );
    expect(s.es.calls).toEqual([]);
  });
});

// Defense in depth: each executor re-checks what its validator already ruled
// out, so a connection whose type changes between the check and the dispatch,
// or a parse that disagrees with the validated one, still runs nothing.
describe("executor fallbacks the validators normally make unreachable", () => {
  const realMatch = String.prototype.match;
  /** Replaces the result of the one regex whose source contains `marker`. */
  const stubMatch = (marker: string, result: (s: string) => unknown) =>
    vi.spyOn(String.prototype, "match").mockImplementation(function (
      this: string,
      re: any,
    ) {
      return re instanceof RegExp && re.source.includes(marker)
        ? result(String(this))
        : realMatch.call(this, re);
    } as any);
  /** A connection whose type reads `checked` once, then `ran`. */
  const switching = (checked: string, ran: string) => {
    let reads = 0;
    return {
      id: "flip",
      env: "QA",
      get type() {
        return reads++ ? ran : checked;
      },
    } as unknown as ConnectionConfig;
  };

  afterEach(() => vi.restoreAllMocks());

  it("refuses a migration on a type the validator never saw", async () => {
    await expect(
      executeMigration(switching("postgres", "mongodb"), "UPDATE t SET a = 1"),
    ).rejects.toThrow("Migrations are not supported for mongodb");
    expect(s.sent).toEqual([]);
  });

  it("refuses a write on a type the validator never saw", async () => {
    await expect(
      executeWrite(
        switching("postgres", "oracle"),
        "UPDATE t SET a = 1 WHERE b = 2",
      ),
    ).rejects.toThrow("Unsupported database type: oracle");
    expect(s.sent).toEqual([]);
  });

  it("refuses with a generic message when a rejection carries no reason", async () => {
    // parseMongoArgs failing with an empty message leaves error "".
    stubMatch("(\\w+)\\.(\\w+)", () => {
      throw new Error("");
    });
    await expect(
      executeWrite(mongo, 'db.orders.updateOne({"a": 1}, {"$set": {"b": 2}})'),
    ).rejects.toThrow(/^Invalid write statement$/);
    expect(s.mongo.calls).toEqual([]);
  });

  it("refuses a Mongo verb the validated parse did not contain", async () => {
    let parses = 0;
    stubMatch("(\\w+)\\.(\\w+)", (str) =>
      parses++
        ? ["", "orders", "drop", ""]
        : realMatch.call(str, /^(?:db\.)?(\w+)\.(\w+)\s*\(([\s\S]*)\)\s*;?$/),
    );
    await expect(
      executeWrite(mongo, 'db.orders.deleteOne({"a": 1})'),
    ).rejects.toThrow("Unsupported MongoDB write verb: drop");
    expect(s.mongo.calls).toEqual([]);
  });

  it("refuses an Elasticsearch request its own parse cannot read", async () => {
    stubMatch("([\\s\\S]*)?$", () => null);
    await expect(
      executeWrite(es, 'PUT orders/_doc/1 {"a": 1}'),
    ).rejects.toThrow("Could not parse Elasticsearch write request");
    expect(s.es.calls).toEqual([]);
  });
});
