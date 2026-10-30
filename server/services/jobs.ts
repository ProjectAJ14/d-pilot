import mssql from "mssql";
import type {
  ConnectionConfig,
  JobDetail,
  JobInfo,
  JobList,
  JobRun,
  JobRunStatus,
} from "../types/index.js";
import {
  introspectMssqlPool,
  introspectPgPool,
} from "./schema-introspector.js";
import {
  decodeDuration,
  decodeRunDateTime,
  decodeRunStatus,
  describeSchedule,
  isEditableSchedule,
  type MsdbSchedule,
} from "./job-schedule.js";

/**
 * Scheduled jobs, read-only: SQL Server Agent jobs (from msdb) and pg_cron
 * jobs. Only jobs that run against the connection's own database are listed —
 * Agent jobs are server-wide, and a reader of one database must not see the
 * step commands of another's.
 *
 * Reading them is a deployment grant, not a D-Pilot capability: msdb needs
 * SQLAgentReaderRole (or SELECT on its job tables), pg_cron needs SELECT on
 * the cron schema. Without it the list comes back `available: false` with a
 * reason naming the grant, never a raw driver error.
 */

export const AGENT_GRANT =
  "This connection can't read SQL Server Agent jobs (its login needs SQLAgentReaderRole in msdb).";
export const PG_CRON_GRANT =
  "This connection can't read pg_cron jobs (its role needs USAGE and SELECT on the cron schema).";

/** An Agent job id is a GUID, a pg_cron id an integer — anything else never reaches SQL. */
export function validJobId(conn: ConnectionConfig, id: string): boolean {
  return conn.type === "mssql"
    ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    : /^\d{1,18}$/.test(id);
}

/** SQL Server: permission denied (229/230) or msdb not there (208, e.g. Azure SQL Database). */
const isAgentAccessError = (err: any) =>
  [229, 230, 208, 916].includes(
    err?.number ?? err?.originalError?.info?.number,
  );

/** Postgres: insufficient_privilege. */
const isPgAccessError = (err: any) => err?.code === "42501";

export async function getJobs(conn: ConnectionConfig): Promise<JobList> {
  if (conn.type === "mssql") return getAgentJobs(conn);
  if (conn.type === "postgres") return getCronJobs(conn);
  return { available: false, jobs: [] };
}

/** One job with its steps, schedules and recent runs; null when not found. */
export async function getJobDetail(
  conn: ConnectionConfig,
  id: string,
): Promise<JobDetail | null> {
  const job =
    conn.type === "mssql"
      ? await getAgentJobDetail(conn, id)
      : conn.type === "postgres"
        ? await getCronJobDetail(conn, id)
        : null;
  return job && { ...job, database: conn.database };
}

// --- SQL Server Agent ---

// The latest job-level outcome per job is its newest sysjobhistory row with
// step_id 0; next run comes from the current Agent session's activity row.
const AGENT_JOBS_SQL = `
SELECT CONVERT(varchar(36), j.job_id) AS job_id, j.name, j.enabled, j.description,
       ISNULL(c.name, 'Uncategorized') AS category,
       (SELECT COUNT(*) FROM msdb.dbo.sysjobsteps s WHERE s.job_id = j.job_id) AS step_count,
       h.run_status, h.run_date, h.run_time, h.run_duration, h.message,
       CONVERT(varchar(19), ja.next_scheduled_run_date, 120) AS next_run
FROM msdb.dbo.sysjobs j
LEFT JOIN msdb.dbo.syscategories c ON c.category_id = j.category_id
OUTER APPLY (SELECT TOP 1 h1.* FROM msdb.dbo.sysjobhistory h1
             WHERE h1.job_id = j.job_id AND h1.step_id = 0
             ORDER BY h1.instance_id DESC) h
LEFT JOIN msdb.dbo.sysjobactivity ja ON ja.job_id = j.job_id
  AND ja.session_id = (SELECT MAX(session_id) FROM msdb.dbo.syssessions)
WHERE EXISTS (SELECT 1 FROM msdb.dbo.sysjobsteps s
              WHERE s.job_id = j.job_id AND s.database_name = DB_NAME())
  AND (@job IS NULL OR j.job_id = @job)
ORDER BY j.name`;

// A step aimed at another database on the same server belongs to that
// database's readers: its command and run message never leave the server.
// Steps with no database (CmdExec, PowerShell) are this job's own and stay.
const THIS_DB = "(s.database_name IS NULL OR s.database_name = DB_NAME())";
export const OTHER_DB_STEP =
  "-- Runs against another database on this server; its command is not shown here.";

