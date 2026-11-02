import { describe, it, expect, vi } from "vitest";
import type { ConnectionConfig, SavedQuery } from "../types/index.js";

const conns: Record<string, Partial<ConnectionConfig>> = {
  pg1: { id: "pg1", type: "postgres" },
  pg2: { id: "pg2", type: "postgres" },
  ms1: { id: "ms1", type: "mssql" },
};
vi.mock("../config/connections.js", () => ({
  getConnection: (id: string) => conns[id],
}));

const { extractReferencedTables, selectExampleQueries } =
  await import("./query-examples.js");

const q = (name: string, sql: string, connectionId?: string): SavedQuery =>
  ({ id: name, name, sql, connectionId }) as SavedQuery;

describe("extractReferencedTables", () => {
  it("returns nothing for empty input", () => {
    expect([...extractReferencedTables("", "postgres")]).toEqual([]);
  });

  it("reads SQL FROM/JOIN/INTO/UPDATE targets, stripping quotes and prefixes", () => {
    const sql = `SELECT * FROM "Orders" o JOIN [Customers] c ON 1=1;
      INSERT INTO app_core.audit_log VALUES (1); UPDATE items SET x = 1`;
    expect([...extractReferencedTables(sql, "postgres")].sort()).toEqual([
      "audit_log",
      "customers",
      "items",
      "orders",
    ]);
  });

  it("reads schema-qualified quoted names by their table part", () => {
    const sql = `SELECT * FROM public."Orders" o
      JOIN [dbo].[Customers] c ON 1=1 JOIN app_core."Line Items" li ON 1=1
      JOIN [db].dbo.[Payments] p ON 1=1`;
    expect([...extractReferencedTables(sql, "postgres")].sort()).toEqual([
      "customers",
      "line items",
      "orders",
      "payments",
    ]);
  });

  it("reads Mongo collections and Elasticsearch indices", () => {
    expect([
      ...extractReferencedTables(
        "db.Orders.find({}); db.customers.count()",
        "mongodb",
      ),
    ]).toEqual(["orders", "customers"]);
    expect([
      ...extractReferencedTables(
        "GET /Orders-2026/_search\nPOST logs*/_count",
        "elasticsearch",
      ),
    ]).toEqual(["orders-2026", "logs*"]);
  });
});

describe("selectExampleQueries", () => {
  const pg = conns.pg1 as ConnectionConfig;

  it("returns nothing when the prompt names no schema table", () => {
    expect(
      selectExampleQueries(
        pg,
        "how many widgets",
        ["orders"],
        [q("a", "SELECT * FROM orders", "pg1")],
      ),
    ).toEqual([]);
  });

  it("picks same-dialect queries that touch the prompt's tables, newest first, max 3", () => {
    const saved = [
      q("no-sql", "", "pg1"),
      q("no-conn", "SELECT * FROM orders"),
      q("unknown-conn", "SELECT * FROM orders", "gone"),
      q("other-dialect", "SELECT * FROM orders", "ms1"),
      q("unrelated", "SELECT * FROM invoices", "pg2"),
      q("one", "SELECT * FROM orders", "pg1"),
      q("two", "SELECT * FROM app_core.customer_accounts", "pg2"),
      q("three", "SELECT * FROM line_items JOIN orders", "pg1"),
      q("four", "SELECT * FROM orders", "pg1"),
    ];
    const out = selectExampleQueries(
      pg,
      "Top ORDER totals by account",
      ["orders", '"app_core"."customer_accounts"', "", "__", "line_items"],
      saved,
    );
    expect(out.map((e) => e.name)).toEqual(["one", "two", "three"]);
    expect(out[0]).toEqual({ name: "one", sql: "SELECT * FROM orders" });
  });

  it("matches the exact table name and ignores short entity suffixes", () => {
    // "tax" is under 4 chars, so "rate_tax" only matches by its full name.
    const saved = [q("t", "SELECT * FROM rate_tax", "pg1")];
    expect(selectExampleQueries(pg, "show tax", ["rate_tax"], saved)).toEqual(
      [],
    );
    expect(
      selectExampleQueries(pg, "show rate_tax", ["rate_tax"], saved),
    ).toHaveLength(1);
  });
});
