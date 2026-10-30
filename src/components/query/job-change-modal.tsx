import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Button,
  Chip,
  Group,
  Modal,
  NumberInput,
  Select,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import type {
  JobChangeAction,
  JobDetail,
  MsdbScheduleFields,
} from "../../types";
import { api } from "../../utils/api-client";
import { notifyError } from "../../utils/notify-error";

/** What the modal is proposing; the form shows only that action's fields. */
export type JobChangeIntent =
  | { type: "set_enabled" }
  | { type: "rename" }
  | { type: "set_description" }
  | { type: "add_step" }
  | { type: "edit_step"; stepId: number }
  | { type: "delete_step"; stepId: number }
  | { type: "set_schedule"; scheduleId: string };

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const hhmm = (t: number) =>
  `${String(Math.floor(t / 10000)).padStart(2, "0")}:${String(Math.floor(t / 100) % 100).padStart(2, "0")}`;
const toHhmmss = (v: string) => {
  const [h, m] = v.split(":").map(Number);
  return (h || 0) * 10000 + (m || 0) * 100;
};

/** Edits the msdb schedule fields as days, times and an interval. */
function AgentScheduleFields({
  value,
  onChange,
}: {
  value: MsdbScheduleFields;
  onChange: (v: MsdbScheduleFields) => void;
}) {
  const set = (p: Partial<MsdbScheduleFields>) => onChange({ ...value, ...p });
  const repeats = value.freq_subday_type !== 1;
  return (
    <>
      <Group grow mb="sm">
        <Select
          label="Frequency"
          data={[
            { value: "4", label: "Daily" },
            { value: "8", label: "Weekly" },
            { value: "16", label: "Monthly" },
          ]}
          value={String(value.freq_type)}
          onChange={(v) =>
            set({
              freq_type: Number(v),
              freq_interval: v === "8" ? 62 : 1,
              freq_recurrence_factor: v === "4" ? 0 : 1,
            })
          }
          allowDeselect={false}
        />
        <NumberInput
          label={
            value.freq_type === 4
              ? "Every N days"
              : value.freq_type === 8
                ? "Every N weeks"
                : "Every N months"
          }
          min={1}
          value={
            value.freq_type === 4
              ? value.freq_interval
              : value.freq_recurrence_factor
          }
          onChange={(n) =>
            set(
              value.freq_type === 4
                ? { freq_interval: Number(n) || 1 }
                : { freq_recurrence_factor: Number(n) || 1 },
            )
          }
        />
      </Group>
      {value.freq_type === 8 && (
        <Chip.Group
          multiple
          value={DAYS.filter((_, i) => value.freq_interval & (1 << i))}
          onChange={(days) =>
            set({
              freq_interval: days.reduce(
                (mask, d) => mask | (1 << DAYS.indexOf(d)),
                0,
              ),
            })
          }
        >
          <Group gap={6} mb="sm">
            {DAYS.map((d) => (
              <Chip key={d} value={d} size="xs">
                {d}
              </Chip>
            ))}
          </Group>
        </Chip.Group>
      )}
      {value.freq_type === 16 && (
        <NumberInput
          label="Day of month"
          min={1}
          max={31}
          mb="sm"
          value={value.freq_interval}
          onChange={(n) => set({ freq_interval: Number(n) || 1 })}
        />
      )}
      <Group grow mb="sm">
        <Select
          label="Runs"
          data={[
            { value: "1", label: "Once a day" },
            { value: "4", label: "Every N minutes" },
            { value: "8", label: "Every N hours" },
          ]}
          value={String(value.freq_subday_type)}
          onChange={(v) =>
            set({
              freq_subday_type: Number(v),
              freq_subday_interval:
                v === "1" ? 0 : value.freq_subday_interval || 1,
            })
          }
          allowDeselect={false}
        />
        {repeats && (
          <NumberInput
            label={value.freq_subday_type === 4 ? "Minutes" : "Hours"}
            min={1}
            value={value.freq_subday_interval}
            onChange={(n) => set({ freq_subday_interval: Number(n) || 1 })}
          />
        )}
      </Group>
      <Group grow mb="sm">
        <TextInput
          type="time"
          label={repeats ? "From" : "At"}
          value={hhmm(value.active_start_time)}
          onChange={(e) =>
            set({ active_start_time: toHhmmss(e.currentTarget.value) })
          }
        />
        {repeats && (
          <TextInput
            type="time"
            label="Until"
            value={hhmm(value.active_end_time)}
            onChange={(e) =>
              set({ active_end_time: toHhmmss(e.currentTarget.value) + 59 })
            }
          />
        )}
      </Group>
    </>
  );
}

const TITLES: Record<JobChangeIntent["type"], string> = {
  set_enabled: "Enable or disable the job",
  rename: "Rename the job",
  set_description: "Change the description",
  add_step: "Add a step",
  edit_step: "Change a step's command",
  delete_step: "Delete a step",
  set_schedule: "Change the schedule",
};

/**
 * Proposes one change to a job as a job_change write request. Nothing runs
 * here: the server writes the SQL, checks it like a direct write, and the
 * request is reviewed and approved like any other — refused if the job
 * changes before then.
 */
