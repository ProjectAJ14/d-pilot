// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { notifications } from "@mantine/notifications";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderUi } from "../../utils/dom.testing";
import { useStore } from "../../store";
import { api } from "../../utils/api-client";
import { AiAssistantPanel } from "./ai-assistant-panel";
import type { QueryTab } from "../../types";

vi.mock("../../utils/api-client", async (orig) => ({
  ...(await orig<typeof import("../../utils/api-client")>()),
  api: { generateQuery: vi.fn() },
}));
const generateQuery = vi.mocked(api.generateQuery);

const conn = {
  id: "c1",
  name: "app_core",
  env: "QA",
  type: "postgres" as const,
};

const tab = (over: Partial<QueryTab> = {}): QueryTab => ({
  id: "t1",
  title: "Query 1",
  sql: "",
  connectionId: "c1",
  result: null,
  loading: false,
  error: null,
  ...over,
});

const result = (over = {}) => ({
  query: "SELECT * FROM orders",
  explanation: "All orders",
  schemaTruncated: false,
  tablesProvided: 1,
  totalTables: 1,
  ...over,
});

const initial = useStore.getState();
const originalClipboard = navigator.clipboard;

beforeEach(() => {
  Element.prototype.scrollTo = vi.fn();
  document.execCommand = vi.fn(() => true);
  useStore.setState({
    aiAssistantOpen: true,
    tabs: [tab()],
    activeTabId: "t1",
    connections: [conn],
    user: null,
    writeHandoff: null,
  });
});

afterEach(() => {
  notifications.clean();
  useStore.setState(initial, true);
  generateQuery.mockReset();
  Object.defineProperty(navigator, "clipboard", {
    value: originalClipboard,
    configurable: true,
  });
});

const box = () =>
  screen.getByPlaceholderText(/Ask in plain English|Describe the change/);
const type = (text: string) =>
  fireEvent.change(box(), { target: { value: text } });
const send = () => fireEvent.keyDown(box(), { key: "Enter", metaKey: true });

