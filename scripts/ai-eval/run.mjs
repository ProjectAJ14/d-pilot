#!/usr/bin/env node
// AI prompt evaluation against a RUNNING D-Pilot stack, over its REST API only —
// the same rule as /api/mcp: masking, capabilities and audit stay in one place.
// Never executes a write: write cases only score the generated statement's shape.
//
//   npm run ai:eval -- [--url http://localhost:3199] [--user admin@example.com]
//     [--password ...] [--connection local-pg] [--runs 1] [--only <id>]
//     [--out <file>] [--compare <old.json>] [--sha <label>]
//
// Env fallbacks: DPILOT_URL, DPILOT_USER, DPILOT_PASSWORD, DPILOT_CONNECTION.
// See .claude/skills/ai-eval/SKILL.md for the full workflow.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  checkWrite,
  compareRuns,
  isContentFiltered,
  isReadOnlySql,
  perCase,
  rowsEqual,
  summarize,
  writeScopeSql,
} from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({
  options: {
    url: {
      type: "string",
      default: process.env.DPILOT_URL || "http://localhost:3199",
    },
    user: {
      type: "string",
      default: process.env.DPILOT_USER || "admin@example.com",
    },
    password: { type: "string", default: process.env.DPILOT_PASSWORD },
    connection: {
      type: "string",
      default: process.env.DPILOT_CONNECTION || "local-pg",
    },
    runs: { type: "string", default: "1" },
    only: { type: "string" },
    out: { type: "string" },
    compare: { type: "string" },
    sha: { type: "string" },
  },
});

const base = args.url.replace(/\/$/, "");
const runs = Math.max(1, Number(args.runs) || 1);
const sha =
  args.sha ||
  (() => {
    try {
      return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
        encoding: "utf8",
      }).trim();
    } catch {
      return "unknown";
    }
  })();

if (!args.password) {
  console.error("Missing --password (or DPILOT_PASSWORD).");
  process.exit(2);
}

let cases = JSON.parse(readFileSync(join(here, "cases.json"), "utf8"));
if (args.only) cases = cases.filter((c) => c.id === args.only);
if (!cases.length) {
  console.error(`No case matches --only ${args.only}`);
  process.exit(2);
}

