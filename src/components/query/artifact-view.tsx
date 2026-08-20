import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import Editor from "@monaco-editor/react";
import { notifications } from "@mantine/notifications";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import {
  Badge,
  Button,
  Group,
  Loader,
  Text,
  Tooltip,
  TypographyStylesProvider,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconArchive,
  IconArchiveOff,
  IconExternalLink,
  IconPlayerPlay,
  IconShare,
  IconWand,
} from "@tabler/icons-react";
import { useStore } from "../../store";
import { api } from "../../utils/api-client";
import { baseSqlEditorOptions } from "../../utils/monaco-editor-options";
import { copyArtifactShareLink } from "../../utils/share-links";
import { envColor } from "../../utils/environments";
import type {
  Artifact,
  QueryTab,
  QueryResult,
  ResultViewMode,
} from "../../types";
import { ResultsGrid } from "./results-grid";
import { monacoLanguageForDb } from "./query-editor";

/**
 * Runnability hint only. The server is the authority — `validateQuery` in
 * query-executor rejects DML/DDL on `/query/execute` no matter what this says —
 * but greying Run out beforehand is friendlier than a 400, and it's what routes
 * the reader to the write-approval workflow instead.
 */
const WRITE_STATEMENT =
  /^\s*(insert|update|delete|drop|alter|create|truncate|merge|grant|revoke)\b/i;

/**
 * Text blocks are GitHub-flavoured markdown. `react-markdown` never emits raw
 * HTML unless `rehype-raw` is added — do not add it. Escaping by construction is
 * what keeps a document written by one colleague from scripting the app for
 * everyone who opens the link, and it is stronger than sanitising after the fact.
 *
 * `remark-breaks` makes a single newline a line break, because people write these
 * in a plain textarea and expect their line endings to survive.
 */
const MARKDOWN_PLUGINS = [remarkGfm, remarkBreaks];

function MarkdownBlock({ body }: { body: string }) {
  return (
    <TypographyStylesProvider style={{ fontSize: 14 }}>
      <ReactMarkdown
        remarkPlugins={MARKDOWN_PLUGINS}
        components={{
          table: (props) => (
            <div style={{ overflowX: "auto" }}>
              <table {...props} />
            </div>
          ),
          a: (props) => (
            <a {...props} target="_blank" rel="noopener noreferrer" />
          ),
        }}
      >
        {body}
      </ReactMarkdown>
    </TypographyStylesProvider>
  );
}

const BLOCK_EDITOR_MIN = 60;
const BLOCK_EDITOR_MAX = 260;
const LINE_HEIGHT = 19;

interface BlockState {
  loading: boolean;
  result: QueryResult | null;
  error: string | null;
  viewMode: ResultViewMode;
}

const EMPTY_BLOCK: BlockState = {
  loading: false,
  result: null,
  error: null,
  viewMode: "table",
};

interface Props {
  tab: QueryTab;
}

/**
 * Renders an artifact document as a tab: prose blocks as plain text, SQL blocks
 * as a read-only editor with its own Run button and its own results.
 *
 * The document is fetched, never persisted with the tab — same reason results
 * aren't (see `utils/tab-persistence.ts`). Running a block goes through the
 * ordinary `/query/execute` path, so the reader gets their own capability
 * checks, their own PHI masking and their own audit entry, not the author's.
 */
