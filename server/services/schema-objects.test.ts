import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ConnectionConfig } from "../types/index.js";

// Fake drivers that record each statement with its bound parameters and answer
// with whatever rows the test queued.
const h = vi.hoisted(() => ({
  calls: [] as { sql: string; params: unknown }[],
  rows: [] as (unknown[] | Error)[],
  docs: [] as unknown[],
  jobs: {} as Record<string, unknown>,
}));
// Jobs come from jobs.ts, whose own tests cover the drivers.
vi.mock("./jobs.js", () => ({
  getJobDefinitions: async (c: { id: string }) => {
    const r = h.jobs[c.id];
    if (r instanceof Error) throw r;
    return r ?? { available: false, jobs: [] };
  },
}));
// Mongo/Elasticsearch objects come from document-objects; its own tests cover
// the drivers, so here it just answers with what the test queued.
vi.mock("./document-objects.js", async (orig) => ({
  ...(await orig<typeof import("./document-objects.js")>()),
  getDocumentObjects: async () => h.docs,
}));
const next = () => {
  const r = h.rows.shift();
  if (r instanceof Error) throw r;
  return r ?? [];
};
vi.mock("./sqlite-store.js", () => ({
  getAiColumnValuesEnabled: () => false,
  getSetting: () => null,
}));
vi.mock("./phi-masking.js", () => ({ findMatchingRule: () => null }));
vi.mock("pg", async () => ({
  default: {
    Pool: class extends (await import("node:events")).EventEmitter {
      async query(sql: string, params: unknown[]) {
        h.calls.push({ sql, params });
        return { rows: next() };
      }
      async end() {}
    },
  },
}));
vi.mock("mssql", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    default: {
      VarChar: "varchar",
      NVarChar: "nvarchar",
      ConnectionPool: class extends EventEmitter {
        async connect() {}
        async close() {}
        request() {
          const params: Record<string, unknown> = {};
          return {
            input(name: string, _t: unknown, value: unknown) {
              params[name] = value;
              return this;
            },
            async query(sql: string) {
              h.calls.push({ sql, params });
              return { recordset: next() };
            },
          };
        }
      },
    },
  };
});

const {
  getObjects,
  getObjectDefinition,
  getObjectDependencies,
  AmbiguousObjectError,
  compareDefinitions,
  compareJobs,
  pgArgTypes,
  normalizeDefinition,
  objectKindsFor,
  supportsObjects,
  getDrift,
  isUserRoutine,
} = await import("./schema-objects.js");

const pg = { id: "qa-core", type: "postgres", env: "QA" } as ConnectionConfig;
const ms = { id: "qa-ms", type: "mssql", env: "QA" } as ConnectionConfig;

const mongo = { id: "qa-m", type: "mongodb", env: "QA" } as ConnectionConfig;
const es = {
  id: "qa-es",
  type: "elasticsearch",
  env: "QA",
} as ConnectionConfig;

beforeEach(() => {
  h.calls = [];
  h.rows = [];
  h.docs = [];
  h.jobs = {};
});

