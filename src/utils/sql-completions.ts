/**
 * Builds Monaco completion items for the SQL query editor from a cursor
 * context (see `sql-context.ts`) and the connection's cached schema.
 *
 * The behavior is a decision table on the cursor context:
 *   - resolved `alias.` / `table.` qualifier → ONLY that table's columns
 *   - FROM / JOIN / UPDATE position          → tables first
 *   - column positions (SELECT/WHERE/...)    → columns of in-statement tables
 *   - no statement context                   → keywords + tables (+ capped columns)
 */
import type { languages } from "monaco-editor";
import type { ColumnInfo, TableInfo } from "../types";
import { isReservedIdent } from "./sql-context";
import type { SqlCursorContext, TableRef } from "./sql-context";

export interface SchemaEntry {
  tables: TableInfo[];
  columns: Record<string, ColumnInfo[]>;
}

export type SqlDialect = "postgres" | "mssql" | "none";

// Monaco namespace value (kinds enum); typed loosely because it arrives via
// the runtime instance, not the static import.
type MonacoNs = {
  languages: { CompletionItemKind: typeof languages.CompletionItemKind };
};
type Range = languages.CompletionItem["range"];

export const SQL_KEYWORDS = [
  "SELECT",
  "FROM",
  "WHERE",
  "AND",
  "OR",
  "NOT",
  "IN",
  "LIKE",
  "ILIKE",
  "BETWEEN",
  "JOIN",
  "LEFT JOIN",
  "RIGHT JOIN",
  "INNER JOIN",
  "OUTER JOIN",
  "CROSS JOIN",
  "ON",
  "AS",
  "ORDER BY",
  "GROUP BY",
  "HAVING",
  "LIMIT",
  "OFFSET",
  "COUNT",
  "SUM",
  "AVG",
  "MIN",
  "MAX",
  "DISTINCT",
  "CASE",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
  "IS NULL",
  "IS NOT NULL",
  "EXISTS",
  "UNION",
  "UNION ALL",
  "ASC",
  "DESC",
  "TOP",
  "WITH",
  "NULL",
  "TRUE",
  "FALSE",
];

export const MSSQL_EXTRA_KEYWORDS = [
  "FETCH NEXT",
  "ROWS ONLY",
  "ROW_NUMBER",
  "OVER",
  "PARTITION BY",
];

/** Keywords worth offering right after a table ref. */
const TABLE_FOLLOW_KEYWORDS = [
  "ON",
  "AS",
  "WHERE",
  "SET",
  "JOIN",
  "LEFT JOIN",
  "INNER JOIN",
  "ORDER BY",
  "GROUP BY",
];

/** Cap on column items when no statement context scopes them. */
const MAX_UNSCOPED_COLUMN_ITEMS = 500;

/**
 * One completion item per keyword. Monaco's fuzzy matcher is
 * case-insensitive against `filterText`, so a single item matches both
 * `sel` and `SEL` — no upper/lower duplicates needed.
 */
export function pushKeywordItems(
  monaco: MonacoNs,
  suggestions: languages.CompletionItem[],
  keywords: string[],
  range: Range,
  sortPrefix: string,
) {
  for (const kw of keywords) {
    suggestions.push({
      label: kw,
      kind: monaco.languages.CompletionItemKind.Keyword,
      insertText: kw.endsWith("(") ? kw : kw + " ",
      filterText: kw.toLowerCase(),
      range,
      sortText: sortPrefix + kw.toLowerCase(),
      detail: "keyword",
    });
  }
}

/** Case-insensitive lookup of a table's columns in the schema cache. */
function findTableColumns(
  schema: SchemaEntry,
  name: string,
): { name: string; cols: ColumnInfo[] } | undefined {
  if (schema.columns[name]) return { name, cols: schema.columns[name] };
  const lower = name.toLowerCase();
  const match = schema.tables.find((t) => t.name.toLowerCase() === lower);
  if (match && schema.columns[match.name]) {
    return { name: match.name, cols: schema.columns[match.name] };
  }
  return undefined;
}

function columnDetail(owner: string, col: ColumnInfo): string {
  const fk = col.references ? ` FK → ${col.references}` : col.isForeignKey ? " FK" : "";
  return `${owner} · ${col.dataType}${col.isPrimaryKey ? " PK" : ""}${fk}${
    col.isPhiField ? " 🔐 PHI" : ""
  }`;
}

function pushColumnItem(
  monaco: MonacoNs,
  suggestions: languages.CompletionItem[],
  col: ColumnInfo,
  owner: string,
  insertText: string,
  range: Range,
  sortPrefix: string,
) {
  suggestions.push({
    label: col.name,
    kind: monaco.languages.CompletionItemKind.Field,
    insertText,
    filterText: col.name,
    detail: columnDetail(owner, col),
    range,
    sortText: sortPrefix + col.name.toLowerCase(),
  });
}

function pushTableItems(
  monaco: MonacoNs,
  suggestions: languages.CompletionItem[],
  schema: SchemaEntry,
  range: Range,
  sortPrefix: string,
) {
  for (const table of schema.tables) {
    suggestions.push({
      label: table.name,
      kind: monaco.languages.CompletionItemKind.Struct,
      insertText: table.name,
      filterText: table.name,
      detail: `${table.type}${table.schema ? " · " + table.schema : ""}`,
      range,
      sortText: sortPrefix + table.name.toLowerCase(),
    });
  }
}