export function ArtifactView({ tab }: Props) {
  const navigate = useNavigate();
  const connections = useStore((s) => s.connections);
  const activeConnectionId = useStore((s) => s.activeConnectionId);
  const defaultLimitEnabled = useStore((s) => s.defaultLimitEnabled);
  const defaultLimitValue = useStore((s) => s.defaultLimitValue);
  const user = useStore((s) => s.user);
  const addTab = useStore((s) => s.addTab);
  const updateTab = useStore((s) => s.updateTab);
  const setWriteHandoff = useStore((s) => s.setWriteHandoff);
  const setArtifacts = useStore((s) => s.setArtifacts);

  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [blocks, setBlocks] = useState<Record<number, BlockState>>({});

  useEffect(() => {
    if (!tab.artifactId) return;
    setArtifact(null);
    setLoadError(null);
    setBlocks({});
    api
      .getArtifact(tab.artifactId)
      .then((a) => {
        setArtifact(a);
        // Keep the tab title honest after a rename by the author.
        if (a.title !== tab.title) updateTab(tab.id, { title: a.title });
      })
      .catch((err) => setLoadError(err.message));
  }, [tab.artifactId]);

  const patchBlock = (index: number, patch: Partial<BlockState>) =>
    setBlocks((prev) => ({
      ...prev,
      [index]: { ...(prev[index] ?? EMPTY_BLOCK), ...patch },
    }));

  /** A block's own connection wins, then the artifact's, then the session's. */
  const connectionFor = (blockConnectionId?: string) => {
    const id =
      blockConnectionId ?? artifact?.connectionId ?? activeConnectionId;
    return connections.find((c) => c.id === id) ?? null;
  };

  const runBlock = async (
    index: number,
    sql: string,
    connectionId?: string,
  ) => {
    const conn = connectionFor(connectionId);
    if (!conn) return;

    patchBlock(index, { loading: true, error: null });
    try {
      const result = await api.executeQuery(
        conn.id,
        sql,
        defaultLimitEnabled ? defaultLimitValue : null,
      );
      patchBlock(index, {
        loading: false,
        result,
        viewMode:
          conn.type === "mongodb" || conn.type === "elasticsearch"
            ? "json"
            : "table",
      });
    } catch (err: any) {
      patchBlock(index, { loading: false, result: null, error: err.message });
    }
  };

  const openInEditor = (label: string, sql: string, connectionId?: string) => {
    const conn = connectionFor(connectionId);
    addTab(conn?.id ?? null);
    const newTabId = useStore.getState().activeTabId;
    updateTab(newTabId, {
      sql,
      title: label,
      connectionId: conn?.id ?? activeConnectionId,
    });
  };

  const sendToWriteComposer = (
    label: string,
    sql: string,
    connectionId?: string,
  ) => {
    setWriteHandoff({
      writeSql: sql,
      connectionId: connectionFor(connectionId)?.id ?? null,
      title: label,
      description: artifact ? `From artifact: ${artifact.title}` : undefined,
    });
    navigate("/write");
  };

  const handleRestore = async () => {
    if (!artifact) return;
    setRestoring(true);
    try {
      setArtifact(await api.setArtifactArchived(artifact.id, false));
      // The sidebar list was filtered server-side; re-fetch so the restored
      // artifact reappears there instead of only on the next page load.
      setArtifacts(await api.getArtifacts());
      notifications.show({ message: "Artifact restored", color: "green" });
    } catch (err: any) {
      notifications.show({ message: err.message, color: "red" });
    } finally {
      setRestoring(false);
    }
  };

  if (loadError) {
    return (
      <Centered>
        <IconAlertTriangle size={28} color="var(--muted)" />
        <Text size="sm" c="dimmed">
          {loadError}
        </Text>
      </Centered>
    );
  }

  if (!artifact) {
    return (
      <Centered>
        <Loader size="sm" />
        <Text size="sm" c="dimmed">
          Loading artifact…
        </Text>
      </Centered>
    );
  }

  return (
    <div style={{ flex: 1, overflowY: "auto", background: "var(--bg)" }}>
      <div
        style={{ maxWidth: 900, margin: "0 auto", padding: "24px 28px 60px" }}
      >
        {/* Header */}
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <div style={{ minWidth: 0 }}>
            <Text
              fw={700}
              style={{ fontSize: 20, lineHeight: 1.3, wordBreak: "break-word" }}
            >
              {artifact.title}
            </Text>
            <Group gap={8} mt={6}>
              <Text size="xs" c="dimmed">
                {artifact.createdByEmail}
              </Text>
              <Text size="xs" c="dimmed">
                · updated {new Date(artifact.updatedAt).toLocaleString()}
              </Text>
              <Badge
                size="xs"
                variant="light"
                color={artifact.isShared ? "teal" : "gray"}
              >
                {artifact.isShared ? "shared" : "private"}
              </Badge>
              {artifact.archivedAt && (
                <Badge
                  size="xs"
                  variant="light"
                  color="orange"
                  leftSection={<IconArchive size={10} />}
                >
                  archived
                </Badge>
              )}
            </Group>
          </div>
          {/*
            Share only. There is deliberately no destructive control here: this
            page is what a teammate opens from a pasted link, and a delete button
            one click from the title is how a shared document gets lost. Owners
            archive from the sidebar instead, and archiving is reversible.
          */}
          <Group gap={6} wrap="nowrap" style={{ flexShrink: 0 }}>
            {artifact.archivedAt && artifact.createdByEmail === user?.email && (
              <Button
                size="compact-sm"
                variant="default"
                loading={restoring}
                leftSection={<IconArchiveOff size={14} />}
                onClick={handleRestore}
              >
                Restore
              </Button>
            )}
            <Button
              size="compact-sm"
              variant="light"
              leftSection={<IconShare size={14} />}
              onClick={() => copyArtifactShareLink(artifact)}
            >
              Share
            </Button>
          </Group>
        </Group>

        {artifact.description && (
          <Text size="sm" c="dimmed" mt={10} style={{ whiteSpace: "pre-wrap" }}>
            {artifact.description}
          </Text>
        )}

        <div
          style={{
            borderTop: "1px solid var(--border)",
            margin: "18px 0 4px",
          }}
        />

        {/* Blocks */}
        {artifact.blocks.map((block, index) => {
          if (block.type === "text") {
            return (
              <div key={index} style={{ marginTop: 18 }}>
                <MarkdownBlock body={block.body} />
              </div>
            );
          }

          const state = blocks[index] ?? EMPTY_BLOCK;
          const conn = connectionFor(block.connectionId);
          const label = block.label || `Query ${index + 1}`;
          const isWrite = WRITE_STATEMENT.test(block.sql);
          const lines = block.sql.split("\n").length;
          const editorHeight = Math.min(
            BLOCK_EDITOR_MAX,
            Math.max(BLOCK_EDITOR_MIN, lines * LINE_HEIGHT + 20),
          );

          return (
            <div key={index} style={{ marginTop: 18 }}>
              <div
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  overflow: "hidden",
                  background: "var(--surface)",
                }}
              >
                <Group
                  justify="space-between"
                  wrap="nowrap"
                  style={{
                    padding: "7px 12px",
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  <Text
                    size="xs"
                    fw={600}
                    tt="uppercase"
                    c="dimmed"
                    style={{ letterSpacing: 0.6 }}
                  >
                    {label}
                  </Text>
                  {conn ? (
                    <Badge
                      size="xs"
                      variant="light"
                      color={envColor(conn.env)}
                      ff="monospace"
                    >
                      {conn.name} · {conn.env}
                    </Badge>
                  ) : (
                    <Badge size="xs" variant="light" color="gray">
                      no connection
                    </Badge>
                  )}
                </Group>
                <Editor
                  height={`${editorHeight}px`}
                  language={monacoLanguageForDb(conn?.type ?? null)}
                  theme="vs"
                  value={block.sql}
                  loading={null}
                  options={{
                    ...baseSqlEditorOptions,
                    readOnly: true,
                    // The document is the source of truth here; a caret and a
                    // scrollbar are all this editor needs.
                    quickSuggestions: false,
                    suggestOnTriggerCharacters: false,
                    lineNumbers: "off",
                    folding: false,
                    scrollbar: { vertical: "auto", horizontal: "auto" },
                  }}
                />
              </div>

              <Group gap={6} mt={7}>
                {isWrite ? (
                  <>
                    <Tooltip label="Artifacts run read queries only">
                      <Button
                        size="compact-xs"
                        variant="default"
                        disabled
                        leftSection={<IconPlayerPlay size={12} />}
                      >
                        Run
                      </Button>
                    </Tooltip>
                    <Badge
                      size="xs"
                      variant="light"
                      color="orange"
                      leftSection={<IconAlertTriangle size={10} />}
                    >
                      write query
                    </Badge>
                    {user?.canWrite && (
                      <Button
                        size="compact-xs"
                        variant="light"
                        color="orange"
                        leftSection={<IconWand size={12} />}
                        onClick={() =>
                          sendToWriteComposer(
                            label,
                            block.sql,
                            block.connectionId,
                          )
                        }
                      >
                        Send to write composer
                      </Button>
                    )}
                  </>
                ) : (
                  <Tooltip
                    label={
                      conn
                        ? "Runs as you — your permissions, your masking"
                        : "You don't have read access to this block's connection"
                    }
                  >
                    <Button
                      size="compact-xs"
                      variant="light"
                      loading={state.loading}
                      disabled={!conn}
                      leftSection={<IconPlayerPlay size={12} />}
                      onClick={() =>
                        runBlock(index, block.sql, block.connectionId)
                      }
                    >
                      Run
                    </Button>
                  </Tooltip>
                )}
                <Button
                  size="compact-xs"
                  variant="subtle"
                  color="gray"
                  leftSection={<IconExternalLink size={12} />}
                  onClick={() =>
                    openInEditor(label, block.sql, block.connectionId)
                  }
                >
                  Open in editor
                </Button>
              </Group>

              {(state.result || state.error) && (
                <div
                  style={{
                    marginTop: 8,
                    height: 320,
                    display: "flex",
                    flexDirection: "column",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    overflow: "hidden",
                  }}
                >
                  <ResultsGrid
                    tab={{
                      ...tab,
                      // A synthetic id: this grid's state lives on the block, so
                      // it must never address the real tab in the store.
                      id: `${tab.id}:block:${index}`,
                      sql: block.sql,
                      connectionId: conn?.id ?? null,
                      result: state.result,
                      loading: state.loading,
                      error: state.error,
                      viewMode: state.viewMode,
                    }}
                    onViewModeChange={(viewMode) =>
                      patchBlock(index, { viewMode })
                    }
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        background: "var(--bg)",
      }}
    >
      {children}
    </div>
  );
}