export function JobChangeModal({
  connId,
  job,
  intent,
  onClose,
}: {
  connId: string;
  job: JobDetail;
  intent: JobChangeIntent;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const step =
    "stepId" in intent ? job.steps.find((s) => s.id === intent.stepId) : null;
  const schedule =
    "scheduleId" in intent
      ? job.schedules.find((s) => s.id === intent.scheduleId)
      : null;

  const [title, setTitle] = useState(`${TITLES[intent.type]} — ${job.name}`);
  const [text, setText] = useState(
    intent.type === "rename"
      ? job.name
      : intent.type === "set_description"
        ? (job.description ?? "")
        : intent.type === "edit_step"
          ? (step?.command ?? "")
          : intent.type === "set_schedule"
            ? (schedule?.cron ?? "")
            : "",
  );
  const [stepName, setStepName] = useState("");
  const [msdb, setMsdb] = useState<MsdbScheduleFields | null>(
    (schedule?.msdb as unknown as MsdbScheduleFields) ?? null,
  );
  const [busy, setBusy] = useState<"draft" | "submit" | null>(null);

  const action = (): JobChangeAction => {
    switch (intent.type) {
      case "set_enabled":
        return { type: "set_enabled", enabled: !job.enabled };
      case "rename":
        return { type: "rename", name: text };
      case "set_description":
        return { type: "set_description", description: text };
      case "add_step":
        return { type: "add_step", name: stepName, command: text };
      case "edit_step":
        return { type: "edit_step", stepId: intent.stepId, command: text };
      case "delete_step":
        return { type: "delete_step", stepId: intent.stepId };
      case "set_schedule":
        return job.engine === "pg_cron"
          ? { type: "set_schedule", scheduleId: intent.scheduleId, cron: text }
          : {
              type: "set_schedule",
              scheduleId: intent.scheduleId,
              msdb: msdb!,
            };
    }
  };

  const save = async (draft: boolean) => {
    setBusy(draft ? "draft" : "submit");
    try {
      const wr = await api.createWriteRequest({
        title: title.trim() || TITLES[intent.type],
        connectionId: connId,
        writeSql: "",
        jobChange: { jobId: job.id, action: action() },
        draft,
      });
      navigate(`/write-requests/${wr.id}`);
    } catch (err) {
      notifyError(err, "Job change");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal opened onClose={onClose} title={TITLES[intent.type]} size="lg">
      <TextInput
        label="Request title"
        value={title}
        onChange={(e) => setTitle(e.currentTarget.value)}
        mb="sm"
      />
      {intent.type === "set_enabled" && (
        <Text size="sm" mb="sm">
          This {job.enabled ? "disables" : "enables"} <b>{job.name}</b>
          {job.enabled
            ? " — it stops running on its schedule until enabled again."
            : " — it runs on its schedule again."}
        </Text>
      )}
      {intent.type === "delete_step" && (
        <Text size="sm" mb="sm">
          Deletes step {step?.id}, <b>{step?.name}</b>. The steps after it move
          up one.
        </Text>
      )}
      {intent.type === "add_step" && (
        <TextInput
          label="Step name"
          value={stepName}
          onChange={(e) => setStepName(e.currentTarget.value)}
          mb="sm"
        />
      )}
      {(intent.type === "rename" || intent.type === "set_description") && (
        <TextInput
          label={intent.type === "rename" ? "New name" : "Description"}
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          mb="sm"
        />
      )}
      {(intent.type === "edit_step" || intent.type === "add_step") && (
        <Textarea
          label="Command"
          description="One EXEC/CALL of a procedure, or INSERT/UPDATE/DELETE statements with a WHERE, separated by semicolons. Keep logic in a procedure and change that with an object change."
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          autosize
          minRows={4}
          styles={{ input: { fontFamily: "var(--font-mono)", fontSize: 12 } }}
          mb="sm"
        />
      )}
      {intent.type === "set_schedule" &&
        (job.engine === "pg_cron" ? (
          <TextInput
            label="Cron schedule"
            description="Five fields (minute hour day month weekday), 'N seconds', or @daily/@hourly…"
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            styles={{ input: { fontFamily: "var(--font-mono)" } }}
            mb="sm"
          />
        ) : (
          msdb && <AgentScheduleFields value={msdb} onChange={setMsdb} />
        ))}
      {schedule && schedule.sharedWith > 0 && (
        <Text size="xs" c="orange" mb="sm">
          This schedule is shared with {schedule.sharedWith} other job
          {schedule.sharedWith > 1 ? "s" : ""} — changing it changes when they
          run too.
        </Text>
      )}
      <Group justify="flex-end" mt="md">
        <Button variant="subtle" color="gray" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="default"
          loading={busy === "draft"}
          disabled={!!busy}
          onClick={() => save(true)}
        >
          Save draft
        </Button>
        <Button
          loading={busy === "submit"}
          disabled={!!busy}
          onClick={() => save(false)}
        >
          Submit for review
        </Button>
      </Group>
    </Modal>
  );
}
