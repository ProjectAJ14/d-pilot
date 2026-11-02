// @vitest-environment jsdom
import { useEffect } from "react";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifications } from "@mantine/notifications";
import { renderUi } from "../../utils/dom.testing";
import { useStore } from "../../store";
import type { ConnectionInfo, QueryTab } from "../../types";
import { QueryEditor, monacoLanguageForDb } from "./query-editor";

/* ---------- fakes ---------- */

type Any = any;

const api = vi.hoisted(() => ({
  getSchemas: vi.fn(),
  getFullSchema: vi.fn(),
  getTables: vi.fn(),
  getColumns: vi.fn(),
  executeQuery: vi.fn(),
  createSavedQuery: vi.fn(),
  updateSavedQuery: vi.fn(),
  exportCsv: vi.fn(),
}));
vi.mock("../../utils/api-client", async (orig) => ({
  ...(await orig<object>()),
  api,
}));

const navigate = vi.fn();
vi.mock("react-router-dom", async (orig) => ({
  ...(await orig<object>()),
  useNavigate: () => navigate,
}));

const copySavedQueryShareLink = vi.fn();
vi.mock("../../utils/share-links", () => ({
  copySavedQueryShareLink: (q: unknown) => copySavedQueryShareLink(q),
}));
const downloadTextFile = vi.fn();
vi.mock("../../utils/download-file", () => ({
  downloadTextFile: (...a: unknown[]) => downloadTextFile(...a),
}));
const attachEditor = vi.fn();
vi.mock("../../utils/vim-mode", () => ({
  useVimMode: () => ({ attachEditor }),
}));

let autoMount = true;
let editorProps: Any;
let fake: ReturnType<typeof makeEditor>;
let monaco: ReturnType<typeof makeMonaco>;

vi.mock("@monaco-editor/react", () => ({
  default: function FakeEditor(props: Any) {
    editorProps = props;
    useEffect(() => {
      if (autoMount) props.onMount(fake.editor, monaco);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return (
      <textarea
        data-testid="monaco"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value || undefined)}
      />
    );
  },
}));

let uriSeq = 0;
function makeEditor(opts: { selected?: string; noModel?: boolean } = {}) {
  const commands = new Map<number, () => void>();
  const disposers: (() => void)[] = [];
  const run = vi.fn();
  const uri = `inmemory://model/${++uriSeq}`;
  let action: { run: () => void } | null = { run };
  const model = opts.noModel
    ? null
    : {
        uri: { toString: () => uri },
        onWillDispose: (cb: () => void) => disposers.push(cb),
        getValueInRange: () => opts.selected ?? "",
      };
  const editor = {
    addCommand: (k: number, fn: () => void) => commands.set(k, fn),
    getModel: () => model,
    getSelection: () => ({ isEmpty: () => !opts.selected }),
    getAction: vi.fn(() => action),
  };
  return {
    editor,
    model,
    commands,
    run,
    dropAction: () => (action = null),
    dispose: () => disposers.forEach((d) => d()),
  };
}

function makeMonaco() {
  const providers: Record<string, Any> = {};
  return {
    providers,
    KeyMod: { CtrlCmd: 2048 },
    KeyCode: { Enter: 3, KeyS: 49 },
    languages: {
      registerCompletionItemProvider: (lang: string, p: Any) => {
        providers[lang] = p;
      },
      CompletionItemKind: { Keyword: 17, Field: 3, Struct: 21, Method: 0 },
    },
    editor: { setModelLanguage: vi.fn() },
  };
}

/* ---------- harness ---------- */

let seq = 0;
const freshId = () => `conn-${++seq}`;

function conn(over: Partial<ConnectionInfo> = {}): ConnectionInfo {
  return {
    id: freshId(),
    name: "app_core",
    env: "DEV",
    type: "postgres",
    ...over,
  };
}

function setup(
  c: ConnectionInfo | null,
  tabOver: Partial<QueryTab> = {},
  props: Partial<Parameters<typeof QueryEditor>[0]> = {},
) {
  const tab: QueryTab = {
    id: "t1",
    title: "Query 1",
    sql: "SELECT 1",
    connectionId: c?.id ?? null,
    result: null,
    loading: false,
    error: null,
    ...tabOver,
  };
  useStore.setState({
    connections: c ? [c] : [],
    tabs: [tab],
  });
  function Harness(p: Partial<Parameters<typeof QueryEditor>[0]>) {
    const live = useStore((s) => s.tabs.find((t) => t.id === "t1"))!;
    return <QueryEditor tab={live} {...props} {...p} />;
  }
  const r = renderUi(<Harness />);
  return { ...r, tab: () => useStore.getState().tabs[0], Harness };
}

