import { useMemo } from "react";
import { Drawer, Text, Badge, ActionIcon, Tooltip, Group } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import Editor from "@monaco-editor/react";
import {
  IconCopy,
  IconShieldLock,
  IconBraces,
  IconLetterCase,
} from "@tabler/icons-react";

export interface CellDetail {
  column: string;
  value: unknown;
  isMasked: boolean;
}

interface Props {
  detail: CellDetail | null;
  onClose: () => void;
}

function copyText(text: string) {
  const done = () =>
    notifications.show({ message: "Copied to clipboard", color: "teal", autoClose: 1500 });
  const fallback = () => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    done();
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(fallback);
  } else {
    fallback();
  }
}

/**
 * Resolve a cell value into displayable text + whether it is JSON.
 * A value is treated as JSON when it is already an object/array, or a string
 * that parses into one — scalars (numbers, plain strings) stay as text.
 */
function resolveContent(value: unknown): { text: string; isJson: boolean } {
  if (value === null || value === undefined) return { text: "NULL", isJson: false };
  if (typeof value === "object") {
    return { text: JSON.stringify(value, null, 2), isJson: true };
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object") {
          return { text: JSON.stringify(parsed, null, 2), isJson: true };
        }
      } catch {
        // not valid JSON — fall through to plain text
      }
    }
    return { text: value, isJson: false };
  }
  return { text: String(value), isJson: false };
}

export function CellDetailDrawer({ detail, onClose }: Props) {
  const content = useMemo(
    () => (detail ? resolveContent(detail.value) : null),
    [detail]
  );

  return (
    <Drawer
      opened={!!detail}
      onClose={onClose}
      position="right"
      size={520}
      // Behave like a docked inspector: no overlay, no focus trap, no scroll
      // lock — the grid stays interactive so clicking another cell just updates
      // this panel instead of reopening a modal.
      withOverlay={false}
      trapFocus={false}
      lockScroll={false}
      closeOnClickOutside={false}
      title={
        detail && content ? (
          <Group gap={8} wrap="nowrap">
            <Text size="sm" fw={700} ff="monospace" style={{ wordBreak: "break-all" }}>
              {detail.column}
            </Text>
            {detail.isMasked ? (
              <Badge
                size="xs"
                color="teal"
                variant="light"
                leftSection={<IconShieldLock size={9} />}
              >
                PHI masked
              </Badge>
            ) : (
              <Badge
                size="xs"
                color={content.isJson ? "blue" : "gray"}
                variant="light"
                leftSection={
                  content.isJson ? <IconBraces size={9} /> : <IconLetterCase size={9} />
                }
              >
                {content.isJson ? "JSON" : "text"}
              </Badge>
            )}
            <Badge size="xs" color="gray" variant="light" ff="monospace">
              {content.text.length} chars
            </Badge>
          </Group>
        ) : null
      }
      styles={{
        content: {
          display: "flex",
          flexDirection: "column",
          boxShadow: "-8px 0 24px rgba(0,0,0,0.08)",
        },
        body: { flex: 1, minHeight: 0, padding: 0, display: "flex", flexDirection: "column" },
      }}
    >
      {detail && content && (
        <>
          <Group
            justify="flex-end"
            gap={6}
            px={12}
            py={8}
            style={{ borderBottom: "1px solid var(--border)", flexShrink: 0 }}
          >
            <Tooltip label="Copy value">
              <ActionIcon
                variant="light"
                color="teal"
                onClick={() => copyText(content.text)}
              >
                <IconCopy size={16} />
              </ActionIcon>
            </Tooltip>
          </Group>
          <div style={{ flex: 1, minHeight: 0 }}>
            <Editor
              height="100%"
              language={content.isJson ? "json" : "plaintext"}
              theme="vs"
              value={content.text}
              loading={null}
              options={{
                readOnly: true,
                minimap: { enabled: false },
                fontSize: 12,
                fontFamily: "IBM Plex Mono, monospace",
                lineNumbers: content.isJson ? "on" : "off",
                wordWrap: "on",
                scrollBeyondLastLine: false,
                folding: content.isJson,
                automaticLayout: true,
                renderLineHighlight: "none",
                padding: { top: 10, bottom: 10 },
                overviewRulerBorder: false,
                hideCursorInOverviewRuler: true,
                contextmenu: false,
              }}
            />
          </div>
        </>
      )}
    </Drawer>
  );
}