/** In-statement table refs resolved against the schema cache. */
function resolveScopedTables(
  schema: SchemaEntry,
  refs: TableRef[],
): { ref: TableRef; tableName: string; cols: ColumnInfo[] }[] {
  const scoped: { ref: TableRef; tableName: string; cols: ColumnInfo[] }[] = [];
  for (const ref of refs) {
    if (!ref.table) continue; // derived-table alias: no columns to offer
    const found = findTableColumns(schema, ref.table);
    if (found) scoped.push({ ref, tableName: found.name, cols: found.cols });
  }
  return scoped;
}

export function buildSqlSuggestions(opts: {
  monaco: MonacoNs;
  ctx: SqlCursorContext;
  schema: SchemaEntry | undefined;
  dialect: SqlDialect;
  range: Range;
}): languages.CompletionItem[] {
  const { monaco, ctx, schema, dialect, range } = opts;
  const suggestions: languages.CompletionItem[] = [];
  const keywords =
    dialect === "mssql" ? [...SQL_KEYWORDS, ...MSSQL_EXTRA_KEYWORDS] : SQL_KEYWORDS;

  // --- Dot-qualified: `alias.` / `table.` → only that table's columns ---
  if (ctx.qualifier) {
    if (!schema) return suggestions;
    // Alias/table from the statement, falling back to a direct schema-table
    // match so `orders.` works even before FROM is written.
    const targetTable = ctx.qualifier.ref
      ? ctx.qualifier.ref.table
      : ctx.qualifier.raw;
    if (!targetTable) return suggestions; // derived-table alias
    const found = findTableColumns(schema, targetTable);
    if (!found) return suggestions;
    for (const col of found.cols) {
      pushColumnItem(monaco, suggestions, col, found.name, col.name, range, "0_");
    }
    return suggestions;
  }

  const scoped = schema ? resolveScopedTables(schema, ctx.tables) : [];
  const qualifyInserts = scoped.length >= 2;
  // Quote qualifiers that would otherwise be misparsed: reserved words
  // (a table literally named "order") or names needing quoting anyway.
  const quoteIdent = (name: string) => {
    if (/^[a-z_][a-z0-9_$]*$/.test(name) && !isReservedIdent(name)) return name;
    return dialect === "mssql" ? `[${name}]` : `"${name}"`;
  };
  const ownerOf = (s: { ref: TableRef; tableName: string }) =>
    s.ref.alias || s.tableName;
  const insertFor = (s: { ref: TableRef; tableName: string }, col: ColumnInfo) =>
    qualifyInserts ? `${quoteIdent(ownerOf(s))}.${col.name}` : col.name;

  switch (ctx.clause) {
    // --- Table position: FROM / JOIN / UPDATE ---
    case "from":
    case "join":
    case "update": {
      if (schema) pushTableItems(monaco, suggestions, schema, range, "0_");
      pushKeywordItems(monaco, suggestions, TABLE_FOLLOW_KEYWORDS, range, "2_");
      return suggestions;
    }

    // --- Join condition: columns of joined tables, PK/FK first ---
    case "on": {
      for (const s of scoped) {
        for (const col of s.cols) {
          const tier = col.isPrimaryKey || col.isForeignKey ? "0_" : "1_";
          pushColumnItem(
            monaco,
            suggestions,
            col,
            ownerOf(s),
            insertFor(s, col),
            range,
            tier,
          );
        }
      }
      pushKeywordItems(monaco, suggestions, keywords, range, "2_");
      return suggestions;
    }

    // --- Column positions scoped to the statement's tables ---
    case "select":
    case "where":
    case "group_by":
    case "having":
    case "order_by":
    case "set":
    case "insert_columns": {
      if (scoped.length > 0) {
        for (const s of scoped) {
          for (const col of s.cols) {
            pushColumnItem(
              monaco,
              suggestions,
              col,
              ownerOf(s),
              insertFor(s, col),
              range,
              "0_",
            );
          }
        }
        pushKeywordItems(monaco, suggestions, keywords, range, "1_");
        if (schema) pushTableItems(monaco, suggestions, schema, range, "2_");
        return suggestions;
      }
      if (ctx.tables.length > 0) {
        // The statement references tables we can't resolve (schema still
        // loading, or names not in this schema). Offering other tables'
        // columns here would be noise that reads as wrong suggestions —
        // keywords + tables only.
        pushKeywordItems(monaco, suggestions, keywords, range, "0_");
        if (schema) pushTableItems(monaco, suggestions, schema, range, "1_");
        return suggestions;
      }
      break; // no tables in the statement yet → generic fallback below
    }

    default:
      break;
  }

  // --- No statement context: keywords, tables, then a capped column list ---
  pushKeywordItems(monaco, suggestions, keywords, range, "0_");
  if (schema) {
    pushTableItems(monaco, suggestions, schema, range, "1_");
    let emitted = 0;
    for (const table of schema.tables) {
      const cols = schema.columns[table.name];
      if (!cols) continue;
      for (const col of cols) {
        if (emitted >= MAX_UNSCOPED_COLUMN_ITEMS) return suggestions;
        pushColumnItem(monaco, suggestions, col, table.name, col.name, range, "2_");
        emitted++;
      }
    }
  }
  return suggestions;
}
