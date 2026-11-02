import { describe, expect, it } from "vitest";
import type { languages } from "monaco-editor";
import type { ColumnInfo, TableInfo } from "../types";
import {
  buildSqlSuggestions,
  pushKeywordItems,
  type SchemaEntry,
} from "./sql-completions";
import { getSqlCursorContext } from "./sql-context";

const monaco = {
  languages: {
    CompletionItemKind: {
      Keyword: 17,
      Field: 3,
      Struct: 21,
    } as unknown as typeof languages.CompletionItemKind,
  },
};

const col = (name: string, extra: Partial<ColumnInfo> = {}): ColumnInfo => ({
  name,
  dataType: "text",
  nullable: true,
  isPrimaryKey: false,
  isForeignKey: false,
  isPhiField: false,
  ...extra,
});

const table = (name: string): TableInfo => ({
  schema: "public",
  name,
  type: "table",
});

const schema: SchemaEntry = {
  tables: [table("orders"), table("customers"), table("products")],
  columns: {
    orders: [
      col("id", { isPrimaryKey: true }),
      col("customer_id"),
      col("total"),
    ],
    customers: [col("id", { isPrimaryKey: true }), col("name")],
    products: [col("id"), col("sku")],
  },
};

const range = {
  startLineNumber: 1,
  endLineNumber: 1,
  startColumn: 1,
  endColumn: 1,
};

function suggestionsAt(sqlWithCursor: string) {
  const offset = sqlWithCursor.indexOf("|");
  const sql = sqlWithCursor.replace("|", "");
  return buildSqlSuggestions({
    monaco,
    ctx: getSqlCursorContext(sql, offset),
    schema,
    dialect: "postgres",
    range,
  });
}

const labels = (items: languages.CompletionItem[]) =>
  items.map((s) => (typeof s.label === "string" ? s.label : s.label.label));

describe("buildSqlSuggestions decision table", () => {
  it("alias dot → only that table's columns", () => {
    const items = suggestionsAt("SELECT o.| FROM orders o");
    expect(labels(items).sort()).toEqual(["customer_id", "id", "total"]);
    expect(
      items.every((s) => s.kind === monaco.languages.CompletionItemKind.Field),
    ).toBe(true);
  });

  it("bare table dot works without a FROM clause", () => {
    const items = suggestionsAt("SELECT customers.|");
    expect(labels(items).sort()).toEqual(["id", "name"]);
  });

  it("unknown qualifier → no suggestions", () => {
    expect(suggestionsAt("SELECT zzz.| FROM orders o")).toEqual([]);
  });

  it("FROM position → tables ranked first, no column flood", () => {
    const items = suggestionsAt("SELECT * FROM |");
    const tableLabels = items
      .filter((s) => s.kind === monaco.languages.CompletionItemKind.Struct)
      .map((s) => s.label);
    expect(tableLabels).toEqual(["orders", "customers", "products"]);
    expect(
      items.some((s) => s.kind === monaco.languages.CompletionItemKind.Field),
    ).toBe(false);
    const tableItem = items.find((s) => s.label === "orders")!;
    expect(tableItem.sortText!.startsWith("0_")).toBe(true);
  });

  it("WHERE with known tables → only in-statement columns", () => {
    const items = suggestionsAt("SELECT * FROM orders WHERE |");
    const fields = items.filter(
      (s) => s.kind === monaco.languages.CompletionItemKind.Field,
    );
    expect(labels(fields).sort()).toEqual(["customer_id", "id", "total"]);
    // products/customers columns must NOT appear
    expect(labels(fields)).not.toContain("sku");
    expect(labels(fields)).not.toContain("name");
  });

  it("two tables in scope → qualified inserts", () => {
    const items = suggestionsAt(
      "SELECT | FROM orders o JOIN customers c ON o.customer_id = c.id",
    );
    const totalItem = items.find((s) => s.label === "total")!;
    expect(totalItem.insertText).toBe("o.total");
    const nameItem = items.find((s) => s.label === "name")!;
    expect(nameItem.insertText).toBe("c.name");
  });

  it("qualified inserts quote reserved-word table names", () => {
    const reservedSchema: SchemaEntry = {
      tables: [table("order"), table("customers")],
      columns: {
        order: [col("region_code")],
        customers: [col("name")],
      },
    };
    const sql = 'SELECT  FROM app_core."order" JOIN customers ON 1=1';
    const items = buildSqlSuggestions({
      monaco,
      ctx: getSqlCursorContext(sql, "SELECT ".length),
      schema: reservedSchema,
      dialect: "postgres",
      range,
    });
    const region = items.find((s) => s.label === "region_code")!;
    expect(region.insertText).toBe('"order".region_code');
    const name = items.find((s) => s.label === "name")!;
    expect(name.insertText).toBe("customers.name");
  });

  it("single table in scope → bare inserts", () => {
    const items = suggestionsAt("SELECT | FROM orders");
    const totalItem = items.find((s) => s.label === "total")!;
    expect(totalItem.insertText).toBe("total");
  });

  it("ON clause ranks PK/FK columns first", () => {
    const items = suggestionsAt("SELECT * FROM orders o JOIN customers c ON |");
    const idItem = items.find(
      (s) => s.label === "id" && s.insertText.startsWith("o."),
    )!;
    const totalItem = items.find((s) => s.insertText === "o.total")!;
    expect(idItem.sortText!.startsWith("0_")).toBe(true);
    expect(totalItem.sortText!.startsWith("1_")).toBe(true);
  });

  it("keywords appear exactly once (no case duplicates)", () => {
    const items = suggestionsAt("|");
    const selects = items.filter(
      (s) =>
        s.kind === monaco.languages.CompletionItemKind.Keyword &&
        String(s.label).toLowerCase() === "select",
    );
    expect(selects).toHaveLength(1);
    expect(selects[0].filterText).toBe("select");
  });

  it("unresolvable table in FROM → no other tables' columns leak in", () => {
    const items = suggestionsAt("SELECT * FROM not_a_real_table WHERE |");
    expect(
      items.some((s) => s.kind === monaco.languages.CompletionItemKind.Field),
    ).toBe(false);
    // keywords and tables still offered
    expect(labels(items)).toContain("AND");
    expect(labels(items)).toContain("orders");
  });

  it("no schema → keywords only, no crash", () => {
    const items = buildSqlSuggestions({
      monaco,
      ctx: getSqlCursorContext("SELECT ", 7),
      schema: undefined,
      dialect: "none",
      range,
    });
    expect(items.length).toBeGreaterThan(0);
    expect(
      items.every(
        (s) => s.kind === monaco.languages.CompletionItemKind.Keyword,
      ),
    ).toBe(true);
  });

  it("mssql dialect adds its extra keywords", () => {
    const items = buildSqlSuggestions({
      monaco,
      ctx: getSqlCursorContext("", 0),
      schema,
      dialect: "mssql",
      range,
    });
    expect(labels(items)).toContain("FETCH NEXT");
  });
});

