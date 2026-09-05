import { useRef, useState, useEffect } from "react";
import {
  Drawer,
  Text,
  Textarea,
  Button,
  Group,
  Badge,
  ScrollArea,
  ActionIcon,
  Tooltip,
  Loader,
  SegmentedControl,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconSparkles,
  IconSend,
  IconCopy,
  IconReplace,
  IconRowInsertBottom,
  IconAlertTriangle,
  IconDatabase,
  IconMessagePlus,
  IconRefresh,
  IconPencilBolt,
} from "@tabler/icons-react";
import { useNavigate } from "react-router-dom";
import { useStore } from "../../store";
import { api } from "../../utils/api-client";

type AssistantMode = "read" | "write";

interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  text?: string; // for user messages / error text
  query?: string; // generated query (assistant)
  explanation?: string;
  isError?: boolean;
  meta?: string; // e.g. model name / truncation note
  mode?: AssistantMode; // which mode produced this result
  prompt?: string; // originating request (for the write-request title)
}

function copyText(text: string) {
  const done = () =>
    notifications.show({
      message: "Copied to clipboard",
      color: "teal",
      autoClose: 1500,
    });
  if (navigator.clipboard?.writeText) {
    navigator.clipboard
      .writeText(text)
      .then(done)
      .catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}

function fallbackCopy(text: string, done: () => void) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  document.body.removeChild(ta);
  done();
}

/** Returns a copy of `map` keeping only entries whose key is in `keep`; same ref if unchanged. */
function pruneMap<T>(
  map: Record<string, T>,
  keep: Set<string>,
): Record<string, T> {
  const next: Record<string, T> = {};
  let changed = false;
  for (const k of Object.keys(map)) {
    if (keep.has(k)) next[k] = map[k];
    else changed = true;
  }
  return changed ? next : map;
}

