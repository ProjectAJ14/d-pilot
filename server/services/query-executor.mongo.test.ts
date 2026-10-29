import { describe, it, expect, vi, beforeEach } from "vitest";
import { ObjectId } from "mongodb";
import type { ConnectionConfig } from "../types/index.js";

// A write request's verify "SELECT" is run by the approver on preview, so the
// Mongo read path must be unable to mutate. Fake the driver and record what
// would reach it.
const sent: { op: string; args: any; options?: any }[] = [];
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
          find: (args: any, options?: any) => (
            sent.push({ op: "find", args, options }),
            cursor([])
          ),
          findOne: async (args: any, options?: any) => (
            sent.push({ op: "findOne", args, options }),
            null
          ),
          distinct: async (field: string, args: any) => (
            sent.push({ op: "distinct", args: { field, filter: args } }),
            []
          ),
          aggregate: (args: any) => (
            sent.push({ op: "aggregate", args }),
            cursor([])
          ),
        }),
      };
    }
  },
}));

const { executeQuery, parseMongoJson, splitMongoArgs } =
  await import("./query-executor.js");
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

  // A write's verify preview runs here; a ")" in a value must not cut it short.
  it("reads brackets inside string values as data", async () => {
    await executeQuery(conn, 'db.orders.find({"note": "smile :) ]}"})');
    expect(sent[0].args).toEqual({ note: "smile :) ]}" });
  });

  it("does not mistake a value for a write operation", async () => {
    await executeQuery(conn, 'db.orders.find({"action": "remove"})');
    expect(sent[0].args).toEqual({ action: "remove" });
    await expect(
      executeQuery(conn, "db.orders.find({}).forEach(printjson)"),
    ).rejects.toThrow(/write operation/);
  });
});

describe("parseMongoJson", () => {
  it("keeps $numberLong exact past 2^53 and $numberDouble a double", () => {
    const v = parseMongoJson(
      '{"id": {"$numberLong": "9007199254740993"}, "d": {"$numberDouble": "1.0"}, "n": 5, "f": 1.5}',
    );
    expect(v.id.toString()).toBe("9007199254740993");
    expect(v.d._bsontype).toBe("Double");
    expect(v.n).toBe(5);
    expect(v.f).toBe(1.5);
  });

  it("leaves plain numbers as JSON.parse would, so stored types don't change", () => {
    expect(parseMongoJson('{"a": 3000000000}').a).toBe(3000000000);
    expect(() => parseMongoJson('{"id": 9007199254740993}')).toThrow(
      /\$numberLong/,
    );
    // Exponent literals are exact doubles, not rounded integers.
    expect(parseMongoJson('{"a": {"$gt": 1e20}, "b": 1.5e16}')).toEqual({
      a: { $gt: 1e20 },
      b: 1.5e16,
    });
    // A long digit run inside a string is just text.
    expect(parseMongoJson('{"s": "9007199254740993"}').s).toBe(
      "9007199254740993",
    );
  });

  it("rejects a $numberDecimal that Decimal128 would round or clamp", () => {
    for (const bad of [
      "12345678901234567890123456789012345678",
      "1.0000000000000000000000000000000001",
      "1E+6145",
      "1E-6200",
      "0x10",
    ])
      expect(
        () => parseMongoJson(`{"a": {"$numberDecimal": "${bad}"}}`),
        bad,
      ).toThrow(/\$numberDecimal/);
    for (const ok of ["1.50", "-0.001", "1E+10", "NaN", "-Infinity"])
      expect(
        parseMongoJson(`{"a": {"$numberDecimal": "${ok}"}}`).a.toString(),
        ok,
      ).toBeTruthy();
  });

  // bson coerces all of these into a *different* value instead of failing.
  it("rejects malformed type wrappers instead of coercing them", () => {
    for (const bad of [
      '{"a": {"$date": 0}}', // was: now
      '{"a": {"$date": {"x": 1}}}', // was: now
      '{"a": {"$date": {"$numberLong": "abc"}}}', // was: epoch
      '{"a": {"$date": "2024-02-30T00:00:00Z"}}', // was: March 1st
      '{"a": {"$date": "2024-01-02T10:00:00"}}', // server-local zone
      '{"a": {"$numberLong": "12a"}}', // was: 12
      '{"a": {"$numberLong": "99999999999999999999"}}', // was: wrapped
      '{"a": {"$numberInt": "9999999999"}}', // was: wrapped
      '{"a": {"$binary": {"base64": "!!!", "subType": "03"}}}', // was: empty
      '{"a": {"$timestamp": {"t": "x", "i": 1}}}', // was: 0
      '{"a": {"$code": "function () {}"}}',
    ]) {
      expect(() => parseMongoJson(bad), bad).toThrow();
    }
  });

  it("never drops operators that sit beside a type key", () => {
    // bson turned this into a bare regex, silently widening a deleteMany.
    expect(
      parseMongoJson(
        '{"name": {"$regex": "^a", "$options": "i", "$nin": ["alice"]}}',
      ),
    ).toEqual({ name: { $regex: "^a", $options: "i", $nin: ["alice"] } });
    expect(() =>
      parseMongoJson('{"a": {"$oid": "65a000000000000000000001", "$ne": 1}}'),
    ).toThrow(/combined/);
  });

  it("rejects an invalid $date instead of writing the epoch", () => {
    expect(() => parseMongoJson('{"at": {"$date": "2024-13-45"}}')).toThrow(
      /\$date/,
    );
    expect(
      parseMongoJson('{"at": {"$date": "2024-01-02T00:00:00Z"}}').at,
    ).toEqual(new Date("2024-01-02T00:00:00Z"));
  });
});

