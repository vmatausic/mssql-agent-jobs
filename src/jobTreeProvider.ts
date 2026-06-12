import * as vscode from "vscode";
import { JobService } from "./jobService";
import {
  AgentJob,
  AgentJobHistoryRun,
  AgentJobSchedule,
  AgentJobStep,
} from "./types";

type TreeNode =
  | JobNode
  | OptionsNode
  | SectionNode
  | ScheduleNode
  | StepNode
  | HistoryNode
  | InfoNode;

export class JobTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private jobs: AgentJob[] = [];
  private connectionLabel = "";

  constructor(private jobService: JobService) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  setConnectionLabel(label: string): void {
    this.connectionLabel = label;
    this.refresh();
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (!element) {
      return this.getRootNodes();
    }
    if (element instanceof JobNode) {
      return [
        new OptionsNode(element.job),
        new SectionNode("Schedules", "schedules", element.job),
        new SectionNode("Steps", "steps", element.job),
        new SectionNode("History", "history", element.job),
      ];
    }
    if (element instanceof SectionNode) {
      return this.getSectionChildren(element);
    }
    return [];
  }

  private async getRootNodes(): Promise<TreeNode[]> {
    if (!this.connectionLabel) {
      return [new InfoNode("No connection — click the plug icon to connect")];
    }
    try {
      this.jobs = await this.jobService.getJobs();
    } catch (e: any) {
      return [new InfoNode(`Error: ${e.message}`)];
    }
    if (this.jobs.length === 0) {
      return [new InfoNode("No SQL Agent jobs found")];
    }
    return this.jobs.map((j) => new JobNode(j));
  }

  private async getSectionChildren(section: SectionNode): Promise<TreeNode[]> {
    try {
      switch (section.kind) {
        case "schedules": {
          const schedules = await this.jobService.getSchedules(section.job.jobId);
          if (schedules.length === 0) return [new InfoNode("No schedules")];
          return schedules.map((s) => new ScheduleNode(s, section.job));
        }
        case "steps": {
          const steps = await this.jobService.getSteps(section.job.jobId);
          if (steps.length === 0) return [new InfoNode("No steps")];
          return steps.map((s) => new StepNode(s));
        }
        case "history": {
          const runs = await this.jobService.getHistory(section.job.jobId);
          if (runs.length === 0) return [new InfoNode("No history")];
          return runs.map((r) => new HistoryNode(r));
        }
      }
    } catch (e: any) {
      return [new InfoNode(`Error: ${e.message}`)];
    }
  }
}

// ── Tree node classes ──────────────────────────────────────────────────────────

export class JobNode extends vscode.TreeItem {
  constructor(public job: AgentJob) {
    super(job.name, vscode.TreeItemCollapsibleState.Collapsed);

    this.tooltip = buildJobTooltip(job);
    this.description = buildJobDescription(job);
    this.iconPath = new vscode.ThemeIcon(jobIcon(job), jobIconColor(job));
    this.contextValue = job.currentlyExecuting
      ? "job-running"
      : job.enabled
      ? "job-enabled"
      : "job-disabled";
  }
}

export class OptionsNode extends vscode.TreeItem {
  constructor(public job: AgentJob) {
    super("Options", vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon("gear");
    this.contextValue = "options";
    this.command = {
      command: "sqlAgentJobs.openJobOptions",
      title: "Open Job Options",
      arguments: [this],
    };
  }
}

export class SectionNode extends vscode.TreeItem {
  constructor(
    label: string,
    public kind: "schedules" | "steps" | "history",
    public job: AgentJob
  ) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    const icons = { schedules: "calendar", steps: "list-ordered", history: "history" };
    this.iconPath = new vscode.ThemeIcon(icons[kind]);
    this.contextValue = `section-${kind}`;
  }
}

export class ScheduleNode extends vscode.TreeItem {
  constructor(public schedule: AgentJobSchedule, public job: AgentJob) {
    super(schedule.scheduleName, vscode.TreeItemCollapsibleState.None);
    this.description = schedule.enabled
      ? schedule.frequencyDescription
      : `${schedule.frequencyDescription} (disabled)`;
    this.iconPath = new vscode.ThemeIcon(
      "clock",
      schedule.enabled
        ? new vscode.ThemeColor("charts.green")
        : new vscode.ThemeColor("disabledForeground")
    );
    this.contextValue = schedule.enabled ? "schedule-enabled" : "schedule-disabled";
    if (schedule.nextRunDate) {
      this.tooltip = `Next run: ${schedule.nextRunDate.toLocaleString()}`;
    }
  }
}

