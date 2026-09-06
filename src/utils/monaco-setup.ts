import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

/**
 * Point @monaco-editor/react at the *bundled* Monaco instead of its default
 * jsdelivr CDN build.
 *
 * Two reasons this matters:
 *  1. `monaco-vim` imports `monaco-editor/esm/...` at runtime. With the CDN
 *     default the app would end up with TWO Monaco instances — vim's bundled
 *     copy and the CDN copy the user actually types in — so commands vim
 *     constructs (notably ShiftCommand, behind the `>>` / `<<` operators) would
 *     be executed against a foreign instance.
 *  2. The editor no longer needs to reach the public internet at load time,
 *     which matters for restricted/air-gapped deployments.
 *
 * Must be imported before the first <Editor> renders.
 */

declare global {
  var MonacoEnvironment: monaco.Environment | undefined;
}

/**
 * Editor themes.
 *
 * Monaco is a canvas-ish surface with its own token colors — it does not read
 * the app's CSS variables, so without these it renders its built-in `vs` light
 * theme regardless of the color scheme, i.e. a white editor inside a dark app.
 * Colors mirror `src/styles/global.css`; keep them in step.
 *
 * `editor.background` deliberately uses --surface (the raised panel), not --bg,
 * because the editor sits on a panel.
 */
monaco.editor.defineTheme("d-pilot-light", {
  base: "vs",
  inherit: true,
  rules: [
    { token: "keyword", foreground: "1b7c81", fontStyle: "bold" },
    { token: "string", foreground: "2e7d32" },
    { token: "number", foreground: "7c3aed" },
    { token: "comment", foreground: "667281", fontStyle: "italic" },
    { token: "operator", foreground: "576e75" },
    { token: "predefined", foreground: "1e579e" },
  ],
  colors: {
    "editor.background": "#ffffff",
    "editor.foreground": "#0c2340",
    "editorLineNumber.foreground": "#878f97",
    "editorLineNumber.activeForeground": "#1b7c81",
    "editorGutter.background": "#ffffff",
    "editor.lineHighlightBackground": "#f3f6f7",
    "editor.selectionBackground": "#1f919629",
    "editorCursor.foreground": "#1b7c81",
    "editorIndentGuide.background1": "#e8e8e8",
    "editorWidget.background": "#ffffff",
    "editorWidget.border": "#ccd0d2",
    "editorSuggestWidget.background": "#ffffff",
    "editorSuggestWidget.border": "#ccd0d2",
    "editorSuggestWidget.selectedBackground": "#f3f6f7",
  },
});

monaco.editor.defineTheme("d-pilot-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "keyword", foreground: "43d0d6", fontStyle: "bold" },
    { token: "string", foreground: "9fd49f" },
    { token: "number", foreground: "b48cff" },
    { token: "comment", foreground: "7d90a1", fontStyle: "italic" },
    { token: "operator", foreground: "a9bac8" },
    { token: "predefined", foreground: "8ab7ed" },
  ],
  colors: {
    "editor.background": "#121e2a",
    "editor.foreground": "#e4ebf1",
    "editorLineNumber.foreground": "#3a4e5f",
    "editorLineNumber.activeForeground": "#43d0d6",
    "editorGutter.background": "#121e2a",
    "editor.lineHighlightBackground": "#182633",
    "editor.selectionBackground": "#43d0d62e",
    "editorCursor.foreground": "#43d0d6",
    "editorIndentGuide.background1": "#21313f",
    "editorWidget.background": "#182633",
    "editorWidget.border": "#2a3b4a",
    "editorSuggestWidget.background": "#182633",
    "editorSuggestWidget.border": "#2a3b4a",
    "editorSuggestWidget.selectedBackground": "#21313f",
  },
});

// Language services run in web workers. Only `typescript`/`javascript` is
// actually needed beyond the core (the Mongo shell editor uses the JS grammar,
// and its "Format" button routes through the TS worker) — SQL and plaintext
// need no language worker of their own.
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === "typescript" || label === "javascript") return new tsWorker();
    return new editorWorker();
  },
};

loader.config({ monaco });
