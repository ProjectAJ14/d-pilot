import { useComputedColorScheme } from "@mantine/core";
import type { editor } from "monaco-editor";

/**
 * Shared Monaco options for the app's editable SQL editors (the read/query
 * editor and the write-composer's write + verify-SELECT editors) so they stay
 * visually and behaviorally in sync. Notably `renderLineHighlight: "gutter"`
 * — the default "line" draws a border box around the active line, which is the
 * stray horizontal lines that otherwise show up only in the write composer.
 */
export const baseSqlEditorOptions: editor.IStandaloneEditorConstructionOptions =
  {
    minimap: { enabled: false },
    fontSize: 13,
    fontFamily: "IBM Plex Mono, monospace",
    lineNumbers: "on",
    scrollBeyondLastLine: false,
    padding: { top: 10, bottom: 10 },
    renderLineHighlight: "gutter",
    automaticLayout: true,
    tabSize: 2,
    wordWrap: "on",
    overviewRulerBorder: false,
    hideCursorInOverviewRuler: true,
    quickSuggestions: {
      other: true,
      comments: false,
      strings: true,
    },
    suggestOnTriggerCharacters: true,
    wordBasedSuggestions: "off",
    acceptSuggestionOnEnter: "on",
    suggest: {
      // Must be true: our SQL keyword completions use CompletionItemKind.Keyword;
      // when false, Monaco hides them and only schema (table/column) items appear.
      showKeywords: true,
      showWords: false,
      preview: true,
      showIcons: true,
      filterGraceful: true,
      snippetsPreventQuickSuggestions: false,
    },
  };

/**
 * The Monaco theme matching the current color scheme.
 *
 * Monaco's theme is global to the Monaco instance, but every <Editor> sets it
 * on mount from its `theme` prop — so the prop has to be passed at each call
 * site rather than set once, or whichever editor mounts last wins. The themes
 * themselves are registered in `monaco-setup.ts`.
 *
 * `useComputedColorScheme` resolves `auto` down to light/dark; Monaco has no
 * concept of following the system.
 */
export function useEditorTheme(): "d-pilot-light" | "d-pilot-dark" {
  return useComputedColorScheme("light") === "dark"
    ? "d-pilot-dark"
    : "d-pilot-light";
}
