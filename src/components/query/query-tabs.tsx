import { useState, useRef, useEffect } from "react";
import { Text, ActionIcon, Tooltip } from "@mantine/core";
import { IconPlus, IconX } from "@tabler/icons-react";
import { useStore } from "../../store";

export function QueryTabs() {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const addTab = useStore((s) => s.addTab);
  const closeTab = useStore((s) => s.closeTab);
  const updateTab = useStore((s) => s.updateTab);
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingTabId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingTabId]);

  const commitRename = (tabId: string) => {
    const trimmed = editValue.trim();
    if (trimmed) updateTab(tabId, { title: trimmed });
    setEditingTabId(null);
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        background: "var(--surface)",
        borderBottom: "1px solid var(--border)",
        padding: "0 10px",
        flexShrink: 0,
        overflowX: "auto",
      }}
    >
      {tabs.map((tab) => (
        <div
          key={tab.id}
          onClick={() => setActiveTab(tab.id)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "10px 14px",
            cursor: "pointer",
            fontSize: 12,
            fontWeight: 500,
            color: tab.id === activeTabId ? "var(--text)" : "var(--muted)",
            borderBottom: `2px solid ${tab.id === activeTabId ? "var(--accent)" : "transparent"}`,
            marginBottom: -1,
            whiteSpace: "nowrap",
            transition: "all 0.15s",
          }}
        >
          {editingTabId === tab.id ? (
            <input
              ref={inputRef}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={() => commitRename(tab.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename(tab.id);
                if (e.key === "Escape") setEditingTabId(null);
              }}
              onClick={(e) => e.stopPropagation()}
              style={{
                border: "none",
                outline: "none",
                background: "transparent",
                fontSize: 12,
                fontWeight: 500,
                color: "inherit",
                fontFamily: "inherit",
                width: Math.max(40, editValue.length * 7),
                padding: 0,
              }}
            />
          ) : (
            <Text
              size="xs"
              fw={tab.id === activeTabId ? 600 : 400}
              onDoubleClick={(e) => {
                e.stopPropagation();
                setEditingTabId(tab.id);
                setEditValue(tab.title);
              }}
            >
              {tab.title}
            </Text>
          )}
          {tab.loading && (
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "var(--accent)",
                animation: "pulse 1s infinite",
              }}
            />
          )}
          <ActionIcon
            size={16}
            variant="subtle"
            color="gray"
            onClick={(e) => {
              e.stopPropagation();
              closeTab(tab.id);
            }}
          >
            <IconX size={10} />
          </ActionIcon>
        </div>
      ))}

      <Tooltip label="New tab">
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          onClick={() => addTab()}
          style={{ marginLeft: 4 }}
        >
          <IconPlus size={16} />
        </ActionIcon>
      </Tooltip>
    </div>
  );
}