describe("getObjects", () => {
  it("lists each Postgres overload as its own entry, keyed by its arguments", async () => {
    h.rows.push([
      {
        name: "refresh_order_totals",
        kind: "function",
        args: "",
        parent: null,
      },
      {
        name: "refresh_order_totals",
        kind: "function",
        args: "integer",
        parent: null,
      },
      { name: "orders_audit", kind: "trigger", args: null, parent: "orders" },
      { name: "open_orders", kind: "view", args: null, parent: null },
    ]);
    const objects = await getObjects(pg, "app_core");
    expect(objects).toEqual([
      {
        schema: "app_core",
        name: "refresh_order_totals",
        kind: "function",
        args: "",
      },
      {
        schema: "app_core",
        name: "refresh_order_totals",
        kind: "function",
        args: "integer",
      },
      {
        schema: "app_core",
        name: "orders_audit",
        kind: "trigger",
        parent: "orders",
      },
      { schema: "app_core", name: "open_orders", kind: "view" },
    ]);
    // The schema is bound, never spliced, and system/extension objects are filtered.
    expect(h.calls[0].params).toEqual(["app_core"]);
    expect(h.calls[0].sql).not.toContain("app_core");
    expect(h.calls[0].sql).toContain("deptype = 'e'");
    expect(h.calls[0].sql).toContain("NOT t.tgisinternal");
  });

  it("maps SQL Server type codes to kinds and skips shipped objects", async () => {
    h.rows.push([
      { name: "refresh_order_totals", type: "P ", parent: null },
      { name: "order_total", type: "FN", parent: null },
      { name: "orders_for", type: "IF", parent: null },
      { name: "open_orders", type: "V ", parent: null },
      { name: "orders_audit", type: "TR", parent: "orders" },
    ]);
    const objects = await getObjects(ms, "app_core");
    expect(objects.map((o) => [o.name, o.kind, o.parent])).toEqual([
      ["refresh_order_totals", "procedure", undefined],
      ["order_total", "function", undefined],
      ["orders_for", "function", undefined],
      ["open_orders", "view", undefined],
      ["orders_audit", "trigger", "orders"],
    ]);
    expect(h.calls[0].params).toEqual({ schema: "app_core" });
    expect(h.calls[0].sql).toContain("is_ms_shipped = 0");
  });
});

describe("getObjectDefinition", () => {
  it("binds a Postgres overload's arguments and returns its body", async () => {
    h.rows.push([
      {
        args: "integer",
        parent: null,
        definition:
          "CREATE OR REPLACE FUNCTION app_core.refresh_order_totals(integer) …",
      },
    ]);
    const def = await getObjectDefinition(pg, {
      kind: "function",
      name: "refresh_order_totals",
      schema: "app_core",
      args: "integer",
    });
    expect(def).toMatchObject({
      args: "integer",
      definition: expect.stringContaining("FUNCTION"),
    });
    expect(h.calls[0].params).toEqual([
      "app_core",
      "refresh_order_totals",
      "integer",
      null,
    ]);
    expect(h.calls[0].sql).toContain("prokind = 'f'");
  });

  it("finds the same overload by argument types when its parameter was renamed", async () => {
    h.rows.push([
      { args: "p_new integer", arg_types: "integer", definition: "CREATE …" },
    ]);
    const def = await getObjectDefinition(pg, {
      kind: "function",
      name: "open_order_count",
      schema: "app_core",
      args: "p_old integer",
      argTypes: "integer",
    });
    expect(def).toMatchObject({ args: "p_new integer", argTypes: "integer" });
    expect(h.calls[0].params).toEqual([
      "app_core",
      "open_order_count",
      "p_old integer",
      "integer",
    ]);
    expect(h.calls[0].sql).toContain("oidvectortypes(p.proargtypes) = $4");
  });

  it("refuses to guess between overloads when no arguments are given", async () => {
    h.rows.push([
      { args: "", definition: "a" },
      { args: "integer", definition: "b" },
    ]);
    const lookup = getObjectDefinition(pg, {
      kind: "function",
      name: "refresh_order_totals",
    });
    await expect(lookup).rejects.toBeInstanceOf(AmbiguousObjectError);
    await expect(lookup).rejects.toThrow("() | (integer)");
    expect(h.calls[0].params).toEqual([
      "public",
      "refresh_order_totals",
      null,
      null,
    ]);
  });

  it("keys a Postgres trigger by its table, and ignores args on a view", async () => {
    h.rows.push([
      { args: null, parent: "orders", definition: "CREATE TRIGGER …;" },
    ]);
    await getObjectDefinition(pg, {
      kind: "trigger",
      name: "orders_audit",
      schema: "app_core",
      parent: "orders",
    });
    expect(h.calls[0].params).toEqual(["app_core", "orders_audit", "orders"]);

    h.rows.push([
      { args: null, parent: null, definition: "CREATE OR REPLACE VIEW …" },
    ]);
    await getObjectDefinition(pg, {
      kind: "view",
      name: "open_orders",
      schema: "app_core",
      args: "stray",
    });
    expect(h.calls[1].params).toEqual(["app_core", "open_orders", null]);
  });

  it("returns null definition for an encrypted SQL Server object, not an empty one", async () => {
    h.rows.push([{ definition: null, parent: null }]);
    const def = await getObjectDefinition(ms, {
      kind: "procedure",
      name: "refresh_order_totals",
      schema: "app_core",
    });
    expect(def).toEqual({
      schema: "app_core",
      name: "refresh_order_totals",
      kind: "procedure",
      definition: null,
    });
    expect(h.calls[0].params).toEqual({
      schema: "app_core",
      name: "refresh_order_totals",
    });
    expect(h.calls[0].sql).toContain("o.type IN ('P')");
  });

  it("returns null when the object does not exist", async () => {
    h.rows.push([]);
    expect(
      await getObjectDefinition(ms, {
        kind: "view",
        name: "nope",
        schema: "dbo",
      }),
    ).toBeNull();
  });
});

