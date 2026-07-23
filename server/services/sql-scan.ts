// Dollar-quote / string / comment aware SQL scanner.
//
// One left-to-right pass powers three consumers so we never tokenize SQL more
// than once, and never with a naive `split(";")` that a PostgreSQL dollar-quoted
// body (e.g. a prompt template full of ; and ') would shred:
//   - statementCount: top-level `;` terminators (those inside quotes/comments
//     don't count). Drives migration-mode auto-detection in the UI.
//   - masked: the script with string / comment / dollar-quote *bodies* blanked
//     to spaces, so keyword checks never trip on a word sitting inside a literal
//     (the word "DROP" inside a prompt template must not read as a DROP verb).
//   - statements: a safe split at top-level `;`. Used ONLY by the no-rollback
//     path (where each statement must be sent to the engine individually).
//
// The transactional execution path never uses `statements` — it hands the whole
// script to the driver and lets the database be the authoritative parser.

export interface SqlScan {
  statementCount: number;
  masked: string;
  statements: string[];
}

/** Blank a source character, preserving newlines so line numbers survive. */
function blank(ch: string): string {
  return ch === "\n" ? "\n" : " ";
}

export function scanSql(sql: string): SqlScan {
  const out: string[] = [];
  const boundaries: number[] = []; // absolute indices of top-level ';'
  const n = sql.length;
  let i = 0;

  while (i < n) {
    const ch = sql[i];
    const two = sql.slice(i, i + 2);

    // Line comment: -- ... <eol>
    if (two === "--") {
      while (i < n && sql[i] !== "\n") {
        out.push(blank(sql[i]));
        i++;
      }
      continue;
    }

    // Block comment: /* ... */  (nests in PostgreSQL)
    if (two === "/*") {
      let depth = 1;
      out.push("  ");
      i += 2;
      while (i < n && depth > 0) {
        const t = sql.slice(i, i + 2);
        if (t === "/*") {
          depth++;
          out.push("  ");
          i += 2;
        } else if (t === "*/") {
          depth--;
          out.push("  ");
          i += 2;
        } else {
          out.push(blank(sql[i]));
          i++;
        }
      }
      continue;
    }

    // String / quoted identifier: '...' or "..."  (doubled quote escapes)
    if (ch === "'" || ch === '"') {
      const q = ch;
      out.push(" ");
      i++;
      while (i < n) {
        if (sql[i] === q) {
          if (sql[i + 1] === q) {
            out.push("  ");
            i += 2;
            continue;
          }
          out.push(" ");
          i++;
          break;
        }
        out.push(blank(sql[i]));
        i++;
      }
      continue;
    }

    // Dollar-quoted string: $tag$ ... $tag$  (tag may be empty: $$)
    if (ch === "$") {
      const m = /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        out.push(" ".repeat(tag.length));
        i += tag.length;
        const end = sql.indexOf(tag, i);
        if (end === -1) {
          while (i < n) {
            out.push(blank(sql[i]));
            i++;
          }
        } else {
          while (i < end) {
            out.push(blank(sql[i]));
            i++;
          }
          out.push(" ".repeat(tag.length));
          i += tag.length;
        }
        continue;
      }
    }

    // Top-level statement terminator.
    if (ch === ";") {
      boundaries.push(i);
      out.push(";");
      i++;
      continue;
    }

    out.push(ch);
    i++;
  }

  const masked = out.join("");

  const statements: string[] = [];
  let start = 0;
  for (const b of boundaries) {
    const s = sql.slice(start, b).trim();
    if (s) statements.push(s);
    start = b + 1;
  }
  const tail = sql.slice(start).trim();
  if (tail) statements.push(tail);

  return { statementCount: statements.length, masked, statements };
}
