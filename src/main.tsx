import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import {
  MantineProvider,
  createTheme,
  Text,
  Title,
  Button,
  Badge,
  Avatar,
  Loader,
  Code,
  Kbd,
  SegmentedControl,
  TextInput,
  defaultVariantColorsResolver,
  type VariantColorsResolver,
  type MantineColorsTuple,
} from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { createRoot } from "react-dom/client";
import App from "./App";
import { installClipboardFallback } from "./utils/clipboard-polyfill";
import "./styles/fonts.css";
import "./styles/global.css";
// AFTER the stylesheets, deliberately: monaco-setup defines its editor themes
// by reading the resolved design tokens out of the document, so tokens.css has
// to be in the page by the time this module is evaluated. Still well before the
// first <Editor> renders, which is all it otherwise requires.
import "./utils/monaco-setup";

// Enable copy-to-clipboard in insecure contexts (e.g. app opened via http://<lan-ip>).
installClipboardFallback();

/**
 * The palettes.
 *
 * Mantine cannot read CSS variables for its own palette maths (it derives the
 * `light`/`outline`/`filled` variants from these tuples at runtime), so this is
 * the one place the design system's colours are restated in JS. Everything
 * *else* Mantine takes — fonts, sizes, radii, spacing — is handed over as a
 * `var()` below and stays in tokens.css.
 *
 * All the ramps share one rhythm, so a shade index means the same thing in each:
 *
 *   index 3 = the value solved for the INK ground   (dark)
 *   index 7 = the value solved for the PAPER ground (light)
 *
 * which is why `primaryShade` is `{ light: 7, dark: 3 }`. Those two anchors are
 * the exact values `--spot`, `--error`, `--warning`, `--success`, `--info` and
 * `--type-special` carry in tokens.css — each already contrast-solved against
 * all four surfaces of its ground — and the rest of each ramp is interpolated
 * monotonically out to near-white and near-black around them.
 *
 * The names are Mantine's stock ones on purpose. The app says `color="red"`,
 * `color="gray"`, `color="teal"` in about a hundred places; overriding the
 * stock palettes re-themes all of them at once, where adding differently-named
 * custom palettes would have re-themed none.
 */

/** Verdigris — the brand. Aged bronze on a bow fitting; one hue, spent
 *  sparingly. The same ten steps as `--vd-50`…`--vd-900` in tokens.css. */
const primary: MantineColorsTuple = [
  "#e6f7f3",
  "#c4ede4",
  "#9be0d2",
  "#79d5c4",
  "#3fb8a3",
  "#199688",
  "#0e6e66",
  "#0a5751",
  "#07403c",
  "#052e2b",
];

/** The warm neutrals: both grounds' surface and text steps in one ramp.
 *  Aliased to `gray` below, which is where Mantine finds its own chrome. */
const neutral: MantineColorsTuple = [
  "#f0ede6",
  "#e7e3da",
  "#ddd8cc",
  "#d2ccbd",
  "#b5ae9d",
  // Mantine takes its disabled/placeholder ink from gray[5]; this is the same
  // value as --faint-2 on paper, for the reason tokens.css gives there.
  "#857e6e",
  "#807a6c",
  "#5b574c",
  "#3d3a33",
  "#16150f",
];

/** Danger: production, destructive, unmasked PHI. Never a primary button. */
const red: MantineColorsTuple = [
  "#f5eded",
  "#ebcacb",
  "#e8a1a3",
  "#eb7175",
  "#e65055",
  "#e22e34",
  "#cd1d23",
  "#ac181d",
  "#801418",
  "#561012",
];

const orange: MantineColorsTuple = [
  "#f6f2ec",
  "#e7d0ac",
  "#e6b05e",
  "#e8920c",
  "#ce8108",
  "#b26f05",
  "#955d04",
  "#7a4b00",
  "#5a3802",
  "#3d2603",
];

const green: MantineColorsTuple = [
  "#eff3ef",
  "#bed7bf",
  "#87c189",
  "#4caf50",
  "#429d45",
  "#388a3b",
  "#2e7731",
  "#256328",
  "#1d4a1f",
  "#153216",
];

const blue: MantineColorsTuple = [
  "#ebf1f7",
  "#bfd6f0",
  "#8abaf2",
  "#4a9eff",
  "#3088f7",
  "#1971ed",
  "#195fcd",
  "#1c4fa8",
  "#173d7e",
  "#112a54",
];