describe("drift", () => {
  it("treats line endings and trailing whitespace as the same definition", () => {
    expect(normalizeDefinition("SELECT 1  \r\nFROM orders\t\r\n\r\n")).toBe(
      "SELECT 1\nFROM orders",
    );
  });

  it("reports differences and one-sided objects, never a hidden definition as identical", () => {
    const o = (name: string, definition: string | null, args?: string) => ({
      schema: "app_core",
      name,
      kind: "function" as const,
      ...(args != null && { args }),
      definition,
    });
    const report = compareDefinitions(
      "app_core",
      [
        o("same", "SELECT 1\r\n"),
        o("changed", "SELECT 1"),
        o("hidden", null),
        o("refresh_order_totals", "a", ""),
        o("dev_only", "x"),
      ],
      [
        o("same", "SELECT 1"),
        o("changed", "SELECT 2"),
        o("hidden", null),
        o("refresh_order_totals", "a", "integer"),
        o("qa_only", "y"),
      ],
    );
    expect(report.identical).toBe(1);
    expect(report.items.map((i) => [i.name, i.args, i.status])).toEqual([
      ["changed", undefined, "different"],
      ["dev_only", undefined, "only_left"],
      ["hidden", undefined, "different"],
      ["qa_only", undefined, "only_right"],
      // Overloads are different objects: each exists on one side only.
      ["refresh_order_totals", "", "only_left"],
      ["refresh_order_totals", "integer", "only_right"],
    ]);
    expect(report.items[0]).not.toHaveProperty("definition");
  });

  it("matches a Postgres overload by argument types, so a renamed parameter is a difference", () => {
    const f = (args: string, definition: string) => ({
      schema: "app_core",
      name: "open_order_count",
      kind: "function" as const,
      args,
      argTypes: "integer",
      definition,
    });
    const report = compareDefinitions(
      "app_core",
      [f("p_customer_id integer", "a")],
      [f("customer integer", "b")],
    );
    expect(report.items).toEqual([
      {
        schema: "app_core",
        name: "open_order_count",
        kind: "function",
        args: "p_customer_id integer",
        argTypes: "integer",
        status: "different",
      },
    ]);
  });

  it("leaves out triggers cloned onto partitions, and reads argument types for drift", async () => {
    h.rows = [[]];
    await getObjects(pg, "app_core");
    expect(h.calls[0].sql).toMatch(/pd\.deptype = 'P'/);
    expect(h.calls[0].sql).toContain("oidvectortypes(p.proargtypes)");
  });
});