describe("AiAssistantPanel", () => {
  it("renders nothing while closed and closes from the drawer button", async () => {
    useStore.setState({ aiAssistantOpen: false });
    renderUi(<AiAssistantPanel />);
    expect(screen.queryByText("AI Query Assistant")).toBeNull();
    act(() => useStore.setState({ aiAssistantOpen: true }));
    await screen.findByText("AI Query Assistant");
    fireEvent.click(document.querySelector(".mantine-Drawer-close")!);
    expect(useStore.getState().aiAssistantOpen).toBe(false);
  });

  it("generates a read query with its context and applies it to the tab", async () => {
    useStore.setState({
      tabs: [tab({ sql: "SELECT 1", schema: "app_core" })],
    });
    generateQuery.mockResolvedValue(
      result({
        model: "gpt-x",
        schemaTruncated: true,
        tablesProvided: 5,
        totalTables: 40,
        relevantSelection: true,
        schemaCached: true,
        examplesUsed: 2,
      }),
    );
    renderUi(<AiAssistantPanel />);
    expect(await screen.findByText("app_core")).toBeTruthy();
    expect(screen.getByText("Describe the data you want")).toBeTruthy();
    // Read-only users get no mode switch.
    expect(screen.queryByText("Write query")).toBeNull();

    type("  recent orders  ");
    // Not a submit shortcut: no request.
    fireEvent.keyDown(box(), { key: "a", metaKey: true });
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(generateQuery).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));

    expect(await screen.findByText("SELECT * FROM orders")).toBeTruthy();
    expect(generateQuery).toHaveBeenCalledWith({
      connectionId: "c1",
      prompt: "recent orders",
      currentQuery: "SELECT 1",
      refreshSchema: false,
      mode: "read",
      schema: "app_core",
    });
    expect(screen.getByText("recent orders")).toBeTruthy();
    expect(screen.getByText("All orders")).toBeTruthy();
    expect(
      screen.getByText(
        "gpt-x · schema: 5/40 tables relevant, cached · 2 examples",
      ),
    ).toBeTruthy();
    expect((box() as HTMLTextAreaElement).value).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Append" }));
    expect(useStore.getState().tabs[0].sql).toBe(
      "SELECT 1\n\nSELECT * FROM orders",
    );
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    expect(useStore.getState().tabs[0].sql).toBe("SELECT * FROM orders");
  });

  it("formats sparse metadata and appends into an empty tab", async () => {
    generateQuery
      .mockResolvedValueOnce(
        result({
          schemaTruncated: true,
          tablesProvided: 3,
          totalTables: 9,
          schemaCached: false,
          examplesUsed: 1,
          explanation: "",
        }),
      )
      .mockResolvedValueOnce(result({ query: "SELECT 2" }));
    renderUi(<AiAssistantPanel />);
    type("x");
    send();
    expect(
      await screen.findByText("schema: 3/9 tables, fresh · 1 example"),
    ).toBeTruthy();
    expect(screen.queryByText("All orders")).toBeNull();

    // No meta at all: nothing printed under the second answer.
    type("y");
    fireEvent.keyDown(box(), { key: "Enter", ctrlKey: true });
    await screen.findByText("SELECT 2");

    fireEvent.click(screen.getAllByRole("button", { name: "Append" })[1]);
    expect(useStore.getState().tabs[0].sql).toBe("SELECT 2");
    act(() =>
      useStore.setState({
        tabs: [tab({ sql: undefined as unknown as string })],
      }),
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Append" })[1]);
    expect(useStore.getState().tabs[0].sql).toBe("SELECT 2");
  });

  it("shows a failure and the loading state, ignoring sends while busy", async () => {
    let fail!: (e: Error) => void;
    generateQuery.mockReturnValue(
      new Promise((_, rej) => {
        fail = rej;
      }),
    );
    renderUi(<AiAssistantPanel />);
    type("orders");
    send();
    expect(await screen.findByText("Generating query…")).toBeTruthy();
    type("again");
    send();
    expect(generateQuery).toHaveBeenCalledTimes(1);
    await act(async () => fail(new Error("quota exceeded")));
    expect(await screen.findByText("Generation failed")).toBeTruthy();
    expect(screen.getByText("quota exceeded")).toBeTruthy();
    expect(screen.queryByText("Generating query…")).toBeNull();
  });

  it("arms a one-shot schema refresh", async () => {
    generateQuery.mockResolvedValue(result());
    renderUi(<AiAssistantPanel />);
    await screen.findByText("app_core");
    const refresh = document
      .querySelector(".tabler-icon-refresh")!
      .closest("button")!;
    fireEvent.click(refresh);
    fireEvent.click(refresh);
    fireEvent.click(refresh);
    type("orders");
    send();
    await screen.findByText("SELECT * FROM orders");
    expect(generateQuery.mock.calls[0][0].refreshSchema).toBe(true);
    type("more");
    send();
    await waitFor(() => expect(generateQuery).toHaveBeenCalledTimes(2));
    expect(generateQuery.mock.calls[1][0].refreshSchema).toBe(false);
  });

  it("drafts a write request and hands it to the write composer", async () => {
    useStore.setState({
      user: { canWrite: true } as ReturnType<typeof useStore.getState>["user"],
    });
    generateQuery.mockResolvedValue(
      result({ query: "UPDATE orders SET status = 'x'" }),
    );
    renderUi(
      <>
        <AiAssistantPanel />
        <Routes>
          <Route path="/" element={null} />
          <Route path="/write" element={<div>write page</div>} />
        </Routes>
      </>,
    );
    fireEvent.click(await screen.findByText("Write query"));
    expect(screen.getByText("Drafts a change → approval")).toBeTruthy();
    const long =
      "close every order that has been open more than ninety days ".repeat(2);
    type(long);
    fireEvent.click(screen.getByRole("button", { name: "Draft write" }));
    await screen.findByText("UPDATE orders SET status = 'x'");
    expect(generateQuery.mock.calls[0][0].mode).toBe("write");
    expect(screen.queryByRole("button", { name: "Replace" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "New write request" }));
    expect(useStore.getState().writeHandoff).toEqual({
      writeSql: "UPDATE orders SET status = 'x'",
      connectionId: "c1",
      title: long.trim().slice(0, 80),
    });
    expect(useStore.getState().aiAssistantOpen).toBe(false);
    expect(await screen.findByText("write page")).toBeTruthy();
  });

  it("copies via the clipboard API, falling back to execCommand", async () => {
    const writeText = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("unfocused"));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    generateQuery.mockResolvedValue(result());
    renderUi(<AiAssistantPanel />);
    type("orders");
    send();
    await screen.findByText("SELECT * FROM orders");
    const copy = () =>
      fireEvent.click(
        document.querySelector(".tabler-icon-copy")!.closest("button")!,
      );

    copy();
    expect(await screen.findByText("Copied to clipboard")).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith("SELECT * FROM orders");

    copy();
    await waitFor(() =>
      expect(document.execCommand).toHaveBeenCalledWith("copy"),
    );

    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
    });
    copy();
    expect(document.execCommand).toHaveBeenCalledTimes(2);
  });

  it("keeps a chat per tab, clears it, and forgets closed tabs", async () => {
    generateQuery.mockResolvedValue(result());
    useStore.setState({ tabs: [tab(), tab({ id: "t2" })] });
    renderUi(<AiAssistantPanel />);
    const newChat = () => screen.getByRole("button", { name: "New chat" });
    expect((newChat() as HTMLButtonElement).disabled).toBe(true);
    type("orders");
    expect((newChat() as HTMLButtonElement).disabled).toBe(false);
    send();
    await screen.findByText("SELECT * FROM orders");

    act(() => useStore.setState({ activeTabId: "t2" }));
    expect(screen.queryByText("SELECT * FROM orders")).toBeNull();
    act(() => useStore.setState({ activeTabId: "t1" }));
    expect(screen.getByText("SELECT * FROM orders")).toBeTruthy();

    type("draft");
    fireEvent.click(newChat());
    expect(screen.queryByText("SELECT * FROM orders")).toBeNull();
    expect((box() as HTMLTextAreaElement).value).toBe("");

    // Closing tab t1 drops its (now empty) chat; reopening it starts fresh.
    type("left over");
    act(() => useStore.setState({ tabs: [tab({ id: "t2" })] }));
    act(() => useStore.setState({ tabs: [tab(), tab({ id: "t2" })] }));
    expect((box() as HTMLTextAreaElement).value).toBe("");
  });

  it("refuses to generate without a connection", async () => {
    renderUi(<AiAssistantPanel />);
    type("orders");
    act(() => useStore.setState({ tabs: [tab({ connectionId: null })] }));
    expect(
      await screen.findByText(
        /Select a connection for the active tab to enable/,
      ),
    ).toBeTruthy();
    expect((box() as HTMLTextAreaElement).disabled).toBe(true);
    send();
    expect(
      await screen.findByText("Select a connection for the active tab first"),
    ).toBeTruthy();

    // A tab pointing at a connection that no longer exists.
    act(() => useStore.setState({ tabs: [tab({ connectionId: "gone" })] }));
    type("orders");
    send();
    expect(generateQuery).not.toHaveBeenCalled();
  });

  it("ignores an empty prompt and New chat without an active tab", async () => {
    useStore.setState({ tabs: [], activeTabId: "" });
    renderUi(<AiAssistantPanel />);
    send();
    type("orders");
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    // Nothing to clear: the draft stays.
    expect((box() as HTMLTextAreaElement).value).toBe("orders");
    expect(generateQuery).not.toHaveBeenCalled();
  });

  it("does nothing to the tab when the answer's tab is no longer active", async () => {
    // A tab whose id is "" shares the chat bucket used when no tab is active.
    useStore.setState({
      user: { canWrite: true } as ReturnType<typeof useStore.getState>["user"],
      tabs: [tab({ id: "", sql: "keep" })],
      activeTabId: "",
    });
    generateQuery
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result({ query: "DELETE FROM orders" }));
    renderUi(<AiAssistantPanel />);
    type("orders");
    send();
    await screen.findByText("SELECT * FROM orders");
    fireEvent.click(await screen.findByText("Write query"));
    type("remove");
    send();
    await screen.findByText("DELETE FROM orders");

    act(() => useStore.setState({ activeTabId: "elsewhere" }));
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    fireEvent.click(screen.getByRole("button", { name: "Append" }));
    expect(useStore.getState().tabs[0].sql).toBe("keep");
    fireEvent.click(screen.getByRole("button", { name: "New write request" }));
    expect(useStore.getState().writeHandoff?.connectionId).toBeNull();
  });
});
