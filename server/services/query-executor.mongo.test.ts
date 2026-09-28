import { describe, it, expect, vi, beforeEach } from "vitest";
import { ObjectId } from "mongodb";
import type { ConnectionConfig } from "../types/index.js";

// A write request's verify "SELECT" is run by the approver on preview, so the
// Mongo read path must be unable to mutate. Fake the driver and record what
// would reach it.
const sent: { op: string; args: any }[] = [];
const cursor = (rows: any[]) => ({
  sort: () => cursor(rows),
  skip: () => cursor(rows),
  limit: () => cursor(rows),
  toArray: async () => rows,
});

vi.mock("mongodb", async (orig) => ({
  ...(await orig<typeof import("mongodb")>()),
  MongoClient: class {
    async connect() {}
    db() {
      return {
        collection: () => ({
          find: (args: any) => (sent.push({ op: "find", args }), cursor([])),
          aggregate: (args: any) => (
            sent.push({ op: "aggregate", args }),
            cursor([])
          ),
        }),
      };
    }
  },
}));

const { executeQuery } = await import("./query-executor.js");
const conn = {
  id: "mongo-read-test",
  type: "mongodb",
  env: "QA",
  uri: "mongodb://fake/app_core",
  database: "app_core",
} as ConnectionConfig;

describe("executeQuery (mongodb)", () => {
  beforeEach(() => {
    sent.length = 0;
  });

  it("refuses $out and $merge, which write the pipeline's output", async () => {
    for (const stage of [
      '{"$out": "copy"}',
      '{"$merge": {"into": "customers", "whenMatched": "replace"}}',
    ]) {
      await expect(
        executeQuery(conn, `db.orders.aggregate([{"$match": {}}, ${stage}])`),
      ).rejects.toThrow(/read-only/);
    }
    expect(sent).toHaveLength(0);
  });

  it("still runs an ordinary pipeline", async () => {
    await executeQuery(
      conn,
      'db.orders.aggregate([{"$project": {"t": {"$type": "$_id"}}}])',
    );
    expect(sent).toEqual([
      { op: "aggregate", args: [{ $project: { t: { $type: "$_id" } } }] },
    ]);
  });

  it("parses Extended JSON so a non-string _id can be matched", async () => {
    await executeQuery(
      conn,
      'db.orders.find({"_id": {"$oid": "65a000000000000000000001"}})',
    );
    expect(sent[0].args._id).toBeInstanceOf(ObjectId);
  });

  it("does not mistake a value for a write operation", async () => {
    await executeQuery(conn, 'db.orders.find({"action": "remove"})');
    expect(sent[0].args).toEqual({ action: "remove" });
    await expect(
      executeQuery(conn, "db.orders.find({}).forEach(printjson)"),
    ).rejects.toThrow(/write operation/);
  });
});
