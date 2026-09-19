import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import { readGround, bare, withAlpha, type Ground } from "./theme-tokens";

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
 * Monaco does not read CSS variables — it parses these colours once, at
 * `defineTheme()` time — so it is the one surface in the app that needs the
 * design system's values as literals. Rather than keep a copy of the palette
 * here (which is what used to drift), read the resolved values back out of
 * `styles/tokens.css` through a probe element. Both grounds are defined up
 * front, so flipping the colour scheme just switches which theme name the
 * editors ask for; nothing is redefined.
 *
 * This means `styles/global.css` must already be in the document when this
 * module is evaluated — see the import order in `main.tsx`.
 *
 * `editor.background` deliberately uses --surface (the raised panel), not --bg,
 * because the editor sits on a panel.
 */
const THEME_TOKENS = [
  "--surface",
  "--surface2",
  "--surface3",
  "--text",
  "--muted",
  "--muted2",
  "--border",
  "--border2",
  "--accent-text",
  "--success",
  "--type-special",
  "--info",
] as const;

function defineEditorTheme(name: string, ground: Ground) {
  const t = readGround(ground, THEME_TOKENS);
  monaco.editor.defineTheme(name, {
    base: ground === "dark" ? "vs-dark" : "vs",
    inherit: true,
    rules: [
      {
        token: "keyword",
        foreground: bare(t["--accent-text"]),
        fontStyle: "bold",
      },
      { token: "string", foreground: bare(t["--success"]) },
      { token: "number", foreground: bare(t["--type-special"]) },
      { token: "comment", foreground: bare(t["--muted"]), fontStyle: "italic" },
      { token: "operator", foreground: bare(t["--muted2"]) },
      { token: "predefined", foreground: bare(t["--info"]) },
    ],
    colors: {
      "editor.background": t["--surface"],
      "editor.foreground": t["--text"],
      "editorLineNumber.foreground": t["--border2"],
      "editorLineNumber.activeForeground": t["--accent-text"],
      "editorGutter.background": t["--surface"],
      "editor.lineHighlightBackground": t["--surface2"],
      "editor.selectionBackground": withAlpha(t["--accent-text"], 0.18),
      "editorCursor.foreground": t["--accent-text"],
      "editorIndentGuide.background1": t["--border"],
      "editorWidget.background": t["--surface"],
      "editorWidget.border": t["--border"],
      "editorSuggestWidget.background": t["--surface"],
      "editorSuggestWidget.border": t["--border"],
      "editorSuggestWidget.selectedBackground": t["--surface3"],
    },
  });
}

defineEditorTheme("d-pilot-light", "light");
defineEditorTheme("d-pilot-dark", "dark");

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
