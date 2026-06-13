import * as vscode from "vscode";
import { JobService } from "../jobService";
import {
  AgentJobHistoryRun,
  AgentJobSchedule,
  AgentJobStep,
  JobAlert,
  JobDetails,
  Operator,
} from "../types";
import {
  BASE_CSS,
  escapeHtml,
  formatDuration,
  getNonce,
  outcomeDot,
  OUTCOME_LABELS,
} from "./webviewShared";

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

const FLOW_LABELS: Record<number, string> = {
  1: "Quit reporting success",
  2: "Quit reporting failure",
  3: "Go to next step",
  4: "Go to step…",
};

/** Decodes the sysalerts.has_notification bitmask into a readable list. */
function describeNotify(mask: number): string {
  const parts: string[] = [];
  if (mask & 1) parts.push("E-mail");
  if (mask & 2) parts.push("Pager");
  if (mask & 4) parts.push("Net send");
  return parts.length ? parts.join(", ") : "—";
}

export class JobOptionsPanel {
  private static panels = new Map<string, JobOptionsPanel>();
  private panel: vscode.WebviewPanel;
  private details: JobDetails | undefined;
  private nextJob: { jobId: string; name: string } | undefined;

  static show(
    jobService: JobService,
    jobId: string,
    jobName: string,
    onChanged: () => void,
    onOpenDashboard: () => void,
    onOpenJob: (jobId: string, jobName: string) => void
  ): void {
    const existing = JobOptionsPanel.panels.get(jobId);
    if (existing) {
      existing.panel.reveal();
      existing.refresh();
      return;
    }
    JobOptionsPanel.panels.set(
      jobId,
      new JobOptionsPanel(jobService, jobId, jobName, onChanged, onOpenDashboard, onOpenJob)
    );
  }

  private constructor(
    private jobService: JobService,
    private jobId: string,
    jobName: string,
    private onChanged: () => void,
    private onOpenDashboard: () => void,
    private onOpenJob: (jobId: string, jobName: string) => void
  ) {
    this.panel = vscode.window.createWebviewPanel(
      "sqlAgentJobOptions",
      `Job · ${jobName}`,
      vscode.ViewColumn.One,
      { enableScripts: true }
    );
    this.panel.onDidDispose(() => {
      JobOptionsPanel.panels.delete(this.jobId);
    });
    this.panel.webview.onDidReceiveMessage((m) => this.handleMessage(m));
    this.refresh();
  }

