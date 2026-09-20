import { useState, useRef, useEffect } from "react";
import { Text, ActionIcon, Tooltip, Menu } from "@mantine/core";
import {
  IconDeviceFloppy,
  IconFileText,
  IconPencil,
  IconPlus,
  IconX,
} from "@tabler/icons-react";
import { useStore } from "../../store";

interface Props {
  /** Asks the editor to open its save modal for the active tab — the same
      flow as Cmd+S and the toolbar button, rather than a second save path. */
  onSaveTab?: () => void;
}

export function QueryTabs({ onSaveTab }: Props) {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const addTab = useStore((s) => s.addTab);
  const closeTab = useStore((s) => s.closeTab);
  const updateTab = useStore((s) => s.updateTab);
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(
    null,
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const menuTab = tabs.find((t) => t.id === menu?.id);

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

  const startRename = (tabId: string, title: string) => {
    setEditingTabId(tabId);
    setEditValue(title);
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
          onContextMenu={(e) => {
            e.preventDefault();
            setActiveTab(tab.id);
            setMenu({ id: tab.id, x: e.clientX, y: e.clientY });
          }}
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
          {tab.kind === "artifact" && (
            <IconFileText size={12} style={{ flexShrink: 0 }} />
          )}
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
                startRename(tab.id, tab.title);
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
                borderRadius: "var(--radius-sm)",
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

      {/* Tab context menu, anchored at the right-click position. */}
      <Menu
        opened={!!menu}
        onChange={(open) => !open && setMenu(null)}
        position="bottom-start"
        shadow="md"
        width={180}
        withinPortal
      >
        <Menu.Target>
          <div
            style={{
              position: "fixed",
              left: menu?.x ?? 0,
              top: menu?.y ?? 0,
              width: 0,
              height: 0,
            }}
          />
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item
            leftSection={<IconPencil size={14} />}
            onClick={() => {
              if (menuTab) startRename(menuTab.id, menuTab.title);
              setMenu(null);
            }}
          >
            Rename
          </Menu.Item>
          {menuTab?.kind !== "artifact" && (
            <Menu.Item
              leftSection={<IconDeviceFloppy size={14} />}
              onClick={() => {
                onSaveTab?.();
                setMenu(null);
              }}
            >
              Save query
            </Menu.Item>
          )}
          <Menu.Divider />
          <Menu.Item
            leftSection={<IconX size={14} />}
            onClick={() => {
              if (menuTab) closeTab(menuTab.id);
              setMenu(null);
            }}
          >
            Close
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </div>
  );
}
