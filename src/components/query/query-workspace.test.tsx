// @vitest-environment jsdom
import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../../store";
import type { QueryTab } from "../../types";
import { renderUi } from "../../utils/dom.testing";
import { QueryWorkspace } from "./query-workspace";

vi.mock("./query-tabs", () => ({
  QueryTabs: ({ onSaveTab }: { onSaveTab: () => void }) => (
    <button onClick={onSaveTab}>save-tab</button>
  ),
}));
vi.mock("./query-editor", () => ({
  QueryEditor: (p: {
    tab: QueryTab;
    saveSignal: number;
    height: number;
    expanded: boolean;
    onToggleHeight: () => void;
  }) => (
    <div data-testid="editor">
      {`${p.tab.id}|save=${p.saveSignal}|h=${p.height}|expanded=${p.expanded}`}
      <button onClick={p.onToggleHeight}>toggle</button>
    </div>
  ),
}));
vi.mock("./artifact-view", () => ({
  ArtifactView: ({ tab }: { tab: QueryTab }) => <div>artifact:{tab.id}</div>,
}));
vi.mock("./object-view", () => ({
  ObjectView: ({ tab }: { tab: QueryTab }) => <div>object:{tab.id}</div>,
}));
vi.mock("./job-view", () => ({
  JobView: ({ tab }: { tab: QueryTab }) => <div>job:{tab.id}</div>,
}));
vi.mock("./results-grid", () => ({
  ResultsGrid: ({ tab }: { tab: QueryTab }) => <div>results:{tab.id}</div>,
}));
vi.mock("./ai-assistant-panel", () => ({
  AiAssistantPanel: () => <div>ai-panel</div>,
}));

const show = (tab: Partial<QueryTab>) =>
  useStore.setState({
    tabs: [{ id: "t", title: "T", sql: "", ...tab } as QueryTab],
    activeTabId: "t",
  });

const editor = () => screen.getByTestId("editor").textContent;

beforeEach(() => {
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
});

describe("QueryWorkspace", () => {
  it.each([
    ["artifact", "artifact:t"],
    ["object", "object:t"],
    ["job", "job:t"],
  ] as const)("renders the %s view without the editor", (kind, text) => {
    show({ kind });
    renderUi(<QueryWorkspace />);
    expect(screen.getByText(text)).toBeTruthy();
    expect(screen.queryByTestId("editor")).toBeNull();
    expect(screen.getByText("ai-panel")).toBeTruthy();
  });

  it("renders nothing but tabs and AI with no active tab", () => {
    useStore.setState({ tabs: [], activeTabId: "" });
    renderUi(<QueryWorkspace />);
    expect(screen.queryByTestId("editor")).toBeNull();
    expect(screen.getByText("ai-panel")).toBeTruthy();
  });

  it("treats a tab without a kind as SQL: editor, handle and results", () => {
    show({});
    renderUi(<QueryWorkspace />);
    expect(editor()).toContain("t|save=0|h=150|expanded=false");
    expect(screen.getByText("results:t")).toBeTruthy();
  });

  it("bumps the save signal on each tab-menu save", () => {
    show({ kind: "sql" });
    renderUi(<QueryWorkspace />);
    fireEvent.click(screen.getByText("save-tab"));
    fireEvent.click(screen.getByText("save-tab"));
    expect(editor()).toContain("save=2");
  });

  it("toggles between compact and expanded heights", () => {
    show({});
    renderUi(<QueryWorkspace />);
    fireEvent.click(screen.getByText("toggle"));
    expect(editor()).toContain("h=400|expanded=true");
    fireEvent.click(screen.getByText("toggle"));
    expect(editor()).toContain("h=150|expanded=false");
  });

  it("drags the handle, clamped between the minimum and 70% of the container", () => {
    show({});
    const { container } = renderUi(<QueryWorkspace />);
    const root = screen.getByText("save-tab").parentElement!;
    root.getBoundingClientRect = () => ({ height: 1000 }) as DOMRect;
    const handle = screen.getByTestId("editor").nextElementSibling!;
    expect(container.contains(handle)).toBe(true);

    // Moving without a drag in progress does nothing.
    fireEvent.mouseMove(document, { clientY: 500 });
    fireEvent.mouseUp(document);
    expect(editor()).toContain("h=150");

    fireEvent.mouseDown(handle, { clientY: 100 });
    expect(document.body.style.cursor).toBe("row-resize");
    expect(document.body.style.userSelect).toBe("none");
    fireEvent.mouseMove(document, { clientY: 200 });
    expect(editor()).toContain("h=250|expanded=true");
    fireEvent.mouseMove(document, { clientY: 5000 });
    expect(editor()).toContain("h=700");
    fireEvent.mouseMove(document, { clientY: -5000 });
    expect(editor()).toContain("h=100");
    fireEvent.mouseUp(document);
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
    fireEvent.mouseMove(document, { clientY: 400 });
    expect(editor()).toContain("h=100");
  });

  it("highlights the drag knob on hover", () => {
    show({});
    renderUi(<QueryWorkspace />);
    const knob = screen.getByTestId("editor").nextElementSibling!
      .firstElementChild as HTMLElement;
    fireEvent.mouseEnter(knob);
    expect(knob.style.background).toBe("var(--accent)");
    fireEvent.mouseLeave(knob);
    expect(knob.style.background).toBe("var(--border2)");
  });
});