  private async handleMessage(m: any): Promise<void> {
    try {
      switch (m.command) {
        case "refresh":
          await this.refresh();
          break;

        case "openDashboard":
          this.onOpenDashboard();
          break;

        case "openNextJob":
          if (this.nextJob) {
            this.onOpenJob(this.nextJob.jobId, this.nextJob.name);
          }
          break;

        case "saveJob": {
          const cur = this.details;
          const notifyLevelEmail = Number(m.notifyLevelEmail) || 0;
          const notifyEmailOperator = String(m.notifyEmailOperator ?? "");
          if (notifyLevelEmail > 0 && !notifyEmailOperator) {
            vscode.window.showErrorMessage(
              "Select an operator to e-mail, or turn off e-mail notification."
            );
            return;
          }
          await this.jobService.updateJobOptions(this.jobId, {
            enabled: !!m.enabled,
            description: String(m.description ?? ""),
            newName:
              cur && m.name && m.name !== cur.name ? String(m.name) : undefined,
            categoryName:
              cur && m.category && m.category !== cur.categoryName
                ? String(m.category)
                : undefined,
            ownerLoginName:
              cur && m.owner && m.owner !== cur.owner ? String(m.owner) : undefined,
            notifyLevelEmail,
            notifyEmailOperatorName:
              notifyLevelEmail > 0 ? notifyEmailOperator : undefined,
            notifyLevelEventlog: Number(m.notifyLevelEventlog) || 0,
          });
          vscode.window.showInformationMessage("Job updated.");
          this.done();
          break;
        }

        case "runJob":
          await this.jobService.startJob(this.jobId);
          vscode.window.showInformationMessage("Job started.");
          this.done();
          break;

        case "updateSchedule":
          await this.jobService.updateSchedule(Number(m.scheduleId), {
            name: String(m.name),
            enabled: !!m.enabled,
            freqType: Number(m.freqType),
            freqInterval: Number(m.freqInterval),
            freqSubdayType: Number(m.freqSubdayType),
            freqSubdayInterval: Number(m.freqSubdayInterval),
            freqRecurrenceFactor: Number(m.freqRecurrenceFactor),
            activeStartTime: Number(m.activeStartTime),
          });
          vscode.window.showInformationMessage("Schedule updated.");
          this.done();
          break;

        case "removeSchedule": {
          const confirm = await vscode.window.showWarningMessage(
            `Remove schedule "${m.scheduleName}" from this job?`,
            { modal: true },
            "Remove"
          );
          if (confirm !== "Remove") return;
          await this.jobService.removeSchedule(this.jobId, Number(m.scheduleId));
          this.done();
          break;
        }

        case "saveStep": {
          const cfg = {
            stepName: String(m.stepName),
            subsystem: String(m.subsystem),
            command: String(m.stepCommand ?? ""),
            databaseName: String(m.databaseName ?? "") || null,
            onSuccessAction: Number(m.onSuccessAction),
            onSuccessStepId: Number(m.onSuccessStepId) || 0,
            onFailAction: Number(m.onFailAction),
            onFailStepId: Number(m.onFailStepId) || 0,
            retryAttempts: Number(m.retryAttempts) || 0,
            retryInterval: Number(m.retryInterval) || 0,
          };
          if (m.stepId) {
            await this.jobService.updateStep(this.jobId, Number(m.stepId), cfg);
            vscode.window.showInformationMessage("Step updated.");
          } else {
            await this.jobService.addStep(this.jobId, cfg);
            vscode.window.showInformationMessage("Step added.");
          }
          this.done();
          break;
        }

        case "deleteStep": {
          const confirm = await vscode.window.showWarningMessage(
            `Delete step ${m.stepId} "${m.stepName}"?`,
            { modal: true },
            "Delete"
          );
          if (confirm !== "Delete") return;
          await this.jobService.deleteStep(this.jobId, Number(m.stepId));
          this.done();
          break;
        }
      }
    } catch (e: any) {
      vscode.window.showErrorMessage(`Action failed: ${e.message}`);
    }
  }

  private done(): void {
    this.onChanged();
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    try {
      const [details, schedules, steps, history, categories, jobs, operators, alerts] =
        await Promise.all([
          this.jobService.getJobDetails(this.jobId),
          this.jobService.getSchedules(this.jobId),
          this.jobService.getSteps(this.jobId),
          this.jobService.getHistory(this.jobId, 10),
          this.jobService.getCategories(),
          this.jobService.getJobs(),
          this.jobService.getOperators(),
          this.jobService.getJobAlerts(this.jobId),
        ]);
      this.details = details;
      const i = jobs.findIndex((j) => j.jobId === this.jobId);
      const next = jobs.length > 1 ? jobs[(i + 1) % jobs.length] : undefined;
      this.nextJob = next ? { jobId: next.jobId, name: next.name } : undefined;
      this.panel.title = `Job · ${details.name}`;
      this.panel.webview.html = this.render(
        details,
        schedules,
        steps,
        history,
        categories,
        operators,
        alerts
      );
    } catch (e: any) {
      this.panel.webview.html = `<!DOCTYPE html><html><body style="font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:20px">
        <p>Error loading job: ${escapeHtml(e.message)}</p></body></html>`;
    }
  }

