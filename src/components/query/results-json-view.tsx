import { useCallback, useRef, useState, useEffect } from "react";
import { ActionIcon, Tooltip, Text } from "@mantine/core";
import { IconSearch, IconArrowsMaximize, IconArrowsMinimize } from "@tabler/icons-react";
import { ObjectView, SearchComponent, extendTheme, themeGitHubLight } from "react-obj-view";
import type { ObjectViewHandle } from "react-obj-view";
import "react-obj-view/dist/react-obj-view.css";

const cepTheme = extendTheme(themeGitHubLight, {
  "--bigobjview-color": "#0c2340",
  "--bigobjview-bg-color": "#fafbfc",
  "--bigobjview-fontsize": "12px",
  "--bigobjview-type-number-color": "#1f9196",
  "--bigobjview-type-string-color": "#2e7d32",
  "--bigobjview-type-boolean-color": "#7c3aed",
  "--bigobjview-type-object-array-color": "#1f9196",
  "--bigobjview-type-object-object-color": "#576e75",
  "--bigobjview-type-object-date-color": "#7c3aed",
  "--bigobjview-type-object-error-color": "#d73636",
  "--bigobjview-action-btn": "#8F9AA7",
  "--bigobjview-action-success": "#4caf50",
  "--bigobjview-action-error": "#d73636",
  fontFamily: "IBM Plex Mono, monospace",
});

interface Props {
  rows: Record<string, unknown>[];
}

export function ResultsJsonView({ rows }: Props) {
  const objViewRef = useRef<ObjectViewHandle | undefined>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);
  const [searchActive, setSearchActive] = useState(false);
  const [expandLevel, setExpandLevel] = useState(1);
  const valueGetter = useCallback(() => rows, [rows]);

  // Ctrl/Cmd+F to open search
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        setSearchActive(true);
      }
    };
    el.addEventListener("keydown", handler);
    return () => el.removeEventListener("keydown", handler);
  }, []);

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* Toolbar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 14px",
          borderBottom: "1px solid var(--border)",
          background: "var(--surface2)",
          flexShrink: 0,
        }}
      >
        <Tooltip label="Search (Ctrl+F)">
          <ActionIcon
            size="xs"
            variant="subtle"
            color="gray"
            onClick={() => setSearchActive(true)}
          >
            <IconSearch size={14} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Expand all">
          <ActionIcon
            size="xs"
            variant="subtle"
            color="gray"
            onClick={() => setExpandLevel(3)}
          >
            <IconArrowsMaximize size={14} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Collapse all">
          <ActionIcon
            size="xs"
            variant="subtle"
            color="gray"
            onClick={() => setExpandLevel(1)}
          >
            <IconArrowsMinimize size={14} />
          </ActionIcon>
        </Tooltip>

        <div style={{ flex: 1 }} />
        <Text size="xs" c="dimmed" ff="monospace">
          {rows.length} document{rows.length !== 1 ? "s" : ""}
        </Text>
      </div>

      {/* Virtualized JSON viewer */}
      <div
        style={{
          flex: 1,
          overflow: "auto",
          position: "relative",
          background: "#fafbfc",
          minHeight: 0,
        }}
      >
        <ObjectView
          ref={objViewRef}
          valueGetter={valueGetter}
          name="results"
          expandLevel={expandLevel}
          arrayGroupSize={500}
          objectGroupSize={100}
          stickyPathHeaders
          showLineNumbers
          lineHeight={20}
          overscan={150}
          style={cepTheme}
        />
        <SearchComponent
          active={searchActive}
          onClose={() => setSearchActive(false)}
          handleSearch={
            objViewRef.current
              ? objViewRef.current.search.bind(objViewRef.current)
              : undefined
          }
          scrollToPaths={
            objViewRef.current
              ? objViewRef.current.scrollToPaths.bind(objViewRef.current)
              : undefined
          }
        />
      </div>
    </div>
  );
}
