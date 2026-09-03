/**
 * Data extractors — render query-result rows/columns into formatted text for the
 * clipboard, DataGrip-style. Pure and UI-agnostic (mirrors `schema-metadata.ts`):
 * every function takes plain `{ columns, rows }` and returns a string.
 *
 * The set of formats offered in the UI is **deployment-configurable** via the
 * `COPY_FORMATS` env var (a JSON array of `CopyFormat`), served through
 * `/api/config`. A format either references a `builtin` structural formatter
 * (CSV/TSV/JSON/Markdown/SQL INSERT) or carries a separator `template` (the
 * DataGrip-style custom extractors). `DEFAULT_COPY_FORMATS` below is the fallback
 * when nothing is configured — keep it in sync with the server copy in
 * `server/config/copy-formats.ts`.
 *
 * PHI note: these run over `QueryResult.rows`, which the server has already
 * masked. A masked column yields its token, never the underlying value — copying
 * introduces no new leak path.
 */
import type { CopyBuiltin, CopyFormat, CopyTemplate } from "../types";

/** One row keyed by column name, as delivered in `QueryResult.rows`. */
export type ExtractRow = Record<string, unknown>;

export interface ExtractInput {
  /** Column names to emit, in output order. */
  columns: string[];
  rows: ExtractRow[];
  /** Table name for the `sql-insert` builtin; falls back to a placeholder. */
  tableName?: string;
}

/**
 * Fallback catalogue used when `COPY_FORMATS` is unset (or the server is older
 * than this client). Order here is the order the menu renders. Keep in sync with
 * `DEFAULT_COPY_FORMATS` in `server/config/copy-formats.ts`.
 */
export const DEFAULT_COPY_FORMATS: CopyFormat[] = [
  {
    id: "csv",
    label: "CSV",
    group: "Tabular",
    example: "id,code",
    builtin: "csv",
    columnMenu: true,
  },
  {
    id: "tsv",
    label: "TSV",
    group: "Tabular",
    example: "id\\tcode",
    builtin: "tsv",
  },
  {
    id: "json",
    label: "JSON",
    group: "Tabular",
    example: '[{ "id": 18 }]',
    builtin: "json",
    columnMenu: true,
  },
  {
    id: "markdown",
    label: "Markdown table",
    group: "Tabular",
    example: "| id | code |",
    builtin: "markdown",
  },
  {
    id: "sql-insert",
    label: "SQL INSERT",
    group: "Tabular",
    example: "INSERT INTO … VALUES (…);",
    builtin: "sql-insert",
  },
  {
    id: "comma",
    label: "Comma-separated",
    group: "List / SQL",
    example: "1560,1580,1593",
    columnMenu: true,
    template: { columnSeparator: ",", rowSeparator: ",", quote: "none" },
  },
  {
    id: "single-quoted",
    label: "Single-quoted (SQL IN)",
    group: "List / SQL",
    example: "'1560','1580'",
    columnMenu: true,
    template: { columnSeparator: ",", rowSeparator: ",", quote: "single" },
  },
  {
    id: "double-quoted",
    label: "Double-quoted",
    group: "List / SQL",
    example: '"1560","1580"',
    columnMenu: true,
    template: { columnSeparator: ",", rowSeparator: ",", quote: "double" },
  },
];

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

