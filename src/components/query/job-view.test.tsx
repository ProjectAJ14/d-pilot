// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../../store";
import type { JobDetail, QueryTab } from "../../types";
import { renderUi } from "../../utils/dom.testing";
import { formatDuration, JobView, RunBadge } from "./job-view";

const getJob = vi.fn();
vi.mock("../../utils/api-client", () => ({
  api: { getJob: (...a: unknown[]) => getJob(...a) },
}));

const tab = (over: Partial<QueryTab> = {}): QueryTab =>
  ({
    id: "t1",
    title: "nightly_orders",
    kind: "job",
    connectionId: "conn-qa",
    job: { id: "job-1", name: "nightly_orders" },
    ...over,
  }) as QueryTab;

type AuthUser = NonNullable<ReturnType<typeof useStore.getState>["user"]>;
const user = (over: Partial<AuthUser> = {}): AuthUser => ({
  id: "u1",
  username: "ann",
  email: "ann@example.com",
  name: "Ann",
  isAdmin: false,
  canUnmaskPhi: false,
  ...over,
});

function makeJob(over: Partial<JobDetail> = {}): JobDetail {
  return {
    id: "job-1",
    name: "nightly_orders",
    engine: "agent",
    enabled: true,
    stepCount: 3,
    database: "app_core",
    steps: [
      {
        id: 1,
        name: "load",
        subsystem: "TSQL",
        command: "EXEC load_orders",
        database: "app_core",
        lastRun: {
          status: "failed",
          startedAt: null,
          durationSec: 1,
          message: "deadlock",
        },
      },
      {
        id: 2,
        name: "ship",
        subsystem: "CmdExec",
        command: "ship.exe",
      },
      {
        id: 3,
        name: "tidy",
        subsystem: "sql",
        command: "DELETE FROM orders WHERE 1=0",
        database: "APP_CORE",
        lastRun: { status: "succeeded", startedAt: null, durationSec: 2 },
      },
    ],
    schedules: [
      {
        id: "s1",
        name: "daily",
        enabled: true,
        description: "Every day at 03:00",
        sharedWith: 0,
        editable: true,
      },
      {
        id: "s2",
        name: "weekly",
        enabled: false,
        description: "Weekly on Mon",
        sharedWith: 1,
        editable: true,
      },
      {
        id: "s3",
        name: "monthly",
        enabled: true,
        description: "Monthly on the 1st",
        sharedWith: 2,
        editable: true,
      },
    ],
    history: [
      {
        status: "succeeded",
        startedAt: "2026-10-31 03:00:00",
        durationSec: 3725,
        message: "ok",
      },
      { status: null, startedAt: null, durationSec: null },
    ],
    ...over,
  };
}

beforeEach(() => {
  getJob.mockReset();
  useStore.setState({
    user: user(),
    connections: [
      { id: "conn-qa", name: "QA core", env: "QA", type: "mssql" },
    ] as never,
  });
});

describe("formatDuration / RunBadge", () => {
  it("drops leading zero units", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(5)).toBe("5 s");
    expect(formatDuration(65)).toBe("1 min 5 s");
    expect(formatDuration(3605)).toBe("1 h 0 min 5 s");
  });

  it("says never run without a status", () => {
    renderUi(<RunBadge />);
    expect(screen.getByText("never run")).toBeTruthy();
  });
});