describe("buildSqlSuggestions edge cases", () => {
  const build = (
    sqlWithCursor: string,
    s: SchemaEntry | undefined,
    dialect: "postgres" | "mssql" = "postgres",
  ) => {
    const offset = sqlWithCursor.indexOf("|");
    return buildSqlSuggestions({
      monaco,
      ctx: getSqlCursorContext(sqlWithCursor.replace("|", ""), offset),
      schema: s,
      dialect,
      range,
    });
  };

  it("keeps a function keyword's open paren without a trailing space", () => {
    const out: languages.CompletionItem[] = [];
    pushKeywordItems(monaco, out, ["COUNT(", "FROM"], range, "0_");
    expect(out.map((i) => i.insertText)).toEqual(["COUNT(", "FROM "]);
  });

  it("matches a differently-cased table name and describes FK / PHI columns", () => {
    const s: SchemaEntry = {
      tables: [{ schema: "", name: "Orders", type: "view" }],
      columns: {
        Orders: [
          col("customer_id", {
            isForeignKey: true,
            references: "customers.id",
          }),
          col("region_id", { isForeignKey: true }),
          col("email", { isPhiField: true }),
        ],
      },
    };
    const items = build("SELECT orders.|", s);
    expect(items.map((i) => i.detail)).toEqual([
      "Orders · text FK → customers.id",
      "Orders · text FK",
      "Orders · text 🔐 PHI",
    ]);
    const tables = build("SELECT * FROM |", s).filter(
      (i) => i.kind === monaco.languages.CompletionItemKind.Struct,
    );
    expect(tables[0].detail).toBe("view");
  });

  it("returns nothing for a qualifier when there is no schema", () => {
    expect(build("SELECT o.| FROM orders o", undefined)).toEqual([]);
  });

  it("returns nothing for a derived-table alias qualifier", () => {
    expect(build("SELECT sub.| FROM (SELECT 1) sub", schema)).toEqual([]);
  });

  it("returns nothing for a table listed without cached columns", () => {
    const s: SchemaEntry = { tables: [table("Ledger")], columns: {} };
    expect(build("SELECT ledger.|", s)).toEqual([]);
  });

  it("skips derived tables when scoping columns", () => {
    const items = build(
      "SELECT | FROM (SELECT 1) sub JOIN orders o ON 1=1",
      schema,
    );
    const fields = items.filter(
      (i) => i.kind === monaco.languages.CompletionItemKind.Field,
    );
    expect(labels(fields).sort()).toEqual(["customer_id", "id", "total"]);
    expect(fields[0].insertText).toBe(fields[0].label);
  });

  it("bracket-quotes awkward qualifiers on mssql", () => {
    const s: SchemaEntry = {
      tables: [table("Order Lines"), table("customers")],
      columns: { "Order Lines": [col("qty")], customers: [col("name")] },
    };
    const items = build(
      "SELECT | FROM [Order Lines] JOIN customers c ON 1=1",
      s,
      "mssql",
    );
    expect(items.find((i) => i.label === "qty")!.insertText).toBe(
      "[Order Lines].qty",
    );
  });

  it("offers keywords only for a table position without a schema", () => {
    const items = build("SELECT * FROM |", undefined);
    expect(items.length).toBeGreaterThan(0);
    expect(
      items.every(
        (i) => i.kind === monaco.languages.CompletionItemKind.Keyword,
      ),
    ).toBe(true);
  });

  it("offers keywords only when statement tables exist but no schema", () => {
    const items = build("SELECT * FROM orders WHERE |", undefined);
    expect(labels(items)).toContain("AND");
    expect(
      items.every(
        (i) => i.kind === monaco.languages.CompletionItemKind.Keyword,
      ),
    ).toBe(true);
  });

  it("caps unscoped columns and skips tables without columns", () => {
    const many = Array.from({ length: 600 }, (_, i) => col(`c${i}`));
    const s: SchemaEntry = {
      tables: [table("empty"), table("wide")],
      columns: { wide: many },
    };
    const fields = build("|", s).filter(
      (i) => i.kind === monaco.languages.CompletionItemKind.Field,
    );
    expect(fields).toHaveLength(500);
    expect(fields[0].detail).toBe("wide · text");
  });
});
