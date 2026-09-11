import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * A Mantine palette index (`--mantine-color-red-0`) looks exactly like a design
 * token but is frozen per palette: it cannot follow the color scheme. That is
 * how the AI review card ended up painting a light-pink surface under
 * near-white text in dark mode — 1.1:1, unreadable.
 *
 * The scheme-aware variant colors (`-light`, `-light-color`, `-filled`,
 * `-outline`) and the semantic tokens in global.css are the supported way to
 * say the same thing, so this fails on any new numeric index in src/.
 */
const FROZEN_INDEX =
  /--mantine-color-[a-zA-Z]+-\d\b|--mantine-color-\$\{[^}]+\}-\d\b/g;

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
      `Frozen palette indices cannot follow the color scheme. Use the variant\ncolors (-light, -light-color, -filled, -outline) or a token from\nglobal.css instead:\n\n${offenders.join("\n")}\n`,
    ).toEqual([]);
  });

  it("defines every color token in both schemes", () => {
    const css = readFileSync("src/styles/global.css", "utf8");
    // The dark scheme block redefines the tokens the light :root sets.
    const darkStart = css.indexOf('[data-mantine-color-scheme="dark"]');
    expect(darkStart).toBeGreaterThan(-1);
    const light = new Set(
      [...css.slice(0, darkStart).matchAll(/^\s*(--[\w-]+):/gm)].map(
        (m) => m[1],
      ),
    );
    const dark = new Set(
      [...css.slice(darkStart).matchAll(/^\s*(--[\w-]+):/gm)].map((m) => m[1]),
    );
    // Tokens carrying a color must flip; layout/size tokens legitimately do not.
    const colorish = [...light].filter((t) =>
      /(bg|surface|border|text|muted|accent|token|success|error|warning|hover|active|selected|focus|shadow|type-special|on-accent)/.test(
        t,
      ),
    );
    expect(colorish.filter((t) => !dark.has(t))).toEqual([]);
  });
});