  private render(
    d: JobDetails,
    schedules: AgentJobSchedule[],
    steps: AgentJobStep[],
    history: AgentJobHistoryRun[],
    categories: string[],
    operators: Operator[],
    alerts: JobAlert[]
  ): string {
    const nonce = getNonce();
    const dataJson = JSON.stringify({ schedules, steps }).replace(/</g, "\\u003c");

    const categoryOptions = categories
      .map(
        (c) =>
          `<option value="${escapeHtml(c)}" ${c === d.categoryName ? "selected" : ""}>${escapeHtml(c)}</option>`
      )
      .join("");

    const hasOperators = operators.length > 0;
    const operatorOptions = operators
      .map(
        (o) =>
          `<option value="${escapeHtml(o.name)}" ${o.name === d.notifyEmailOperator ? "selected" : ""}>${escapeHtml(o.name)}${o.emailAddress ? " (" + escapeHtml(o.emailAddress) + ")" : ""}</option>`
      )
      .join("");
    const levelOptions = (sel: number) =>
      [
        [2, "On failure"],
        [1, "On success"],
        [3, "On completion"],
      ]
        .map(
          ([v, label]) =>
            `<option value="${v}" ${v === sel ? "selected" : ""}>${label}</option>`
        )
        .join("");

    const alertRows = alerts
      .map(
        (a) => `
        <tr>
          <td><span class="dot ${a.enabled ? "dot-green" : "dot-grey"}"></span>${escapeHtml(a.name)}</td>
          <td>${escapeHtml(a.description)}</td>
          <td>${escapeHtml(describeNotify(a.hasNotification))}</td>
        </tr>`
      )
      .join("");

    const scheduleRows = schedules
      .map(
        (s) => `
        <tr>
          <td><span class="dot ${s.enabled ? "dot-green" : "dot-grey"}"></span>${escapeHtml(s.scheduleName)}</td>
          <td>${escapeHtml(s.frequencyDescription)}</td>
          <td>${s.nextRunDate ? s.nextRunDate.toLocaleString() : "—"}</td>
          <td class="actions">
            <button class="secondary edit-schedule" data-id="${s.scheduleId}">Edit</button>
            <button class="secondary remove-schedule" data-id="${s.scheduleId}" data-name="${escapeHtml(s.scheduleName)}">Remove</button>
          </td>
        </tr>`
      )
      .join("");

    const stepRows = steps
      .map(
        (s) => `
        <tr>
          <td>${s.stepId}</td>
          <td>${escapeHtml(s.stepName)}</td>
          <td>${escapeHtml(s.subsystem)}</td>
          <td>${escapeHtml(FLOW_LABELS[s.onSuccessAction] ?? "?")}${s.onSuccessAction === 4 ? " " + s.onSuccessStepId : ""}</td>
          <td>${outcomeDot(s.lastRunOutcome)}${OUTCOME_LABELS[s.lastRunOutcome] ?? "Unknown"}</td>
          <td class="actions">
            <button class="secondary edit-step" data-id="${s.stepId}">Edit</button>
            <button class="secondary delete-step" data-id="${s.stepId}" data-name="${escapeHtml(s.stepName)}">Delete</button>
          </td>
        </tr>`
      )
      .join("");

    const historyRows = history
      .map(
        (r) => `
        <tr>
          <td>${outcomeDot(r.outcome)}${OUTCOME_LABELS[r.outcome] ?? "Unknown"}</td>
          <td>${r.runDate ? r.runDate.toLocaleString() : ""}</td>
          <td>${formatDuration(r.durationSeconds)}</td>
          <td class="msg-cell" title="${escapeHtml(r.message)}">${escapeHtml(r.message)}</td>
        </tr>`
      )
      .join("");

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>${BASE_CSS}
    .hidden { display: none !important; }
    .editor {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 14px 18px;
      margin: 10px 0;
      background: var(--vscode-sideBar-background);
    }
    .editor h3 { margin: 0 0 10px 0; font-size: 1em; }
    h3.subhead { font-size: 1em; font-weight: 600; margin: 20px 0 4px 0; }
    .row { display: flex; gap: 16px; flex-wrap: wrap; align-items: flex-end; }
    .row .field { flex: 1; min-width: 140px; }
    .field input[type="number"] { width: 80px; }
    select {
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border, transparent);
      padding: 5px 8px;
      border-radius: 2px;
      font-size: 13px;
    }
    .days { display: flex; gap: 10px; flex-wrap: wrap; }
    .days label { font-weight: normal; }
    td.actions { white-space: nowrap; }
    textarea.code { font-family: var(--vscode-editor-font-family, monospace); }
    .form-note { color: var(--vscode-descriptionForeground); font-size: 12px; margin: 6px 0; }
    .back-link {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: none;
      border: none;
      padding: 0;
      margin: 0 0 10px 0;
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      font-size: 13px;
    }
    .back-link:hover { text-decoration: underline; background: none; }
    .page-nav { display: flex; justify-content: space-between; align-items: center; gap: 16px; }
  </style>
</head>
<body>
  <div class="page-nav">
    <button class="back-link" id="back-dashboard">← Dashboard</button>
    ${
      this.nextJob
        ? `<button class="back-link" id="next-job" title="${escapeHtml(this.nextJob.name)}">Next job: ${escapeHtml(truncate(this.nextJob.name, 30))} →</button>`
        : ""
    }
  </div>
  <h1>${escapeHtml(d.name)}</h1>
  <dl class="meta">
    <dt>Created</dt><dd>${d.dateCreated ? d.dateCreated.toLocaleString() : "—"}</dd>
    <dt>Modified</dt><dd>${d.dateModified ? d.dateModified.toLocaleString() : "—"}</dd>
    <dt>Last run</dt><dd>${d.lastRunDate ? d.lastRunDate.toLocaleString() : "Never"}</dd>
    <dt>Next run</dt><dd>${d.nextRunDate ? d.nextRunDate.toLocaleString() : "Not scheduled"}</dd>
  </dl>

