/**
 * Lightweight SQL cursor-context engine powering the query editor's
 * schema-aware autocomplete. Pure module — no Monaco or React imports —
 * so it stays unit-testable in isolation.
 *
 * Given the full editor text and a cursor offset it answers three questions:
 *   1. Which tables (with aliases) does the current statement reference?
 *   2. Which clause is the cursor in (SELECT list, FROM, WHERE, ON, ...)?
 *   3. Is the cursor completing a dot-qualified name (`alias.` / `table.`)?
 *
 * It is a tolerant tokenizer + two scans, not a SQL parser: mid-keystroke
 * text is almost never valid SQL, so grammars with no error recovery are
 * useless here. Explicitly punted (safe fallbacks, never crashes):
 *   - CTE names as table sources (`WITH x AS (...) SELECT ... FROM x`)
 *   - subquery scoping (all statement aliases are visible everywhere)
 *   - MSSQL `db..table` double-dot shorthand
 *   - `USING` / `LATERAL` join forms
 */

export type SqlClause =
  | "select"
  | "from"
  | "join"
  | "on"
  | "where"
  | "group_by"
  | "having"
  | "order_by"
  | "set"
  | "insert_columns"
  | "update"
  | "start"
  | "unknown";

export interface TableRef {
  /** Unquoted table name, case preserved as written. */
  table: string;
  /** Present when written schema-qualified (`public.orders`). */
  schema?: string;
  /** AS alias or bare alias, unquoted. */
  alias?: string;
}

export interface SqlCursorContext {
  clause: SqlClause;
  /** All table refs in the statement containing the cursor. */
  tables: TableRef[];
  /** Identifier immediately before a `.` at the cursor, when present. */
  qualifier?: { raw: string; ref?: TableRef };
  /** The partial identifier being typed at the cursor. */
  wordPrefix: string;
}

export interface SqlToken {
  type: "word" | "quoted" | "string" | "number" | "punct";
  /** Raw source text including quotes. */
  text: string;
  /** Identifier value without quotes (words/quoted idents only). */
  unquoted: string;
  start: number;
  end: number;
}

/** Keywords that terminate an alias — a bare word after a table ref is only
 *  an alias if it is not one of these. */
const RESERVED = new Set([
  "SELECT",
  "FROM",
  "WHERE",
  "JOIN",
  "INNER",
  "LEFT",
  "RIGHT",
  "FULL",
  "OUTER",
  "CROSS",
  "ON",
  "AND",
  "OR",
  "NOT",
  "AS",
  "GROUP",
  "ORDER",
  "BY",
  "HAVING",
  "LIMIT",
  "OFFSET",
  "UNION",
  "EXCEPT",
  "INTERSECT",
  "SET",
  "VALUES",
  "INSERT",
  "UPDATE",
  "DELETE",
  "INTO",
  "RETURNING",
  "FETCH",
  "TOP",
  "WITH",
  "USING",
  "CASE",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
  "EXISTS",
  "BETWEEN",
  "LIKE",
  "ILIKE",
  "IN",
  "IS",
  "NULL",
  "ASC",
  "DESC",
  "DISTINCT",
]);

const TABLE_KEYWORDS = new Set(["FROM", "JOIN", "UPDATE", "INTO"]);

/**
 * Slice out the statement containing `offset`. Statements are separated by
 * top-level `;` OR by a blank line at paren depth 0 — people stack queries
 * in a scratchpad editor without semicolons, and treating them as one
 * statement bleeds one query's tables into another's suggestions.
 * Separators inside strings, quoted identifiers, and comments don't split.
 * Returns the statement text and the cursor offset relative to it.
 */