describe("pgArgTypes", () => {
  it("asks the database for each type, trying past a parameter name first", async () => {
    // "p_ts timestamp": the tail resolves. "double precision": the tail
    // ("precision") does not, the whole does.
    h.rows = [
      [{ t: "timestamp without time zone" }],
      [{ t: null }],
      [{ t: "double precision" }],
    ];
    expect(
      await pgArgTypes(pg, ["p_ts timestamp", "double precision"]),
    ).toEqual(["timestamp without time zone", "double precision"]);
    expect(h.calls.map((c) => c.params)).toEqual([
      ["timestamp"],
      ["precision"],
      ["double precision"],
    ]);
  });
});

describe("getObjectDependencies", () => {
  it("keeps unresolved and cross-database SQL Server references instead of dropping them", async () => {
    h.rows.push([
      { dir: "uses", db: null, sch: "app_core", name: "orders", type: "U " },
      {
        dir: "uses",
        db: null,
        sch: "app_core",
        name: "dropped_view",
        type: null,
      },
      {
        dir: "uses",
        db: "archive",
        sch: "dbo",
        name: "orders_2019",
        type: null,
      },
      {
        dir: "usedBy",
        db: null,
        sch: "app_core",
        name: "nightly_close",
        type: "P ",
      },
    ]);
    const deps = await getObjectDependencies(ms, {
      kind: "view",
      name: "open_orders",
      schema: "app_core",
    });
    expect(deps).toEqual({
      uses: [
        { schema: "app_core", name: "orders", kind: "table" },
        { schema: "app_core", name: "dropped_view", kind: null },
        { schema: "dbo", name: "orders_2019", kind: null, database: "archive" },
      ],
      usedBy: [
        { schema: "app_core", name: "nightly_close", kind: "procedure" },
      ],
      bestEffort: false,
    });
    // Bound, and the referenced side is LEFT JOINed so unresolved rows survive.
    expect(h.calls[0].params).toEqual({
      schema: "app_core",
      name: "open_orders",
    });
    expect(h.calls[0].sql).toContain("LEFT JOIN sys.objects");
  });

  it("marks Postgres routine dependencies best-effort and binds the overload", async () => {
    h.rows.push(
      [{ dir: "uses", sch: "app_core", name: "orders", kind: "table" }],
      [
        {
          dir: "usedBy",
          sch: "app_core",
          name: "nightly_close",
          kind: "procedure",
          args: "IN p_days integer",
          parent: null,
        },
        {
          dir: "usedBy",
          sch: "app_core",
          name: "orders_audit",
          kind: "trigger",
          args: null,
          parent: "orders",
        },
      ],
    );
    const deps = await getObjectDependencies(pg, {
      kind: "function",
      name: "refresh_order_totals",
      schema: "app_core",
      args: "integer",
    });
    expect(deps.bestEffort).toBe(true);
    // Each carries what opening it needs: the overload, or the trigger's table.
    expect(deps.usedBy).toEqual([
      {
        schema: "app_core",
        name: "nightly_close",
        kind: "procedure",
        args: "IN p_days integer",
      },
      {
        schema: "app_core",
        name: "orders_audit",
        kind: "trigger",
        parent: "orders",
      },
    ]);
    expect(h.calls[0].params).toEqual([
      "app_core",
      "refresh_order_totals",
      "integer",
    ]);
    expect(h.calls[1].params).toEqual(["app_core", "refresh_order_totals"]);
  });
});

describe("engine capabilities", () => {
  it("offers each engine its own object kinds", () => {
    expect(objectKindsFor(pg)).toEqual([
      "procedure",
      "function",
      "view",
      "trigger",
    ]);
    expect(objectKindsFor(ms)).toEqual(objectKindsFor(pg));
    expect(objectKindsFor(mongo)).toEqual(["view", "index", "validator"]);
    expect(objectKindsFor(es)).toContain("ingest_pipeline");
    expect([pg, ms, mongo, es].map(supportsObjects)).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });
});

