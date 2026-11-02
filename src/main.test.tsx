// @vitest-environment jsdom
import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "./utils/dom.testing";

const m = vi.hoisted(() => ({
  render: vi.fn(),
  createRoot: vi.fn(),
  installClipboardFallback: vi.fn(),
}));
vi.mock("react-dom/client", () => ({
  createRoot: (el: Element) => {
    m.createRoot(el);
    return { render: m.render };
  },
}));
vi.mock("./utils/clipboard-polyfill", () => ({
  installClipboardFallback: m.installClipboardFallback,
}));
vi.mock("./utils/monaco-setup", () => ({}));
vi.mock("./styles/fonts.css", () => ({}));
vi.mock("./styles/global.css", () => ({}));
vi.mock("./App", async () => {
  const core = await import("@mantine/core");
  return {
    default: () => (
      <>
        <core.Title>Saved queries</core.Title>
        <core.Text>body</core.Text>
        <core.Button>Run</core.Button>
        <core.Button variant="default">Cancel</core.Button>
        <core.Badge>PROD</core.Badge>
        <core.Code>select 1</core.Code>
        <core.Kbd>Ctrl</core.Kbd>
        <core.SegmentedControl data={["grid", "json"]} />
        <core.TextInput aria-label="filter" />
        <core.ScrollArea>rows</core.ScrollArea>
        <core.Avatar />
        <core.Loader />
      </>
    ),
  };
});

describe("main", () => {
  it("mounts the themed app into #root behind the crash screen", async () => {
    const root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
    await import("./main");

    expect(m.installClipboardFallback).toHaveBeenCalled();
    expect(m.createRoot).toHaveBeenCalledWith(root);
    const tree = m.render.mock.calls[0][0] as ReactElement;
    const view = render(tree);

    // Filled buttons take their ink from the --on-fill token; other variants keep Mantine's.
    const run = view.getByRole("button", { name: "Run" });
    expect(run.getAttribute("style")).toContain(
      "--button-color: var(--on-fill)",
    );
    const cancel = view.getByRole("button", { name: "Cancel" });
    expect(cancel.getAttribute("style") ?? "").not.toContain("var(--on-fill)");
    expect(view.getByText("PROD")).toBeTruthy();
    expect(view.getByText("select 1")).toBeTruthy();
  });
});
