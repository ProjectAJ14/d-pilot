import { useMemo, useCallback } from "react";
import { Text, Badge } from "@mantine/core";
import { IconShieldLock, IconAlertTriangle } from "@tabler/icons-react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, CellClassParams, GetRowIdParams } from "ag-grid-community";
import { AllCommunityModule, ModuleRegistry, themeQuartz } from "ag-grid-community";
import { useStore } from "../../store";
import type { QueryTab } from "../../types";

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

interface Props {
  tab: QueryTab;
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

export function ResultsGrid({ tab }: Props) {
  const phiEnabled = useStore((s) => s.phiEnabled);

  const { result, error } = tab;

  const columnDefs = useMemo<ColDef[]>(() => {
    if (!result) return [];

    // Row number column
    const cols: ColDef[] = [
      {
        headerName: "#",
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
    }),
    []
  );

  const getRowId = useCallback(
    (params: GetRowIdParams) => String(params.data._agRowId ?? 0),
    []
  );

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
      </div>

      {/* ag-Grid */}
      <div style={{ flex: 1 }}>
        <AgGridReact
          theme={gridTheme}
          rowData={rowData}
          columnDefs={columnDefs}
          defaultColDef={defaultColDef}
          getRowId={getRowId}
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
    </div>
  );
}