describe("document-store objects", () => {
  const docs = [
    {
      schema: "app_core",
      name: "status_due",
      kind: "index",
      parent: "orders",
      definition: "{}",
    },
    {
      schema: "app_core",
      name: "status_due",
      kind: "index",
      parent: "customers",
      definition: "{ }",
    },
    { schema: "app_core", name: "open_orders", kind: "view", definition: "[]" },
  ];

  it("lists them without their definitions", async () => {
    h.docs = docs;
    const list = await getObjects(mongo);
    expect(list.map((o) => [o.kind, o.name, o.parent])).toEqual([
      ["index", "status_due", "orders"],
      ["index", "status_due", "customers"],
      ["view", "open_orders", undefined],
    ]);
    expect(list[0]).not.toHaveProperty("definition");
  });

  it("finds one by kind, name and (when given) parent", async () => {
    h.docs = docs;
    expect(
      await getObjectDefinition(mongo, {
        kind: "index",
        name: "status_due",
        parent: "customers",
      }),
    ).toBe(docs[1]);
    expect(
      await getObjectDefinition(mongo, { kind: "view", name: "open_orders" }),
    ).toBe(docs[2]);
    expect(
      await getObjectDefinition(mongo, { kind: "view", name: "status_due" }),
    ).toBeNull();
    expect(
      await getObjectDefinition(es, {
        kind: "index",
        name: "status_due",
        parent: "invoices",
      }),
    ).toBeNull();
  });

  it("has no SQL dependencies and no user routines", async () => {
    expect(
      await getObjectDependencies(mongo, { kind: "view", name: "open_orders" }),
    ).toEqual({ uses: [], usedBy: [], bestEffort: false });
    expect(await isUserRoutine(es, "refresh_order_totals")).toBe(false);
    expect(h.calls).toEqual([]);
  });
});

describe("getDrift", () => {
  it("reads definitions on both sides and compares them", async () => {
    h.rows.push(
      [
        {
          name: "refresh_order_totals",
          kind: "function",
          args: "integer",
          arg_types: "integer",
          parent: null,
          definition: "CREATE FUNCTION …",
        },
        { name: "open_orders", kind: "view", args: null, parent: null },
      ],
      [
        { name: "refresh_order_totals", type: "FN", parent: null },
        {
          name: "orders_audit",
          type: "TR",
          parent: "orders",
          definition: "CREATE TRIGGER …",
        },
      ],
    );
    const report = await getDrift(pg, ms, "app_core");
    // Bodies are only fetched for a drift report.
    expect(h.calls[0].sql).toContain("pg_get_functiondef(p.oid)");
    expect(h.calls[0].sql).toContain("pg_get_viewdef(c.oid, true)");
    expect(h.calls[0].sql).toContain("pg_get_triggerdef(t.oid, true)");
    expect(h.calls[1].sql).toContain("OBJECT_DEFINITION(o.object_id)");
    expect(report.schema).toBe("app_core");
    expect(report.identical).toBe(0);
    expect(report.items.map((i) => [i.kind, i.name, i.status])).toEqual([
      ["function", "refresh_order_totals", "only_right"],
      ["function", "refresh_order_totals", "only_left"],
      ["trigger", "orders_audit", "only_right"],
      ["view", "open_orders", "only_left"],
    ]);
  });

  it("has no jobs section when neither side has jobs", async () => {
    expect(await getDrift(pg, pg, "app_core")).not.toHaveProperty("jobs");
  });

  it("compares the jobs on both databases, whatever the schema", async () => {
    const prod = { ...pg, id: "prod-core", name: "PROD core" };
    h.jobs = {
      "qa-core": {
        available: true,
        jobs: [
          {
            id: "1",
            name: "vacuum",
            key: "vacuum",
            definition: "schedule: 0 3 * * *\n\nVACUUM orders",
          },
        ],
      },
      // pg_cron missing on one side: its jobs are only on the other.
      "prod-core": { available: false, jobs: [] },
    };
    expect((await getDrift(pg, prod, "app_core")).jobs).toEqual({
      identical: 0,
      items: [{ name: "vacuum", status: "only_left", leftId: "1" }],
    });
  });

  it("says which side can't read jobs instead of comparing them", async () => {
    const left = { ...ms, name: "QA ms" };
    const right = { ...ms, id: "prod-ms", name: "PROD ms" };
    h.jobs = {
      "qa-ms": {
        available: true,
        jobs: [{ id: "a", name: "nightly", key: "nightly", definition: "x" }],
      },
      "prod-ms": {
        available: false,
        reason: "Needs SQLAgentReaderRole.",
        jobs: [],
      },
    };
    expect((await getDrift(left, right)).jobs).toEqual({
      identical: 0,
      items: [],
      unavailable: "PROD ms: Needs SQLAgentReaderRole.",
    });
    h.jobs["qa-ms"] = { available: false, reason: "No grant.", jobs: [] };
    expect((await getDrift(left, right)).jobs?.unavailable).toBe(
      "QA ms: No grant. PROD ms: Needs SQLAgentReaderRole.",
    );
  });

  it("names a failure to read jobs and still compares the objects", async () => {
    const left = { ...ms, name: "QA ms" };
    const right = { ...ms, id: "prod-ms", name: "PROD ms" };
    h.jobs = { "prod-ms": new Error("msdb timeout") };
    h.rows.push([
      { name: "open_orders", type: "V", parent: null, definition: "x" },
    ]);
    const report = await getDrift(left, right);
    expect(report.items.map((i) => [i.name, i.status])).toEqual([
      ["open_orders", "only_left"],
    ]);
    expect(report.jobs?.unavailable).toBe(
      "PROD ms: Couldn't read its jobs (msdb timeout).",
    );
  });
});