const press = (key: number) => act(() => fake.commands.get(key)!());
const CMD_ENTER = 2048 | 3;
const CMD_S = 2048 | 49;

/** Waits for a toast whose title or message text contains `text`. */
const toast = (text: string) =>
  waitFor(() => {
    const shown = vi
      .mocked(notifications.show)
      .mock.calls.map(([n]) => `${n.title ?? ""}|${textOf(n.message)}`);
    expect(shown.join("\n")).toContain(text);
  });
const noToast = (text: string) =>
  expect(
    vi
      .mocked(notifications.show)
      .mock.calls.map(([n]) => `${n.title ?? ""}|${textOf(n.message)}`)
      .join("\n"),
  ).not.toContain(text);
function textOf(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return textOf((node as { props?: { children?: unknown } }).props?.children);
}

beforeEach(() => {
  vi.spyOn(notifications, "show");
  autoMount = true;
  fake = makeEditor();
  monaco = makeMonaco();
  Object.values(api).forEach((f) => f.mockReset());
  api.getSchemas.mockResolvedValue({ schemas: ["public", "sales"] });
  api.getFullSchema.mockResolvedValue({ tables: [], columns: {} });
  api.getTables.mockResolvedValue([]);
  api.getColumns.mockResolvedValue([]);
  navigate.mockReset();
  copySavedQueryShareLink.mockReset();
  downloadTextFile.mockReset();
  useStore.setState({
    user: { canWrite: true } as Any,
    savedQueries: [],
    schemaByConnection: {},
    defaultLimitEnabled: true,
    defaultLimitValue: 500,
    aiAssistantOpen: false,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/* ---------- tests ---------- */

describe("monacoLanguageForDb", () => {
  it("maps each engine to its grammar", () => {
    expect(monacoLanguageForDb("mongodb")).toBe("javascript");
    expect(monacoLanguageForDb("elasticsearch")).toBe("plaintext");
    expect(monacoLanguageForDb("mssql")).toBe("sql");
    expect(monacoLanguageForDb(null)).toBe("sql");
  });
});

describe("QueryEditor toolbar", () => {
  it("labels Run with the environment and names the connection", async () => {
    setup(conn({ env: "PROD", name: "orders_db" }));
    expect(screen.getByText("Run on PROD")).toBeTruthy();
    expect(screen.getByText("orders_db")).toBeTruthy();
    expect(screen.getByText("Connected to PROD environment")).toBeTruthy();
    await waitFor(() => expect(api.getSchemas).toHaveBeenCalled());
  });

  it("shows a plain Run and no write button without a connection or write rights", () => {
    useStore.setState({ user: null });
    setup(null, {}, { height: 30, expanded: true });
    expect(screen.getByText("Run")).toBeTruthy();
    expect(screen.queryByText("Write request")).toBeNull();
    expect(editorProps.height).toBe("60px");
    expect(editorProps.language).toBe("sql");
  });

  it("sizes the editor from the panel height", () => {
    setup(null, {}, { height: 300 });
    expect(editorProps.height).toBe("244px");
  });

  it("tags Mongo and Elasticsearch editors", () => {
    const { unmount } = setup(conn({ type: "mongodb" }));
    expect(screen.getByText("· Mongo shell")).toBeTruthy();
    expect(editorProps.language).toBe("javascript");
    unmount();
    setup(conn({ type: "elasticsearch" }));
    expect(screen.getByText("· ES REST / JSON")).toBeTruthy();
  });

  it("toggles height and the AI assistant", () => {
    const onToggleHeight = vi.fn();
    const { container } = setup(null, {}, { onToggleHeight });
    fireEvent.click(screen.getByText("Generate"));
    expect(useStore.getState().aiAssistantOpen).toBe(true);
    const icons = container.querySelectorAll("button.mantine-ActionIcon-root");
    fireEvent.click(icons[0]);
    expect(onToggleHeight).toHaveBeenCalled();
  });

  it("edits the SQL and the default limit", () => {
    const { container, tab } = setup(null);
    fireEvent.change(screen.getByTestId("monaco"), {
      target: { value: "SELECT 2" },
    });
    expect(tab().sql).toBe("SELECT 2");
    fireEvent.change(screen.getByTestId("monaco"), { target: { value: "" } });
    expect(tab().sql).toBe("");

    fireEvent.click(screen.getByLabelText("Limit"));
    expect(useStore.getState().defaultLimitEnabled).toBe(false);
    fireEvent.click(screen.getByLabelText("Limit"));
    const input = container.querySelector(
      ".mantine-NumberInput-input",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "250" } });
    expect(useStore.getState().defaultLimitValue).toBe(250);
    fireEvent.change(input, { target: { value: "" } });
    expect(useStore.getState().defaultLimitValue).toBe(500);
  });

  it("hides the placeholder once Monaco has painted", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setup(null);
    const placeholder = screen.getByText("Preparing editor…").parentElement!;
    expect(placeholder.style.opacity).toBe("1");
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(placeholder.style.opacity).toBe("0");
    expect(attachEditor).toHaveBeenCalledWith(fake.editor);
  });

  it("cancels the reveal timer on unmount", () => {
    const clear = vi.spyOn(window, "clearTimeout");
    const { unmount } = setup(null);
    unmount();
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });

  it("skips the reveal-timer cleanup when the editor never mounted", () => {
    autoMount = false;
    attachEditor.mockClear();
    const { unmount } = setup(null);
    unmount();
    expect(attachEditor).not.toHaveBeenCalled();
  });
});

describe("QueryEditor running", () => {
  it("refuses to run without SQL or a connection", async () => {
    setup(null, { sql: "   " });
    fireEvent.click(screen.getByText("Run"));
    await toast("Enter a query and select a connection first");
    expect(api.executeQuery).not.toHaveBeenCalled();
  });

  it("runs the selection from Cmd+Enter and reports the result", async () => {
    fake = makeEditor({ selected: " SELECT id FROM orders " });
    const c = conn({ database: "app_core" });
    api.executeQuery.mockResolvedValue({
      columns: [],
      rows: [],
      totalRows: 3,
      executionTimeMs: 9,
      truncated: true,
    });
    const { tab } = setup(c, { schema: "public" });
    press(CMD_ENTER);
    await waitFor(() => expect(tab().result?.totalRows).toBe(3));
    expect(api.executeQuery).toHaveBeenCalledWith(
      c.id,
      "SELECT id FROM orders",
      500,
      "public",
    );
    expect(tab().viewMode).toBe("table");
    expect(tab().loading).toBe(false);
    await toast(
      "app_core · DEV · postgres · app_core · 3 rows in 9ms · Truncated",
    );
  });

  it("keeps the tab's view mode and copes with a vanished connection", async () => {
    const c = conn({ type: "mongodb" });
    api.executeQuery.mockImplementation(async () => {
      useStore.setState({ connections: [] });
      return { totalRows: 1, executionTimeMs: 2, truncated: false };
    });
    useStore.setState({ defaultLimitEnabled: false });
    const { tab } = setup(c, { viewMode: "table" });
    fireEvent.click(screen.getByText("Run on DEV"));
    await toast("Unknown connection · 1 rows in 2ms");
    expect(tab().viewMode).toBe("table");
    expect(api.executeQuery.mock.calls[0][2]).toBeNull();
  });

  it("puts a failure inline, with its code and reportability", async () => {
    const c = conn();
    api.executeQuery.mockRejectedValueOnce(
      Object.assign(new Error("relation missing"), { code: 42 }),
    );
    const { tab } = setup(c);
    fireEvent.click(screen.getByText("Run on DEV"));
    await waitFor(() => expect(tab().error).toBe("relation missing"));
    expect(tab().errorCode).toBe("42");
    expect(tab().errorReportable).toBe(true);
    expect(tab().result).toBeNull();
    await toast("relation missing");

    api.executeQuery.mockRejectedValueOnce(
      Object.assign(new Error("offline"), { code: "SERVER_UNREACHABLE" }),
    );
    fireEvent.click(screen.getByText("Run on DEV"));
    await waitFor(() => expect(tab().error).toBe("offline"));
    expect(tab().errorReportable).toBe(false);
    noToast("offline");

    api.executeQuery.mockRejectedValueOnce(new Error("plain"));
    fireEvent.click(screen.getByText("Run on DEV"));
    await waitFor(() => expect(tab().error).toBe("plain"));
    expect(tab().errorCode).toBeUndefined();
  });
});

describe("QueryEditor write handoff", () => {
  it("needs something to hand off", async () => {
    setup(null, { sql: "" });
    fireEvent.click(screen.getByText("Write request"));
    await toast("Select or write a statement first");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("hands the selection off, dropping an auto-generated title", () => {
    fake = makeEditor({ selected: "UPDATE orders SET x = 1" });
    const c = conn();
    setup(c);
    fireEvent.click(screen.getByText("Write request"));
    expect(useStore.getState().writeHandoff).toEqual({
      writeSql: "UPDATE orders SET x = 1",
      connectionId: c.id,
      title: "",
    });
    expect(navigate).toHaveBeenCalledWith("/write");
  });

  it("keeps a named tab's title", () => {
    setup(null, { title: "Monthly totals", sql: "DELETE FROM x" });
    fireEvent.click(screen.getByText("Write request"));
    expect(useStore.getState().writeHandoff).toMatchObject({
      writeSql: "DELETE FROM x",
      title: "Monthly totals",
    });
  });
});

describe("QueryEditor saving", () => {
  const saved = {
    id: "sq1",
    name: "Monthly totals",
    sql: "SELECT 1",
    createdBy: "u",
    createdByEmail: "u@example.com",
    isShared: true,
    tags: [],
    createdAt: "",
    updatedAt: "",
  };

  it("saves a new query from Cmd+S", async () => {
    api.createSavedQuery.mockResolvedValue({ ...saved, id: "sq2" });
    setup(null);
    press(CMD_S);
    expect(await screen.findByText("Save Query")).toBeTruthy();
    const name = screen.getByLabelText("Query Name") as HTMLInputElement;
    expect(name.value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(api.createSavedQuery).not.toHaveBeenCalled();

    fireEvent.change(name, { target: { value: "Open orders" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await toast("Query saved!");
    expect(api.createSavedQuery).toHaveBeenCalledWith({
      name: "Open orders",
      sql: "SELECT 1",
      connectionId: null,
      isShared: true,
      tags: [],
    });
    expect(useStore.getState().savedQueries[0].id).toBe("sq2");
  });

  it("updates the saved query backing the tab and copies its link", async () => {
    useStore.setState({ savedQueries: [saved] });
    api.updateSavedQuery.mockResolvedValue({ ...saved, sql: "SELECT 2" });
    const { container } = setup(null, { title: "Monthly totals" });
    const icons = container.querySelectorAll("button.mantine-ActionIcon-root");
    // [height, format, save, share, export]
    fireEvent.click(icons[3]);
    expect(copySavedQueryShareLink).toHaveBeenCalledWith(saved);

    fireEvent.click(icons[2]);
    expect(await screen.findByText("Update Query")).toBeTruthy();
    expect(
      (screen.getByLabelText("Query Name") as HTMLInputElement).value,
    ).toBe("Monthly totals");
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    await toast("Query updated!");
    expect(api.updateSavedQuery).toHaveBeenCalledWith("sq1", {
      name: "Monthly totals",
      sql: "SELECT 1",
      connectionId: null,
    });
    expect(useStore.getState().savedQueries[0].sql).toBe("SELECT 2");
  });

  it("prefills a named tab and reports a failed save", async () => {
    api.createSavedQuery.mockRejectedValue(new Error("disk full"));
    setup(null, { title: "Scratch" }, { saveSignal: 1 });
    const name = (await screen.findByLabelText(
      "Query Name",
    )) as HTMLInputElement;
    expect(name.value).toBe("Scratch");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await toast("disk full");
  });

  it("closes from Cancel and from the modal close button", async () => {
    setup(null, {}, { saveSignal: 2 });
    await screen.findByText("Save Query");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText("Save Query")).toBeNull());

    press(CMD_S);
    await screen.findByText("Save Query");
    const close = document.querySelector(
      ".mantine-Modal-close",
    ) as HTMLButtonElement;
    fireEvent.click(close);
    await waitFor(() => expect(screen.queryByText("Save Query")).toBeNull());
  });
});

describe("QueryEditor export and format", () => {
  const icon = (container: HTMLElement, i: number) =>
    container.querySelectorAll("button.mantine-ActionIcon-root")[i];

  it("exports CSV with the active limit", async () => {
    const c = conn();
    api.exportCsv.mockResolvedValue("id\n1");
    const { container } = setup(c);
    fireEvent.click(icon(container, 3));
    await waitFor(() =>
      expect(downloadTextFile).toHaveBeenCalledWith(
        "query-export.csv",
        "id\n1",
      ),
    );
    expect(api.exportCsv).toHaveBeenCalledWith(c.id, "SELECT 1", 500);
  });

  it("reports a failed export and skips one with nothing to export", async () => {
    api.exportCsv.mockRejectedValue(new Error("export broke"));
    const { container, unmount } = setup(conn());
    fireEvent.click(icon(container, 3));
    await toast("export broke");
    unmount();

    const r = setup(null);
    fireEvent.click(icon(r.container, 3));
    expect(api.exportCsv).toHaveBeenCalledTimes(1);
  });

  it("formats SQL for the connection's dialect", () => {
    const { container, tab, unmount } = setup(null, {
      sql: "select id from orders",
    });
    fireEvent.click(icon(container, 1));
    expect(tab().sql).toBe("SELECT\n  id\nFROM\n  orders");
    unmount();

    const r = setup(conn({ type: "mssql" }), { sql: "select top 1 id from t" });
    fireEvent.click(icon(r.container, 1));
    expect(r.tab().sql).toBe("SELECT\n  TOP 1 id\nFROM\n  t");
  });

  it("warns when SQL cannot be formatted", async () => {
    const { container, tab } = setup(null, { sql: "SELECT 'unterminated" });
    fireEvent.click(icon(container, 1));
    await toast("Could not format query");
    expect(tab().sql).toBe("SELECT 'unterminated");
  });

  it("formats Mongo through Monaco's document formatter", () => {
    const { container } = setup(conn({ type: "mongodb" }));
    fireEvent.click(icon(container, 1));
    expect(fake.editor.getAction).toHaveBeenCalledWith(
      "editor.action.formatDocument",
    );
    expect(fake.run).toHaveBeenCalled();
    fake.dropAction();
    fireEvent.click(icon(container, 1));
    expect(fake.run).toHaveBeenCalledTimes(1);
  });

  it("pretty-prints an Elasticsearch JSON body", async () => {
    const c = conn({ type: "elasticsearch" });
    const { container, tab } = setup(c, {
      sql: 'GET orders/_search\n{"size":1}',
    });
    fireEvent.click(icon(container, 1));
    expect(tab().sql).toBe('GET orders/_search\n{\n  "size": 1\n}');

    act(() => useStore.getState().updateTab("t1", { sql: "GET x\n{bad" }));
    fireEvent.click(icon(container, 1));
    await toast("Invalid JSON body");

    act(() => useStore.getState().updateTab("t1", { sql: "GET x" }));
    fireEvent.click(icon(container, 1));
    expect(tab().sql).toBe("GET x");
  });
});

describe("QueryEditor schemas", () => {
  it("defaults the schema, lists the others and switches on pick", async () => {
    const c = conn();
    const { tab } = setup(c);
    expect(tab().schema).toBe("public");
    expect(useStore.getState().schemaByConnection[c.id]).toBe("public");
    await waitFor(() =>
      expect(document.querySelector(".mantine-Select-input")).not.toBeNull(),
    );
    const input = document.querySelector(
      ".mantine-Select-input",
    ) as HTMLInputElement;
    expect(input.value).toBe("public");
    fireEvent.click(input);
    fireEvent.click(
      await screen.findByRole("option", { name: "sales", hidden: true }),
    );
    expect(tab().schema).toBe("sales");
    await waitFor(() =>
      expect(api.getFullSchema).toHaveBeenCalledWith(c.id, "sales"),
    );

    // allowDeselect is off, so a null pick only comes from a direct call;
    // it must leave the schema alone.
    const key = Object.keys(input).find((k) => k.startsWith("__reactFiber$"))!;
    type Fiber = { memoizedProps: Record<string, unknown>; return: Fiber };
    let f = (input as unknown as Record<string, Fiber>)[key];
    while (!("allowDeselect" in (f.memoizedProps ?? {}))) f = f.return;
    act(() => (f.memoizedProps.onChange as (v: null) => void)(null));
    expect(tab().schema).toBe("sales");
  });

  it("prefers the sidebar's schema, then each engine's default", () => {
    const pg = conn();
    useStore.setState({ schemaByConnection: { [pg.id]: "sales" } });
    let r = setup(pg);
    expect(r.tab().schema).toBe("sales");
    r.unmount();

    r = setup(conn({ type: "mssql" }));
    expect(r.tab().schema).toBe("dbo");
    r.unmount();

    r = setup(conn({ type: "mssql", schema: "ops" }));
    expect(r.tab().schema).toBe("ops");
    r.unmount();

    r = setup(conn({ schema: "app" }));
    expect(r.tab().schema).toBe("app");
  });

  it("leaves the schema unset when the stored choice is blank", async () => {
    const c = conn();
    useStore.setState({ schemaByConnection: { [c.id]: "" } });
    const { tab } = setup(c);
    expect(tab().schema).toBeUndefined();
    // The picker still lists the schemas, with nothing selected.
    await waitFor(() =>
      expect(document.querySelector(".mantine-Select-input")).not.toBeNull(),
    );
    expect(
      (document.querySelector(".mantine-Select-input") as HTMLInputElement)
        .value,
    ).toBe("");
  });

  it("toasts a failed schema list unless the server is unreachable", async () => {
    api.getSchemas.mockRejectedValueOnce(new Error("no perms"));
    const r = setup(conn(), { schema: "public" });
    await toast("Unable to load schemas");
    r.unmount();

    api.getSchemas.mockRejectedValueOnce({
      code: "SERVER_UNREACHABLE",
      message: "down",
    });
    setup(conn(), { schema: "public" });
    await waitFor(() => expect(api.getSchemas).toHaveBeenCalledTimes(2));
    noToast("down");
  });

  it("ignores a schema list that lands after unmount", async () => {
    let resolve!: (v: unknown) => void;
    let reject!: (e: unknown) => void;
    api.getSchemas
      .mockReturnValueOnce(new Promise((r) => (resolve = r)))
      .mockReturnValueOnce(new Promise((_, r) => (reject = r)));
    setup(conn(), { schema: "public" }).unmount();
    setup(conn(), { schema: "public" }).unmount();
    resolve({ schemas: ["late"] });
    reject(new Error("late failure"));
    await new Promise((r) => setTimeout(r, 0));
    noToast("Unable to load schemas");
  });

  it("offers no schema picker for engines without schemas", () => {
    setup(conn({ type: "mongodb" }));
    expect(api.getSchemas).not.toHaveBeenCalled();
    expect(document.querySelector(".mantine-Select-input")).toBeNull();
  });
});

describe("QueryEditor schema cache", () => {
  it("loads the full schema once for editors sharing a connection", async () => {
    const c = conn();
    api.getFullSchema.mockResolvedValue({
      tables: [{ name: "orders", type: "table" }],
      columns: null,
    });
    const first = setup(c, { schema: "public" });
    await waitFor(() => expect(api.getFullSchema).toHaveBeenCalledTimes(1));
    first.unmount();
    // Fresh cache: a second editor does not refetch.
    setup(c, { schema: "public" });
    await waitFor(() =>
      expect(monaco.editor.setModelLanguage).toHaveBeenCalled(),
    );
    expect(api.getFullSchema).toHaveBeenCalledTimes(1);
  });

  it("serves a stale entry while it refreshes, and keeps it if the refresh fails", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000_000);
    const c = conn();
    api.getFullSchema.mockResolvedValueOnce({
      tables: [{ name: "orders", type: "table" }],
      columns: { orders: [] },
    });
    let r = setup(c, { schema: "public" });
    await waitFor(() => expect(api.getFullSchema).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(monaco.editor.setModelLanguage).toHaveBeenCalled(),
    );
    r.unmount();

    now.mockReturnValue(1_000_000 + 6 * 60_000);
    api.getFullSchema.mockRejectedValueOnce(new Error("db down"));
    monaco = makeMonaco();
    fake = makeEditor();
    r = setup(c, { schema: "public" });
    await waitFor(() => expect(api.getFullSchema).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(monaco.editor.setModelLanguage).toHaveBeenCalled(),
    );
    // Completions still come from the stale entry.
    const items = monaco.providers.sql.provideCompletionItems(
      sqlModel(fake, "SELECT * FROM "),
      { lineNumber: 1, column: 15 },
    ).suggestions;
    expect(items.some((i: Any) => i.label === "orders")).toBe(true);
    now.mockRestore();
  });

  it("caches an empty result when the first load fails", async () => {
    api.getFullSchema.mockRejectedValue(new Error("db down"));
    setup(conn(), { schema: "public" });
    await waitFor(() =>
      expect(monaco.editor.setModelLanguage).toHaveBeenCalled(),
    );
    const items = monaco.providers.sql.provideCompletionItems(
      sqlModel(fake, "SELECT * FROM "),
      { lineNumber: 1, column: 15 },
    ).suggestions;
    expect(items.every((i: Any) => i.kind === 17)).toBe(true);
  });

  it("upgrades a tables-only entry once the connection turns out to be SQL", async () => {
    const c = conn({ type: "mongodb" });
    api.getTables.mockResolvedValue([
      { schema: "", name: "orders", type: "collection" },
      { schema: "", name: "events", type: "collection" },
    ]);
    api.getColumns
      .mockResolvedValueOnce([{ name: "total", dataType: "number" }])
      .mockRejectedValueOnce(new Error("sampling failed"));
    setup(c, { schema: "" });
    await waitFor(() => expect(api.getColumns).toHaveBeenCalledTimes(2));
    expect(api.getColumns).toHaveBeenCalledWith(c.id, "orders", "");

    api.getFullSchema.mockResolvedValue({
      tables: [{ name: "orders", type: "table" }],
      columns: {},
    });
    act(() => useStore.setState({ connections: [{ ...c, type: "postgres" }] }));
    await waitFor(() =>
      expect(api.getFullSchema).toHaveBeenCalledWith(c.id, ""),
    );
    await waitFor(() =>
      expect(
        labels(
          monaco.providers.sql.provideCompletionItems(
            sqlModel(fake, "SELECT * FROM "),
            at("SELECT * FROM "),
          ),
        ),
      ).toContain("orders"),
    );
  });

  it("dedupes concurrent loads for the same key", async () => {
    const c = conn();
    let resolve!: (v: unknown) => void;
    api.getFullSchema.mockReturnValue(new Promise((r) => (resolve = r)));
    const a = setup(c, { schema: "public" });
    a.unmount();
    setup(c, { schema: "public" });
    await waitFor(() => expect(api.getFullSchema).toHaveBeenCalledTimes(1));
    resolve({ tables: [], columns: {} });
    await waitFor(() =>
      expect(monaco.editor.setModelLanguage).toHaveBeenCalled(),
    );
    expect(api.getFullSchema).toHaveBeenCalledTimes(1);
  });

  it("does not load before the connection type is known", async () => {
    setup(null, { connectionId: freshId() });
    await waitFor(() =>
      expect(monaco.editor.setModelLanguage).toHaveBeenCalled(),
    );
    expect(api.getFullSchema).not.toHaveBeenCalled();
    expect(api.getTables).not.toHaveBeenCalled();
  });

  it("applies the language once Monaco mounts late, and gives up after 5s", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    autoMount = false;
    const r = setup(null);
    await act(() => vi.advanceTimersByTimeAsync(0));
    act(() => editorProps.onMount(fake.editor, monaco));
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(monaco.editor.setModelLanguage).toHaveBeenCalledWith(
      fake.model,
      "sql",
    );
    r.unmount();

    // Never mounts: polling stops after 5 seconds.
    monaco = makeMonaco();
    setup(null);
    await act(() => vi.advanceTimersByTimeAsync(5200));
    act(() => editorProps.onMount(fake.editor, monaco));
    await act(() => vi.advanceTimersByTimeAsync(400));
    expect(monaco.editor.setModelLanguage).not.toHaveBeenCalled();
  });

  it("keeps polling while the editor has no model", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fake = makeEditor({ noModel: true });
    setup(null);
    await act(() => vi.advanceTimersByTimeAsync(5200));
    expect(monaco.editor.setModelLanguage).not.toHaveBeenCalled();
  });
});

/* ---------- completion providers ---------- */

function sqlModel(f: ReturnType<typeof makeEditor>, text: string) {
  return {
    uri: f.model!.uri,
    getValue: () => text,
    getOffsetAt: (p: { column: number }) => p.column - 1,
    getWordUntilPosition: () => ({ startColumn: 1, endColumn: 1 }),
    getLineContent: () => text,
  };
}
const at = (text: string) => ({ lineNumber: 1, column: text.length + 1 });
const labels = (r: { suggestions: Any[] }) => r.suggestions.map((s) => s.label);

describe("completion providers", () => {
  async function mounted(c: ConnectionInfo | null, tabOver = {}) {
    setup(c, tabOver);
    await waitFor(() =>
      expect(monaco.editor.setModelLanguage).toHaveBeenCalled(),
    );
  }

  it("register once per Monaco instance", async () => {
    const register = vi.spyOn(
      monaco.languages,
      "registerCompletionItemProvider",
    );
    const r = setup(null);
    await waitFor(() =>
      expect(monaco.editor.setModelLanguage).toHaveBeenCalled(),
    );
    r.unmount();
    fake = makeEditor();
    setup(null);
    await waitFor(() =>
      expect(monaco.editor.setModelLanguage).toHaveBeenCalledTimes(2),
    );
    expect(register).toHaveBeenCalledTimes(3);
  });

  it("SQL completions follow the model's connection dialect", async () => {
    api.getFullSchema.mockResolvedValue({
      tables: [{ name: "orders", type: "table" }],
      columns: { orders: [{ name: "total", dataType: "numeric" }] },
    });
    await mounted(conn({ type: "mssql" }), { schema: "dbo" });
    const sql = monaco.providers.sql;
    const text = "SELECT o.";
    expect(
      labels(sql.provideCompletionItems(sqlModel(fake, text), at(text))),
    ).toEqual([]);
    const text2 = "SELECT * FROM orders o WHERE o.";
    expect(
      labels(sql.provideCompletionItems(sqlModel(fake, text2), at(text2))),
    ).toEqual(["total"]);
    expect(
      labels(sql.provideCompletionItems(sqlModel(fake, ""), at(""))),
    ).toContain("FETCH NEXT");
  });

  it("SQL completions on postgres omit T-SQL keywords; unknown models get keywords only", async () => {
    await mounted(conn(), { schema: "public" });
    const sql = monaco.providers.sql;
    expect(
      labels(sql.provideCompletionItems(sqlModel(fake, ""), at(""))),
    ).not.toContain("FETCH NEXT");
    const stranger = {
      ...sqlModel(fake, ""),
      uri: { toString: () => "inmemory://elsewhere" },
    };
    const items = sql.provideCompletionItems(stranger, at("")).suggestions;
    expect(items.every((i: Any) => i.kind === 17)).toBe(true);
  });

  it("forgets a model's context when it is disposed", async () => {
    api.getFullSchema.mockResolvedValue({
      tables: [{ name: "orders", type: "table" }],
      columns: {},
    });
    await mounted(conn(), { schema: "public" });
    const sql = monaco.providers.sql;
    const text = "SELECT * FROM ";
    expect(
      labels(sql.provideCompletionItems(sqlModel(fake, text), at(text))),
    ).toContain("orders");
    fake.dispose();
    expect(
      labels(sql.provideCompletionItems(sqlModel(fake, text), at(text))),
    ).not.toContain("orders");
  });

  it("Mongo completions suggest collections, methods and fields", async () => {
    api.getTables.mockResolvedValue([
      { schema: "app_core", name: "orders", type: "collection" },
      { schema: "app_core", name: "customers", type: "collection" },
    ]);
    api.getColumns.mockImplementation(async (_c: string, t: string) =>
      t === "orders"
        ? [
            { name: "total", dataType: "number" },
            { name: "email", dataType: "string", isPhiField: true },
          ]
        : [],
    );
    await mounted(conn({ type: "mongodb" }));
    await waitFor(() => expect(api.getColumns).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 0));
    const js = monaco.providers.javascript;
    const ask = (text: string) =>
      js.provideCompletionItems(sqlModel(fake, text), at(text));

    const coll = ask("db.ord");
    expect(labels(coll)).toContain("orders");
    expect(labels(coll)).not.toContain("customers");
    expect(
      coll.suggestions.find((s: Any) => s.label === "orders"),
    ).toMatchObject({
      insertText: "orders.find({})",
      detail: "collection · app_core",
    });
    expect(labels(ask("db."))).toEqual(
      expect.arrayContaining(["orders", "customers", "find({})"]),
    );

    const fields = ask("db.orders.find({ ");
    expect(
      fields.suggestions
        .filter((s: Any) => s.kind === 3)
        .map((s: Any) => [s.insertText, s.detail]),
    ).toEqual([
      ['"total"', "number"],
      ['"email"', "string 🔐 PHI"],
    ]);
    expect(
      ask("db.missing.find({ ").suggestions.some((s: Any) => s.kind === 3),
    ).toBe(false);
    expect(labels(ask("x"))).toContain("$match");
  });

  it("Mongo completions stay quiet for other JavaScript models", async () => {
    await mounted(conn());
    const js = monaco.providers.javascript;
    expect(js.provideCompletionItems(sqlModel(fake, "db."), at("db."))).toEqual(
      { suggestions: [] },
    );
  });

  it("Elasticsearch completions suggest index paths", async () => {
    api.getTables.mockResolvedValue([
      { schema: "", name: "orders-2024", type: "index" },
      { schema: "", name: "logs", type: "index" },
    ]);
    await mounted(conn({ type: "elasticsearch" }));
    const es = monaco.providers.plaintext;
    const ask = (text: string) =>
      es.provideCompletionItems(sqlModel(fake, text), at(text));
    expect(labels(ask("GET /ord"))).toContain("orders-2024/_search");
    expect(labels(ask("GET /ord"))).not.toContain("logs/_search");
    expect(labels(ask("GET "))).toEqual(
      expect.arrayContaining(["orders-2024/_search", "logs/_search"]),
    );
    expect(labels(ask('{"query": '))).not.toContain("logs/_search");
    expect(labels(ask('{"query": '))).toContain("match_all");
  });

  it("Elasticsearch completions stay quiet for other plaintext models", async () => {
    await mounted(conn());
    expect(
      monaco.providers.plaintext.provideCompletionItems(
        sqlModel(fake, ""),
        at(""),
      ),
    ).toEqual({ suggestions: [] });
  });
});
