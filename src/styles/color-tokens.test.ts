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
 * A font-family declaration, in CSS or in a JSX style object. The design system
 * names three faces (`--font-disp`, `--font-body`, `--font-mono`) and the whole
 * point is that swapping one is a single edit — so a literal family name
 * anywhere else is a face that will NOT change with it.
 *
 * This is not hypothetical: the verdigris re-theme left 24 `"IBM Plex Mono,
 * monospace"` literals behind, every one of them pointing at a file that had
 * just been deleted.
 */
const FONT_FAMILY = /font-?[Ff]amily:\s*("[^"]*"|'[^']*'|[^,;\n}]+)/g;

/**
 * Mantine's shorthand prop. `ff="monospace"` is fine — it is a keyword that
 * resolves through `theme.fontFamilyMonospace`, which points at `--font-mono`
 * — but `ff="Barlow, sans-serif"` names a face directly and would sail past
 * the `fontFamily:` pattern above. There are ~65 `ff=` uses, so this matters.
 */
const FF_PROP = /\bff="([^"]*)"/g;
const FF_KEYWORDS = new Set(["monospace", "text", "heading"]);
const FONT_FILES = ["src/styles/tokens.css", "src/styles/fonts.css"];

/**
 * A corner radius. The chrome is square, and `--radius-*` is how it stays that
 * way — but Mantine's `radius: 0` only reaches Mantine components, so the 75
 * inline `borderRadius: 8` on hand-rolled divs are what actually decide whether
 * the app looks like one thing. A literal here is a corner that will not follow
 * the next theme.
 *
 * `50%` is exempt: that is a circle, a shape rather than a step on the scale.
 */