  <h2>Options</h2>
  <div class="row">
    <div class="field">
      <label for="j-name">Name</label>
      <input type="text" id="j-name" value="${escapeHtml(d.name)}">
    </div>
    <div class="field">
      <label for="j-category">Category</label>
      <select id="j-category">${categoryOptions}</select>
    </div>
    <div class="field">
      <label for="j-owner">Owner</label>
      <input type="text" id="j-owner" value="${escapeHtml(d.owner)}">
    </div>
  </div>
  <div class="field checkbox-row">
    <input type="checkbox" id="j-enabled" ${d.enabled ? "checked" : ""}>
    <label for="j-enabled">Enabled</label>
  </div>
  <div class="field">
    <label for="j-description">Description</label>
    <textarea id="j-description" rows="3">${escapeHtml(d.description)}</textarea>
  </div>

  <h3 class="subhead">Notifications</h3>
  ${
    hasOperators
      ? ""
      : '<p class="form-note">No operators are defined on this server, so e-mail notification is unavailable. Create an operator (SSMS, or <code>sp_add_operator</code>) and Database Mail to enable it.</p>'
  }
  <div class="row">
    <div class="field checkbox-row" style="flex:0">
      <input type="checkbox" id="n-email" ${d.notifyLevelEmail > 0 ? "checked" : ""} ${hasOperators ? "" : "disabled"}>
      <label for="n-email">E-mail an operator</label>
    </div>
    <div class="field">
      <label for="n-email-op">Operator</label>
      <select id="n-email-op" ${hasOperators ? "" : "disabled"}>${operatorOptions}</select>
    </div>
    <div class="field">
      <label for="n-email-level">When</label>
      <select id="n-email-level">${levelOptions(d.notifyLevelEmail > 0 ? d.notifyLevelEmail : 2)}</select>
    </div>
  </div>
  <div class="row">
    <div class="field checkbox-row" style="flex:0">
      <input type="checkbox" id="n-eventlog" ${d.notifyLevelEventlog > 0 ? "checked" : ""}>
      <label for="n-eventlog">Write to Windows event log</label>
    </div>
    <div class="field">
      <label for="n-eventlog-level">When</label>
      <select id="n-eventlog-level">${levelOptions(d.notifyLevelEventlog > 0 ? d.notifyLevelEventlog : 2)}</select>
    </div>
  </div>

