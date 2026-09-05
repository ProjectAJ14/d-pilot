import {
  useState,
  useEffect,
  useMemo,
  useRef,
  type CSSProperties,
} from "react";
import Editor from "@monaco-editor/react";
import {
  Text,
  Button,
  Group,
  Select,
  TextInput,
  Textarea,
  Alert,
  Checkbox,
} from "@mantine/core";
import {
  IconPlayerPlay,
  IconSend,
  IconDeviceFloppy,
  IconBolt,
  IconSparkles,
  IconWand,
  IconInfoCircle,
  IconEye,
  IconStack2,
  IconAlertTriangle,
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
import { EnvBadge, PreviewTable, AiReviewCard, StepBadge } from "./shared";
import { baseSqlEditorOptions, useEditorTheme } from "../../utils/monaco-editor-options";
import { useVimMode } from "../../utils/vim-mode";

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
  // Same config as the main read editor (keeps them in sync) plus a placeholder.
  return { ...baseSqlEditorOptions, placeholder };
}

// Drag-to-resize wrapper: the browser draws a grip at the bottom-right corner
// and Monaco's automaticLayout follows the height change.
const RESIZE_WRAPPER: CSSProperties = {
  minHeight: 80,
  resize: "vertical",
  overflow: "hidden",
};

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
  noTransaction?: boolean;
}

