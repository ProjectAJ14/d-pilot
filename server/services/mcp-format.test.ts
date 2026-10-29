import { describe, it, expect } from "vitest";
import { columnNames, formatRows, tableList } from "./mcp-format.js";

describe("formatRows (csv)", () => {
  it("writes a header and one line per row, in column order", () => {
    const { text, rowsShown } = formatRows(
      [
        { id: 1, status: "shipped" },
        { id: 2, status: "draft" },
      ],
      [{ name: "id" }, { name: "status" }],
    );
    expect(text).toBe("id,status\n1,shipped\n2,draft");
    expect(rowsShown).toBe(2);
  });

  it("keeps NULL and the empty string apart", () => {
    const { text } = formatRows(
      [{ a: null, b: "", c: undefined }],
      ["a", "b", "c"],
    );
    expect(text).toBe('a,b,c\n,"",');
  });

  it("quotes commas, quotes and line breaks (RFC 4180)", () => {
    const { text } = formatRows([{ v: 'say "hi", then\nleave' }], ["v"]);
    expect(text).toBe('v\n"say ""hi"", then\nleave"');
  });

  it("writes nested values as compact JSON", () => {
    const { text } = formatRows(
      [{ doc: { a: [1, 2] }, ok: true }],
      ["doc", "ok"],
    );
    expect(text).toBe('doc,ok\n"{""a"":[1,2]}",true');
  });

  it("is far smaller than the pretty JSON it replaces", () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({
      id: i,
      status: "shipped",
      customer_id: 1000 + i,
    }));
    const pretty = JSON.stringify(rows, null, 2).length;
    expect(formatRows(rows, undefined).text.length).toBeLessThan(pretty / 3);
  });
});

describe("cell cap", () => {
  it("cuts long cells and says how much is missing", () => {
    const { text, cappedCells } = formatRows(
      [{ payload: "x".repeat(1000), id: 7 }],
      undefined,
      { maxCellChars: 10 },
    );
    expect(text).toBe("payload,id\nxxxxxxxxxx…[+990 chars],7");
    expect(cappedCells).toBe(1);
  });

  it("caps a nested document by its JSON length", () => {
    const doc = { items: Array.from({ length: 100 }, (_, i) => i) };
    const { text, cappedCells } = formatRows([{ doc }], undefined, {
      maxCellChars: 20,
    });
    const full = JSON.stringify(doc);
    expect(cappedCells).toBe(1);
    expect(text).toContain(`…[+${full.length - 20} chars]`);
  });

  it("leaves short cells alone", () => {
    expect(formatRows([{ a: "short" }], undefined).cappedCells).toBe(0);
  });
});

describe("result budget", () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({
    id: i,
    pad: "y".repeat(90),
  }));

  it("keeps whole rows until the budget runs out", () => {
    const { text, rowsShown } = formatRows(rows, undefined, {
      budgetChars: 1000,
    });
    expect(rowsShown).toBeGreaterThan(0);
    expect(rowsShown).toBeLessThan(100);
    expect(text.split("\n")).toHaveLength(rowsShown + 1);
    expect(text.length).toBeLessThanOrEqual(1000);
  });

  it("always returns at least one row", () => {
    expect(formatRows(rows, undefined, { budgetChars: 1 }).rowsShown).toBe(1);
  });

  it("does not count caps in rows it dropped", () => {
    const wide = Array.from({ length: 50 }, () => ({ p: "z".repeat(500) }));
    const { rowsShown, cappedCells } = formatRows(wide, undefined, {
      maxCellChars: 100,
      budgetChars: 500,
    });
    expect(cappedCells).toBe(rowsShown);
  });
});

describe("formatRows (json)", () => {
  it("writes one compact object per row, types intact", () => {
    const { text } = formatRows(
      [{ id: 1, ok: true, doc: { a: 1 }, n: null }],
      undefined,
      {
        format: "json",
      },
    );
    expect(JSON.parse(text)).toEqual([
      { id: 1, ok: true, doc: { a: 1 }, n: null },
    ]);
    expect(text).not.toContain("\n  ");
  });

  it("turns a capped value into its shortened text", () => {
    const { text } = formatRows([{ id: 1, body: "b".repeat(50) }], undefined, {
      format: "json",
      maxCellChars: 5,
    });
    expect(JSON.parse(text)).toEqual([{ id: 1, body: "bbbbb…[+45 chars]" }]);
  });
});

describe("columnNames", () => {
  it("adds fields that only later documents carry", () => {
    expect(columnNames([{ a: 1 }, { a: 2, b: 3 }], ["a"])).toEqual(["a", "b"]);
  });
});

describe("tableList", () => {
  it("names each schema once and marks views", () => {
    expect(
      tableList([
        { schema: "app_core", name: "orders", type: "TABLE" },
        { schema: "app_core", name: "order_totals", type: "VIEW" },
        { schema: "audit", name: "events", type: "TABLE" },
      ]),
    ).toBe("app_core (2): orders, order_totals (view)\naudit (1): events");
  });

  it("lists bare names when there is no schema (collections, indices)", () => {
    expect(tableList([{ name: "orders" }, { name: "customers" }])).toBe(
      "orders, customers",
    );
  });
});
