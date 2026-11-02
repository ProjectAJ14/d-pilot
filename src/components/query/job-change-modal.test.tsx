// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobDetail, MsdbScheduleFields } from "../../types";
import { renderUi } from "../../utils/dom.testing";
import { JobChangeModal, type JobChangeIntent } from "./job-change-modal";

const createWriteRequest = vi.fn();
const notifyError = vi.fn();
vi.mock("../../utils/api-client", () => ({
  api: { createWriteRequest: (...a: unknown[]) => createWriteRequest(...a) },
}));
vi.mock("../../utils/notify-error", () => ({
  notifyError: (...a: unknown[]) => notifyError(...a),
}));

const MSDB: MsdbScheduleFields = {
  freq_type: 4,
  freq_interval: 1,
  freq_subday_type: 1,
  freq_subday_interval: 0,
  freq_recurrence_factor: 0,
  active_start_time: 63000,
  active_end_time: 235959,
};

function makeJob(over: Partial<JobDetail> = {}): JobDetail {
  return {
    id: "job-1",
    name: "nightly_orders",
    engine: "agent",
    enabled: true,
    description: "Rolls up orders",
    stepCount: 2,
    database: "app_core",
    steps: [
      { id: 1, name: "load", subsystem: "TSQL", command: "EXEC load_orders" },
      { id: 2, name: "purge", subsystem: "TSQL", command: "EXEC purge" },
    ],
    schedules: [
      {
        id: "s1",
        name: "daily",
        enabled: true,
        description: "Daily",
        sharedWith: 0,
        editable: true,
        cron: "0 3 * * *",
        msdb: { ...MSDB } as unknown as Record<string, number>,
      },
    ],
    history: [],
    ...over,
  };
}

const onClose = vi.fn();

function open(intent: JobChangeIntent, job = makeJob()) {
  return renderUi(
    <Routes>
      <Route
        path="/"
        element={
          <JobChangeModal
            connId="conn-qa"
            job={job}
            intent={intent}
            onClose={onClose}
          />
        }
      />
      <Route path="/write-requests/:id" element={<div>request page</div>} />
    </Routes>,
  );
}

async function saveAndGetAction() {
  await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await screen.findByText("request page");
  return createWriteRequest.mock.calls.at(-1)![0];
}

async function pick(label: string, option: string) {
  await userEvent.click(screen.getByRole("textbox", { name: label }));
  await userEvent.click(
    await screen.findByRole("option", { name: option, hidden: true }),
  );
}

beforeEach(() => {
  createWriteRequest.mockReset().mockResolvedValue({ id: 42 });
  notifyError.mockReset();
  onClose.mockReset();
});

