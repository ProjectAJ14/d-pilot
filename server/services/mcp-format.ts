/**
 * How the MCP endpoint writes query results for an agent.
 *
 * An agent pays for every character a tool returns, and keeps paying while the
 * result sits in its context. Pretty-printed JSON repeats every column name on
 * every row and indents it; measured on real audited queries that is about
 * twice the tokens of CSV for the same rows. One wide `SELECT *` over payload
 * columns (JSON documents, stack traces) can cost more than a whole session of
 * ordinary queries, so long cells are cut too, with a marker saying how much.
 *
 * Only the MCP output changes. The UI, exports and the audit log never see this.
 */

/** Longest cell an agent gets by default; `maxCellChars` raises it per call. */
export const DEFAULT_MAX_CELL_CHARS = 300;

/**
 * Most text one result may hand an agent (~25k tokens). Beyond it the rows are
 * cut with a note: past this size a client truncates the result anyway, and
 * what survives is an arbitrary prefix rather than whole rows plus advice.
 */
export const RESULT_BUDGET_CHARS = 100_000;

export interface FormatOptions {
  format?: "csv" | "json";
  maxCellChars?: number;
  budgetChars?: number;
}

export interface FormattedRows {
  text: string;
  /** Rows actually written; fewer than given when the budget ran out. */
  rowsShown: number;
  /** Cells shortened by the cap. */
  cappedCells: number;
}

type Row = Record<string, unknown>;

/** Column names in result order, plus any key a later document adds (Mongo). */
export function columnNames(
  rows: Row[],
  columns?: (string | { name: string })[],
): string[] {
  const names = (columns ?? []).map((c) =>
    typeof c === "string" ? c : c.name,
  );
  const seen = new Set(names);
  for (const row of rows)
    for (const key of Object.keys(row))
      if (!seen.has(key)) {
        seen.add(key);
        names.push(key);
      }
  return names;
}

/** A value as text, or null for SQL NULL / a missing document field. */
function cellText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function cap(text: string, max: number): { text: string; capped: boolean } {
  if (text.length <= max) return { text, capped: false };
  return {
    text: `${text.slice(0, max)}…[+${text.length - max} chars]`,
    capped: true,
  };
}

/**
 * RFC 4180: quote a field holding a comma, quote or line break, doubling inner
 * quotes. NULL is an empty field and an empty string is `""`, so the two stay
 * distinguishable.
 */
function csvField(text: string | null): string {
  if (text === null) return "";
  if (text === "" || /[",\r\n]/.test(text))
    return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function formatRows(
  rows: Row[],
  columns: (string | { name: string })[] | undefined,
  {
    format = "csv",
    maxCellChars = DEFAULT_MAX_CELL_CHARS,
    budgetChars = RESULT_BUDGET_CHARS,
  }: FormatOptions = {},
): FormattedRows {
  const names = columnNames(rows, columns);

  // Each cell as text (null for NULL), shortened to the cap.
  const cells = (row: Row) => {
    let capped = 0;
    const values = names.map((name) => {
      const text = cellText(row[name]);
      if (text === null) return { text, capped: false };
      const out = cap(text, maxCellChars);
      if (out.capped) capped++;
      return out;
    });
    return { values, capped };
  };

  // Rows are kept whole until the budget runs out; the first always fits, so a
  // single huge row still comes back (its cells are capped anyway).
  const lines: string[] = [];
  let used = 0;
  let rowsShown = 0;
  let cappedCells = 0;
  const take = (line: string, capped: number): boolean => {
    if (rowsShown && used + line.length + 1 > budgetChars) return false;
    lines.push(line);
    used += line.length + 1;
    rowsShown++;
    cappedCells += capped;
    return true;
  };

  if (format === "json") {
    for (const row of rows) {
      const { values, capped } = cells(row);
      // A capped value is the shortened text; everything else keeps its type.
      const out: Row = {};
      names.forEach((name, i) => {
        if (name in row)
          out[name] = values[i].capped ? values[i].text : row[name];
      });
      if (!take(JSON.stringify(out), capped)) break;
    }
    return { text: `[${lines.join(",\n")}]`, rowsShown, cappedCells };
  }

  const header = names.map(csvField).join(",");
  used = header.length + 1;
  for (const row of rows) {
    const { values, capped } = cells(row);
    if (!take(values.map((v) => csvField(v.text)).join(","), capped)) break;
  }
  return { text: [header, ...lines].join("\n"), rowsShown, cappedCells };
}
