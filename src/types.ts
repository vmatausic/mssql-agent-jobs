export interface MssqlConnectionProfile {
  server: string;
  database?: string;
  authenticationType: "SqlLogin" | "Integrated" | "AzureMFA";
  user?: string;
  password?: string;
  profileName?: string;
  savePassword?: boolean;
  /** Older mssql versions use boolean, newer use "Mandatory" | "Optional" | "Strict" */
  encrypt?: boolean | string;
  trustServerCertificate?: boolean;
  connectTimeout?: number;
}

export interface AgentJob {
  jobId: string;
  name: string;
  enabled: boolean;
  description: string;
  lastRunDate: Date | null;
  lastRunOutcome: number; // 0=failed, 1=succeeded, 2=retry, 3=cancelled, 5=unknown
  nextRunDate: Date | null;
  currentlyExecuting: boolean;
  stepCount: number;
  categoryName: string;
}

export interface AgentJobSchedule {
  scheduleId: number;
  scheduleName: string;
  enabled: boolean;
  frequencyDescription: string;
  nextRunDate: Date | null;
  // raw agent fields, needed for editing
  freqType: number;
  freqInterval: number;
  freqSubdayType: number;
  freqSubdayInterval: number;
  freqRecurrenceFactor: number;
  activeStartTime: number; // HHMMSS as integer
}

export interface AgentJobStep {
  stepId: number;
  stepName: string;
  subsystem: string;
  command: string;
  databaseName: string;
  onSuccessAction: number; // 1=quit success, 2=quit failure, 3=next step, 4=go to step
  onSuccessStepId: number;
  onFailAction: number;
  onFailStepId: number;
  retryAttempts: number;
  retryInterval: number; // minutes
  lastRunOutcome: number;
  lastRunDuration: number; // seconds (decoded from agent HHMMSS format)
}

export interface StepConfig {
  stepName: string;
  subsystem: string; // TSQL | CmdExec | PowerShell
  command: string;
  databaseName: string | null;
  onSuccessAction: number;
  onSuccessStepId: number;
  onFailAction: number;
  onFailStepId: number;
  retryAttempts: number;
  retryInterval: number;
}

export interface ScheduleConfig {
  name: string;
  enabled: boolean;
  freqType: number;
  freqInterval: number;
  freqSubdayType: number;
  freqSubdayInterval: number;
  freqRecurrenceFactor: number;
  activeStartTime: number;
}

export interface JobOptionsUpdate {
  newName?: string;
  enabled: boolean;
  description: string;
  categoryName?: string;
  ownerLoginName?: string;
  // Notifications — levels are 0=never, 1=on success, 2=on failure, 3=on completion.
  notifyLevelEmail?: number;
  notifyEmailOperatorName?: string;
  notifyLevelEventlog?: number;
}

/** Notification settings that can be applied when a job is first created. */
export interface JobNotificationConfig {
  emailOperator?: string;
  emailLevel?: number; // 0-3
  eventlogLevel?: number; // 0-3
}

/** A SQL Server Agent operator — the recipient of job and alert notifications. */
export interface Operator {
  id: number;
  name: string;
  emailAddress: string;
  enabled: boolean;
}

/** An alert whose response is to run a given job (sysalerts.job_id = job). */
export interface JobAlert {
  alertId: number;
  name: string;
  enabled: boolean;
  type: number; // 1=event, 2=performance condition, 3=WMI
  messageId: number;
  severity: number;
  performanceCondition: string;
  databaseName: string;
  hasNotification: number; // bitmask: 1=email, 2=pager, 4=net send
  description: string;
}

export interface AgentJobHistoryRun {
  instanceId: number;
  runDate: Date | null;
  outcome: number;
  durationSeconds: number;
  message: string;
}

export interface JobDetails {
  jobId: string;
  name: string;
  enabled: boolean;
  description: string;
  categoryName: string;
  owner: string;
  dateCreated: Date | null;
  dateModified: Date | null;
  lastRunDate: Date | null;
  nextRunDate: Date | null;
  notifyLevelEmail: number; // 0=never, 1=success, 2=failure, 3=completion
  notifyEmailOperator: string;
  notifyLevelEventlog: number;
}

export interface JobScheduleExportRow {
  jobName: string;
  jobEnabled: boolean;
  scheduleName: string;
  scheduleEnabled: boolean | null;
  frequency: string;
  nextRun: Date | null;
}

export interface DailyStat {
  date: Date;
  succeeded: number;
  failed: number;
}

export interface RecentRun {
  jobId: string;
  jobName: string;
  runDate: Date | null;
  outcome: number;
  durationSeconds: number;
  message: string;
}

export interface NewSchedule {
  name: string;
  freqType: number; // 4=daily, 8=weekly
  freqInterval: number; // daily: every N days; weekly: day-of-week bitmask
  freqSubdayType: number; // 1=at time, 4=every N minutes, 8=every N hours
  freqSubdayInterval: number;
  freqRecurrenceFactor: number; // weekly: every N weeks
  activeStartTime: number; // HHMMSS as integer
}
