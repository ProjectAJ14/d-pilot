// @vitest-environment jsdom
import { notifications } from "@mantine/notifications";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyToClipboard } from "./clipboard";

const show = vi.spyOn(notifications, "show").mockReturnValue("");
const hide = vi.spyOn(notifications, "hide").mockImplementation(() => "");
const exec = vi.fn();

beforeEach(() => {
  show.mockClear();
  hide.mockClear();
  exec.mockReset();
  document.execCommand = exec;
});
afterEach(() => vi.unstubAllGlobals());

const lastToast = () => show.mock.calls.at(-1)![0];
const flush = () => new Promise((r) => setTimeout(r, 0));

function stubClipboard(clipboard: unknown) {
  vi.stubGlobal("navigator", { ...navigator, clipboard });
}

describe("copyToClipboard", () => {
  it("uses the async API and confirms with a single, replaced toast", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard({ writeText });
    copyToClipboard("SELECT 1", "query");
    await flush();
    expect(writeText).toHaveBeenCalledWith("SELECT 1");
    expect(exec).not.toHaveBeenCalled();
    expect(hide).toHaveBeenCalledWith("clipboard-copy");
    expect(lastToast()).toMatchObject({
      id: "clipboard-copy",
      color: "teal",
      message: "Copied query: SELECT 1",
    });
  });

  it("quotes the preview, truncated past 60 chars, never the copied text", async () => {
    stubClipboard({ writeText: vi.fn().mockResolvedValue(undefined) });
    copyToClipboard("Basic c2VjcmV0", "auth", "x".repeat(70));
    await flush();
    expect(lastToast().message).toBe(`Copied auth: ${"x".repeat(60)}…`);
  });

  it("falls back to execCommand when the async API rejects", async () => {
    stubClipboard({ writeText: vi.fn().mockRejectedValue(new Error("no")) });
    exec.mockReturnValue(true);
    copyToClipboard("abc", "value");
    await flush();
    expect(exec).toHaveBeenCalledWith("copy");
    expect(lastToast().color).toBe("teal");
    // The hidden textarea is cleaned up.
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("reports failure when both paths fail", async () => {
    stubClipboard({ writeText: vi.fn().mockRejectedValue(new Error("no")) });
    exec.mockReturnValue(false);
    copyToClipboard("abc", "value");
    await flush();
    expect(lastToast()).toMatchObject({
      title: "Nothing was copied",
      color: "red",
    });
  });

  it("uses execCommand directly without the async API, and survives it throwing", () => {
    stubClipboard(undefined);
    exec.mockImplementation(() => {
      throw new Error("insecure");
    });
    copyToClipboard("abc", "value");
    expect(exec).toHaveBeenCalled();
    expect(lastToast().title).toBe("Nothing was copied");

    exec.mockReset().mockReturnValue(true);
    copyToClipboard("abc", "value");
    expect(lastToast().message).toBe("Copied value: abc");
  });
});