  <div class="toolbar">
    <button id="save-job">Save Changes</button>
    <button id="run" class="secondary">Run Job Now</button>
    <button id="refresh" class="secondary">Refresh</button>
  </div>

  <h2>Schedules</h2>
  ${
    schedules.length === 0
      ? '<p class="muted">No schedules. Right-click the job in the tree to add one.</p>'
      : `<table>
          <thead><tr><th>Name</th><th>Frequency</th><th>Next run</th><th></th></tr></thead>
          <tbody>${scheduleRows}</tbody>
        </table>`
  }

  <div id="schedule-editor" class="editor hidden">
    <h3>Edit schedule</h3>
    <p class="form-note" id="s-convert-note"></p>
    <div class="row">
      <div class="field"><label>Name</label><input type="text" id="s-name"></div>
      <div class="field checkbox-row" style="flex:0">
        <input type="checkbox" id="s-enabled"><label for="s-enabled">Enabled</label>
      </div>
    </div>
    <div class="row">
      <div class="field">
        <label>Recurrence</label>
        <select id="s-type">
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
        </select>
      </div>
      <div class="field" id="s-daily-fields">
        <label>Every N days</label><input type="number" id="s-daily-n" min="1" value="1">
      </div>
      <div class="field hidden" id="s-monthly-fields">
        <label>Day of month</label><input type="number" id="s-monthday" min="1" max="31" value="1">
      </div>
      <div class="field hidden" id="s-recur-fields">
        <label id="s-recur-label">Every N weeks</label><input type="number" id="s-recur-n" min="1" value="1">
      </div>
    </div>
    <div class="field hidden" id="s-weekly-fields">
      <label>Days</label>
      <div class="days">
        <label><input type="checkbox" class="s-day" value="2"> Mon</label>
        <label><input type="checkbox" class="s-day" value="4"> Tue</label>
        <label><input type="checkbox" class="s-day" value="8"> Wed</label>
        <label><input type="checkbox" class="s-day" value="16"> Thu</label>
        <label><input type="checkbox" class="s-day" value="32"> Fri</label>
        <label><input type="checkbox" class="s-day" value="64"> Sat</label>
        <label><input type="checkbox" class="s-day" value="1"> Sun</label>
      </div>
    </div>
    <div class="row">
      <div class="field">
        <label>Occurs</label>
        <select id="s-subday">
          <option value="1">Once at a time</option>
          <option value="4">Every N minutes</option>
          <option value="8">Every N hours</option>
        </select>
      </div>
      <div class="field" id="s-time-field">
        <label>Time (24h HH:MM)</label><input type="text" id="s-time" value="02:00" placeholder="02:00">
      </div>
      <div class="field hidden" id="s-subdayn-field">
        <label>N</label><input type="number" id="s-subday-n" min="1" value="1">
      </div>
    </div>
    <div class="toolbar">
      <button id="s-save">Save Schedule</button>
      <button id="s-cancel" class="secondary">Cancel</button>
    </div>
  </div>

  <h2>Steps <button id="add-step" class="secondary" style="margin-left:8px">Add Step</button></h2>
  ${
    steps.length === 0
      ? '<p class="muted">No steps.</p>'
      : `<table>
          <thead><tr><th>#</th><th>Name</th><th>Type</th><th>On success</th><th>Last outcome</th><th></th></tr></thead>
          <tbody>${stepRows}</tbody>
        </table>`
  }

