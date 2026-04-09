import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import type { BranchTrack, Checkpoint, Delta, DeltaRecord, ProjectDigest, Report, ReportAnalysis, VibegpsConfig } from "../shared";
import { createId } from "../utils/ids";
import { readJson, writeJson } from "../utils/json";
import { nowIso } from "../utils/time";
import { getLatestReport, insertReport, listDeltasForBranch } from "./db";
import { recordRecentReport } from "./global-index";
import { analyzeReport, type AnalyzerContext, type ReportAggregate } from "./report-analyzer";
import type Database from "better-sqlite3";

export interface ReportWindow {
  fromCheckpointId: string;
  toCheckpointId: string;
  deltas: Delta[];
  aggregate: ReportAggregate;
}

interface FileAggregate {
  path: string;
  touches: number;
  lines: number;
  lastChangeType: string;
  patchRef?: string;
}

function loadDelta(record: DeltaRecord): Delta {
  return readJson<Delta>(record.dataRef);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function summarizeDelta(delta: Delta): string {
  if (delta.items.length === 0) {
    return "当前窗口没有文件级变更。";
  }

  return delta.items
    .slice(0, 3)
    .map((item) => `${item.path} (${item.summary ?? item.changeType})`)
    .join("，");
}

function collectWindowRecords(
  records: DeltaRecord[],
  startCheckpointId: string,
  currentCheckpointId: string
): DeltaRecord[] {
  if (startCheckpointId === currentCheckpointId) {
    return [];
  }

  const recordByToCheckpoint = new Map(records.map((record) => [record.toCheckpointId, record]));
  const chain: DeltaRecord[] = [];
  let cursor = currentCheckpointId;

  while (cursor !== startCheckpointId) {
    const record = recordByToCheckpoint.get(cursor);
    if (!record) {
      break;
    }

    chain.push(record);
    cursor = record.fromCheckpointId;
  }

  if (cursor !== startCheckpointId) {
    return [];
  }

  return chain.reverse();
}

function buildAggregate(deltas: Delta[]): ReportAggregate {
  const fileMap = new Map<string, FileAggregate>();
  let addedFiles = 0;
  let modifiedFiles = 0;
  let deletedFiles = 0;

  for (const delta of deltas) {
    addedFiles += delta.addedFiles.length;
    modifiedFiles += delta.modifiedFiles.length;
    deletedFiles += delta.deletedFiles.length;

    for (const item of delta.items) {
      const lines = (item.addedLines ?? 0) + (item.deletedLines ?? 0);
      const current = fileMap.get(item.path);
      if (current) {
        current.touches += 1;
        current.lines += lines;
        current.lastChangeType = item.changeType;
        current.patchRef = item.patchRef ?? current.patchRef;
      } else {
        fileMap.set(item.path, {
          path: item.path,
          touches: 1,
          lines,
          lastChangeType: item.changeType,
          patchRef: item.patchRef
        });
      }
    }
  }

  const topFiles = [...fileMap.values()]
    .sort((left, right) => {
      if (right.lines !== left.lines) {
        return right.lines - left.lines;
      }

      return right.touches - left.touches;
    })
    .slice(0, 8)
    .map((item) => ({
      path: item.path,
      touches: item.touches,
      lines: item.lines,
      lastChangeType: item.lastChangeType,
      patchRef: item.patchRef
    }));

  return {
    deltaCount: deltas.length,
    touchedFiles: fileMap.size,
    changedLines: deltas.reduce((sum, delta) => sum + delta.changedLines, 0),
    addedFiles,
    modifiedFiles,
    deletedFiles,
    topFiles,
    timeline: deltas.map((delta) => ({
      deltaId: delta.deltaId,
      createdAt: delta.createdAt,
      changedFiles: delta.changedFiles,
      changedLines: delta.changedLines,
      summary: summarizeDelta(delta),
      promptPreview: delta.promptPreview
    }))
  };
}

function findDesignContext(workspaceRoot: string): string | undefined {
  const candidates = ["README.md"];
  const docsDir = join(workspaceRoot, "docs");

  if (existsSync(docsDir)) {
    const docFiles = readdirSync(docsDir)
      .filter((file) => extname(file).toLowerCase() === ".md")
      .filter((file) => /design|concept|spec|readme/i.test(file))
      .slice(0, 2)
      .map((file) => join(docsDir, file));
    candidates.push(...docFiles.map((file) => relative(workspaceRoot, file).replaceAll("\\", "/")));
  }

  const snippets: string[] = [];
  for (const relativePath of candidates) {
    const absolutePath = join(workspaceRoot, relativePath);
    if (!existsSync(absolutePath)) {
      continue;
    }

    const content = readFileSync(absolutePath, "utf8").trim();
    if (content.length === 0) {
      continue;
    }

    snippets.push(`[${relativePath}]\n${content.slice(0, 1200)}`);
  }

  return snippets.length > 0 ? snippets.join("\n\n") : undefined;
}

function buildProjectContext(workspaceRoot: string): string | undefined {
  const snippets: string[] = [];
  const packageJsonPath = join(workspaceRoot, "package.json");
  const readmePath = join(workspaceRoot, "README.md");
  const digestPath = join(workspaceRoot, ".vibegps", "cache", "project-digest.json");

  if (existsSync(digestPath)) {
    try {
      const digest = readJson<ProjectDigest>(digestPath);
      snippets.push(
        [
          "[project-digest]",
          `summary: ${digest.summary}`,
          digest.designDocSummary ? `design: ${digest.designDocSummary}` : undefined,
          digest.modules.length > 0
            ? `modules: ${digest.modules.map((module) => `${module.name}(${module.paths.join(",")})`).join("; ")}`
            : undefined
        ]
          .filter((value): value is string => Boolean(value))
          .join("\n")
      );
    } catch {
      // Ignore invalid digest content and fall back to raw project files.
    }
  }

  if (existsSync(packageJsonPath)) {
    snippets.push(`[package.json]\n${readFileSync(packageJsonPath, "utf8").slice(0, 1200)}`);
  }
  if (existsSync(readmePath)) {
    snippets.push(`[README.md]\n${readFileSync(readmePath, "utf8").slice(0, 1200)}`);
  }

  return snippets.length > 0 ? snippets.join("\n\n") : undefined;
}

function findPatchExcerpt(deltaPatchesDir: string, patchRef: string | undefined, maxChars: number): string | undefined {
  if (!patchRef) {
    return undefined;
  }

  const patchPath = join(deltaPatchesDir, ...patchRef.split("/"));
  if (!existsSync(patchPath)) {
    return undefined;
  }

  return readFileSync(patchPath, "utf8").slice(0, maxChars);
}

function buildAnalyzerContext(
  input: {
    workspaceRoot: string;
    branchTrack: BranchTrack;
    currentCheckpoint: Checkpoint;
    config: VibegpsConfig;
    deltaPatchesDir: string;
    trigger: Report["trigger"];
  },
  window: ReportWindow
): AnalyzerContext {
  const candidates = window.aggregate.topFiles
    .map((file) => {
      const matchingItem = [...window.deltas]
        .reverse()
        .flatMap((delta) => delta.items)
        .find((item) => item.path === file.path);

      return {
        path: file.path,
        patchRef: matchingItem?.patchRef ?? file.patchRef,
        patchExcerpt: findPatchExcerpt(
          input.deltaPatchesDir,
          matchingItem?.patchRef ?? file.patchRef,
          input.config.report.maxPatchCharsPerFile
        ),
        lines: file.lines,
        changeType: matchingItem?.changeType ?? file.lastChangeType,
        summary: matchingItem?.summary
      };
    })
    .slice(0, input.config.report.maxContextFiles);

  return {
    workspaceRoot: input.workspaceRoot,
    gitBranch: input.branchTrack.gitBranch,
    fromCheckpointId: window.fromCheckpointId,
    toCheckpointId: input.currentCheckpoint.checkpointId,
    trigger: input.trigger,
    aggregate: window.aggregate,
    deltas: window.deltas,
    designContext: findDesignContext(input.workspaceRoot),
    projectContext: buildProjectContext(input.workspaceRoot),
    reviewCandidates: candidates
  };
}

function renderList(items: string[]): string {
  return items.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
}

function renderRiskList(analysis: ReportAnalysis): string {
  if (analysis.risks.length === 0) {
    return '<li class="risk risk-low"><div class="risk-title">未发现显著高风险</div><p>当前窗口内没有检测到明显需要立刻阻断的风险点，但仍建议按 review 顺序检查关键文件。</p></li>';
  }

  return analysis.risks
    .map(
      (risk) => `
        <li class="risk risk-${risk.severity}">
          <div class="risk-title">${escapeHtml(risk.title)}</div>
          <p>${escapeHtml(risk.detail)}</p>
        </li>`
    )
    .join("");
}

function renderReviewOrder(analysis: ReportAnalysis): string {
  if (analysis.reviewOrder.length === 0) {
    return "<li>当前窗口没有形成明确的 review 顺序。</li>";
  }

  return analysis.reviewOrder
    .map(
      (item) => `
        <li>
          <strong>${escapeHtml(item.path)}</strong>
          <span class="priority priority-${item.priority}">${item.priority.toUpperCase()}</span>
          <p>${escapeHtml(item.reason)}</p>
          ${item.patchRef ? `<code>${escapeHtml(item.patchRef)}</code>` : ""}
        </li>`
    )
    .join("");
}

function renderTimeline(window: ReportWindow): string {
  if (window.aggregate.timeline.length === 0) {
    return "<li>当前窗口没有累计到 delta。</li>";
  }

  return window.aggregate.timeline
    .map(
      (item) => `
        <li>
          <strong>${escapeHtml(item.deltaId)}</strong>
          <span>${escapeHtml(item.createdAt)}</span>
          <span>${item.changedFiles} files / ${item.changedLines} lines</span>
          <p>${escapeHtml(item.summary)}</p>
          ${item.promptPreview ? `<p class="prompt">Prompt: ${escapeHtml(item.promptPreview.slice(0, 140))}</p>` : ""}
        </li>`
    )
    .join("");
}

function renderTopFiles(window: ReportWindow): string {
  if (window.aggregate.topFiles.length === 0) {
    return '<div class="empty-state">当前窗口没有足够的文件级变化可展示。</div>';
  }

  return window.aggregate.topFiles
    .map(
      (file) => `
        <article class="file-card">
          <div class="file-card-header">
            <div>
              <p class="file-card-kicker">${escapeHtml(file.lastChangeType)}</p>
              <h3>${escapeHtml(basename(file.path))}</h3>
            </div>
            <span class="touch-pill">${file.touches}x</span>
          </div>
          <p class="file-card-path">${escapeHtml(file.path)}</p>
          <div class="file-card-metrics">
            <span>${file.lines} lines</span>
            <span>${file.touches} touches</span>
          </div>
          ${file.patchRef ? `<code>${escapeHtml(file.patchRef)}</code>` : ""}
        </article>`
    )
    .join("");
}

function renderPatchBlock(patch: string): string {
  const lines = patch.split(/\r?\n/);
  if (lines.at(-1) === "") {
    lines.pop();
  }

  return lines
    .map((line) => {
      let kind = "context";
      let marker = " ";
      let content = line;

      if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("\\")) {
        kind = "meta";
        marker = "•";
      } else if (line.startsWith("@@")) {
        kind = "hunk";
        marker = "@";
      } else if (line.startsWith("+")) {
        kind = "add";
        marker = "+";
        content = line.slice(1);
      } else if (line.startsWith("-")) {
        kind = "del";
        marker = "-";
        content = line.slice(1);
      } else if (line.startsWith(" ")) {
        content = line.slice(1);
      }

      return `
        <div class="patch-line patch-${kind}">
          <span class="patch-gutter">${escapeHtml(marker)}</span>
          <code>${escapeHtml(content)}</code>
        </div>`;
    })
    .join("");
}

