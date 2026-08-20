import { useMemo, useCallback, useRef, useEffect, useState } from "react";
import { Text, Badge, SegmentedControl } from "@mantine/core";
import {
  IconShieldLock,
  IconAlertTriangle,
  IconTable,
  IconBraces,
  IconEye,
  IconClick,
  IconCopyCheck,
} from "@tabler/icons-react";
import { AgGridReact } from "ag-grid-react";
import type {
  ColDef,
  CellClassParams,
  GetRowIdParams,
  CellDoubleClickedEvent,
  CellClickedEvent,
} from "ag-grid-community";
import { AllCommunityModule, ModuleRegistry, themeQuartz } from "ag-grid-community";
import { useStore } from "../../store";
import type { QueryTab, ResultViewMode } from "../../types";
import { ResultsJsonView } from "./results-json-view";
import { CellDetailDrawer, type CellDetail } from "./cell-detail-drawer";
import { GridCellTooltip } from "./grid-cell-tooltip";
import { copyToClipboard } from "../../utils/clipboard";

ModuleRegistry.registerModules([AllCommunityModule]);

const gridTheme = themeQuartz.withParams({
  accentColor: "#1f9196",
  backgroundColor: "#FFFFFF",
  borderColor: "#ccd0d2",
  browserColorScheme: "light",
  chromeBackgroundColor: "#f3f6f7",
  foregroundColor: "#0c2340",
  headerBackgroundColor: "#f3f6f7",
  headerFontSize: 11,
  headerFontWeight: 700,
  fontSize: 12,
  fontFamily: "IBM Plex Mono, monospace",
  rowBorder: { color: "#e8e8e8", style: "solid", width: 1 },
  columnBorder: { color: "#e8e8e8", style: "solid", width: 1 },
  spacing: 6,
  wrapperBorderRadius: 0,
});

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
        background: "rgba(31,145,150,0.12)",
        border: "1px solid rgba(31,145,150,0.3)",
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

export function ResultsGrid({ tab, onViewModeChange }: Props) {
  const phiEnabled = useStore((s) => s.phiEnabled);
  const updateTab = useStore((s) => s.updateTab);
  const viewMode = tab.viewMode ?? "table";
  const gridWrapperRef = useRef<HTMLDivElement>(null);

  const { result, error } = tab;

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
        headerName: col.isMasked ? `${col.name} 🔐` : col.name,
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
          return text.length > 2000 ? text.slice(0, 2000) + "… (click cell for full value)" : text;
        },
      };

      if (col.isMasked) {
        def.cellRenderer = PhiCellRenderer;
        def.filter = false;
        def.sortable = false;
      } else {
        // Color cells by type
        def.cellStyle = (params: CellClassParams): Record<string, string> => {
          const v = params.value;
          if (v === null || v === undefined) return { color: "var(--muted)", fontStyle: "italic" };
          if (typeof v === "number") return { color: "var(--accent)" };
          if (typeof v === "boolean") return { color: v ? "var(--success)" : "var(--error)" };
          if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return { color: "#7c3aed" };
          return {};
        };
        def.valueFormatter = (params) => {
          if (params.value === null || params.value === undefined) return "NULL";
          if (typeof params.value === "object") return JSON.stringify(params.value);
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
    []
  );

  const getRowId = useCallback(
    (params: GetRowIdParams) => String(params.data._agRowId ?? 0),
    []
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
    [maskedByColumn]
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
      const colName = textEl?.textContent?.trim();
      if (colName && colName !== "#") {
        copyToClipboard(colName, "column");
      }
    };
    wrapper.addEventListener("dblclick", handler);
    return () => wrapper.removeEventListener("dblclick", handler);
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
            background: "rgba(215,54,54,0.08)",
            padding: "10px 16px",
            borderRadius: 8,
            border: "1px solid rgba(215,54,54,0.25)",
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

  const { totalRows, executionTimeMs, masked, maskedFields, truncated } = result;

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
              background: "rgba(31,145,150,0.07)",
              border: "1px solid rgba(31,145,150,0.16)",
              color: "var(--muted)",
              fontSize: 11,
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <IconEye size={13} style={{ color: "var(--accent)" }} />
              hover to peek
            </span>
            <span style={{ opacity: 0.35 }}>·</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <IconClick size={13} style={{ color: "var(--accent)" }} />
              click a long value to expand
            </span>
            <span style={{ opacity: 0.35 }}>·</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <IconCopyCheck size={13} style={{ color: "var(--accent)" }} />
              double-click to copy
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
            theme={gridTheme}
            rowData={rowData}
            columnDefs={columnDefs}
            defaultColDef={defaultColDef}
            getRowId={getRowId}
            onCellClicked={onCellClicked}
            onCellDoubleClicked={onCellDoubleClicked}
            animateRows={false}
            enableCellTextSelection={true}
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
            background: "rgba(31,145,150,0.06)",
            borderTop: "1px solid rgba(31,145,150,0.2)",
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
            {phiEnabled ? "All PHI fields masked" : "PHI shield OFF — access logged"} ·
            Masked fields:{" "}
            <strong style={{ color: "var(--token)" }}>
              {maskedFields.join(", ")}
            </strong>
          </Text>
        </div>
      )}

      <CellDetailDrawer detail={cellDetail} onClose={() => setCellDetail(null)} />
    </div>
  );
}
