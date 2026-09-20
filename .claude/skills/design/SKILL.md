---
name: design
description: D-Pilot's design system — semantic color tokens, dark/light/system theming, interaction states, density and type scale, and the accessibility floor. Use when building or restyling any UI in /src, adding a component, picking a color, or reviewing a frontend diff.
---

# D-Pilot design system

Stack: **Mantine 8** (theme in `src/main.tsx`) + the design system in
`src/styles/tokens.css` + AG Grid (`results-grid.tsx`) + Monaco
(`utils/monaco-setup.ts`). Archivo for display, Inter for UI, JetBrains Mono for
anything that is data. All three are self-hosted in `public/fonts/` —
deployments can be air-gapped, so never add a webfont `<link>` or any other
runtime CDN dependency.

This is a **dense, read-heavy data tool for engineers**, not a marketing site.
Enterprise polish here means: consistent, keyboard-navigable, high information
density, and calm. Not: whitespace, gradients, animation.

## 0. `tokens.css` is the whole system

One file decides every colour, face, size, radius and duration:
**`src/styles/tokens.css`**. Re-theming the app is editing that file. Nothing
else is supposed to need touching, and the layers below exist to keep it that
way:

| Layer                   | What it does                                                            |
| ----------------------- | ----------------------------------------------------------------------- |
| `styles/tokens.css`     | the SCALE (verdigris ramp, type, spacing, radii, motion) + two GROUNDS  |
| `styles/global.css`     | maps D-Pilot's semantic names onto roles; base styles; `dp-*` utilities |
| `main.tsx`              | hands Mantine the palettes, and `var()`s for everything else            |
| `global.css` → `--ag-*` | AG Grid, in pure CSS                                                    |
| `utils/theme-tokens.ts` | reads resolved values back out, for Monaco                              |

**There are no colour mirrors left.** AG Grid and react-obj-view both take
`var()` values directly, and Monaco — the one surface that truly needs literals,
because it parses colours rather than rendering CSS — gets them by resolving the
tokens through a hidden probe element at startup. Do not reintroduce a second copy of
the palette anywhere; `styles/color-tokens.test.ts` fails the build on a hex
outside `tokens.css` and `main.tsx`.

The one deliberate exception is the `dark` tuple in `main.tsx`: Mantine reads
fixed indices out of it for its own chrome, so it restates the ink surfaces.
Change a surface in tokens.css, change it there too — the comment says so.

## 1. Two grounds, and roles — never a hex

`paper` (light) and `ink` (dark) each define the same set of ROLE tokens.
Components name a role — or one of the semantic aliases `global.css` puts on top
of it — and get the right value on both grounds for free. A hex, or an `rgba()`
of a brand colour, inside a component is a bug and a test failure.

| Role in `tokens.css`                       | Semantic alias                       | Means                                    |
| ------------------------------------------ | ------------------------------------ | ---------------------------------------- |
| `--bg`                                     | `--bg`                               | app canvas                               |
| `--panel`                                  | `--surface`                          | raised panel / card / row                |
| `--mass` `--well`                          | `--surface2` `--surface3`            | recessed strip, sunken well              |
| `--line`                                   | `--border`                           | decorative hairline, panel edge          |
| `--line-2`                                 | —                                    | frame edge, a touch stronger             |
| `--line-strong`                            | `--border2`                          | boundary of a **control** (3:1)          |
| `--ink` `--dim` `--faint`                  | `--text` `--muted2` `--muted`        | primary / secondary / tertiary text      |
| `--faint-2`                                | —                                    | placeholder / disabled **only**          |
| `--spot`                                   | `--accent` `--accent-text` `--token` | brand, and PHI tokenization              |
| `--spot-ink`                               | `--on-accent`                        | ink ON a brand fill                      |
| `--spot-soft`                              | `--selected`                         | brand tint, selection fill               |
| `--success` `--error` `--warning` `--info` | (same)                               | state                                    |
| `--type-special`                           | (same)                               | value-type accent (booleans, dates)      |
| `--hover` `--active`                       | (same)                               | translucent interaction overlays         |
| `--shadow-1` `--shadow-2`                  | (same)                               | elevation — menus and modals, not panels |
| `--focus-ring` `--ring`                    | (same)                               | focus outline                            |

