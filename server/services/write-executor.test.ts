import { describe, it, expect, vi, beforeEach } from "vitest";
import { Binary, ObjectId } from "mongodb";
import type { ConnectionConfig } from "../types/index.js";

// The executor reuses query-executor's client cache; swap the client for a
// recording fake so the test sees exactly what would reach the driver.
const calls: { verb: string; args: any[] }[] = [];
let replicaSet = true;

const fakeCollection = new Proxy(
  {},
  {
    get:
      (_t, verb: string) =>
      async (...args: any[]) => {
        calls.push({ verb, args });
        return {
          modifiedCount: 2,
          deletedCount: 3,
          insertedCount: Array.isArray(args[0]) ? args[0].length : 1,
        };
      },
  },
);

vi.mock("./query-executor.js", async (orig) => ({
  ...(await orig<typeof import("./query-executor.js")>()),
  getMongoClient: async () => ({
    db: () => ({ collection: () => fakeCollection }),
    startSession: () => ({
      withTransaction: async (fn: () => Promise<void>) => {
        if (!replicaSet)
          throw new Error(
            "Transaction numbers are only allowed on a replica set member or mongos",
          );
        await fn();
      },
      endSession: async () => {},
    }),
  }),
}));

const { validateWriteQuery, parseMongoArgs, executeWrite } =
  await import("./write-executor.js");

const conn = {
  id: "mongo-write-test",
  type: "mongodb",
  env: "QA",
  database: "app_core",
} as ConnectionConfig;

describe("validateWriteQuery (mongodb)", () => {
  it("accepts every permitted write verb", () => {
    for (const sql of [
      'db.orders.updateOne({"_id": {"$oid": "65a000000000000000000001"}}, {"$set": {"status": "done"}})',
      'db.orders.updateMany({"status": "pending"}, {"$set": {"status": "done"}})',
      'db.orders.replaceOne({"sku": "A"}, {"sku": "A", "qty": 1})',
      'db.orders.insertOne({"sku": "A"})',
      'db.orders.insertMany([{"sku": "A"}, {"sku": "B"}])',
      'db.orders.deleteOne({"sku": "A"})',
      'db.orders.deleteMany({"status": "void"});',
      'orders.deleteMany({"status": "void"})',
    ]) {
      const v = validateWriteQuery(sql, "mongodb");
      expect(v.valid, `${sql}: ${v.error}`).toBe(true);
    }
  });

  it("rejects reads, admin ops and non-calls", () => {
    for (const sql of [
      'db.orders.find({"sku": "A"})',
      "db.orders.drop()",
      'db.orders.bulkWrite([{"deleteMany": {"filter": {}}}])',
      'db.orders.findOneAndUpdate({"sku": "A"}, {"$set": {"qty": 0}})',
      "delete everything",
      "",
    ]) {
      expect(validateWriteQuery(sql, "mongodb").valid, sql).toBe(false);
    }
  });

  // The route's syntax check can't reach Mongo, so this is the only thing that
  // stops a malformed filter being approved and failing at execution time.
  it("rejects arguments that are not Extended JSON before the request is saved", () => {
    const v = validateWriteQuery(
      'db.orders.updateOne({status: "pending"}, {"$set": {"status": "done"}})',
      "mongodb",
    );
    expect(v.valid).toBe(false);
    expect(v.error).toMatch(/Extended JSON/);
    expect(
      validateWriteQuery(
        'db.orders.deleteOne({"_id": {"$oid": "nope"}})',
        "mongodb",
      ).valid,
    ).toBe(false);
  });
});

