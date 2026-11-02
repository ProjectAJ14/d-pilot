// @vitest-environment jsdom
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifications } from "@mantine/notifications";
import { renderUi } from "../../utils/dom.testing";
import { useStore } from "../../store";
import { ApiError } from "../../utils/api-client";
import { Sidebar } from "./sidebar";

const m = vi.hoisted(() => ({
  api: {
    getTables: vi.fn(),
    getSchemas: vi.fn(),
    getColumns: vi.fn(),
    executeQuery: vi.fn(),
    getQueryHistory: vi.fn(),
    exportQueryHistory: vi.fn(),
    setArtifactArchived: vi.fn(),
    deleteSavedQuery: vi.fn(),
  },
  notifyError: vi.fn(),
  copyToClipboard: vi.fn(),
  copyArtifactShareLink: vi.fn(),
  copySavedQueryShareLink: vi.fn(),
  downloadTextFile: vi.fn(),
}));
vi.mock("../../utils/api-client", async (orig) => ({
  ...(await orig<typeof import("../../utils/api-client")>()),
  api: m.api,
}));
vi.mock("../../utils/notify-error", () => ({ notifyError: m.notifyError }));
vi.mock("../../utils/clipboard", () => ({
  copyToClipboard: m.copyToClipboard,
}));
vi.mock("../../utils/share-links", () => ({
  copyArtifactShareLink: m.copyArtifactShareLink,
  copySavedQueryShareLink: m.copySavedQueryShareLink,
}));
vi.mock("../../utils/download-file", () => ({
  downloadTextFile: m.downloadTextFile,
}));
vi.mock("./object-tree", () => ({
  ObjectTree: (p: { connId: string; schema: string; query: string }) => (
    <div data-testid="object-tree">{`objects ${p.connId} ${p.schema} ${p.query}`}</div>
  ),
  JobTree: (p: { connId: string }) => (
    <div data-testid="job-tree">{`jobs ${p.connId}`}</div>
  ),
}));

const CONNS = [
  {
    id: "pg1",
    name: "orders_dev",
    env: "DEV",
    type: "postgres",
    database: "app_core",
  },
  {
    id: "pg2",
    name: "customers_dev",
    env: "DEV",
    type: "postgres",
    schema: "sales",
  },
  {
    id: "ms1",
    name: "billing_qa",
    env: "QA",
    type: "mssql",
    database: "billing",
  },
  { id: "ms2", name: "ledger_qa", env: "QA", type: "mssql", schema: "fin" },
  { id: "mg1", name: "events_qa", env: "QA", type: "mongodb" },
  { id: "es1", name: "logs_prod", env: "PROD", type: "elasticsearch" },
  { id: "x1", name: "scratch", env: "SANDBOX", type: "postgres" },
];

const TABLES = [
  { name: "orders", type: "BASE TABLE" },
  { name: "order_view", type: "VIEW" },
];
const COLUMNS = [
  { name: "id", dataType: "integer", isPrimaryKey: true },
  {
    name: "customer_id",
    dataType: "integer",
    isForeignKey: true,
    references: "customers.id",
  },
  { name: "email", dataType: "text", isPhiField: true },
];

const initial = useStore.getState();
const user = {
  id: "u1",
  username: "me",
  email: "me@example.com",
  isAdmin: false,
};

const setup = (state: Record<string, unknown> = {}) => {
  useStore.setState({
    sidebarOpen: true,
    connections: CONNS as never,
    activeConnectionId: "pg1",
    connectionPins: {},
    connectionLastUsed: {},
    user: user as never,
    savedQueries: [],
    artifacts: [],
    schemaByConnection: {},
    config: {
      ...initial.config,
      environments: ["PROD", "QA", "DEV"],
      phiMaskedEnvironments: ["PROD", "QA"],
    },
    ...state,
  });
  return renderUi(<Sidebar />);
};

const conn = (name: string) =>
  screen.getByText(name).closest(".dp-row") as HTMLElement;
const tableRow = (name: string) =>
  screen.getByText(name).closest(".dp-row") as HTMLElement;
const envTab = (env: string) => screen.getByRole("button", { name: env });
const activeTab = () =>
  useStore
    .getState()
    .tabs.find((t) => t.id === useStore.getState().activeTabId)!;
const search = () => screen.getByPlaceholderText(/^Search/) as HTMLInputElement;
/** Props of the nearest React component at or above `el` that has `prop`. */
function propsWith(el: Element, prop: string) {
  const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"))!;
  type Fiber = { memoizedProps: Record<string, unknown>; return: Fiber };
  let f = (el as unknown as Record<string, Fiber>)[key];
  while (!(f.memoizedProps && prop in f.memoizedProps)) f = f.return;
  return f.memoizedProps as Record<string, (...a: unknown[]) => void>;
}
const download = () =>
  screen.getByText("Download").closest("button") as HTMLButtonElement;

