export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function getNonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

export const OUTCOME_LABELS: Record<number, string> = {
  0: "Failed",
  1: "Succeeded",
  2: "Retry",
  3: "Cancelled",
  4: "In progress",
  5: "Unknown",
};

export const OUTCOME_CLASSES: Record<number, string> = {
  0: "dot-red",
  1: "dot-green",
  2: "dot-yellow",
  3: "dot-orange",
  4: "dot-blue",
  5: "dot-grey",
};

export function outcomeDot(outcome: number): string {
  const cls = OUTCOME_CLASSES[outcome] ?? "dot-grey";
  const label = OUTCOME_LABELS[outcome] ?? "Unknown";
  return `<span class="dot ${cls}" title="${label}"></span>`;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export const BASE_CSS = `
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 16px 24px;
    font-size: 13px;
  }
  h1 { font-size: 1.4em; font-weight: 600; margin: 0 0 4px 0; }
  h2 { font-size: 1.1em; font-weight: 600; margin: 24px 0 8px 0; }
  .muted { color: var(--vscode-descriptionForeground); }
  table { border-collapse: collapse; width: 100%; }
  th {
    text-align: left;
    padding: 6px 10px;
    border-bottom: 1px solid var(--vscode-panel-border);
    color: var(--vscode-descriptionForeground);
    font-weight: 600;
  }
  td { padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
  tr.clickable { cursor: pointer; }
  tr.clickable:hover { background: var(--vscode-list-hoverBackground); }
  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; }
  .dot-green  { background: var(--vscode-charts-green); }
  .dot-red    { background: var(--vscode-charts-red); }
  .dot-yellow { background: var(--vscode-charts-yellow); }
  .dot-orange { background: var(--vscode-charts-orange); }
  .dot-blue   { background: var(--vscode-charts-blue); }
  .dot-grey   { background: var(--vscode-descriptionForeground); }
  button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    padding: 6px 14px;
    border-radius: 2px;
    cursor: pointer;
    font-size: 13px;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  input[type="text"], textarea {
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    padding: 6px 8px;
    border-radius: 2px;
    width: 100%;
    box-sizing: border-box;
    font-family: var(--vscode-font-family);
    font-size: 13px;
  }
  .toolbar { display: flex; gap: 8px; align-items: center; margin: 12px 0 20px 0; }
  .msg-cell { max-width: 480px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .field { margin: 14px 0; }
  .field label { display: block; font-weight: 600; margin-bottom: 4px; }
  .checkbox-row { display: flex; align-items: center; gap: 8px; }
  .checkbox-row label { font-weight: 600; }
  .meta { display: grid; grid-template-columns: auto 1fr; gap: 4px 16px; margin: 8px 0; }
  .meta dt { color: var(--vscode-descriptionForeground); }
  .meta dd { margin: 0; }
  .badge {
    display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px;
    border: 1px solid var(--vscode-panel-border);
  }
`;
