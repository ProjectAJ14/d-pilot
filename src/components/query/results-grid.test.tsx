// @vitest-environment jsdom
import type { ComponentType } from "react";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderUi } from "../../utils/dom.testing";
import { useStore } from "../../store";
import type { QueryResult, QueryTab } from "../../types";
import { ResultsGrid } from "./results-grid";

/* ---------- fakes ---------- */

type Any = any;

let gridProps: Any;
let gridInstance: { api?: Any } | null;

vi.mock("ag-grid-community", () => ({
  AllCommunityModule: {},
  ModuleRegistry: { registerModules: () => {} },
  themeQuartz: { withParams: (p: object) => p },
}));
vi.mock("ag-grid-enterprise", () => ({
  CellSelectionModule: {},
  ClipboardModule: {},
}));
vi.mock("ag-grid-react", () => ({
  AgGridReact: (props: Any) => {
    gridProps = props;
    props.ref.current = gridInstance;
    return (
      <div data-testid="grid">
        {props.columnDefs.map((c: Any) => {
          const id = c.colId ?? c.field;
          const Header = c.headerComponent as ComponentType<Any> | undefined;
          return (
            <div key={id}>
              <div className="ag-header-cell" data-testid={`h-${id}`}>
                {Header ? (
                  <Header
                    displayName={c.headerName}
                    {...c.headerComponentParams}
                  />
                ) : (
                  <span className="ag-header-cell-text">{c.headerName}</span>
                )}
              </div>
              <div className="ag-cell" col-id={id} data-testid={`c-${id}`} />
            </div>
          );
        })}
        <div className="ag-header-cell" data-testid="h-empty" />
        <div
          className="ag-cell"
          col-id="ag-Grid-SelectionColumn"
          data-testid="c-select"
        />
        <div className="ag-cell" data-testid="c-noid" />
        <div data-testid="blank" />
      </div>
    );
  },
}));

const copyToClipboard = vi.fn();
vi.mock("../../utils/clipboard", () => ({
  copyToClipboard: (...a: unknown[]) => copyToClipboard(...a),
}));

const reportUrl = vi.fn((_f: unknown) => "https://issues.example/new");
vi.mock("../../utils/notify-error", () => ({
  reportUrl: (f: unknown) => reportUrl(f),
}));

// One extra format with no group/example, to exercise the menu's fallbacks.
vi.mock("../../utils/data-extractors", async (orig) => {
  const real = await orig<typeof import("../../utils/data-extractors")>();
  return {
    ...real,
    DEFAULT_COPY_FORMATS: [
      ...real.DEFAULT_COPY_FORMATS,
      { id: "plain", label: "Plainly", builtin: "csv", columnMenu: true },
    ],
  };
});

vi.mock("./cell-detail-drawer", () => ({
  CellDetailDrawer: ({ detail, onClose }: Any) =>
    detail ? (
      <div className="mantine-Drawer-content" data-testid="drawer">
        {detail.column}:{String(detail.isMasked)}
        <button onClick={onClose}>close drawer</button>
      </div>
    ) : null,
}));
vi.mock("./results-json-view", () => ({
  ResultsJsonView: ({ rows }: Any) => (
    <div data-testid="json-view">{rows.length}</div>
  ),
}));

/* ---------- fixtures ---------- */

const result = (over: Partial<QueryResult> = {}): QueryResult => ({
  columns: [
    { name: "id", type: "int", isMasked: false },
    {
      name: "customer_id",
      type: "int",
      isMasked: false,
      references: "customers.id",
    },
    { name: "email", type: "text", isMasked: true },
  ],
  rows: [
    { id: 1, customer_id: 7, email: "***" },
    { id: 2, customer_id: 8, email: "***" },
  ],
  totalRows: 2,
  executionTimeMs: 12,
  masked: false,
  maskedFields: [],
  connectionId: "c1",
  truncated: false,
  ...over,
});

const tab = (over: Partial<QueryTab> = {}): QueryTab => ({
  id: "t1",
  title: "Query",
  sql: "SELECT 1",
  connectionId: "c1",
  result: result(),
  loading: false,
  error: null,
  ...over,
});

const col = (field: string) =>
  gridProps.columnDefs.find((c: Any) => c.field === field);