  <div id="step-editor" class="editor hidden">
    <h3 id="st-title">Edit step</h3>
    <div class="row">
      <div class="field"><label>Name</label><input type="text" id="st-name"></div>
      <div class="field">
        <label>Type</label>
        <select id="st-subsystem">
          <option value="TSQL">Transact-SQL (T-SQL)</option>
          <option value="CmdExec">Operating system (CmdExec)</option>
          <option value="PowerShell">PowerShell</option>
        </select>
      </div>
      <div class="field" id="st-db-field">
        <label>Database</label><input type="text" id="st-database" placeholder="master">
      </div>
    </div>
    <div class="field">
      <label>Command</label>
      <textarea id="st-command" rows="8" class="code"></textarea>
    </div>
    <div class="row">
      <div class="field">
        <label>On success</label>
        <select id="st-onsuccess">
          <option value="1">Quit reporting success</option>
          <option value="2">Quit reporting failure</option>
          <option value="3">Go to next step</option>
          <option value="4">Go to step…</option>
        </select>
      </div>
      <div class="field hidden" id="st-onsuccess-step-field">
        <label>Step #</label><input type="number" id="st-onsuccess-step" min="1" value="1">
      </div>
      <div class="field">
        <label>On failure</label>
        <select id="st-onfail">
          <option value="2">Quit reporting failure</option>
          <option value="1">Quit reporting success</option>
          <option value="3">Go to next step</option>
          <option value="4">Go to step…</option>
        </select>
      </div>
      <div class="field hidden" id="st-onfail-step-field">
        <label>Step #</label><input type="number" id="st-onfail-step" min="1" value="1">
      </div>
    </div>
    <div class="row">
      <div class="field">
        <label>Retry attempts</label><input type="number" id="st-retry" min="0" value="0">
      </div>
      <div class="field">
        <label>Retry interval (minutes)</label><input type="number" id="st-retry-interval" min="0" value="0">
      </div>
    </div>
    <div class="toolbar">
      <button id="st-save">Save Step</button>
      <button id="st-cancel" class="secondary">Cancel</button>
    </div>
  </div>

  <h2>Alerts</h2>
  <p class="muted" style="margin-top:-4px">Alerts that run this job when they fire. Alerts are server-wide — manage them in SSMS.</p>
  ${
    alerts.length === 0
      ? '<p class="muted">No alerts run this job.</p>'
      : `<table>
          <thead><tr><th>Name</th><th>Trigger</th><th>Notifies operators by</th></tr></thead>
          <tbody>${alertRows}</tbody>
        </table>`
  }

  <h2>Recent History</h2>
  ${
    history.length === 0
      ? '<p class="muted">No history.</p>'
      : `<table>
          <thead><tr><th>Outcome</th><th>Started</th><th>Duration</th><th>Message</th></tr></thead>
          <tbody>${historyRows}</tbody>
        </table>`
  }

  <script type="application/json" id="data">${dataJson}</script>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const data = JSON.parse(document.getElementById("data").textContent);
    const $ = (id) => document.getElementById(id);
    const show = (id, visible) => $(id).classList.toggle("hidden", !visible);

    $("back-dashboard").addEventListener("click", () => {
      vscode.postMessage({ command: "openDashboard" });
    });
    const nextBtn = $("next-job");
    if (nextBtn) {
      nextBtn.addEventListener("click", () => {
        vscode.postMessage({ command: "openNextJob" });
      });
    }

    // ── Job options ──────────────────────────────────────────────────────────
    function syncNotify() {
      const emailOn = $("n-email").checked;
      $("n-email-op").disabled = !emailOn;
      $("n-email-level").disabled = !emailOn;
      $("n-eventlog-level").disabled = !$("n-eventlog").checked;
    }
    $("n-email").addEventListener("change", syncNotify);
    $("n-eventlog").addEventListener("change", syncNotify);
    syncNotify();

    $("save-job").addEventListener("click", () => {
      vscode.postMessage({
        command: "saveJob",
        name: $("j-name").value.trim(),
        enabled: $("j-enabled").checked,
        description: $("j-description").value,
        category: $("j-category").value,
        owner: $("j-owner").value.trim(),
        notifyLevelEmail: $("n-email").checked ? Number($("n-email-level").value) : 0,
        notifyEmailOperator: $("n-email-op").value,
        notifyLevelEventlog: $("n-eventlog").checked ? Number($("n-eventlog-level").value) : 0,
      });
    });
    $("run").addEventListener("click", () => vscode.postMessage({ command: "runJob" }));
    $("refresh").addEventListener("click", () => vscode.postMessage({ command: "refresh" }));

