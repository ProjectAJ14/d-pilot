// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installClipboardFallback } from "./clipboard-polyfill";

type Nav = { clipboard?: { writeText?: (t: string) => Promise<void> } };

afterEach(() => {
  vi.unstubAllGlobals();
  delete (navigator as Nav).clipboard;
  vi.restoreAllMocks();
});

/** jsdom has no execCommand; give it one that records what was selected. */
function stubExecCommand(result: boolean | (() => never)) {
  const seen: string[] = [];
  document.execCommand = vi.fn(() => {
    const ta = document.querySelector("textarea")!;
    seen.push(ta.value.slice(ta.selectionStart, ta.selectionEnd));
    if (typeof result === "function") result();
    return result as boolean;
  });
  return seen;
}

describe("installClipboardFallback", () => {
  it("leaves a native clipboard alone", () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    installClipboardFallback();
    expect((navigator as Nav).clipboard!.writeText).toBe(writeText);
  });

  it("adds a clipboard that copies via a temporary textarea", async () => {
    installClipboardFallback();
    const seen = stubExecCommand(true);
    await (navigator as Nav).clipboard!.writeText!("hello");
    expect(seen).toEqual(["hello"]);
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("restores the user's previous selection", async () => {
    document.body.innerHTML = "<p id='p'>keep me</p>";
    const range = document.createRange();
    range.selectNodeContents(document.getElementById("p")!);
    document.getSelection()!.addRange(range);
    installClipboardFallback();
    stubExecCommand(true);
    await (navigator as Nav).clipboard!.writeText!("x");
    expect(document.getSelection()!.toString()).toBe("keep me");
    document.body.innerHTML = "";
  });

  it("fills in writeText on a clipboard object that lacks it", async () => {
    const clip: Nav["clipboard"] = {};
    Object.defineProperty(navigator, "clipboard", {
      value: clip,
      configurable: true,
    });
    installClipboardFallback();
    expect(typeof clip.writeText).toBe("function");
    stubExecCommand(false);
    await expect(clip.writeText!("x")).rejects.toThrow(
      "Copy command was unsuccessful",
    );
  });

  it("rejects with an Error whatever execCommand throws", async () => {
    installClipboardFallback();
    stubExecCommand(() => {
      throw "boom";
    });
    await expect((navigator as Nav).clipboard!.writeText!("x")).rejects.toThrow(
      "boom",
    );
    stubExecCommand(() => {
      throw new TypeError("nope");
    });
    await expect(
      (navigator as Nav).clipboard!.writeText!("x"),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("gives up quietly when navigator.clipboard cannot be defined", () => {
    const frozen = Object.freeze({});
    vi.stubGlobal("navigator", frozen);
    expect(() => installClipboardFallback()).not.toThrow();
    expect((frozen as Nav).clipboard).toBeUndefined();
  });

  it("does nothing without a DOM", () => {
    vi.stubGlobal("document", undefined);
    installClipboardFallback();
    expect((navigator as Nav).clipboard).toBeUndefined();
  });
});