function renderDiffVault(window: ReportWindow, deltaPatchesDir: string): string {
  const entries = window.deltas.flatMap((delta) =>
    delta.items.map((item) => ({
      deltaId: delta.deltaId,
      createdAt: delta.createdAt,
      path: item.path,
      summary: item.summary,
      changeType: item.changeType,
      patchRef: item.patchRef,
      addedLines: item.addedLines ?? 0,
      deletedLines: item.deletedLines ?? 0,
      patch: item.patchRef ? findPatchExcerpt(deltaPatchesDir, item.patchRef, Number.MAX_SAFE_INTEGER) : undefined
    }))
  );

  if (entries.length === 0) {
    return '<div class="empty-state">当前窗口没有可展开的 diff 内容。</div>';
  }

  return entries
    .map(
      (entry, index) => `
        <details class="diff-card"${index === 0 ? " open" : ""}>
          <summary>
            <div class="diff-summary-main">
              <span class="diff-badge diff-${entry.changeType}">${escapeHtml(entry.changeType)}</span>
              <strong>${escapeHtml(entry.path)}</strong>
              <p>${escapeHtml(entry.summary ?? "展开查看该文件在本窗口内记录到的 patch 内容。")}</p>
            </div>
            <div class="diff-summary-meta">
              <span>${escapeHtml(entry.deltaId)}</span>
              <span>+${entry.addedLines} / -${entry.deletedLines}</span>
            </div>
          </summary>
          <div class="diff-body">
            <div class="diff-meta-row">
              <span>${escapeHtml(entry.createdAt)}</span>
              ${entry.patchRef ? `<code>${escapeHtml(entry.patchRef)}</code>` : ""}
            </div>
            ${
              entry.patch
                ? `<div class="patch-view">${renderPatchBlock(entry.patch)}</div>`
                : '<p class="diff-missing">这个文件没有可用的文本 patch，可能是二进制文件或 patch 未落盘。</p>'
            }
          </div>
        </details>`
    )
    .join("");
}

