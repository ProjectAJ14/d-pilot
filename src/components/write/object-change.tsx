import { useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { Alert, Badge, Button, Group, Text } from "@mantine/core";
import {
  IconAlertTriangle,
  IconArrowBackUp,
  IconCopy,
} from "@tabler/icons-react";
import { useNavigate } from "react-router-dom";
import type { WriteRequest } from "../../types";
import { api } from "../../utils/api-client";
import { copyToClipboard } from "../../utils/clipboard";
import {
  baseSqlEditorOptions,
  useEditorTheme,
} from "../../utils/monaco-editor-options";
import { monacoLanguageForDb } from "../query/query-editor";
import { notifyError } from "../../utils/notify-error";

/**
 * The review of an object_change: the version deployed when it was submitted
 * on the left, the proposed one on the right — reviewers judge the change,
 * not a wall of SQL. After it runs, the snapshot is what "Restore previous
 * version" proposes back, through the same approval flow.
 */
export function ObjectChangeReview({
  wr,
  canAuthor,
}: {
  wr: WriteRequest;
  /** Whether the viewer may raise a request on this environment. */
  canAuthor: boolean;
}) {
  const theme = useEditorTheme();
  const navigate = useNavigate();
  const [restoring, setRestoring] = useState(false);
  const o = wr.object!;
  const name = `${o.schema}.${o.name}${o.args != null ? `(${o.args})` : ""}`;

  const restore = async () => {
    setRestoring(true);
    try {
      const created = await api.createWriteRequest({
        title: `Restore ${o.kind} ${o.name}`,
        description: `Puts back the version that write request ${wr.id} replaced.`,
        connectionId: wr.connectionId,
        writeSql: wr.restoreSql!,
        object: o,
      });
      navigate(`/write-requests/${created.id}`);
    } catch (err) {
      notifyError(err, "Restore previous version");
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Group gap="xs" wrap="nowrap">
        <Badge variant="light" color="orange">
          {wr.snapshot == null ? "creates" : "changes"} {o.kind}
        </Badge>
        <Text ff="monospace" size="sm" truncate style={{ flex: 1 }}>
          {name}
          {o.parent && (
            <Text span c="dimmed" inherit>
              {" "}
              on {o.parent}
            </Text>
          )}
        </Text>
        <Button
          size="xs"
          variant="default"
          leftSection={<IconCopy size={14} />}
          onClick={() => copyToClipboard(wr.writeSql, "migration", name)}
        >
          Copy as migration
        </Button>
        {wr.status === "EXECUTED" && wr.restoreSql && canAuthor && (
          <Button
            size="xs"
            variant="light"
            leftSection={<IconArrowBackUp size={14} />}
            loading={restoring}
            onClick={restore}
          >
            Restore previous version
          </Button>
        )}
      </Group>
      {wr.warnings?.map((w) => (
        <Alert
          key={w}
          color="orange"
          variant="light"
          icon={<IconAlertTriangle size={16} />}
        >
          {w}
        </Alert>
      ))}
      <Text size="xs" c="dimmed">
        Left: deployed when {wr.status === "EXECUTED" ? "it ran" : "submitted"}
        {wr.snapshot == null && " (nothing — the object did not exist)"}. Right:
        proposed. Runs as one batch in a transaction; approval checks the
        deployed version is still the left one.
      </Text>
      <div
        style={{
          height: 420,
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-md)",
          overflow: "hidden",
        }}
      >
        <DiffEditor
          // The deployed side in its re-runnable form, so the diff is the
          // author's edit, not CREATE → CREATE OR ALTER.
          original={(wr.restoreSql ?? wr.snapshot ?? "").trim()}
          modified={wr.writeSql}
          language={monacoLanguageForDb(wr.dbType)}
          theme={theme}
          options={{
            ...baseSqlEditorOptions,
            readOnly: true,
            originalEditable: false,
            renderSideBySide: true,
          }}
        />
      </div>
    </div>
  );
}

/**
 * The top of a job_change review: what it does in words, what it reaches
 * beyond this job, and — for a step command — the old command beside the new
 * one. The generated SQL that runs is shown below it as usual.
 */
export function JobChangeSummary({ wr }: { wr: WriteRequest }) {
  const theme = useEditorTheme();
  const jc = wr.jobChange!;
  const action = jc.action;
  const before =
    action.type === "edit_step" && wr.snapshot
      ? ((
          JSON.parse(wr.snapshot) as {
            steps: { id: number; command: string }[];
          }
        ).steps.find((s) => s.id === action.stepId)?.command ?? "")
      : null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <Group gap="xs" wrap="nowrap">
        <Badge variant="light" color="orange">
          changes {jc.engine === "agent" ? "Agent job" : "pg_cron job"}
        </Badge>
        <Text size="sm" fw={500}>
          {jc.jobName}
        </Text>
        <Text size="sm" c="dimmed">
          — {wr.summary}
        </Text>
      </Group>
      {wr.warnings?.map((w) => (
        <Alert
          key={w}
          color="orange"
          variant="light"
          icon={<IconAlertTriangle size={16} />}
        >
          {w}
        </Alert>
      ))}
      <Text size="xs" c="dimmed">
        Approval checks the job is still exactly as it was when this was
        submitted; if anyone changed it, nothing runs.
      </Text>
      {before != null && action.type === "edit_step" && (
        <div
          style={{
            height: 180,
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-md)",
            overflow: "hidden",
          }}
        >
          <DiffEditor
            original={before}
            modified={action.command}
            language={monacoLanguageForDb(wr.dbType)}
            theme={theme}
            options={{
              ...baseSqlEditorOptions,
              readOnly: true,
              originalEditable: false,
              renderSideBySide: true,
            }}
          />
        </div>
      )}
    </div>
  );
}
