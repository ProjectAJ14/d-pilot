// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderUi } from "../../utils/dom.testing";
import { CellDetailDrawer, type CellDetail } from "./cell-detail-drawer";

const editorProps: Record<string, unknown>[] = [];
vi.mock("@monaco-editor/react", () => ({
  default: (props: Record<string, unknown>) => {
    editorProps.push(props);
    return <pre data-testid="editor">{props.value as string}</pre>;
  },
}));

const jsonViewerLink = vi.fn();
vi.mock("../../utils/json-viewer-link", () => ({
  jsonViewerLink: (t: string) => jsonViewerLink(t),
}));

const last = () => editorProps[editorProps.length - 1];
const show = (detail: CellDetail | null) =>
  renderUi(<CellDetailDrawer detail={detail} onClose={() => {}} />);

beforeEach(() => {
  editorProps.length = 0;
  jsonViewerLink.mockReset();
  jsonViewerLink.mockResolvedValue({
    url: "https://viewer.example/#x",
    needsClipboard: false,
  });
  document.execCommand = vi.fn(() => true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CellDetailDrawer content", () => {
  it("renders nothing when closed", () => {
    show(null);
    expect(screen.queryByTestId("editor")).toBeNull();
  });

  it("pretty-prints an object as JSON with a viewer link", async () => {
    show({ column: "payload", value: { a: 1 }, isMasked: false });
    expect(await screen.findByText("JSON")).toBeTruthy();
    expect(last().language).toBe("json");
    expect(last().value).toBe('{\n  "a": 1\n}');
    const link = await screen.findByText("Open in viewer");
    expect(link.closest("a")!.getAttribute("href")).toBe(
      "https://viewer.example/#x",
    );
    expect(jsonViewerLink).toHaveBeenCalledWith('{\n  "a": 1\n}');
  });

  it("parses JSON-looking strings, and leaves invalid or scalar JSON as text", async () => {
    const { unmount } = show({
      column: "c",
      value: " [1, 2] ",
      isMasked: false,
    });
    expect(await screen.findByText("JSON")).toBeTruthy();
    unmount();

    for (const value of ["{not json", "plain", 42, undefined]) {
      const r = show({ column: "c", value, isMasked: false });
      expect(await screen.findByText("text")).toBeTruthy();
      expect(last().language).toBe("plaintext");
      r.unmount();
    }
    expect(editorProps.map((p) => p.value).slice(-4)).toEqual([
      "{not json",
      "plain",
      "42",
      "NULL",
    ]);
    expect(jsonViewerLink).toHaveBeenCalledTimes(1);
  });

  it("treats a string that parses to null as text", async () => {
    show({ column: "c", value: "[", isMasked: true });
    expect(await screen.findByText("PHI masked")).toBeTruthy();
    expect(screen.getByText("1 chars")).toBeTruthy();
  });

  it("ignores a viewer link that resolves after the drawer moved on", async () => {
    let resolve!: (v: unknown) => void;
    jsonViewerLink.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const r = show({ column: "c", value: { a: 1 }, isMasked: false });
    await screen.findByText("JSON");
    r.unmount();
    resolve({ url: "u", needsClipboard: false });
    await Promise.resolve();
    expect(screen.queryByText("Open in viewer")).toBeNull();
  });

  it("swallows a failed viewer link", async () => {
    jsonViewerLink.mockRejectedValueOnce(new Error("no compression"));
    show({ column: "c", value: { a: 1 }, isMasked: false });
    await screen.findByText("JSON");
    await Promise.resolve();
    expect(screen.queryByText("Open in viewer")).toBeNull();
  });
});

describe("CellDetailDrawer copying", () => {
  it("copies through the async clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    show({ column: "c", value: "hello", isMasked: false });
    fireEvent.click(await screen.findByText("Copy"));
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(await screen.findAllByText("Copied to clipboard")).not.toHaveLength(
      0,
    );
    expect(document.execCommand).not.toHaveBeenCalled();
  });

  it("falls back to execCommand when the clipboard write rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("not focused"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    show({ column: "c", value: "hello", isMasked: false });
    fireEvent.click(await screen.findByText("Copy"));
    await waitFor(() =>
      expect(document.execCommand).toHaveBeenCalledWith("copy"),
    );
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("falls back to execCommand without a clipboard API", async () => {
    vi.stubGlobal("navigator", {});
    show({ column: "c", value: "hello", isMasked: false });
    fireEvent.click(await screen.findByText("Copy"));
    expect(document.execCommand).toHaveBeenCalledWith("copy");
    expect(await screen.findAllByText("Copied to clipboard")).not.toHaveLength(
      0,
    );
  });

  it("copies the JSON when the viewer reads it from the clipboard", async () => {
    vi.stubGlobal("navigator", {});
    jsonViewerLink.mockResolvedValue({ url: "u", needsClipboard: true });
    show({ column: "c", value: [1], isMasked: false });
    const link = await screen.findByText("Open in viewer");
    fireEvent.click(link);
    expect(document.execCommand).toHaveBeenCalledWith("copy");
  });
});