function renderHtml(report: Report, window: ReportWindow, analysis: ReportAnalysis, deltaPatchesDir: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(report.reportId)} - VibeGPS</title>
  <style>
    :root {
      --canvas: #14171c;
      --canvas-2: #1a2028;
      --rail: rgba(19, 23, 30, 0.9);
      --paper: #f7f1e8;
      --paper-strong: #fffaf3;
      --line: rgba(37, 31, 26, 0.11);
      --ink: #1f1b18;
      --muted: #6b635b;
      --accent: #f18a3b;
      --accent-2: #6ab6a1;
      --accent-soft: rgba(241, 138, 59, 0.12);
      --good: #73e6a4;
      --good-ink: #1d7f57;
      --warn: #e7bc59;
      --danger: #ff8d8d;
      --danger-ink: #9f3128;
      --shadow: 0 26px 70px rgba(0, 0, 0, 0.24);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "IBM Plex Sans", "PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif;
      background:
        radial-gradient(circle at 14% 0%, rgba(241, 138, 59, 0.22), transparent 26%),
        radial-gradient(circle at 90% 12%, rgba(106, 182, 161, 0.18), transparent 22%),
        linear-gradient(180deg, var(--canvas), var(--canvas-2));
      color: var(--ink);
    }
    .page {
      max-width: 1480px;
      margin: 0 auto;
      padding: 22px 18px 56px;
    }
    .shell {
      display: grid;
      grid-template-columns: 280px minmax(0, 1fr);
      gap: 20px;
      align-items: start;
    }
    .rail {
      position: sticky;
      top: 18px;
      padding: 22px 18px;
      border-radius: 26px;
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.03), transparent 24%),
        var(--rail);
      border: 1px solid rgba(255, 255, 255, 0.07);
      box-shadow: 0 24px 70px rgba(0, 0, 0, 0.28);
      color: #f6f0e7;
      overflow: hidden;
    }
    .rail::after {
      content: "";
      position: absolute;
      inset: auto -20% -16% auto;
      width: 180px;
      height: 180px;
      border-radius: 50%;
      background: radial-gradient(circle, rgba(241, 138, 59, 0.14), transparent 70%);
      pointer-events: none;
    }
    .rail-label {
      margin: 0 0 10px;
      color: rgba(246, 240, 231, 0.62);
      font-size: 11px;
      letter-spacing: 0.16em;
      text-transform: uppercase;
    }
    .rail-title {
      margin: 0;
      font-family: "Iowan Old Style", "Noto Serif CJK SC", Georgia, serif;
      font-size: 30px;
      line-height: 0.95;
      letter-spacing: -0.03em;
    }
    .rail-copy {
      margin: 14px 0 18px;
      color: rgba(246, 240, 231, 0.78);
      line-height: 1.7;
      font-size: 14px;
    }
    .rail-meta {
      display: grid;
      gap: 10px;
      margin-bottom: 16px;
    }
    .rail-meta-item {
      padding: 12px 13px;
      border-radius: 16px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.06);
    }
    .rail-meta-item span {
      display: block;
      margin-bottom: 4px;
      color: rgba(246, 240, 231, 0.58);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .rail-nav {
      display: grid;
      gap: 8px;
      margin-top: 18px;
    }
    .rail-nav a {
      color: #f6f0e7;
      text-decoration: none;
      padding: 11px 13px;
      border-radius: 14px;
      border: 1px solid rgba(255, 255, 255, 0.05);
      background: rgba(255, 255, 255, 0.03);
      transition: background 160ms ease, transform 160ms ease, border-color 160ms ease;
    }
    .rail-nav a:hover {
      background: rgba(241, 138, 59, 0.12);
      border-color: rgba(241, 138, 59, 0.32);
      transform: translateX(2px);
    }
    .content {
      display: grid;
      gap: 20px;
    }
    .hero, .panel {
      background: var(--paper);
      border: 1px solid var(--line);
      border-radius: 28px;
      box-shadow: var(--shadow);
    }
    .hero {
      padding: 32px 32px 30px;
      position: relative;
      overflow: hidden;
    }
    .hero::before {
      content: "";
      position: absolute;
      inset: 0 auto auto 0;
      width: 100%;
      height: 6px;
      background: linear-gradient(90deg, var(--accent), var(--accent-2));
    }
    .hero::after {
      content: "";
      position: absolute;
      inset: auto -5% -34% auto;
      width: 280px;
      height: 280px;
      border-radius: 50%;
      background: radial-gradient(circle, rgba(106, 182, 161, 0.16), transparent 70%);
      pointer-events: none;
    }
    .eyebrow {
      color: var(--accent);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.22em;
      text-transform: uppercase;
    }
    h1 {
      margin: 10px 0 14px;
      font-family: "Iowan Old Style", "Noto Serif CJK SC", "Source Han Serif SC", Georgia, serif;
      font-size: clamp(40px, 6vw, 72px);
      line-height: 0.92;
      letter-spacing: -0.03em;
      max-width: 1020px;
    }
    .overview {
      color: var(--muted);
      font-size: 18px;
      line-height: 1.78;
      max-width: 860px;
    }
    .hero-grid {
      display: grid;
      grid-template-columns: minmax(0, 1.35fr) minmax(280px, 0.8fr);
      gap: 22px;
      position: relative;
      z-index: 1;
    }
    .hero-aside {
      display: grid;
      gap: 16px;
      align-content: start;
    }
    .hero-note {
      padding: 18px 18px 16px;
      border: 1px solid rgba(31, 27, 24, 0.08);
      border-radius: 20px;
      background: rgba(255, 255, 255, 0.68);
    }
    .hero-note h2 {
      margin: 0 0 8px;
      font-size: 13px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--accent-2);
    }
    .hero-note p {
      margin: 0;
      color: var(--muted);
    }
    .meta, .metrics {
      display: grid;
      gap: 14px;
    }
    .meta {
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      margin-top: 22px;
    }
    .metrics {
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      margin: 22px 0;
    }
    .meta-item, .metric {
      padding: 16px 18px 18px;
      border-radius: 18px;
      border: 1px solid rgba(31, 26, 21, 0.08);
      background: rgba(255, 255, 255, 0.74);
    }
    .meta-item span, .metric span {
      display: block;
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 8px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .metric strong {
      font-size: 34px;
      line-height: 1;
      font-family: "Iowan Old Style", "Noto Serif CJK SC", Georgia, serif;
    }
    .metric p {
      margin: 8px 0 0;
      color: var(--muted);
    }
    .grid {
      display: grid;
      grid-template-columns: 1.08fr 0.92fr;
      gap: 20px;
    }
    .stack {
      display: grid;
      gap: 20px;
    }
    .panel {
      padding: 24px 24px 26px;
    }
    h2 {
      margin: 0 0 14px;
      font-size: 26px;
      font-family: "Iowan Old Style", "Noto Serif CJK SC", Georgia, serif;
    }
    h3 {
      margin: 0 0 10px;
      font-size: 15px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    p {
      line-height: 1.7;
    }
    ul {
      margin: 0;
      padding-left: 20px;
    }
    .timeline, .review-list, .risk-list {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    .timeline li, .review-list li, .risk-list li {
      padding: 14px 0;
      border-bottom: 1px solid var(--line);
    }
    .timeline span, .review-list span {
      display: inline-block;
      margin-right: 10px;
      color: var(--muted);
      font-size: 12px;
    }
    .prompt {
      color: var(--muted);
      font-size: 13px;
    }
    .alignment {
      padding: 16px 18px;
      border-radius: 18px;
      background: linear-gradient(135deg, rgba(241, 138, 59, 0.12), rgba(106, 182, 161, 0.12));
      border: 1px solid rgba(241, 138, 59, 0.18);
    }
    .risk-title {
      font-weight: 700;
      margin-bottom: 6px;
    }
    .risk-high .risk-title { color: var(--danger-ink); }
    .risk-medium .risk-title { color: var(--warn); }
    .risk-low .risk-title { color: var(--good-ink); }
    .priority {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.06em;
    }
    .priority-high { background: rgba(165, 50, 34, 0.12); color: var(--danger-ink); }
    .priority-medium { background: rgba(183, 121, 31, 0.14); color: var(--warn); }
    .priority-low { background: rgba(29, 127, 87, 0.12); color: var(--good-ink); }
    code {
      display: inline-block;
      margin-top: 6px;
      padding: 4px 8px;
      border-radius: 10px;
      background: rgba(31, 26, 21, 0.06);
      font-size: 12px;
      word-break: break-all;
    }
    .files-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 14px;
    }
    .file-card {
      padding: 18px;
      border-radius: 22px;
      border: 1px solid rgba(34, 26, 20, 0.08);
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.88), rgba(248, 240, 232, 0.88)),
        linear-gradient(120deg, rgba(241, 138, 59, 0.05), transparent 40%);
    }
    .file-card-header {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: flex-start;
    }
    .file-card-kicker {
      margin: 0 0 6px;
      font-size: 11px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--accent);
    }
    .file-card h3 {
      margin: 0;
      color: var(--ink);
      text-transform: none;
      letter-spacing: 0;
      font-size: 18px;
      font-family: "Iowan Old Style", "Noto Serif CJK SC", Georgia, serif;
    }
    .file-card-path {
      margin: 10px 0 12px;
      color: var(--muted);
      word-break: break-word;
    }
    .file-card-metrics {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      color: var(--muted);
      font-size: 12px;
    }
    .touch-pill {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 42px;
      height: 42px;
      border-radius: 999px;
      background: rgba(106, 182, 161, 0.16);
      color: var(--accent-2);
      font-weight: 700;
    }
    .diff-vault {
      margin-top: 0;
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.96), rgba(246, 239, 231, 0.96)),
        linear-gradient(120deg, rgba(106, 182, 161, 0.08), transparent 46%);
    }
    .diff-list {
      display: grid;
      gap: 14px;
    }
    .diff-card {
      border: 1px solid rgba(34, 26, 20, 0.08);
      border-radius: 22px;
      background: #14181f;
      overflow: hidden;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
    }
    .diff-card summary {
      list-style: none;
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      padding: 18px 20px;
      cursor: pointer;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.03), transparent);
    }
    .diff-card summary::-webkit-details-marker {
      display: none;
    }
    .diff-summary-main strong {
      display: block;
      color: #f8efe1;
      font-size: 18px;
      font-family: "Iowan Old Style", "Noto Serif CJK SC", Georgia, serif;
    }
    .diff-summary-main p {
      margin: 8px 0 0;
      color: rgba(248, 239, 225, 0.68);
      font-size: 14px;
    }
    .diff-summary-meta {
      display: grid;
      gap: 6px;
      text-align: right;
      color: rgba(248, 239, 225, 0.6);
      font-size: 12px;
      white-space: nowrap;
    }
    .diff-badge {
      display: inline-flex;
      margin-bottom: 10px;
      padding: 4px 9px;
      border-radius: 999px;
      font-size: 11px;
      letter-spacing: 0.08em;
      font-weight: 700;
      text-transform: uppercase;
    }
    .diff-added { background: rgba(115, 230, 164, 0.14); color: var(--good); }
    .diff-modified, .diff-binary_modified { background: rgba(241, 138, 59, 0.16); color: #ffb77a; }
    .diff-deleted { background: rgba(255, 141, 141, 0.16); color: var(--danger); }
    .diff-body {
      padding: 0 20px 20px;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
    }
    .diff-meta-row {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      justify-content: space-between;
      align-items: center;
      padding: 14px 0;
      color: rgba(248, 239, 225, 0.6);
      font-size: 12px;
    }
    .patch-view {
      overflow: auto;
      border-radius: 18px;
      border: 1px solid rgba(255, 255, 255, 0.06);
      background: #101318;
    }
    .patch-line {
      display: grid;
      grid-template-columns: 34px minmax(0, 1fr);
      align-items: stretch;
      min-height: 24px;
      font-family: "IBM Plex Mono", "SFMono-Regular", Consolas, monospace;
      font-size: 12px;
      line-height: 1.6;
    }
    .patch-line + .patch-line {
      border-top: 1px solid rgba(255, 255, 255, 0.03);
    }
    .patch-gutter {
      display: flex;
      align-items: center;
      justify-content: center;
      color: rgba(248, 239, 225, 0.45);
      border-right: 1px solid rgba(255, 255, 255, 0.06);
      user-select: none;
    }
    .patch-line code {
      display: block;
      margin: 0;
      padding: 2px 12px;
      background: none;
      color: #e6ddd0;
      border-radius: 0;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .patch-meta {
      background: rgba(91, 161, 255, 0.08);
    }
    .patch-meta .patch-gutter,
    .patch-meta code {
      color: #82c0ff;
    }
    .patch-hunk {
      background: rgba(231, 188, 89, 0.08);
    }
    .patch-hunk .patch-gutter,
    .patch-hunk code {
      color: #ffd77c;
    }
    .patch-add {
      background: rgba(51, 103, 76, 0.32);
    }
    .patch-add .patch-gutter,
    .patch-add code {
      color: #d7ffe5;
    }
    .patch-del {
      background: rgba(123, 44, 44, 0.34);
    }
    .patch-del .patch-gutter,
    .patch-del code {
      color: #ffd8d8;
    }
    .patch-context {
      background: rgba(255, 255, 255, 0.01);
    }
    .diff-missing, .empty-state {
      margin: 0;
      padding: 16px 0 2px;
      color: var(--muted);
    }
    @media (max-width: 980px) {
      .shell,
      .hero-grid,
      .grid {
        grid-template-columns: 1fr;
      }
      .rail {
        position: static;
      }
      .diff-card summary {
        flex-direction: column;
      }
      .diff-summary-meta {
        text-align: left;
      }
    }
    @media (max-width: 720px) {
      .grid { grid-template-columns: 1fr; }
      .page { padding: 20px 14px 56px; }
      .hero, .panel { border-radius: 22px; }
      .hero, .panel { padding-left: 18px; padding-right: 18px; }
      .rail { border-radius: 22px; }
    }
  </style>
</head>
<body>
  <main class="page">
    <div class="shell">
      <aside class="rail">
        <p class="rail-label">VibeGPS Dossier</p>
        <h2 class="rail-title">Code Review Brief</h2>
        <p class="rail-copy">这份报告应该先帮你决定“哪里值得看”，再让你下钻到 patch 证据，而不是把你直接扔进生硬 diff。</p>
        <div class="rail-meta">
          <div class="rail-meta-item"><span>Branch</span>${escapeHtml(report.gitBranch)}</div>
          <div class="rail-meta-item"><span>Trigger</span>${escapeHtml(report.trigger)}</div>
          <div class="rail-meta-item"><span>Analyzer</span>${escapeHtml(analysis.analyzerRuntime)} / ${escapeHtml(analysis.confidence)}</div>
          <div class="rail-meta-item"><span>Window</span>${escapeHtml(report.fromCheckpointId)} -> ${escapeHtml(report.toCheckpointId)}</div>
        </div>
        <nav class="rail-nav">
          <a href="#overview">Overview</a>
          <a href="#intent">Intent</a>
          <a href="#risks">Risks</a>
          <a href="#review-order">Review Order</a>
          <a href="#top-files">Top Files</a>
          <a href="#timeline">Timeline</a>
          <a href="#diff-vault">Diff Vault</a>
        </nav>
      </aside>

      <div class="content">
        <section class="hero" id="overview">
          <div class="hero-grid">
            <div>
              <div class="eyebrow">VibeGPS Meaningful Report</div>
              <h1>${escapeHtml(analysis.headline)}</h1>
              <p class="overview">${escapeHtml(analysis.overview)}</p>
              <div class="meta">
                <div class="meta-item"><span>Delta Count</span>${window.aggregate.deltaCount}</div>
                <div class="meta-item"><span>Touched Files</span>${window.aggregate.touchedFiles}</div>
                <div class="meta-item"><span>Changed Lines</span>${window.aggregate.changedLines}</div>
                <div class="meta-item"><span>Added / Modified / Deleted</span>${window.aggregate.addedFiles}/${window.aggregate.modifiedFiles}/${window.aggregate.deletedFiles}</div>
              </div>
            </div>
            <aside class="hero-aside">
              <div class="hero-note">
                <h2>Why This Exists</h2>
                <p>你现在看到的不是单轮噪声，而是一段足以让人丢失上下文的累计演化窗口。</p>
              </div>
              <div class="hero-note">
                <h2>How To Read</h2>
                <p>先看风险和 review 顺序，再对照下面的 Git 风格 patch，效率会比直接盯 raw diff 高很多。</p>
              </div>
            </aside>
          </div>
        </section>

        <section class="metrics">
          <div class="metric"><span>Delta Count</span><strong>${window.aggregate.deltaCount}</strong><p>这是一次阶段性接管，不是单轮零散改动。</p></div>
          <div class="metric"><span>Touched Files</span><strong>${window.aggregate.touchedFiles}</strong><p>文件触达范围已经足够大，值得先恢复全局认知。</p></div>
          <div class="metric"><span>Changed Lines</span><strong>${window.aggregate.changedLines}</strong><p>累计行数说明仅靠记忆追踪已经不可靠。</p></div>
          <div class="metric"><span>Added / Modified / Deleted</span><strong>${window.aggregate.addedFiles}/${window.aggregate.modifiedFiles}/${window.aggregate.deletedFiles}</strong><p>快速判断这是扩展、修补还是替换型演化。</p></div>
        </section>

        <section class="grid">
          <div class="stack">
            <section class="panel" id="intent">
              <h2>阶段意图</h2>
              <p>${escapeHtml(analysis.intent)}</p>
            </section>

            <section class="panel">
              <h2>关键变化</h2>
              <ul>${renderList(analysis.keyChanges)}</ul>
            </section>

            <section class="panel" id="top-files">
              <h2>重点文件面板</h2>
              <div class="files-grid">${renderTopFiles(window)}</div>
            </section>

            <section class="panel">
              <h2>影响分析</h2>
              <ul>${renderList(analysis.impact)}</ul>
            </section>

            <section class="panel">
              <h2>设计对齐</h2>
              <div class="alignment">
                <h3>${escapeHtml(analysis.designAlignment.status)}</h3>
                <p>${escapeHtml(analysis.designAlignment.reason)}</p>
                ${analysis.designAlignment.evidence ? `<p>${escapeHtml(analysis.designAlignment.evidence)}</p>` : ""}
              </div>
            </section>
          </div>

          <div class="stack">
            <section class="panel" id="risks">
              <h2>风险提示</h2>
              <ul class="risk-list">${renderRiskList(analysis)}</ul>
            </section>

            <section class="panel" id="review-order">
              <h2>建议 Review 顺序</h2>
              <ul class="review-list">${renderReviewOrder(analysis)}</ul>
            </section>

            <section class="panel" id="timeline">
              <h2>Delta 时间线</h2>
              <ul class="timeline">${renderTimeline(window)}</ul>
            </section>

            <section class="panel">
              <h2>下一步建议</h2>
              <ul>${renderList(analysis.nextQuestions)}</ul>
            </section>
          </div>
        </section>

        <section class="panel diff-vault" id="diff-vault">
          <h2>Diff Vault</h2>
          <p class="overview">这里不再只是把 patch 原样塞进一个黑框，而是按 Git 的阅读习惯给出红 / 绿 / hunk / meta 分层，让你展开后可以直接核对证据。</p>
          <div class="diff-list">${renderDiffVault(window, deltaPatchesDir)}</div>
        </section>
      </div>
    </div>
  </main>
</body>
</html>`;
}

function renderMarkdown(report: Report, window: ReportWindow, analysis: ReportAnalysis): string {
  const riskLines =
    analysis.risks.length > 0
      ? analysis.risks.map((risk) => `- [${risk.severity}] ${risk.title}: ${risk.detail}`).join("\n")
      : "- 当前未发现明显需要立即阻断的高风险，但仍建议按 review 顺序检查关键文件。";

  const reviewLines =
    analysis.reviewOrder.length > 0
      ? analysis.reviewOrder
          .map((item) => `- [${item.priority}] ${item.path}: ${item.reason}${item.patchRef ? ` (${item.patchRef})` : ""}`)
          .join("\n")
      : "- 当前窗口没有形成明确的 review 顺序。";

  const timelineLines =
    window.aggregate.timeline.length > 0
      ? window.aggregate.timeline
          .map(
            (item) =>
              `- ${item.createdAt} | ${item.deltaId} | ${item.changedFiles} files / ${item.changedLines} lines | ${item.summary}`
          )
          .join("\n")
      : "- 当前窗口没有累计到 delta。";

  return [
    `# ${analysis.headline}`,
    "",
    analysis.overview,
    "",
    `- Branch: ${report.gitBranch}`,
    `- Window: ${report.fromCheckpointId} -> ${report.toCheckpointId}`,
    `- Trigger: ${report.trigger}`,
    `- Analyzer: ${analysis.analyzerRuntime}`,
    `- Confidence: ${analysis.confidence}`,
    "",
    "## 阶段意图",
    "",
    analysis.intent,
    "",
    "## 关键变化",
    "",
    ...analysis.keyChanges.map((item) => `- ${item}`),
    "",
    "## 影响分析",
    "",
    ...analysis.impact.map((item) => `- ${item}`),
    "",
    "## 设计对齐",
    "",
    `- Status: ${analysis.designAlignment.status}`,
    `- Reason: ${analysis.designAlignment.reason}`,
    ...(analysis.designAlignment.evidence ? [`- Evidence: ${analysis.designAlignment.evidence}`] : []),
    "",
    "## 风险提示",
    "",
    riskLines,
    "",
    "## 建议 Review 顺序",
    "",
    reviewLines,
    "",
    "## Delta 时间线",
    "",
    timelineLines,
    "",
    "## 下一步建议",
    "",
    ...analysis.nextQuestions.map((item) => `- ${item}`),
    ""
  ].join("\n");
}

