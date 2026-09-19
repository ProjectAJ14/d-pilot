import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Guards on the design system.
 *
 * `styles/tokens.css` is meant to be the ONLY place a colour is decided, so
 * these tests fail the build on the ways that stops being true: a component
 * reaching past the tokens for a frozen value, a ground gaining a role its
 * counterpart does not have, or an alias pointing at a role that is not there.
 */

/**
 * A Mantine palette index (`--mantine-color-red-0`) looks exactly like a design
 * token but is frozen per palette: it cannot follow the colour scheme. That is
 * how the AI review card ended up painting a light-pink surface under near-white
 * text on the ink ground — 1.1:1, unreadable.
 *
 * The scheme-aware variant colours (`-light`, `-light-color`, `-filled`,
 * `-outline`) and the semantic tokens are the supported way to say the same
 * thing, so this fails on any new numeric index in src/.
 */
const FROZEN_INDEX =
  /--mantine-color-[a-zA-Z]+-\d\b|--mantine-color-\$\{[^}]+\}-\d\b/g;

/**
 * A literal colour outside the design system's own files. `tokens.css` owns the
 * palette; `main.tsx` restates it for Mantine, which cannot read CSS variables
 * for its own palette maths. Anywhere else a hex pins the element to one
 * ground, which is what makes a re-theme a scavenger hunt.
 */
const HEX = /#[0-9a-fA-F]{3,8}\b/g;
const PALETTE_FILES = ["src/styles/tokens.css", "src/main.tsx"];

/**
 * Blank out comments before scanning. A hex in a doc comment pins nothing —
 * and the files that explain the token plumbing quote example values by
 * necessity. Line comments are matched only when not preceded by `:`, so a
 * `https://` in a comment or a string is left alone.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_, lead) => lead);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx|css)$/.test(entry) && !entry.endsWith(".test.ts")
      ? [full]
      : [];
  });
}

describe("color tokens", () => {
  it("uses no frozen Mantine palette indices in src/", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles("src")) {
      const text = readFileSync(file, "utf8");
      text.split("\n").forEach((line, i) => {
        for (const hit of line.match(FROZEN_INDEX) ?? []) {
          offenders.push(`${file}:${i + 1}  ${hit.trim()}`);
        }
      });
    }
    expect(
      offenders,
      `Frozen palette indices cannot follow the color scheme. Use the variant\ncolors (-light, -light-color, -filled, -outline) or a token from\ntokens.css instead:\n\n${offenders.join("\n")}\n`,
    ).toEqual([]);
  });

  it("decides colors only in tokens.css and main.tsx", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles("src")) {
      if (PALETTE_FILES.includes(file)) continue;
      const text = stripComments(readFileSync(file, "utf8"));
      text.split("\n").forEach((line, i) => {
        for (const hit of line.match(HEX) ?? []) {
          offenders.push(`${file}:${i + 1}  ${hit}`);
        }
      });
    }
    expect(
      offenders,
      `A literal color pins an element to one ground. Name a role from\nsrc/styles/tokens.css (or a semantic alias from global.css) instead:\n\n${offenders.join("\n")}\n`,
    ).toEqual([]);
  });

  it("defines every ground role in both grounds", () => {
    const css = readFileSync("src/styles/tokens.css", "utf8");
    // Everything before the first ground block is the shared scale; the two
    // blocks after it must agree, role for role.
    const paperStart = css.indexOf('[data-mantine-color-scheme="light"]');
    const inkStart = css.indexOf('[data-mantine-color-scheme="dark"]');
    expect(paperStart, "paper (light) ground block").toBeGreaterThan(-1);
    expect(inkStart, "ink (dark) ground block").toBeGreaterThan(paperStart);

    const roles = (chunk: string) =>
      new Set([...chunk.matchAll(/^\s*(--[\w-]+):/gm)].map((m) => m[1]));
    const paper = roles(css.slice(paperStart, inkStart));
    const ink = roles(css.slice(inkStart));

    expect(
      [...paper].filter((r) => !ink.has(r)),
      "roles defined on paper but not on ink",
    ).toEqual([]);
    expect(
      [...ink].filter((r) => !paper.has(r)),
      "roles defined on ink but not on paper",
    ).toEqual([]);
  });

  it("keeps the semantic aliases pointing at roles that exist", () => {
    const tokens = readFileSync("src/styles/tokens.css", "utf8");
    const global = readFileSync("src/styles/global.css", "utf8");
    // Both files count: tokens.css declares the roles, and global.css's own
    // aliases are what the `--ag-*` and `--mantine-*` blocks below them point at.
    const defined = new Set(
      [...tokens.matchAll(/^\s*(--[\w-]+):/gm)]
        .concat([...global.matchAll(/^\s*(--[\w-]+):/gm)])
        .map((m) => m[1]),
    );
    // Every `var(--x)` an alias in global.css hands on must resolve to
    // something the design system actually defines — a typo'd role renders
    // nothing at all, silently.
    const referenced = [
      ...global.matchAll(/^\s*--[\w-]+:\s*var\((--[\w-]+)\)/gm),
    ].map((m) => m[1]);
    expect(
      referenced.filter((r) => !defined.has(r) && !r.startsWith("--mantine")),
      "aliases pointing at roles tokens.css does not define",
    ).toEqual([]);
  });
});