beforeEach(() => {
  m.api.getTables.mockResolvedValue(TABLES);
  m.api.getSchemas.mockResolvedValue({ schemas: ["public", "archive"] });
  m.api.getColumns.mockResolvedValue(COLUMNS);
  m.api.executeQuery.mockResolvedValue({ rows: [], columns: [] });
  m.api.getQueryHistory.mockResolvedValue([]);
});
afterEach(() => {
  act(() => notifications.clean());
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("Sidebar", () => {
  it("renders nothing when collapsed", () => {
    setup({ sidebarOpen: false });
    expect(screen.queryByText("orders_dev")).toBeNull();
  });

  it("shows the masked envs in the footer", () => {
    setup();
    expect(screen.getByText("PHI tokenized on PROD + QA")).toBeTruthy();
  });

  describe("empty explorer", () => {
    it("points admins at Settings", () => {
      setup({ connections: [], user: { ...user, isAdmin: true } });
      expect(screen.getByText("No connections configured")).toBeTruthy();
      expect(
        screen
          .getByRole("link", { name: "Add one in Settings" })
          .getAttribute("href"),
      ).toBe("/settings?tab=connections");
    });

    it("tells others to ask an admin", () => {
      setup({ connections: [], user: null });
      expect(screen.getByText("Ask an admin to add one.")).toBeTruthy();
    });
  });

  describe("environments", () => {
    it("starts on the active connection's env and switches on click", () => {
      setup({ activeConnectionId: "ms1" });
      expect(envTab("QA").getAttribute("aria-pressed")).toBe("true");
      expect(screen.getByText("billing_qa")).toBeTruthy();
      expect(screen.getByText("Active")).toBeTruthy();
      expect(screen.queryByText("orders_dev")).toBeNull();
      fireEvent.click(envTab("DEV"));
      expect(screen.getByText("orders_dev")).toBeTruthy();
      expect(screen.getByText("app_core")).toBeTruthy();
      // An env the server did not list is still shown, after the known ones.
      const envs = screen
        .getAllByRole("button", { pressed: false })
        .map((b) => b.textContent);
      expect(envs).toContain("SANDBOX");
      fireEvent.click(envTab("PROD"));
      expect(screen.getByText("logs_prod")).toBeTruthy();
      expect(screen.getByText("ES")).toBeTruthy();
    });

    it("falls back to the first env without an active connection", () => {
      setup({ activeConnectionId: null });
      expect(envTab("DEV").getAttribute("aria-pressed")).toBe("true");
    });
  });

  describe("expanding a connection", () => {
    it("loads tables for the default schema, then the schema list", async () => {
      setup();
      fireEvent.click(conn("orders_dev"));
      expect(screen.getByText("Loading tables...")).toBeTruthy();
      expect(m.api.getTables).toHaveBeenCalledWith("pg1", "public");
      expect(useStore.getState().schemaByConnection.pg1).toBe("public");
      expect(m.api.getSchemas).toHaveBeenCalledWith("pg1");
      expect(await screen.findByText("orders")).toBeTruthy();
      expect(screen.getByText("VIEW")).toBeTruthy();
      expect(screen.getByTestId("object-tree").textContent).toBe(
        "objects pg1 public ",
      );
      expect(screen.getByTestId("job-tree").textContent).toBe("jobs pg1");
      expect(useStore.getState().activeConnectionId).toBe("pg1");

      // Pick another schema from the picker.
      fireEvent.click(
        document.querySelector<HTMLInputElement>(".mantine-Select-input")!,
      );
      fireEvent.click(
        await screen.findByRole("option", { name: "archive", hidden: true }),
      );
      expect(m.api.getTables).toHaveBeenLastCalledWith("pg1", "archive");
      await waitFor(() =>
        expect(useStore.getState().schemaByConnection.pg1).toBe("archive"),
      );
      // A deselect (allowDeselect is off, so only a direct call) is ignored.
      act(() =>
        propsWith(
          document.querySelector(".mantine-Select-input")!,
          "allowDeselect",
        ).onChange(null),
      );
      expect(useStore.getState().schemaByConnection.pg1).toBe("archive");
      expect(m.api.getTables).toHaveBeenCalledTimes(2);

      // Collapse; re-expand uses the cache.
      fireEvent.click(conn("orders_dev"));
      expect(screen.queryByTestId("object-tree")).toBeNull();
      fireEvent.click(conn("orders_dev"));
      expect(m.api.getTables).toHaveBeenCalledTimes(2);
      expect(m.api.getSchemas).toHaveBeenCalledTimes(1);
    });

    it("uses each engine's default schema", async () => {
      setup({ activeConnectionId: "ms1", schemaByConnection: { ms2: "hr" } });
      fireEvent.click(conn("billing_qa"));
      expect(m.api.getTables).toHaveBeenLastCalledWith("ms1", "dbo");
      fireEvent.click(conn("ledger_qa"));
      // A schema already chosen in the editor wins over the connection default.
      expect(m.api.getTables).toHaveBeenLastCalledWith("ms2", "hr");
      fireEvent.click(conn("events_qa"));
      expect(m.api.getTables).toHaveBeenLastCalledWith("mg1", undefined);
      expect(m.api.getSchemas).toHaveBeenCalledTimes(2);
      await screen.findByText("orders");
      expect(screen.queryByTestId("job-tree")).toBeNull();
      expect(useStore.getState().schemaByConnection.mg1).toBeUndefined();
    });

    it("uses a configured schema and hides the picker when discovery finds none", async () => {
      m.api.getSchemas.mockResolvedValue({ schemas: [] });
      setup();
      fireEvent.click(conn("customers_dev"));
      expect(m.api.getTables).toHaveBeenCalledWith("pg2", "sales");
      await screen.findByText("orders");
      expect(screen.queryByDisplayValue("sales")).toBeNull();
    });

    it("shows a generic schema-discovery failure with no schema chosen", async () => {
      m.api.getSchemas.mockRejectedValueOnce(new Error("catalog locked"));
      setup({ schemaByConnection: { pg1: "" } });
      fireEvent.click(conn("orders_dev"));
      expect(m.api.getTables).toHaveBeenCalledWith("pg1", undefined);
      expect(await screen.findByText("catalog locked")).toBeTruthy();
      expect(screen.getByText("Failed to load tables")).toBeTruthy();
    });

    it("leaves the schema picker empty when no schema is chosen", async () => {
      setup({ schemaByConnection: { pg1: "" } });
      fireEvent.click(conn("orders_dev"));
      await screen.findByText("orders");
      await waitFor(() =>
        expect(
          document.querySelector<HTMLInputElement>(".mantine-Select-input")!
            .value,
        ).toBe(""),
      );
    });

    it("explains a connection failure and retries both loads", async () => {
      m.api.getTables.mockRejectedValueOnce(
        new ApiError("ECONNREFUSED", 503, "CONNECTION_FAILED"),
      );
      m.api.getSchemas.mockRejectedValueOnce(new Error("schemas down"));
      setup();
      fireEvent.click(conn("orders_dev"));
      expect(
        await screen.findByText("Unable to connect to database"),
      ).toBeTruthy();
      expect(screen.getByText("ECONNREFUSED")).toBeTruthy();
      // The table error keeps the alert slot even after the schema error lands.
      await waitFor(() => expect(m.api.getSchemas).toHaveBeenCalled());
      expect(screen.queryByText("schemas down")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(await screen.findByText("orders")).toBeTruthy();
      expect(m.api.getTables).toHaveBeenCalledTimes(2);
      expect(m.api.getSchemas).toHaveBeenCalledTimes(2);
      expect(screen.queryByText("Unable to connect to database")).toBeNull();
    });

    it("shows a schema-discovery failure, and a generic table failure", async () => {
      m.api.getSchemas.mockRejectedValueOnce(
        new ApiError("no access", 403, "FORBIDDEN" as never),
      );
      setup();
      fireEvent.click(conn("orders_dev"));
      expect(await screen.findByText("no access")).toBeTruthy();
      expect(screen.getByText("Failed to load tables")).toBeTruthy();

      m.api.getTables.mockRejectedValueOnce(new Error("boom"));
      fireEvent.click(conn("orders_dev")); // collapse
      fireEvent.click(envTab("QA"));
      fireEvent.click(conn("events_qa"));
      expect(await screen.findByText("boom")).toBeTruthy();
      // Retrying a non-schema engine refetches only its tables.
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(await screen.findByText("orders")).toBeTruthy();
      expect(m.api.getSchemas).toHaveBeenCalledTimes(1);
    });
  });

  describe("tables", () => {
    const expandOrders = async () => {
      setup();
      fireEvent.click(conn("orders_dev"));
      await screen.findByText("orders");
    };

    it("expands a table into its columns and collapses it again", async () => {
      await expandOrders();
      fireEvent.click(tableRow("orders"));
      expect(screen.getByText("Loading columns...")).toBeTruthy();
      expect(await screen.findByText("customer_id")).toBeTruthy();
      expect(m.api.getColumns).toHaveBeenCalledWith("pg1", "orders", "public");
      expect(screen.getByText(/customers\.id/)).toBeTruthy();
      expect(screen.getByText("FK")).toBeTruthy();
      expect(screen.getByText("text")).toBeTruthy();
      fireEvent.click(tableRow("orders"));
      expect(screen.queryByText("customer_id")).toBeNull();
      fireEvent.click(tableRow("orders"));
      expect(screen.getByText("customer_id")).toBeTruthy();
      expect(m.api.getColumns).toHaveBeenCalledTimes(1);
    });

    it.each([
      [
        new ApiError("db unreachable", 503, "CONNECTION_FAILED"),
        "db unreachable",
      ],
      [new Error("bad table"), "Failed to load columns: bad table"],
    ])("notifies when columns fail (%s)", async (err, message) => {
      m.api.getColumns.mockRejectedValueOnce(err);
      await expandOrders();
      fireEvent.click(tableRow("orders"));
      expect(await screen.findByText(message)).toBeTruthy();
      expect(screen.queryByText("customer_id")).toBeNull();
    });

    it("stays quiet when the server itself is unreachable", async () => {
      m.api.getColumns.mockRejectedValueOnce(
        Object.assign(new Error("x"), { code: "SERVER_UNREACHABLE" }),
      );
      await expandOrders();
      fireEvent.click(tableRow("orders"));
      await waitFor(() =>
        expect(screen.queryByText("Loading columns...")).toBeNull(),
      );
      expect(screen.queryByText(/Failed to load columns/)).toBeNull();
    });

    it("double-click opens a schema-qualified preview tab and runs it", async () => {
      await expandOrders();
      fireEvent.doubleClick(tableRow("orders"));
      await waitFor(() => expect(m.api.executeQuery).toHaveBeenCalled());
      expect(m.api.executeQuery.mock.calls[0].slice(0, 2)).toEqual([
        "pg1",
        "SELECT * FROM public.orders LIMIT 100",
      ]);
      await waitFor(() => expect(activeTab().loading).toBe(false));
      expect(activeTab().title).toBe("orders");
      expect(activeTab().result).toEqual({ rows: [], columns: [] });
    });

    it("puts a failed preview's error on the tab", async () => {
      m.api.executeQuery.mockRejectedValueOnce(new Error("permission denied"));
      setup({ activeConnectionId: "mg1" });
      fireEvent.click(conn("events_qa"));
      await screen.findByText("orders");
      fireEvent.doubleClick(tableRow("orders"));
      await waitFor(() => expect(activeTab().error).toBe("permission denied"));
      expect(activeTab().sql).toBe("db.orders.find({})");
      fireEvent.click(tableRow("orders"));
      expect(await screen.findByText("customer_id")).toBeTruthy();
      expect(m.api.getColumns).toHaveBeenCalledWith("mg1", "orders", undefined);
    });

    it("previews Elasticsearch indexes with a search request", async () => {
      setup({ activeConnectionId: "es1" });
      fireEvent.click(conn("logs_prod"));
      await screen.findByText("orders");
      fireEvent.doubleClick(tableRow("orders"));
      await waitFor(() => expect(m.api.executeQuery).toHaveBeenCalled());
      expect(m.api.executeQuery.mock.calls[0][1]).toBe(
        'GET /orders/_search {"query":{"match_all":{}},"size":100}',
      );
    });

    describe("context menu", () => {
      const openMenu = async (via: "right" | "dots" = "right") => {
        if (via === "right")
          fireEvent.contextMenu(tableRow("orders"), {
            clientX: 10,
            clientY: 20,
          });
        else
          fireEvent.click(
            screen.getByRole("button", { name: "Actions for orders" }),
          );
        return screen.findByRole("menu");
      };

      it("previews rows from the menu", async () => {
        await expandOrders();
        await openMenu("dots");
        expect(
          screen
            .getByRole("button", { name: "Actions for orders" })
            .hasAttribute("data-pinned"),
        ).toBe(true);
        fireEvent.click(screen.getByText("View top 100 rows"));
        await waitFor(() => expect(m.api.executeQuery).toHaveBeenCalled());
      });

      it.each([
        ["Copy as JSON", "json"],
        ["Copy as DDL (CREATE TABLE)", "ddl"],
        ["Copy as text", "text"],
      ])("%s fetches columns and copies", async (item) => {
        await expandOrders();
        await openMenu();
        fireEvent.click(screen.getByText(item));
        await waitFor(() => expect(m.copyToClipboard).toHaveBeenCalled());
        expect(m.api.getColumns).toHaveBeenCalledWith(
          "pg1",
          "orders",
          "public",
        );
        expect(m.copyToClipboard.mock.calls[0][0]).toContain("customer_id");
      });

      it("reuses loaded columns, and reports a failed fetch", async () => {
        await expandOrders();
        fireEvent.click(tableRow("orders"));
        await screen.findByText("customer_id");
        await openMenu();
        fireEvent.click(screen.getByText("Copy as text"));
        await waitFor(() => expect(m.copyToClipboard).toHaveBeenCalled());
        expect(m.api.getColumns).toHaveBeenCalledTimes(1);

        m.api.getColumns.mockRejectedValueOnce(new Error("gone"));
        fireEvent.contextMenu(tableRow("order_view"));
        await screen.findByRole("menu");
        fireEvent.click(screen.getByText("Copy as JSON"));
        await waitFor(() =>
          expect(m.notifyError).toHaveBeenCalledWith(
            expect.any(Error),
            "Explorer",
            {
              title: "Failed to copy metadata",
            },
          ),
        );
      });

      it("offers no DDL for document stores, and closes on Escape", async () => {
        setup({ activeConnectionId: "mg1" });
        fireEvent.click(conn("events_qa"));
        await screen.findByText("orders");
        await openMenu();
        expect(screen.queryByText("Copy as DDL (CREATE TABLE)")).toBeNull();
        fireEvent.keyDown(document.querySelector("[role=menu]")!, {
          key: "Escape",
        });
        await waitFor(() =>
          expect(document.querySelector("[role=menu]")).toBeNull(),
        );
      });

      it("copies a schemaless table's metadata", async () => {
        setup({ activeConnectionId: "mg1" });
        fireEvent.click(conn("events_qa"));
        await screen.findByText("orders");
        await openMenu();
        fireEvent.click(screen.getByText("Copy as text"));
        await waitFor(() => expect(m.copyToClipboard).toHaveBeenCalled());
        expect(m.api.getColumns).toHaveBeenCalledWith(
          "mg1",
          "orders",
          undefined,
        );
      });

      it("does nothing if the connection vanished while the menu was open", async () => {
        setup({ activeConnectionId: "mg1" });
        fireEvent.click(conn("events_qa"));
        await screen.findByText("orders");
        await openMenu();
        act(() =>
          useStore.setState({
            connections: CONNS.filter((c) => c.id !== "mg1") as never,
          }),
        );
        expect(screen.queryByText("Copy as DDL (CREATE TABLE)")).toBeNull();
        fireEvent.click(screen.getByText("Copy as JSON"));
        expect(m.api.getColumns).not.toHaveBeenCalled();
        expect(m.copyToClipboard).not.toHaveBeenCalled();
      });

      it("previews a vanished connection's table unqualified", async () => {
        setup({ activeConnectionId: "mg1" });
        fireEvent.click(conn("events_qa"));
        await screen.findByText("orders");
        await openMenu();
        act(() =>
          useStore.setState({
            connections: CONNS.filter((c) => c.id !== "mg1") as never,
          }),
        );
        fireEvent.click(screen.getByText("View top 100 rows"));
        await waitFor(() => expect(m.api.executeQuery).toHaveBeenCalled());
        expect(m.api.executeQuery.mock.calls[0][1]).toBe(
          "SELECT * FROM orders LIMIT 100",
        );
      });
    });
  });

  describe("explorer search", () => {
    it("filters connections by name and loaded tables, and clears", async () => {
      setup();
      fireEvent.click(conn("orders_dev"));
      await screen.findByText("orders");
      fireEvent.click(conn("orders_dev")); // collapse; tables stay cached

      fireEvent.change(search(), { target: { value: "VIEW" } });
      // A table match shows the table under its (collapsed) connection.
      expect(screen.getByText("order_view")).toBeTruthy();
      expect(screen.queryByText("orders")).toBeNull();
      expect(screen.queryByText("customers_dev")).toBeNull();

      fireEvent.change(search(), { target: { value: "orders_dev" } });
      expect(screen.queryByText("order_view")).toBeNull();
      fireEvent.click(conn("orders_dev"));
      // Connection name matches, so all its tables show.
      expect(screen.getByText("orders")).toBeTruthy();
      expect(screen.getByText("order_view")).toBeTruthy();

      fireEvent.change(search(), { target: { value: "nothing-like-this" } });
      expect(screen.getByText("No matching databases or tables")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
      expect(search().value).toBe("");
      expect(screen.getByText("customers_dev")).toBeTruthy();
    });
  });

  describe("pins", () => {
    const pins = (ids: string[]) => ({ connectionPins: { u1: ids } });

    it("pins and unpins a connection without selecting it", () => {
      setup({ activeConnectionId: null });
      fireEvent.click(
        screen.getByRole("button", { name: "Pin customers_dev" }),
      );
      expect(useStore.getState().connectionPins.u1).toEqual(["pg2"]);
      expect(useStore.getState().activeConnectionId).toBeNull();
      const unpin = screen.getByRole("button", { name: "Unpin customers_dev" });
      expect(unpin.getAttribute("aria-keyshortcuts")).toBe(
        "Alt+ArrowUp Alt+ArrowDown",
      );
      fireEvent.click(unpin);
      expect(useStore.getState().connectionPins.u1).toEqual([]);
    });

    it("reorders pinned rows by drag and drop", () => {
      setup({ activeConnectionId: "ms1", ...pins(["ms1", "ms2"]) });
      const first = conn("billing_qa");
      const second = conn("ledger_qa");
      const unpinned = conn("events_qa");
      const dataTransfer = { setData: vi.fn(), effectAllowed: "" };
      expect(second.getAttribute("draggable")).toBe("true");
      expect(unpinned.getAttribute("draggable")).toBe("false");

      // Unpinned rows neither drag nor accept a drop.
      fireEvent.dragStart(unpinned, { dataTransfer });
      expect(dataTransfer.setData).not.toHaveBeenCalled();

      fireEvent.dragStart(second, { dataTransfer });
      expect(dataTransfer.setData).toHaveBeenCalledWith("text/plain", "ms2");
      expect(second.style.opacity).toBe("0.5");
      fireEvent.dragOver(unpinned);
      fireEvent.drop(unpinned);
      expect(useStore.getState().connectionPins.u1).toEqual(["ms1", "ms2"]);
      fireEvent.dragOver(first);
      expect(first.style.boxShadow).toBe("0 -2px 0 var(--accent)");
      fireEvent.drop(first);
      expect(useStore.getState().connectionPins.u1).toEqual(["ms2", "ms1"]);
      fireEvent.dragEnd(second);
      expect(conn("ledger_qa").style.opacity).toBe("1");
    });

    it("shows the drop edge below when dragging down", () => {
      setup({ activeConnectionId: null, ...pins(["ms1", "ms2"]) });
      fireEvent.click(envTab("QA"));
      fireEvent.dragStart(conn("billing_qa"), {
        dataTransfer: { setData: vi.fn() },
      });
      fireEvent.dragOver(conn("ledger_qa"));
      expect(conn("ledger_qa").style.boxShadow).toBe("0 2px 0 var(--accent)");
    });

    it("nudges a pinned row with Alt+Arrow keys", () => {
      const raf = vi
        .spyOn(window, "requestAnimationFrame")
        .mockImplementation((cb) => {
          cb(0);
          return 0;
        });
      setup({ activeConnectionId: "ms1", ...pins(["ms1", "ms2"]) });
      const btn = () =>
        screen.getByRole("button", { name: "Unpin billing_qa" });
      fireEvent.keyDown(btn(), { key: "ArrowDown" });
      fireEvent.keyDown(btn(), { key: "Enter", altKey: true });
      fireEvent.keyDown(btn(), { key: "ArrowUp", altKey: true }); // already first
      expect(useStore.getState().connectionPins.u1).toEqual(["ms1", "ms2"]);
      fireEvent.keyDown(btn(), { key: "ArrowDown", altKey: true });
      expect(useStore.getState().connectionPins.u1).toEqual(["ms2", "ms1"]);
      expect(document.activeElement).toBe(btn());
      fireEvent.keyDown(screen.getByRole("button", { name: "Pin events_qa" }), {
        key: "ArrowUp",
        altKey: true,
      });
      expect(useStore.getState().connectionPins.u1).toEqual(["ms2", "ms1"]);
      raf.mockRestore();
    });
  });

  describe("saved", () => {
    const artifacts = [
      {
        id: "a1",
        title: "Order health",
        description: "weekly",
        blocks: [{ type: "sql" }, { type: "text" }],
        createdByEmail: "me@example.com",
      },
      {
        id: "a2",
        title: "Customer churn",
        blocks: [{ type: "sql" }, { type: "sql" }],
        createdByEmail: "other@example.com",
      },
    ];
    const savedQueries = [
      {
        id: "s1",
        name: "Open orders",
        sql: "  select * from orders  ",
        connectionId: "ms1",
      },
      { id: "s2", name: "Top customers", sql: "select * from customers" },
    ];
    const openSaved = (
      state: Record<string, unknown> = { artifacts, savedQueries },
    ) => {
      setup(state);
      fireEvent.click(screen.getByRole("button", { name: "Saved, 4" }));
    };

    it("lists artifacts and saved queries and filters them", () => {
      openSaved();
      expect(screen.getByText("1 query · me@example.com")).toBeTruthy();
      expect(screen.getByText("2 queries · other@example.com")).toBeTruthy();
      expect(screen.getByText("select * from orders")).toBeTruthy();
      expect(search().placeholder).toBe("Search saved queries...");
      fireEvent.change(search(), { target: { value: "WEEKLY" } });
      expect(screen.getByText("Order health")).toBeTruthy();
      expect(screen.queryByText("Customer churn")).toBeNull();
      expect(screen.queryByText("Open orders")).toBeNull();
      fireEvent.change(search(), { target: { value: "customers" } });
      expect(screen.getByText("Top customers")).toBeTruthy();
      // Each section keeps its own search.
      fireEvent.click(screen.getByRole("button", { name: "Explorer" }));
      expect(search().value).toBe("");
    });

    it("opens an artifact and copies its link", () => {
      openSaved();
      fireEvent.click(screen.getByText("Order health"));
      expect(
        useStore.getState().tabs.some((t) => t.title === "Order health"),
      ).toBe(true);
      const row = screen
        .getByText("Customer churn")
        .closest(".dp-row") as HTMLElement;
      const buttons = within(row).getAllByRole("button");
      expect(buttons).toHaveLength(1); // not the author: no archive
      fireEvent.click(buttons[0]);
      expect(m.copyArtifactShareLink).toHaveBeenCalledWith(artifacts[1]);
    });

    it("archives your own artifact, and reports a failure", async () => {
      m.api.setArtifactArchived
        .mockRejectedValueOnce(new Error("nope"))
        .mockResolvedValueOnce(undefined);
      openSaved();
      const archive = () =>
        within(
          screen.getByText("Order health").closest(".dp-row") as HTMLElement,
        ).getAllByRole("button")[1];
      fireEvent.click(archive());
      await waitFor(() =>
        expect(m.notifyError).toHaveBeenCalledWith(
          expect.any(Error),
          "Explorer",
        ),
      );
      fireEvent.click(archive());
      expect(
        await screen.findByText("Artifact archived — it can be restored"),
      ).toBeTruthy();
      expect(m.api.setArtifactArchived).toHaveBeenCalledWith("a1", true);
      expect(useStore.getState().artifacts.map((a) => a.id)).toEqual(["a2"]);
    });

    it("opens a saved query in a new tab", async () => {
      openSaved();
      fireEvent.click(screen.getByText("Open orders"));
      await waitFor(() => expect(activeTab().title).toBe("Open orders"));
      expect(activeTab().sql).toBe("  select * from orders  ");
      expect(activeTab().connectionId).toBe("ms1");
      fireEvent.click(screen.getByText("Top customers"));
      await waitFor(() => expect(activeTab().title).toBe("Top customers"));
      expect(activeTab().connectionId).toBe("pg1");
    });

    it("copies and deletes saved queries", async () => {
      m.api.deleteSavedQuery
        .mockRejectedValueOnce(new Error("locked"))
        .mockResolvedValueOnce(undefined);
      openSaved();
      const buttons = () =>
        within(
          screen.getByText("Top customers").closest(".dp-row") as HTMLElement,
        ).getAllByRole("button");
      fireEvent.click(buttons()[0]);
      expect(m.copySavedQueryShareLink).toHaveBeenCalledWith(savedQueries[1]);
      fireEvent.click(buttons()[1]);
      await waitFor(() => expect(m.notifyError).toHaveBeenCalled());
      fireEvent.click(buttons()[1]);
      expect(await screen.findByText("Query deleted")).toBeTruthy();
      expect(useStore.getState().savedQueries.map((q) => q.id)).toEqual(["s1"]);
    });

    it("has an empty state", () => {
      setup();
      fireEvent.click(screen.getByRole("button", { name: "Saved" }));
      expect(screen.getByText("No saved queries yet")).toBeTruthy();
    });
  });

  describe("history", () => {
    const entry = (id: number, extra: Record<string, unknown> = {}) => ({
      id,
      sql: `select ${id} from orders`,
      connectionId: "ms1",
      rowsReturned: 5,
      executionMs: 12,
      timestamp: "2026-01-01T00:00:00Z",
      ...extra,
    });

    it("loads once, pages with Load more, filters, and opens an entry", async () => {
      const page1 = Array.from({ length: 50 }, (_, i) => entry(i + 1));
      let finish!: (v: unknown) => void;
      m.api.getQueryHistory
        .mockResolvedValueOnce(page1)
        .mockReturnValueOnce(new Promise((r) => (finish = r)));
      setup();
      fireEvent.click(screen.getByRole("button", { name: "History" }));
      expect(await screen.findByText("select 1 from orders")).toBeTruthy();
      expect(m.api.getQueryHistory).toHaveBeenCalledWith(50, 0);
      expect(screen.getAllByText("5 rows")).toHaveLength(50);
      expect(screen.getAllByText("12ms")).toHaveLength(50);

      const more = screen.getByRole("button", { name: "Load more" });
      fireEvent.click(more);
      // Guarded while the first page is in flight. The button is disabled
      // now, so call its handler directly.
      act(() => propsWith(more, "onClick").onClick());
      expect(m.api.getQueryHistory).toHaveBeenCalledTimes(2);
      expect(m.api.getQueryHistory).toHaveBeenLastCalledWith(50, 50);
      await act(async () =>
        finish([
          entry(51, { sql: null, rowsReturned: null, executionMs: null }),
        ]),
      );
      expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();

      // Switching away and back does not reload.
      fireEvent.click(screen.getByRole("button", { name: "Explorer" }));
      fireEvent.click(screen.getByRole("button", { name: "History" }));
      expect(m.api.getQueryHistory).toHaveBeenCalledTimes(2);

      expect(search().placeholder).toBe("Search history...");
      fireEvent.change(search(), { target: { value: "SELECT 7 " } });
      expect(screen.getByText("select 7 from orders")).toBeTruthy();
      expect(screen.queryByText("select 8 from orders")).toBeNull();
      fireEvent.click(screen.getByText("select 7 from orders"));
      await waitFor(() => expect(activeTab().sql).toBe("select 7 from orders"));
      expect(activeTab().connectionId).toBe("ms1");
    });

    it("falls back to the active connection, and shows an empty state on failure", async () => {
      m.api.getQueryHistory.mockRejectedValueOnce(new Error("down"));
      setup();
      fireEvent.click(screen.getByRole("button", { name: "History" }));
      await waitFor(() => expect(m.api.getQueryHistory).toHaveBeenCalled());
      expect(screen.getByText("No query history yet")).toBeTruthy();
    });

    it("opens an entry without a connection on the active one", async () => {
      m.api.getQueryHistory.mockResolvedValueOnce([
        entry(1, { connectionId: undefined }),
      ]);
      setup();
      fireEvent.click(screen.getByRole("button", { name: "History" }));
      fireEvent.click(await screen.findByText("select 1 from orders"));
      await waitFor(() => expect(activeTab().sql).toBe("select 1 from orders"));
      expect(activeTab().connectionId).toBe("pg1");
    });

    it("exports a date range as CSV and reports a refusal", async () => {
      m.api.exportQueryHistory
        .mockResolvedValueOnce("id,sql\n")
        .mockRejectedValueOnce(new Error("too wide"));
      setup();
      fireEvent.click(screen.getByRole("button", { name: "History" }));
      const toggle = screen.getByRole("button", { name: "Export CSV" });
      fireEvent.click(toggle);
      const from = (await screen.findByLabelText("From")) as HTMLInputElement;
      const to = screen.getByLabelText("To") as HTMLInputElement;
      fireEvent.change(from, { target: { value: "2026-01-01" } });
      fireEvent.change(to, { target: { value: "2026-01-10" } });
      fireEvent.click(download());
      await waitFor(() =>
        expect(m.downloadTextFile).toHaveBeenCalledWith(
          "query-history-2026-01-01-to-2026-01-10.csv",
          "id,sql\n",
        ),
      );
      expect(m.api.exportQueryHistory).toHaveBeenCalledWith(
        "2026-01-01",
        "2026-01-10",
      );
      await waitFor(() => expect(screen.queryByLabelText("From")).toBeNull());

      fireEvent.click(toggle);
      fireEvent.change(await screen.findByLabelText("To"), {
        target: { value: "" },
      });
      expect(download().disabled).toBe(true);
      fireEvent.change(screen.getByLabelText("To"), {
        target: { value: "2026-03-01" },
      });
      fireEvent.click(download());
      await waitFor(() =>
        expect(m.notifyError).toHaveBeenCalledWith(
          expect.any(Error),
          "Explorer",
          { title: "Export failed" },
        ),
      );
      expect(screen.getByLabelText("From")).toBeTruthy();
    });
  });
});
