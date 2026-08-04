import { describe, it, expect } from "vitest";
import { validateQuery } from "./query-executor.js";

const rejects = (sql: string) => {
  const r = validateQuery(sql);
  expect(r.valid, `expected to be rejected: ${sql}`).toBe(false);
  return r.error!;
};

const accepts = (sql: string) => {
  const r = validateQuery(sql);
  expect(r.valid, `expected to be allowed: ${sql} (${r.error})`).toBe(true);
};

describe("validateQuery", () => {
  it("allows ordinary read queries", () => {
    accepts("SELECT * FROM customers");
    accepts("  with recent as (select 1) select * from recent  ");
    accepts("SELECT * FROM orders;"); // a single trailing semicolon is fine
    accepts("EXPLAIN SELECT * FROM orders");
  });

  it("blocks DML/DDL statements", () => {
    expect(rejects("DELETE FROM customers")).toMatch(/DELETE/);
    expect(rejects("  update customers set status = 'x'")).toMatch(/UPDATE/);
    expect(rejects("DROP TABLE customers")).toMatch(/DROP/);
    expect(rejects("TRUNCATE customers")).toMatch(/TRUNCATE/);
    expect(rejects("GRANT ALL ON customers TO bob")).toMatch(/GRANT/);
  });

  it("rejects an empty query", () => {
    expect(rejects("   ")).toMatch(/empty/i);
  });

  // The read path hands the whole string to the driver, and both pg and mssql
  // execute every statement in it — so a leading SELECT must not smuggle a write.
  it("rejects statements stacked behind a read query", () => {
    for (const sql of [
      "SELECT 1 LIMIT 1; DROP TABLE customers",
      "SELECT 1; DELETE FROM customers",
      "SELECT 1 LIMIT 1;\n-- sneaky\nCREATE TABLE t (id int)",
      "SELECT 1 LIMIT 1 ; TRUNCATE customers ;",
    ]) {
      expect(rejects(sql)).toMatch(/one statement/i);
    }
  });

  it("does not mistake semicolons inside literals or comments for statements", () => {
    accepts("SELECT * FROM t WHERE note = 'a;b'");
    accepts("SELECT * FROM t -- trailing ; comment");
    accepts("SELECT * FROM t /* block ; comment */");
    accepts("SELECT $$body with ; and 'quotes'$$ AS x");
  });

  it("does not mistake a keyword inside a literal for the statement verb", () => {
    accepts("SELECT * FROM t WHERE action = 'DELETE'");
    accepts("SELECT 'DROP TABLE customers' AS example");
  });
});
