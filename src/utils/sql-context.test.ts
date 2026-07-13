import { describe, expect, it } from "vitest";
import {
  clauseAt,
  extractCurrentStatement,
  extractTableRefs,
  getSqlCursorContext,
  tokenize,
} from "./sql-context";

/** Context at the `|` marker in the given SQL. */
function ctxAt(sqlWithCursor: string) {
  const offset = sqlWithCursor.indexOf("|");
  if (offset === -1) throw new Error("test SQL needs a | cursor marker");
  const sql = sqlWithCursor.replace("|", "");
  return getSqlCursorContext(sql, offset);
}

describe("extractCurrentStatement", () => {
  it("returns the whole text when there is no semicolon", () => {
    expect(extractCurrentStatement("SELECT 1", 3)).toEqual({
      text: "SELECT 1",
      offset: 3,
    });
  });

  it("isolates the statement containing the cursor", () => {
    const sql = "SELECT * FROM orders; SELECT * FROM customers";
    const second = extractCurrentStatement(sql, sql.length);
    expect(second.text).toBe(" SELECT * FROM customers");
    const first = extractCurrentStatement(sql, 5);
    expect(first.text).toBe("SELECT * FROM orders");
  });

  it("ignores semicolons inside strings and comments", () => {
    const sql = "SELECT ';' FROM t -- ; not a split\nWHERE x = 1";
    expect(extractCurrentStatement(sql, sql.length).text).toBe(sql);
  });

  it("splits statements on blank lines (no semicolons)", () => {
    const sql =
      "SELECT a FROM orders WHERE x = 1\n\nSELECT b FROM customers WHERE ";
    const second = extractCurrentStatement(sql, sql.length);
    expect(second.text.trim()).toBe("SELECT b FROM customers WHERE");
    const first = extractCurrentStatement(sql, 10);
    expect(first.text).toBe("SELECT a FROM orders WHERE x = 1");
  });

  it("blank lines inside parens do not split", () => {
    const sql = "SELECT * FROM t WHERE id IN (\n\n  SELECT id FROM x) AND ";
    expect(extractCurrentStatement(sql, sql.length).text).toBe(sql);
  });

  it("handles CRLF blank lines", () => {
    const sql = "SELECT a FROM orders\r\n\r\nSELECT b FROM customers WHERE ";
    const second = extractCurrentStatement(sql, sql.length);
    expect(second.text.trim()).toBe("SELECT b FROM customers WHERE");
  });
});

describe("tokenize", () => {
  it("skips comments and keeps strings as single tokens", () => {
    const tokens = tokenize("SELECT 'FROM fake' -- from fake_table\nFROM t");
    const words = tokens.filter((t) => t.type === "word").map((t) => t.text);
    expect(words).toEqual(["SELECT", "FROM", "t"]);
  });

  it("unquotes double-quoted and bracketed identifiers", () => {
    const tokens = tokenize('"Weird Table" [Order Details]');
    expect(tokens.map((t) => t.unquoted)).toEqual([
      "Weird Table",
      "Order Details",
    ]);
  });
});

describe("extractTableRefs", () => {
  const refs = (sql: string) => extractTableRefs(tokenize(sql));

  it("finds table + alias after FROM", () => {
    expect(refs("SELECT * FROM orders o")).toEqual([
      { table: "orders", schema: undefined, alias: "o" },
    ]);
  });

  it("handles AS aliases and JOINs", () => {
    expect(refs("FROM orders AS o LEFT JOIN customers c")).toEqual([
      { table: "orders", schema: undefined, alias: "o" },
      { table: "customers", schema: undefined, alias: "c" },
    ]);
  });

  it("handles schema-qualified and quoted names", () => {
    expect(refs('FROM public.orders o, "Weird Table" w')).toEqual([
      { table: "orders", schema: "public", alias: "o" },
      { table: "Weird Table", schema: undefined, alias: "w" },
    ]);
    expect(refs("FROM [dbo].[Order Details] od")).toEqual([
      { table: "Order Details", schema: "dbo", alias: "od" },
    ]);
  });

  it("does not swallow keywords as aliases", () => {
    expect(refs("FROM orders WHERE x = 1")).toEqual([
      { table: "orders", schema: undefined, alias: undefined },
    ]);
    expect(refs("FROM orders o LEFT JOIN")).toEqual([
      { table: "orders", schema: undefined, alias: "o" },
    ]);
  });

  it("handles UPDATE and INSERT INTO targets", () => {
    expect(refs("UPDATE orders SET x = 1")).toEqual([
      { table: "orders", schema: undefined, alias: undefined },
    ]);
    expect(refs("INSERT INTO orders (id, name)")).toEqual([
      { table: "orders", schema: undefined, alias: undefined },
    ]);
  });

  it("skips derived tables but keeps their alias unresolvable", () => {
    expect(refs("FROM (SELECT id FROM x) sub JOIN orders o")).toEqual([
      { table: "", alias: "sub" },
      { table: "orders", schema: undefined, alias: "o" },
    ]);
  });

  it("ignores FROM inside strings and comments", () => {
    expect(refs("SELECT 'FROM fake' -- FROM commented\nFROM real")).toEqual([
      { table: "real", schema: undefined, alias: undefined },
    ]);
  });
});

