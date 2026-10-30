import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import Editor, { DiffEditor } from "@monaco-editor/react";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Group,
  Loader,
  Select,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import {
  IconCopy,
  IconFileExport,
  IconLock,
  IconPencil,
  IconRefresh,
} from "@tabler/icons-react";
import type { editor as MonacoEditor } from "monaco-editor";
import type {
  DbObjectDefinition,
  DbObjectDependencies,
  DbObjectInfo,
  DbObjectReference,
  QueryTab,
} from "../../types";
import { api, ApiError } from "../../utils/api-client";
import { useStore } from "../../store";
import {
  baseSqlEditorOptions,
  useEditorTheme,
} from "../../utils/monaco-editor-options";
import { copyToClipboard } from "../../utils/clipboard";
import { runEnvStyle } from "../../utils/environments";
import { monacoLanguageForDb } from "./query-editor";
import { notifyError } from "../../utils/notify-error";
import { pressable } from "../../utils/pressable";

/** One side of the view: loading, the object, or why there is none. */
type Side =
  | { state: "loading" }
  | { state: "ok"; obj: DbObjectDefinition }
  | { state: "missing" }
  | { state: "error"; message: string };

/**
 * Reads one side into `set`; the returned cleanup drops a late answer, so a
 * slow read for an earlier pick never lands on a newer one.
 */
function load(connectionId: string, o: DbObjectInfo, set: (s: Side) => void) {
  let live = true;
  const put = (side: Side) => live && set(side);
  put({ state: "loading" });
  api
    .getObjectDefinition(connectionId, o)
    .then((obj) => put({ state: "ok", obj }))
    .catch((err) =>
      put(
        err instanceof ApiError && err.code === "OBJECT_NOT_FOUND"
          ? { state: "missing" }
          : { state: "error", message: err.message },
      ),
    );
  return () => {
    live = false;
  };
}

const HIDDEN =
  "Definition not available: the object is encrypted, or this connection's login lacks VIEW DEFINITION permission.";

/** The text a side contributes to a diff; a missing object diffs as empty. */
const sideText = (s: Side) =>
  s.state === "ok" ? (s.obj.definition ?? `-- ${HIDDEN}`) : "";

/** The "compare with" choice that diffs against text the user pastes. */
const PASTE = "__paste__";

const label = (o: DbObjectInfo) =>
  `${o.schema ? `${o.schema}.` : ""}${o.name}${o.args != null ? `(${o.args})` : ""}`;

/**
 * A procedure, function, view or trigger, read live from its database —
 * never persisted, like query results. "Compare with…" fetches the same object
 * (same schema, name and overload) from another connection and diffs the two;
 * an object that exists on only one side is a valid answer, not an error.
 */
