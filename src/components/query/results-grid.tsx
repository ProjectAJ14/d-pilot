import {
  useMemo,
  useCallback,
  useRef,
  useEffect,
  useState,
  Fragment,
} from "react";
import {
  Text,
  Badge,
  SegmentedControl,
  Menu,
  Button,
  useComputedColorScheme,
} from "@mantine/core";
import {
  IconShieldLock,
  IconAlertTriangle,
  IconTable,
  IconBraces,
  IconEye,
  IconClick,
  IconCopyCheck,
  IconCopy,
  IconChevronDown,
} from "@tabler/icons-react";
import { AgGridReact } from "ag-grid-react";
import type {
  ColDef,
  CellClassParams,
  GetRowIdParams,
  CellDoubleClickedEvent,
  CellClickedEvent,
} from "ag-grid-community";
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
} from "ag-grid-community";
// Enterprise: Excel-style cell (range) selection + native range copy. Running
// WITHOUT a license key — AG Grid prints a console warning and shows a watermark.
// Acceptable for internal/dev use; a license is required to ship this cleanly.
import { CellSelectionModule, ClipboardModule } from "ag-grid-enterprise";
import { useStore } from "../../store";
import type { QueryTab, ResultViewMode } from "../../types";
import { ResultsJsonView } from "./results-json-view";
import { CellDetailDrawer, type CellDetail } from "./cell-detail-drawer";
import { GridCellTooltip } from "./grid-cell-tooltip";
import { copyToClipboard } from "../../utils/clipboard";
import {
  renderCopyFormat,
  DEFAULT_COPY_FORMATS,
} from "../../utils/data-extractors";
import type { CopyFormat } from "../../types";
import { FkBadge } from "./fk-badge";

ModuleRegistry.registerModules([
  AllCommunityModule,
  CellSelectionModule,
  ClipboardModule,
]);

/** Group the configured formats by their `group`, preserving first-seen order. */
function groupFormats(formats: CopyFormat[]): [string, CopyFormat[]][] {
  const groups = new Map<string, CopyFormat[]>();
  for (const f of formats) {
    const key = f.group ?? "Other";
    const bucket = groups.get(key);
    if (bucket) bucket.push(f);
    else groups.set(key, [f]);
  }
  return [...groups.entries()];
}

/**
 * AG Grid renders into its own CSS-variable namespace and does NOT inherit the
 * app's `--surface`/`--text` tokens, so the grid needs its own light and dark
 * definitions. These values must stay in step with `src/styles/global.css`.
 *
 * The mode is selected by `data-ag-theme-mode` on <html> — see `useAgThemeMode`
 * below. Params shared by both schemes go in the un-scoped `withParams` call.
 */
const sharedGridParams = {
  headerFontSize: 11,
  headerFontWeight: 700,
  fontSize: 12,
  fontFamily: "IBM Plex Mono, monospace",
  spacing: 6,
  wrapperBorderRadius: 0,
};

const gridTheme = themeQuartz
  .withParams(sharedGridParams)
  .withParams(
    {
      accentColor: "#1f9196",
      backgroundColor: "#FFFFFF",
      borderColor: "#ccd0d2",
      browserColorScheme: "light",
      chromeBackgroundColor: "#f3f6f7",
      foregroundColor: "#0c2340",
      headerBackgroundColor: "#f3f6f7",
      rowHoverColor: "rgba(12, 35, 64, 0.045)",
      selectedRowBackgroundColor: "rgba(31, 145, 150, 0.12)",
      rowBorder: { color: "#e8e8e8", style: "solid", width: 1 },
      columnBorder: { color: "#e8e8e8", style: "solid", width: 1 },
    },
    "light",
  )
  .withParams(
    {
      accentColor: "#43d0d6",
      backgroundColor: "#121e2a",
      borderColor: "#2a3b4a",
      browserColorScheme: "dark",
      chromeBackgroundColor: "#182633",
      foregroundColor: "#e4ebf1",
      headerBackgroundColor: "#182633",
      rowHoverColor: "rgba(255, 255, 255, 0.055)",
      selectedRowBackgroundColor: "rgba(67, 208, 214, 0.16)",
      // On dark the row grid lines have to be lighter than the surface, not
      // darker, or the table reads as a solid block.
      rowBorder: { color: "#21313f", style: "solid", width: 1 },
      columnBorder: { color: "#21313f", style: "solid", width: 1 },
    },
    "dark",
  );

