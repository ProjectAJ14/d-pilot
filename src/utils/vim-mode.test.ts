// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { editor as MonacoEditor } from "monaco-editor";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import { useVimMode } from "./vim-mode";

const dispose = vi.fn();
const initVimMode = vi.fn((_editor: unknown) => ({ dispose }));
vi.mock("monaco-vim", () => ({
  initVimMode: (e: unknown) => initVimMode(e),
}));

function fakeEditor(domNode: HTMLElement | null) {
  const trigger = vi.fn();
  const editor = {
    getDomNode: () => domNode,
    trigger,
  } as unknown as MonacoEditor.IStandaloneCodeEditor;
  return { editor, trigger };
}

function escape(target: HTMLElement, key = "Escape") {
  const e = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(e);
  return e;
}

beforeEach(() => {
  dispose.mockClear();
  initVimMode.mockClear();
  useStore.setState({ viModeEnabled: true });
});

afterEach(() => {
  cleanup();
  useStore.setState({ viModeEnabled: false });
  document.body.innerHTML = "";
});

describe("useVimMode", () => {
  it("does nothing while vi mode is off", async () => {
    useStore.setState({ viModeEnabled: false });
    const { result } = renderHook(useVimMode);
    act(() => result.current.attachEditor(fakeEditor(null).editor));
    await new Promise((r) => setTimeout(r, 0));
    expect(initVimMode).not.toHaveBeenCalled();
  });

  it("attaches on mount, and Escape closes an open suggest widget without reaching vim", async () => {
    const dom = document.createElement("div");
    const textarea = document.createElement("textarea");
    dom.appendChild(textarea);
    document.body.appendChild(dom);
    const { editor, trigger } = fakeEditor(dom);
    const inner = vi.fn();
    textarea.addEventListener("keydown", inner);

    const { result, unmount } = renderHook(useVimMode);
    act(() => result.current.attachEditor(editor));
    await waitFor(() => expect(initVimMode).toHaveBeenCalledWith(editor));

    // No widget open → Escape goes through to vim.
    expect(escape(textarea).defaultPrevented).toBe(false);
    // A non-Escape key always goes through.
    escape(textarea, "j");
    expect(inner).toHaveBeenCalledTimes(2);

    const widget = document.createElement("div");
    widget.className = "suggest-widget visible";
    dom.appendChild(widget);
    expect(escape(textarea).defaultPrevented).toBe(true);
    expect(inner).toHaveBeenCalledTimes(2);
    expect(trigger).toHaveBeenCalledWith("vim-mode", "hideSuggestWidget", null);

    unmount();
    expect(dispose).toHaveBeenCalledTimes(1);
    // Listener released: Escape now reaches the inner handler.
    escape(textarea);
    expect(inner).toHaveBeenCalledTimes(3);
  });

  it("detaches when the setting is turned off", async () => {
    const { result } = renderHook(useVimMode);
    act(() => result.current.attachEditor(fakeEditor(null).editor));
    await waitFor(() => expect(initVimMode).toHaveBeenCalledTimes(1));
    act(() => useStore.setState({ viModeEnabled: false }));
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("skips init if unmounted before monaco-vim loads", async () => {
    const { result, unmount } = renderHook(useVimMode);
    act(() => result.current.attachEditor(fakeEditor(null).editor));
    unmount();
    await import("monaco-vim");
    await new Promise((r) => setTimeout(r, 0));
    expect(initVimMode).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
  });
});
