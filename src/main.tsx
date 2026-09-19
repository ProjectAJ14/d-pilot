import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import {
  MantineProvider,
  createTheme,
  Text,
  Title,
  Button,
  Badge,
  Code,
  Kbd,
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
  "#a09a8c",
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
 * Mantine picks the ink for a `filled` control once, from the palette shade it
 * resolves without knowing the colour scheme — so it reads one ground's brand
 * shade, decides white is right, and emits `--button-color: white` inline for
 * both. On ink the brand fill is the LIGHT verdigris, where white collapses to
 * 1.4:1.
 *
 * Handing back a token instead moves the decision to CSS, which does know the
 * ground: white on the dark verdigris (paper, 8.42:1), the ground colour on the
 * light verdigris (ink, 10.33:1). Only the brand fill is overridden — the stock
 * red/orange badges keep their documented treatment.
 */
const variantColorResolver: VariantColorsResolver = (input) => {
  const resolved = defaultVariantColorsResolver(input);
  if (input.variant === "filled" && input.color === "primary") {
    return { ...resolved, color: "var(--on-accent)" };
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
  // Flips label text to black on filled backgrounds too light to carry white.
  // Note: this does NOT reach the env badges (PROD/STG/UAT) — Mantine only
  // applies it to `filled` variants and those still resolve to white here.
  // Fixing that means changing the env badge treatment, which is a product
  // decision about how loud PROD looks.
  autoContrast: true,
  variantColorResolver,
  cursorType: "pointer",
  colors: {
    primary,
    neutral,
    red,
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
      styles: () => ({
        label: {
          fontFamily: "var(--font-mono)",
          letterSpacing: "var(--tracking-caps)",
          fontWeight: "var(--weight-medium)",
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