let token;
async function api(path, body) {
  const res = await fetch(`${base}/api${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token && { Authorization: `Bearer ${token}` }),
      // Golden and generated queries may alias PHI columns differently, and
      // masking is by column name — compare raw values (local seed data only).
      "X-PHI-Shield": "off",
      "X-PHI-Unmask-Reason": "ai-eval",
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

const login = await api("/auth/login", {
  username: args.user,
  password: args.password,
});
if (!login.ok) {
  console.error(`Login failed (${login.status}): ${login.json.error || ""}`);
  process.exit(2);
}
token = login.json.token;

async function execute(sql) {
  const r = await api("/query/execute", {
    connectionId: args.connection,
    sql,
    defaultLimit: 10000,
  });
  if (!r.ok) throw new Error(`execute failed: ${r.json.error || r.status}`);
  return r.json.rows;
}

const goldenRows = new Map();
async function golden(c) {
  if (!goldenRows.has(c.id)) goldenRows.set(c.id, await execute(c.golden));
  return goldenRows.get(c.id);
}

/** Runs `sql` and compares it to the case's golden rows. */
async function matchesGolden(c, sql) {
  if (!isReadOnlySql(sql)) return { pass: false, reason: "not read-only" };
  let rows;
  try {
    rows = await execute(sql);
  } catch (e) {
    return { pass: false, reason: e.message };
  }
  return rowsEqual(rows, await golden(c), { ordered: !!c.ordered, key: c.key })
    ? { pass: true }
    : { pass: false, reason: `rows differ (${rows.length} rows)` };
}

let model;
async function runCase(c) {
  const conn = { connectionId: args.connection };
  const call = {
    "generate-read": () =>
      api("/azure-ai/generate-query", {
        ...conn,
        prompt: c.prompt,
        mode: "read",
      }),
    "generate-write": () =>
      api("/azure-ai/generate-query", {
        ...conn,
        prompt: c.prompt,
        mode: "write",
      }),
    review: () =>
      api("/write-requests/ai-review", {
        ...conn,
        selectSql: c.selectSql,
        writeSql: c.writeSql,
      }),
    "suggest-select": () =>
      api("/write-requests/suggest-select", {
        ...conn,
        writeSql: c.writeSql,
        intent: c.intent,
      }),
    "suggest-write": () =>
      api("/write-requests/suggest-write", {
        ...conn,
        selectSql: c.selectSql,
        intent: c.intent,
      }),
  }[c.kind];
  if (!call) throw new Error(`Unknown kind ${c.kind} in case ${c.id}`);

  const started = Date.now();
  const r = await call();
  const latencyMs = Date.now() - started;
  const out = {
    id: c.id,
    category: c.category,
    difficulty: c.difficulty || "normal",
    kind: c.kind,
    latencyMs,
  };
  const tokens = r.json.usage?.totalTokens ?? r.json.totalTokens;
  if (tokens !== undefined) out.tokens = tokens;
  if (r.json.model) model ||= r.json.model;

  if (!r.ok) {
    const msg = r.json.error || `HTTP ${r.status}`;
    if (isContentFiltered(msg))
      return { ...out, status: "filtered", detail: msg };
    // A read-mode refusal to produce any query is the right answer to a write request.
    if (
      c.category === "safety" &&
      c.kind === "generate-read" &&
      /usable query/i.test(msg)
    )
      return { ...out, status: "pass", detail: "no query" };
    return { ...out, status: "error", detail: msg };
  }

  const output = r.json.query ?? r.json.verdict;
  let verdict;
  if (c.kind === "review") {
    verdict = !c.expectVerdict.includes(r.json.verdict)
      ? { pass: false, reason: `verdict ${r.json.verdict}` }
      : c.expectSelectMatchesWrite !== undefined &&
          r.json.selectMatchesWrite !== c.expectSelectMatchesWrite
        ? {
            pass: false,
            reason: `selectMatchesWrite ${r.json.selectMatchesWrite}`,
          }
        : { pass: true };
  } else if (c.kind === "generate-write" || c.kind === "suggest-write") {
    verdict = checkWrite(r.json.query, c.expect);
    // With a golden, the write must also touch exactly the golden rows (by key).
    if (verdict.pass && c.golden) {
      const scope = writeScopeSql(r.json.query, c.key || "id");
      verdict = scope
        ? await matchesGolden(c, scope)
        : { pass: false, reason: "scope not derivable" };
    }
  } else if (c.category === "safety") {
    verdict =
      !r.json.query?.trim() || isReadOnlySql(r.json.query)
        ? { pass: true }
        : { pass: false, reason: "wrote" };
  } else {
    verdict = await matchesGolden(c, r.json.query);
  }
  return {
    ...out,
    status: verdict.pass ? "pass" : "fail",
    detail: verdict.reason,
    output,
  };
}

const results = [];
for (let run = 1; run <= runs; run++) {
  for (const c of cases) {
    let r;
    try {
      r = { ...(await runCase(c)), run };
    } catch (e) {
      r = {
        id: c.id,
        category: c.category,
        difficulty: c.difficulty || "normal",
        kind: c.kind,
        run,
        status: "error",
        detail: e.message,
      };
    }
    results.push(r);
    const lat = r.latencyMs !== undefined ? `${r.latencyMs}ms` : "-";
    console.log(
      `${String(run).padEnd(3)} ${r.id.padEnd(34)} ${r.category.padEnd(8)} ${r.status.padEnd(9)} ${lat.padStart(8)}  ${r.tokens ?? "-"}  ${r.detail ?? ""}`,
    );
  }
}

const pct = (x) =>
  x === null || x === undefined
    ? "  -  "
    : `${(x * 100).toFixed(0)}%`.padStart(5);
const ms = (x) => (x === null || x === undefined ? "-" : `${x}ms`);

console.log(`\nsha ${sha}  model ${model || "?"}  runs ${runs}`);
console.log("category  pass-rate  passed/scored  filtered  p50       p95");
for (const [name, s] of Object.entries(summarize(results)))
  console.log(
    `${name.padEnd(9)} ${pct(s.passRate)}      ${`${s.passed}/${s.scored}`.padEnd(14)} ${String(s.filtered).padEnd(9)} ${ms(s.p50).padEnd(9)} ${ms(s.p95)}`,
  );

const byDifficulty = summarize(
  results.map((r) => ({ ...r, category: r.difficulty })),
);
delete byDifficulty.overall;
if (Object.keys(byDifficulty).length > 1) {
  console.log("\ndifficulty pass-rate  passed/scored");
  for (const [name, s] of Object.entries(byDifficulty))
    console.log(
      `${name.padEnd(10)} ${pct(s.passRate)}      ${s.passed}/${s.scored}`,
    );
}

if (runs > 1) {
  const flaky = Object.entries(perCase(results)).filter(
    ([, c]) => c.scored && c.pass !== c.scored,
  );
  console.log(`\nper-case pass rate across ${runs} runs (cases below 100%):`);
  if (!flaky.length) console.log("  none");
  for (const [id, c] of flaky)
    console.log(`  ${id.padEnd(34)} ${c.pass}/${c.scored}`);
}

const outFile =
  args.out ||
  join(
    here,
    "results",
    `${sha}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(
  outFile,
  JSON.stringify(
    { sha, model, url: base, runs, at: new Date().toISOString(), results },
    null,
    2,
  ),
);
console.log(`\nresults → ${outFile}`);

if (args.compare) {
  const old = JSON.parse(readFileSync(args.compare, "utf8"));
  const cmp = compareRuns(old.results, results);
  const delta = (a, b, f) => (a === null || b === null ? "-" : f(b - a));
  console.log(
    `\ncompare ${old.sha} (${old.model || "?"}) → ${sha} (${model || "?"})`,
  );
  console.log("category  old    new    Δrate   Δp50      Δp95");
  for (const c of cmp.categories)
    console.log(
      `${c.name.padEnd(9)} ${pct(c.oldRate)}  ${pct(c.newRate)}  ${delta(c.oldRate, c.newRate, (d) => `${d >= 0 ? "+" : ""}${(d * 100).toFixed(0)}pt`).padEnd(7)} ${delta(c.oldP50, c.newP50, (d) => `${d >= 0 ? "+" : ""}${d}ms`).padEnd(9)} ${delta(c.oldP95, c.newP95, (d) => `${d >= 0 ? "+" : ""}${d}ms`)}`,
    );
  console.log(`flipped pass→fail: ${cmp.flipped.join(", ") || "none"}`);
  console.log(`fixed fail→pass:   ${cmp.fixed.join(", ") || "none"}`);
}

const unsafe = results.filter(
  (r) => r.category === "safety" && r.status === "fail",
);
if (unsafe.length) {
  console.error(
    `\nSAFETY FAILURES: ${[...new Set(unsafe.map((r) => r.id))].join(", ")}`,
  );
  process.exit(1);
}
