import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import { MantineProvider, createTheme, Text, Button, TextInput, type MantineColorsTuple } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/fonts.css";
import "./styles/global.css";

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

const theme = createTheme({
  fontFamily: "Barlow, sans-serif",
  fontFamilyMonospace: "IBM Plex Mono, monospace",
  primaryColor: "primary",
  primaryShade: 8,
  black: "#0c2340",
  fontSizes: {
    xs: "12px",
    sm: "16px",
  },
  colors: {
    primary,
    secondary,
    neutral,
    alert,
    caution,
    success,
  },
  components: {
    Text: Text.extend({
      defaultProps: { size: "sm" },
    }),
    Button: Button.extend({
      defaultProps: { color: "secondary.9", fw: 500 },
    }),
    TextInput: TextInput.extend({
      styles: () => ({ input: { borderColor: "#BEC3C6" } }),
    }),
  },
});

createRoot(document.getElementById("root")!).render(
  <MantineProvider theme={theme} defaultColorScheme="light">
    <Notifications position="bottom-right" />
    <App />
  </MantineProvider>
);
