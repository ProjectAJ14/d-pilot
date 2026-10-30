import { useEffect, useState } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Group,
  Loader,
  Stack,
  Table,
  Text,
  Tooltip,
} from "@mantine/core";
import { IconAlertTriangle, IconRefresh } from "@tabler/icons-react";
import type { JobDetail, JobRun, QueryTab } from "../../types";
import { api } from "../../utils/api-client";

const STATUS_COLOR: Record<string, string> = {
  succeeded: "green",
  failed: "red",
  retry: "orange",
  cancelled: "gray",
  running: "blue",
};

/** `1 h 2 min 3 s`, dropping the leading zero units. */
export function formatDuration(sec: number | null): string {
  if (sec == null) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor(sec / 60) % 60;
  const s = sec % 60;
  return [h && `${h} h`, (h || m) && `${m} min`, `${s} s`]
    .filter(Boolean)
    .join(" ");
}

export function RunBadge({ run }: { run?: JobRun }) {
  if (!run?.status)
    return (
      <Text span size="xs" c="dimmed">
        never run
      </Text>
    );
  return (
    <Badge size="xs" variant="light" color={STATUS_COLOR[run.status]}>
      {run.status}
    </Badge>
  );
}

const Mono = ({ children }: { children: string }) => (
  <pre
    style={{
      margin: 0,
      padding: "8px 10px",
      background: "var(--surface2)",
      borderRadius: "var(--radius-sm)",
      fontFamily: "var(--font-mono)",
      fontSize: 12,
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
    }}
  >
    {children}
  </pre>
);

/**
 * A scheduled job (SQL Server Agent or pg_cron), read live: what it runs, when,
 * and how its last runs went. Read-only — a change to a job goes through a
 * job_change write request.
 */
export function JobView({ tab }: { tab: QueryTab }) {
  const [job, setJob] = useState<JobDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    api
      .getJob(tab.connectionId!, tab.job!.id)
      .then((j) => live && (setJob(j), setError(null)))
      .catch((err) => live && setError(err.message));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.connectionId, tab.job?.id, reload]);

  if (error)
    return (
      <Alert m="md" color="red" variant="light" title="Could not load job">
        {error}
      </Alert>
    );
  if (!job)
    return (
      <Group justify="center" p="xl">
        <Loader size="sm" color="var(--accent)" />
      </Group>
    );

  return (
    <div style={{ flex: 1, overflow: "auto", padding: "12px 16px" }}>
      <Group gap="xs" mb={4}>
        <Badge size="sm" variant="light" color="gray">
          {job.engine === "agent" ? "SQL Server Agent job" : "pg_cron job"}
        </Badge>
        <Text fw={600}>{job.name}</Text>
        <Badge size="sm" variant="light" color={job.enabled ? "green" : "gray"}>
          {job.enabled ? "enabled" : "disabled"}
        </Badge>
        {job.category && (
          <Text size="xs" c="dimmed">
            {job.category}
          </Text>
        )}
        <Tooltip label="Re-read from the database" openDelay={400}>
          <ActionIcon
            ml="auto"
            variant="subtle"
            color="gray"
            aria-label="Refresh job"
            onClick={() => setReload((n) => n + 1)}
          >
            <IconRefresh size={15} />
          </ActionIcon>
        </Tooltip>
      </Group>
      {job.description && (
        <Text size="sm" c="dimmed" mb="xs">
          {job.description}
        </Text>
      )}
      <Text size="sm" mb="md" component="div">
        Last run: <RunBadge run={job.lastRun} />{" "}
        {job.lastRun?.startedAt && (
          <Text span size="sm" c="dimmed">
            {job.lastRun.startedAt} · {formatDuration(job.lastRun.durationSec)}
          </Text>
        )}
        {job.nextRunAt && (
          <Text span size="sm" c="dimmed">
            {" "}
            · next run {job.nextRunAt}
          </Text>
        )}
      </Text>
      {job.lastRun?.status === "failed" && job.lastRun.message && (
        <Alert
          color="red"
          variant="light"
          icon={<IconAlertTriangle size={16} />}
          mb="md"
        >
          {job.lastRun.message}
        </Alert>
      )}

      <Text size="xs" tt="uppercase" c="dimmed" fw={600} mb={6}>
        Steps
      </Text>
      <Stack gap="sm" mb="md">
        {job.steps.map((s) => (
          <div key={s.id}>
            <Group gap="xs" mb={4}>
              <Text size="sm" fw={500}>
                {s.id}. {s.name}
              </Text>
              <Badge size="xs" variant="outline" color="gray">
                {s.subsystem}
              </Badge>
              {s.database && (
                <Text size="xs" c="dimmed">
                  on {s.database}
                </Text>
              )}
              <RunBadge run={s.lastRun} />
            </Group>
            <Mono>{s.command}</Mono>
            {s.lastRun?.status === "failed" && s.lastRun.message && (
              <Text size="xs" c="red" mt={4}>
                {s.lastRun.message}
              </Text>
            )}
          </div>
        ))}
      </Stack>

      <Text size="xs" tt="uppercase" c="dimmed" fw={600} mb={6}>
        Schedules
      </Text>
      <Stack gap={4} mb="md">
        {job.schedules.length === 0 && (
          <Text size="sm" c="dimmed">
            No schedule — runs only when started.
          </Text>
        )}
        {job.schedules.map((s) => (
          <Text key={s.id} size="sm">
            {s.description}
            {!s.enabled && (
              <Text span c="dimmed">
                {" "}
                (disabled)
              </Text>
            )}
            {s.sharedWith > 0 && (
              <Text span c="orange" size="xs">
                {" "}
                — also used by {s.sharedWith} other job
                {s.sharedWith > 1 ? "s" : ""}; editing it changes them too
              </Text>
            )}
          </Text>
        ))}
      </Stack>

      {job.history.length > 0 && (
        <>
          <Text size="xs" tt="uppercase" c="dimmed" fw={600} mb={6}>
            Recent runs
          </Text>
          <Table fz="xs" verticalSpacing={4}>
            <Table.Tbody>
              {job.history.map((r, i) => (
                <Table.Tr key={i}>
                  <Table.Td>
                    <RunBadge run={r} />
                  </Table.Td>
                  <Table.Td ff="monospace">{r.startedAt}</Table.Td>
                  <Table.Td>{formatDuration(r.durationSec)}</Table.Td>
                  <Table.Td c="dimmed">{r.message}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </>
      )}
    </div>
  );
}
