---
name: design
description: D-Pilot's design system — semantic color tokens, dark/light/system theming, interaction states, density and type scale, and the accessibility floor. Use when building or restyling any UI in /src, adding a component, picking a color, or reviewing a frontend diff.
---

# D-Pilot design system

Stack: **Mantine 8** (theme in `src/main.tsx`) + semantic CSS variables
(`src/styles/global.css`) + AG Grid (`results-grid.tsx`) + Monaco
(`utils/monaco-setup.ts`). Barlow for UI, IBM Plex Mono for anything that is data.
Both fonts are self-hosted in `public/fonts/` — deployments can be air-gapped, so
never add a webfont `<link>` or any other runtime CDN dependency.

This is a **dense, read-heavy data tool for engineers**, not a marketing site.
Enterprise polish here means: consistent, keyboard-navigable, high information
density, and calm. Not: whitespace, gradients, animation.

## 1. Never hardcode a color

Every color resolves through a token in `global.css`, defined in **both** schemes.
A hex, or an `rgba()` of a brand color, inside a component is a bug.

| Token | Means |
|---|---|
| `--bg` | app canvas |
| `--surface` | raised panel / card / row |
| `--surface2` `--surface3` | recessed strip, sunken well |
| `--border` | decorative hairline, panel edge |
| `--border2` | boundary of a **control** (input, select, scrollbar) |
| `--text` `--muted2` `--muted` | primary / secondary / tertiary text |
| `--accent` | brand teal, for **shapes and icons** |
| `--accent-text` | brand teal for **words** — see §2 |
| `--token` | **PHI tokenization only** |
| `--success` `--error` `--warning` | state |
| `--type-special` | value-type accent (booleans, dates) in grid/JSON |
| `--hover` `--active` | translucent interaction overlays |
| `--shadow-1` `--shadow-2` | elevation |
| `--selected` `--focus-ring` | selection fill, focus outline |

Mantine props take them directly: `c="var(--muted2)"`, `bg="var(--surface)"`.

For a **tint** of a token, use `color-mix`, never a frozen `rgba()` — an rgba
literal cannot follow the color scheme:

```jsx
background: "color-mix(in srgb, var(--accent) 12%, transparent)"
```

**Reserved meanings — do not reuse decoratively:**
- **Teal** = PHI/tokenized data. A teal thing on screen must mean "this is masked".
- **Red** = production, destructive, or unmasked-PHI danger. Never "primary button".
- **Env colors** come from `envColor()` in `src/utils/environments.ts`. Never invent
  one, never hardcode the env list — a deployment can define `SUPER_PROD`.

## 2. Contrast is a hard gate

Token values were solved numerically against every surface, in both schemes, and
the whole palette currently passes. Keep it that way.

- **Text: ≥ 4.5:1** against `--bg`, `--surface` *and* `--surface2`.
- **Non-text (icons, control borders, focus ring): ≥ 3:1**.

This is why `--accent` and `--accent-text` are two tokens. The brand teal clears
3:1 (fine for an icon or a fill) but not 4.5:1, so **words in brand color — and
white words on a brand fill — use `--accent-text`**, one step darker. In dark mode
both resolve to the same value.

Same reason `--border2` looks heavier than you'd expect: it is the boundary that
makes an input identifiable, so it is held at 3:1 (IBM Carbon's field border sits
at the same ratio). `--border` is decorative and stays hairline. Don't swap them.

Changing any token means re-running the contrast math, not eyeballing it.

## 3. Theming: light / dark / system

Mantine owns the color scheme and stamps `data-mantine-color-scheme="light|dark"`
on `<html>`. An inline script in `index.html` applies the stored choice **before
first paint** (this is a client-only SPA, so a React-rendered `ColorSchemeScript`
would run too late and flash). `<ColorSchemeToggle>` is the Light/Dark/System
control, in the top-bar account menu. "System" is Mantine's `auto`.

Write theme-aware color **once**, at the token layer in `global.css`. In component
CSS, `light-dark()` also works — `postcss-preset-mantine` compiles it.

Rules:
- A color defined in only one scheme is a bug — define both.
- **Dark mode is not "invert"**. Shadows barely read on dark; separate surfaces
  with a lighter background plus a border, not `box-shadow`.
- Never branch on the color scheme in JS to pick a style. CSS does it with no
  re-render. The only legitimate `useComputedColorScheme` callers are the three
  third-party surfaces below, which cannot see our CSS variables:
  - **AG Grid** — `themeQuartz.withParams(light, "light").withParams(dark, "dark")`,
    selected by `data-ag-theme-mode` on `<html>` (`useAgThemeMode`).
  - **Monaco** — `d-pilot-light` / `d-pilot-dark` in `monaco-setup.ts`; every
    `<Editor>` passes `theme={editorTheme}` from `useEditorTheme()`.
  - **react-obj-view** — its `--bigobjview-*` vars in `results-json-view.tsx`.
  Each duplicates token values as literals. **Change a token, change the mirrors.**

## 4. Interaction states are not optional

Every interactive element ships all four:

```
:hover         --hover overlay (or --surface + --shadow-1 to lift)
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

- **Spacing**: Mantine tokens (`gap="xs"`, `p="sm"`), not raw px. Raw px only for
  fixed chrome (top-bar height, sidebar width).
- **Radius**: use the theme scale — `xs` 3px (chips), `sm` 4px (default: inputs,
  buttons), `md` 8px (panels, cards, menus), `50%` (avatars). Not ad-hoc 7/9px.
- **Type**: the theme scale is `xs` 11 / `sm` 13 / `md` 14 / `lg` 16 / `xl` 20, and
  `<Text>` defaults to `sm`. 13px is the working size; 11px for labels and
  metadata. Do not reintroduce a 16px body size — Mantine text sitting 3px larger
  than the hand-styled text beside it was the app's most visible inconsistency.
- **Mono** (`IBM Plex Mono`) for SQL, identifiers, values, counts, timestamps.
  Barlow for prose and labels. Mixing them in one line is what makes a data tool
  look amateur.

## 7. Layout & state

- Fill the viewport; scroll the pane, never the page. `body` is `overflow: hidden`.
- Every async surface needs all four: **loading** (skeleton, not a spinner in an
  empty box), **empty** (say what to do next), **error** (what failed and the
  retry), **success**.
- Long values truncate with a tooltip or click-to-expand — never reflow the row.

## 8. Before you call it done

- [ ] No new hex or brand-color `rgba()` outside `main.tsx` / `global.css`
- [ ] Renders correctly in dark **and** light (toggle it, don't assume)
- [ ] If a token changed: contrast re-checked, and the AG Grid / Monaco /
      react-obj-view mirrors updated
- [ ] Tab to every control — visible focus ring, correct order, Enter/Space work
- [ ] Hover/active/disabled all present, none of them in React state
- [ ] Env / PHI / production colors carry their reserved meaning
- [ ] `npx tsc --noEmit` and `npx vitest run` clean
