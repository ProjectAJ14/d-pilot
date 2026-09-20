import { useEffect, useMemo, useState } from "react";
import { Drawer, Text, Badge, Button, Tooltip, Group } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import Editor from "@monaco-editor/react";
import {
  IconCopy,
  IconShieldLock,
  IconBraces,
  IconLetterCase,
  IconExternalLink,
} from "@tabler/icons-react";
import { useEditorTheme } from "../../utils/monaco-editor-options";
import {
  jsonViewerLink,
  type JsonViewerLink,
} from "../../utils/json-viewer-link";

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
    notifications.show({
      message: "Copied to clipboard",
      color: "teal",
      autoClose: 1500,
    });
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
  if (value === null || value === undefined)
    return { text: "NULL", isJson: false };
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
  const editorTheme = useEditorTheme();
  const content = useMemo(
    () => (detail ? resolveContent(detail.value) : null),
    [detail],
  );

  // Built up-front so the control can be a real <a href> — middle-click, cmd-click and "copy
  // link address" keep working, and there is no popup to block. `live` guards the drawer being
  // closed, or another cell opened, while the compressor is still running.
  // The link is stamped with the payload it was built from, so a link left over from the
  // previously inspected cell is simply not rendered — no clearing, no stale href.
  const [link, setLink] = useState<(JsonViewerLink & { json: string }) | null>(
    null,
  );
  const json = content?.isJson ? content.text : null;
  useEffect(() => {
    if (json === null) return;
    let live = true;
    jsonViewerLink(json).then(
      (v) => {
        if (live) setLink({ ...v, json });
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [json]);
  const viewer = link && link.json === json ? link : null;

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
            <Text
              size="sm"
              fw={700}
              ff="monospace"
              style={{ wordBreak: "break-all" }}
            >
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
                  content.isJson ? (
                    <IconBraces size={9} />
                  ) : (
                    <IconLetterCase size={9} />
                  )
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
          boxShadow: "var(--shadow-2)",
        },
        body: {
          flex: 1,
          minHeight: 0,
          padding: 0,
          display: "flex",
          flexDirection: "column",
        },
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
            <Button
              size="xs"
              variant="light"
              color="teal"
              leftSection={<IconCopy size={14} />}
              onClick={() => copyText(content.text)}
            >
              Copy
            </Button>
            {/* The payload rides in the URL fragment, which a browser never transmits — see
                utils/json-viewer-link.ts. Too big for a URL and the viewer reads it off the
                clipboard instead, so the click writes it there (inside the gesture, the only
                place a clipboard write is allowed). */}
            {viewer && (
              <Tooltip
                label={
                  viewer.needsClipboard
                    ? "Too large for a link — copies the JSON and opens the viewer, which reads it from your clipboard"
                    : "Open in json.nonstopio.com — search, filter and graph it"
                }
              >
                <Button
                  component="a"
                  href={viewer.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  size="xs"
                  variant="light"
                  color="blue"
                  leftSection={<IconExternalLink size={14} />}
                  onClick={
                    viewer.needsClipboard
                      ? () => copyText(content.text)
                      : undefined
                  }
                >
                  Open in viewer
                </Button>
              </Tooltip>
            )}
          </Group>
          <div style={{ flex: 1, minHeight: 0 }}>
            <Editor
              height="100%"
              language={content.isJson ? "json" : "plaintext"}
              theme={editorTheme}
              value={content.text}
              loading={null}
              options={{
                readOnly: true,
                minimap: { enabled: false },
                fontSize: 12,
                fontFamily: "var(--font-mono)",
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