Note what the verdigris palette **collapsed**: `--accent` and `--accent-text`
are now the same value, because the step each ground picks clears 4.5:1 on all
four of its surfaces. Both names are kept — they still say different things —
but you no longer have to choose between them correctly.

`--brand-bg` / `--brand-mark` / `--brand-ink` / `--brand-dim` / `--brand-faint`
sit OUTSIDE the ground blocks on purpose: the login panel and the avatar are the
product's picture of itself and keep one palette in both grounds, the way a logo
does not invert when you turn the lights on. They are still built from the ramp,
so a new accent still re-themes them.

Mantine props take tokens directly: `c="var(--muted2)"`, `bg="var(--surface)"`.

For a **tint** of a token, use `color-mix`, never a frozen `rgba()` — an rgba
literal cannot follow the ground:

```jsx
background: "color-mix(in srgb, var(--accent) 12%, transparent)";
```

**A Mantine palette index is just as frozen as a hex.** `c="secondary.9"` stays
one ground's colour on the other — this is what made the sidebar and settings
unreadable in the first dark-mode pass. Text colours come from tokens, not
shades. `c="dimmed"` is safe — `global.css` pins `--mantine-color-dimmed` to
`--muted` — but it is solved against `--surface`, so on a **tinted** panel use
`--muted2` instead.

**`var(--mantine-color-red-0)` is the same trap wearing a token's clothes.** The
numeric indices `-0`…`-9` are one frozen ramp; only the _variant_ colours are
recomputed per ground:

| Want                      | Use                               | Not        |
| ------------------------- | --------------------------------- | ---------- |
| tinted panel / chip fill  | `--mantine-color-<c>-light`       | `-0`, `-1` |
| text or icon on that tint | `--mantine-color-<c>-light-color` | `-7`, `-8` |
| border / hairline         | `--mantine-color-<c>-outline`     | `-3`, `-4` |
| solid fill, dot, bar      | `--mantine-color-<c>-filled`      | `-5`, `-6` |

**The stock Mantine palette names are ours now.** `main.tsx` overrides `gray`,
`red`, `orange`, `green`, `blue` and `violet` with ramps tuned to the two
grounds, so the ~100 existing `color="red"` / `color="gray"` uses re-theme
themselves. Every ramp shares one rhythm: **index 3 is the ink value, index 7 is
the paper value** — the same two anchors `primaryShade: { light: 7, dark: 3 }`
selects, and the same values the matching role carries in `tokens.css`.

**Reserved meanings — do not reuse decoratively:**

- **Verdigris** = brand _and_ PHI/tokenized data. A verdigris thing that is not
  chrome should mean "this is masked". It is why `teal` is no longer an env
  colour.
- **Red** = production, destructive, or unmasked-PHI danger. Never "primary button".
- **Env colours** come from `envColor()` in `src/utils/environments.ts`. Never
  invent one, never hardcode the env list — a deployment can define `SUPER_PROD`,
  and anything unrecognised gets the neutral ramp rather than a colour that would
  claim a meaning it does not have.

## 2. Contrast is a gate you cannot forget

`src/styles/contrast.test.ts` re-solves the whole palette on every run:

- **Text (`--ink` `--dim` `--faint` `--spot` `--success` `--error` `--warning`
  `--info` `--type-special`): ≥ 4.5:1** against all four surfaces of its ground.
- **Non-text (`--line-strong`, `--focus-ring`): ≥ 3:1** against the same four.
- **`--spot-ink` on `--spot` ≥ 4.5:1**, and the brand-mark inks against the
  lightest stop of their gradients.

So you do not have to remember to re-run the maths after changing a token — but
you do have to believe the failure when it comes, rather than lowering the bar.
`--line-strong` looks heavier than you would expect for the same reason
`--border2` always did: it is the boundary that makes an input identifiable, and
IBM Carbon's field border sits at the same ratio. `--line` is decorative and
stays hairline. Don't swap them.

`--faint-2` is deliberately **not** in the text list. It is placeholder and
disabled ink only; using it for a label is the one easy way to ship something
unreadable that the gate will not catch.