export function resolveReportWindow(
  db: Database.Database,
  branchTrackId: string,
  initCheckpoint: Checkpoint,
  currentCheckpoint: Checkpoint
): ReportWindow {
  const latestReport = getLatestReport(db, branchTrackId);
  const startCheckpointId = latestReport?.toCheckpointId ?? initCheckpoint.checkpointId;
  const relevantRecords = collectWindowRecords(
    listDeltasForBranch(db, branchTrackId),
    startCheckpointId,
    currentCheckpoint.checkpointId
  );
  const deltas = relevantRecords.map(loadDelta);
  const fromCheckpointId = deltas[0]?.fromCheckpointId ?? startCheckpointId;

  return {
    fromCheckpointId,
    toCheckpointId: currentCheckpoint.checkpointId,
    deltas,
    aggregate: buildAggregate(deltas)
  };
}

export function shouldTriggerReport(config: VibegpsConfig, aggregate: Pick<ReportAggregate, "changedLines" | "touchedFiles" | "deltaCount">): boolean {
  if (!config.report.autoGenerate) {
    return false;
  }

  if (aggregate.deltaCount === 0) {
    return false;
  }

  return aggregate.touchedFiles >= config.thresholds.changedFiles || aggregate.changedLines >= config.thresholds.changedLines;
}

