/**
 * A failure on screen → a prefilled GitHub issue on the public D-Pilot repo.
 *
 * Issues are public and D-Pilot sits on PHI, so the report is built from an
 * allowlist, never from what is on screen: no SQL, no rows, no connection,
 * table, user or environment names. The one free-text field — the database's
 * error message — goes through `scrub` first, because drivers echo values back
 * (`Key (email)=(jane@…) already exists`).
 */
const REPO = "ProjectAJ14/d-pilot";
/** GitHub answers 414 past ~8k. Leave room for the fixed part of the URL. */
const MAX_URL = 6000;
const MAX_MESSAGE = 500;

export interface Failure {
  /** Fixed label written in code ("Query", "Settings") — never user input. */
  where: string;
  /** Raw error message; scrubbed here, so callers cannot forget to. */
  message: string;
  /** Driver code (Postgres SQLSTATE, MSSQL/Mongo code) — data-free by design. */
  code?: string;
  /** e.g. "postgres". A fixed list, not a name. */
  dbType?: string;
  /** `isProductionEnv(env)` — the env's name itself never leaves the app. */
  production?: boolean;
  version: string;
  userAgent: string;
  /** ISO time, so the reporter's admins can find the QUERY_ERROR audit row. */
  time: string;
}

/** Everything that could be data, out. Punctuation-only quotes (`";"`) stay — they name the syntax fault. */
export function scrub(text: string): string {
  // Quoted or bracketed text is where drivers put values and identifiers.
  // Innermost first, until stable, so `(Doe (Jr), Jane)` is caught whole; a
  // scrubbed group is held as \0 + its PAIRS index so its outer group can still match.
  const PAIRS = ['""', "''", "``", "[]", "()", "{}"];
  let out = text;
  for (let prev = ""; prev !== out; ) {
    prev = out;
    out = out.replace(
      /"[^"]*"|'[^']*'|`[^`]*`|\[[^[\]]*\]|\([^()]*\)|\{[^{}]*\}/g,
      (m) =>
        /[\p{L}\p{N}\0]/u.test(m)
          ? `\0${PAIRS.indexOf(m[0] + m[m.length - 1])}`
          : m,
    );
  }
  return (
    out
      .replace(/\0(\d)/g, (_, i) => `${PAIRS[i][0]}<value>${PAIRS[i][1]}`)
      .replace(
        /\b(sk-[A-Za-z0-9_-]{8,}|gsk_[A-Za-z0-9]{8,}|xox[bapsr]-[A-Za-z0-9-]{8,})/g,
        "<key>",
      )
      .replace(
        /((?:api[-_]?key|authorization|bearer|token|password)["'\s:=]+)[^\s"',;]+/gi,
        "$1<key>",
      )
      // Unquoted identifiers after the word that names them:
      // `permission denied for table customers`, `not authorized on appdb`.
      .replace(
        /\b(table|schema|database|relation|column|view|index|constraint|sequence|function|procedure|collection|namespace|role|user|login|authorized on)\s+(?![<"'`[({])[^\s,;:]+/gi,
        "$1 <name>",
      )
      .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "<email>")
      .replace(/\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/g, "<ip>")
      // Hosts and schema.table names alike.
      .replace(/\b[\w-]+(\.[\w-]+)+\b/g, "<name>")
      // Long numbers are IDs, dates, phone parts. Short ones are positions and sizes.
      .replace(/\d{4,}/g, "<n>")
      .slice(0, MAX_MESSAGE)
  );
}

function title(f: Failure, message: string): string {
  const tags = [f.dbType, f.code].filter(Boolean).join(", ");
  return `${f.where} failed${tags ? ` (${tags})` : ""}: ${message}`.slice(
    0,
    120,
  );
}

function body(f: Failure, message: string): string {
  const env =
    f.production === undefined
      ? "—"
      : f.production
        ? "production-like"
        : "non-production";
  return [
    "### What happened",
    "",
    `${f.where} failed. Reported from the app — the error below is captured, with values removed.`,
    "",
    "```",
    message,
    "```",
    "",
    "### Context",
    "",
    "| | |",
    "|---|---|",
    `| Error code | ${f.code ?? "—"} |`,
    `| Database | ${f.dbType ?? "—"} |`,
    `| Environment | ${env} |`,
    `| D-Pilot | ${f.version} |`,
    `| Browser | ${f.userAgent.slice(0, 200)} |`,
    `| Time | ${f.time} |`,
    "",
    "### Steps to reproduce",
    "",
    "<!-- What were you trying to do? This issue is PUBLIC: describe the query's shape, never paste real SQL, table names or data. -->",
    "",
  ].join("\n");
}

export function issueUrl(f: Failure): string {
  const message = scrub(f.message);
  const build = (m: string) =>
    `https://github.com/${REPO}/issues/new?${new URLSearchParams({
      title: title(f, m),
      body: body(f, m),
      labels: "bug",
    })}`;

  const full = build(message);
  if (full.length <= MAX_URL) return full;
  // Non-ASCII text encodes to up to 9 URL chars each, so 500 of them can still overflow. One clamp.
  const over = full.length - MAX_URL;
  return build(
    message.slice(0, Math.max(80, message.length - over - 20)) + " [truncated]",
  );
}
