import * as vscode from "vscode";
import { JobService } from "../jobService";
import { AgentJob, DailyStat, JobScheduleExportRow, RecentRun } from "../types";
import {
  BASE_CSS,
  escapeHtml,
  formatDuration,
  getNonce,
  outcomeDot,
  OUTCOME_LABELS,
} from "./webviewShared";

export class DashboardPanel {
  private static current: DashboardPanel | undefined;
  private panel: vscode.WebviewPanel;
  private days = 14;

  static show(
    jobService: JobService,
    connectionLabel: string,
    openJob: (jobId: string, jobName: string) => void
  ): void {
    if (DashboardPanel.current) {
      DashboardPanel.current.connectionLabel = connectionLabel;
      DashboardPanel.current.panel.title = `SQL Agent · ${connectionLabel}`;
      DashboardPanel.current.panel.reveal();
      DashboardPanel.current.refresh();
      return;
    }
    DashboardPanel.current = new DashboardPanel(jobService, connectionLabel, openJob);
  }

  static refreshIfOpen(): void {
    DashboardPanel.current?.refresh();
  }

  private constructor(
    private jobService: JobService,
    private connectionLabel: string,
    private openJob: (jobId: string, jobName: string) => void
  ) {
    this.panel = vscode.window.createWebviewPanel(
      "sqlAgentDashboard",
      `SQL Agent · ${connectionLabel}`,
      vscode.ViewColumn.One,
      { enableScripts: true }
    );
    this.panel.onDidDispose(() => {
      DashboardPanel.current = undefined;
    });
    this.panel.webview.onDidReceiveMessage((m) => {
      if (m.command === "refresh") this.refresh();
      if (m.command === "openJob") this.openJob(m.jobId, m.jobName);
      if (m.command === "setDays") {
        this.days = Math.min(30, Math.max(1, Number(m.days) || 14));
        this.refresh();
      }
      if (m.command === "export") this.export();
    });
    this.refresh();
  }

  private async export(): Promise<void> {
    try {
      const format = await vscode.window.showQuickPick(
        [
          { label: "CSV", detail: "Comma-separated — opens in Excel", ext: "csv" },
          { label: "JSON", detail: "Machine-readable", ext: "json" },
          { label: "Markdown", detail: "Table for docs and wikis", ext: "md" },
        ],
        { placeHolder: "Export format" }
      );
      if (!format) return;

      const rows = await this.jobService.getJobScheduleExport();
      const date = new Date().toISOString().slice(0, 10);
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(`sql-agent-jobs-${date}.${format.ext}`),
        filters: { [format.label]: [format.ext] },
      });
      if (!uri) return;

