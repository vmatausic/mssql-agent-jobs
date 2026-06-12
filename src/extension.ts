import * as vscode from "vscode";
import { ConnectionManager } from "./connectionManager";
import { JobService } from "./jobService";
import { JobNode, JobTreeProvider, OptionsNode, ScheduleNode } from "./jobTreeProvider";
import { DashboardPanel } from "./panels/dashboardPanel";
import { JobOptionsPanel } from "./panels/jobOptionsPanel";
import { NewSchedule } from "./types";

export function activate(context: vscode.ExtensionContext) {
  const connectionManager = new ConnectionManager(context.secrets);
  const jobService = new JobService(connectionManager);
  const treeProvider = new JobTreeProvider(jobService);

  const treeView = vscode.window.createTreeView("sqlAgentJobsExplorer", {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });

  let refreshTimer: NodeJS.Timeout | undefined;

  function startAutoRefresh() {
    stopAutoRefresh();
    const interval = vscode.workspace
      .getConfiguration("sqlAgentJobs")
      .get<number>("autoRefreshInterval", 60);
    if (interval > 0) {
      refreshTimer = setInterval(() => treeProvider.refresh(), interval * 1000);
    }
  }

  function stopAutoRefresh() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = undefined;
    }
  }

  async function runAction(label: string, fn: () => Promise<void>) {
    try {
      await fn();
      treeProvider.refresh();
      DashboardPanel.refreshIfOpen();
    } catch (e: any) {
      vscode.window.showErrorMessage(`${label} failed: ${e.message}`);
    }
  }

  function openJobOptions(jobId: string, jobName: string) {
    JobOptionsPanel.show(jobService, jobId, jobName, () => {
      treeProvider.refresh();
      DashboardPanel.refreshIfOpen();
    });
  }

  function openDashboard() {
    const profile = connectionManager.getCurrentProfile();
    if (!profile) {
      vscode.window.showWarningMessage("Connect to a server first.");
      return;
    }
    DashboardPanel.show(
      jobService,
      profile.profileName || profile.server,
      openJobOptions
    );
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("sqlAgentJobs.refresh", () => {
      treeProvider.refresh();
    }),

    vscode.commands.registerCommand("sqlAgentJobs.selectConnection", async () => {
      const profile = await connectionManager.promptSelectProfile();
      if (!profile) return;

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Connecting to SQL Server…" },
        async () => {
          try {
            await connectionManager.connect(profile);
            const label = profile.profileName || profile.server;
            treeProvider.setConnectionLabel(label);
            treeView.title = `SQL Agent Jobs · ${label}`;
            startAutoRefresh();
            DashboardPanel.show(jobService, label, openJobOptions);
          } catch (e: any) {
            vscode.window.showErrorMessage(`Connection failed: ${e.message}`);
          }
        }
      );
    }),

    vscode.commands.registerCommand("sqlAgentJobs.forgetPassword", async () => {
      const profile = await connectionManager.promptSelectProfile();
      if (!profile) return;
      await connectionManager.forgetPassword(profile);
      vscode.window.showInformationMessage(
        `Saved password cleared for ${profile.profileName || profile.server}.`
      );
    }),

    vscode.commands.registerCommand("sqlAgentJobs.openDashboard", openDashboard),

    vscode.commands.registerCommand(
      "sqlAgentJobs.openJobOptions",
      (node: JobNode | OptionsNode) => openJobOptions(node.job.jobId, node.job.name)
    ),

    // ── Job actions ──────────────────────────────────────────────────────────

    vscode.commands.registerCommand("sqlAgentJobs.enableJob", (node: JobNode) =>
      runAction("Enable job", () => jobService.setJobEnabled(node.job.jobId, true))
    ),

    vscode.commands.registerCommand("sqlAgentJobs.disableJob", (node: JobNode) =>
      runAction("Disable job", () => jobService.setJobEnabled(node.job.jobId, false))
    ),

    vscode.commands.registerCommand("sqlAgentJobs.startJob", (node: JobNode) =>
      runAction("Start job", () => jobService.startJob(node.job.jobId))
    ),

    vscode.commands.registerCommand("sqlAgentJobs.stopJob", async (node: JobNode) => {
      const confirm = await vscode.window.showWarningMessage(
        `Stop job "${node.job.name}"?`,
        { modal: true },
        "Stop"
      );
      if (confirm !== "Stop") return;
      await runAction("Stop job", () => jobService.stopJob(node.job.jobId));
    }),

    // ── Schedule actions ─────────────────────────────────────────────────────

    vscode.commands.registerCommand("sqlAgentJobs.addSchedule", async (node: JobNode) => {
      const schedule = await promptNewSchedule(node.job.name);
      if (!schedule) return;
      await runAction("Add schedule", () =>
        jobService.addSchedule(node.job.jobId, schedule)
      );
    }),

    vscode.commands.registerCommand("sqlAgentJobs.enableSchedule", (node: ScheduleNode) =>
      runAction("Enable schedule", () =>
        jobService.setScheduleEnabled(node.schedule.scheduleId, true)
      )
    ),

    vscode.commands.registerCommand("sqlAgentJobs.disableSchedule", (node: ScheduleNode) =>
      runAction("Disable schedule", () =>
        jobService.setScheduleEnabled(node.schedule.scheduleId, false)
      )
    ),

    vscode.commands.registerCommand("sqlAgentJobs.deleteSchedule", async (node: ScheduleNode) => {
      const confirm = await vscode.window.showWarningMessage(
        `Remove schedule "${node.schedule.scheduleName}" from job "${node.job.name}"? ` +
          `The schedule is deleted entirely if no other job uses it.`,
        { modal: true },
        "Remove"
      );
      if (confirm !== "Remove") return;
      await runAction("Remove schedule", () =>
        jobService.removeSchedule(node.job.jobId, node.schedule.scheduleId)
      );
    }),

    treeView,
    { dispose: stopAutoRefresh }
  );
}

