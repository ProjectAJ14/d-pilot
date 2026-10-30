import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ConnectionConfig } from "../types/index.js";

// Fake drivers that record each statement with its bound parameters and answer
// with whatever rows the test queued.
const h = vi.hoisted(() => ({
  calls: [] as { sql: string; params: unknown }[],
  rows: [] as unknown[][],
}));
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
        return { rows: h.rows.shift() ?? [] };
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
              return { recordset: h.rows.shift() ?? [] };
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
  normalizeDefinition,
} = await import("./schema-objects.js");

const pg = { id: "qa-core", type: "postgres", env: "QA" } as ConnectionConfig;
const ms = { id: "qa-ms", type: "mssql", env: "QA" } as ConnectionConfig;

beforeEach(() => {
  h.calls = [];
  h.rows = [];
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

  it("lists nothing for engines without programmable objects", async () => {
    const mongo = { id: "m", type: "mongodb", env: "QA" } as ConnectionConfig;
    expect(await getObjects(mongo)).toEqual([]);
    expect(h.calls).toEqual([]);
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
    ]);
    expect(h.calls[0].sql).toContain("prokind = 'f'");
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
    expect(h.calls[0].params).toEqual(["public", "refresh_order_totals", null]);
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
    expect(deps.usedBy).toEqual([
      { schema: "app_core", name: "nightly_close", kind: "procedure" },
    ]);
    expect(h.calls[0].params).toEqual([
      "app_core",
      "refresh_order_totals",
      "integer",
    ]);
    expect(h.calls[1].params).toEqual(["app_core", "refresh_order_totals"]);
  });
});
