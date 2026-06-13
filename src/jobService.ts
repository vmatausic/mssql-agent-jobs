import * as mssql from "mssql";
import { ConnectionManager } from "./connectionManager";
import {
  AgentJob,
  AgentJobHistoryRun,
  AgentJobSchedule,
  AgentJobStep,
  DailyStat,
  JobDetails,
  JobScheduleExportRow,
  JobOptionsUpdate,
  NewSchedule,
  RecentRun,
  ScheduleConfig,
  StepConfig,
} from "./types";

type ProcParam = { name: string; type: mssql.ISqlTypeFactory | mssql.ISqlType; value: unknown } | null;

export class JobService {
  constructor(private conn: ConnectionManager) {}

  /** The connected SQL Server instance name (MACHINE or MACHINE\INSTANCE). */
  async getServerName(): Promise<string> {
    const rows = await this.conn.query<{ name: string }>(
      `SELECT CAST(SERVERPROPERTY('ServerName') AS nvarchar(256)) AS name`
    );
    return rows[0]?.name ?? "";
  }

  /**
   * Creates a job, targets it at the local agent, and returns the new job_id.
   * Steps and schedules are added afterward via the editor.
   */
  async createJob(name: string, description: string): Promise<string> {
    const rows = await this.conn.query<{ jobId: string }>(
      `SET NOCOUNT ON;
       DECLARE @jobId uniqueidentifier;
       EXEC msdb.dbo.sp_add_job
         @job_name    = @name,
         @description = @description,
         @enabled     = 1,
         @job_id      = @jobId OUTPUT;
       DECLARE @srv sysname = CAST(SERVERPROPERTY('ServerName') AS sysname);
       EXEC msdb.dbo.sp_add_jobserver @job_id = @jobId, @server_name = @srv;
       SELECT CONVERT(nvarchar(36), @jobId) AS jobId;`,
      (req) => {
        req.input("name", mssql.NVarChar(128), name);
        req.input(
          "description",
          mssql.NVarChar(512),
          description || "No description available."
        );
      }
    );
    const jobId = rows[0]?.jobId;
    if (!jobId) {
      throw new Error("Job was created but no id was returned.");
    }
    return jobId;
  }

  async getJobs(): Promise<AgentJob[]> {
    const sql = `
      SELECT
        CONVERT(nvarchar(36), j.job_id)                                       AS jobId,
        j.name                                                                AS name,
        j.enabled                                                             AS enabled,
        ISNULL(j.description, '')                                             AS description,
        ISNULL(c.name, 'Uncategorized')                                       AS categoryName,
        (SELECT COUNT(*) FROM msdb.dbo.sysjobsteps s WHERE s.job_id = j.job_id) AS stepCount,
        ja.last_executed_step_date                                            AS lastRunDate,
        ISNULL(jh.run_status, 5)                                              AS lastRunOutcome,
        ja.next_scheduled_run_date                                            AS nextRunDate,
        CASE WHEN ja.start_execution_date IS NOT NULL
             AND  ja.stop_execution_date  IS NULL     THEN 1 ELSE 0 END      AS currentlyExecuting
      FROM msdb.dbo.sysjobs j
      LEFT JOIN msdb.dbo.syscategories c ON j.category_id = c.category_id
      LEFT JOIN msdb.dbo.sysjobactivity ja
        ON  ja.job_id     = j.job_id
        AND ja.session_id = (
              SELECT MAX(session_id) FROM msdb.dbo.sysjobactivity WHERE job_id = j.job_id)
      LEFT JOIN msdb.dbo.sysjobhistory jh
        ON  jh.job_id      = j.job_id
        AND jh.instance_id = (
              SELECT MAX(instance_id) FROM msdb.dbo.sysjobhistory
              WHERE job_id = j.job_id AND step_id = 0)
      ORDER BY j.name
    `;

    const rows = await this.conn.query<{
      jobId: string;
      name: string;
      enabled: number;
      description: string;
      categoryName: string;
      stepCount: number;
      lastRunDate: Date | null;
      lastRunOutcome: number;
      nextRunDate: Date | null;
      currentlyExecuting: number;
    }>(sql);

    return rows.map((r) => ({
      jobId: r.jobId,
      name: r.name,
      enabled: r.enabled === 1,
      description: r.description,
      categoryName: r.categoryName,
      stepCount: r.stepCount,
      lastRunDate: r.lastRunDate,
      lastRunOutcome: r.lastRunOutcome,
      nextRunDate: r.nextRunDate,
      currentlyExecuting: r.currentlyExecuting === 1,
    }));
  }

