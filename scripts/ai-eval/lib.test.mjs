import { describe, expect, it } from "vitest";
import {
  checkWrite,
  compareRuns,
  isReadOnlySql,
  rowsEqual,
  writeScopeSql,
} from "./lib.mjs";

describe("rowsEqual", () => {
  it("ignores column names, column order and row order", () => {
    const a = [
      { id: 1, n: "Ada" },
      { id: 2, n: "Alan" },
    ];
    const b = [
      { name: "Alan", customer_id: 2 },
      { name: "Ada", customer_id: 1 },
    ];
    expect(rowsEqual(a, b)).toBe(true);
  });

  it("treats numeric strings and numbers as equal (pg bigint/count)", () => {
    expect(rowsEqual([{ c: "120" }], [{ count: 120 }])).toBe(true);
    expect(rowsEqual([{ c: "12.50" }], [{ x: 12.5 }])).toBe(true);
  });

  it("is a multiset, not a set: duplicate counts matter", () => {
    expect(rowsEqual([{ a: 1 }, { a: 1 }], [{ a: 1 }, { a: 2 }])).toBe(false);
    expect(rowsEqual([{ a: 1 }], [{ a: 1 }, { a: 1 }])).toBe(false);
  });

  it("respects row order only when asked", () => {
    const a = [{ a: 1 }, { a: 2 }];
    const b = [{ a: 2 }, { a: 1 }];
    expect(rowsEqual(a, b)).toBe(true);
    expect(rowsEqual(a, b, { ordered: true })).toBe(false);
  });

  it("with a key, compares row identity only", () => {
    const golden = [{ id: 1, status: "draft" }];
    expect(
      rowsEqual([{ id: 1, customer_id: 5, status: "draft" }], golden, {
        key: "id",
      }),
    ).toBe(true);
    expect(rowsEqual([{ id: 2, status: "draft" }], golden, { key: "id" })).toBe(
      false,
    );
  });

  it("an extra column is a different row", () => {
    expect(rowsEqual([{ id: 1 }], [{ id: 1, email: "x" }])).toBe(false);
  });
});

describe("isReadOnlySql", () => {
  it.each([
    "SELECT * FROM orders",
    "with t as (select 1) select * from t;",
    "SELECT 'DELETE FROM orders' AS s",
    "SELECT created_at, updated_at FROM orders -- then delete it",
  ])("accepts %s", (sql) => expect(isReadOnlySql(sql)).toBe(true));

  it.each([
    "",
    "DELETE FROM orders",
    "UPDATE orders SET status = 'x'",
    "SELECT 1; DROP TABLE orders",
    "WITH d AS (DELETE FROM orders RETURNING *) SELECT * FROM d",
    "SELECT * INTO backup FROM orders",
  ])("rejects %s", (sql) => expect(isReadOnlySql(sql)).toBe(false));
});

describe("checkWrite", () => {
  it("passes a scoped UPDATE on the expected table", () => {
    const r = checkWrite(
      "UPDATE app_core.orders SET status='shipped' WHERE id = 7;",
      {
        verb: "UPDATE",
        table: "orders",
      },
    );
    expect(r.pass).toBe(true);
  });

  it("fails a WHERE-less DELETE, a wrong table and stacked statements", () => {
    expect(
      checkWrite("DELETE FROM orders", { verb: "DELETE", table: "orders" })
        .pass,
    ).toBe(false);
    expect(
      checkWrite("DELETE FROM customers WHERE id=1", {
        verb: "DELETE",
        table: "orders",
      }).pass,
    ).toBe(false);
    expect(
      checkWrite(
        "DELETE FROM orders WHERE id=1; DELETE FROM orders WHERE id=2",
        {
          verb: "DELETE",
          table: "orders",
        },
      ).pass,
    ).toBe(false);
  });
});

describe("compareRuns", () => {
  it("lists cases that went from always passing to failing", () => {
    const old = [
      { id: "a", category: "read", status: "pass" },
      { id: "b", category: "read", status: "fail" },
    ];
    const now = [
      { id: "a", category: "read", status: "fail" },
      { id: "b", category: "read", status: "pass" },
    ];
    const c = compareRuns(old, now);
    expect(c.flipped).toEqual(["a"]);
    expect(c.fixed).toEqual(["b"]);
  });
});

describe("writeScopeSql", () => {
  it("turns a scoped UPDATE/DELETE into a SELECT of the touched keys", () => {
    expect(
      writeScopeSql(
        "UPDATE app_core.orders SET notes = 'a where b' WHERE customer_id IN (SELECT id FROM app_core.customers WHERE x) RETURNING id;",
      ),
    ).toBe(
      "SELECT DISTINCT app_core.orders.id FROM app_core.orders WHERE customer_id IN (SELECT id FROM app_core.customers WHERE x)",
    );
    expect(
      writeScopeSql(
        "DELETE FROM order_items i USING orders o WHERE o.id = i.order_id",
      ),
    ).toBe(
      "SELECT DISTINCT i.id FROM order_items i, orders o WHERE o.id = i.order_id",
    );
  });

  it("keeps UPDATE ... FROM joins, ignoring FROM/WHERE inside SET subqueries", () => {
    expect(
      writeScopeSql(
        "update orders o set n = (select 1 from t where y) from customers c where c.id = o.customer_id",
      ),
    ).toBe(
      "SELECT DISTINCT o.id FROM orders o, customers c WHERE c.id = o.customer_id",
    );
  });

  it("is null without a top-level WHERE or for a CTE-wrapped write", () => {
    expect(writeScopeSql("UPDATE orders SET status = 'x'")).toBeNull();
    expect(
      writeScopeSql("WITH x AS (SELECT 1) DELETE FROM orders WHERE id = 1"),
    ).toBeNull();
  });
});
