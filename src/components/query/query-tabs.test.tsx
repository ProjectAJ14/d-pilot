// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../../store";
import type { QueryTab } from "../../types";
import { renderUi } from "../../utils/dom.testing";
import { QueryTabs } from "./query-tabs";

const tab = (id: string, extra: Partial<QueryTab> = {}) =>
  ({
    id,
    title: `Tab ${id}`,
    sql: "",
    connectionId: null,
    ...extra,
  }) as QueryTab;

beforeEach(() => {
  useStore.setState({
    tabs: [
      tab("1"),
      tab("2", { kind: "artifact" }),
      tab("3", { kind: "object", loading: true }),
      tab("4", { kind: "job" }),
    ],
    activeTabId: "1",
  });
});

const titles = () => useStore.getState().tabs.map((t) => t.title);
const kindIcon = (title: string, name: string) =>
  screen.getByText(title).parentElement!.querySelector(`.tabler-icon-${name}`);

describe("QueryTabs", () => {
  it("renders each tab with its kind icon and switches on click", async () => {
    renderUi(<QueryTabs />);
    expect(kindIcon("Tab 2", "file-text")).toBeTruthy();
    expect(kindIcon("Tab 3", "code")).toBeTruthy();
    expect(kindIcon("Tab 4", "clock")).toBeTruthy();
    expect(kindIcon("Tab 1", "file-text")).toBeNull();
    await userEvent.click(screen.getByText("Tab 3"));
    expect(useStore.getState().activeTabId).toBe("3");
  });

  it("adds and closes tabs", async () => {
    renderUi(<QueryTabs />);
    const closeBtn = screen
      .getByText("Tab 2")
      .parentElement!.querySelector("button")!;
    await userEvent.click(closeBtn);
    expect(titles()).not.toContain("Tab 2");
    // Closing doesn't also activate the closed tab.
    expect(useStore.getState().activeTabId).toBe("1");
    await userEvent.click(
      document.querySelector(".tabler-icon-plus")!.closest("button")!,
    );
    const { tabs, activeTabId } = useStore.getState();
    expect(tabs).toHaveLength(4);
    expect(activeTabId).toBe(tabs[3].id);
  });

  it("renames on double-click: Enter commits trimmed, blanks are ignored, Escape cancels", async () => {
    const user = userEvent.setup({ delay: null });
    renderUi(<QueryTabs />);
    await user.dblClick(screen.getByText("Tab 1"));
    const input = screen.getByDisplayValue("Tab 1");
    expect(document.activeElement).toBe(input);
    // Clicking inside the input doesn't re-select the tab.
    useStore.setState({ activeTabId: "2" });
    await user.click(input);
    expect(useStore.getState().activeTabId).toBe("2");
    await user.clear(input);
    await user.type(input, "  Orders  {Enter}");
    expect(titles()[0]).toBe("Orders");

    await user.dblClick(screen.getByText("Orders"));
    await user.clear(screen.getByDisplayValue("Orders"));
    await user.type(screen.getByDisplayValue(""), "   {Enter}");
    expect(titles()[0]).toBe("Orders");

    await user.dblClick(screen.getByText("Orders"));
    await user.type(screen.getByDisplayValue("Orders"), "x{Escape}");
    expect(screen.queryByDisplayValue("Ordersx")).toBeNull();
    expect(titles()[0]).toBe("Orders");

    await user.dblClick(screen.getByText("Orders"));
    await user.type(screen.getByDisplayValue("Orders"), "!");
    fireEvent.blur(screen.getByDisplayValue("Orders!"));
    expect(titles()[0]).toBe("Orders!");
  });

  it("context menu: rename, save (sql only) and close", async () => {
    const onSaveTab = vi.fn();
    const user = userEvent.setup({ delay: null });
    renderUi(<QueryTabs onSaveTab={onSaveTab} />);

    fireEvent.contextMenu(screen.getByText("Tab 4"), {
      clientX: 5,
      clientY: 6,
    });
    expect(useStore.getState().activeTabId).toBe("4");
    await screen.findByText("Rename");
    expect(screen.queryByText("Save query")).toBeNull();
    await user.click(screen.getByText("Close"));
    expect(titles()).not.toContain("Tab 4");

    fireEvent.contextMenu(screen.getByText("Tab 1"));
    await user.click(await screen.findByText("Save query"));
    expect(onSaveTab).toHaveBeenCalledTimes(1);

    fireEvent.contextMenu(screen.getByText("Tab 1"));
    await user.click(await screen.findByText("Rename"));
    expect(screen.getByDisplayValue("Tab 1")).toBeTruthy();
  });

  it("context menu tolerates its tab vanishing and a missing save handler", async () => {
    const user = userEvent.setup({ delay: null });
    renderUi(<QueryTabs />);
    fireEvent.contextMenu(screen.getByText("Tab 1"));
    await user.click(await screen.findByText("Save query"));

    fireEvent.contextMenu(screen.getByText("Tab 1"));
    await screen.findByText("Rename");
    useStore.setState({ tabs: [tab("9")], activeTabId: "9" });
    await user.click(screen.getByText("Rename"));
    expect(screen.queryByDisplayValue("Tab 1")).toBeNull();

    fireEvent.contextMenu(screen.getByText("Tab 9"));
    await screen.findByText("Close");
    useStore.setState({ tabs: [tab("8")], activeTabId: "8" });
    await user.click(screen.getByText("Close"));
    expect(titles()).toEqual(["Tab 8"]);

    // Escape closes the menu through onChange.
    fireEvent.contextMenu(screen.getByText("Tab 8"));
    await screen.findByText("Rename");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByText("Rename")).toBeNull());
  });
});