export function extractCurrentStatement(
  fullText: string,
  offset: number,
): { text: string; offset: number } {
  const n = fullText.length;
  let segStart = 0;
  let parenDepth = 0;
  let i = 0;
  while (i < n) {
    const ch = fullText[i];
    if (ch === "'") {
      i++;
      while (i < n) {
        if (fullText[i] === "'") {
          if (fullText[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < n && fullText[i] !== '"') i++;
      i++;
      continue;
    }
    if (ch === "[") {
      i++;
      while (i < n && fullText[i] !== "]") i++;
      i++;
      continue;
    }
    if (ch === "-" && fullText[i + 1] === "-") {
      const nl = fullText.indexOf("\n", i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    if (ch === "/" && fullText[i + 1] === "*") {
      const close = fullText.indexOf("*/", i + 2);
      i = close === -1 ? n : close + 2;
      continue;
    }
    if (ch === "(") parenDepth++;
    else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
    else if (ch === ";") {
      if (offset <= i) {
        return { text: fullText.slice(segStart, i), offset: offset - segStart };
      }
      segStart = i + 1;
    } else if (ch === "\n" && parenDepth === 0) {
      // A newline followed by a blank line separates statements. Only the
      // first newline is consumed; the blank line becomes leading
      // whitespace of the next segment (harmless — the tokenizer skips it).
      let j = i + 1;
      while (j < n && (fullText[j] === " " || fullText[j] === "\t" || fullText[j] === "\r")) {
        j++;
      }
      if (j < n && fullText[j] === "\n") {
        if (offset <= i) {
          return {
            text: fullText.slice(segStart, i),
            offset: offset - segStart,
          };
        }
        segStart = i + 1;
      }
    }
    i++;
  }
  return {
    text: fullText.slice(segStart),
    offset: Math.max(0, offset - segStart),
  };
}

/** Tolerant SQL tokenizer. Comments are skipped; strings kept as one token. */
export function tokenize(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const ch = sql[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      const close = sql.indexOf("*/", i + 2);
      i = close === -1 ? n : close + 2;
      continue;
    }
    if (ch === "'") {
      const start = i;
      i++;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      tokens.push({ type: "string", text: sql.slice(start, i), unquoted: "", start, end: i });
      continue;
    }
    if (ch === '"') {
      const start = i;
      i++;
      let val = "";
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            val += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        val += sql[i];
        i++;
      }
      tokens.push({ type: "quoted", text: sql.slice(start, i), unquoted: val, start, end: i });
      continue;
    }
    if (ch === "[") {
      const start = i;
      i++;
      let val = "";
      while (i < n) {
        if (sql[i] === "]") {
          if (sql[i + 1] === "]") {
            val += "]";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        val += sql[i];
        i++;
      }
      tokens.push({ type: "quoted", text: sql.slice(start, i), unquoted: val, start, end: i });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      while (i < n && /[\w$]/.test(sql[i])) i++;
      const text = sql.slice(start, i);
      tokens.push({ type: "word", text, unquoted: text, start, end: i });
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const start = i;
      while (i < n && /[\w.]/.test(sql[i])) i++;
      tokens.push({ type: "number", text: sql.slice(start, i), unquoted: "", start, end: i });
      continue;
    }
    tokens.push({ type: "punct", text: ch, unquoted: ch, start: i, end: i + 1 });
    i++;
  }
  return tokens;
}

function isIdent(t: SqlToken | undefined): t is SqlToken {
  return !!t && (t.type === "word" || t.type === "quoted");
}

function isReservedWord(t: SqlToken): boolean {
  return t.type === "word" && RESERVED.has(t.text.toUpperCase());
}

/** Collect every table reference after FROM / JOIN / UPDATE / INTO. */
export function extractTableRefs(tokens: SqlToken[]): TableRef[] {
  const refs: TableRef[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "word") continue;
    const kw = t.text.toUpperCase();
    if (!TABLE_KEYWORDS.has(kw)) continue;
    i = parseRefList(tokens, i + 1, refs, kw === "FROM") - 1;
  }
  return refs;
}

function parseRefList(
  tokens: SqlToken[],
  i: number,
  refs: TableRef[],
  allowComma: boolean,
): number {
  for (;;) {
    i = parseOneRef(tokens, i, refs);
    if (allowComma && tokens[i]?.type === "punct" && tokens[i].text === ",") {
      i++;
      continue;
    }
    return i;
  }
}

function parseOneRef(tokens: SqlToken[], i: number, refs: TableRef[]): number {
  const t = tokens[i];
  if (!t) return i;

  // Derived table `FROM (SELECT ...) alias` — skip the balanced parens; the
  // alias is kept (with an empty table) so it never resolves to columns.
  if (t.type === "punct" && t.text === "(") {
    let depth = 1;
    i++;
    while (i < tokens.length && depth > 0) {
      if (tokens[i].type === "punct") {
        if (tokens[i].text === "(") depth++;
        else if (tokens[i].text === ")") depth--;
      }
      i++;
    }
    if (tokens[i]?.type === "word" && tokens[i].text.toUpperCase() === "AS") i++;
    if (isIdent(tokens[i]) && !isReservedWord(tokens[i])) {
      refs.push({ table: "", alias: tokens[i].unquoted });
      i++;
    }
    return i;
  }

  if (!isIdent(t) || isReservedWord(t)) return i;

  let schema: string | undefined;
  let table = t.unquoted;
  i++;
  while (
    tokens[i]?.type === "punct" &&
    tokens[i].text === "." &&
    isIdent(tokens[i + 1])
  ) {
    schema = table;
    table = tokens[i + 1].unquoted;
    i += 2;
  }

  let alias: string | undefined;
  if (tokens[i]?.type === "word" && tokens[i].text.toUpperCase() === "AS") {
    i++;
    if (isIdent(tokens[i])) {
      alias = tokens[i].unquoted;
      i++;
    }
  } else if (isIdent(tokens[i]) && !isReservedWord(tokens[i])) {
    alias = tokens[i].unquoted;
    i++;
  }

  refs.push({ table, schema, alias });
  return i;
}

const CLAUSE_KEYWORDS: Record<string, SqlClause> = {
  SELECT: "select",
  FROM: "from",
  JOIN: "join",
  ON: "on",
  WHERE: "where",
  HAVING: "having",
  SET: "set",
  UPDATE: "update",
};

/**
 * The clause the cursor sits in: the last clause keyword seen before the
 * cursor *at the cursor's paren depth* (a `(` pushes the current clause, a
 * `)` pops it, so subquery clauses don't leak into the outer statement).
 */
export function clauseAt(tokens: SqlToken[], offset: number): SqlClause {
  const stack: SqlClause[] = ["start"];
  let afterInsertInto = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.end > offset) break;
    if (t.type === "punct") {
      if (t.text === "(") {
        stack.push(afterInsertInto ? "insert_columns" : stack[stack.length - 1]);
        afterInsertInto = false;
      } else if (t.text === ")") {
        if (stack.length > 1) stack.pop();
      }
      continue;
    }
    if (t.type !== "word") continue;
    const up = t.text.toUpperCase();
    if (up === "INTO") {
      // Table position (INSERT INTO / SELECT INTO); a following `(` opens
      // the insert column list.
      afterInsertInto = true;
      stack[stack.length - 1] = "from";
      continue;
    }
    if (up === "VALUES") {
      afterInsertInto = false;
      stack[stack.length - 1] = "unknown";
      continue;
    }
    if (up === "GROUP" || up === "ORDER") {
      const next = tokens[i + 1];
      if (next?.type === "word" && next.text.toUpperCase() === "BY" && next.end <= offset) {
        stack[stack.length - 1] = up === "GROUP" ? "group_by" : "order_by";
        afterInsertInto = false;
        i++;
      }
      continue;
    }
    const mapped = CLAUSE_KEYWORDS[up];
    if (mapped) {
      stack[stack.length - 1] = mapped;
      afterInsertInto = false;
    }
  }
  return stack[stack.length - 1];
}

function unquoteIdent(raw: string): string {
  if (raw.startsWith('"')) return raw.slice(1, -1).replace(/""/g, '"');
  if (raw.startsWith("[")) return raw.slice(1, -1).replace(/]]/g, "]");
  return raw;
}