describe("JobChangeModal", () => {
  it("proposes disabling an enabled job as a draft and opens the request", async () => {
    open({ type: "set_enabled" });
    expect(screen.getByText(/it stops running on its schedule/)).toBeTruthy();
    const body = await saveAndGetAction();
    expect(body).toEqual({
      title: "Enable or disable the job — nightly_orders",
      connectionId: "conn-qa",
      writeSql: "",
      jobChange: {
        jobId: "job-1",
        action: { type: "set_enabled", enabled: false },
      },
      draft: true,
    });
  });

  it("proposes enabling a disabled job, falling back to the default title", async () => {
    open({ type: "set_enabled" }, makeJob({ enabled: false }));
    expect(screen.getByText(/it runs on its schedule again/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Request title"), {
      target: { value: "   " },
    });
    const body = await saveAndGetAction();
    expect(body.title).toBe("Enable or disable the job");
    expect(body.jobChange.action).toEqual({
      type: "set_enabled",
      enabled: true,
    });
  });

  it("renames the job", async () => {
    open({ type: "rename" });
    const input = screen.getByLabelText("New name") as HTMLInputElement;
    expect(input.value).toBe("nightly_orders");
    fireEvent.change(input, { target: { value: "nightly_customers" } });
    expect((await saveAndGetAction()).jobChange.action).toEqual({
      type: "rename",
      name: "nightly_customers",
    });
  });

  it("changes the description, starting empty when there is none", async () => {
    open({ type: "set_description" }, makeJob({ description: undefined }));
    const input = screen.getByLabelText("Description") as HTMLInputElement;
    expect(input.value).toBe("");
    fireEvent.change(input, { target: { value: "New text" } });
    expect((await saveAndGetAction()).jobChange.action).toEqual({
      type: "set_description",
      description: "New text",
    });
  });

  it("adds a step with a name and command", async () => {
    open({ type: "add_step" });
    fireEvent.change(screen.getByLabelText("Step name"), {
      target: { value: "notify" },
    });
    fireEvent.change(screen.getByLabelText("Command"), {
      target: { value: "EXEC notify" },
    });
    expect((await saveAndGetAction()).jobChange.action).toEqual({
      type: "add_step",
      name: "notify",
      command: "EXEC notify",
    });
  });

  it("edits a step's command, prefilled from the step", async () => {
    open({ type: "edit_step", stepId: 1 });
    const cmd = screen.getByLabelText("Command") as HTMLTextAreaElement;
    expect(cmd.value).toBe("EXEC load_orders");
    fireEvent.change(cmd, { target: { value: "EXEC load_orders_v2" } });
    expect((await saveAndGetAction()).jobChange.action).toEqual({
      type: "edit_step",
      stepId: 1,
      command: "EXEC load_orders_v2",
    });
  });

  it("edits an unknown step starting from an empty command", () => {
    open({ type: "edit_step", stepId: 99 });
    expect(
      (screen.getByLabelText("Command") as HTMLTextAreaElement).value,
    ).toBe("");
  });

  it("deletes a step", async () => {
    open({ type: "delete_step", stepId: 2 });
    expect(screen.getByText("purge")).toBeTruthy();
    expect((await saveAndGetAction()).jobChange.action).toEqual({
      type: "delete_step",
      stepId: 2,
    });
  });

  it("changes a pg_cron schedule as a cron expression", async () => {
    open(
      { type: "set_schedule", scheduleId: "s1" },
      makeJob({ engine: "pg_cron" }),
    );
    const cron = screen.getByLabelText(/Cron schedule/) as HTMLInputElement;
    expect(cron.value).toBe("0 3 * * *");
    fireEvent.change(cron, { target: { value: "@hourly" } });
    expect((await saveAndGetAction()).jobChange.action).toEqual({
      type: "set_schedule",
      scheduleId: "s1",
      cron: "@hourly",
    });
  });

  it("starts empty for an unknown schedule and shows no Agent form", () => {
    open({ type: "set_schedule", scheduleId: "nope" });
    expect(screen.queryByLabelText("Frequency")).toBeNull();
    open(
      { type: "set_schedule", scheduleId: "nope" },
      makeJob({ engine: "pg_cron" }),
    );
    expect(
      (screen.getByLabelText(/Cron schedule/) as HTMLInputElement).value,
    ).toBe("");
  });

  it("edits an Agent schedule through days, times and intervals", async () => {
    open({ type: "set_schedule", scheduleId: "s1" });
    // Daily, once a day at 06:30.
    expect(screen.getByLabelText("Every N days")).toBeTruthy();
    expect((screen.getByLabelText("At") as HTMLInputElement).value).toBe(
      "06:30",
    );
    expect(screen.queryByLabelText("Until")).toBeNull();
    fireEvent.change(screen.getByLabelText("Every N days"), {
      target: { value: "3" },
    });
    fireEvent.change(screen.getByLabelText("At"), {
      target: { value: "07:15" },
    });
    const action = (await saveAndGetAction()).jobChange.action;
    expect(action.msdb).toMatchObject({
      freq_type: 4,
      freq_interval: 3,
      active_start_time: 71500,
    });
  });

  it("switches an Agent schedule to weekly on chosen days, every N hours", async () => {
    open({ type: "set_schedule", scheduleId: "s1" });
    await pick("Frequency", "Weekly");
    expect(screen.getByLabelText("Every N weeks")).toBeTruthy();
    // Weekly defaults to Mon–Fri (62).
    expect(
      (screen.getByRole("checkbox", { name: "Mon" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    await userEvent.click(screen.getByRole("checkbox", { name: "Sun" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Fri" }));
    fireEvent.change(screen.getByLabelText("Every N weeks"), {
      target: { value: "2" },
    });
    await pick("Runs", "Every N hours");
    expect(screen.getByLabelText("Hours")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Hours"), {
      target: { value: "4" },
    });
    fireEvent.change(screen.getByLabelText("From"), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByLabelText("Until"), {
      target: { value: "20:00" },
    });
    const action = (await saveAndGetAction()).jobChange.action;
    expect(action.msdb).toEqual({
      freq_type: 8,
      freq_interval: 1 + 2 + 4 + 8 + 16, // Sun–Thu
      freq_recurrence_factor: 2,
      freq_subday_type: 8,
      freq_subday_interval: 4,
      active_start_time: 0,
      active_end_time: 200059,
    });
  });

  it("switches to monthly and every N minutes, clamping cleared numbers to 1", async () => {
    open({ type: "set_schedule", scheduleId: "s1" });
    await pick("Frequency", "Monthly");
    expect(screen.getByLabelText("Every N months")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Day of month"), {
      target: { value: "15" },
    });
    fireEvent.change(screen.getByLabelText("Every N months"), {
      target: { value: "" },
    });
    await pick("Runs", "Every N minutes");
    expect(screen.getByLabelText("Minutes")).toBeTruthy();
    const action = (await saveAndGetAction()).jobChange.action;
    expect(action.msdb).toMatchObject({
      freq_type: 16,
      freq_interval: 15,
      freq_recurrence_factor: 1,
      freq_subday_type: 4,
      freq_subday_interval: 1,
    });
  });

  it("clamps cleared intervals and goes back to daily, once a day", async () => {
    open(
      { type: "set_schedule", scheduleId: "s1" },
      makeJob({
        schedules: [
          {
            ...makeJob().schedules[0],
            msdb: {
              ...MSDB,
              freq_type: 16,
              freq_interval: 5,
              freq_subday_type: 4,
              freq_subday_interval: 10,
            } as unknown as Record<string, number>,
          },
        ],
      }),
    );
    fireEvent.change(screen.getByLabelText("Day of month"), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByLabelText("Minutes"), {
      target: { value: "" },
    });
    await pick("Runs", "Every N hours");
    const action = (await saveAndGetAction()).jobChange.action;
    // Cleared numbers clamp to 1; switching repeat unit keeps the interval.
    expect(action.msdb).toMatchObject({
      freq_interval: 1,
      freq_subday_type: 8,
      freq_subday_interval: 1,
    });
  });

  it("returns to daily once a day and clamps a cleared day count", async () => {
    open(
      { type: "set_schedule", scheduleId: "s1" },
      makeJob({
        schedules: [
          {
            ...makeJob().schedules[0],
            msdb: {
              ...MSDB,
              freq_type: 8,
              freq_interval: 62,
              freq_subday_type: 8,
              freq_subday_interval: 2,
            } as unknown as Record<string, number>,
          },
        ],
      }),
    );
    await pick("Frequency", "Daily");
    fireEvent.change(screen.getByLabelText("Every N days"), {
      target: { value: "" },
    });
    await pick("Runs", "Once a day");
    const action = (await saveAndGetAction()).jobChange.action;
    expect(action.msdb).toMatchObject({
      freq_type: 4,
      freq_interval: 1,
      freq_recurrence_factor: 0,
      freq_subday_type: 1,
      freq_subday_interval: 0,
    });
  });

  it("reports a failed save and stays open; Cancel closes", async () => {
    createWriteRequest.mockRejectedValueOnce(new Error("boom"));
    open({ type: "set_enabled" });
    await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() =>
      expect(notifyError).toHaveBeenCalledWith(expect.any(Error), "Job change"),
    );
    expect(screen.queryByText("request page")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });
});