  async getSchedules(jobId: string): Promise<AgentJobSchedule[]> {
    const sql = `
      SELECT
        s.schedule_id            AS scheduleId,
        s.name                   AS scheduleName,
        s.enabled                AS enabled,
        js.next_run_date         AS nextRunDate,
        js.next_run_time         AS nextRunTime,
        s.freq_type              AS freqType,
        s.freq_interval          AS freqInterval,
        s.freq_subday_type       AS freqSubdayType,
        s.freq_subday_interval   AS freqSubdayInterval,
        s.freq_relative_interval AS freqRelativeInterval,
        s.freq_recurrence_factor AS freqRecurrenceFactor,
        s.active_start_time      AS activeStartTime
      FROM msdb.dbo.sysjobschedules js
      JOIN msdb.dbo.sysschedules s ON js.schedule_id = s.schedule_id
      WHERE js.job_id = @jobId
      ORDER BY s.name
    `;

    const rows = await this.conn.query<{
      scheduleId: number;
      scheduleName: string;
      enabled: number;
      nextRunDate: number;
      nextRunTime: number;
      freqType: number;
      freqInterval: number;
      freqSubdayType: number;
      freqSubdayInterval: number;
      freqRelativeInterval: number;
      freqRecurrenceFactor: number;
      activeStartTime: number;
    }>(sql, (req) => req.input("jobId", mssql.UniqueIdentifier, jobId));

    return rows.map((r) => ({
      scheduleId: r.scheduleId,
      scheduleName: r.scheduleName,
      enabled: r.enabled === 1,
      frequencyDescription: describeFrequency(r),
      nextRunDate: parseAgentDate(r.nextRunDate, r.nextRunTime),
      freqType: r.freqType,
      freqInterval: r.freqInterval,
      freqSubdayType: r.freqSubdayType,
      freqSubdayInterval: r.freqSubdayInterval,
      freqRecurrenceFactor: r.freqRecurrenceFactor,
      activeStartTime: r.activeStartTime,
    }));
  }

  async getSteps(jobId: string): Promise<AgentJobStep[]> {
    const sql = `
      SELECT
        s.step_id                 AS stepId,
        s.step_name               AS stepName,
        s.subsystem               AS subsystem,
        ISNULL(s.command, '')     AS command,
        ISNULL(s.database_name, '') AS databaseName,
        s.on_success_action       AS onSuccessAction,
        s.on_success_step_id      AS onSuccessStepId,
        s.on_fail_action          AS onFailAction,
        s.on_fail_step_id         AS onFailStepId,
        s.retry_attempts          AS retryAttempts,
        s.retry_interval          AS retryInterval,
        ISNULL(h.run_status, 5)   AS lastRunOutcome,
        ISNULL(h.run_duration, 0) AS lastRunDuration
      FROM msdb.dbo.sysjobsteps s
      LEFT JOIN msdb.dbo.sysjobhistory h
        ON  h.job_id      = s.job_id
        AND h.step_id     = s.step_id
        AND h.instance_id = (
              SELECT MAX(instance_id) FROM msdb.dbo.sysjobhistory
              WHERE job_id = s.job_id AND step_id = s.step_id)
      WHERE s.job_id = @jobId
      ORDER BY s.step_id
    `;

    const rows = await this.conn.query<{
      stepId: number;
      stepName: string;
      subsystem: string;
      command: string;
      databaseName: string;
      onSuccessAction: number;
      onSuccessStepId: number;
      onFailAction: number;
      onFailStepId: number;
      retryAttempts: number;
      retryInterval: number;
      lastRunOutcome: number;
      lastRunDuration: number;
    }>(sql, (req) => req.input("jobId", mssql.UniqueIdentifier, jobId));

    return rows.map((r) => ({
      ...r,
      lastRunDuration: decodeAgentDuration(r.lastRunDuration),
    }));
  }