const violet: MantineColorsTuple = [
  "#efebf7",
  "#ddd1f4",
  "#c9b1f7",
  "#b48cff",
  "#a06efb",
  "#8c50f7",
  "#7934f1",
  "#671aea",
  "#4e14b2",
  "#361077",
];

/** The AI features (Generate, write-request review) ask for `grape`. Kept a
 *  distinct hue from `violet` because violet is the QA environment. */
const grape: MantineColorsTuple = [
  "#f4ebf7",
  "#e6d1f0",
  "#d9b1ec",
  "#d18cff",
  "#c46ef7",
  "#b350ee",
  "#9c34d8",
  "#7b1aab",
  "#5d1482",
  "#3f0e58",
];

/**
 * Mantine's own dark ramp is a neutral grey; ours is the ink ground. These are
 * the SAME surfaces tokens.css defines — Mantine reads fixed indices out of
 * this tuple (0 = text, 2 = dimmed, 4 = border, 5 = hover, 7 = panel, 8 = body),
 * so the ORDER is load-bearing. It is the one tuple that genuinely mirrors a
 * ground block: change a surface in tokens.css, change it here too.
 */
const dark: MantineColorsTuple = [
  "#eae7e1", // --ink
  "#c9c4bc",
  "#a29c93", // --dim
  "#9b968d", // --faint
  "#33333a", // --line-2
  "#2f2f35", // --well
  "#26262a", // --mass
  "#1e1e22", // --panel
  "#17171a", // --bg
  "#0f0f11",
];

/**
 * The ink on a filled control.
 *
 * Mantine picks this ONCE, from the palette shade it resolves without knowing
 * the colour scheme (`parsed.isLight` in its default resolver) — so it reads
 * the paper-ground shade, decides white is right, and emits
 * `--button-color: white` inline for BOTH grounds. On ink every fill is the
 * light end of its ramp, where white collapses: 2.4:1 on the green Run button,
 * and the same on every `PROD`/`STG` env badge. That gap was documented as
 * unfixable-without-a-redesign for a long time.
 *
 * It is fixable now because the ramps share a rhythm. `primaryShade` picks
 * index 7 on paper (the dark end, wants white ink) and index 3 on ink (the
 * light end, wants the ground colour) — for EVERY palette, not just the brand.
 * So the choice is one token, and handing it back moves the decision to CSS,
 * which does know the ground.
 *
 * Every combination clears 4.5:1; `styles/contrast.test.ts` checks all of them
 * against these tuples on every run. Note this changes only the INK — no fill
 * moves, so `PROD` is exactly as loud as it was, just legible.
 */
const variantColorResolver: VariantColorsResolver = (input) => {
  const resolved = defaultVariantColorsResolver(input);
  if (input.variant === "filled") {
    return { ...resolved, color: "var(--on-fill)" };
  }
  return resolved;
};

/**
 * Everything below that is not a palette is a `var()` pointing back at
 * tokens.css. Mantine's `rem()` converter passes a `var(...)` string through
 * untouched, which is what lets the type scale, the radii and the spacing scale
 * live in ONE file and still reach Mantine's own components.
 */
