import { useCallback, useEffect, useRef, useState } from "react";
import type { editor as MonacoEditor } from "monaco-editor";
import { useStore } from "../store";

/** What `initVimMode` hands back — we only ever need to tear it down. */
interface VimAdapter {
  dispose(): void;
}

/**
 * Make Escape dismiss the suggestion popup *without* also leaving insert mode.
 *
 * monaco-vim deliberately processes Escape even when another handler already
 * consumed it — its `handleKeyDown` exempts Escape from the `defaultPrevented`
 * bail-out. So with the suggest widget open a single Esc did two things at
 * once: Monaco closed the popup and monaco-vim dropped you into normal mode.
 *
 * We intercept on the editor container in the *capture* phase, which runs
 * before Monaco's own keydown handler on the inner text area — and that
 * handler is what feeds monaco-vim's `onKeyDown`. Stopping the event there
 * means vim never sees the key, so we close the widget ourselves.
 *
 * Scoped to this editor's DOM node (Monaco renders the widget inside it), so
 * the three editors never interfere with each other.
 */
function keepInsertModeOnSuggestEscape(
  editor: MonacoEditor.IStandaloneCodeEditor,
): () => void {
  const domNode = editor.getDomNode();
  if (!domNode) return () => {};

  const onKeyDownCapture = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    if (!domNode.querySelector(".suggest-widget.visible")) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    editor.trigger("vim-mode", "hideSuggestWidget", null);
  };

  domNode.addEventListener("keydown", onKeyDownCapture, true);
  return () => domNode.removeEventListener("keydown", onKeyDownCapture, true);
}

/**
 * Opt-in vim keybindings for a Monaco editor, driven by the `viModeEnabled`
 * store flag (Settings → User Interface). Attaches on mount, detaches on
 * unmount, and re-attaches when the setting is toggled.
 *
 * There is no status bar: mode is communicated by the cursor alone, which
 * monaco-vim handles for us (a solid block in normal/visual, a thin blinking
 * line in insert — see its `enterVimMode`/`leaveVimMode`). Disposal restores
 * the normal cursor.
 *
 * Trade-off of running without a status-bar node: monaco-vim's `openDialog`
 * returns early when there is no status bar, so `:` Ex commands and `/` search
 * are inert. Motions, operators, registers and undo are unaffected.
 *
 * Usage:
 *   const vim = useVimMode();
 *   <Editor onMount={vim.attachEditor} … />
 */
export function useVimMode() {
  const enabled = useStore((s) => s.viModeEnabled);
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  // Monaco mounts asynchronously; this re-runs the effect once it exists.
  const [editorMounted, setEditorMounted] = useState(false);

  const attachEditor = useCallback(
    (editor: MonacoEditor.IStandaloneCodeEditor) => {
      editorRef.current = editor;
      setEditorMounted(true);
    },
    [],
  );

  useEffect(() => {
    if (!enabled || !editorMounted) return;

    let adapter: VimAdapter | null = null;
    let releaseEscapeFix: (() => void) | null = null;
    let cancelled = false;

    // Loaded lazily so users who never turn vi mode on don't pay for it.
    void import("monaco-vim").then(({ initVimMode }) => {
      const editor = editorRef.current;
      if (cancelled || !editor) return;
      adapter = initVimMode(editor) as unknown as VimAdapter;
      releaseEscapeFix = keepInsertModeOnSuggestEscape(editor);
    });

    return () => {
      cancelled = true;
      releaseEscapeFix?.();
      adapter?.dispose();
    };
  }, [enabled, editorMounted]);

  return { attachEditor };
}