  async getHistory(jobId: string, limit = 20): Promise<AgentJobHistoryRun[]> {
    const sql = `
      SELECT TOP (@limit)
        h.instance_id  AS instanceId,
        h.run_date     AS runDate,
        h.run_time     AS runTime,
        h.run_status   AS outcome,
        h.run_duration AS duration,
        ISNULL(h.message, '') AS message
      FROM msdb.dbo.sysjobhistory h
      WHERE h.job_id = @jobId AND h.step_id = 0
      ORDER BY h.instance_id DESC
    `;

    const rows = await this.conn.query<{
      instanceId: number;
      runDate: number;
      runTime: number;
      outcome: number;
      duration: number;
      message: string;
    }>(sql, (req) => {
      req.input("jobId", mssql.UniqueIdentifier, jobId);
      req.input("limit", mssql.Int, limit);
    });

    return rows.map((r) => ({
      instanceId: r.instanceId,
      runDate: parseAgentDate(r.runDate, r.runTime),
      outcome: r.outcome,
      durationSeconds: decodeAgentDuration(r.duration),
      message: r.message,
    }));
  }

  async getJobDetails(jobId: string): Promise<JobDetails> {
    const sql = `
      SELECT
        CONVERT(nvarchar(36), j.job_id)       AS jobId,
        j.name                                AS name,
        j.enabled                             AS enabled,
        ISNULL(j.description, '')             AS description,
        ISNULL(c.name, 'Uncategorized')       AS categoryName,
        ISNULL(SUSER_SNAME(j.owner_sid), '?') AS owner,
        j.date_created                        AS dateCreated,
        j.date_modified                       AS dateModified,
        ja.last_executed_step_date            AS lastRunDate,
        ja.next_scheduled_run_date            AS nextRunDate
      FROM msdb.dbo.sysjobs j
      LEFT JOIN msdb.dbo.syscategories c ON j.category_id = c.category_id
      LEFT JOIN msdb.dbo.sysjobactivity ja
        ON  ja.job_id     = j.job_id
        AND ja.session_id = (
              SELECT MAX(session_id) FROM msdb.dbo.sysjobactivity WHERE job_id = j.job_id)
      WHERE j.job_id = @jobId
    `;

    const rows = await this.conn.query<{
      jobId: string;
      name: string;
      enabled: number;
      description: string;
      categoryName: string;
      owner: string;
      dateCreated: Date | null;
      dateModified: Date | null;
      lastRunDate: Date | null;
      nextRunDate: Date | null;
    }>(sql, (req) => req.input("jobId", mssql.UniqueIdentifier, jobId));

    if (rows.length === 0) {
      throw new Error("Job not found — it may have been deleted.");
    }
    const r = rows[0];
    return { ...r, enabled: r.enabled === 1 };
  }

  async updateJobOptions(jobId: string, u: JobOptionsUpdate): Promise<void> {
    await this.execProc("msdb.dbo.sp_update_job", [
      { name: "job_id", type: mssql.UniqueIdentifier, value: jobId },
      { name: "enabled", type: mssql.Int, value: u.enabled ? 1 : 0 },
      {
        name: "description",
        type: mssql.NVarChar(512),
        value: u.description || "No description available.",
      },
      u.newName !== undefined
        ? { name: "new_name", type: mssql.NVarChar(128), value: u.newName }
        : null,
      u.categoryName !== undefined
        ? { name: "category_name", type: mssql.NVarChar(128), value: u.categoryName }
        : null,
      u.ownerLoginName !== undefined
        ? { name: "owner_login_name", type: mssql.NVarChar(128), value: u.ownerLoginName }
        : null,
    ]);
  }

  async getCategories(): Promise<string[]> {
    const rows = await this.conn.query<{ name: string }>(
      `SELECT name FROM msdb.dbo.syscategories WHERE category_class = 1 ORDER BY name`
    );
    return rows.map((r) => r.name);
  }

  async getRecentRuns(limit = 30, days?: number): Promise<RecentRun[]> {
    const sql = `
      SELECT TOP (@limit)
        CONVERT(nvarchar(36), h.job_id) AS jobId,
        j.name                          AS jobName,
        h.run_date                      AS runDate,
        h.run_time                      AS runTime,
        h.run_status                    AS outcome,
        h.run_duration                  AS duration,
        ISNULL(h.message, '')           AS message
      FROM msdb.dbo.sysjobhistory h
      JOIN msdb.dbo.sysjobs j ON j.job_id = h.job_id
      WHERE h.step_id = 0 AND h.run_date >= @minDate
      ORDER BY h.instance_id DESC
    `;

    const rows = await this.conn.query<{
      jobId: string;
      jobName: string;
      runDate: number;
      runTime: number;
      outcome: number;
      duration: number;
      message: string;
    }>(sql, (req) => {
      req.input("limit", mssql.Int, limit);
      req.input("minDate", mssql.Int, days ? dateIntDaysAgo(days) : 0);
    });

    return rows.map((r) => ({
      jobId: r.jobId,
      jobName: r.jobName,
      runDate: parseAgentDate(r.runDate, r.runTime),
      outcome: r.outcome,
      durationSeconds: decodeAgentDuration(r.duration),
      message: r.message,
    }));
  }