const theme = createTheme({
  fontFamily: "var(--font-body)",
  fontFamilyMonospace: "var(--font-mono)",
  headings: {
    // The display face, with the tracking and sub-1 leading that are most of
    // what reads as "designed". global.css sets the same on bare h1-h6.
    fontFamily: "var(--font-disp)",
    fontWeight: "var(--weight-extra)",
  },
  primaryColor: "primary",
  // index 7 = the paper-ground step, index 3 = the ink-ground step. See the
  // palette note above.
  primaryShade: { light: 7, dark: 3 },
  // Mantine hardcodes `--mantine-color-white` as the light-scheme surface of a
  // few components (Notification, most visibly), so leaving it at #fff floats a
  // sheet of literal white over the cream ground. On a warm ground the "white"
  // IS the paper's raised surface. Safe now that no filled control takes its
  // ink from here — see variantColorResolver above.
  white: "#e7e3da",
  black: "#16150f",
  fontSizes: {
    xs: "var(--text-xs)",
    sm: "var(--text-sm)",
    md: "var(--text-md)",
    lg: "var(--text-lg)",
    xl: "var(--text-xl)",
  },
  lineHeights: {
    xs: "var(--lh-xs)",
    sm: "var(--lh-sm)",
    md: "var(--lh-md)",
    lg: "var(--lh-lg)",
    xl: "var(--lh-xl)",
  },
  spacing: {
    xs: "var(--space-2)",
    sm: "var(--space-3)",
    md: "var(--space-4)",
    lg: "var(--space-5)",
    xl: "var(--space-8)",
  },
  // The chrome is square: hairline rules, not rounded cards. Every step is 0 in
  // tokens.css, so rounding the app back up is a one-file edit.
  radius: {
    xs: "var(--radius-xs)",
    sm: "var(--radius-sm)",
    md: "var(--radius-md)",
    lg: "var(--radius-lg)",
    xl: "var(--radius-xl)",
  },
  defaultRadius: "sm",
  // Kept on for the variants `variantColorResolver` does not override.
  autoContrast: true,
  variantColorResolver,
  cursorType: "pointer",
  colors: {
    primary,
    neutral,
    red,
    grape,
    // Teal is the reserved PHI/tokenization hue and verdigris IS that hue, so
    // `color="teal"` and the brand resolve to one ramp. Left on the stock
    // Mantine teal it was a second, colder green sitting next to the brand.
    teal: primary,
    orange,
    green,
    blue,
    violet,
    dark,
    // Mantine resolves its own neutrals (default borders, `dimmed` text) out of
    // `gray`. Point it at the ground neutrals so Mantine chrome and the CSS
    // tokens are one palette rather than two that nearly match.
    gray: neutral,
  },
  components: {
    Text: Text.extend({
      defaultProps: { size: "sm" },
    }),
    Title: Title.extend({
      styles: () => ({ root: { letterSpacing: "var(--tracking-display)" } }),
    }),
    Button: Button.extend({
      // The brand fill is the call to action; everything that should be quieter
      // already asks for `variant="default"`/`"subtle"`/`"light"` by name.
      defaultProps: { color: "primary", fw: 500 },
      styles: () => ({ root: { letterSpacing: "var(--tracking-snug)" } }),
    }),
    Badge: Badge.extend({
      // A badge is a micro-label, so it takes the micro-label treatment: mono,
      // wide-tracked, square. This is the loudest single carrier of the theme,
      // because env badges and status pills are everywhere.
      //
      // `radius` has to be passed explicitly: Badge only emits `--badge-radius`
      // when the prop is set, and falls back to a hardcoded 1000px otherwise —
      // so `theme.radius` alone left every badge a pill in an app of squares.
      defaultProps: { radius: "sm" },
      styles: () => ({
        label: {
          fontFamily: "var(--font-mono)",
          letterSpacing: "var(--tracking-caps)",
          fontWeight: "var(--weight-medium)",
        },
      }),
    }),
    Loader: Loader.extend({
      // The default "oval" spinner and the "dots" variant are both circles.
      // Bars are rectangles, so the one animated thing in the app matches the
      // square chrome instead of being the lone round shape on screen.
      defaultProps: { type: "bars" },
    }),
    Avatar: Avatar.extend({
      // Mantine defaults Avatar to a circle; nothing in this theme is round.
      defaultProps: { radius: "sm" },
    }),
    SegmentedControl: SegmentedControl.extend({
      // A segmented control is a row of micro-labels, so it takes the
      // micro-label treatment — same as Badge. Doing it here rather than per
      // instance means the view toggles, the request filters and the theme
      // picker all read as one control rather than three.
      styles: () => ({
        label: {
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
          letterSpacing: "var(--tracking-caps)",
          textTransform: "uppercase",
        },
      }),
    }),
    Code: Code.extend({
      styles: () => ({ root: { fontFamily: "var(--font-mono)" } }),
    }),
    Kbd: Kbd.extend({
      styles: () => ({ root: { fontFamily: "var(--font-mono)" } }),
    }),
    TextInput: TextInput.extend({
      styles: () => ({ input: { borderColor: "var(--border2)" } }),
    }),
  },
});

createRoot(document.getElementById("root")!).render(
  <MantineProvider theme={theme} defaultColorScheme="auto">
    <Notifications position="bottom-right" />
    <App />
  </MantineProvider>,
);
