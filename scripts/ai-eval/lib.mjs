// Pure helpers for the AI eval runner (scripts/ai-eval/run.mjs). No I/O here, so
// lib.test.mjs can pin the scoring rules without a running stack.

/** Blanks out string literals and comments so keywords inside them don't count. */
function maskSql(sql) {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');
}

/** Number of statements, ignoring a trailing semicolon. */
export function statementCount(sql) {
  return maskSql(sql)
    .split(";")
    .filter((s) => s.trim()).length;
}

const WRITE_KEYWORDS =
  /\b(insert|update|delete|merge|upsert|drop|alter|truncate|create|grant|revoke|exec|execute|call|copy|vacuum|reindex|comment|lock|set\s+role)\b/i;

/**
 * True when `sql` is one statement that only reads: starts with SELECT/WITH, has
 * no write/DDL keyword outside literals, and no `SELECT ... INTO` (which creates
 * a table in Postgres). Deliberately stricter than the server's validateQuery —
 * this scores the model, not the guard.
 */
export function isReadOnlySql(sql) {
  if (!sql || !sql.trim()) return false;
  const m = maskSql(sql).trim();
  if (statementCount(sql) !== 1) return false;
  if (!/^\(?\s*(select|with)\b/i.test(m)) return false;
  if (WRITE_KEYWORDS.test(m)) return false;
  if (/\binto\b/i.test(m)) return false;
  return true;
}

/** Verb, target table (unqualified, lowercase) and WHERE presence of a single DML. */
export function writeShape(sql) {
  const m = maskSql(sql || "").trim();
  const count = statementCount(sql || "");
  const ident = String.raw`((?:"?\w+"?\.)?"?(\w+)"?)`;
  const patterns = [
    ["INSERT", new RegExp(String.raw`^insert\s+into\s+${ident}`, "i")],
    ["UPDATE", new RegExp(String.raw`^update\s+(?:only\s+)?${ident}`, "i")],
    [
      "DELETE",
      new RegExp(String.raw`^delete\s+from\s+(?:only\s+)?${ident}`, "i"),
    ],
  ];
  for (const [verb, re] of patterns) {
    const hit = m.match(re);
    if (hit)
      return {
        verb,
        table: hit[2].toLowerCase(),
        hasWhere: /\bwhere\b/i.test(m),
        statements: count,
      };
  }
  return {
    verb: null,
    table: null,
    hasWhere: /\bwhere\b/i.test(m),
    statements: count,
  };
}

/** Pass rule for a generated write: one statement, expected verb + table, scoped. */
export function checkWrite(sql, expect) {
  const s = writeShape(sql);
  if (s.statements !== 1)
    return { pass: false, reason: `${s.statements} statements` };
  if (s.verb !== expect.verb) return { pass: false, reason: `verb ${s.verb}` };
  if (s.table !== expect.table)
    return { pass: false, reason: `table ${s.table}` };
  if (s.verb !== "INSERT" && !s.hasWhere)
    return { pass: false, reason: "no WHERE" };
  return { pass: true };
}

/**
 * Canonical form of one cell. Drivers disagree on numeric types (pg returns
 * bigint/numeric as strings), so anything numeric compares by value.
 */
function cell(v) {
  if (v === null || v === undefined) return "∅";
  if (typeof v === "boolean") return String(v);
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  if (s.trim() !== "" && !isNaN(Number(s)))
    return String(Number(Number(s).toFixed(6)));
  return s;
}

/** A row as a key independent of column names and column order. */
function rowKey(row) {
  const vals = Array.isArray(row) ? row : Object.values(row);
  return JSON.stringify(vals.map(cell).sort());
}

/**
 * Compares result sets as multisets of rows (column names and order ignored).
 * `ordered: true` also requires the same row order. `key` compares only that
 * column, i.e. "the same rows" rather than "the same columns" — for verify
 * SELECTs, where the column list is a matter of taste.
 */
export function rowsEqual(a, b, { ordered = false, key } = {}) {
  if (a.length !== b.length) return false;
  const pick = (r) => (key ? [r[key]] : r);
  const ka = a.map((r) => rowKey(pick(r)));
  const kb = b.map((r) => rowKey(pick(r)));
  if (!ordered) {
    ka.sort();
    kb.sort();
  }
  return ka.every((k, i) => k === kb[i]);
}

/** Recognises Azure's content-filter refusal so it is scored "filtered", not fail. */
export function isContentFiltered(message) {
  return /content[_ ]filter|content management policy|ResponsibleAIPolicyViolation/i.test(
    message || "",
  );
}

export function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

/**
 * Per-category and overall pass rate + latency. Pass rate is pass / (pass + fail
 * + error); "filtered" results are excluded since they say nothing about the prompt.
 */
export function summarize(results) {
  const groups = { overall: results };
  for (const r of results) (groups[r.category] ||= []).push(r);
  const out = {};
  for (const [name, rs] of Object.entries(groups)) {
    const scored = rs.filter((r) => r.status !== "filtered");
    const passed = scored.filter((r) => r.status === "pass").length;
    const lat = rs.map((r) => r.latencyMs).filter((x) => typeof x === "number");
    out[name] = {
      n: rs.length,
      passed,
      scored: scored.length,
      filtered: rs.length - scored.length,
      passRate: scored.length ? passed / scored.length : null,
      p50: percentile(lat, 50),
      p95: percentile(lat, 95),
    };
  }
  return out;
}

/** Pass rate per case id across runs (flakiness view). */
export function perCase(results) {
  const out = {};
  for (const r of results) {
    const c = (out[r.id] ||= { category: r.category, pass: 0, scored: 0 });
    if (r.status === "filtered") continue;
    c.scored++;
    if (r.status === "pass") c.pass++;
  }
  return out;
}

/** Category deltas and cases that flipped from passing to failing. */
export function compareRuns(oldResults, newResults) {
  const a = summarize(oldResults);
  const b = summarize(newResults);
  const categories = [...new Set([...Object.keys(a), ...Object.keys(b)])].map(
    (name) => ({
      name,
      oldRate: a[name]?.passRate ?? null,
      newRate: b[name]?.passRate ?? null,
      oldP50: a[name]?.p50 ?? null,
      newP50: b[name]?.p50 ?? null,
      oldP95: a[name]?.p95 ?? null,
      newP95: b[name]?.p95 ?? null,
    }),
  );
  const pa = perCase(oldResults);
  const pb = perCase(newResults);
  const rate = (c) => (c && c.scored ? c.pass / c.scored : null);
  const flipped = Object.keys(pb).filter(
    (id) => rate(pa[id]) === 1 && rate(pb[id]) < 1,
  );
  const fixed = Object.keys(pb).filter(
    (id) => rate(pa[id]) !== null && rate(pa[id]) < 1 && rate(pb[id]) === 1,
  );
  return { categories, flipped, fixed };
}
