import { useEffect, useState } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Group,
  Menu,
  Loader,
  Stack,
  Table,
  Text,
  Tooltip,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconPencil,
  IconRefresh,
} from "@tabler/icons-react";
import type { JobDetail, JobRun, QueryTab } from "../../types";
import { api } from "../../utils/api-client";
import { useStore } from "../../store";
import { JobChangeModal, type JobChangeIntent } from "./job-change-modal";

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
 * Whether the job also runs steps on another database — then only this
 * database's own step commands can change (the server refuses the rest).
 */
const runsElsewhere = (job: JobDetail) =>
  job.steps.some((s) => s.database && s.database !== job.database);

/** SQL steps on this database: the ones a job_change may rewrite. */
const stepEditable = (job: JobDetail, s: JobDetail["steps"][number]) =>
  ["TSQL", "SQL"].includes(s.subsystem.toUpperCase()) &&
  (!s.database || s.database === job.database);

/**
 * A scheduled job (SQL Server Agent or pg_cron), read live: what it runs, when,
 * and how its last runs went. Changes are proposed from here as job_change
 * write requests — nothing changes until one is approved.
 */
export function JobView({ tab }: { tab: QueryTab }) {
  const [job, setJob] = useState<JobDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [intent, setIntent] = useState<JobChangeIntent | null>(null);
  const env = useStore(
    (s) => s.connections.find((c) => c.id === tab.connectionId)?.env,
  );
  // Changing a job is its own capability, not write access.
  const canChange = useStore(
    (s) =>
      !!s.user?.isAdmin || !!(env && s.user?.jobEnvironments?.includes(env)),
  );

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
        {canChange && !runsElsewhere(job) && (
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <Button
                ml="auto"
                size="xs"
                variant="light"
                leftSection={<IconPencil size={14} />}
              >
                Propose a change
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item onClick={() => setIntent({ type: "set_enabled" })}>
                {job.enabled ? "Disable job" : "Enable job"}
              </Menu.Item>
              {job.engine === "agent" && (
                <>
                  <Menu.Item onClick={() => setIntent({ type: "rename" })}>
                    Rename…
                  </Menu.Item>
                  <Menu.Item
                    onClick={() => setIntent({ type: "set_description" })}
                  >
                    Change description…
                  </Menu.Item>
                  <Menu.Item onClick={() => setIntent({ type: "add_step" })}>
                    Add a step…
                  </Menu.Item>
                </>
              )}
            </Menu.Dropdown>
          </Menu>
        )}
        <Tooltip label="Re-read from the database" openDelay={400}>
          <ActionIcon
            ml={canChange ? undefined : "auto"}
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
              {canChange && stepEditable(job, s) && (
                <Button
                  size="compact-xs"
                  variant="subtle"
                  ml="auto"
                  onClick={() => setIntent({ type: "edit_step", stepId: s.id })}
                >
                  Edit command
                </Button>
              )}
              {canChange &&
                !runsElsewhere(job) &&
                job.engine === "agent" &&
                job.steps.length > 1 &&
                (!s.database || s.database === job.database) && (
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    color="red"
                    ml={stepEditable(job, s) ? undefined : "auto"}
                    onClick={() =>
                      setIntent({ type: "delete_step", stepId: s.id })
                    }
                  >
                    Delete
                  </Button>
                )}
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
          <Text key={s.id} size="sm" component="div">
            {s.description}
            {canChange &&
              s.editable &&
              s.sharedWith === 0 &&
              !runsElsewhere(job) && (
                <Button
                  size="compact-xs"
                  variant="subtle"
                  ml={6}
                  onClick={() =>
                    setIntent({ type: "set_schedule", scheduleId: s.id })
                  }
                >
                  Change
                </Button>
              )}
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
                {s.sharedWith > 1 ? "s" : ""}; so it can't be changed here
              </Text>
            )}
          </Text>
        ))}
      </Stack>

      {intent && tab.connectionId && (
        <JobChangeModal
          connId={tab.connectionId}
          job={job}
          intent={intent}
          onClose={() => setIntent(null)}
        />
      )}

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
