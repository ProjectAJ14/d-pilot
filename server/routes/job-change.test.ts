import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import type { JobDetail } from "../types/index.js";

/**
 * job_change requests: one change to a scheduled job, its SQL written by the
 * server, refused (and audited) when the change would not pass as a direct
 * write, and never run over a job that changed since it was reviewed.
 */

const dir = mkdtempSync(path.join(tmpdir(), "d-pilot-job-change-"));
vi.stubEnv("DATA_DIR", dir);
vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "");

const JOB_ID = "28741445-2c81-4de3-8fe9-bb30b243dd28";
const job = (): JobDetail => ({
  id: JOB_ID,
  name: "recalc due dates",
  engine: "agent",
  enabled: true,
  stepCount: 2,
  database: "app_core",
  steps: [
    {
      id: 1,
      name: "run proc",
      subsystem: "TSQL",
      command: "EXEC app_core.refresh_order_totals",
      database: "app_core",
    },
    { id: 2, name: "cleanup", subsystem: "CmdExec", command: "echo done" },
  ],
  schedules: [
    {
      id: "8",
      name: "s",
      enabled: true,
      description: "",
      sharedWith: 0,
      editable: true,
      msdb: {},
    },
  ],
  history: [],
});

const h = vi.hoisted(() => ({
  executeMigration: vi.fn(),
  job: null as JobDetail | null,
}));
vi.mock("../services/write-executor.js", async (orig) => ({
  ...(await orig<typeof import("../services/write-executor.js")>()),
  executeMigration: h.executeMigration,
}));
vi.mock("../services/query-executor.js", async (orig) => ({
  ...(await orig<typeof import("../services/query-executor.js")>()),
  validateSqlSyntax: vi.fn(async () => ({})),
}));
vi.mock("../services/jobs.js", async (orig) => ({
  ...(await orig<typeof import("../services/jobs.js")>()),
  getJobDetail: vi.fn(async () => h.job),
}));

const store = await import("../services/sqlite-store.js");
const { default: writes } = await import("./write-requests.js");

store.initDatabase();
store.saveDbConnection({
  id: "qa-ms",
  name: "QA core",
  env: "QA",
  type: "mssql" as const,
  host: "db-a.example.com",
  database: "app_core",
  username: "app",
  password: "pw",
});

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const sub = req.headers["x-user"] as string;
    req.user = {
      sub,
      email: `${sub}@example.com`,
      isAdmin: false,
      allowedEnvironments: ["QA"],
      unmaskEnvironments: [],
      writeEnvironments: ["QA"],
      approveEnvironments: ["QA"],
      // Only "ops" may change jobs; "dev" can write data but not jobs.
      jobEnvironments: sub === "ops" ? ["QA"] : [],
    } as any;
    next();
  });
  app.use("/writes", writes);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/writes`;
});

afterAll(() => {
  server.close();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  h.job = job();
  h.executeMigration.mockReset();
  h.executeMigration.mockResolvedValue({
    rowsAffected: 0,
    executionMs: 1,
    transactional: true,
  });
});

const call = async (user: string, url: string, payload: unknown = {}) => {
  const res = await fetch(`${base}${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-user": user },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: (await res.json()) as any };
};
const raise = (action: unknown, user = "ops", extra = {}) =>
  call(user, "", {
    title: "Job fix",
    connectionId: "qa-ms",
    jobChange: { jobId: JOB_ID, action },
    ...extra,
  });
const refusals = () =>
  store
    .getDb()
    .prepare("SELECT sql FROM audit_log WHERE action = 'JOB_CHANGE_REFUSED'")
    .all() as { sql: string }[];

describe("job_change", () => {
  it("generates the SQL, binds the job as reviewed, and waits for approval", async () => {
    const { status, body } = await raise({
      type: "set_enabled",
      enabled: false,
      stray: 1,
    });
    expect(status).toBe(201);
    expect(body).toMatchObject({
      kind: "job_change",
      status: "PENDING",
      isMigration: true,
      writeSql: `EXEC msdb.dbo.sp_update_job @job_id = N'${JOB_ID}', @enabled = 0;`,
      jobChange: {
        jobId: JOB_ID,
        jobName: "recalc due dates",
        engine: "agent",
        action: { type: "set_enabled", enabled: false },
      },
    });
    expect(body.jobChange.action).not.toHaveProperty("stray");
    expect(body.events[0].notes).toBe(
      "Disables the job — job recalc due dates",
    );
    expect(h.executeMigration).not.toHaveBeenCalled();
  });

  it("refuses and audits a step command that would be refused as a direct write", async () => {
    const before = refusals().length;
    const { status, body } = await raise({
      type: "edit_step",
      stepId: 1,
      command: "UPDATE app_core.orders SET status = 'x'",
    });
    expect(status).toBe(400);
    expect(body.error).toContain("without a WHERE");
    const audited = refusals();
    expect(audited).toHaveLength(before + 1);
    expect(audited.at(-1)!.sql).toContain("refused: UPDATE without a WHERE");
  });

  it("refuses a non-SQL step and a user without the job capability, audited", async () => {
    const before = refusals().length;
    expect(
      (await raise({ type: "edit_step", stepId: 2, command: "EXEC p" })).body
        .error,
    ).toContain("CmdExec");
    const noCap = await raise({ type: "set_enabled", enabled: false }, "dev");
    expect(noCap.status).toBe(403);
    expect(refusals()).toHaveLength(before + 2);
  });

  it("won't run over a job changed since submit, and runs the generated SQL when unchanged", async () => {
    const { body } = await raise({
      type: "edit_step",
      stepId: 1,
      command: "EXEC app_core.refresh_order_totals @days = 14",
    });
    h.job = { ...job(), enabled: false }; // someone disabled it meanwhile
    const stale = await call("approver", `/${body.id}/approve`);
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("OBJECT_CHANGED");
    expect(store.getWriteRequest(body.id)!.status).toBe("PENDING");

    h.job = job();
    const ok = await call("approver", `/${body.id}/approve`);
    expect(ok.body.status).toBe("EXECUTED");
    expect(h.executeMigration).toHaveBeenCalledWith(
      expect.objectContaining({ id: "qa-ms" }),
      `EXEC msdb.dbo.sp_update_jobstep @job_id = N'${JOB_ID}', @step_id = 1, @command = N'EXEC app_core.refresh_order_totals @days = 14';`,
      { noTransaction: false },
    );
  });

  it("can't be revised, and a draft needs the capability to submit", async () => {
    const sched = await raise(
      {
        type: "set_schedule",
        scheduleId: "8",
        msdb: {
          freq_type: 4,
          freq_interval: 1,
          freq_subday_type: 4,
          freq_subday_interval: 15,
          freq_recurrence_factor: 0,
          active_start_time: 60000,
          active_end_time: 220000,
        },
      },
      "ops",
      { draft: true },
    );
    expect(sched.body.status).toBe("DRAFT");
    expect(
      (await call("ops", `/${sched.body.id}/revise`, { writeSql: "EXEC x" }))
        .status,
    ).toBe(400);
    expect((await call("dev", `/${sched.body.id}/submit`)).status).toBe(403);
    expect((await call("ops", `/${sched.body.id}/submit`)).body.status).toBe(
      "PENDING",
    );
  });
});
