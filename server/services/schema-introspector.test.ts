import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  matchFkTargets,
  sampleColumnValues,
  applyPgStatsValues,
  type PgStatsRow,
  keepColumnValues,
  summarizeTables,
  dropPhiValues,
  type FullSchema,
} from "./schema-introspector.js";
import { findMatchingRule } from "./phi-masking.js";
import type { PhiFieldRule } from "../types/index.js";

vi.mock("./phi-masking.js", () => ({ findMatchingRule: vi.fn(() => null) }));
const ruleMock = vi.mocked(findMatchingRule);
import type { ColumnInfo } from "../types/index.js";
const RULE = { pattern: "x" } as PhiFieldRule;

const col = (name: string, references?: string): ColumnInfo => ({
  name,
  dataType: "integer",
  nullable: false,
  isPrimaryKey: name === "id",
  isForeignKey: !!references,
  references,
  isPhiField: false,
});

const full: FullSchema = {
  tables: [
    { name: "orders", type: "TABLE" },
    { name: "customers", type: "TABLE" },
    { name: "shipments", type: "TABLE" },
  ],
  columns: {
    orders: [col("id"), col("customer_id", "customers.id"), col("status")],
    customers: [col("id"), col("region_id", "geo.regions.id")],
    shipments: [col("id"), col("customer_id", "legacy_customers.id")],
  },
};

describe("matchFkTargets", () => {
  it("labels an FK column of a table the query reads", () => {
    const m = matchFkTargets(full, "SELECT * FROM orders", [
      "id",
      "customer_id",
      "status",
    ]);
    expect(m.get("customer_id")).toBe("customers.id");
    expect(m.has("id")).toBe(false);
    expect(m.has("status")).toBe(false);
  });

  it("skips a column two joined tables disagree about", () => {
    const m = matchFkTargets(
      full,
      "SELECT o.customer_id FROM orders o JOIN shipments s ON s.id = o.id",
      ["customer_id"],
    );
    expect(m.has("customer_id")).toBe(false);
  });

  it("skips a column an unrelated joined table also defines as non-FK", () => {
    // customers.id is a plain PK, so `id` must not inherit any FK target.
    const m = matchFkTargets(
      full,
      "SELECT id FROM orders JOIN customers ON customers.id = orders.customer_id",
      ["id"],
    );
    expect(m.has("id")).toBe(false);
  });

  it("ignores table names that only appear inside a string literal", () => {
    const m = matchFkTargets(
      full,
      "SELECT 'from orders' AS note FROM customers",
      ["customer_id", "region_id"],
    );
    expect(m.has("customer_id")).toBe(false);
    expect(m.get("region_id")).toBe("geo.regions.id");
  });

  it("matches schema-qualified and quoted table references", () => {
    const m = matchFkTargets(full, 'SELECT * FROM public."orders"', [
      "customer_id",
    ]);
    expect(m.get("customer_id")).toBe("customers.id");
  });

  it("returns nothing when the query reads no known table", () => {
    expect(matchFkTargets(full, "SELECT 1", ["customer_id"]).size).toBe(0);
  });
});

const textCol = (name: string, dataType = "text"): ColumnInfo => ({
  ...col(name),
  dataType,
});