describe("compareJobs", () => {
  it("matches jobs by key across servers and compares normalized definitions", () => {
    const j = (id: string, name: string, definition: string, key = name) => ({
      id,
      name,
      key,
      definition,
    });
    const report = compareJobs(
      [
        j("1", "same", "SELECT 1  \r\n"),
        j("2", "changed", "a"),
        j("3", "qa_only", "x"),
        // Unnamed: different ids and names on each server, same key.
        j("4", "(unnamed job 4)", "y", "unnamed:abc"),
      ],
      [
        j("9", "same", "SELECT 1"),
        j("8", "changed", "b"),
        j("7", "prod_only", "y"),
        j("6", "(unnamed job 6)", "y", "unnamed:abc"),
      ],
    );
    expect(report).toEqual({
      identical: 2,
      items: [
        { name: "changed", status: "different", leftId: "2", rightId: "8" },
        { name: "prod_only", status: "only_right", rightId: "7" },
        { name: "qa_only", status: "only_left", leftId: "3" },
      ],
    });
  });
});

describe("definition lookups — edge cases", () => {
  it("names the table when a Postgres trigger name is ambiguous", async () => {
    h.rows.push([
      { args: null, parent: "orders", definition: "a" },
      { args: null, parent: "customers", definition: "b" },
    ]);
    await expect(
      getObjectDefinition(pg, { kind: "trigger", name: "audit" }),
    ).rejects.toThrow("pass parent (its table), one of: orders | customers");
  });

  it("returns null for a missing Postgres object and null for a hidden body", async () => {
    h.rows.push([]);
    expect(
      await getObjectDefinition(pg, { kind: "procedure", name: "nope" }),
    ).toBeNull();
    expect(h.calls[0].params).toEqual(["public", "nope", null, null]);

    h.rows.push([{ args: "", parent: null }]);
    expect(
      await getObjectDefinition(pg, { kind: "procedure", name: "nightly" }),
    ).toEqual({
      schema: "public",
      name: "nightly",
      kind: "procedure",
      args: "",
      definition: null,
    });
  });

  it("returns a SQL Server trigger with its table", async () => {
    h.rows.push([{ definition: "CREATE TRIGGER …", parent: "orders" }]);
    expect(
      await getObjectDefinition(ms, { kind: "trigger", name: "orders_audit" }),
    ).toMatchObject({ schema: "dbo", parent: "orders" });
    expect(h.calls[0].sql).toContain("o.type IN ('TR')");
  });
});