/**
 * Agents write find(filter, projection) to keep documents small — the shell's
 * own form. It used to be parsed as one JSON value and rejected: 17 of 50
 * failed Mongo/ES queries in a week of production audit log were exactly this.
 */
describe("find/findOne projection", () => {
  beforeEach(() => {
    sent.length = 0;
  });

  it("passes the projection to the driver", async () => {
    await executeQuery(
      conn,
      'db.orders.find({"status": "shipped"}, {"_id": 0, "orderId": 1}).limit(5)',
    );
    expect(sent).toEqual([
      {
        op: "find",
        args: { status: "shipped" },
        options: { projection: { _id: 0, orderId: 1 } },
      },
    ]);
  });

  it("does the same for findOne", async () => {
    await executeQuery(conn, 'db.orders.findOne({"id": 7}, {"total": 1})');
    expect(sent[0]).toEqual({
      op: "findOne",
      args: { id: 7 },
      options: { projection: { total: 1 } },
    });
  });

  it("still runs a find with only a filter", async () => {
    await executeQuery(conn, 'db.orders.find({"a": [1, 2], "b": "x, y"})');
    expect(sent[0]).toEqual({
      op: "find",
      args: { a: [1, 2], b: "x, y" },
      options: undefined,
    });
  });

  it("rejects a projection that is not a document", async () => {
    await expect(
      executeQuery(conn, 'db.orders.find({}, ["orderId"])'),
    ).rejects.toThrow(/projection must be an object/);
    expect(sent).toHaveLength(0);
  });

  it("lets distinct take its filter", async () => {
    await executeQuery(conn, 'db.orders.distinct("status", {"region": "EU"})');
    expect(sent[0]).toEqual({
      op: "distinct",
      args: { field: "status", filter: { region: "EU" } },
    });
  });
});

describe("extra arguments", () => {
  beforeEach(() => {
    sent.length = 0;
  });

  it("rejects varargs aggregate stages instead of running only the first", async () => {
    await expect(
      executeQuery(
        conn,
        'db.orders.aggregate({"$match": {"status": "shipped"}}, {"$group": {"_id": "$region"}})',
      ),
    ).rejects.toThrow(
      /aggregate takes at most 1 argument\(s\), got 2 — pass the stages as one array/,
    );
    expect(sent).toHaveLength(0);
  });

  it("rejects options to countDocuments and a third argument to find", async () => {
    await expect(
      executeQuery(conn, 'db.orders.countDocuments({}, {"limit": 10})'),
    ).rejects.toThrow(/countDocuments takes at most 1/);
    await expect(
      executeQuery(conn, 'db.orders.find({}, {"a": 1}, {"skip": 5})'),
    ).rejects.toThrow(/find takes at most 2/);
    expect(sent).toHaveLength(0);
  });
});

describe("splitMongoArgs", () => {
  it("splits only at top-level commas", () => {
    expect(
      splitMongoArgs('{"a": {"b": 1, "c": [1, 2]}, "s": "x, y"}, {"a": 1}')
        .args,
    ).toEqual(['{"a": {"b": 1, "c": [1, 2]}, "s": "x, y"}', ' {"a": 1}']);
  });

  it("ignores quotes escaped inside strings", () => {
    expect(splitMongoArgs('{"q": "say \\"a, b\\""}, {}').args).toEqual([
      '{"q": "say \\"a, b\\""}',
      " {}",
    ]);
  });

  it("stops at the call's own close paren, not one inside a string", () => {
    const text = 'find({"note": "smile :)"}).limit(5)';
    const { args, end } = splitMongoArgs(text, 5);
    expect(args).toEqual(['{"note": "smile :)"}']);
    expect(text.slice(end)).toBe(".limit(5)");
  });
});