/** True when a bare identifier would collide with a SQL keyword. */
export function isReservedIdent(name: string): boolean {
  return RESERVED.has(name.toUpperCase());
}

/** Resolve an identifier against statement refs: alias first, then table name. */
export function resolveTableRef(
  name: string,
  tables: TableRef[],
): TableRef | undefined {
  const lower = name.toLowerCase();
  return (
    tables.find((r) => r.alias?.toLowerCase() === lower) ??
    tables.find((r) => r.table.toLowerCase() === lower)
  );
}

/** Main entry: context at `offset` within the full editor text. */
export function getSqlCursorContext(
  fullText: string,
  offset: number,
): SqlCursorContext {
  const stmt = extractCurrentStatement(fullText, offset);
  const tokens = tokenize(stmt.text);
  const tables = extractTableRefs(tokens);
  const clause = clauseAt(tokens, stmt.offset);

  let wordStart = stmt.offset;
  while (wordStart > 0 && /[\w$]/.test(stmt.text[wordStart - 1])) wordStart--;
  const wordPrefix = stmt.text.slice(wordStart, stmt.offset);

  const beforeWord = stmt.text.slice(0, wordStart);
  const qualMatch = beforeWord.match(
    /((?:"[^"]+")|(?:\[[^\]]+\])|(?:[A-Za-z_][\w$]*))\s*\.\s*$/,
  );
  let qualifier: SqlCursorContext["qualifier"];
  if (qualMatch) {
    const raw = unquoteIdent(qualMatch[1]);
    qualifier = { raw, ref: resolveTableRef(raw, tables) };
  }

  return { clause, tables, qualifier, wordPrefix };
}