  /** One row per job-schedule pair (jobs without schedules included), for export. */
  async getJobScheduleExport(): Promise<JobScheduleExportRow[]> {
    const sql = `
      SELECT
        j.name                   AS jobName,
        j.enabled                AS jobEnabled,
        s.name                   AS scheduleName,
        s.enabled                AS scheduleEnabled,
        js.next_run_date         AS nextRunDate,
        js.next_run_time         AS nextRunTime,
        s.freq_type              AS freqType,
        s.freq_interval          AS freqInterval,
        s.freq_subday_type       AS freqSubdayType,
        s.freq_subday_interval   AS freqSubdayInterval,
        s.freq_relative_interval AS freqRelativeInterval,
        s.freq_recurrence_factor AS freqRecurrenceFactor
      FROM msdb.dbo.sysjobs j
      LEFT JOIN msdb.dbo.sysjobschedules js ON js.job_id = j.job_id
      LEFT JOIN msdb.dbo.sysschedules s ON s.schedule_id = js.schedule_id
      ORDER BY j.name, s.name
    `;

    const rows = await this.conn.query<{
      jobName: string;
      jobEnabled: number;
      scheduleName: string | null;
      scheduleEnabled: number | null;
      nextRunDate: number | null;
      nextRunTime: number | null;
      freqType: number | null;
      freqInterval: number;
      freqSubdayType: number;
      freqSubdayInterval: number;
      freqRelativeInterval: number;
      freqRecurrenceFactor: number;
    }>(sql);

    return rows.map((r) => ({
      jobName: r.jobName,
      jobEnabled: r.jobEnabled === 1,
      scheduleName: r.scheduleName ?? "",
      scheduleEnabled: r.scheduleEnabled === null ? null : r.scheduleEnabled === 1,
      frequency:
        r.freqType === null
          ? ""
          : describeFrequency({
              freqType: r.freqType,
              freqInterval: r.freqInterval,
              freqSubdayType: r.freqSubdayType,
              freqSubdayInterval: r.freqSubdayInterval,
              freqRelativeInterval: r.freqRelativeInterval,
              freqRecurrenceFactor: r.freqRecurrenceFactor,
            }),
      nextRun: parseAgentDate(r.nextRunDate ?? 0, r.nextRunTime ?? 0),
    }));
  }

  /** Succeeded/failed run counts per day over the last `days` days, gaps filled with zeros. */
  async getDailyStats(days = 14): Promise<DailyStat[]> {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (days - 1));
    const minDateInt = dateIntDaysAgo(days);

    const rows = await this.conn.query<{
      runDate: number;
      succeeded: number;
      failed: number;
    }>(
      `SELECT
         h.run_date                                          AS runDate,
         SUM(CASE WHEN h.run_status = 1 THEN 1 ELSE 0 END)   AS succeeded,
         SUM(CASE WHEN h.run_status = 0 THEN 1 ELSE 0 END)   AS failed
       FROM msdb.dbo.sysjobhistory h
       WHERE h.step_id = 0 AND h.run_date >= @minDate
       GROUP BY h.run_date
       ORDER BY h.run_date`,
      (req) => req.input("minDate", mssql.Int, minDateInt)
    );