interface WriteAnalysis {
  statementCount: number;
  isMigration: boolean;
  hasDdl: boolean;
  requiresNoTransaction: boolean;
  blocked?: string;
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
  /** Save the request without submitting or running it. Shows a "Save request" button. */
  onSave?: (payload: ComposerSubmit) => Promise<WriteRequest>;
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
  onSave,
  onSubmitted,
  onCancel,
}: WriteComposerProps) {
  const isCreate = mode === "create";
  const writeHandoff = useStore((s) => s.writeHandoff);
  const setWriteHandoff = useStore((s) => s.setWriteHandoff);
  // Separate vim instances — one per editor, so they never share a mode.
  const vimWrite = useVimMode();
  const vimSelect = useVimMode();

  // For a new request, seed from the persisted draft; otherwise from `initial`.
  const seedRef = useRef<Partial<ComposerDraft> | null>(
    isCreate ? loadDraft() : (initial ?? null),
  );
  const seed = seedRef.current;

  const editorTheme = useEditorTheme();
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
  const [analysis, setAnalysis] = useState<WriteAnalysis | null>(null);
  const [noTransaction, setNoTransaction] = useState(false);

  const [preview, setPreview] = useState<QueryResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [aiReview, setAiReview] = useState<WriteAiReview | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [genSelecting, setGenSelecting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [saving, setSaving] = useState(false);

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

  // Classify the write (single-DML vs migration) as it's typed. The server is
  // authoritative — it decides migration mode, so the verify SELECT and the
  // no-rollback toggle stay in sync with how it will actually run.
  useEffect(() => {
    const sql = writeSql.trim();
    if (!connectionId || !sql) {
      setAnalysis(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const a = await api.analyzeWrite({ connectionId, writeSql: sql });
        if (!cancelled) setAnalysis(a);
      } catch {
        if (!cancelled) setAnalysis(null);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [connectionId, writeSql]);

  const isMigration = analysis?.isMigration ?? false;
  const requiresNoTransaction = analysis?.requiresNoTransaction ?? false;
  // Drop a stale no-rollback opt-in once it's no longer needed.
  useEffect(() => {
    if (!requiresNoTransaction && noTransaction) setNoTransaction(false);
  }, [requiresNoTransaction, noTransaction]);

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

  /** `save: true` stores the request as a draft — nothing is queued or executed. */
  const handleSubmit = async (save = false) => {
    if (
      !title.trim() ||
      !connectionId ||
      !writeSql.trim() ||
      (!isMigration && !selectSql.trim())
    ) {
      notifications.show({
        message: isMigration
          ? "Title, connection and the migration script are required"
          : "Title, connection, write statement and a verify SELECT are all required",
        color: "orange",
      });
      return;
    }
    if (analysis?.blocked) {
      notifications.show({ message: analysis.blocked, color: "red" });
      return;
    }
    if (requiresNoTransaction && !noTransaction) {
      notifications.show({
        message:
          'This script can\'t run in a transaction — tick "Run without rollback" to submit it.',
        color: "orange",
      });
      return;
    }
    const setBusy = save ? setSaving : setSubmitting;
    setBusy(true);
    try {
      const wr = await (save ? onSave! : onSubmit)({
        title: title.trim(),
        description: description.trim() || undefined,
        connectionId,
        selectSql: isMigration ? "" : selectSql.trim(),
        writeSql: writeSql.trim(),
        note: note.trim() || undefined,
        noTransaction: isMigration ? noTransaction : undefined,
      });
      const verb = isCreate ? "Submitted" : "Resubmitted";
      if (wr.status === "DRAFT") {
        notifications.show({
          title: "Request saved",
          message:
            "It has not run — open it under Requests to submit or run it.",
          color: "teal",
          icon: <IconDeviceFloppy size={16} />,
        });
      } else if (wr.status === "EXECUTED") {
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
      setBusy(false);
    }
  };

  const submitLabel = !isCreate
    ? "Resubmit"
    : isDirect
      ? "Run write"
      : "Submit for approval";

  // Mockup-style env strip colors: teal for direct, amber for approval.
  const modeMeta = isDirect
    ? {
        label: "Direct write · runs immediately",
        text: "var(--accent)",
        dot: "var(--accent)",
        halo: "color-mix(in srgb, var(--accent) 18%, transparent)",
      }
    : {
        label: "Approval required · second reviewer",
        text: "var(--warning)",
        dot: "var(--warning)",
        halo: "color-mix(in srgb, var(--warning) 18%, transparent)",
      };

  // A light hint mirroring the required-field gating.
  const runHint = !title.trim()
    ? "Add a title"
    : !connectionId
      ? "Pick a connection"
      : !writeSql.trim()
        ? "Write a statement first"
        : analysis?.blocked
          ? analysis.blocked
          : isMigration
            ? requiresNoTransaction && !noTransaction
              ? 'Enable "Run without rollback"'
              : ""
            : !selectSql.trim()
              ? "Add a verify SELECT"
              : "";

  const submitDisabled =
    !writeModeEnabled ||
    !title.trim() ||
    !connectionId ||
    !writeSql.trim() ||
    (!isMigration && !selectSql.trim()) ||
    !!analysis?.blocked ||
    (requiresNoTransaction && !noTransaction);

  const previewNote = preview
    ? `Preview ran · ${preview.totalRows} row(s) returned`
    : "Runs the verify SELECT only — read-only, changes nothing";

  return (
    <div>
      <Group grow mb="md" align="flex-start">
        <TextInput
          label="Title"
          radius="md"
          placeholder="e.g. Fix duplicated patient status"
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
        />
        {lockConnectionId ? (
          <TextInput
            label="Target connection"
            radius="md"
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
            radius="md"
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
        radius="md"
        placeholder="Why is this change needed? Link a ticket if relevant."
        value={description}
        onChange={(e) => setDescription(e.currentTarget.value)}
        autosize
        minRows={1}
        maxRows={3}
        mb="md"
      />

      {conn && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
            padding: "11px 14px",
            background: "var(--surface2)",
            border: "1px solid var(--border)",
            borderRadius: 11,
            marginBottom: 16,
          }}
        >
          <EnvBadge env={conn.env} />
          <span style={{ width: 1, height: 16, background: "var(--border)" }} />
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              fontSize: 12.5,
              fontWeight: 600,
              color: modeMeta.text,
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: modeMeta.dot,
                boxShadow: `0 0 0 3px ${modeMeta.halo}`,
              }}
            />
            {modeMeta.label}
          </span>
          {conn.database && (
            <Text
              size="xs"
              c="dimmed"
              ff="monospace"
              style={{ marginLeft: "auto" }}
            >
              {conn.database}
            </Text>
          )}
        </div>
      )}

      {/* 1 · Write statement */}
      <Group gap={8} mb={9} align="center">
        <StepBadge n={1} />
        <Text size="sm" fw={600} c="secondary.9">
          {isMigration ? "Migration script" : "Write statement"}
        </Text>
        <Text size="xs" c="dimmed">
          {isMigration
            ? "runs as one transaction"
            : "single statement, or paste a migration script"}
        </Text>
        {isMigration && analysis && (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              fontSize: 11,
              fontWeight: 600,
              color: "var(--accent-text)",
              background: "color-mix(in srgb, var(--accent) 12%, transparent)",
              border: "1px solid color-mix(in srgb, var(--accent) 35%, transparent)",
              borderRadius: 999,
              padding: "1px 9px",
            }}
          >
            <IconStack2 size={12} />
            {analysis.statementCount} statement
            {analysis.statementCount === 1 ? "" : "s"}
            {analysis.hasDdl ? " · DDL" : ""}
          </span>
        )}
      </Group>
      <div
        style={{
          border: "1px solid color-mix(in srgb, var(--accent) 35%, transparent)",
          borderRadius: 12,
          overflow: "hidden",
          marginBottom: 20,
          height: 132,
          ...RESIZE_WRAPPER,
        }}
      >
        <Editor
          height="100%"
          language={monacoLang(dbType)}
          theme={editorTheme}
          value={writeSql}
          onChange={(v) => {
            setWriteSql(v || "");
            if (aiReview) setAiReview(null);
          }}
          onMount={vimWrite.attachEditor}
          options={editorOptions(WRITE_PLACEHOLDERS[dbType || "postgres"])}
        />
      </div>

      {/* Migration mode: no verify SELECT (there is no single row-set to preview). */}
      {isMigration && (
        <Alert
          color="teal"
          variant="light"
          mb="md"
          icon={<IconStack2 size={16} />}
        >
          Migration mode — multiple statements or DDL detected. The verify
          SELECT is disabled because there's no single set of rows to preview;
          the whole script runs as one change and the AI review checks it
          end-to-end.
        </Alert>
      )}

      {isMigration && analysis?.blocked && (
        <Alert
          color="red"
          variant="light"
          mb="md"
          icon={<IconAlertTriangle size={16} />}
        >
          {analysis.blocked}
        </Alert>
      )}

      {isMigration && requiresNoTransaction && (
        <div
          style={{
            border: "1px solid color-mix(in srgb, var(--warning) 50%, transparent)",
            background: "color-mix(in srgb, var(--warning) 8%, transparent)",
            borderRadius: 11,
            padding: "12px 14px",
            marginBottom: 16,
          }}
        >
          <Checkbox
            checked={noTransaction}
            onChange={(e) => setNoTransaction(e.currentTarget.checked)}
            color="yellow"
            label={
              <Text size="sm" fw={600} c="var(--warning)">
                Run without rollback
              </Text>
            }
            description="This script contains a statement that can't run inside a transaction (e.g. CREATE INDEX CONCURRENTLY, VACUUM). Statements will be committed one by one — if it fails partway, earlier statements stay applied and can't be undone."
          />
        </div>
      )}

      {/* 2 · Verify SELECT (single-statement DML only) */}
      {!isMigration && (
        <>
          <Group gap={8} mb={9} align="center">
            <StepBadge n={2} />
            <Text size="sm" fw={600} c="secondary.9">
              Verify SELECT
            </Text>
            <Text size="xs" c="red" fw={600}>
              required
            </Text>
            <Text size="xs" c="dimmed">
              a read-only query that previews the rows the write will affect
            </Text>
          </Group>
          <div
            style={{
              border: "1px solid var(--border)",
              borderRadius: 12,
              overflow: "hidden",
              background: "var(--surface)",
            }}
          >
            {/* header bar */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                padding: "8px 10px 8px 14px",
                borderBottom: "1px solid var(--border)",
                background: "var(--surface2)",
              }}
            >
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 7,
                  fontSize: 11.5,
                  fontWeight: 600,
                  letterSpacing: "0.02em",
                  color: "var(--muted)",
                }}
              >
                <IconEye size={13} />
                READ-ONLY PREVIEW QUERY
              </span>
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
            </div>
            <div style={{ height: 104, ...RESIZE_WRAPPER }}>
              <Editor
                height="100%"
                language={monacoLang(dbType)}
                theme={editorTheme}
                value={selectSql}
                onChange={(v) => {
                  setSelectSql(v || "");
                  setPreview(null);
                }}
                onMount={vimSelect.attachEditor}
                options={editorOptions(
                  SELECT_PLACEHOLDERS[dbType || "postgres"],
                )}
              />
            </div>
            {/* footer bar */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "9px 12px",
                borderTop: "1px solid var(--border)",
                background: "var(--surface2)",
              }}
            >
              <Button
                size="xs"
                variant="light"
                color="blue"
                leftSection={<IconPlayerPlay size={14} />}
                onClick={handlePreview}
                loading={previewLoading}
                disabled={!selectSql.trim() || !connectionId}
              >
                Run this SELECT
              </Button>
              <Text size="xs" c="dimmed">
                {previewNote}
              </Text>
            </div>
          </div>
        </>
      )}
      {previewError && (
        <Alert color="red" mt="md" variant="light">
          {previewError}
        </Alert>
      )}
      {preview && (
        <div style={{ marginTop: 16 }}>
          <PreviewTable result={preview} />
        </div>
      )}

      {aiReview && (
        <div style={{ marginTop: 20 }}>
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
          mt="md"
        />
      )}

      {!writeModeEnabled && (
        <Alert
          color="red"
          mt="md"
          variant="light"
          icon={<IconInfoCircle size={16} />}
        >
          Write mode is disabled by an administrator — you can draft but not
          submit.
        </Alert>
      )}

      <Group
        justify="space-between"
        align="center"
        mt="lg"
        pt="md"
        style={{ borderTop: "1px solid var(--border)" }}
      >
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
        <Group gap={12} align="center">
          {runHint && (
            <Text size="xs" c="dimmed">
              {runHint}
            </Text>
          )}
          {onCancel && (
            <Button variant="subtle" color="gray" onClick={onCancel}>
              Cancel
            </Button>
          )}
          {onSave && (
            <Button
              variant="default"
              leftSection={<IconDeviceFloppy size={16} />}
              onClick={() => handleSubmit(true)}
              loading={saving}
              disabled={submitDisabled || submitting}
            >
              Save request
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
            onClick={() => handleSubmit()}
            loading={submitting}
            disabled={submitDisabled || saving}
          >
            {submitLabel}
          </Button>
        </Group>
      </Group>
    </div>
  );
}