describe("clauseAt", () => {
  const clause = (sqlWithCursor: string) => {
    const offset = sqlWithCursor.indexOf("|");
    const sql = sqlWithCursor.replace("|", "");
    return clauseAt(tokenize(sql), offset);
  };

  it("detects basic clauses", () => {
    expect(clause("|")).toBe("start");
    expect(clause("SEL|")).toBe("start");
    expect(clause("SELECT |")).toBe("select");
    expect(clause("SELECT * FROM |")).toBe("from");
    expect(clause("SELECT * FROM orders WHERE |")).toBe("where");
    expect(clause("SELECT * FROM orders o JOIN |")).toBe("join");
    expect(clause("FROM a JOIN b ON |")).toBe("on");
    expect(clause("SELECT x FROM t GROUP BY |")).toBe("group_by");
    expect(clause("SELECT x FROM t ORDER BY |")).toBe("order_by");
    expect(clause("SELECT x FROM t GROUP BY x HAVING |")).toBe("having");
  });

  it("detects UPDATE / SET / INSERT clauses", () => {
    expect(clause("UPDATE |")).toBe("update");
    expect(clause("UPDATE orders SET |")).toBe("set");
    expect(clause("INSERT INTO |")).toBe("from");
    expect(clause("INSERT INTO orders (|")).toBe("insert_columns");
    expect(clause("INSERT INTO orders (id) VALUES (|")).toBe("unknown");
  });

  it("pops subquery clauses at the closing paren", () => {
    expect(clause("SELECT * FROM t WHERE id IN (SELECT id FROM x) AND |")).toBe(
      "where",
    );
    expect(clause("SELECT * FROM t WHERE id IN (SELECT |")).toBe("select");
  });
});

describe("getSqlCursorContext", () => {
  it("resolves an alias qualifier even when the cursor is before FROM", () => {
    const ctx = ctxAt("SELECT o.| FROM orders o");
    expect(ctx.qualifier?.raw).toBe("o");
    expect(ctx.qualifier?.ref?.table).toBe("orders");
  });

  it("resolves the joined table's alias", () => {
    const ctx = ctxAt("SELECT * FROM orders o JOIN customers c ON c.|");
    expect(ctx.qualifier?.ref?.table).toBe("customers");
  });

  it("resolves a bare table name qualifier", () => {
    const ctx = ctxAt("SELECT orders.| FROM orders");
    expect(ctx.qualifier?.ref?.table).toBe("orders");
  });

  it("resolves case-insensitively", () => {
    const ctx = ctxAt("select O.| from ORDERS O");
    expect(ctx.qualifier?.ref?.table).toBe("ORDERS");
  });

  it("keeps a partial word prefix after the dot", () => {
    const ctx = ctxAt("SELECT o.nam| FROM orders o");
    expect(ctx.wordPrefix).toBe("nam");
    expect(ctx.qualifier?.ref?.table).toBe("orders");
  });

  it("leaves unknown qualifiers unresolved", () => {
    const ctx = ctxAt("SELECT z.| FROM orders o");
    expect(ctx.qualifier?.raw).toBe("z");
    expect(ctx.qualifier?.ref).toBeUndefined();
  });

  it("has no qualifier after a numeric literal", () => {
    const ctx = ctxAt("SELECT 1.| FROM orders o");
    expect(ctx.qualifier).toBeUndefined();
  });

  it("scopes to the statement containing the cursor", () => {
    const ctx = ctxAt("SELECT * FROM orders; SELECT c.| FROM customers c");
    expect(ctx.tables).toEqual([
      { table: "customers", schema: undefined, alias: "c" },
    ]);
    expect(ctx.qualifier?.ref?.table).toBe("customers");
  });

  it("does not bleed tables across blank-line-separated statements", () => {
    // Real-world scratchpad: queries stacked with a blank line, no ';'.
    const ctx = ctxAt(
      'SELECT order_id, hospital_code from cep_core."order" where hospital_code is null ORDER BY updated_at\n\nSELECT job_id from id_mapping_log where |',
    );
    expect(ctx.tables).toEqual([
      { table: "id_mapping_log", schema: undefined, alias: undefined },
    ]);
    expect(ctx.clause).toBe("where");
  });

  it("collects all tables from comma-separated FROM lists", () => {
    const ctx = ctxAt("SELECT * FROM orders o, customers c WHERE |");
    expect(ctx.tables.map((t) => t.table)).toEqual(["orders", "customers"]);
    expect(ctx.clause).toBe("where");
  });

  it("handles a derived table alias without crashing", () => {
    const ctx = ctxAt("SELECT sub.| FROM (SELECT 1 AS x) sub");
    expect(ctx.qualifier?.raw).toBe("sub");
    expect(ctx.qualifier?.ref?.table).toBe("");
  });

  it("resolves bracket-quoted qualifiers", () => {
    const ctx = ctxAt("SELECT [od].| FROM [dbo].[Order Details] od");
    expect(ctx.qualifier?.ref?.table).toBe("Order Details");
  });
});