    const byDate = new Map(rows.map((r) => [r.runDate, r]));
    const stats: DailyStat[] = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const key = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
      const row = byDate.get(key);
      stats.push({
        date: d,
        succeeded: row?.succeeded ?? 0,
        failed: row?.failed ?? 0,
      });
    }
    return stats;
  }

  // ── Job actions ──────────────────────────────────────────────────────────────

  async setJobEnabled(jobId: string, enabled: boolean): Promise<void> {
    await this.conn.query(
      `EXEC msdb.dbo.sp_update_job @job_id = @jobId, @enabled = @enabled`,
      (req) => {
        req.input("jobId", mssql.UniqueIdentifier, jobId);
        req.input("enabled", mssql.Int, enabled ? 1 : 0);
      }
    );
  }

  async startJob(jobId: string): Promise<void> {
    await this.conn.query(
      `EXEC msdb.dbo.sp_start_job @job_id = @jobId`,
      (req) => req.input("jobId", mssql.UniqueIdentifier, jobId)
    );
  }

  async stopJob(jobId: string): Promise<void> {
    await this.conn.query(
      `EXEC msdb.dbo.sp_stop_job @job_id = @jobId`,
      (req) => req.input("jobId", mssql.UniqueIdentifier, jobId)
    );
  }

  // ── Schedule actions ─────────────────────────────────────────────────────────

  async addSchedule(jobId: string, s: NewSchedule): Promise<void> {
    await this.conn.query(
      `EXEC msdb.dbo.sp_add_jobschedule
         @job_id                = @jobId,
         @name                  = @name,
         @enabled               = 1,
         @freq_type             = @freqType,
         @freq_interval         = @freqInterval,
         @freq_subday_type      = @freqSubdayType,
         @freq_subday_interval  = @freqSubdayInterval,
         @freq_recurrence_factor = @freqRecurrenceFactor,
         @active_start_time     = @activeStartTime`,
      (req) => {
        req.input("jobId", mssql.UniqueIdentifier, jobId);
        req.input("name", mssql.NVarChar, s.name);
        req.input("freqType", mssql.Int, s.freqType);
        req.input("freqInterval", mssql.Int, s.freqInterval);
        req.input("freqSubdayType", mssql.Int, s.freqSubdayType);
        req.input("freqSubdayInterval", mssql.Int, s.freqSubdayInterval);
        req.input("freqRecurrenceFactor", mssql.Int, s.freqRecurrenceFactor);
        req.input("activeStartTime", mssql.Int, s.activeStartTime);
      }
    );
  }

  /** Note: a schedule can be shared by several jobs — updating affects all of them. */
  async updateSchedule(scheduleId: number, s: ScheduleConfig): Promise<void> {
    await this.execProc("msdb.dbo.sp_update_schedule", [
      { name: "schedule_id", type: mssql.Int, value: scheduleId },
      { name: "new_name", type: mssql.NVarChar(128), value: s.name },
      { name: "enabled", type: mssql.Int, value: s.enabled ? 1 : 0 },
      { name: "freq_type", type: mssql.Int, value: s.freqType },
      { name: "freq_interval", type: mssql.Int, value: s.freqInterval },
      { name: "freq_subday_type", type: mssql.Int, value: s.freqSubdayType },
      { name: "freq_subday_interval", type: mssql.Int, value: s.freqSubdayInterval },
      { name: "freq_relative_interval", type: mssql.Int, value: 0 },
      { name: "freq_recurrence_factor", type: mssql.Int, value: s.freqRecurrenceFactor },
      { name: "active_start_time", type: mssql.Int, value: s.activeStartTime },
    ]);
  }

  async updateStep(jobId: string, stepId: number, st: StepConfig): Promise<void> {
    await this.execProc("msdb.dbo.sp_update_jobstep", [
      { name: "job_id", type: mssql.UniqueIdentifier, value: jobId },
      { name: "step_id", type: mssql.Int, value: stepId },
      ...this.stepParams(st),
    ]);
  }

  async addStep(jobId: string, st: StepConfig): Promise<void> {
    await this.execProc("msdb.dbo.sp_add_jobstep", [
      { name: "job_id", type: mssql.UniqueIdentifier, value: jobId },
      ...this.stepParams(st),
    ]);
  }

  async deleteStep(jobId: string, stepId: number): Promise<void> {
    await this.execProc("msdb.dbo.sp_delete_jobstep", [
      { name: "job_id", type: mssql.UniqueIdentifier, value: jobId },
      { name: "step_id", type: mssql.Int, value: stepId },
    ]);
  }

  private stepParams(st: StepConfig): ProcParam[] {
    return [
      { name: "step_name", type: mssql.NVarChar(128), value: st.stepName },
      { name: "subsystem", type: mssql.NVarChar(40), value: st.subsystem },
      { name: "command", type: mssql.NVarChar(mssql.MAX), value: st.command },
      // database_name only applies to T-SQL steps; sending it for other
      // subsystems makes the proc reject the call
      st.subsystem === "TSQL"
        ? {
            name: "database_name",
            type: mssql.NVarChar(128),
            value: st.databaseName || "master",
          }
        : null,
      { name: "on_success_action", type: mssql.Int, value: st.onSuccessAction },
      { name: "on_success_step_id", type: mssql.Int, value: st.onSuccessStepId },
      { name: "on_fail_action", type: mssql.Int, value: st.onFailAction },
      { name: "on_fail_step_id", type: mssql.Int, value: st.onFailStepId },
      { name: "retry_attempts", type: mssql.Int, value: st.retryAttempts },
      { name: "retry_interval", type: mssql.Int, value: st.retryInterval },
    ];
  }

  private async execProc(proc: string, params: ProcParam[]): Promise<void> {
    const present = params.filter((p): p is NonNullable<ProcParam> => p !== null);
    const sql =
      `EXEC ${proc} ` + present.map((p) => `@${p.name} = @${p.name}`).join(", ");
    await this.conn.query(sql, (req) => {
      for (const p of present) {
        req.input(p.name, p.type as mssql.ISqlType, p.value);
      }
    });
  }

  async setScheduleEnabled(scheduleId: number, enabled: boolean): Promise<void> {
    await this.conn.query(
      `EXEC msdb.dbo.sp_update_schedule @schedule_id = @scheduleId, @enabled = @enabled`,
      (req) => {
        req.input("scheduleId", mssql.Int, scheduleId);
        req.input("enabled", mssql.Int, enabled ? 1 : 0);
      }
    );
  }

  async removeSchedule(jobId: string, scheduleId: number): Promise<void> {
    await this.conn.query(
      `EXEC msdb.dbo.sp_detach_schedule
         @job_id = @jobId,
         @schedule_id = @scheduleId,
         @delete_unused_schedule = 1`,
      (req) => {
        req.input("jobId", mssql.UniqueIdentifier, jobId);
        req.input("scheduleId", mssql.Int, scheduleId);
      }
    );
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** YYYYMMDD int for midnight `days - 1` days before today (inclusive window start). */
function dateIntDaysAgo(days: number): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (days - 1));
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