      const content =
        format.ext === "csv"
          ? toCsv(rows)
          : format.ext === "json"
          ? toJson(rows)
          : toMarkdown(rows, this.connectionLabel);

      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
      const open = await vscode.window.showInformationMessage(
        `Exported ${rows.length} rows to ${uri.fsPath}`,
        "Open File"
      );
      if (open === "Open File") {
        await vscode.window.showTextDocument(uri);
      }
    } catch (e: any) {
      vscode.window.showErrorMessage(`Export failed: ${e.message}`);
    }
  }

  private async refresh(): Promise<void> {
    try {
      const [jobs, runs, stats] = await Promise.all([
        this.jobService.getJobs(),
        this.jobService.getRecentRuns(50, this.days),
        this.jobService.getDailyStats(this.days),
      ]);
      this.panel.webview.html = this.render(jobs, runs, stats);
    } catch (e: any) {
      this.panel.webview.html = this.render([], [], [], e.message);
    }
  }

  private render(
    jobs: AgentJob[],
    runs: RecentRun[],
    stats: DailyStat[],
    error?: string
  ): string {
    const nonce = getNonce();

    const enabled = jobs.filter((j) => j.enabled).length;
    const running = jobs.filter((j) => j.currentlyExecuting).length;
    const failedLast = jobs.filter((j) => j.enabled && j.lastRunOutcome === 0).length;

    const jobRows = jobs
      .map((j) => {
        const status = j.currentlyExecuting
          ? `${outcomeDot(4)}Running`
          : !j.enabled
          ? `${outcomeDot(5)}Disabled`
          : `${outcomeDot(j.lastRunOutcome)}${OUTCOME_LABELS[j.lastRunOutcome] ?? "Never run"}`;
        return `
        <tr class="clickable" data-jobid="${escapeHtml(j.jobId)}" data-jobname="${escapeHtml(j.name)}">
          <td>${status}</td>
          <td>${escapeHtml(j.name)}</td>
          <td>${j.lastRunDate ? j.lastRunDate.toLocaleString() : "—"}</td>
          <td>${j.nextRunDate ? j.nextRunDate.toLocaleString() : "—"}</td>
        </tr>`;
      })
      .join("");

    const runRows = runs
      .map(
        (r) => `
        <tr class="clickable" data-jobid="${escapeHtml(r.jobId)}" data-jobname="${escapeHtml(r.jobName)}">
          <td>${outcomeDot(r.outcome)}</td>
          <td>${escapeHtml(r.jobName)}</td>
          <td>${r.runDate ? r.runDate.toLocaleString() : ""}</td>
          <td>${formatDuration(r.durationSeconds)}</td>
        </tr>`
      )
      .join("");

    const body = error
      ? `<p class="muted">Error loading dashboard: ${escapeHtml(error)}</p>`
      : `
      <div class="chart-header">
        <h2>Runs — last <span id="days-label">${this.days}</span> day${this.days === 1 ? "" : "s"}</h2>
        <div class="slider-wrap">
          <span class="muted">1</span>
          <div class="slider-container">
            <input type="range" id="days-slider" min="1" max="30" value="${this.days}">
            <output id="days-bubble" for="days-slider">${this.days}</output>
          </div>
          <span class="muted">30</span>
        </div>
      </div>
      ${renderChart(stats)}

      <div class="columns">
        <section>
          <h2>Jobs (${jobs.length})</h2>
          ${
            jobs.length === 0
              ? '<p class="muted">No SQL Agent jobs found.</p>'
              : `<table>
                  <thead><tr><th>Status</th><th>Name</th><th>Last run</th><th>Next run</th></tr></thead>
                  <tbody>${jobRows}</tbody>
                </table>`
          }
        </section>
        <section>
          <h2>History — last ${this.days} day${this.days === 1 ? "" : "s"}</h2>
          ${
            runs.length === 0
              ? '<p class="muted">No job runs in this period.</p>'
              : `<table>
                  <thead><tr><th></th><th>Job</th><th>Started</th><th>Duration</th></tr></thead>
                  <tbody>${runRows}</tbody>
                </table>`
          }
        </section>
      </div>`;

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>${BASE_CSS}
    .columns {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 28px;
      align-items: start;
    }
    @media (max-width: 900px) { .columns { grid-template-columns: 1fr; } }
    .chart-wrap { margin: 4px 0 12px 0; }
    .chart-wrap svg { width: 100%; max-width: 900px; height: auto; }
    section h2 { margin-top: 8px; }
    .chart-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      max-width: 900px;
      flex-wrap: wrap;
    }
    .slider-wrap { display: flex; align-items: center; gap: 8px; padding-top: 22px; }
    .slider-container { position: relative; display: flex; align-items: center; }
    input[type="range"] {
      width: 220px;
      accent-color: var(--vscode-button-background);
    }
    #days-bubble {
      position: absolute;
      top: -22px;
      transform: translateX(-50%);
      background: var(--vscode-badge-background, var(--vscode-button-background));
      color: var(--vscode-badge-foreground, var(--vscode-button-foreground));
      font-size: 11px;
      font-weight: 600;
      line-height: 1;
      padding: 3px 7px;
      border-radius: 9px;
      pointer-events: none;
      white-space: nowrap;
    }
  </style>
</head>
<body>
  <h1>SQL Server Agent — ${escapeHtml(this.connectionLabel)}</h1>
  <div class="toolbar">
    <button id="refresh">Refresh</button>
    <button id="export" class="secondary">Export…</button>
    <span class="badge">${jobs.length} jobs</span>
    <span class="badge">${enabled} enabled</span>
    <span class="badge"><span class="dot dot-blue"></span>${running} running</span>
    <span class="badge"><span class="dot dot-red"></span>${failedLast} failing</span>
  </div>
  ${body}
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById("refresh").addEventListener("click", () => {
      vscode.postMessage({ command: "refresh" });
    });
    document.getElementById("export").addEventListener("click", () => {
      vscode.postMessage({ command: "export" });
    });
    const slider = document.getElementById("days-slider");
    if (slider) {
      const bubble = document.getElementById("days-bubble");
      const thumbW = 16; // approximate native thumb width
      const positionBubble = () => {
        const min = Number(slider.min), max = Number(slider.max);
        const pct = (Number(slider.value) - min) / (max - min);
        const x = pct * (slider.offsetWidth - thumbW) + thumbW / 2;
        bubble.style.left = x + "px";
        bubble.textContent = slider.value;
      };
      positionBubble();
      slider.addEventListener("input", () => {
        document.getElementById("days-label").textContent = slider.value;
        positionBubble();
      });
      slider.addEventListener("change", () => {
        vscode.postMessage({ command: "setDays", days: Number(slider.value) });
      });
    }
    for (const row of document.querySelectorAll("tr.clickable")) {
      row.addEventListener("click", () => {
        vscode.postMessage({
          command: "openJob",
          jobId: row.dataset.jobid,
          jobName: row.dataset.jobname,
        });
      });
    }
  </script>