/**
 * Mirror Mantine's resolved color scheme onto the attribute AG Grid reads.
 * `useComputedColorScheme` collapses `auto` to the concrete light/dark value,
 * which is what the grid needs — it has no notion of "follow the system".
 */
function useAgThemeMode() {
  const scheme = useComputedColorScheme("light");
  useEffect(() => {
    document.documentElement.dataset.agThemeMode = scheme;
  }, [scheme]);
}

// Short values render fully in the cell, so opening the inspector for them is
// just friction. Only values longer than this get a click-to-expand panel.
const INSPECT_MIN_CHARS = 24;

interface Props {
  tab: QueryTab;
  /**
   * Takes over the table/JSON toggle. Artifact blocks pass this because their
   * results belong to a block, not to the tab — without it every block on the
   * tab would switch view together.
   */
  onViewModeChange?: (mode: ResultViewMode) => void;
}

function PhiCellRenderer(props: any) {
  return (
    <span
      style={{
        background: "color-mix(in srgb, var(--token) 12%, transparent)",
        border: "1px solid color-mix(in srgb, var(--token) 30%, transparent)",
        color: "var(--token)",
        padding: "2px 8px",
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: 0.3,
      }}
    >
      {props.value ?? ""}
    </span>
  );
}

/**
 * Header for a foreign-key column: the name plus a clickable FK chip. Keeps the
 * `ag-header-cell-text` class so the dblclick-to-copy handler below still finds
 * the plain column name.
 */
function FkHeader(props: {
  displayName: string;
  column?: string;
  references?: string;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        minWidth: 0,
      }}
    >
      <span
        className="ag-header-cell-text"
        style={{ overflow: "hidden", textOverflow: "ellipsis" }}
      >
        {props.displayName}
      </span>
      <FkBadge
        column={props.column ?? props.displayName}
        references={props.references}
      />
    </span>
  );
}