/** Agent dates are int pairs: run_date = YYYYMMDD, run_time = HHMMSS. */
function parseAgentDate(dateInt: number, timeInt: number): Date | null {
  if (!dateInt || dateInt === 0) return null;
  const ds = String(dateInt).padStart(8, "0");
  const ts = String(timeInt).padStart(6, "0");
  return new Date(
    parseInt(ds.slice(0, 4)),
    parseInt(ds.slice(4, 6)) - 1,
    parseInt(ds.slice(6, 8)),
    parseInt(ts.slice(0, 2)),
    parseInt(ts.slice(2, 4)),
    parseInt(ts.slice(4, 6))
  );
}

/** run_duration is HHMMSS packed into an int (13030 = 1h 30m 30s) — NOT seconds. */
function decodeAgentDuration(packed: number): number {
  const h = Math.floor(packed / 10000);
  const m = Math.floor((packed % 10000) / 100);
  const s = packed % 100;
  return h * 3600 + m * 60 + s;
}

function describeFrequency(r: {
  freqType: number;
  freqInterval: number;
  freqSubdayType: number;
  freqSubdayInterval: number;
  freqRelativeInterval: number;
  freqRecurrenceFactor: number;
}): string {
  switch (r.freqType) {
    case 1:   return "One time";
    case 4: {
      const sub = describeSubday(r.freqSubdayType, r.freqSubdayInterval);
      return r.freqInterval === 1 ? `Daily${sub}` : `Every ${r.freqInterval} days${sub}`;
    }
    case 8:   return `Weekly on ${decodeDayMask(r.freqInterval)} (every ${r.freqRecurrenceFactor} wk)`;
    case 16:  return `Monthly on day ${r.freqInterval}`;
    case 32:  return "Monthly relative";
    case 64:  return "On SQL Server Agent start";
    case 128: return "When CPU is idle";
    default:  return "Unknown schedule";
  }
}

function describeSubday(type: number, interval: number): string {
  if (type === 2) return `, every ${interval}s`;
  if (type === 4) return `, every ${interval}m`;
  if (type === 8) return `, every ${interval}h`;
  return "";
}

function decodeDayMask(mask: number): string {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    .filter((_, i) => mask & (1 << i))
    .join(", ");
}