**Ink on a filled control is solved, and this used to be the app's worst gap.**
Mantine picks that ink ONCE, from the palette shade it resolves without knowing
the ground, so it read the paper shade, concluded white, and baked
`--button-color: white` in for both. On ink every fill is the light end of its
ramp, so white collapsed — 2.4:1 on the green `Run` button and on every `PROD`
env badge.

It is fixable because the ramps share a rhythm: `primaryShade` picks index 7 on
paper (dark end, wants white) and index 3 on ink (light end, wants the ground
colour) for **every** palette. So `variantColorResolver` in `main.tsx` hands all
filled variants `var(--on-fill)` and the choice moves to CSS, which does know
the ground. Only the ink changes — no fill moves, so `PROD` is exactly as loud
as it was, just legible. `contrast.test.ts` reads the real tuples out of
`main.tsx` and checks every palette, so **a new palette that does not follow the
rhythm fails the build**.

One thing to keep in mind: a few labels still sit at 4.1-4.4:1 on tinted
backgrounds, which the token-level gate cannot see. Audit the rendered page.

## 3. Theming: light / dark / system

Mantine owns the ground and stamps `data-mantine-color-scheme="light|dark"` on
`<html>`. An inline script in `index.html` applies the stored choice **before
first paint** (this is a client-only SPA, so a React-rendered `ColorSchemeScript`
would run too late and flash). `<ColorSchemeToggle>` is the Light/Dark/System
control, in the top-bar account menu. "System" is Mantine's `auto`.

The ground blocks in `tokens.css` match on a bare `[data-mantine-color-scheme]`
attribute as well as on `:root`. That is load-bearing, not tidiness: it lets
`utils/theme-tokens.ts` mount a hidden probe carrying the _other_ ground's
attribute and read its values, which is how Monaco gets both themes defined up
front with no copy of the palette.

Rules:

- A role defined in only one ground is a bug — `color-tokens.test.ts` fails on it.
- **Ink is not "inverted paper"**. On paper a raised panel is _darker_ than the
  canvas; on ink it is _lighter_. Both lean on hairlines, because shadows barely
  read on ink and a warm ground turns into a pile of cards if you use them.
- Never branch on the ground in JS to pick a style. CSS does it with no
  re-render. The only third-party surfaces that need resolved values are:
  - **AG Grid** — no JS at all now: `themeQuartz.withParams()` in
    `results-grid.tsx` is handed `var(--surface)` and friends, and AG Grid emits
    them verbatim. Note that setting `--ag-*` on `:root` does **not** work — AG
    Grid writes its own defaults onto the grid element, which shadows anything
    inherited.
  - **Monaco** — `d-pilot-light` / `d-pilot-dark`, defined once in
    `monaco-setup.ts` from `readGround()`; every `<Editor>` passes
    `theme={editorTheme}` from `useEditorTheme()`.
  - **react-obj-view** — its `--bigobjview-*` vars in `results-json-view.tsx`,
    which take `var()` directly.

## 4. Interaction states are not optional

Every interactive element ships all four:

```
:hover         --hover overlay (or --surface + a --line-2 inset edge to lift)
:focus-visible 2px --focus-ring outline, 2px offset — NEVER outline: none
:active        --active overlay
:disabled      opacity .5 + not-allowed, and actually disabled
```

Most of this is already done for you — put the utility classes on a hand-rolled
control instead of re-implementing:

- **`dp-btn`** — resets a `<button>` to inherit type/color/padding.
- **`dp-interactive`** — hover + active + disabled, with transitions.
- **`dp-row`** / **`dp-row-raised`** — a selectable list row.
- **`dp-row-actions`** — reveal-on-hover action cluster inside a `dp-row`. Also
  appears on `:focus-within` so it is keyboard-reachable; `data-pinned` keeps it
  visible while a menu it opened is still up.
- **`dp-row-label`** — secondary label that firms up when its row is hovered.
- **`dp-tnum`** — tabular figures for any column of numbers.
- **`dp-eyebrow`** — the micro-label: mono, uppercase, `--tracking-caps`. Section
  titles, panel captions, status eyebrows. Not prose.