const AGENT_SCHEDULE_COLS = `sc.freq_type, sc.freq_interval, sc.freq_subday_type,
  sc.freq_subday_interval, sc.freq_relative_interval, sc.freq_recurrence_factor,
  sc.active_start_date, sc.active_start_time, sc.active_end_time`;

const agentRun = (r: any): JobRun | undefined =>
  r.run_status == null
    ? undefined
    : {
        status: decodeRunStatus(r.run_status),
        startedAt: decodeRunDateTime(r.run_date, r.run_time),
        durationSec: decodeDuration(r.run_duration),
        ...(r.message && { message: r.message }),
      };

const agentJob = (r: any, schedule?: string): JobInfo => ({
  id: r.job_id.toLowerCase(),
  name: r.name,
  engine: "agent",
  enabled: !!r.enabled,
  // Agent fills an empty description with this placeholder.
  ...(r.description &&
    r.description !== "No description available." && {
      description: r.description,
    }),
  category: r.category,
  ...(schedule && { schedule }),
  lastRun: agentRun(r),
  nextRunAt: r.next_run ?? null,
  stepCount: r.step_count,
});

async function withAgent<T>(
  conn: ConnectionConfig,
  run: (pool: mssql.ConnectionPool) => Promise<T>,
): Promise<T> {
  const pool = introspectMssqlPool(conn);
  try {
    await pool.connect();
    return await run(pool);
  } finally {
    await pool.close();
  }
}

async function getAgentJobs(conn: ConnectionConfig): Promise<JobList> {
  try {
    return await withAgent(conn, async (pool) => {
      const res = await pool
        .request()
        .input("job", mssql.UniqueIdentifier, null)
        .query(
          `${AGENT_JOBS_SQL};
           SELECT CONVERT(varchar(36), js.job_id) AS job_id, ${AGENT_SCHEDULE_COLS}
           FROM msdb.dbo.sysjobschedules js
           JOIN msdb.dbo.sysschedules sc ON sc.schedule_id = js.schedule_id
           WHERE sc.enabled = 1`,
        );
      const [jobs, schedules] = res.recordsets as unknown as any[][];
      const byJob = new Map<string, string[]>();
      for (const s of schedules) {
        const id = s.job_id.toLowerCase();
        byJob.set(id, [...(byJob.get(id) ?? []), describeSchedule(s)]);
      }
      return {
        available: true,
        jobs: jobs.map((r) =>
          agentJob(r, byJob.get(r.job_id.toLowerCase())?.join("; ")),
        ),
      };
    });
  } catch (err) {
    if (isAgentAccessError(err))
      return { available: false, reason: AGENT_GRANT, jobs: [] };
    throw err;
  }
}

async function getAgentJobDetail(
  conn: ConnectionConfig,
  id: string,
): Promise<JobDetail | null> {
  return withAgent(conn, async (pool) => {
    const res = await pool
      .request()
      .input("job", mssql.UniqueIdentifier, id)
      .query(
        `${AGENT_JOBS_SQL};
         SELECT s.step_id, s.step_name, s.subsystem, s.database_name,
                CASE WHEN ${THIS_DB} THEN 0 ELSE 1 END AS other_db,
                CASE WHEN ${THIS_DB} THEN s.command END AS command,
                h.run_status, h.run_date, h.run_time, h.run_duration,
                CASE WHEN ${THIS_DB} THEN h.message END AS message
         FROM msdb.dbo.sysjobsteps s
         OUTER APPLY (SELECT TOP 1 h1.* FROM msdb.dbo.sysjobhistory h1
                      WHERE h1.job_id = s.job_id AND h1.step_id = s.step_id
                      ORDER BY h1.instance_id DESC) h
         WHERE s.job_id = @job ORDER BY s.step_id;
         SELECT sc.schedule_id, sc.name, sc.enabled, ${AGENT_SCHEDULE_COLS},
                (SELECT COUNT(*) FROM msdb.dbo.sysjobschedules x
                 WHERE x.schedule_id = sc.schedule_id) - 1 AS shared_with
         FROM msdb.dbo.sysjobschedules js
         JOIN msdb.dbo.sysschedules sc ON sc.schedule_id = js.schedule_id
         WHERE js.job_id = @job ORDER BY sc.name;
         SELECT TOP 20 run_status, run_date, run_time, run_duration, message
         FROM msdb.dbo.sysjobhistory WHERE job_id = @job AND step_id = 0
         ORDER BY instance_id DESC`,
      );
    const [jobs, steps, schedules, history] =
      res.recordsets as unknown as any[][];
    if (!jobs[0]) return null;
    const described = schedules.map((s) => ({
      id: String(s.schedule_id),
      name: s.name,
      enabled: !!s.enabled,
      description: describeSchedule(s as MsdbSchedule),
      sharedWith: s.shared_with,
      editable: isEditableSchedule(s as MsdbSchedule),
      msdb: Object.fromEntries(
        Object.entries(s).filter(
          ([k]) => k.startsWith("freq_") || k.startsWith("active_"),
        ),
      ) as Record<string, number>,
    }));
    return {
      ...agentJob(
        jobs[0],
        described
          .filter((s) => s.enabled)
          .map((s) => s.description)
          .join("; "),
      ),
      steps: steps.map((s) => ({
        id: s.step_id,
        name: s.step_name,
        subsystem: s.subsystem,
        command: s.other_db ? OTHER_DB_STEP : s.command,
        ...(s.database_name && { database: s.database_name }),
        lastRun: agentRun(s),
      })),
      schedules: described,
      history: history.map((h) => agentRun(h)!),
    };
  });
}