</body>
</html>`;
  }
}

// ── Export serializers ──────────────────────────────────────────────────────────

function toCsv(rows: JobScheduleExportRow[]): string {
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const header = "Job,Job Enabled,Schedule,Schedule Enabled,Frequency,Next Run";
  const lines = rows.map((r) =>
    [
      esc(r.jobName),
      r.jobEnabled ? "Yes" : "No",
      esc(r.scheduleName || "No schedule"),
      r.scheduleEnabled === null ? "" : r.scheduleEnabled ? "Yes" : "No",
      esc(r.frequency),
      r.nextRun ? esc(r.nextRun.toLocaleString()) : "",
    ].join(",")
  );
  return [header, ...lines].join("\r\n") + "\r\n";
}

function toJson(rows: JobScheduleExportRow[]): string {
  return JSON.stringify(
    rows.map((r) => ({
      job: r.jobName,
      jobEnabled: r.jobEnabled,
      schedule: r.scheduleName || null,
      scheduleEnabled: r.scheduleEnabled,
      frequency: r.frequency || null,
      nextRun: r.nextRun ? r.nextRun.toISOString() : null,
    })),
    null,
    2
  );
}

function toMarkdown(rows: JobScheduleExportRow[], server: string): string {
  const esc = (v: string) => v.replace(/\|/g, "\\|");
  const lines = [
    `# SQL Agent Jobs — ${esc(server)}`,
    "",
    `Exported ${new Date().toLocaleString()}`,
    "",
    "| Job | Enabled | Schedule | Schedule enabled | Frequency | Next run |",
    "|---|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${esc(r.jobName)} | ${r.jobEnabled ? "✅" : "⛔"} | ${esc(r.scheduleName || "—")} | ${
          r.scheduleEnabled === null ? "—" : r.scheduleEnabled ? "✅" : "⛔"
        } | ${esc(r.frequency || "—")} | ${r.nextRun ? r.nextRun.toLocaleString() : "—"} |`
    ),
  ];
  return lines.join("\n") + "\n";
}

// ── Inline SVG stacked bar chart (green = succeeded, red = failed) ─────────────

function renderChart(stats: DailyStat[]): string {
  const max = Math.max(...stats.map((s) => s.succeeded + s.failed), 0);
  if (max === 0) {
    return '<p class="muted">No job runs in the last 14 days.</p>';
  }

  const W = 900;
  const H = 190;
  const padL = 30;
  const padR = 10;
  const padTop = 18;
  const padBottom = 28;
  const plotW = W - padL - padR;
  const plotH = H - padTop - padBottom;
  const step = plotW / stats.length;
  const barW = Math.min(44, step * 0.62);
  const scale = plotH / max;

  const labelEvery = stats.length > 20 ? 2 : 1;
  let bars = "";
  stats.forEach((s, i) => {
    const x = padL + i * step + (step - barW) / 2;
    const okH = s.succeeded * scale;
    const failH = s.failed * scale;
    const okY = padTop + plotH - okH;
    const failY = okY - failH;
    const total = s.succeeded + s.failed;
    const label = `${s.date.getDate()}.${s.date.getMonth() + 1}.`;
    const tooltip = `${s.date.toLocaleDateString()}: ${s.succeeded} succeeded, ${s.failed} failed`;

    bars += `
    <g>
      <title>${escapeHtml(tooltip)}</title>
      ${okH > 0 ? `<rect x="${x.toFixed(1)}" y="${okY.toFixed(1)}" width="${barW.toFixed(1)}" height="${okH.toFixed(1)}" rx="2" fill="var(--vscode-charts-green)" />` : ""}
      ${failH > 0 ? `<rect x="${x.toFixed(1)}" y="${failY.toFixed(1)}" width="${barW.toFixed(1)}" height="${failH.toFixed(1)}" rx="2" fill="var(--vscode-charts-red)" />` : ""}
      ${total > 0 ? `<text x="${(x + barW / 2).toFixed(1)}" y="${(failY - 4).toFixed(1)}" text-anchor="middle" font-size="10" fill="var(--vscode-descriptionForeground)">${total}</text>` : ""}
      ${i % labelEvery === 0 ? `<text x="${(x + barW / 2).toFixed(1)}" y="${H - 10}" text-anchor="middle" font-size="10" fill="var(--vscode-descriptionForeground)">${label}</text>` : ""}
    </g>`;
  });

  const baselineY = padTop + plotH;
  return `
  <div class="chart-wrap">
    <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Job runs per day">
      <line x1="${padL}" y1="${baselineY}" x2="${W - padR}" y2="${baselineY}"
            stroke="var(--vscode-panel-border)" stroke-width="1" />
      <text x="${padL - 6}" y="${padTop + 4}" text-anchor="end" font-size="10"
            fill="var(--vscode-descriptionForeground)">${max}</text>
      ${bars}
    </svg>
  </div>`;
}