describe("dependencies — edge cases", () => {
  it("leaves an SQL Server reference of an unknown type unresolved", async () => {
    h.rows.push([
      { dir: "uses", db: null, sch: null, name: "orders_syn", type: "SN" },
    ]);
    const deps = await getObjectDependencies(ms, {
      kind: "procedure",
      name: "nightly_close",
    });
    expect(deps.uses).toEqual([{ name: "orders_syn", kind: null }]);
    expect(h.calls[0].params).toEqual({ schema: "dbo", name: "nightly_close" });
  });

  it("reads a Postgres view's exact dependencies plus body matches, deduped", async () => {
    const orders = {
      dir: "uses",
      sch: "app_core",
      name: "orders",
      kind: "table",
    };
    h.rows.push([orders, orders], []);
    const deps = await getObjectDependencies(pg, {
      kind: "view",
      name: "open_orders",
      schema: "app_core",
    });
    expect(deps).toEqual({
      uses: [{ schema: "app_core", name: "orders", kind: "table" }],
      usedBy: [],
      bestEffort: true,
    });
    expect(h.calls[0].params).toEqual(["app_core", "open_orders", "view"]);
    expect(h.calls[1].params).toEqual(["app_core", "open_orders"]);
  });

  it("answers a Postgres trigger exactly, with no body search", async () => {
    h.rows.push([
      { dir: "uses", sch: "public", name: "orders", kind: "table" },
    ]);
    const deps = await getObjectDependencies(pg, {
      kind: "trigger",
      name: "orders_audit",
    });
    expect(deps.bestEffort).toBe(false);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].params).toEqual(["public", "orders_audit", null]);
  });

  it("binds no overload for a routine given without args", async () => {
    h.rows.push([], []);
    await getObjectDependencies(pg, { kind: "procedure", name: "nightly" });
    expect(h.calls[0].params).toEqual(["public", "nightly", null]);
  });
});

describe("isUserRoutine", () => {
  it("asks Postgres by schema and name, and refuses a bare name", async () => {
    expect(await isUserRoutine(pg, "refresh_order_totals")).toBe(false);
    expect(h.calls).toEqual([]);

    h.rows.push([{ "?column?": 1 }], []);
    const ref = { schema: "app_core", name: "refresh_order_totals" };
    expect(await isUserRoutine(pg, ref)).toBe(true);
    expect(await isUserRoutine(pg, ref)).toBe(false);
    expect(h.calls[0].params).toEqual(["app_core", "refresh_order_totals"]);
    expect(h.calls[0].sql).toContain("deptype = 'e'");
  });

  it("asks SQL Server by the name SHOWPLAN reported, never across databases", async () => {
    h.rows.push([{ ok: 1 }], []);
    expect(await isUserRoutine(ms, "dbo.nightly_close")).toBe(true);
    expect(await isUserRoutine(ms, "other.dbo.x")).toBe(false);
    expect(h.calls[0].params).toEqual({ name: "dbo.nightly_close" });
    expect(h.calls[0].sql).toContain("PARSENAME(@name, 4) IS NULL");
    expect(h.calls[0].sql).not.toContain("OBJECT_ID");
  });
});

describe("pgArgTypes — edge cases", () => {
  it("resolves a bare type directly and maps a rejected one to null", async () => {
    h.rows = [[{ t: "integer" }], new Error("syntax error"), []];
    expect(await pgArgTypes(pg, ["int", "not a type"])).toEqual([
      "integer",
      null,
    ]);
    expect(h.calls.map((c) => c.params)).toEqual([
      ["int"],
      ["a type"],
      ["not a type"],
    ]);
  });
});