export class StepNode extends vscode.TreeItem {
  constructor(step: AgentJobStep) {
    super(`${step.stepId}. ${step.stepName}`, vscode.TreeItemCollapsibleState.None);
    this.description = step.subsystem;
    this.iconPath = new vscode.ThemeIcon(
      outcomeIcon(step.lastRunOutcome),
      outcomeColor(step.lastRunOutcome)
    );
    if (step.lastRunDuration > 0) {
      this.tooltip = `Last duration: ${formatDuration(step.lastRunDuration)}`;
    }
  }
}

export class HistoryNode extends vscode.TreeItem {
  constructor(run: AgentJobHistoryRun) {
    super(
      run.runDate ? run.runDate.toLocaleString() : "(unknown date)",
      vscode.TreeItemCollapsibleState.None
    );
    const outcomes: Record<number, string> = {
      0: "Failed",
      1: "Succeeded",
      2: "Retry",
      3: "Cancelled",
      4: "In progress",
    };
    const outcome = outcomes[run.outcome] ?? "Unknown";
    this.description = `${outcome} · ${formatDuration(run.durationSeconds)}`;
    this.iconPath = new vscode.ThemeIcon(outcomeIcon(run.outcome), outcomeColor(run.outcome));
    if (run.message) {
      this.tooltip = new vscode.MarkdownString(run.message);
    }
  }
}

class InfoNode extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "info";
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function jobIcon(job: AgentJob): string {
  if (job.currentlyExecuting) return "sync~spin";
  if (!job.enabled) return "circle-slash";
  switch (job.lastRunOutcome) {
    case 0: return "error";
    case 1: return "pass";
    case 2: return "refresh";
    case 3: return "debug-stop";
    default: return "circle-outline";
  }
}

function jobIconColor(job: AgentJob): vscode.ThemeColor | undefined {
  if (!job.enabled) return new vscode.ThemeColor("disabledForeground");
  if (job.currentlyExecuting) return new vscode.ThemeColor("charts.blue");
  switch (job.lastRunOutcome) {
    case 0: return new vscode.ThemeColor("charts.red");
    case 1: return new vscode.ThemeColor("charts.green");
    case 2: return new vscode.ThemeColor("charts.yellow");
    case 3: return new vscode.ThemeColor("charts.orange");
    default: return undefined;
  }
}

function outcomeIcon(outcome: number): string {
  switch (outcome) {
    case 0: return "error";
    case 1: return "pass";
    case 2: return "refresh";
    case 3: return "debug-stop";
    case 4: return "sync~spin";
    default: return "circle-outline";
  }
}

function outcomeColor(outcome: number): vscode.ThemeColor | undefined {
  switch (outcome) {
    case 0: return new vscode.ThemeColor("charts.red");
    case 1: return new vscode.ThemeColor("charts.green");
    default: return undefined;
  }
}

function buildJobDescription(job: AgentJob): string {
  if (job.currentlyExecuting) return "Running…";
  if (!job.enabled) return "Disabled";
  const outcomes: Record<number, string> = {
    0: "Failed",
    1: "Succeeded",
    2: "Retry",
    3: "Cancelled",
    5: "Never run",
  };
  const status = outcomes[job.lastRunOutcome] ?? "Unknown";
  if (job.lastRunDate) {
    return `${status} · ${job.lastRunDate.toLocaleDateString()}`;
  }
  return status;
}

function buildJobTooltip(job: AgentJob): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${job.name}**\n\n`);
  if (job.description) md.appendMarkdown(`${job.description}\n\n`);
  md.appendMarkdown(`- Category: ${job.categoryName}\n`);
  md.appendMarkdown(`- Steps: ${job.stepCount}\n`);
  md.appendMarkdown(`- Enabled: ${job.enabled ? "Yes" : "No"}\n`);
  if (job.lastRunDate) md.appendMarkdown(`- Last run: ${job.lastRunDate.toLocaleString()}\n`);
  if (job.nextRunDate) md.appendMarkdown(`- Next run: ${job.nextRunDate.toLocaleString()}\n`);
  return md;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
