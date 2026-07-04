import { useState, useEffect, useMemo, useRef } from "react";
import Editor from "@monaco-editor/react";
import {
  Text,
  Button,
  Group,
  Select,
  TextInput,
  Textarea,
  Badge,
  Alert,
} from "@mantine/core";
import {
  IconPlayerPlay,
  IconSend,
  IconBolt,
  IconSparkles,
  IconWand,
  IconInfoCircle,
} from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { useStore } from "../../store";
import { api } from "../../utils/api-client";
import type {
  ConnectionInfo,
  QueryResult,
  WriteRequest,
  WriteAiReview,
  DatabaseType,
} from "../../types";
import { EnvBadge, PreviewTable, AiReviewCard } from "./shared";

function monacoLang(dbType?: DatabaseType): string {
  if (dbType === "mongodb") return "javascript";
  if (dbType === "elasticsearch") return "plaintext";
  return "sql";
}

const WRITE_PLACEHOLDERS: Record<DatabaseType, string> = {
  postgres: "UPDATE patients SET status = 'active' WHERE id = 123",
  mssql: "UPDATE patients SET status = 'active' WHERE id = 123",
  mongodb:
    'db.patients.updateMany({ status: "pending" }, { $set: { status: "active" } })',
  elasticsearch:
    'POST /patients/_update_by_query\n{ "query": {...}, "script": {...} }',
};

const SELECT_PLACEHOLDERS: Record<DatabaseType, string> = {
  postgres: "SELECT id, status FROM patients WHERE id = 123",
  mssql: "SELECT id, status FROM patients WHERE id = 123",
  mongodb: 'db.patients.find({ status: "pending" })',
  elasticsearch: 'GET /patients/_search\n{ "query": {...} }',
};

function editorOptions(placeholder: string) {
  return {
    minimap: { enabled: false },
    fontSize: 13,
    fontFamily: "IBM Plex Mono, monospace",
    lineNumbers: "on" as const,
    scrollBeyondLastLine: false,
    padding: { top: 8, bottom: 8 },
    automaticLayout: true,
    tabSize: 2,
    wordWrap: "on" as const,
    placeholder,
    overviewRulerBorder: false,
  };
}

// Draft persistence — keeps an in-progress *new* request alive across navigation.
const DRAFT_KEY = "dbpilot_write_draft";
interface ComposerDraft {
  title: string;
  description: string;
  connectionId: string | null;
  selectSql: string;
  writeSql: string;
}
export function loadDraft(): Partial<ComposerDraft> | null {
  try {
    return JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
  } catch {
    return null;
  }
}
function saveDraft(d: ComposerDraft) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
  } catch {
    /* ignore quota errors */
  }
}
export function clearDraft() {
  localStorage.removeItem(DRAFT_KEY);
}

export interface ComposerSubmit {
  title: string;
  description?: string;
  connectionId: string;
  selectSql: string;
  writeSql: string;
  note?: string;
}

interface WriteComposerProps {
  mode: "create" | "revise";
  connections: ConnectionInfo[];
  directEnvs: string[];
  writeModeEnabled: boolean;
  /** Lock the target connection (revise: you can't move a request to another env). */
  lockConnectionId?: string;
  initial?: Partial<ComposerDraft>;
  /** Show a "note to reviewer" field (revise). */
  showNote?: boolean;
  onSubmit: (payload: ComposerSubmit) => Promise<WriteRequest>;
  onSubmitted?: (wr: WriteRequest) => void;
  onCancel?: () => void;
}

/**
 * The shared write composer used both to create a new request and to edit &
 * resubmit an existing one. Same tooling in both cases: generate the verify
 * SELECT from the write, run a preview, review with AI, and apply the AI's
 * suggested correction.
 */
