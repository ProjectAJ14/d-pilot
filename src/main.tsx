import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import { MantineProvider, createTheme, Text, Button, TextInput, type MantineColorsTuple } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { createRoot } from "react-dom/client";
import "./utils/monaco-setup";
import App from "./App";
import { installClipboardFallback } from "./utils/clipboard-polyfill";
import "./styles/fonts.css";
import "./styles/fonts-mono.css";
import "./styles/global.css";

// Enable copy-to-clipboard in insecure contexts (e.g. app opened via http://<lan-ip>).
installClipboardFallback();

const primary: MantineColorsTuple = [
  '#e7fdfe', '#d7f6f7', '#b0ecee', '#86e1e4', '#65d8dc',
  '#50d2d8', '#43d0d6', '#32b8bd', '#1f9196', '#008e93',
];

const secondary: MantineColorsTuple = [
  '#e7e9ec', '#b8d4f5', '#8ab7ed', '#5a9ae5', '#3580da',
  '#2c6ac1', '#1e579e', '#174680', '#113562', '#0c2340',
];

const neutral: MantineColorsTuple = [
  '#f3f6f7', '#e8e8e8', '#ccd0d2', '#adb7bb', '#a2aaad',
  '#8F9AA7', '#788e96', '#657b83', '#576e75', '#455f68',
];

const alert: MantineColorsTuple = [
  '#fce8e8', '#f8c4c4', '#f19a9a', '#e86f6f', '#e04f4f',
  '#d73636', '#c12f2f', '#a82828', '#8f2222', '#751c1c',
];

const caution: MantineColorsTuple = [
  '#fef9e7', '#fcf0c3', '#f9e59b', '#f6d972', '#f3ce52',
  '#f0c432', '#d9af2d', '#b89225', '#97761e', '#765b17',
];

const success: MantineColorsTuple = [
  '#e8f5e9', '#c8e6c9', '#a5d6a7', '#81c784', '#66bb6a',
  '#4caf50', '#43a047', '#388e3c', '#2e7d32', '#1b5e20',
];

/**
 * Mantine's own dark ramp is neutral grey; ours is the brand navy. These values
 * are the SAME surfaces global.css defines — Mantine reads fixed indices out of
 * this tuple (0 = text, 2 = dimmed, 4 = border, 5 = hover, 7 = body), so the
 * order is load-bearing. Change a surface in global.css, change it here too.
 */
const dark: MantineColorsTuple = [
  '#e4ebf1', '#c3cfda', '#a9bac8', '#7d90a1', '#3a4e5f',
  '#21313f', '#182633', '#121e2a', '#0b1620', '#060e15',
];

const theme = createTheme({
  fontFamily: "Barlow, sans-serif",
  fontFamilyMonospace: "IBM Plex Mono, monospace",
  primaryColor: "primary",
  primaryShade: { light: 8, dark: 6 },
  black: "#0c2340",
  fontSizes: {
    xs: "11px",
    sm: "13px",
    md: "14px",
    lg: "16px",
    xl: "20px",
  },
  radius: {
    xs: "3px",
    sm: "4px",
    md: "8px",
    lg: "12px",
    xl: "16px",
  },
  defaultRadius: "sm",
  // Auto-flip label text to black/white on filled backgrounds that would
  // otherwise fail contrast — mostly badges over the mid palette shades.
  autoContrast: true,
  cursorType: "pointer",
  colors: {
    primary,
    secondary,
    neutral,
    alert,
    caution,
    success,
    dark,
    // Mantine resolves its own neutrals (default borders, `dimmed` text) out of
    // `gray`. Point it at the brand neutrals so Mantine chrome and the CSS
    // tokens are one palette rather than two that nearly match.
    gray: neutral,
  },
  components: {
    Text: Text.extend({
      defaultProps: { size: "sm" },
    }),
    Button: Button.extend({
      defaultProps: { color: "secondary", fw: 500 },
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
  </MantineProvider>
);