// --- pg_cron ---

/** pg_cron's run states, on Agent's scale: anything not finished is running. */
const cronStatus = (s: string | null): JobRunStatus | null =>
  s == null
    ? null
    : s === "succeeded"
      ? "succeeded"
      : s === "failed"
        ? "failed"
        : "running";

const ts = (d: Date | null) =>
  d ? d.toISOString().replace("T", " ").slice(0, 19) : null;

const cronRun = (r: any): JobRun | undefined =>
  r.status == null
    ? undefined
    : {
        status: cronStatus(r.status),
        startedAt: ts(r.start_time),
        durationSec:
          r.start_time && r.end_time
            ? Math.round((r.end_time - r.start_time) / 1000)
            : null,
        ...(r.return_message && { message: r.return_message }),
      };

const CRON_JOBS_SQL = `
SELECT j.jobid, j.jobname, j.schedule, j.command, j.database, j.active,
       r.status, r.return_message, r.start_time, r.end_time
FROM cron.job j
LEFT JOIN LATERAL (SELECT d.status, d.return_message, d.start_time, d.end_time
                   FROM cron.job_run_details d WHERE d.jobid = j.jobid
                   ORDER BY d.runid DESC LIMIT 1) r ON true
WHERE j.database = current_database() AND ($1::bigint IS NULL OR j.jobid = $1)
ORDER BY j.jobname, j.jobid`;

const cronJob = (r: any): JobInfo => ({
  id: String(r.jobid),
  name: r.jobname ?? `job ${r.jobid}`,
  engine: "pg_cron",
  enabled: !!r.active,
  schedule: r.schedule,
  lastRun: cronRun(r),
  // pg_cron does not record the next run; the cron expression says it.
  nextRunAt: null,
  stepCount: 1,
});

async function withCron<T>(
  conn: ConnectionConfig,
  run: (pool: ReturnType<typeof introspectPgPool>) => Promise<T>,
): Promise<T | "absent"> {
  const pool = introspectPgPool(conn);
  try {
    const ext = await pool.query(
      "SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'",
    );
    if (!ext.rowCount) return "absent";
    return await run(pool);
  } finally {
    await pool.end();
  }
}

async function getCronJobs(conn: ConnectionConfig): Promise<JobList> {
  try {
    const rows = await withCron(
      conn,
      async (pool) => (await pool.query(CRON_JOBS_SQL, [null])).rows,
    );
    // No extension: no jobs node at all, rather than an error.
    if (rows === "absent") return { available: false, jobs: [] };
    return { available: true, jobs: rows.map(cronJob) };
  } catch (err) {
    if (isPgAccessError(err))
      return { available: false, reason: PG_CRON_GRANT, jobs: [] };
    throw err;
  }
}

async function getCronJobDetail(
  conn: ConnectionConfig,
  id: string,
): Promise<JobDetail | null> {
  const detail = await withCron(conn, async (pool) => {
    const [job, runs] = await Promise.all([
      pool.query(CRON_JOBS_SQL, [id]),
      pool.query(
        `SELECT status, return_message, start_time, end_time
         FROM cron.job_run_details WHERE jobid = $1
         ORDER BY runid DESC LIMIT 20`,
        [id],
      ),
    ]);
    const r = job.rows[0];
    if (!r) return null;
    return {
      ...cronJob(r),
      steps: [
        {
          id: 1,
          name: r.jobname ?? "command",
          subsystem: "SQL",
          command: r.command,
          database: r.database,
          lastRun: cronRun(r),
        },
      ],
      schedules: [
        {
          id: String(r.jobid),
          name: r.schedule,
          enabled: !!r.active,
          description: r.schedule,
          sharedWith: 0,
          editable: true,
          cron: r.schedule,
        },
      ],
      history: runs.rows.map((x) => cronRun(x)!),
    };
  });
  return detail === "absent" ? null : detail;
}