const LONG = "x".repeat(40);

beforeEach(() => {
  gridProps = undefined;
  gridInstance = {
    api: {
      getSelectedRows: () => [],
      getCellRanges: () => [],
      getDisplayedRowAtIndex: (i: number) =>
        i < 2 ? { data: result().rows[i] } : undefined,
    },
  };
  copyToClipboard.mockReset();
  reportUrl.mockClear();
  useStore.setState({
    phiEnabled: true,
    connections: [
      { id: "c1", name: "app", env: "PROD", type: "postgres" },
    ] as Any,
    tabs: [tab()],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

/* ---------- tests ---------- */

describe("ResultsGrid states", () => {
  it("prompts before any query has run", () => {
    renderUi(<ResultsGrid tab={tab({ result: null })} />);
    expect(screen.getByText("Run a query to see results here")).toBeTruthy();
  });

  it("shows an error with a report link built from data-free fields", () => {
    renderUi(<ResultsGrid tab={tab({ error: "boom", errorCode: "42P01" })} />);
    expect(screen.getByText("boom")).toBeTruthy();
    expect(
      screen.getByText("Report issue").closest("a")!.getAttribute("href"),
    ).toBe("https://issues.example/new");
    expect(reportUrl).toHaveBeenCalledWith({
      where: "Query",
      message: "boom",
      code: "42P01",
      dbType: "postgres",
      production: true,
    });
  });

  it("omits connection details when the connection is gone", () => {
    renderUi(<ResultsGrid tab={tab({ error: "boom", connectionId: "x" })} />);
    expect(reportUrl).toHaveBeenCalledWith(
      expect.objectContaining({ dbType: undefined, production: undefined }),
    );
  });

  it("offers no report link for a refusal", () => {
    renderUi(
      <ResultsGrid tab={tab({ error: "denied", errorReportable: false })} />,
    );
    expect(screen.getByText("denied")).toBeTruthy();
    expect(screen.queryByText("Report issue")).toBeNull();
  });

  it("shows masking and truncation badges plus the PHI audit bar", () => {
    const masked = result({
      masked: true,
      maskedFields: ["email", "phone"],
      truncated: true,
    });
    const { unmount } = renderUi(<ResultsGrid tab={tab({ result: masked })} />);
    expect(screen.getByText("2 PHI fields masked")).toBeTruthy();
    expect(screen.getByText("truncated")).toBeTruthy();
    expect(screen.getByText(/All PHI fields masked/)).toBeTruthy();
    expect(screen.getByText("email, phone")).toBeTruthy();
    unmount();

    useStore.setState({ phiEnabled: false });
    renderUi(<ResultsGrid tab={tab({ result: masked })} />);
    expect(screen.getByText(/PHI shield OFF/)).toBeTruthy();
  });

  it("hides Copy as when there are no rows", () => {
    renderUi(<ResultsGrid tab={tab({ result: result({ rows: [] }) })} />);
    expect(screen.queryByText("Copy as")).toBeNull();
  });

  it("switches to the JSON view through the store or the override", () => {
    const { unmount } = renderUi(<ResultsGrid tab={tab()} />);
    fireEvent.click(screen.getAllByRole("radio")[1]);
    expect(useStore.getState().tabs[0].viewMode).toBe("json");
    unmount();

    const onViewModeChange = vi.fn();
    renderUi(<ResultsGrid tab={tab()} onViewModeChange={onViewModeChange} />);
    fireEvent.click(screen.getAllByRole("radio")[1]);
    expect(onViewModeChange).toHaveBeenCalledWith("json");
  });

  it("renders the JSON view without the table hints", () => {
    renderUi(<ResultsGrid tab={tab({ viewMode: "json" })} />);
    expect(screen.getByTestId("json-view").textContent).toBe("2");
    expect(screen.queryByText("hover to peek")).toBeNull();
    expect(screen.queryByText("Copy as")).toBeNull();
  });
});

describe("ResultsGrid column definitions", () => {
  it("builds a row-number column, FK headers and a masked renderer", () => {
    renderUi(<ResultsGrid tab={tab()} />);
    const defs = gridProps.columnDefs;
    expect(defs.map((d: Any) => d.headerName)).toEqual([
      "#",
      "id",
      "customer_id",
      "email 🔐",
    ]);
    expect(col("customer_id").headerComponentParams).toEqual({
      column: "customer_id",
      references: "customers.id",
    });
    // The FK header renders the chip next to the plain name.
    expect(screen.getByTestId("h-customer_id").textContent).toBe(
      "customer_idFK",
    );
    const email = col("email");
    expect(email.filter).toBe(false);
    expect(email.sortable).toBe(false);
    expect(email.valueFormatter).toBeUndefined();
    const Phi = email.cellRenderer;
    renderUi(
      <div data-testid="phi">
        <Phi value="***" />
        <Phi />
      </div>,
    );
    expect(screen.getByTestId("phi").textContent).toBe("***");
  });

  it("falls back to the display name when an FK header has no column param", () => {
    renderUi(<ResultsGrid tab={tab()} />);
    const Header = col("customer_id").headerComponent;
    renderUi(<Header displayName="alias_col" />);
    expect(screen.getByText("alias_col")).toBeTruthy();
  });

  it("formats, colours and previews values by type", () => {
    renderUi(<ResultsGrid tab={tab()} />);
    const { cellStyle, valueFormatter, tooltipValueGetter } = col("id");
    expect(cellStyle({ value: null })).toEqual({
      color: "var(--muted)",
      fontStyle: "italic",
    });
    expect(cellStyle({ value: 3 })).toEqual({ color: "var(--accent-text)" });
    expect(cellStyle({ value: true })).toEqual({ color: "var(--success)" });
    expect(cellStyle({ value: false })).toEqual({ color: "var(--error)" });
    expect(cellStyle({ value: "2024-01-02" })).toEqual({
      color: "var(--type-special)",
    });
    expect(cellStyle({ value: "abc" })).toEqual({});

    expect(valueFormatter({ value: undefined })).toBe("NULL");
    expect(valueFormatter({ value: { a: 1 } })).toBe('{"a":1}');
    expect(valueFormatter({ value: 5 })).toBe("5");

    expect(tooltipValueGetter({ value: null })).toBe("NULL");
    expect(tooltipValueGetter({ value: [1] })).toBe("[1]");
    expect(tooltipValueGetter({ value: "short" })).toBe("short");
    expect(tooltipValueGetter({ value: "y".repeat(2500) })).toBe(
      "y".repeat(2000) + "… (click cell for full value)",
    );
  });

  it("keys rows by their position", () => {
    renderUi(<ResultsGrid tab={tab()} />);
    expect(gridProps.rowData.map((r: Any) => r._agRowId)).toEqual(["0", "1"]);
    expect(gridProps.getRowId({ data: { _agRowId: "1" } })).toBe("1");
    expect(gridProps.getRowId({ data: {} })).toBe("0");
  });
});

describe("ResultsGrid cell inspector", () => {
  const click = (field: string | undefined, value: unknown) =>
    act(() => gridProps.onCellClicked({ colDef: { field }, value }));
  const dbl = (headerName: string | undefined, value: unknown) =>
    act(() => gridProps.onCellDoubleClicked({ colDef: { headerName }, value }));

  it("opens long values after the double-click window", () => {
    vi.useFakeTimers();
    renderUi(<ResultsGrid tab={tab()} />);
    click(undefined, LONG); // row-number column: ignored
    click("email", LONG);
    expect(screen.queryByTestId("drawer")).toBeNull();
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByTestId("drawer").textContent).toContain("email:true");

    // A short value dismisses it.
    click("id", 5);
    expect(screen.queryByTestId("drawer")).toBeNull();

    // Objects are measured as JSON; unknown columns are not masked.
    click("other", { k: LONG });
    click("other", { k: LONG }); // re-click restarts the timer
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByTestId("drawer").textContent).toContain("other:false");

    click("id", null);
    expect(screen.queryByTestId("drawer")).toBeNull();
  });

  it("double-click copies the value instead of opening the inspector", () => {
    vi.useFakeTimers();
    renderUi(<ResultsGrid tab={tab()} />);
    click("id", LONG);
    dbl("id", LONG);
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.queryByTestId("drawer")).toBeNull();
    expect(copyToClipboard).toHaveBeenLastCalledWith(LONG, '"id"');

    dbl("payload", { a: 1 });
    expect(copyToClipboard).toHaveBeenLastCalledWith('{"a":1}', '"payload"');
    dbl("id", undefined);
    expect(copyToClipboard).toHaveBeenLastCalledWith("NULL", '"id"');
    dbl(undefined, 3);
    expect(copyToClipboard).toHaveBeenLastCalledWith("3", '""');
    copyToClipboard.mockClear();
    dbl("#", 1);
    expect(copyToClipboard).not.toHaveBeenCalled();
  });

  it("closes from its own button and on clicks away from data cells", () => {
    vi.useFakeTimers();
    renderUi(<ResultsGrid tab={tab()} />);
    const open = () => {
      click("email", LONG);
      act(() => vi.advanceTimersByTime(500));
      expect(screen.getByTestId("drawer")).toBeTruthy();
    };
    open();
    fireEvent.click(screen.getByText("close drawer"));
    expect(screen.queryByTestId("drawer")).toBeNull();

    open();
    fireEvent.mouseDown(screen.getByTestId("drawer"));
    fireEvent.mouseDown(screen.getByTestId("c-id"));
    expect(screen.getByTestId("drawer")).toBeTruthy();

    for (const id of ["c-__rownum", "c-noid", "blank"]) {
      fireEvent.mouseDown(screen.getByTestId(id));
      expect(screen.queryByTestId("drawer")).toBeNull();
      open();
    }
  });

  it("cancels a pending open on unmount", () => {
    vi.useFakeTimers();
    const clear = vi.spyOn(window, "clearTimeout");
    const { unmount } = renderUi(<ResultsGrid tab={tab()} />);
    click("email", LONG);
    unmount();
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });
});

describe("ResultsGrid copying", () => {
  it("double-clicking a header copies the bare column name", () => {
    renderUi(<ResultsGrid tab={tab()} />);
    fireEvent.doubleClick(screen.getByText("email 🔐"));
    expect(copyToClipboard).toHaveBeenLastCalledWith("email", "column");
    copyToClipboard.mockClear();
    fireEvent.doubleClick(screen.getByText("#"));
    fireEvent.doubleClick(screen.getByTestId("h-empty"));
    fireEvent.doubleClick(screen.getByTestId("blank"));
    expect(copyToClipboard).not.toHaveBeenCalled();
  });

  it("right-click opens a per-column copy menu only on real columns", async () => {
    renderUi(<ResultsGrid tab={tab()} />);
    for (const id of ["c-__rownum", "c-select", "c-noid", "h-empty", "blank"]) {
      fireEvent.contextMenu(screen.getByTestId(id));
    }
    fireEvent.contextMenu(screen.getByText("#"));
    expect(screen.queryByText(/Copy column/)).toBeNull();

    fireEvent.contextMenu(screen.getByTestId("c-id"));
    expect(await screen.findByText("Copy column “id”")).toBeTruthy();
    fireEvent.click(screen.getByText("CSV"));
    expect(copyToClipboard).toHaveBeenLastCalledWith("id\n1\n2", "id (CSV)");
    await waitFor(() => expect(screen.queryByText(/Copy column/)).toBeNull());

    fireEvent.contextMenu(screen.getByText("email 🔐"));
    expect(await screen.findByText("Copy column “email”")).toBeTruthy();
    fireEvent.click(screen.getByText("Plainly"));
    expect(copyToClipboard).toHaveBeenLastCalledWith(
      "email\n***\n***",
      "email (Plainly)",
    );
  });

  it("closes the column menu with Escape without copying", async () => {
    renderUi(<ResultsGrid tab={tab()} />);
    fireEvent.contextMenu(screen.getByTestId("c-id"));
    const label = await screen.findByText("Copy column “id”");
    fireEvent.keyDown(label, { key: "Escape" });
    // An item clicked while the menu animates out copies nothing.
    fireEvent.click(screen.getByText("CSV"));
    await waitFor(() => expect(screen.queryByText(/Copy column/)).toBeNull());
    expect(copyToClipboard).not.toHaveBeenCalled();
  });

  it("labels Copy as by the ticked rows and copies only those", async () => {
    const picked = [{ id: 2, customer_id: 8, email: "***" }];
    gridInstance!.api.getSelectedRows = () => picked;
    renderUi(<ResultsGrid tab={tab()} />);
    act(() => gridProps.onSelectionChanged({ api: gridInstance!.api }));
    expect(screen.getByText("Copy 1 rows as")).toBeTruthy();

    fireEvent.click(screen.getByText("Copy 1 rows as"));
    expect(await screen.findByText("Other")).toBeTruthy();
    fireEvent.click(screen.getByText("CSV"));
    expect(copyToClipboard).toHaveBeenLastCalledWith(
      "id,customer_id,email\n2,8,***",
      "CSV",
    );

    fireEvent.contextMenu(screen.getByTestId("c-id"));
    expect(await screen.findByText("Copy column “id” · 1 rows")).toBeTruthy();
  });

  it("copies the selected cell range, in grid order", async () => {
    const ranges = [
      {
        columns: [
          { getColId: () => "customer_id" },
          { getColId: () => "__rownum" },
          { getColId: () => "ag-Grid-SelectionColumn" },
          { getColId: () => "" },
        ],
        startRow: { rowIndex: 1 },
        endRow: { rowIndex: 0 },
      },
      { columns: [{ getColId: () => "id" }] }, // no row bounds
      {
        columns: [{ getColId: () => "id" }],
        startRow: { rowIndex: 5 },
        endRow: { rowIndex: 5 }, // not displayed
      },
    ];
    gridInstance!.api.getCellRanges = () => ranges;
    renderUi(<ResultsGrid tab={tab()} />);
    act(() =>
      gridProps.onCellSelectionChanged({
        api: { getCellRanges: () => ranges },
      }),
    );
    expect(screen.getByText("Copy 3×2 as")).toBeTruthy();
    fireEvent.click(screen.getByText("Copy 3×2 as"));
    fireEvent.click(await screen.findByText("TSV"));
    expect(copyToClipboard).toHaveBeenLastCalledWith(
      "id\tcustomer_id\n1\t7\n2\t8",
      "TSV",
    );
  });

  it("resets the range label when the selection empties or has no real cells", () => {
    renderUi(<ResultsGrid tab={tab()} />);
    const select = (r: unknown) =>
      act(() =>
        gridProps.onCellSelectionChanged({ api: { getCellRanges: () => r } }),
      );
    select([
      {
        columns: [{ getColId: () => "id" }],
        startRow: { rowIndex: 0 },
        endRow: { rowIndex: 0 },
      },
    ]);
    expect(screen.getByText("Copy 1×1 as")).toBeTruthy();
    select(null);
    expect(screen.getByText("Copy as")).toBeTruthy();
    select([{ columns: [{ getColId: () => "__rownum" }] }]);
    expect(screen.getByText("Copy as")).toBeTruthy();
  });

  it("falls back to every row when a range has no usable cells", async () => {
    gridInstance!.api.getCellRanges = () => [
      { columns: [{ getColId: () => "__rownum" }] },
    ];
    renderUi(<ResultsGrid tab={tab()} />);
    fireEvent.click(screen.getByText("Copy as"));
    fireEvent.click(await screen.findByText("Comma-separated"));
    expect(copyToClipboard).toHaveBeenLastCalledWith(
      "1,7,***,2,8,***",
      "Comma-separated",
    );
  });

  it("copies every row when the grid API is not ready", async () => {
    gridInstance = null;
    renderUi(<ResultsGrid tab={tab()} />);
    fireEvent.click(screen.getByText("Copy as"));
    fireEvent.click(await screen.findByText("CSV"));
    expect(copyToClipboard).toHaveBeenLastCalledWith(
      "id,customer_id,email\n1,7,***\n2,8,***",
      "CSV",
    );
  });

  it("copies every row when the API lacks selection methods", async () => {
    gridInstance = { api: {} };
    renderUi(<ResultsGrid tab={tab()} />);
    fireEvent.click(screen.getByText("Copy as"));
    fireEvent.click(await screen.findByText("CSV"));
    expect(copyToClipboard).toHaveBeenLastCalledWith(
      "id,customer_id,email\n1,7,***\n2,8,***",
      "CSV",
    );
  });
});