    // ── Schedule editor ──────────────────────────────────────────────────────
    let editingScheduleId = null;

    function timeToString(t) {
      const h = Math.floor(t / 10000), m = Math.floor((t % 10000) / 100);
      return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
    }

    function updateScheduleVisibility() {
      const type = $("s-type").value;
      show("s-daily-fields", type === "daily");
      show("s-weekly-fields", type === "weekly");
      show("s-monthly-fields", type === "monthly");
      show("s-recur-fields", type !== "daily");
      $("s-recur-label").textContent = type === "monthly" ? "Every N months" : "Every N weeks";
      const subday = $("s-subday").value;
      show("s-time-field", subday === "1");
      show("s-subdayn-field", subday !== "1");
    }
    $("s-type").addEventListener("change", updateScheduleVisibility);
    $("s-subday").addEventListener("change", updateScheduleVisibility);

    for (const btn of document.querySelectorAll(".edit-schedule")) {
      btn.addEventListener("click", () => {
        const s = data.schedules.find((x) => x.scheduleId === Number(btn.dataset.id));
        if (!s) return;
        editingScheduleId = s.scheduleId;
        $("s-name").value = s.scheduleName;
        $("s-enabled").checked = s.enabled;
        const supported = [4, 8, 16].includes(s.freqType);
        $("s-convert-note").textContent = supported ? "" :
          "This schedule type (" + s.frequencyDescription + ") can't be shown in the editor — saving converts it to the selected recurrence.";
        if (s.freqType === 8) {
          $("s-type").value = "weekly";
          for (const cb of document.querySelectorAll(".s-day")) {
            cb.checked = (s.freqInterval & Number(cb.value)) !== 0;
          }
          $("s-recur-n").value = Math.max(1, s.freqRecurrenceFactor);
        } else if (s.freqType === 16) {
          $("s-type").value = "monthly";
          $("s-monthday").value = s.freqInterval || 1;
          $("s-recur-n").value = Math.max(1, s.freqRecurrenceFactor);
        } else {
          $("s-type").value = "daily";
          $("s-daily-n").value = s.freqType === 4 ? Math.max(1, s.freqInterval) : 1;
        }
        if (s.freqSubdayType === 4 || s.freqSubdayType === 8) {
          $("s-subday").value = String(s.freqSubdayType);
          $("s-subday-n").value = Math.max(1, s.freqSubdayInterval);
        } else {
          $("s-subday").value = "1";
          $("s-time").value = timeToString(s.activeStartTime);
        }
        updateScheduleVisibility();
        show("schedule-editor", true);
        $("schedule-editor").scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    }

    $("s-cancel").addEventListener("click", () => show("schedule-editor", false));
    $("s-save").addEventListener("click", () => {
      const type = $("s-type").value;
      let freqType, freqInterval, recur = 0;
      if (type === "weekly") {
        freqType = 8;
        freqInterval = [...document.querySelectorAll(".s-day")]
          .filter((cb) => cb.checked)
          .reduce((m, cb) => m | Number(cb.value), 0);
        if (freqInterval === 0) return;
        recur = Math.max(1, Number($("s-recur-n").value) || 1);
      } else if (type === "monthly") {
        freqType = 16;
        freqInterval = Math.min(31, Math.max(1, Number($("s-monthday").value) || 1));
        recur = Math.max(1, Number($("s-recur-n").value) || 1);
      } else {
        freqType = 4;
        freqInterval = Math.max(1, Number($("s-daily-n").value) || 1);
      }
      const subdayType = Number($("s-subday").value);
      let subdayInterval = 0, startTime = 0;
      if (subdayType === 1) {
        const match = /^([01]?\\d|2[0-3]):([0-5]\\d)$/.exec($("s-time").value.trim());
        if (!match) return;
        startTime = Number(match[1]) * 10000 + Number(match[2]) * 100;
      } else {
        subdayInterval = Math.max(1, Number($("s-subday-n").value) || 1);
      }
      vscode.postMessage({
        command: "updateSchedule",
        scheduleId: editingScheduleId,
        name: $("s-name").value.trim() || "Schedule",
        enabled: $("s-enabled").checked,
        freqType, freqInterval,
        freqSubdayType: subdayType,
        freqSubdayInterval: subdayInterval,
        freqRecurrenceFactor: recur,
        activeStartTime: startTime,
      });
    });

    for (const btn of document.querySelectorAll(".remove-schedule")) {
      btn.addEventListener("click", () => {
        vscode.postMessage({
          command: "removeSchedule",
          scheduleId: btn.dataset.id,
          scheduleName: btn.dataset.name,
        });
      });
    }

    // ── Step editor ──────────────────────────────────────────────────────────
    let editingStepId = null;

    function updateStepVisibility() {
      show("st-db-field", $("st-subsystem").value === "TSQL");
      show("st-onsuccess-step-field", $("st-onsuccess").value === "4");
      show("st-onfail-step-field", $("st-onfail").value === "4");
    }
    $("st-subsystem").addEventListener("change", updateStepVisibility);
    $("st-onsuccess").addEventListener("change", updateStepVisibility);
    $("st-onfail").addEventListener("change", updateStepVisibility);

    function openStepEditor(step) {
      editingStepId = step ? step.stepId : null;
      $("st-title").textContent = step ? "Edit step " + step.stepId : "Add step";
      $("st-name").value = step ? step.stepName : "";
      $("st-subsystem").value = step && ["TSQL","CmdExec","PowerShell"].includes(step.subsystem) ? step.subsystem : "TSQL";
      $("st-database").value = step ? step.databaseName : "";
      $("st-command").value = step ? step.command : "";
      $("st-onsuccess").value = step ? String(step.onSuccessAction) : "1";
      $("st-onsuccess-step").value = step && step.onSuccessStepId ? step.onSuccessStepId : 1;
      $("st-onfail").value = step ? String(step.onFailAction) : "2";
      $("st-onfail-step").value = step && step.onFailStepId ? step.onFailStepId : 1;
      $("st-retry").value = step ? step.retryAttempts : 0;
      $("st-retry-interval").value = step ? step.retryInterval : 0;
      updateStepVisibility();
      show("step-editor", true);
      $("step-editor").scrollIntoView({ behavior: "smooth", block: "nearest" });
    }

    $("add-step").addEventListener("click", () => openStepEditor(null));
    for (const btn of document.querySelectorAll(".edit-step")) {
      btn.addEventListener("click", () => {
        const s = data.steps.find((x) => x.stepId === Number(btn.dataset.id));
        if (s) openStepEditor(s);
      });
    }
    for (const btn of document.querySelectorAll(".delete-step")) {
      btn.addEventListener("click", () => {
        vscode.postMessage({
          command: "deleteStep",
          stepId: btn.dataset.id,
          stepName: btn.dataset.name,
        });
      });
    }

    $("st-cancel").addEventListener("click", () => show("step-editor", false));
    $("st-save").addEventListener("click", () => {
      if (!$("st-name").value.trim()) return;
      vscode.postMessage({
        command: "saveStep",
        stepId: editingStepId,
        stepName: $("st-name").value.trim(),
        subsystem: $("st-subsystem").value,
        databaseName: $("st-database").value.trim(),
        stepCommand: $("st-command").value,
        onSuccessAction: $("st-onsuccess").value,
        onSuccessStepId: $("st-onsuccess-step").value,
        onFailAction: $("st-onfail").value,
        onFailStepId: $("st-onfail-step").value,
        retryAttempts: $("st-retry").value,
        retryInterval: $("st-retry-interval").value,
      });
    });
  </script>
</body>
</html>`;
  }
}