export function WriteComposer({
  mode,
  connections,
  directEnvs,
  writeModeEnabled,
  lockConnectionId,
  initial,
  showNote,
  onSubmit,
  onSubmitted,
  onCancel,
}: WriteComposerProps) {
  const isCreate = mode === "create";
  const writeHandoff = useStore((s) => s.writeHandoff);
  const setWriteHandoff = useStore((s) => s.setWriteHandoff);

  // For a new request, seed from the persisted draft; otherwise from `initial`.
  const seedRef = useRef<Partial<ComposerDraft> | null>(
    isCreate ? loadDraft() : (initial ?? null),
  );
  const seed = seedRef.current;

  const [title, setTitle] = useState(seed?.title ?? initial?.title ?? "");
  const [description, setDescription] = useState(
    seed?.description ?? initial?.description ?? "",
  );
  const [connectionId, setConnectionId] = useState<string | null>(
    lockConnectionId ?? seed?.connectionId ?? initial?.connectionId ?? null,
  );
  const [selectSql, setSelectSql] = useState(
    seed?.selectSql ?? initial?.selectSql ?? "",
  );
  const [writeSql, setWriteSql] = useState(
    seed?.writeSql ?? initial?.writeSql ?? "",
  );
  const [note, setNote] = useState("");

  const [preview, setPreview] = useState<QueryResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [aiReview, setAiReview] = useState<WriteAiReview | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [genSelecting, setGenSelecting] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const conn = connections.find((c) => c.id === connectionId);
  const isDirect = conn ? directEnvs.includes(conn.env) : false;
  const dbType = conn?.type;

  const connectionOptions = useMemo(
    () =>
      connections.map((c) => ({
        value: c.id,
        label: `${c.env} · ${c.name} · ${c.type}`,
      })),
    [connections],
  );

  // Default the connection to the first writable one once they load (create).
  useEffect(() => {
    if (lockConnectionId) return;
    setConnectionId((prev) =>
      prev && connections.some((c) => c.id === prev)
        ? prev
        : (connections[0]?.id ?? null),
    );
  }, [connections, lockConnectionId]);

  // Persist the in-progress draft (create only).
  useEffect(() => {
    if (!isCreate) return;
    const t = setTimeout(
      () =>
        saveDraft({ title, description, connectionId, selectSql, writeSql }),
      400,
    );
    return () => clearTimeout(t);
  }, [isCreate, title, description, connectionId, selectSql, writeSql]);

  // Consume a handoff (create only): from the read section / AI assistant (write
  // only) or from "Duplicate request" (all fields).
  useEffect(() => {
    if (!isCreate || !writeHandoff) return;
    setWriteSql(writeHandoff.writeSql);
    setSelectSql(writeHandoff.selectSql ?? "");
    if (writeHandoff.connectionId) setConnectionId(writeHandoff.connectionId);
    if (writeHandoff.title != null) setTitle(writeHandoff.title);
    if (writeHandoff.description != null)
      setDescription(writeHandoff.description);
    setPreview(null);
    setAiReview(null);
    setWriteHandoff(null);
    notifications.show({
      title: "Loaded into the write composer",
      message: "Review it, pick the target connection, then submit.",
      color: "teal",
      icon: <IconWand size={16} />,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [writeHandoff]);

  const handlePreview = async () => {
    if (!connectionId || !selectSql.trim()) {
      notifications.show({
        message: "Enter a SELECT query and pick a connection",
        color: "orange",
      });
      return;
    }
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      setPreview(await api.executeQuery(connectionId, selectSql.trim()));
    } catch (e: any) {
      setPreview(null);
      setPreviewError(e.message);
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleGenerateSelect = async () => {
    if (!connectionId || !writeSql.trim()) {
      notifications.show({
        message: "Write the statement and pick a connection first",
        color: "orange",
      });
      return;
    }
    setGenSelecting(true);
    try {
      const { query, explanation } = await api.suggestSelectQuery({
        connectionId,
        writeSql: writeSql.trim(),
        intent: description.trim() || undefined,
        currentSelect: selectSql.trim() || undefined,
      });
      if (query) {
        setSelectSql(query);
        setPreview(null);
        notifications.show({
          title: "Verify SELECT generated",
          message: explanation || "Review and edit, then run the preview.",
          color: "teal",
          icon: <IconWand size={16} />,
        });
      } else {
        notifications.show({
          message: "The AI did not return a usable SELECT",
          color: "orange",
        });
      }
    } catch (e: any) {
      notifications.show({ message: e.message, color: "red" });
    } finally {
      setGenSelecting(false);
    }
  };

  const handleAiReview = async () => {
    if (!connectionId || !writeSql.trim()) {
      notifications.show({
        message: "Enter a write statement and pick a connection first",
        color: "orange",
      });
      return;
    }
    setAiLoading(true);
    try {
      setAiReview(
        await api.reviewWriteDraft({
          connectionId,
          selectSql: selectSql.trim() || undefined,
          writeSql: writeSql.trim(),
        }),
      );
    } catch (e: any) {
      notifications.show({ message: e.message, color: "red" });
    } finally {
      setAiLoading(false);
    }
  };

  const applySuggestion = (s: { writeSql?: string; selectSql?: string }) => {
    if (s.writeSql) setWriteSql(s.writeSql);
    if (s.selectSql) setSelectSql(s.selectSql);
    setAiReview(null);
    setPreview(null);
    notifications.show({
      title: "Suggestion applied",
      message: "Re-run “Review with AI” to confirm it now passes.",
      color: "teal",
      icon: <IconWand size={16} />,
    });
  };

  const handleSubmit = async () => {
    if (
      !title.trim() ||
      !connectionId ||
      !writeSql.trim() ||
      !selectSql.trim()
    ) {
      notifications.show({
        message:
          "Title, connection, write statement and a verify SELECT are all required",
        color: "orange",
      });
      return;
    }
    setSubmitting(true);
    try {
      const wr = await onSubmit({
        title: title.trim(),
        description: description.trim() || undefined,
        connectionId,
        selectSql: selectSql.trim(),
        writeSql: writeSql.trim(),
        note: note.trim() || undefined,
      });
      const verb = isCreate ? "Submitted" : "Resubmitted";
      if (wr.status === "EXECUTED") {
        notifications.show({
          title: isCreate ? "Write executed" : "Resubmitted & executed",
          message: `${wr.rowsAffected ?? 0} row(s) affected${wr.transactional === false ? " (non-transactional)" : ""}`,
          color: "green",
          icon: <IconBolt size={16} />,
        });
      } else if (wr.status === "FAILED") {
        notifications.show({
          title: "Write failed",
          message: wr.executionError || "Execution failed",
          color: "red",
        });
      } else {
        notifications.show({
          message: `${verb} for approval`,
          color: "teal",
          icon: <IconSend size={16} />,
        });
      }
      if (isCreate) {
        setTitle("");
        setDescription("");
        setSelectSql("");
        setWriteSql("");
        setPreview(null);
        setAiReview(null);
        clearDraft();
      }
      onSubmitted?.(wr);
    } catch (e: any) {
      notifications.show({ message: e.message, color: "red" });
    } finally {
      setSubmitting(false);
    }
  };

  const submitLabel = !isCreate
    ? "Resubmit"
    : isDirect
      ? "Run write"
      : "Submit for approval";

  return (
    <div>
      <Group grow mb="sm" align="flex-start">
        <TextInput
          label="Title"
          placeholder="e.g. Fix duplicated patient status"
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
        />
        {lockConnectionId ? (
          <TextInput
            label="Target connection"
            value={
              conn
                ? `${conn.env} · ${conn.name} · ${conn.type}`
                : lockConnectionId
            }
            disabled
            styles={{ input: { opacity: 0.7 } }}
          />
        ) : (
          <Select
            label="Target connection"
            data={connectionOptions}
            value={connectionId}
            onChange={setConnectionId}
            searchable
            nothingFoundMessage="No writable connections"
          />
        )}
      </Group>
      <Textarea
        label="Description / reason (optional)"
        placeholder="Why is this change needed? Link a ticket if relevant."
        value={description}
        onChange={(e) => setDescription(e.currentTarget.value)}
        autosize
        minRows={1}
        maxRows={3}
        mb="sm"
      />

      {conn && (
        <Group gap={8} mb="sm">
          <EnvBadge env={conn.env} />
          <Badge
            size="sm"
            variant="light"
            color={isDirect ? "green" : "yellow"}
            style={{ overflow: "visible" }}
          >
            {isDirect ? "Direct write (runs immediately)" : "Requires approval"}
          </Badge>
          {conn.database && (
            <Text size="xs" c="dimmed" ff="monospace">
              {conn.database}
            </Text>
          )}
        </Group>
      )}

      {/* 1 · Write statement */}
      <Text
        size="xs"
        fw={700}
        tt="uppercase"
        c="dimmed"
        mb={4}
        mt="xs"
        style={{ letterSpacing: 0.5 }}
      >
        1 · Write statement{" "}
        <Text component="span" size="xs" c="dimmed" fw={400} tt="none">
          — what you want to do (single INSERT / UPDATE / DELETE)
        </Text>
      </Text>
      <div
        style={{
          border: "1px solid var(--mantine-color-orange-3)",
          borderRadius: 8,
          overflow: "hidden",
          marginBottom: 12,
        }}
      >
        <Editor
          height="110px"
          language={monacoLang(dbType)}
          theme="vs"
          value={writeSql}
          onChange={(v) => {
            setWriteSql(v || "");
            if (aiReview) setAiReview(null);
          }}
          options={editorOptions(WRITE_PLACEHOLDERS[dbType || "postgres"])}
        />
      </div>

      {/* 2 · Verify SELECT */}
      <Group justify="space-between" align="flex-end" mb={4}>
        <Text
          size="xs"
          fw={700}
          tt="uppercase"
          c="dimmed"
          style={{ letterSpacing: 0.5 }}
        >
          2 · Verify SELECT{" "}
          <Text component="span" size="xs" c="red" fw={600} tt="none">
            (required)
          </Text>
          <Text component="span" size="xs" c="dimmed" fw={400} tt="none">
            {" "}
            — previews the rows the write will affect
          </Text>
        </Text>
        <Button
          size="compact-xs"
          variant="light"
          color="teal"
          leftSection={<IconWand size={13} />}
          onClick={handleGenerateSelect}
          loading={genSelecting}
          disabled={!writeSql.trim() || !connectionId}
        >
          Generate from write
        </Button>
      </Group>
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 8,
          overflow: "hidden",
          marginBottom: 8,
        }}
      >
        <Editor
          height="110px"
          language={monacoLang(dbType)}
          theme="vs"
          value={selectSql}
          onChange={(v) => {
            setSelectSql(v || "");
            setPreview(null);
          }}
          options={editorOptions(SELECT_PLACEHOLDERS[dbType || "postgres"])}
        />
      </div>
      <Group mb="md">
        <Button
          size="xs"
          variant="light"
          color="blue"
          leftSection={<IconPlayerPlay size={14} />}
          onClick={handlePreview}
          loading={previewLoading}
          disabled={!selectSql.trim() || !connectionId}
        >
          Run preview
        </Button>
      </Group>
      {previewError && (
        <Alert color="red" mb="md" variant="light">
          {previewError}
        </Alert>
      )}
      {preview && (
        <div style={{ marginBottom: 16 }}>
          <PreviewTable result={preview} />
        </div>
      )}

      {aiReview && (
        <div style={{ marginBottom: 12 }}>
          <AiReviewCard review={aiReview} onApply={applySuggestion} />
        </div>
      )}

      {showNote && (
        <Textarea
          label="Note to reviewer (optional)"
          placeholder="What changed since the last review…"
          value={note}
          onChange={(e) => setNote(e.currentTarget.value)}
          autosize
          minRows={1}
          maxRows={3}
          mb="md"
        />
      )}

      {!writeModeEnabled && (
        <Alert
          color="red"
          mb="md"
          variant="light"
          icon={<IconInfoCircle size={16} />}
        >
          Write mode is disabled by an administrator — you can draft but not
          submit.
        </Alert>
      )}

      <Group justify="space-between">
        <Button
          size="sm"
          variant="light"
          color="primary"
          leftSection={<IconSparkles size={16} />}
          onClick={handleAiReview}
          loading={aiLoading}
          disabled={!connectionId || !writeSql.trim()}
        >
          Review with AI
        </Button>
        <Group gap={8}>
          {onCancel && (
            <Button variant="subtle" color="gray" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button
            color={!isCreate ? "grape" : isDirect ? "green" : "primary"}
            leftSection={
              isCreate && isDirect ? (
                <IconBolt size={16} />
              ) : (
                <IconSend size={16} />
              )
            }
            onClick={handleSubmit}
            loading={submitting}
            disabled={
              !writeModeEnabled ||
              !title.trim() ||
              !connectionId ||
              !writeSql.trim() ||
              !selectSql.trim()
            }
          >
            {submitLabel}
          </Button>
        </Group>
      </Group>
    </div>
  );
}