export function AiAssistantPanel() {
  const open = useStore((s) => s.aiAssistantOpen);
  const setOpen = useStore((s) => s.setAiAssistant);
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const updateTab = useStore((s) => s.updateTab);
  const connections = useStore((s) => s.connections);
  const user = useStore((s) => s.user);
  const setWriteHandoff = useStore((s) => s.setWriteHandoff);
  const navigate = useNavigate();

  const [mode, setMode] = useState<AssistantMode>("read");
  const canWrite = !!user?.canWrite;

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const activeConn = connections.find((c) => c.id === activeTab?.connectionId);

  // Chat state is kept per tab so each query tab has its own conversation.
  const [inputByTab, setInputByTab] = useState<Record<string, string>>({});
  const [messagesByTab, setMessagesByTab] = useState<
    Record<string, ChatMessage[]>
  >({});
  const [loadingByTab, setLoadingByTab] = useState<Record<string, boolean>>({});
  // One-shot flag: when armed, the next generation re-introspects the schema
  // (bypasses the server-side schema cache) for the active connection.
  const [refreshArmed, setRefreshArmed] = useState(false);
  const idRef = useRef(1);
  const viewportRef = useRef<HTMLDivElement>(null);

  const tabId = activeTab?.id ?? "";
  const input = inputByTab[tabId] ?? "";
  const messages = messagesByTab[tabId] ?? [];
  const loading = loadingByTab[tabId] ?? false;

  const nextId = () => idRef.current++;
  const setInput = (val: string) =>
    setInputByTab((prev) => ({ ...prev, [tabId]: val }));
  const pushMessage = (tid: string, msg: ChatMessage) =>
    setMessagesByTab((prev) => ({
      ...prev,
      [tid]: [...(prev[tid] ?? []), msg],
    }));

  // Forget chats for tabs that no longer exist.
  useEffect(() => {
    const ids = new Set(tabs.map((t) => t.id));
    setMessagesByTab((prev) => pruneMap(prev, ids));
    setInputByTab((prev) => pruneMap(prev, ids));
    setLoadingByTab((prev) => pruneMap(prev, ids));
  }, [tabs]);

  useEffect(() => {
    // Auto-scroll to latest message (also on tab switch)
    viewportRef.current?.scrollTo({
      top: viewportRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, loading, tabId]);

  const handleNewChat = () => {
    if (!tabId) return;
    setMessagesByTab((prev) => ({ ...prev, [tabId]: [] }));
    setInput("");
  };

  const handleGenerate = async () => {
    const prompt = input.trim();
    if (!prompt || loading) return;

    if (!activeTab?.connectionId || !activeConn) {
      notifications.show({
        message: "Select a connection for the active tab first",
        color: "orange",
      });
      return;
    }

    // Capture the originating tab so async results land in the right conversation
    // even if the user switches tabs while generating.
    const tid = activeTab.id;
    const connId = activeTab.connectionId;
    const activeSchema = activeTab.schema;
    const currentSql = activeTab.sql || undefined;
    const doRefresh = refreshArmed;
    setRefreshArmed(false);

    const genMode = mode;
    pushMessage(tid, { id: nextId(), role: "user", text: prompt });
    setInput("");
    setLoadingByTab((prev) => ({ ...prev, [tid]: true }));

    try {
      const res = await api.generateQuery({
        connectionId: connId,
        prompt,
        currentQuery: currentSql,
        refreshSchema: doRefresh,
        mode: genMode,
        schema: activeSchema,
      });
      const metaParts: string[] = [];
      if (res.model) metaParts.push(res.model);
      const schemaBits: string[] = [];
      if (res.schemaTruncated)
        schemaBits.push(
          `${res.tablesProvided}/${res.totalTables} tables${res.relevantSelection ? " relevant" : ""}`,
        );
      if (res.schemaCached != null)
        schemaBits.push(res.schemaCached ? "cached" : "fresh");
      if (schemaBits.length) metaParts.push(`schema: ${schemaBits.join(", ")}`);
      if (res.examplesUsed)
        metaParts.push(
          `${res.examplesUsed} example${res.examplesUsed === 1 ? "" : "s"}`,
        );
      pushMessage(tid, {
        id: nextId(),
        role: "assistant",
        query: res.query,
        explanation: res.explanation,
        meta: metaParts.join(" · "),
        mode: genMode,
        prompt,
      });
    } catch (err: any) {
      pushMessage(tid, {
        id: nextId(),
        role: "assistant",
        text: err.message,
        isError: true,
      });
    } finally {
      setLoadingByTab((prev) => ({ ...prev, [tid]: false }));
    }
  };

  const applyReplace = (query: string) => {
    if (!activeTab) return;
    updateTab(activeTab.id, { sql: query });
    notifications.show({
      message: "Replaced query in active tab",
      color: "green",
      autoClose: 1500,
    });
  };

  const applyAppend = (query: string) => {
    if (!activeTab) return;
    const existing = activeTab.sql?.trim();
    const next = existing ? `${existing}\n\n${query}` : query;
    updateTab(activeTab.id, { sql: next });
    notifications.show({
      message: "Appended to active tab",
      color: "green",
      autoClose: 1500,
    });
  };

  // Hand a generated (or selected) statement to the Write composer and go there.
  const startWriteRequest = (query: string, promptText?: string) => {
    const title = promptText ? promptText.slice(0, 80) : "AI-drafted change";
    setWriteHandoff({
      writeSql: query,
      connectionId: activeTab?.connectionId ?? null,
      title,
    });
    setOpen(false);
    navigate("/write");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Cmd/Ctrl+Enter submits
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      handleGenerate();
    }
  };

  return (
    <Drawer
      opened={open}
      onClose={() => setOpen(false)}
      position="right"
      size={440}
      withOverlay={false}
      closeOnClickOutside={false}
      lockScroll={false}
      trapFocus={false}
      title={
        <Group gap={8}>
          <IconSparkles size={18} color="var(--accent)" />
          <Text fw={700} size="sm">
            AI Query Assistant
          </Text>
        </Group>
      }
      styles={{
        body: {
          height: "calc(100% - 60px)",
          display: "flex",
          flexDirection: "column",
          padding: 0,
        },
        content: { boxShadow: "var(--shadow-2)" },
      }}
    >
      {/* Connection context + New chat */}
      <div
        style={{
          padding: "10px 16px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <Group justify="space-between" wrap="nowrap" gap={8}>
          <div style={{ minWidth: 0, flex: 1 }}>
            {activeConn ? (
              <Group gap={6} wrap="nowrap" style={{ overflow: "hidden" }}>
                <IconDatabase
                  size={14}
                  color="var(--mantine-color-dimmed)"
                  style={{ flexShrink: 0 }}
                />
                <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                  Context:
                </Text>
                <Badge
                  size="sm"
                  variant="light"
                  color="gray"
                  ff="monospace"
                  style={{ flexShrink: 1, overflow: "hidden" }}
                >
                  {activeConn.name}
                </Badge>
                <Badge
                  size="xs"
                  variant="light"
                  color="blue"
                  style={{ flexShrink: 0 }}
                >
                  {activeConn.type}
                </Badge>
                <Badge
                  size="xs"
                  variant="light"
                  color="gray"
                  style={{ flexShrink: 0 }}
                >
                  {activeConn.env}
                </Badge>
              </Group>
            ) : (
              <Group gap={6} wrap="nowrap">
                <IconAlertTriangle
                  size={14}
                  color="var(--warning)"
                  style={{ flexShrink: 0 }}
                />
                <Text size="xs" c="dimmed">
                  Select a connection for the active tab to enable generation.
                </Text>
              </Group>
            )}
          </div>
          <Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
            <Tooltip
              label={
                refreshArmed
                  ? "Schema will be re-fetched on next generate"
                  : "Re-fetch schema on next generate (bypass cache)"
              }
            >
              <ActionIcon
                variant={refreshArmed ? "filled" : "subtle"}
                color={refreshArmed ? "primary" : "gray"}
                size="md"
                onClick={() => setRefreshArmed((a) => !a)}
                disabled={!activeConn}
              >
                <IconRefresh size={15} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label="Clear this tab's chat and start over">
              <Button
                size="compact-xs"
                variant="subtle"
                color="gray"
                leftSection={<IconMessagePlus size={13} />}
                onClick={handleNewChat}
                disabled={loading || (messages.length === 0 && !input.trim())}
              >
                New chat
              </Button>
            </Tooltip>
          </Group>
        </Group>
      </div>

      {/* Messages */}
      <ScrollArea style={{ flex: 1 }} viewportRef={viewportRef}>
        <div
          style={{
            padding: 16,
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          {messages.length === 0 && (
            <div
              style={{
                textAlign: "center",
                padding: "32px 12px",
                color: "var(--mantine-color-dimmed)",
              }}
            >
              <IconSparkles size={28} style={{ opacity: 0.4 }} />
              <Text size="sm" mt="sm" fw={600}>
                Describe the data you want
              </Text>
              <Text size="xs" c="dimmed" mt={4} style={{ lineHeight: 1.6 }}>
                e.g. "all orders created in the last 30 days with their patient
                name and kit status, newest first"
              </Text>
              <Text
                size="xs"
                c="dimmed"
                mt="sm"
                style={{ fontStyle: "italic" }}
              >
                Only schema (table & column names) is sent to Azure OpenAI —
                never row data.
              </Text>
            </div>
          )}

          {messages.map((msg) =>
            msg.role === "user" ? (
              <div
                key={msg.id}
                style={{ alignSelf: "flex-end", maxWidth: "90%" }}
              >
                <div
                  style={{
                    background: "var(--accent)",
                    color: "white",
                    padding: "8px 12px",
                    borderRadius: "12px 12px 2px 12px",
                    fontSize: 13,
                    lineHeight: 1.5,
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {msg.text}
                </div>
              </div>
            ) : (
              <div
                key={msg.id}
                style={{
                  alignSelf: "flex-start",
                  maxWidth: "100%",
                  width: "100%",
                }}
              >
                {msg.isError ? (
                  <div
                    style={{
                      background: "color-mix(in srgb, var(--error) 6%, transparent)",
                      border: "1px solid color-mix(in srgb, var(--error) 25%, transparent)",
                      borderRadius: 10,
                      padding: "10px 12px",
                    }}
                  >
                    <Group gap={6} mb={2}>
                      <IconAlertTriangle
                        size={14}
                        color="var(--error)"
                      />
                      <Text size="xs" fw={700} c="red">
                        Generation failed
                      </Text>
                    </Group>
                    <Text size="xs" c="dimmed">
                      {msg.text}
                    </Text>
                  </div>
                ) : (
                  <div
                    style={{
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                      borderRadius: 10,
                      overflow: "hidden",
                    }}
                  >
                    {msg.explanation && (
                      <Text
                        size="xs"
                        c="dimmed"
                        style={{ padding: "10px 12px 0", lineHeight: 1.6 }}
                      >
                        {msg.explanation}
                      </Text>
                    )}
                    <pre
                      style={{
                        margin: 0,
                        padding: "10px 12px",
                        fontFamily: "IBM Plex Mono, monospace",
                        fontSize: 12,
                        lineHeight: 1.6,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        background: "var(--surface2)",
                        maxHeight: 320,
                        overflow: "auto",
                      }}
                    >
                      {msg.query}
                    </pre>
                    <Group
                      gap={4}
                      justify="space-between"
                      style={{
                        padding: "6px 8px",
                        borderTop: "1px solid var(--border)",
                      }}
                    >
                      <Group gap={4}>
                        {msg.mode === "write" ? (
                          <Tooltip label="Open the write composer with this statement">
                            <Button
                              size="compact-xs"
                              variant="light"
                              color="grape"
                              leftSection={<IconPencilBolt size={13} />}
                              onClick={() =>
                                startWriteRequest(msg.query!, msg.prompt)
                              }
                            >
                              New write request
                            </Button>
                          </Tooltip>
                        ) : (
                          <>
                            <Tooltip label="Replace active tab's query">
                              <Button
                                size="compact-xs"
                                variant="light"
                                leftSection={<IconReplace size={13} />}
                                onClick={() => applyReplace(msg.query!)}
                              >
                                Replace
                              </Button>
                            </Tooltip>
                            <Tooltip label="Append to active tab's query">
                              <Button
                                size="compact-xs"
                                variant="subtle"
                                color="gray"
                                leftSection={<IconRowInsertBottom size={13} />}
                                onClick={() => applyAppend(msg.query!)}
                              >
                                Append
                              </Button>
                            </Tooltip>
                          </>
                        )}
                        <Tooltip label="Copy">
                          <ActionIcon
                            size="sm"
                            variant="subtle"
                            color="gray"
                            onClick={() => copyText(msg.query!)}
                          >
                            <IconCopy size={14} />
                          </ActionIcon>
                        </Tooltip>
                      </Group>
                      {msg.meta && (
                        <Text
                          size="xs"
                          c="dimmed"
                          ff="monospace"
                          style={{ fontSize: 10 }}
                        >
                          {msg.meta}
                        </Text>
                      )}
                    </Group>
                  </div>
                )}
              </div>
            ),
          )}

          {loading && (
            <Group
              gap={8}
              style={{ alignSelf: "flex-start", padding: "4px 2px" }}
            >
              <Loader size="xs" />
              <Text size="xs" c="dimmed">
                Generating query…
              </Text>
            </Group>
          )}
        </div>
      </ScrollArea>

      {/* Input */}
      <div style={{ borderTop: "1px solid var(--border)", padding: 12 }}>
        {canWrite && (
          <Group justify="space-between" mb={8} wrap="nowrap">
            <SegmentedControl
              size="xs"
              value={mode}
              onChange={(v) => setMode(v as AssistantMode)}
              data={[
                { label: "Read query", value: "read" },
                { label: "Write query", value: "write" },
              ]}
            />
            {mode === "write" && (
              <Badge size="xs" variant="light" color="grape">
                Drafts a change → approval
              </Badge>
            )}
          </Group>
        )}
        <Textarea
          placeholder={
            mode === "write"
              ? "Describe the change… e.g. “set config ai_doc_generation_enabled to false” (Cmd/Ctrl+Enter)"
              : "Ask in plain English… (Cmd/Ctrl+Enter to send)"
          }
          value={input}
          onChange={(e) => setInput(e.currentTarget.value)}
          onKeyDown={handleKeyDown}
          autosize
          minRows={2}
          maxRows={6}
          disabled={!activeConn}
        />
        <Group justify="flex-end" mt={8}>
          <Button
            size="xs"
            color={mode === "write" ? "grape" : undefined}
            leftSection={
              mode === "write" ? (
                <IconPencilBolt size={14} />
              ) : (
                <IconSend size={14} />
              )
            }
            onClick={handleGenerate}
            loading={loading}
            disabled={!input.trim() || !activeConn}
          >
            {mode === "write" ? "Draft write" : "Generate"}
          </Button>
        </Group>
      </div>
    </Drawer>
  );
}