const RADIUS = /\b[A-Za-z]*[Bb]order-?[Rr]adius: *("[^"]*"|'[^']*'|[^,;\n}]+)/g;

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
    return /\.(ts|tsx|css)$/.test(entry) && !/\.test\.tsx?$/.test(entry)
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

  it("names a face only through the type tokens", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles("src")) {
      if (FONT_FILES.includes(file)) continue;
      const text = stripComments(readFileSync(file, "utf8"));
      for (const [, value] of text.matchAll(FF_PROP)) {
        if (!FF_KEYWORDS.has(value.trim()) && !value.includes("var(--font-")) {
          offenders.push(`${file}  ff="${value}"`);
        }
      }
      for (const [, value] of text.matchAll(FONT_FAMILY)) {
        // `var(--mantine-font-family*)` is fine: main.tsx points those at
        // ours. `inherit` opts out of naming a face at all, which is the
        // correct thing for a control that should match its surroundings.
        const followsSystem =
          value.includes("var(--font-") ||
          value.includes("var(--mantine-font-family") ||
          value.trim().replace(/["']/g, "") === "inherit";
        if (!followsSystem) {
          offenders.push(`${file}  ${value.trim()}`);
        }
      }
    }
    expect(
      offenders,
      `A literal font family does not follow the design system. Use
--font-disp / --font-body / --font-mono from tokens.css:

${offenders.join("\n")}
`,
    ).toEqual([]);
  });

  it("names a corner radius only through the radius scale", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles("src")) {
      if (file === "src/styles/tokens.css") continue;
      const text = stripComments(readFileSync(file, "utf8"));
      for (const [, value] of text.matchAll(RADIUS)) {
        const v = value.trim().replace(/["']/g, "");
        if (v.includes("var(--radius-") || v === "inherit") {
          continue;
        }
        offenders.push(`${file}  ${v}`);
      }
    }
    expect(
      offenders,
      `A literal radius will not follow the theme. Use a step from the scale
in tokens.css (--radius-none … --radius-xl). There is no pill or circle
step on purpose — see the RADII note in tokens.css:

${offenders.join("\n")}
`,
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

  /**
   * Monaco is the one consumer that resolves tokens through a probe element
   * (`utils/theme-tokens.ts`), and a custom property inherits its COMPUTED
   * value — so a token declared only on `:root` hands the probe whatever the
   * ACTIVE ground already resolved it to, not the ground the probe asked for.
   * That silently built Monaco's dark theme out of paper colours once.
   *
   * Every name Monaco reads therefore has to be declared inside a per-ground
   * block, in both grounds.
   */
  it("only lets Monaco read tokens that are declared per ground", () => {
    const monaco = readFileSync("src/utils/monaco-setup.ts", "utf8");
    const block = /const THEME_TOKENS = \[([\s\S]*?)\] as const;/.exec(monaco);
    expect(block, "THEME_TOKENS in monaco-setup.ts").not.toBeNull();
    const wanted = [...block![1].matchAll(/"(--[\w-]+)"/g)].map((m) => m[1]);
    expect(wanted.length).toBeGreaterThan(0);

    const tokens = readFileSync("src/styles/tokens.css", "utf8");
    const global = readFileSync("src/styles/global.css", "utf8");
    // Declarations that live under a selector mentioning a ground attribute.
    const perGround = (css: string, scheme: string) => {
      const names = new Set<string>();
      for (const rule of css.split("}")) {
        const [selector, body] = rule.split("{");
        if (!body) continue;
        if (!selector.includes(`data-mantine-color-scheme="${scheme}"`))
          continue;
        for (const m of body.matchAll(/^\s*(--[\w-]+):/gm)) names.add(m[1]);
      }
      return names;
    };
    for (const scheme of ["light", "dark"]) {
      const declared = new Set([
        ...perGround(tokens, scheme),
        ...perGround(global, scheme),
      ]);
      expect(
        wanted.filter((t) => !declared.has(t)),
        `tokens Monaco reads that are not declared for the ${scheme} ground — the probe would return the OTHER ground's value`,
      ).toEqual([]);
    }
  });

  /**
   * The browser and OS chrome — the mobile URL bar, the installed window's
   * title bar, the splash screen behind the app while it boots.
   *
   * These are the one class of colour the guards above cannot reach: a
   * `theme-color` meta is read out of index.html before any stylesheet loads,
   * and the manifest is JSON served by Express, so neither can be a `var()`.
   * That makes them the last real mirror of tokens.css — and an unguarded
   * mirror is one a re-theme leaves behind, which is the whole failure mode
   * this file exists to prevent. The splash screen showing the OLD ground
   * behind the new app is exactly how it would surface.
   *
   * The invariant is narrow on purpose: each one must be a ground's `--bg`,
   * because what they paint is the app's canvas extending past the viewport.
   */
  it("paints the installed app out of the design system", () => {
    const tokens = readFileSync("src/styles/tokens.css", "utf8");
    const grounds = ["light", "dark"].map((scheme) => {
      const start = tokens.indexOf(
        `:root[data-mantine-color-scheme="${scheme}"]`,
      );
      const block = tokens.slice(start, tokens.indexOf("}", start));
      return /^\s*--bg:\s*(#[0-9a-fA-F]{3,8});/m.exec(block)![1].toLowerCase();
    });

    // The boot screen (the #boot style block in index.html) is the same kind
    // of mirror for the same reason — it paints before any stylesheet is in
    // the document — but it is the app's canvas rather than the chrome around
    // it, so it draws with ink and the spot colour too, not just --bg. Held to
    // the weaker invariant that fits it: every value must still be one
    // tokens.css declares, so a re-theme cannot leave it behind either.
    const declared = new Set(
      (stripComments(tokens).match(HEX) ?? []).map((h) => h.toLowerCase()),
    );
    const html = stripComments(readFileSync("index.html", "utf8"));
    const bootStart = html.indexOf("#boot {");
    const boot = bootStart === -1 ? "" : html.slice(bootStart);

    const offenders: string[] = [];
    for (const hit of boot.match(HEX) ?? []) {
      if (!declared.has(hit.toLowerCase()))
        offenders.push(
          `index.html (#boot)  ${hit} — not a value in tokens.css`,
        );
    }
    for (const file of ["index.html", "server/index.ts"]) {
      const text =
        file === "index.html"
          ? html.slice(0, bootStart === -1 ? undefined : bootStart)
          : stripComments(readFileSync(file, "utf8"));
      for (const hit of text.match(HEX) ?? []) {
        if (!grounds.includes(hit.toLowerCase()))
          offenders.push(`${file}  ${hit}`);
      }
    }
    expect(
      offenders,
      `The theme-color metas and the web manifest paint the chrome around the
app, so they have to be a ground's --bg from src/styles/tokens.css
(${grounds.join(" or ")}) — they cannot be var()s, so this is what keeps
them in step:\n\n${offenders.join("\n")}\n`,
    ).toEqual([]);
  });

  /**
   * `color="yellow"` is not an error and not a warning — it is a stock Mantine
   * palette rendering next to a themed one, which is the same drift a hex
   * would cause and is harder to spot because it looks like it followed the
   * rules. `main.tsx` overrides the stock names it uses precisely so the ~100
   * existing `color=` props re-theme themselves; a name it does NOT override
   * quietly opts out of that.
   *
   * This is how the `noTransaction` checkbox ended up in Mantine's own yellow
   * inside a callout drawn in `--warning`.
   *
   * Only string literals are checked. `color={envColor(env)}` is computed, and
   * `utils/environments.ts` is where that mapping is reviewed.
   */
  it("names only palettes main.tsx defines", () => {
    const main = readFileSync("src/main.tsx", "utf8");
    // Non-greedy to the first `},` on a line of its own: the colors block is a
    // flat list of palette names, so nothing nested can end it early.
    const block = /colors: \{([\s\S]*?)\n\s*\},/.exec(main);
    expect(block, "the colors block in main.tsx").not.toBeNull();
    const defined = new Set(
      [...block![1].matchAll(/^\s*(\w+)[,:]/gm)].map((m) => m[1]),
    );
    expect(defined.size).toBeGreaterThan(5);

    const offenders: string[] = [];
    for (const file of sourceFiles("src")) {
      const text = stripComments(readFileSync(file, "utf8"));
      text.split("\n").forEach((line, i) => {
        for (const [, name] of line.matchAll(/\bcolor="([a-z]+)"/g)) {
          if (!defined.has(name))
            offenders.push(`${file}:${i + 1}  color="${name}"`);
        }
      });
    }
    expect(
      offenders,
      `These name a Mantine palette that main.tsx does not override, so they
render in stock Mantine colours beside the themed ones. Use a palette from
the colors block (${[...defined].join(", ")}):\n\n${offenders.join("\n")}\n`,
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
