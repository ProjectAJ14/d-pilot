import { describe, it, expect } from "vitest";
import {
  renderCopyFormat,
  DEFAULT_COPY_FORMATS,
  type ExtractInput,
} from "./data-extractors";
import type { CopyFormat } from "../types";

const byId = (id: string): CopyFormat => {
  const f = DEFAULT_COPY_FORMATS.find((x) => x.id === id);
  if (!f) throw new Error(`no default format ${id}`);
  return f;
};

// Two-column sample modelled on the shared chat: a numeric code + a text
// description, including one description with a comma and quotes.
const twoCol: ExtractInput = {
  columns: ["test_code", "test_name"],
  rows: [
    { test_code: 1560, test_name: "Custom Proband Sequence Analysis" },
    { test_code: 2625, test_name: 'Collagen, Type I, "Alpha"' },
  ],
};

const codeOnly: ExtractInput = {
  columns: ["test_code"],
  rows: [{ test_code: 1560 }, { test_code: 1580 }, { test_code: 1593 }],
};

describe("builtin formats", () => {
  it("csv quotes only fields that need it and doubles inner quotes", () => {
    expect(renderCopyFormat(byId("csv"), twoCol)).toBe(
      [
        "test_code,test_name",
        "1560,Custom Proband Sequence Analysis",
        '2625,"Collagen, Type I, ""Alpha"""',
      ].join("\n"),
    );
  });

  it("json emits an array of projected objects with real types", () => {
    expect(JSON.parse(renderCopyFormat(byId("json"), codeOnly))).toEqual([
      { test_code: 1560 },
      { test_code: 1580 },
      { test_code: 1593 },
    ]);
  });

  it("sql-insert quotes strings, leaves numbers bare and uses the table name", () => {
    const sql = renderCopyFormat(byId("sql-insert"), {
      ...codeOnly,
      tableName: "tests",
    });
    expect(sql.split("\n")[0]).toBe(
      'INSERT INTO tests ("test_code") VALUES (1560);',
    );
  });

  it("sql-insert falls back to a placeholder table and NULLs nullish cells", () => {
    const sql = renderCopyFormat(byId("sql-insert"), {
      columns: ["a", "b"],
      rows: [{ a: null, b: "hi" }],
    });
    expect(sql).toBe(`INSERT INTO table_name ("a", "b") VALUES (NULL, 'hi');`);
  });
});

describe("default template formats reproduce the shared-chat formats", () => {
  it("comma joins every cell row-major, bare", () => {
    expect(renderCopyFormat(byId("comma"), codeOnly)).toBe("1560,1580,1593");
  });

  it("single-quoted wraps each cell and escapes inner single quotes", () => {
    expect(renderCopyFormat(byId("single-quoted"), codeOnly)).toBe(
      "'1560','1580','1593'",
    );
    expect(
      renderCopyFormat(byId("single-quoted"), {
        columns: ["x"],
        rows: [{ x: "O'Brien" }],
      }),
    ).toBe("'O''Brien'");
  });

  it("double-quoted wraps each cell in double quotes and escapes inner ones", () => {
    expect(renderCopyFormat(byId("double-quoted"), codeOnly)).toBe(
      '"1560","1580","1593"',
    );
    expect(
      renderCopyFormat(byId("double-quoted"), {
        columns: ["x"],
        rows: [{ x: 'say "hi"' }],
      }),
    ).toBe('"say \\"hi\\""');
  });
});

describe("custom (COPY_FORMATS-style) templates", () => {
  it("leaves the first column bare when quoteFirstColumn is false", () => {
    const custom: CopyFormat = {
      id: "x",
      label: "custom",
      template: {
        columnSeparator: " ",
        rowSeparator: ",",
        quote: "double",
        quoteFirstColumn: false,
      },
    };
    expect(renderCopyFormat(custom, twoCol)).toBe(
      '1560 "Custom Proband Sequence Analysis",2625 "Collagen, Type I, \\"Alpha\\""',
    );
  });

  it("honours a comma-columns / space-rows spec with a header", () => {
    const custom: CopyFormat = {
      id: "x",
      label: "custom",
      template: { columnSeparator: ",", rowSeparator: " ", header: true },
    };
    expect(renderCopyFormat(custom, twoCol)).toBe(
      'test_code,test_name 1560,Custom Proband Sequence Analysis 2625,Collagen, Type I, "Alpha"',
    );
  });

  it("applies prefix, suffix and nullText", () => {
    const custom: CopyFormat = {
      id: "x",
      label: "custom",
      template: {
        columnSeparator: ",",
        rowSeparator: ",",
        quote: "single",
        nullText: "NULL",
        prefix: "IN (",
        suffix: ")",
      },
    };
    expect(
      renderCopyFormat(custom, {
        columns: ["a"],
        rows: [{ a: 1 }, { a: null }],
      }),
    ).toBe("IN ('1','NULL')");
  });
});

describe("edge cases", () => {
  it("returns a string for every default format on an empty result set", () => {
    for (const f of DEFAULT_COPY_FORMATS) {
      expect(typeof renderCopyFormat(f, { columns: ["a"], rows: [] })).toBe(
        "string",
      );
    }
  });

  it("a format with neither builtin nor template renders empty", () => {
    expect(renderCopyFormat({ id: "x", label: "x" }, codeOnly)).toBe("");
  });

  it("serialises object cells as JSON text in delimited output", () => {
    expect(
      renderCopyFormat(byId("csv"), {
        columns: ["j"],
        rows: [{ j: { k: 1 } }],
      }),
    ).toBe(["j", '"{""k"":1}"'].join("\n"));
  });
});