// The statement a reviewer approves must be the statement that runs.
describe("validateWriteQuery (mongodb) — validated is what executes", () => {
  it("binds to the outer call, never one smuggled inside a string value", () => {
    // Unanchored parsing once ran customers.deleteMany({}) here.
    const v = validateWriteQuery(
      'db.orders.updateOne ({"_id": 1, "note": "customers.deleteMany({})"}, {"$set": {"x": 1}})',
      "mongodb",
    );
    expect(v).toMatchObject({ valid: true, verb: "updateOne" });
    expect(
      parseMongoArgs(
        'db.orders.updateOne ({"_id": 1, "note": "customers.deleteMany({})"}, {"$set": {"x": 1}})',
      ),
    ).toMatchObject({ collection: "orders", verb: "updateOne" });
  });

  it("rejects anything chained or stacked after the call", () => {
    for (const sql of [
      'db.orders.updateOne({"a": 1}, {"$set": {"b": 1}}).drop()',
      'db.orders.deleteOne({"a": 1}), db.customers.deleteMany({})',
      'db.orders.deleteOne({"a": 1}); db.customers.deleteMany({})',
    ]) {
      expect(validateWriteQuery(sql, "mongodb").valid, sql).toBe(false);
    }
  });

  it("accepts brackets, quotes and operation names inside string values", () => {
    for (const sql of [
      'db.orders.updateOne({"_id": 1}, {"$set": {"note": "smile :)"}})',
      'db.orders.updateOne({"_id": 1}, {"$set": {"action": "remove"}})',
      'db.orders.updateOne({"_id": 1}, {"$set": {"note": "a \\"quoted\\", b\\\\"}})',
    ]) {
      const v = validateWriteQuery(sql, "mongodb");
      expect(v.valid, `${sql}: ${v.error}`).toBe(true);
    }
    expect(
      parseMongoArgs(
        'db.orders.updateOne({"_id": 1}, {"$set": {"note": "a \\"quoted\\", b\\\\"}})',
      ).args,
    ).toEqual([{ _id: 1 }, { $set: { note: 'a "quoted", b\\' } }]);
  });
});

describe("parseMongoArgs", () => {
  it("turns Extended JSON into real BSON types so non-string _ids match", () => {
    const { collection, verb, args } = parseMongoArgs(
      'db.orders.updateOne({"_id": {"$binary": {"base64": "MDEyMzQ1Njc4OWFiY2RlZg==", "subType": "03"}}, "owner": {"$oid": "65a000000000000000000001"}}, {"$set": {"at": {"$date": "2024-01-01T00:00:00Z"}}})',
    );
    expect(collection).toBe("orders");
    expect(verb).toBe("updateOne");
    expect(args[0]._id).toBeInstanceOf(Binary);
    expect(args[0]._id.sub_type).toBe(3);
    expect(args[0].owner).toBeInstanceOf(ObjectId);
    expect(args[0].owner.toHexString()).toBe("65a000000000000000000001");
    expect(args[1].$set.at).toEqual(new Date("2024-01-01T00:00:00Z"));
  });

  it("parses plain JSON exactly as before", () => {
    const { args } = parseMongoArgs(
      'db.orders.updateMany({"note": "a, b", "qty": {"$gt": 5}}, {"$inc": {"qty": 1}}, {"upsert": false})',
    );
    expect(args).toEqual([
      { note: "a, b", qty: { $gt: 5 } },
      { $inc: { qty: 1 } },
      { upsert: false },
    ]);
  });
});

describe("executeWrite (mongodb)", () => {
  beforeEach(() => {
    calls.length = 0;
    replicaSet = true;
  });

  it("hands the driver typed filters inside a transaction", async () => {
    const r = await executeWrite(
      conn,
      'db.orders.updateOne({"_id": {"$oid": "65a000000000000000000001"}}, {"$set": {"status": "done"}})',
    );
    expect(r).toMatchObject({ rowsAffected: 2, transactional: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].verb).toBe("updateOne");
    expect(calls[0].args[0]._id).toBeInstanceOf(ObjectId);
    expect(calls[0].args[2]).toHaveProperty("session");
  });

  it("reports the count for each verb", async () => {
    expect(
      (await executeWrite(conn, 'db.orders.deleteMany({"status": "void"})'))
        .rowsAffected,
    ).toBe(3);
    expect(
      (await executeWrite(conn, 'db.orders.insertMany([{"a": 1}, {"a": 2}])'))
        .rowsAffected,
    ).toBe(2);
    expect(
      (await executeWrite(conn, 'db.orders.insertOne({"a": 1})')).rowsAffected,
    ).toBe(1);
  });

  it("falls back to a direct write when the deployment is not a replica set", async () => {
    replicaSet = false;
    const r = await executeWrite(conn, 'db.orders.deleteOne({"sku": "A"})');
    expect(r).toMatchObject({ rowsAffected: 3, transactional: false });
    expect(calls).toHaveLength(1);
  });

  it("refuses to run an invalid write", async () => {
    await expect(executeWrite(conn, "db.orders.drop()")).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});