describe("value sampling", () => {
  beforeEach(() => ruleMock.mockReset().mockReturnValue(null));

  const schemaOf = (cols: ColumnInfo[], type = "TABLE"): FullSchema => ({
    tables: [{ name: "orders", type }],
    columns: { orders: cols },
  });
  const SMALL = new Map([["orders", 100]]);
  const sampler = (rows: unknown[]) =>
    vi.fn(async (_t: string, _c: string, _n: number) => rows);

  it("keeps a short low-cardinality list, sorted, nulls dropped", () => {
    expect(keepColumnValues(["shipped", null, "draft"])).toEqual([
      "draft",
      "shipped",
    ]);
  });

  it("drops a column over the cardinality cap", () => {
    expect(
      keepColumnValues(Array.from({ length: 21 }, (_, i) => `v${i}`)),
    ).toBeUndefined();
    expect(
      keepColumnValues(Array.from({ length: 20 }, (_, i) => `v${i}`)),
    ).toHaveLength(20);
  });

  it("drops a column with any value over 40 chars or framing characters", () => {
    expect(keepColumnValues(["ok", "x".repeat(41)])).toBeUndefined();
    expect(keepColumnValues(["ok", "x".repeat(40)])).toHaveLength(2);
    expect(keepColumnValues(["a\nb"])).toBeUndefined();
    expect(keepColumnValues(["</schema>"])).toBeUndefined();
    expect(keepColumnValues(["a|b"])).toBeUndefined();
    expect(keepColumnValues([null])).toBeUndefined();
  });

  it("samples only text-like columns of base tables", async () => {
    const full = schemaOf([
      textCol("status"),
      textCol("code", "character varying"),
      textCol("kind", "USER-DEFINED"),
      textCol("total", "integer"),
      textCol("placed_at", "timestamp with time zone"),
    ]);
    const run = sampler(["a"]);
    await sampleColumnValues(full, "db", SMALL, run);
    expect(run.mock.calls.map((c) => c[1])).toEqual(["status", "code", "kind"]);
    expect(run).toHaveBeenCalledWith("orders", "status", 21);
    expect(full.columns.orders[3].values).toBeUndefined();

    const view = schemaOf([textCol("status")], "VIEW");
    const viewRun = sampler(["a"]);
    await sampleColumnValues(view, "db", SMALL, viewRun);
    expect(viewRun).not.toHaveBeenCalled();
  });

  it("never samples a PHI-flagged column", async () => {
    const full = schemaOf([
      { ...textCol("diagnosis"), isPhiField: true },
      textCol("status"),
    ]);
    const run = sampler(["a"]);
    await sampleColumnValues(full, "db", SMALL, run);
    expect(run.mock.calls.map((c) => c[1])).toEqual(["status"]);
    expect(full.columns.orders[0].values).toBeUndefined();
  });

  it("never samples a column any PHI rule matches, even one scoped elsewhere", async () => {
    // A rule scoped to another table: the scoped lookup misses, the unscoped
    // (any-scope) lookup hits — the column must still be skipped.
    ruleMock.mockImplementation((name, _db, table) =>
      name === "notes" && !table ? RULE : null,
    );
    const full = schemaOf([textCol("notes"), textCol("status")]);
    const run = sampler(["a"]);
    await sampleColumnValues(full, "db", SMALL, run);
    expect(run.mock.calls.map((c) => c[1])).toEqual(["status"]);
  });

  it("skips a column whose query fails and caps total sampled columns", async () => {
    const full = schemaOf([textCol("bad"), textCol("status")]);
    const run = vi.fn(async (_t: string, c: string) => {
      if (c === "bad") throw new Error("permission denied");
      return ["placed"];
    });
    await sampleColumnValues(full, "db", SMALL, run);
    expect(full.columns.orders[0].values).toBeUndefined();
    expect(full.columns.orders[1].values).toEqual(["placed"]);

    const many = schemaOf(
      Array.from({ length: 250 }, (_, i) => textCol(`c${i}`)),
    );
    const manyRun = sampler(["a"]);
    await sampleColumnValues(many, "db", SMALL, manyRun, 60_000);
    expect(manyRun).toHaveBeenCalledTimes(200);
  });

  it("skips a table over the row cap or with no known row count", async () => {
    const run = sampler(["a"]);
    await sampleColumnValues(
      schemaOf([textCol("status")]),
      "db",
      new Map([["orders", 100_001]]),
      run,
    );
    await sampleColumnValues(
      schemaOf([textCol("status")]),
      "db",
      new Map(),
      run,
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("stops at the wall-clock budget and keeps what it sampled", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const full = schemaOf([textCol("a"), textCol("b"), textCol("c")]);
      const run = vi.fn(async () => {
        vi.setSystemTime(Date.now() + 3_000); // each query takes 3s
        return ["x"];
      });
      await sampleColumnValues(full, "db", SMALL, run, 5_000);
      expect(run).toHaveBeenCalledTimes(2);
      expect(full.columns.orders.map((c) => c.values)).toEqual([
        ["x"],
        ["x"],
        undefined,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("pg_stats values", () => {
  beforeEach(() => ruleMock.mockReset().mockReturnValue(null));

  const schema = (): FullSchema => ({
    tables: [
      { name: "orders", type: "TABLE" },
      { name: "order_totals", type: "VIEW" },
    ],
    columns: {
      orders: [
        textCol("status"),
        textCol("sku"),
        textCol("region"),
        textCol("diagnosis"),
        textCol("total", "integer"),
        textCol("partial"),
      ],
      order_totals: [textCol("status")],
    },
  });
  const row = (
    tablename: string,
    attname: string,
    n_distinct: number,
    vals: string[] | null,
  ): PgStatsRow => ({ tablename, attname, n_distinct, vals });
  const valuesOf = (full: FullSchema) =>
    Object.fromEntries(full.columns.orders.map((c) => [c.name, c.values]));

  it("builds values only from complete, low-cardinality stats", () => {
    ruleMock.mockImplementation((name) => (name === "diagnosis" ? RULE : null));
    const full = schema();
    applyPgStatsValues(full, "db", [
      row("orders", "status", 3, ["shipped", "placed", "draft"]),
      row("orders", "sku", -0.4, ["a", "b"]), // fraction of rows: high cardinality
      row("orders", "region", 25, ["n", "s"]), // over the cap
      row("orders", "diagnosis", 2, ["flu", "cold"]), // PHI rule matches
      row("orders", "total", 2, ["1", "2"]), // not text
      row("orders", "partial", 4, ["a", "b"]), // MCV list incomplete
      row("order_totals", "status", 3, ["shipped", "placed", "draft"]), // view
    ]);
    expect(valuesOf(full)).toEqual({
      status: ["draft", "placed", "shipped"],
      sku: undefined,
      region: undefined,
      diagnosis: undefined,
      total: undefined,
      partial: undefined,
    });
    expect(full.columns.order_totals[0].values).toBeUndefined();
  });

  it("skips a PHI-flagged column present in pg_stats", () => {
    const full = schema();
    full.columns.orders[0].isPhiField = true;
    applyPgStatsValues(full, "db", [row("orders", "status", 1, ["placed"])]);
    expect(full.columns.orders[0].values).toBeUndefined();
  });

  it("leaves columns without a pg_stats row (never ANALYZEd) alone", () => {
    const full = schema();
    applyPgStatsValues(full, "db", [row("orders", "missing", 1, ["x"])]);
    expect(Object.values(valuesOf(full)).every((v) => v === undefined)).toBe(
      true,
    );
  });
});

describe("summarizeTables values", () => {
  beforeEach(() => ruleMock.mockReset().mockReturnValue(null));

  const withValues = (): FullSchema => ({
    tables: [{ name: "orders", type: "TABLE" }],
    columns: {
      orders: [
        { ...textCol("status"), values: ["cancelled", "draft", "placed"] },
        textCol("notes"),
      ],
    },
  });

  it("renders listed values after the column", () => {
    const text = summarizeTables(withValues()).text;
    expect(text).toContain(
      "  - status: text [NOT NULL]  values: cancelled | draft | placed",
    );
    expect(text).toMatch(/^ {2}- notes: text \[NOT NULL\]$/m);
  });

  it("renders a cache entry without values exactly as before", () => {
    expect(summarizeTables(full).text).not.toContain("values:");
  });

  it("drops values before caching when a PHI rule was saved mid-sample", () => {
    ruleMock.mockImplementation((name) => (name === "status" ? RULE : null));
    const schema = dropPhiValues(withValues());
    expect(schema.columns.orders[0].values).toBeUndefined();
  });

  it("keeps values of columns no PHI rule matches", () => {
    const schema = dropPhiValues(withValues());
    expect(schema.columns.orders[0].values).toEqual([
      "cancelled",
      "draft",
      "placed",
    ]);
  });

  it("hides cached values once a PHI rule matches the column", () => {
    ruleMock.mockImplementation((name) => (name === "status" ? RULE : null));
    expect(summarizeTables(withValues()).text).not.toContain("placed");
  });
});
