// The rules for a job_change write request. A job is SQL that runs later,
// unattended, so a change to one gets at least the scrutiny of a direct
// write. Pure functions — the route reads the job and does the I/O.
//
// The SQL that runs is generated here from one structured action, never
// typed by the author: ids are validated, every other value is a quoted
// literal. That text is what the reviewer sees and what executes.

import { scanSql } from "./sql-scan.js";
import { validateWriteQuery } from "./write-executor.js";
import { isEditableSchedule } from "./job-schedule.js";
export { describeJobAction } from "./job-action.js";
import type {
  DatabaseType,
  JobChangeAction,
  JobDetail,
  MsdbScheduleFields,
} from "../types/index.js";

/** `N'…'` with quotes doubled — SQL Server. */
const nstr = (s: string) => `N'${s.replace(/'/g, "''")}'`;
/** `'…'` with quotes doubled — Postgres (standard_conforming_strings). */
const pstr = (s: string) => `'${s.replace(/'/g, "''")}'`;

const ROUTINE_CALL = /^(EXEC|EXECUTE|CALL|SELECT)\b/i;
const PG_MAINTENANCE = /^(VACUUM|ANALYZE|REFRESH\s+MATERIALIZED\s+VIEW)\b/i;
const DML = /\b(INSERT|UPDATE|DELETE|MERGE)\b/i;
const DML_ALL = /\b(INSERT|UPDATE|DELETE|MERGE)\b/gi;
// SQL built from a string runs text the checker never sees.
const DYNAMIC_SQL = /\bEXEC(UTE)?\s*\(|\bsp_executesql\b/i;
const DDL = /\b(CREATE|ALTER|DROP|TRUNCATE|RENAME|GRANT|REVOKE|DENY)\b/i;

// The shape of exactly one routine call, over `callTokens` text: a string
// literal is the single token S, comments are gone. Arguments are literal
// values only — no nested calls, operators or subqueries — so the routine
// named is the only code that runs, and the server then checks in the
// catalog that it is one of the database's own (see isUserRoutine). Anything
// after the call fails: T-SQL needs no semicolon, so "EXEC p 1 SHUTDOWN" is
// two statements.
const IDENT = String.raw`(?:\[[^\]]+\]|"[^"]+"|[A-Za-z_#][\w$#@]*)`;
const NAME = String.raw`${IDENT}(?:\s*\.\s*${IDENT}?){0,3}`;
const VALUE = String.raw`(?:S|[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?|0x[0-9a-f]+|@\w+|NULL|DEFAULT|TRUE|FALSE)`;
const TSQL_ARG = String.raw`(?:@\w+\s*=\s*)?${VALUE}(?:\s+OUT(?:PUT)?)?`;
const TSQL_EXEC = new RegExp(
  String.raw`^EXEC(?:UTE)?\s+(?:@\w+\s*=\s*)?(${NAME})(?:\s+${TSQL_ARG}(?:\s*,\s*${TSQL_ARG})*)?\s*;?\s*$`,
  "i",
);
const CAST = String.raw`(?:\s*::\s*[A-Za-z_][\w ]*(?:\(\d+(?:\s*,\s*\d+)?\))?(?:\[\])?)?`;
const CALL_ARG = String.raw`(?:[A-Za-z_]\w*\s*=>\s*)?${VALUE}${CAST}`;
const CALL = new RegExp(
  String.raw`^(?:CALL|SELECT)\s+(${NAME})\s*\(\s*(?:${CALL_ARG}(?:\s*,\s*${CALL_ARG})*)?\s*\)\s*;?\s*$`,
  "i",
);
// Never a job step, whatever the catalog says.
const SYSTEM_ROUTINE = /^(xp_|pg_|lo_|dblink)|^set_config$/i;

/** `stmt` with each string literal as the token S and comments removed. */
function callTokens(stmt: string): string {
  return stmt
    .replace(
      // E'…' first: in it a backslash escapes the quote.
      /(?<![\w$])[eE]'(?:[^'\\]|\\.|'')*'|N?'(?:[^']|'')*'|\$(\w*)\$[\s\S]*?\$\1\$|--[^\n]*|\/\*[\s\S]*?\*\//g,
      (t) => (t.startsWith("--") || t.startsWith("/*") ? " " : " S "),
    )
    .trim();
}

const parts = (name: string) =>
  name.split(/\s*\.\s*/).map((p) => p.trim().replace(/^[["]|[\]"]$/g, ""));

/** The routine a call statement runs, or why it is not exactly one call. */
function parseRoutineCall(
  stmt: string,
  dbType: DatabaseType,
): { name: string } | { error: string } {
  const t = callTokens(stmt);
  const name = (TSQL_EXEC.exec(t) ?? CALL.exec(t))?.[1];
  if (!name)
    return {
      error: `A job step calls one routine with literal arguments and nothing else — "EXEC name args", "CALL name(args)" or "SELECT name(args)". ${PATTERN_HINT}`,
    };
  const p = parts(name);
  if (SYSTEM_ROUTINE.test(p[p.length - 1]))
    return {
      error: `${p[p.length - 1]}: system and administration routines can't run as a job step. ${PATTERN_HINT}`,
    };
  if (p.length > 2)
    return {
      error: `${name}: a job step calls a routine in this database — name it schema.routine.`,
    };
  // A Postgres job runs with its own search_path: say which routine.
  if (dbType === "postgres" && p.length < 2)
    return { error: `Qualify ${name} with its schema (schema.${name}).` };
  return { name: name.replace(/\s+/g, "") };
}

/**
 * The routines `command` calls, for the catalog check that each is one of
 * this database's own — not built in, not an extension's (dblink, pg_cron…),
 * not another database's. Only meaningful once checkJobCommand passed.
 */
export function jobCommandRoutines(
  command: string,
  dbType: DatabaseType,
): string[] {
  const names: string[] = [];
  for (const raw of scanSql(command).statements) {
    const stmt = raw.trim();
    if (!stmt || !ROUTINE_CALL.test(scanSql(stmt).masked)) continue;
    const call = parseRoutineCall(stmt, dbType);
    if ("name" in call) names.push(call.name);
  }
  return names;
}

const PATTERN_HINT =
  "Keep the logic in a procedure (changed through an object change) and have the step only EXEC/CALL it.";

/**
 * Why `command` may not become a job step, or null. A step D-Pilot writes is
 * either exactly one call of a user routine (EXEC/CALL, or SELECT of a
 * function — never a system or administration routine), Postgres
 * maintenance (VACUUM, ANALYZE, REFRESH MATERIALIZED VIEW), or INSERT/UPDATE/
 * DELETE statements that would each pass as a direct write — so an UPDATE
 * with no WHERE is refused here exactly as it is there. DDL and anything
 * the checker can't see through (T-SQL control flow, DML inside a call) is
 * refused.
 */
export function checkJobCommand(
  command: string,
  dbType: DatabaseType,
): string | null {
  const { statements, masked } = scanSql(command);
  if (!statements.some((s) => s.trim())) return "The command is empty.";
  if (DDL.test(masked))
    return `A job step can't run DDL (CREATE/ALTER/DROP/TRUNCATE/GRANT…). ${PATTERN_HINT}`;
  for (const raw of statements) {
    const stmt = raw.trim();
    if (!stmt) continue;
    const m = scanSql(stmt).masked;
    if (dbType === "postgres" && PG_MAINTENANCE.test(m)) continue;
    if (ROUTINE_CALL.test(m)) {
      if (DYNAMIC_SQL.test(m))
        return `Dynamic SQL (EXEC('…'), sp_executesql) can't be checked as a job step. ${PATTERN_HINT}`;
      // The raw text, strings included: a function such as dblink_exec runs
      // the SQL it is handed as a string.
      if (DML.test(stmt) || DDL.test(stmt))
        return `Write the INSERT/UPDATE/DELETE as its own statement, not inside a call or a string, so it can be checked. ${PATTERN_HINT}`;
      const call = parseRoutineCall(stmt, dbType);
      if ("error" in call) return call.error;
      continue;
    }
    if (DML.test(m.slice(0, 7))) {
      const v = validateWriteQuery(stmt, dbType);
      if (!v.valid) return `${v.error} ${PATTERN_HINT}`;
      // T-SQL needs no semicolons: "UPDATE … WHERE … UPDATE …" is two
      // statements that would pass as one scoped write.
      if ((m.match(DML_ALL) ?? []).length > 1)
        return "Separate each INSERT/UPDATE/DELETE with a semicolon so each can be checked.";
      if (!v.scoped)
        return `${v.verb} without a WHERE clause would change every row — refused, as it would be as a direct write.`;
      continue;
    }
    return `"${stmt.split(/\s+/)[0]}" can't be checked as a job step. Use one EXEC/CALL of a procedure, or scoped INSERT/UPDATE/DELETE statements separated by semicolons. ${PATTERN_HINT}`;
  }
  return null;
}

/**
 * Whether a step's database is not the connection's. SQL Server compares
 * database names case-insensitively, and a Postgres connection only works
 * when its name matches, so case never makes it another database.
 */
const otherDb = (step: string | undefined, own: string | undefined) =>
  !!step && step.toLowerCase() !== (own ?? "").toLowerCase();

const SQL_SUBSYSTEMS = ["TSQL", "SQL"];
const validTime = (t: number) =>
  Number.isInteger(t) &&
  t >= 0 &&
  t <= 235959 &&
  Math.floor(t / 100) % 100 < 60 &&
  t % 100 < 60;

function checkMsdbSchedule(s: MsdbScheduleFields | undefined): string | null {
  if (!s) return "A SQL Server Agent schedule needs its msdb fields.";
  const int = (n: unknown) => Number.isInteger(n);
  if (!Object.values(s).every(int)) return "Schedule fields must be integers.";
  if (!isEditableSchedule({ ...s, freq_relative_interval: 0 }))
    return "Only daily, weekly or monthly schedules that run once a day or every N minutes/hours can be set here.";
  if (s.freq_type === 4 && (s.freq_interval < 1 || s.freq_interval > 365))
    return "Daily: every 1–365 days.";
  if (s.freq_type === 8 && (s.freq_interval < 1 || s.freq_interval > 127))
    return "Weekly: pick at least one weekday.";
  if (s.freq_type === 16 && (s.freq_interval < 1 || s.freq_interval > 31))
    return "Monthly: a day from 1 to 31.";
  if (s.freq_type !== 4 && s.freq_recurrence_factor < 1)
    return "Repeat every 1 or more weeks/months.";
  if (
    s.freq_subday_type === 4 &&
    (s.freq_subday_interval < 1 || s.freq_subday_interval > 1439)
  )
    return "Every 1–1439 minutes.";
  if (
    s.freq_subday_type === 8 &&
    (s.freq_subday_interval < 1 || s.freq_subday_interval > 23)
  )
    return "Every 1–23 hours.";
  if (!validTime(s.active_start_time) || !validTime(s.active_end_time))
    return "Times are HHMMSS, 000000–235959.";
  return null;
}

// Five fields of cron, pg_cron's "N seconds", or a @-shortcut.
const CRON =
  /^(@(yearly|annually|monthly|weekly|daily|hourly|reboot)|([0-9*,/-]+\s+){4}[0-9*,/-]+|[1-5]?[0-9]\s+seconds)$/i;

/**
 * Why `action` can't be made to `job`, or null. `database` is the
 * connection's own: a step aimed at another database is not this reader's
 * to change, and new steps run here.
 */
export function validateJobChange(
  action: JobChangeAction,
  job: JobDetail,
  dbType: DatabaseType,
): string | null {
  const agent = job.engine === "agent";
  const step = (id: number) => job.steps.find((s) => s.id === id);
  const agentOnly = () =>
    agent
      ? null
      : "pg_cron jobs can't be renamed or described, and have exactly one command.";
  // A job that also runs steps on another database is partly that database's
  // work: disabling, renaming, rescheduling or re-ordering it changes what
  // runs there, which this connection's readers and approvers can't see.
  // Only this database's own step commands may change.
  const foreign = job.steps.some((s) => otherDb(s.database, job.database));
  if (foreign && action.type !== "edit_step")
    return "This job also runs steps against another database, so only this database's own step commands can be changed here.";
  switch (action.type) {
    case "set_enabled":
      return typeof action.enabled === "boolean"
        ? action.enabled === job.enabled
          ? `The job is already ${job.enabled ? "enabled" : "disabled"}.`
          : null
        : "enabled must be true or false.";
    case "rename":
      return (
        agentOnly() ?? (action.name?.trim() ? null : "A name is required.")
      );
    case "set_description":
      return (
        agentOnly() ??
        (typeof action.description === "string"
          ? null
          : "A description is required.")
      );
    case "delete_step": {
      const s = step(action.stepId);
      if (agentOnly()) return agentOnly();
      if (!s) return `Step ${action.stepId} does not exist.`;
      if (otherDb(s.database, job.database))
        return "That step runs against another database.";
      return job.steps.length === 1 ? "A job needs at least one step." : null;
    }
    case "edit_step":
    case "add_step": {
      if (action.type === "add_step") {
        if (agentOnly()) return agentOnly();
        if (!action.name?.trim()) return "A step name is required.";
      } else {
        const s = step(action.stepId);
        if (!s) return `Step ${action.stepId} does not exist.`;
        // CmdExec, PowerShell, SSIS… run operating-system commands the SQL
        // checker can't see; they are not changed through D-Pilot.
        if (!SQL_SUBSYSTEMS.includes(s.subsystem.toUpperCase()))
          return `Step ${s.id} is a ${s.subsystem} step — it runs an operating-system command D-Pilot can't check, so it can't be changed here.`;
        if (otherDb(s.database, job.database))
          return "That step runs against another database.";
      }
      return checkJobCommand(action.command ?? "", dbType);
    }
    case "set_schedule": {
      const sch = job.schedules.find((s) => s.id === String(action.scheduleId));
      if (!sch)
        return `Schedule ${action.scheduleId} is not attached to this job.`;
      // The other jobs may belong to other databases; moving their run time
      // is not this request's to decide.
      if (sch.sharedWith > 0)
        return `This schedule is shared with ${sch.sharedWith} other job${sch.sharedWith > 1 ? "s" : ""}, so it can't be changed here — give this job its own schedule first.`;
      if (agent) {
        if (!sch.editable)
          return "This schedule (one-time, monthly-relative, or on Agent start/idle) is read-only here.";
        return checkMsdbSchedule(action.msdb);
      }
      return CRON.test((action.cron ?? "").trim())
        ? null
        : "Not a cron expression: five fields, 'N seconds', or @daily/@hourly/….";
    }
    default:
      return "Unknown job change.";
  }
}

/** The statement that makes the change. Call only after validateJobChange. */
export function buildJobChangeSql(
  action: JobChangeAction,
  job: JobDetail,
): string {
  if (job.engine === "pg_cron") {
    const id = Number(job.id);
    const set = (arg: string) =>
      `SELECT cron.alter_job(job_id := ${id}, ${arg});`;
    switch (action.type) {
      case "set_enabled":
        return set(`active := ${action.enabled}`);
      case "edit_step":
        return set(`command := ${pstr(action.command.trim())}`);
      case "set_schedule":
        return set(`schedule := ${pstr(action.cron!.trim())}`);
      default:
        throw new Error(`${action.type} is not a pg_cron change`);
    }
  }
  const job_ = `@job_id = ${nstr(job.id)}`;
  switch (action.type) {
    case "set_enabled":
      return `EXEC msdb.dbo.sp_update_job ${job_}, @enabled = ${action.enabled ? 1 : 0};`;
    case "rename":
      return `EXEC msdb.dbo.sp_update_job ${job_}, @new_name = ${nstr(action.name.trim())};`;
    case "set_description":
      return `EXEC msdb.dbo.sp_update_job ${job_}, @description = ${nstr(action.description)};`;
    case "edit_step":
      return `EXEC msdb.dbo.sp_update_jobstep ${job_}, @step_id = ${action.stepId}, @command = ${nstr(action.command.trim())};`;
    case "add_step":
      return `EXEC msdb.dbo.sp_add_jobstep ${job_}, @step_name = ${nstr(action.name.trim())}, @subsystem = N'TSQL', @database_name = ${nstr(job.database!)}, @command = ${nstr(action.command.trim())};`;
    case "delete_step":
      return `EXEC msdb.dbo.sp_delete_jobstep ${job_}, @step_id = ${action.stepId};`;
    case "set_schedule": {
      const s = action.msdb!;
      return `EXEC msdb.dbo.sp_update_schedule @schedule_id = ${Number(action.scheduleId)}, @freq_type = ${s.freq_type}, @freq_interval = ${s.freq_interval}, @freq_subday_type = ${s.freq_subday_type}, @freq_subday_interval = ${s.freq_subday_interval}, @freq_recurrence_factor = ${s.freq_recurrence_factor}, @active_start_time = ${s.active_start_time}, @active_end_time = ${s.active_end_time};`;
    }
  }
}

/**
 * The job as reviewed: everything a change could collide with. Approval
 * re-reads the job and refuses if this moved — someone else changed it.
 */
export function jobSnapshot(job: JobDetail): string {
  return JSON.stringify({
    name: job.name,
    enabled: job.enabled,
    description: job.description ?? null,
    steps: job.steps.map(({ id, name, subsystem, command, database }) => ({
      id,
      name,
      subsystem,
      command,
      database: database ?? null,
    })),
    // sharedWith too: another job attaching the schedule widens what a
    // schedule change reaches, which the reviewer did not see.
    schedules: job.schedules.map(({ id, enabled, msdb, cron, sharedWith }) => ({
      id,
      enabled,
      msdb: msdb ?? null,
      cron: cron ?? null,
      sharedWith,
    })),
  });
}
