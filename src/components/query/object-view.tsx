import { useEffect, useState } from "react";
import Editor, { DiffEditor } from "@monaco-editor/react";
import {
  ActionIcon,
  Alert,
  Badge,
  Group,
  Loader,
  Select,
  Text,
  Tooltip,
} from "@mantine/core";
import { IconCopy, IconLock, IconRefresh } from "@tabler/icons-react";
import type { DbObjectDefinition, DbObjectInfo, QueryTab } from "../../types";
import { api, ApiError } from "../../utils/api-client";
import { useStore } from "../../store";
import {
  baseSqlEditorOptions,
  useEditorTheme,
} from "../../utils/monaco-editor-options";
import { copyToClipboard } from "../../utils/clipboard";
import { runEnvStyle } from "../../utils/environments";
import { monacoLanguageForDb } from "./query-editor";

/** One side of the view: loading, the object, or why there is none. */
type Side =
  | { state: "loading" }
  | { state: "ok"; obj: DbObjectDefinition }
  | { state: "missing" }
  | { state: "error"; message: string };

function load(connectionId: string, o: DbObjectInfo, set: (s: Side) => void) {
  set({ state: "loading" });
  api
    .getObjectDefinition(connectionId, o)
    .then((obj) => set({ state: "ok", obj }))
    .catch((err) =>
      set(
        err instanceof ApiError && err.code === "OBJECT_NOT_FOUND"
          ? { state: "missing" }
          : { state: "error", message: err.message },
      ),
    );
}

const HIDDEN =
  "Definition not available: the object is encrypted, or this connection's login lacks VIEW DEFINITION permission.";

/** The text a side contributes to a diff; a missing object diffs as empty. */
const sideText = (s: Side) =>
  s.state === "ok" ? (s.obj.definition ?? `-- ${HIDDEN}`) : "";

const label = (o: DbObjectInfo) =>
  `${o.schema}.${o.name}${o.args != null ? `(${o.args})` : ""}`;

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
  const [otherId, setOtherId] = useState<string | null>(null);
  const [otherSide, setOther] = useState<Side | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (tab.connectionId) load(tab.connectionId, object, setMine);
    // `object` is a fresh reference per render of the store; key on the tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, tab.connectionId, reload]);

  useEffect(() => {
    if (otherId) load(otherId, object, setOther);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, otherId, reload]);

  // Only connections of the same engine hold a comparable definition.
  const compareOptions = connections
    .filter((c) => c.id !== tab.connectionId && c.type === conn?.type)
    .map((c) => ({ value: c.id, label: `${c.env} · ${c.name}` }));
  const otherConn = connections.find((c) => c.id === otherId);
  // A cleared picker leaves the last side in state; it just stops counting.
  const other = otherId ? otherSide : null;
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
          aria-label="Compare with another connection"
          data={compareOptions}
          value={otherId}
          onChange={setOtherId}
          clearable
          searchable
          nothingFoundMessage="No other connection of this type"
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
        {mine.state === "loading" || other?.state === "loading" ? (
          <Group justify="center" p="xl">
            <Loader size="sm" color="var(--accent)" />
          </Group>
        ) : otherId && other ? (
          <DiffEditor
            original={sideText(mine)}
            modified={sideText(other)}
            language={monacoLanguageForDb(conn?.type)}
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
            language={monacoLanguageForDb(conn?.type)}
            theme={theme}
            options={{ ...baseSqlEditorOptions, readOnly: true }}
          />
        ) : null}
      </div>
    </div>
  );
}