export function generateReport(
  db: Database.Database,
  input: {
    workspaceId: string;
    workspaceRoot: string;
    branchTrack: BranchTrack;
    currentCheckpoint: Checkpoint;
    initCheckpoint: Checkpoint;
    config: VibegpsConfig;
    reportsDir: string;
    deltaPatchesDir: string;
    trigger: Report["trigger"];
  }
): Report {
  const window = resolveReportWindow(db, input.branchTrack.branchTrackId, input.initCheckpoint, input.currentCheckpoint);
  const analysis = analyzeReport(
    buildAnalyzerContext(
      {
        workspaceRoot: input.workspaceRoot,
        branchTrack: input.branchTrack,
        currentCheckpoint: input.currentCheckpoint,
        config: input.config,
        deltaPatchesDir: input.deltaPatchesDir,
        trigger: input.trigger
      },
      window
    ),
    input.config
  );

  const reportId = createId("report");
  const reportDir = join(input.reportsDir, reportId);
  mkdirSync(reportDir, { recursive: true });

  const htmlPath = join(reportDir, "index.html");
  const mdPath = join(reportDir, "report.md");
  const reportPath = input.config.report.defaultFormat === "md" ? mdPath : htmlPath;

  const report: Report = {
    reportId,
    workspaceId: input.workspaceId,
    branchTrackId: input.branchTrack.branchTrackId,
    gitBranch: input.branchTrack.gitBranch,
    createdAt: nowIso(),
    fromCheckpointId: window.fromCheckpointId,
    toCheckpointId: input.currentCheckpoint.checkpointId,
    trigger: input.trigger,
    format: input.config.report.defaultFormat,
    summary: analysis.headline,
    path: reportPath
  };

  writeFileSync(htmlPath, renderHtml(report, window, analysis, input.deltaPatchesDir), "utf8");
  if (input.config.report.alsoEmitMarkdown || input.config.report.defaultFormat === "md") {
    writeFileSync(mdPath, renderMarkdown(report, window, analysis), "utf8");
  }

  writeJson(join(reportDir, "report.json"), {
    report,
    window,
    aggregate: window.aggregate,
    analysis,
    deltas: window.deltas
  });

  insertReport(db, report);
  recordRecentReport(input.workspaceRoot, input.workspaceId, report);
  return report;
}
