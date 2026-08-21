import { describe, it, expect } from "vitest";
import { matchFkTargets, type FullSchema } from "./schema-introspector.js";
import type { ColumnInfo } from "../types/index.js";

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
    const m = matchFkTargets(full, "SELECT * FROM orders", ["id", "customer_id", "status"]);
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
    const m = matchFkTargets(full, "SELECT 'from orders' AS note FROM customers", [
      "customer_id",
      "region_id",
    ]);
    expect(m.has("customer_id")).toBe(false);
    expect(m.get("region_id")).toBe("geo.regions.id");
  });

  it("matches schema-qualified and quoted table references", () => {
    const m = matchFkTargets(full, 'SELECT * FROM public."orders"', ["customer_id"]);
    expect(m.get("customer_id")).toBe("customers.id");
  });

  it("returns nothing when the query reads no known table", () => {
    expect(matchFkTargets(full, "SELECT 1", ["customer_id"]).size).toBe(0);
  });
});