export function ObjectView({ tab }: { tab: QueryTab }) {
  const connections = useStore((s) => s.connections);
  const theme = useEditorTheme();
  const object = tab.object!;
  const conn = connections.find((c) => c.id === tab.connectionId);
  const [mine, setMine] = useState<Side>({ state: "loading" });
  const [otherId, setOtherId] = useState<string | null>(
    tab.compareWith ?? null,
  );
  const [otherSide, setOther] = useState<Side | null>(null);
  const [reload, setReload] = useState(0);
  const [editing, setEditing] = useState(false);
  const [deps, setDeps] = useState<DbObjectDependencies | null>(null);
  const [depsError, setDepsError] = useState<string | null>(null);
  // MongoDB/Elasticsearch objects are JSON documents, read-only here, with
  // no dependency graph to show.
  const isSql = conn?.type === "postgres" || conn?.type === "mssql";
  const language = isSql ? monacoLanguageForDb(conn?.type) : "json";
  const canAuthor = useStore(
    (s) =>
      !!s.user?.isAdmin ||
      !!(conn && s.user?.writeEnvironments?.includes(conn.env)),
  );

  useEffect(() => {
    if (tab.connectionId) return load(tab.connectionId, object, setMine);
    // `object` is a fresh reference per render of the store; key on the tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, tab.connectionId, reload]);

  useEffect(() => {
    if (otherId && otherId !== PASTE) return load(otherId, object, setOther);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, otherId, reload]);

  useEffect(() => {
    if (!tab.connectionId || !isSql) return;
    let live = true;
    api
      .getObjectDependencies(tab.connectionId, object)
      .then((d) => {
        if (!live) return;
        setDeps(d);
        setDepsError(null);
      })
      .catch((err) => live && setDepsError(err.message));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, tab.connectionId, reload, isSql]);

  // Only connections of the same engine hold a comparable definition.
  const compareOptions = [
    { value: PASTE, label: "Pasted text…" },
    ...connections
      .filter((c) => c.id !== tab.connectionId && c.type === conn?.type)
      .map((c) => ({ value: c.id, label: `${c.env} · ${c.name}` })),
  ];
  const otherConn = connections.find((c) => c.id === otherId);
  // A cleared picker leaves the last side in state; it just stops counting.
  const pasting = otherId === PASTE;
  const other = otherId && !pasting ? otherSide : null;
  const env = conn ? runEnvStyle(conn.env) : null;

  const sideNote = (s: Side | null, name?: string) =>
    s?.state === "missing"
      ? `Not on ${name}`
      : s?.state === "error"
        ? `${name}: ${s.message}`
        : null;
  const notes = [
    sideNote(mine, conn?.name),
    otherConn && sideNote(other, otherConn.name),
  ].filter(Boolean);
  const same =
    other?.state === "ok" &&
    mine.state === "ok" &&
    sideText(mine).trimEnd() === sideText(other).trimEnd();

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <Group
        gap="xs"
        wrap="nowrap"
        style={{
          padding: "8px 14px",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        <Badge size="sm" variant="light" color="gray">
          {object.kind}
        </Badge>
        <Text size="sm" ff="monospace" truncate style={{ flex: 1 }}>
          {label(object)}
          {object.parent && (
            <Text span c="dimmed" size="sm">
              {" "}
              on {object.parent}
            </Text>
          )}
        </Text>
        {env && (
          <Badge size="sm" variant="light" color={env.color}>
            {env.label}
          </Badge>
        )}
        <Select
          size="xs"
          w={220}
          placeholder="Compare with…"
          aria-label="Compare with another connection or pasted text"
          data={compareOptions}
          value={otherId}
          onChange={setOtherId}
          clearable
          searchable
        />
        <Tooltip label="Re-read from the database" openDelay={400}>
          <ActionIcon
            variant="subtle"
            color="gray"
            aria-label="Refresh definition"
            onClick={() => setReload((n) => n + 1)}
          >
            <IconRefresh size={15} />
          </ActionIcon>
        </Tooltip>
        <Tooltip
          label="Copy as a re-runnable script (CREATE OR ALTER / CREATE OR REPLACE) for a migrations repo"
          openDelay={400}
        >
          <ActionIcon
            variant="subtle"
            color="gray"
            aria-label="Copy as migration"
            disabled={mine.state !== "ok" || !mine.obj.migration}
            onClick={() =>
              mine.state === "ok" &&
              copyToClipboard(mine.obj.migration!, "migration", label(object))
            }
          >
            <IconFileExport size={15} />
          </ActionIcon>
        </Tooltip>
        {canAuthor && isSql && (
          <Button
            size="xs"
            variant="light"
            leftSection={<IconPencil size={14} />}
            disabled={mine.state !== "ok" || !mine.obj.migration || editing}
            onClick={() => {
              setOtherId(null);
              setEditing(true);
            }}
          >
            Edit
          </Button>
        )}
        <Tooltip label="Copy definition" openDelay={400}>
          <ActionIcon
            variant="subtle"
            color="gray"
            aria-label="Copy definition"
            disabled={mine.state !== "ok" || mine.obj.definition == null}
            onClick={() =>
              copyToClipboard(sideText(mine), "definition", label(object))
            }
          >
            <IconCopy size={15} />
          </ActionIcon>
        </Tooltip>
      </Group>

      {conn && isSql && (
        <DependencyStrip connId={conn.id} deps={deps} error={depsError} />
      )}

      {pasting && !editing && (
        <Text
          size="xs"
          c="dimmed"
          style={{ padding: "6px 14px", flexShrink: 0 }}
        >
          Paste a version on the right to compare it with {conn?.name}.
        </Text>
      )}

      {(notes.length > 0 || same) && (
        <Text
          size="xs"
          c="dimmed"
          style={{ padding: "6px 14px", flexShrink: 0 }}
        >
          {same
            ? `Identical on ${conn?.name} and ${otherConn?.name}.`
            : notes.join(" · ")}
        </Text>
      )}

      <div style={{ flex: 1, minHeight: 0 }}>
        {editing && mine.state === "ok" && conn ? (
          <ObjectEditor
            connId={conn.id}
            object={object}
            start={mine.obj.migration!}
            dbType={conn.type}
            impact={impact(object, deps)}
            onCancel={() => setEditing(false)}
          />
        ) : pasting && mine.state === "ok" ? (
          <DiffEditor
            original={sideText(mine)}
            modified=""
            language={language}
            theme={theme}
            options={{
              ...baseSqlEditorOptions,
              readOnly: false,
              originalEditable: false,
              renderSideBySide: true,
            }}
          />
        ) : mine.state === "loading" || other?.state === "loading" ? (
          <Group justify="center" p="xl">
            <Loader size="sm" color="var(--accent)" />
          </Group>
        ) : otherId && other ? (
          <DiffEditor
            original={sideText(mine)}
            modified={sideText(other)}
            language={language}
            theme={theme}
            options={{
              ...baseSqlEditorOptions,
              readOnly: true,
              originalEditable: false,
              renderSideBySide: true,
            }}
          />
        ) : mine.state === "ok" && mine.obj.definition == null ? (
          <Alert
            m="md"
            color="gray"
            variant="light"
            icon={<IconLock size={16} />}
          >
            {HIDDEN}
          </Alert>
        ) : mine.state === "ok" ? (
          <Editor
            value={mine.obj.definition!}
            language={language}
            theme={theme}
            options={{ ...baseSqlEditorOptions, readOnly: true }}
          />
        ) : null}
      </div>
    </div>
  );
}

const OPENABLE = ["procedure", "function", "view", "trigger"];

/**
 * "Uses / Used by" for the open object, so its blast radius is on screen
 * before anyone proposes a change to it. A reference the engine could not
 * resolve (dropped, late-bound, another database) is listed, not hidden.
 */
function DependencyStrip({
  connId,
  deps,
  error,
}: {
  connId: string;
  deps: DbObjectDependencies | null;
  error: string | null;
}) {
  const openObjectTab = useStore((s) => s.openObjectTab);
  const openJobTab = useStore((s) => s.openJobTab);

  const ref = (r: DbObjectReference) => {
    const name = `${r.database ? `${r.database}.` : ""}${r.schema ? `${r.schema}.` : ""}${r.name}`;
    const openable = !r.database && r.schema && OPENABLE.includes(r.kind ?? "");
    const open = () =>
      openObjectTab(connId, {
        schema: r.schema!,
        name: r.name,
        kind: r.kind as DbObjectInfo["kind"],
        ...(r.args != null && { args: r.args }),
        ...(r.parent != null && { parent: r.parent }),
      });
    return (
      <Text
        key={`${name}:${r.kind}(${r.args ?? ""})@${r.parent ?? ""}`}
        span
        size="xs"
        ff="monospace"
        c={r.kind == null ? "dimmed" : openable ? "var(--accent)" : undefined}
        title={
          r.kind ?? "unresolved — dropped, late-bound or in another database"
        }
        style={{ cursor: openable ? "pointer" : undefined, marginRight: 8 }}
        {...(openable && pressable(open))}
      >
        {name}
        {r.args != null && `(${r.args})`}
        {r.kind == null ? " (?)" : r.kind === "table" ? "" : ` (${r.kind})`}
      </Text>
    );
  };

  if (error)
    return (
      <Text size="xs" c="dimmed" style={{ padding: "6px 14px" }}>
        Dependencies unavailable: {error}
      </Text>
    );
  if (!deps) return null;
  return (
    <div
      style={{
        padding: "6px 14px",
        borderBottom: "1px solid var(--border)",
        flexShrink: 0,
        display: "grid",
        gridTemplateColumns: "auto 1fr",
        columnGap: 8,
        rowGap: 2,
      }}
    >
      <Text size="xs" c="dimmed">
        Uses
      </Text>
      <div>
        {deps.uses.length ? (
          deps.uses.map(ref)
        ) : (
          <Text span size="xs" c="dimmed">
            nothing found
          </Text>
        )}
      </div>
      <Text size="xs" c="dimmed">
        Used by
      </Text>
      <div>
        {deps.usedBy.length ? (
          deps.usedBy.map(ref)
        ) : (
          <Text span size="xs" c="dimmed">
            nothing found
          </Text>
        )}
        {deps.bestEffort && (
          <Text span size="xs" c="dimmed" fs="italic">
            {" "}
            — best effort: found by name in function bodies
          </Text>
        )}
      </div>
      {!!deps.jobs?.length && (
        <>
          <Text size="xs" c="dimmed">
            Run by
          </Text>
          <div>
            {deps.jobs.map((j) => (
              <Text
                key={j.id}
                span
                size="xs"
                c="var(--accent)"
                title="job — found by name in its steps"
                style={{ cursor: "pointer", marginRight: 8 }}
                {...pressable(() => openJobTab(connId, j))}
              >
                {j.name} (job)
              </Text>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** "Changing this view affects 3 objects and 1 job." — null when nothing is known to. */
function impact(o: DbObjectInfo, deps: DbObjectDependencies | null) {
  const objects = deps?.usedBy.length ?? 0;
  const jobs = deps?.jobs?.length ?? 0;
  if (!objects && !jobs) return null;
  const parts = [
    objects && plural(objects, "object"),
    jobs && plural(jobs, "job"),
  ].filter(Boolean);
  return `Changing this ${o.kind} affects ${parts.join(" and ")}${deps?.bestEffort ? " (found by name, best effort)" : ""}.`;
}

/**
 * Proposes a new definition as an object_change write request: the deployed
 * version on the left, the editable re-runnable one on the right. Nothing runs
 * here — it is saved as a draft, run or submitted from the request page like
 * any other write, and refused if the deployed version changes meanwhile.
 */
function ObjectEditor({
  connId,
  object,
  start,
  dbType,
  impact,
  onCancel,
}: {
  connId: string;
  object: DbObjectInfo;
  start: string;
  dbType: Parameters<typeof monacoLanguageForDb>[0];
  impact: string | null;
  onCancel: () => void;
}) {
  const theme = useEditorTheme();
  const navigate = useNavigate();
  const editorRef = useRef<MonacoEditor.IStandaloneDiffEditor | null>(null);
  const [title, setTitle] = useState(`Update ${object.kind} ${object.name}`);
  const [busy, setBusy] = useState(false);

  // Always a draft, like any write request: the request page then offers
  // "Run now" or "Submit for approval", whichever this environment allows.
  const save = async () => {
    const writeSql = editorRef.current?.getModifiedEditor().getValue() ?? start;
    setBusy(true);
    try {
      const wr = await api.createWriteRequest({
        title: title.trim() || `Update ${object.kind} ${object.name}`,
        connectionId: connId,
        writeSql,
        object,
        draft: true,
      });
      navigate(`/write-requests/${wr.id}`);
    } catch (err) {
      notifyError(err, "Object change");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <Group
        gap="xs"
        wrap="nowrap"
        style={{
          padding: "8px 14px",
          background: "var(--surface2)",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <Text size="xs" fw={600} style={{ whiteSpace: "nowrap" }}>
          Editing {object.kind} {object.schema}.{object.name}
        </Text>
        <TextInput
          size="xs"
          aria-label="Request title"
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
          style={{ flex: 1 }}
        />
        <Button size="xs" variant="default" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="xs" loading={busy} onClick={save}>
          Save draft
        </Button>
      </Group>
      {impact && (
        <Alert color="orange" variant="light" py={6} px="md" radius={0}>
          <Text size="xs">{impact}</Text>
        </Alert>
      )}
      <Text size="xs" c="dimmed" style={{ padding: "4px 14px" }}>
        Left: deployed now. Right: your version — it is saved as a draft write
        request, and nothing runs until you run or submit it from there.
      </Text>
      <div style={{ flex: 1, minHeight: 0 }}>
        <DiffEditor
          original={start}
          modified={start}
          language={monacoLanguageForDb(dbType)}
          theme={theme}
          onMount={(e) => {
            editorRef.current = e;
          }}
          options={{
            ...baseSqlEditorOptions,
            readOnly: false,
            originalEditable: false,
            renderSideBySide: true,
          }}
        />
      </div>
    </div>
  );
}