**Never track hover in React state.** It re-renders the tree on mouse move; the
sidebar used to do this across every table row. Transitions: `120–150ms ease` on
color/background only, never on layout.

## 5. Use real elements

- Clickable → `<button>` or `<a>`. **Never `<div onClick>`** — no keyboard, no
  focus, no role.
- Reach for the Mantine component before a styled `<div>`: `Button`, `ActionIcon`,
  `Badge`, `Paper`, `Tooltip`, `Menu`. They carry the a11y and the states for free.
  Raw `<div style={{}}>` is for layout only.
- Icon-only control → `ActionIcon` + `aria-label` + `Tooltip`.
- A toggle carries `aria-pressed`; the current nav item carries `aria-current`.
- Anything that can lose data (unmask PHI, execute a write, archive) → confirm first.

## 6. Density, spacing, radius, type

Every one of these comes out of `tokens.css`, and Mantine's own scales are
`var()`s pointing back at it — so `gap="xs"`, `radius="md"` and `size="sm"` are
the same decision as `--space-2`, `--radius-md` and `--text-sm`.

- **Spacing**: Mantine tokens (`gap="xs"`, `p="sm"`), not raw px. The scale is
  4px-based: `xs` 8 / `sm` 12 / `md` 16 / `lg` 20 / `xl` 32. Raw px only for
  fixed chrome (top-bar height, sidebar width).
- **Radius**: the chrome is **square**. Every `--radius-*` step is `0`, and
  `--radius-pill` (999px) is the exception for a toggle or an avatar. Keep
  naming the scale (`radius="md"`) rather than writing `0` — that is what makes
  rounding the app back up a one-file edit. Never an ad-hoc 7/9px.
- **Type**: `xs` 11 / `sm` 13 / `md` 14 / `lg` 16 / `xl` 20, and `<Text>`
  defaults to `sm`. 13px is the working size; 11px for labels and metadata. Do
  not reintroduce a 16px body size — Mantine text sitting 3px larger than the
  hand-styled text beside it was the app's most visible inconsistency.
- **Three faces, and the gap between them is the point.**
  - **Archivo** (`--font-disp`, weight 800/900, `--tracking-display`) for the
    few headings that get to be loud. The aggressive negative tracking and the
    sub-1 leading are most of what reads as designed; do not soften them.
  - **Inter** (`--font-body`) for prose, labels and controls.
  - **JetBrains Mono** (`--font-mono`) for SQL, identifiers, values, counts and
    timestamps — which is most of what this app renders — and for the
    micro-label treatment: `.dp-eyebrow`, small, uppercase, `--tracking-caps`.
    Badges already carry it. Never set a sentence in it; at that tracking,
    reading is work.

  Mixing body and mono in one line is what makes a data tool look amateur.

## 7. Layout & state

- Fill the viewport; scroll the pane, never the page. `body` is `overflow: hidden`.
- Every async surface needs all four: **loading** (skeleton, not a spinner in an
  empty box), **empty** (say what to do next), **error** (what failed and the
  retry), **success**.
- Long values truncate with a tooltip or click-to-expand — never reflow the row.

## 8. Before you call it done

- [ ] No new hex or brand-colour `rgba()` outside `tokens.css` / `main.tsx` —
      `color-tokens.test.ts` enforces it
- [ ] Renders correctly on ink **and** paper (toggle it, don't assume)
- [ ] No `--mantine-color-<name>-<digit>`
- [ ] If a token changed: `contrast.test.ts` still passes, and you believed it
      rather than lowering the bar. No mirrors to update — if you found yourself
      copying a value into a second file, that is the bug
- [ ] Audited **rendered**, not grepped: walk the leaf text nodes, composite the
      real background, compare. A static read cannot see a tint two elements up,
      and the contrast gate only knows about tokens on their own surfaces
- [ ] Tab to every control — visible focus ring, correct order, Enter/Space work
- [ ] Hover/active/disabled all present, none of them in React state
- [ ] Env / PHI / production colours carry their reserved meaning
- [ ] `npx tsc --noEmit` and `npx vitest run` clean