export function ResultsGrid({ tab, onViewModeChange }: Props) {
  useAgThemeMode();
  const phiEnabled = useStore((s) => s.phiEnabled);
  const updateTab = useStore((s) => s.updateTab);
  // Deployment-configured "Copy as" formats (COPY_FORMATS env), with a code
  // fallback so the menu always renders even before /api/config answers.
  const configuredFormats = useStore((s) => s.config.copyFormats);
  const copyFormats = configuredFormats?.length
    ? configuredFormats
    : DEFAULT_COPY_FORMATS;
  const groupedFormats = useMemo(
    () => groupFormats(copyFormats),
    [copyFormats],
  );
  const columnFormats = useMemo(
    () => copyFormats.filter((f) => f.columnMenu),
    [copyFormats],
  );
  const viewMode = tab.viewMode ?? "table";
  const gridWrapperRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<AgGridReact>(null);

  const { result, error } = tab;

  // How many rows the user has ticked (row checkboxes). Copy falls back to these
  // when no cell range is selected.
  const [selectedCount, setSelectedCount] = useState(0);
  // Rows × cols of the current cell (range) selection — drives the button label.
  const [rangeSummary, setRangeSummary] = useState<{
    rows: number;
    cols: number;
  } | null>(null);
  // Right-click a header or data cell to copy just that column in a chosen
  // format. Anchored at the cursor via a zero-size fixed target below.
  const [colMenu, setColMenu] = useState<{
    column: string;
    x: number;
    y: number;
  } | null>(null);

  const allColumnNames = useMemo(
    () => result?.columns.map((c) => c.name) ?? [],
    [result],
  );

  // Selected rows if any are ticked, else the whole result set.
  const rowsForCopy = useCallback((): Record<string, unknown>[] => {
    const selected = (gridRef.current?.api?.getSelectedRows?.() ??
      []) as Record<string, unknown>[];
    return selected.length ? selected : (result?.rows ?? []);
  }, [result]);

  /**
   * The scope a whole-grid "Copy as" acts on, in priority order:
   *   1. the selected cell range(s) — exact columns × rows the user dragged over;
   *   2. else the ticked rows (all columns);
   *   3. else the entire result.
   * Multiple ranges are unioned into one column set + row set, in grid order.
   */
  const getScopedInput = useCallback((): {
    columns: string[];
    rows: Record<string, unknown>[];
  } => {
    const api = gridRef.current?.api;
    const ranges = api?.getCellRanges?.() ?? [];
    if (api && ranges.length) {
      const colIds = new Set<string>();
      const rowIdxs = new Set<number>();
      for (const range of ranges) {
        for (const col of range.columns) {
          const id = col.getColId();
          if (id && id !== "__rownum" && !id.startsWith("ag-Grid-")) {
            colIds.add(id);
          }
        }
        if (range.startRow && range.endRow) {
          const lo = Math.min(range.startRow.rowIndex, range.endRow.rowIndex);
          const hi = Math.max(range.startRow.rowIndex, range.endRow.rowIndex);
          for (let i = lo; i <= hi; i++) rowIdxs.add(i);
        }
      }
      const columns = allColumnNames.filter((n) => colIds.has(n));
      const rows = [...rowIdxs]
        .sort((a, b) => a - b)
        .map((i) => api.getDisplayedRowAtIndex(i)?.data)
        .filter((d): d is Record<string, unknown> => !!d);
      if (columns.length && rows.length) return { columns, rows };
    }
    return { columns: allColumnNames, rows: rowsForCopy() };
  }, [allColumnNames, rowsForCopy]);

  // Copy the whole-grid scope (cell range → ticked rows → all) in a format.
  const copyScoped = useCallback(
    (format: CopyFormat, label: string) => {
      const { columns, rows } = getScopedInput();
      copyToClipboard(renderCopyFormat(format, { columns, rows }), label);
    },
    [getScopedInput],
  );

  // Copy a single column (from the right-click menu) across ticked/all rows.
  const copyColumn = useCallback(
    (format: CopyFormat, column: string, label: string) => {
      copyToClipboard(
        renderCopyFormat(format, { columns: [column], rows: rowsForCopy() }),
        label,
      );
    },
    [rowsForCopy],
  );

  // Cell inspector: single-click a data cell to open/refresh the detail drawer.
  const [cellDetail, setCellDetail] = useState<CellDetail | null>(null);
  // Opening the panel is deferred briefly so a double-click (copy) can cancel it
  // before it fires — otherwise a double-click both copies and opens the panel.
  const openTimerRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (openTimerRef.current) window.clearTimeout(openTimerRef.current);
    };
  }, []);

  // Close the inspector when the click isn't on a data cell and isn't inside the
  // drawer — i.e. empty grid space, the row-number column, or anywhere outside.
  // Clicking another data cell is left alone so onCellClicked can just refresh
  // the panel (closing + reopening here would flicker). Runs only while open.
  const inspectorOpen = !!cellDetail;
  useEffect(() => {
    if (!inspectorOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      // Interacting with the drawer itself keeps it open.
      if (target.closest(".mantine-Drawer-content")) return;
      // A data cell (col-id other than the row-number column) will refresh via
      // onCellClicked — don't close it out from under that.
      const cell = target.closest(".ag-cell");
      if (cell) {
        const colId = cell.getAttribute("col-id");
        if (colId && colId !== "__rownum") return;
      }
      setCellDetail(null);
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [inspectorOpen]);

  const columnDefs = useMemo<ColDef[]>(() => {
    if (!result) return [];

    // Row number column
    const cols: ColDef[] = [
      {
        headerName: "#",
        colId: "__rownum",
        valueGetter: "node.rowIndex + 1",
        width: 60,
        pinned: "left",
        sortable: false,
        filter: false,
        resizable: false,
        cellStyle: { color: "var(--muted)", fontSize: 10 },
      },
    ];

    for (const col of result.columns) {
      const def: ColDef = {
        // Header glyphs flag PHI masking. The dblclick-to-copy handler below
        // strips them so the copied name stays usable in SQL.
        headerName: `${col.name}${col.isMasked ? " 🔐" : ""}`,
        field: col.name,
        sortable: true,
        filter: true,
        resizable: true,
        minWidth: 80,
        // Tier 1 — quick peek on hover. GridCellTooltip renders the value:
        // ISO datetimes convert to the browser's local zone; long values get a
        // wrapped text preview. Full/rich inspection is the click-drawer.
        tooltipValueGetter: (p) => {
          const v = p.value;
          if (v === null || v === undefined) return "NULL";
          const text = typeof v === "object" ? JSON.stringify(v) : String(v);
          return text.length > 2000
            ? text.slice(0, 2000) + "… (click cell for full value)"
            : text;
        },
      };

      if (col.references) {
        def.headerComponent = FkHeader;
        def.headerComponentParams = {
          column: col.name,
          references: col.references,
        };
      }

      if (col.isMasked) {
        def.cellRenderer = PhiCellRenderer;
        def.filter = false;
        def.sortable = false;
      } else {
        // Color cells by type
        def.cellStyle = (params: CellClassParams): Record<string, string> => {
          const v = params.value;
          if (v === null || v === undefined)
            return { color: "var(--muted)", fontStyle: "italic" };
          if (typeof v === "number") return { color: "var(--accent-text)" };
          if (typeof v === "boolean")
            return { color: v ? "var(--success)" : "var(--error)" };
          if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v))
            return { color: "var(--type-special)" };
          return {};
        };
        def.valueFormatter = (params) => {
          if (params.value === null || params.value === undefined)
            return "NULL";
          if (typeof params.value === "object")
            return JSON.stringify(params.value);
          return String(params.value);
        };
      }

      cols.push(def);
    }

    return cols;
  }, [result]);

  const defaultColDef = useMemo<ColDef>(
    () => ({
      sortable: true,
      filter: true,
      resizable: true,
      suppressHeaderMenuButton: false,
      tooltipComponent: GridCellTooltip,
    }),
    [],
  );

  const getRowId = useCallback(
    (params: GetRowIdParams) => String(params.data._agRowId ?? 0),
    [],
  );

  // name → isMasked, so the inspector can enforce the same PHI rule as the grid.
  const maskedByColumn = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const col of result?.columns ?? []) m.set(col.name, col.isMasked);
    return m;
  }, [result]);

  const onCellClicked = useCallback(
    (event: CellClickedEvent) => {
      const field = event.colDef.field;
      // Skip the row-number column (it has no field).
      if (!field) return;
      // Cancel any previously-scheduled open (rapid clicks / double-click).
      if (openTimerRef.current) {
        window.clearTimeout(openTimerRef.current);
        openTimerRef.current = null;
      }
      const v = event.value;
      const text =
        v === null || v === undefined
          ? ""
          : typeof v === "object"
            ? JSON.stringify(v)
            : String(v);
      // Short values are fully visible in the cell — don't open the panel, and
      // dismiss it if it was showing a previous (longer) value.
      if (text.length <= INSPECT_MIN_CHARS) {
        setCellDetail(null);
        return;
      }
      const detail: CellDetail = {
        column: field,
        value: v,
        isMasked: maskedByColumn.get(field) ?? false,
      };
      // Defer the open so onCellDoubleClicked can cancel it within the dbl-click
      // window (~250ms). A lone single click just opens ~250ms later.
      openTimerRef.current = window.setTimeout(() => {
        setCellDetail(detail);
        openTimerRef.current = null;
      }, 250);
    },
    [maskedByColumn],
  );

  const onCellDoubleClicked = useCallback((event: CellDoubleClickedEvent) => {
    // Cancel the pending panel open — this gesture is a copy, not an inspect.
    if (openTimerRef.current) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    const colName = event.colDef.headerName ?? "";
    // Skip row number column
    if (colName === "#") return;
    const v = event.value;
    let text: string;
    if (v === null || v === undefined) text = "NULL";
    else if (typeof v === "object") text = JSON.stringify(v);
    else text = String(v);
    copyToClipboard(text, `"${colName}"`);
  }, []);

  // Attach dblclick listener on header cells for copying column names
  useEffect(() => {
    const wrapper = gridWrapperRef.current;
    if (!wrapper || viewMode !== "table") return;
    const handler = (e: MouseEvent) => {
      const target = (e.target as HTMLElement).closest(".ag-header-cell");
      if (!target) return;
      const textEl = target.querySelector(".ag-header-cell-text");
      // Drop the PHI / FK glyphs — the column name is what belongs on the clipboard.
      const colName = textEl?.textContent?.replace(/[\s🔐]+$/u, "").trim();
      if (colName && colName !== "#") {
        copyToClipboard(colName, "column");
      }
    };
    wrapper.addEventListener("dblclick", handler);
    return () => wrapper.removeEventListener("dblclick", handler);
  }, [viewMode, result]);

  // Right-click a header or data cell → per-column "Copy column as" menu. Falls
  // through to the browser's native menu when the target isn't a real column
  // (row-number, selection checkbox, empty space).
  useEffect(() => {
    const wrapper = gridWrapperRef.current;
    if (!wrapper || viewMode !== "table") return;
    const handler = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      const cell = el.closest(".ag-cell");
      const header = el.closest(".ag-header-cell");
      let column: string | null = null;
      if (cell) {
        const colId = cell.getAttribute("col-id");
        if (colId && colId !== "__rownum" && !colId.startsWith("ag-Grid-")) {
          column = colId;
        }
      } else if (header) {
        const textEl = header.querySelector(".ag-header-cell-text");
        const name = textEl?.textContent?.replace(/[\s🔐]+$/u, "").trim();
        if (name && name !== "#") column = name;
      }
      if (!column) return;
      e.preventDefault();
      setColMenu({ column, x: e.clientX, y: e.clientY });
    };
    wrapper.addEventListener("contextmenu", handler);
    return () => wrapper.removeEventListener("contextmenu", handler);
  }, [viewMode, result]);

  // Add row IDs for ag-grid
  const rowData = useMemo(() => {
    if (!result) return [];
    return result.rows.map((row, i) => ({ ...row, _agRowId: String(i) }));
  }, [result]);

  if (error) {
    return (
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "column",
          gap: 8,
          color: "var(--error)",
        }}
      >
        <IconAlertTriangle size={32} />
        <Text size="sm" fw={600}>
          Query Error
        </Text>
        <Text
          size="xs"
          ff="monospace"
          style={{
            maxWidth: 500,
            textAlign: "center",
            background: "color-mix(in srgb, var(--error) 8%, transparent)",
            padding: "10px 16px",
            borderRadius: 8,
            border: "1px solid color-mix(in srgb, var(--error) 25%, transparent)",
            whiteSpace: "pre-wrap",
          }}
        >
          {error}
        </Text>
      </div>
    );
  }

  if (!result) {
    return (
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--muted)",
        }}
      >
        <Text size="sm">Run a query to see results here</Text>
      </div>
    );
  }

  const { totalRows, executionTimeMs, masked, maskedFields, truncated } =
    result;

  return (
    <div
      style={{
        flex: 1,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Results bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 14px",
          borderBottom: "1px solid var(--border)",
          background: "var(--surface)",
          flexShrink: 0,
        }}
      >
        <Text
          size="xs"
          fw={700}
          tt="uppercase"
          c="dimmed"
          style={{ letterSpacing: 1 }}
        >
          Results
        </Text>
        <SegmentedControl
          size="xs"
          value={viewMode}
          onChange={(value) =>
            onViewModeChange
              ? onViewModeChange(value as ResultViewMode)
              : updateTab(tab.id, { viewMode: value as ResultViewMode })
          }
          data={[
            { label: <IconTable size={14} />, value: "table" },
            { label: <IconBraces size={14} />, value: "json" },
          ]}
          styles={{ root: { background: "var(--surface)" } }}
        />
        <Badge size="sm" variant="light" color="blue" ff="monospace">
          {totalRows} rows
        </Badge>
        <Badge size="sm" variant="light" color="green" ff="monospace">
          {executionTimeMs}ms
        </Badge>
        {masked && (
          <Badge
            size="sm"
            variant="light"
            color="teal"
            ff="monospace"
            leftSection={<IconShieldLock size={10} />}
          >
            {maskedFields.length} PHI fields masked
          </Badge>
        )}
        {truncated && (
          <Badge size="sm" variant="light" color="orange">
            truncated
          </Badge>
        )}

        {/* Copy the whole result (or the ticked rows/columns) in any format. */}
        {viewMode === "table" && result.rows.length > 0 && (
          <Menu shadow="md" position="bottom-start" withinPortal width={260}>
            <Menu.Target>
              <Button
                size="compact-xs"
                variant="light"
                color="teal"
                leftSection={<IconCopy size={13} />}
                rightSection={<IconChevronDown size={12} />}
              >
                {rangeSummary
                  ? `Copy ${rangeSummary.rows}×${rangeSummary.cols} as`
                  : selectedCount > 0
                    ? `Copy ${selectedCount} rows as`
                    : "Copy as"}
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              {groupedFormats.map(([group, formats]) => (
                <Fragment key={group}>
                  <Menu.Label>{group}</Menu.Label>
                  {formats.map((f) => (
                    <Menu.Item
                      key={f.id}
                      onClick={() => copyScoped(f, f.label)}
                    >
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 1,
                        }}
                      >
                        <span style={{ fontSize: 12 }}>{f.label}</span>
                        {f.example && (
                          <span
                            style={{
                              fontSize: 10,
                              color: "var(--muted)",
                              fontFamily: "IBM Plex Mono, monospace",
                            }}
                          >
                            {f.example}
                          </span>
                        )}
                      </div>
                    </Menu.Item>
                  ))}
                </Fragment>
              ))}
            </Menu.Dropdown>
          </Menu>
        )}

        {/* Discoverability hint — table view only (the JSON view shows full
            values already, so these gestures don't apply there). */}
        {viewMode === "table" && (
          <div
            style={{
              marginLeft: "auto",
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "3px 10px",
              borderRadius: 999,
              background: "color-mix(in srgb, var(--token) 7%, transparent)",
              border: "1px solid color-mix(in srgb, var(--token) 16%, transparent)",
              color: "var(--muted)",
              fontSize: 11,
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            <span
              style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
            >
              <IconEye size={13} style={{ color: "var(--accent)" }} />
              hover to peek
            </span>
            <span style={{ opacity: 0.35 }}>·</span>
            <span
              style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
            >
              <IconClick size={13} style={{ color: "var(--accent)" }} />
              click a long value to expand
            </span>
            <span style={{ opacity: 0.35 }}>·</span>
            <span
              style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
            >
              <IconCopyCheck size={13} style={{ color: "var(--accent)" }} />
              double-click to copy
            </span>
            <span style={{ opacity: 0.35 }}>·</span>
            <span
              style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
            >
              <IconCopy size={13} style={{ color: "var(--accent)" }} />
              right-click a column to copy as…
            </span>
            <span style={{ opacity: 0.35 }}>·</span>
            <span
              style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
            >
              <IconCopyCheck size={13} style={{ color: "var(--accent)" }} />
              drag to select cells, then Copy as
            </span>
          </div>
        )}
      </div>

      {/* Results view */}
      {viewMode === "json" ? (
        <ResultsJsonView rows={result.rows} />
      ) : (
        <div ref={gridWrapperRef} style={{ flex: 1 }}>
          <AgGridReact
            ref={gridRef}
            theme={gridTheme}
            rowData={rowData}
            columnDefs={columnDefs}
            defaultColDef={defaultColDef}
            getRowId={getRowId}
            onCellClicked={onCellClicked}
            onCellDoubleClicked={onCellDoubleClicked}
            // Tick rows to narrow a copy; clicking a cell must not select the row
            // (it drives the inspector), so click-selection stays off.
            rowSelection={{
              mode: "multiRow",
              checkboxes: true,
              headerCheckbox: true,
              enableClickSelection: false,
            }}
            selectionColumnDef={{ pinned: "left", width: 44, resizable: false }}
            onSelectionChanged={(e) =>
              setSelectedCount(e.api.getSelectedRows().length)
            }
            // Excel-style cell (range) selection — drag to pick an exact block of
            // cells. Ctrl/Cmd+C copies the range natively; "Copy as" reformats the
            // same scope. (Enterprise feature; running unlicensed in eval mode.)
            cellSelection={true}
            onCellSelectionChanged={(e) => {
              const ranges = e.api.getCellRanges() ?? [];
              if (!ranges.length) {
                setRangeSummary(null);
                return;
              }
              const cols = new Set<string>();
              const rows = new Set<number>();
              for (const r of ranges) {
                for (const c of r.columns) {
                  const id = c.getColId();
                  if (id && id !== "__rownum" && !id.startsWith("ag-Grid-")) {
                    cols.add(id);
                  }
                }
                if (r.startRow && r.endRow) {
                  const lo = Math.min(r.startRow.rowIndex, r.endRow.rowIndex);
                  const hi = Math.max(r.startRow.rowIndex, r.endRow.rowIndex);
                  for (let i = lo; i <= hi; i++) rows.add(i);
                }
              }
              setRangeSummary(
                cols.size && rows.size
                  ? { rows: rows.size, cols: cols.size }
                  : null,
              );
            }}
            animateRows={false}
            ensureDomOrder={true}
            suppressCellFocus={false}
            rowBuffer={20}
            headerHeight={36}
            rowHeight={32}
            tooltipShowDelay={300}
          />
        </div>
      )}

      {/* Audit bar */}
      {masked && (
        <div
          style={{
            height: 30,
            background: "color-mix(in srgb, var(--token) 6%, transparent)",
            borderTop: "1px solid color-mix(in srgb, var(--token) 20%, transparent)",
            display: "flex",
            alignItems: "center",
            padding: "0 14px",
            gap: 10,
            flexShrink: 0,
          }}
        >
          <Text
            size="xs"
            fw={700}
            tt="uppercase"
            style={{ letterSpacing: 0.8, color: "var(--token)" }}
          >
            PHI Audit
          </Text>
          <Text size="xs" ff="monospace" c="dimmed">
            {phiEnabled
              ? "All PHI fields masked"
              : "PHI shield OFF — access logged"}{" "}
            · Masked fields:{" "}
            <strong style={{ color: "var(--token)" }}>
              {maskedFields.join(", ")}
            </strong>
          </Text>
        </div>
      )}

      <CellDetailDrawer
        detail={cellDetail}
        onClose={() => setCellDetail(null)}
      />

      {/* Per-column copy menu, anchored at the right-click position. */}
      <Menu
        opened={!!colMenu}
        onChange={(open) => !open && setColMenu(null)}
        position="bottom-start"
        shadow="md"
        width={230}
        withinPortal
      >
        <Menu.Target>
          <div
            style={{
              position: "fixed",
              left: colMenu?.x ?? 0,
              top: colMenu?.y ?? 0,
              width: 0,
              height: 0,
            }}
          />
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Label>
            Copy column “{colMenu?.column}”
            {selectedCount > 0 ? ` · ${selectedCount} rows` : ""}
          </Menu.Label>
          {columnFormats.map((f) => (
            <Menu.Item
              key={f.id}
              onClick={() => {
                if (colMenu) {
                  copyColumn(
                    f,
                    colMenu.column,
                    `${colMenu.column} (${f.label})`,
                  );
                }
                setColMenu(null);
              }}
            >
              {f.label}
            </Menu.Item>
          ))}
        </Menu.Dropdown>
      </Menu>
    </div>
  );
}