describe("JobView", () => {
  it("shows a read-only job when the user cannot change jobs", async () => {
    getJob.mockResolvedValue(
      makeJob({
        category: "Maintenance",
        description: "Rolls up orders",
        lastRun: {
          status: "failed",
          startedAt: "2026-10-31 03:00:00",
          durationSec: 65,
          message: "Step 1 failed",
        },
        nextRunAt: "2026-11-01 03:00:00",
      }),
    );
    renderUi(<JobView tab={tab()} />);
    expect(await screen.findByText("SQL Server Agent job")).toBeTruthy();
    expect(getJob).toHaveBeenCalledWith("conn-qa", "job-1");
    expect(screen.getByText("enabled")).toBeTruthy();
    expect(screen.getByText("Maintenance")).toBeTruthy();
    expect(screen.getByText("Rolls up orders")).toBeTruthy();
    expect(screen.getByText(/2026-10-31 03:00:00 · 1 min 5 s/)).toBeTruthy();
    expect(screen.getByText(/next run 2026-11-01 03:00:00/)).toBeTruthy();
    expect(screen.getByText("Step 1 failed")).toBeTruthy();
    expect(screen.getByText("deadlock")).toBeTruthy();
    expect(screen.getByText("on app_core")).toBeTruthy();
    expect(screen.getByText("(disabled)")).toBeTruthy();
    expect(screen.getByText(/also used by 1 other job;/)).toBeTruthy();
    expect(screen.getByText(/also used by 2 other jobs;/)).toBeTruthy();
    expect(screen.getByText("Recent runs")).toBeTruthy();
    expect(screen.getByText("1 h 2 min 5 s")).toBeTruthy();
    expect(screen.queryByText("Propose a change")).toBeNull();
    expect(screen.queryByText("Edit command")).toBeNull();
    expect(screen.queryByText("Change")).toBeNull();
  });

  it("offers every change on an Agent job to a user with job + write access", async () => {
    useStore.setState({
      user: user({ jobEnvironments: ["QA"], writeEnvironments: ["QA"] }),
    });
    getJob.mockResolvedValue(makeJob());
    renderUi(<JobView tab={tab()} />);
    await screen.findByText("nightly_orders");
    // TSQL on its own db and SQL on the same db (other case) are editable.
    expect(screen.getAllByText("Edit command")).toHaveLength(2);
    // Delete shows where the step names no db or exactly the job's db.
    expect(screen.getAllByText("Delete")).toHaveLength(2);
    // Only the unshared, editable schedule can change.
    expect(screen.getAllByText("Change")).toHaveLength(1);

    await userEvent.click(screen.getByText("Propose a change"));
    for (const item of ["Rename…", "Change description…", "Add a step…"])
      expect(await screen.findByText(item)).toBeTruthy();
    await userEvent.click(screen.getByText("Disable job"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/This disables/)).toBeTruthy();
    await userEvent.click(within(dialog).getByText("Cancel"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    const intents: [() => HTMLElement, string][] = [
      [() => screen.getAllByText("Edit command")[0], "Change a step's command"],
      [() => screen.getAllByText("Delete")[0], "Delete a step"],
      [() => screen.getByText("Change"), "Change the schedule"],
    ];
    for (const [target, title] of intents) {
      await userEvent.click(target());
      const d = await screen.findByRole("dialog");
      expect(within(d).getAllByText(title).length).toBeGreaterThan(0);
      await userEvent.click(within(d).getByText("Cancel"));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    }

    for (const [item, title] of [
      ["Rename…", "Rename the job"],
      ["Change description…", "Change the description"],
      ["Add a step…", "Add a step"],
    ]) {
      await userEvent.click(screen.getByText("Propose a change"));
      await userEvent.click(await screen.findByText(item));
      const d = await screen.findByRole("dialog");
      expect(within(d).getAllByText(title).length).toBeGreaterThan(0);
      await userEvent.click(within(d).getByText("Cancel"));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    }
  });

  it("locks the job-wide changes when a step runs on another database", async () => {
    useStore.setState({ user: user({ isAdmin: true }) });
    getJob.mockResolvedValue(
      makeJob({
        enabled: false,
        steps: [
          ...makeJob().steps,
          {
            id: 4,
            name: "remote",
            subsystem: "TSQL",
            command: "EXEC r",
            database: "reporting",
          },
        ],
      }),
    );
    renderUi(<JobView tab={tab()} />);
    await screen.findByText("disabled");
    expect(screen.queryByText("Propose a change")).toBeNull();
    expect(screen.queryByText("Delete")).toBeNull();
    expect(screen.queryByText("Change")).toBeNull();
    // Steps on this database can still change their command.
    expect(screen.getAllByText("Edit command")).toHaveLength(2);
  });

  it("treats every step as remote when the connection names no database", async () => {
    useStore.setState({ user: user({ isAdmin: true }) });
    getJob.mockResolvedValue(makeJob({ database: undefined }));
    renderUi(<JobView tab={tab()} />);
    await screen.findByText("SQL Server Agent job");
    expect(screen.queryByText("Propose a change")).toBeNull();
    expect(screen.queryByText("Edit command")).toBeNull();
  });

  it("offers only enable on a pg_cron job, with no Delete on a single step", async () => {
    useStore.setState({ user: user({ isAdmin: true }) });
    getJob.mockResolvedValue(
      makeJob({
        engine: "pg_cron",
        enabled: false,
        steps: [{ id: 1, name: "run", subsystem: "SQL", command: "CALL x()" }],
        schedules: [],
        history: [],
      }),
    );
    renderUi(<JobView tab={tab()} />);
    expect(await screen.findByText("pg_cron job")).toBeTruthy();
    expect(screen.getByText(/No schedule/)).toBeTruthy();
    expect(screen.queryByText("Recent runs")).toBeNull();
    expect(screen.queryByText("Delete")).toBeNull();
    await userEvent.click(screen.getByText("Propose a change"));
    expect(await screen.findByText("Enable job")).toBeTruthy();
    expect(screen.queryByText("Rename…")).toBeNull();
  });

  it("hides changes when the connection is unknown or the user lacks write", async () => {
    useStore.setState({
      user: user({ jobEnvironments: ["QA"], writeEnvironments: [] }),
    });
    getJob.mockResolvedValue(makeJob());
    const { unmount } = renderUi(<JobView tab={tab()} />);
    await screen.findByText("nightly_orders");
    expect(screen.queryByText("Propose a change")).toBeNull();
    unmount();

    useStore.setState({ user: null, connections: [] });
    renderUi(<JobView tab={tab()} />);
    await screen.findByText("nightly_orders");
    expect(screen.queryByText("Propose a change")).toBeNull();
  });

  it("opens no modal for a tab without a connection", async () => {
    useStore.setState({ user: user({ isAdmin: true }) });
    getJob.mockResolvedValue(makeJob());
    renderUi(<JobView tab={tab({ connectionId: null })} />);
    await userEvent.click(await screen.findByText("Propose a change"));
    await userEvent.click(await screen.findByText("Disable job"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows a load error and retries; Refresh re-reads", async () => {
    getJob.mockRejectedValueOnce(new Error("no msdb access"));
    getJob.mockResolvedValue(makeJob());
    renderUi(<JobView tab={tab()} />);
    expect(await screen.findByText("no msdb access")).toBeTruthy();
    await userEvent.click(screen.getByText("Try again"));
    expect(await screen.findByText("nightly_orders")).toBeTruthy();
    expect(getJob).toHaveBeenCalledTimes(2);
    await userEvent.click(screen.getByLabelText("Refresh job"));
    await waitFor(() => expect(getJob).toHaveBeenCalledTimes(3));
  });

  it("ignores answers that arrive after unmount", async () => {
    let resolve!: (j: JobDetail) => void;
    let reject!: (e: Error) => void;
    getJob
      .mockReturnValueOnce(new Promise((r) => (resolve = r)))
      .mockReturnValueOnce(new Promise((_, r) => (reject = r)));
    const first = renderUi(<JobView tab={tab()} />);
    first.unmount();
    resolve(makeJob());
    const second = renderUi(<JobView tab={tab()} />);
    second.unmount();
    reject(new Error("late"));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText("late")).toBeNull();
    expect(screen.queryByText("nightly_orders")).toBeNull();
  });
});
