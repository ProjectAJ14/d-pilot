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