/** Plain-text rendering of a cell: null/undefined → `nullText`, objects → JSON. */
function toText(value: unknown, nullText = ""): string {
  if (value === null || value === undefined) return nullText;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** True for values that should render bare (unquoted) in SQL — numbers/bools. */
function isBareSqlValue(value: unknown): boolean {
  return typeof value === "number" || typeof value === "boolean";
}

/** CSV/DSV field: quote when it contains the delimiter, a quote or a newline. */
function csvField(value: unknown, delimiter: string): string {
  const text = toText(value);
  if (text === "") return "";
  const needsQuote =
    text.includes(delimiter) ||
    text.includes('"') ||
    text.includes("\n") ||
    text.includes("\r");
  return needsQuote ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Wrap in single quotes, escaping embedded single quotes SQL-style (`''`). */
function singleQuoted(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

/** Wrap in double quotes, escaping embedded double quotes. */
function doubleQuoted(text: string): string {
  return `"${text.replace(/"/g, '\\"')}"`;
}

/** A SQL literal: numbers/booleans bare, null → NULL, everything else quoted. */
function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (isBareSqlValue(value)) return String(value);
  return singleQuoted(toText(value));
}

// ---------------------------------------------------------------------------
// Builtin (structural) formatters
// ---------------------------------------------------------------------------

function toDelimited(input: ExtractInput, delimiter: string): string {
  const { columns, rows } = input;
  const header = columns.map((c) => csvField(c, delimiter)).join(delimiter);
  const body = rows.map((row) =>
    columns.map((c) => csvField(row[c], delimiter)).join(delimiter),
  );
  return [header, ...body].join("\n");
}

function toJson(input: ExtractInput): string {
  const { columns, rows } = input;
  const projected = rows.map((row) => {
    const obj: Record<string, unknown> = {};
    for (const c of columns) obj[c] = row[c] ?? null;
    return obj;
  });
  return JSON.stringify(projected, null, 2);
}

function toMarkdown(input: ExtractInput): string {
  const { columns, rows } = input;
  // Pipes and newlines would break the table grid — neutralise them.
  const cell = (v: unknown) =>
    toText(v).replace(/\|/g, "\\|").replace(/\n/g, " ");
  const header = `| ${columns.map(cell).join(" | ")} |`;
  const divider = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map(
    (row) => `| ${columns.map((c) => cell(row[c])).join(" | ")} |`,
  );
  return [header, divider, ...body].join("\n");
}

function toSqlInsert(input: ExtractInput): string {
  const { columns, rows } = input;
  const table = input.tableName?.trim() || "table_name";
  const colList = columns.map((c) => `"${c}"`).join(", ");
  return rows
    .map((row) => {
      const values = columns.map((c) => sqlLiteral(row[c])).join(", ");
      return `INSERT INTO ${table} (${colList}) VALUES (${values});`;
    })
    .join("\n");
}

function renderBuiltin(builtin: CopyBuiltin, input: ExtractInput): string {
  switch (builtin) {
    case "csv":
      return toDelimited(input, ",");
    case "tsv":
      return toDelimited(input, "\t");
    case "json":
      return toJson(input);
    case "markdown":
      return toMarkdown(input);
    case "sql-insert":
      return toSqlInsert(input);
    default: {
      const _never: never = builtin;
      return _never;
    }
  }
}

// ---------------------------------------------------------------------------
// Template (separator-based) formatter
// ---------------------------------------------------------------------------

function quoteCell(text: string, quote: CopyTemplate["quote"]): string {
  switch (quote) {
    case "single":
      return singleQuoted(text);
    case "double":
      return doubleQuoted(text);
    default:
      return text;
  }
}

function renderTemplate(spec: CopyTemplate, input: ExtractInput): string {
  const { columns, rows } = input;
  const nullText = spec.nullText ?? "";

  const renderRow = (row: ExtractRow) =>
    columns
      .map((c, i) => {
        // A `code "description"` style format leaves the first column bare.
        const quote =
          i === 0 && spec.quoteFirstColumn === false ? "none" : spec.quote;
        return quoteCell(toText(row[c], nullText), quote);
      })
      .join(spec.columnSeparator);

  const lines = rows.map(renderRow);
  if (spec.header) lines.unshift(columns.join(spec.columnSeparator));

  return `${spec.prefix ?? ""}${lines.join(spec.rowSeparator)}${spec.suffix ?? ""}`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Render `input` using the given copy `format`. Dispatches to the builtin
 * structural formatter or the separator template, whichever the format carries.
 */
export function renderCopyFormat(
  format: CopyFormat,
  input: ExtractInput,
): string {
  if (format.builtin) return renderBuiltin(format.builtin, input);
  if (format.template) return renderTemplate(format.template, input);
  return "";
}
