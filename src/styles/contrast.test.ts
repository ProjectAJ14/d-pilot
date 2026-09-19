import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The accessibility floor, as a build gate.
 *
 * `tokens.css` is designed to be the one file you edit to re-theme the app,
 * which is exactly why it needs this: nudging a surface two shades is a
 * one-character change that can quietly drop a label under 4.5:1 on a ground
 * nobody happened to be looking at. The ratios in that file's comments were
 * solved numerically; this re-solves them on every run so they cannot rot.
 *
 * WCAG 2.1: 4.5:1 for text (1.4.3), 3:1 for the non-text things that have to
 * stay identifiable — a control's boundary and the focus ring (1.4.11).
 */

const TOKENS = readFileSync("src/styles/tokens.css", "utf8");

/** Every surface a role can end up sitting on, within one ground. */
const SURFACES = ["--bg", "--panel", "--mass", "--well"] as const;

/** Roles that render words, and so owe 4.5:1 against all four surfaces. */
const TEXT_ROLES = [
  "--ink",
  "--dim",
  "--faint",
  "--spot",
  "--success",
  "--error",
  "--warning",
  "--info",
  "--type-special",
] as const;

/** Roles that render a shape you must be able to find: 3:1 is the bar. */
const SHAPE_ROLES = ["--line-strong", "--focus-ring"] as const;

function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  const [r, g, b] = [0, 2, 4]
    .map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Pull one ground's role → value map out of tokens.css, following `var()`
 * indirections into the shared scale (`--spot: var(--vd-300)`). Roles whose
 * value is not a flat colour — `color-mix()`, a gradient, `rgba()` — are left
 * out: there is no single value to measure, and none of them carry text.
 */
function ground(scheme: "light" | "dark"): Record<string, string> {
  const start = TOKENS.indexOf(`:root[data-mantine-color-scheme="${scheme}"]`);
  expect(start, `${scheme} ground block`).toBeGreaterThan(-1);
  const block = TOKENS.slice(start, TOKENS.indexOf("}", start));

  const scale = Object.fromEntries(
    [...TOKENS.matchAll(/^\s*(--vd-\d+):\s*(#[0-9a-fA-F]{3,8});/gm)].map(
      (m) => [m[1], m[2]],
    ),
  );
  const raw: Record<string, string> = Object.fromEntries(
    [...block.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)].map(
      ([, name, value]) => [name, value.trim()],
    ),
  );

  // Chase `var()` through as many hops as it takes: `--focus-ring` is
  // `var(--spot)` is `var(--vd-300)`. Bounded so a cycle cannot hang the suite.
  const resolve = (value: string, depth = 0): string => {
    const ref = /^var\((--[\w-]+)\)$/.exec(value);
    if (!ref || depth > 8) return value;
    return resolve(scale[ref[1]] ?? raw[ref[1]] ?? "", depth + 1);
  };

  return Object.fromEntries(
    Object.entries(raw)
      .map(([name, value]) => [name, resolve(value)] as const)
      .filter(([, v]) => /^#[0-9a-fA-F]{3,8}$/.test(v)),
  );
}

describe.each([
  ["paper", "light"],
  ["ink", "dark"],
] as const)("%s ground", (_name, scheme) => {
  const roles = ground(scheme);

  it.each(TEXT_ROLES)("%s carries text on every surface (4.5:1)", (role) => {
    expect(roles[role], `${role} is not a flat colour`).toBeTruthy();
    for (const surface of SURFACES) {
      expect(
        Number(ratio(roles[role], roles[surface]).toFixed(2)),
        `${role} on ${surface}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(SHAPE_ROLES)(
    "%s stays identifiable on every surface (3:1)",
    (role) => {
      expect(roles[role], `${role} is not a flat colour`).toBeTruthy();
      for (const surface of SURFACES) {
        expect(
          Number(ratio(roles[role], roles[surface]).toFixed(2)),
          `${role} on ${surface}`,
        ).toBeGreaterThanOrEqual(3);
      }
    },
  );

  it("carries words on a brand fill", () => {
    // --spot-ink is the ink for a filled brand control. Mantine cannot pick it
    // (see variantColorResolver in main.tsx), so it is a token — and a token
    // nobody re-checks is a token that drifts.
    expect(
      Number(ratio(roles["--spot-ink"], roles["--spot"]).toFixed(2)),
      "--spot-ink on --spot",
    ).toBeGreaterThanOrEqual(4.5);
  });
});

describe("the brand mark", () => {
  // The login panel and the avatar keep one palette on BOTH grounds, so their
  // inks are solved against the lightest stop their gradients reach.
  const scale = Object.fromEntries(
    [...TOKENS.matchAll(/^\s*(--vd-\d+):\s*(#[0-9a-fA-F]{3,8});/gm)].map(
      (m) => [m[1], m[2]],
    ),
  );
  const inks = ["--brand-ink", "--brand-dim", "--brand-faint"] as const;
  const resolved = Object.fromEntries(
    inks.map((name) => {
      const m = new RegExp(`${name}:\\s*var\\((--vd-\\d+)\\)`).exec(TOKENS);
      return [name, scale[m![1]]];
    }),
  );

  it.each(inks)("%s reads on the brand panel (4.5:1)", (name) => {
    expect(
      Number(ratio(resolved[name], scale["--vd-800"]).toFixed(2)),
      `${name} on --vd-800`,
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("reads on the lightest stop of the avatar gradient", () => {
    expect(
      Number(ratio(resolved["--brand-ink"], scale["--vd-600"]).toFixed(2)),
      "--brand-ink on --vd-600",
    ).toBeGreaterThanOrEqual(4.5);
  });
});
