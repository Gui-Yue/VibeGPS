import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, extname, join } from "node:path";
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
    candidates.push(...docFiles.map((file) => file.replace(`${workspaceRoot}\\`, "")));
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

function renderHtml(report: Report, window: ReportWindow, analysis: ReportAnalysis): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(report.reportId)} - VibeGPS</title>
  <style>
    :root {
      --bg: #f7f1e6;
      --panel: rgba(255, 251, 245, 0.92);
      --line: rgba(31, 26, 21, 0.1);
      --ink: #1f1a15;
      --muted: #6f665c;
      --accent: #c4572d;
      --accent-soft: rgba(196, 87, 45, 0.12);
      --good: #1d7f57;
      --warn: #b7791f;
      --danger: #b42318;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      background:
        radial-gradient(circle at top left, rgba(196, 87, 45, 0.14), transparent 30%),
        linear-gradient(135deg, #fbf4e8, #f0e3d0 52%, #ead7bf);
    }
    .page {
      max-width: 1280px;
      margin: 0 auto;
      padding: 40px 24px 64px;
    }
    .hero, .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 24px;
      box-shadow: 0 18px 48px rgba(73, 48, 27, 0.08);
      backdrop-filter: blur(10px);
    }
    .hero {
      padding: 28px;
      margin-bottom: 24px;
    }
    .eyebrow {
      color: var(--accent);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.18em;
      text-transform: uppercase;
    }
    h1 {
      margin: 10px 0 12px;
      font-size: 38px;
      line-height: 1.1;
      max-width: 900px;
    }
    .overview {
      color: var(--muted);
      font-size: 16px;
      line-height: 1.75;
      max-width: 920px;
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
      margin: 24px 0;
    }
    .meta-item, .metric {
      padding: 16px 18px;
      border-radius: 18px;
      border: 1px solid rgba(31, 26, 21, 0.08);
      background: rgba(255, 255, 255, 0.55);
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
      font-size: 32px;
      line-height: 1;
    }
    .metric p {
      margin: 8px 0 0;
      color: var(--muted);
    }
    .grid {
      display: grid;
      grid-template-columns: 1.35fr 0.9fr;
      gap: 24px;
    }
    .stack {
      display: grid;
      gap: 24px;
    }
    .panel {
      padding: 24px;
    }
    h2 {
      margin: 0 0 14px;
      font-size: 22px;
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
      background: var(--accent-soft);
      border: 1px solid rgba(196, 87, 45, 0.18);
    }
    .risk-title {
      font-weight: 700;
      margin-bottom: 6px;
    }
    .risk-high .risk-title { color: var(--danger); }
    .risk-medium .risk-title { color: var(--warn); }
    .risk-low .risk-title { color: var(--good); }
    .priority {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.06em;
    }
    .priority-high { background: rgba(180, 35, 24, 0.12); color: var(--danger); }
    .priority-medium { background: rgba(183, 121, 31, 0.14); color: var(--warn); }
    .priority-low { background: rgba(29, 127, 87, 0.12); color: var(--good); }
    code {
      display: inline-block;
      margin-top: 6px;
      padding: 4px 8px;
      border-radius: 10px;
      background: rgba(31, 26, 21, 0.06);
      font-size: 12px;
      word-break: break-all;
    }
    @media (max-width: 980px) {
      .grid { grid-template-columns: 1fr; }
      h1 { font-size: 30px; }
    }
  </style>
</head>
<body>
  <main class="page">
    <section class="hero">
      <div class="eyebrow">VibeGPS Meaningful Report</div>
      <h1>${escapeHtml(analysis.headline)}</h1>
      <p class="overview">${escapeHtml(analysis.overview)}</p>
      <div class="meta">
        <div class="meta-item"><span>Branch</span>${escapeHtml(report.gitBranch)}</div>
        <div class="meta-item"><span>Window</span>${escapeHtml(report.fromCheckpointId)} -> ${escapeHtml(report.toCheckpointId)}</div>
        <div class="meta-item"><span>Trigger</span>${escapeHtml(report.trigger)}</div>
        <div class="meta-item"><span>Analyzer</span>${escapeHtml(analysis.analyzerRuntime)} / ${escapeHtml(analysis.confidence)}</div>
      </div>
    </section>

    <section class="metrics">
      <div class="metric"><span>Delta Count</span><strong>${window.aggregate.deltaCount}</strong><p>这是一次阶段性总结，不是单轮噪声。</p></div>
      <div class="metric"><span>Touched Files</span><strong>${window.aggregate.touchedFiles}</strong><p>用户已经很难只靠 diff 保持上下文。</p></div>
      <div class="metric"><span>Changed Lines</span><strong>${window.aggregate.changedLines}</strong><p>累计变更已达到值得恢复认知的规模。</p></div>
      <div class="metric"><span>Added / Modified / Deleted</span><strong>${window.aggregate.addedFiles}/${window.aggregate.modifiedFiles}/${window.aggregate.deletedFiles}</strong><p>帮助用户判断这次是追加、修补还是重构。</p></div>
    </section>

    <section class="grid">
      <div class="stack">
        <section class="panel">
          <h2>阶段意图</h2>
          <p>${escapeHtml(analysis.intent)}</p>
        </section>

        <section class="panel">
          <h2>关键变化</h2>
          <ul>${renderList(analysis.keyChanges)}</ul>
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
        <section class="panel">
          <h2>风险提示</h2>
          <ul class="risk-list">${renderRiskList(analysis)}</ul>
        </section>

        <section class="panel">
          <h2>建议 Review 顺序</h2>
          <ul class="review-list">${renderReviewOrder(analysis)}</ul>
        </section>

        <section class="panel">
          <h2>Delta 时间线</h2>
          <ul class="timeline">${renderTimeline(window)}</ul>
        </section>

        <section class="panel">
          <h2>下一步建议</h2>
          <ul>${renderList(analysis.nextQuestions)}</ul>
        </section>
      </div>
    </section>
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

  writeFileSync(htmlPath, renderHtml(report, window, analysis), "utf8");
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
