import { useState } from "react";
import { ActionIcon, Tooltip, Text, TextInput } from "@mantine/core";
import { IconSearch, IconX } from "@tabler/icons-react";
import JsonView from "react18-json-view";
import "react18-json-view/src/style.css";

interface Props {
  rows: Record<string, unknown>[];
}

export function ResultsJsonView({ rows }: Props) {
  const [search, setSearch] = useState("");
  const [showSearch, setShowSearch] = useState(false);

  const searchLower = search.toLowerCase();
  const filteredRows = search
    ? rows.filter((row) =>
        JSON.stringify(row).toLowerCase().includes(searchLower)
      )
    : rows;

  return (
    <div
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
        {showSearch ? (
          <TextInput
            size="xs"
            placeholder="Filter documents..."
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            rightSection={
              <ActionIcon
                size="xs"
                variant="subtle"
                onClick={() => {
                  setSearch("");
                  setShowSearch(false);
                }}
              >
                <IconX size={12} />
              </ActionIcon>
            }
            styles={{
              input: {
                fontFamily: "IBM Plex Mono, monospace",
                fontSize: 11,
                height: 24,
                minHeight: 24,
              },
            }}
            style={{ width: 240 }}
            autoFocus
          />
        ) : (
          <Tooltip label="Search documents">
            <ActionIcon
              size="xs"
              variant="subtle"
              color="gray"
              onClick={() => setShowSearch(true)}
            >
              <IconSearch size={14} />
            </ActionIcon>
          </Tooltip>
        )}

        {search && (
          <Text size="xs" c="dimmed" ff="monospace">
            {filteredRows.length} of {rows.length}
          </Text>
        )}

        <div style={{ flex: 1 }} />
        <Text size="xs" c="dimmed" ff="monospace">
          {rows.length} document{rows.length !== 1 ? "s" : ""}
        </Text>
      </div>

      {/* JSON viewer */}
      <div style={{ flex: 1, overflow: "auto", padding: "14px 18px", background: "#fafbfc" }}>
        <JsonView
          src={filteredRows}
          enableClipboard
          collapseStringMode="word"
          collapseStringsAfterLength={80}
          displaySize
          style={{
            fontFamily: "IBM Plex Mono, monospace",
            fontSize: 12,
            lineHeight: 1.7,
            color: "#0c2340",
          }}
        />
      </div>
    </div>
  );
}