export function deactivate() {}

// ── Add-schedule wizard ─────────────────────────────────────────────────────────

async function promptNewSchedule(jobName: string): Promise<NewSchedule | undefined> {
  const kind = await vscode.window.showQuickPick(
    [
      { label: "Daily at a specific time", id: "daily" },
      { label: "Every N minutes", id: "minutes" },
      { label: "Every N hours", id: "hours" },
      { label: "Weekly on selected days", id: "weekly" },
    ],
    { placeHolder: `New schedule for "${jobName}"` }
  );
  if (!kind) return undefined;

  const name = await vscode.window.showInputBox({
    prompt: "Schedule name",
    value: kind.label,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : "Name is required"),
  });
  if (name === undefined) return undefined;

  switch (kind.id) {
    case "daily": {
      const time = await promptTime();
      if (time === undefined) return undefined;
      return {
        name,
        freqType: 4,
        freqInterval: 1,
        freqSubdayType: 1,
        freqSubdayInterval: 0,
        freqRecurrenceFactor: 0,
        activeStartTime: time,
      };
    }
    case "minutes":
    case "hours": {
      const unit = kind.id === "minutes" ? "minutes" : "hours";
      const max = kind.id === "minutes" ? 1439 : 23;
      const n = await vscode.window.showInputBox({
        prompt: `Run every how many ${unit}?`,
        ignoreFocusOut: true,
        validateInput: (v) => {
          const num = parseInt(v, 10);
          return Number.isInteger(num) && num >= 1 && num <= max
            ? undefined
            : `Enter a whole number between 1 and ${max}`;
        },
      });
      if (n === undefined) return undefined;
      return {
        name,
        freqType: 4,
        freqInterval: 1,
        freqSubdayType: kind.id === "minutes" ? 4 : 8,
        freqSubdayInterval: parseInt(n, 10),
        freqRecurrenceFactor: 0,
        activeStartTime: 0,
      };
    }
    case "weekly": {
      const days = await vscode.window.showQuickPick(
        [
          { label: "Monday", bit: 2 },
          { label: "Tuesday", bit: 4 },
          { label: "Wednesday", bit: 8 },
          { label: "Thursday", bit: 16 },
          { label: "Friday", bit: 32 },
          { label: "Saturday", bit: 64 },
          { label: "Sunday", bit: 1 },
        ],
        { canPickMany: true, placeHolder: "Select days of the week" }
      );
      if (!days || days.length === 0) return undefined;
      const time = await promptTime();
      if (time === undefined) return undefined;
      return {
        name,
        freqType: 8,
        freqInterval: days.reduce((mask, d) => mask | d.bit, 0),
        freqSubdayType: 1,
        freqSubdayInterval: 0,
        freqRecurrenceFactor: 1,
        activeStartTime: time,
      };
    }
  }
  return undefined;
}

/** Returns HHMMSS as an integer (the format sp_add_jobschedule expects). */
async function promptTime(): Promise<number | undefined> {
  const input = await vscode.window.showInputBox({
    prompt: "Start time (24h, HH:MM)",
    value: "02:00",
    ignoreFocusOut: true,
    validateInput: (v) =>
      /^([01]?\d|2[0-3]):[0-5]\d$/.test(v.trim())
        ? undefined
        : "Use HH:MM in 24-hour format, e.g. 14:30",
  });
  if (input === undefined) return undefined;
  const [h, m] = input.trim().split(":").map(Number);
  return h * 10000 + m * 100;
}
