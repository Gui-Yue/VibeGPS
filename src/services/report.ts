import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import type { BranchTrack, Checkpoint, Delta, DeltaRecord, ProjectDigest, Report, ReportAnalysis, VibegpsConfig } from "../shared";
import { createId } from "../utils/ids";
import { readJson, writeJson } from "../utils/json";
import { nowIso } from "../utils/time";
import { getLatestReport, insertReport, listDeltasForBranch } from "./db";
import { recordRecentReport } from "./global-index";
import { analyzeReport, generateVisualReportHtml, type AnalyzerContext, type ReportAggregate } from "./report-analyzer";
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

function buildFallbackVisualHtml(report: Report, window: ReportWindow, analysis: ReportAnalysis, _deltaPatchesDir: string): string {
  const agg = window.aggregate;

  const topFileCards = agg.topFiles.slice(0, 8).map((f) => {
    const isHot = f.lines > 40;
    const borderColor = isHot ? "rgba(241,138,59,0.5)" : "rgba(106,182,161,0.35)";
    return `<div class="file-card" style="border-color:${borderColor}">
      <div class="file-card-type">${escapeHtml(f.lastChangeType)}</div>
      <h4>${escapeHtml(basename(f.path))}</h4>
      <p class="file-card-path">${escapeHtml(f.path)}</p>
      <div class="file-card-stats"><span>${f.lines} lines</span><span>${f.touches}x touched</span></div>
    </div>`;
  }).join("");

  const riskCards = analysis.risks.slice(0, 4).map((r) => {
    const color = r.severity === "high" ? "#ff8d8d" : r.severity === "medium" ? "#e7bc59" : "#73e6a4";
    return `<div class="risk-card" style="border-left-color:${color}">
      <div class="risk-badge" style="background:${color}">${escapeHtml(r.severity)}</div>
      <h4>${escapeHtml(r.title)}</h4>
      <p>${escapeHtml(r.detail)}</p>
    </div>`;
  }).join("");

  const reviewItems = analysis.reviewOrder.slice(0, 6).map((item, i) => {
    const color = item.priority === "high" ? "#ff8d8d" : item.priority === "medium" ? "#e7bc59" : "#73e6a4";
    return `<div class="review-item">
      <div class="review-rank" style="color:${color}">${i + 1}</div>
      <div><strong>${escapeHtml(basename(item.path))}</strong><p>${escapeHtml(item.reason)}</p></div>
    </div>`;
  }).join("");

  const moduleNodes = agg.topFiles.slice(0, 6).map((f, i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const x = 60 + col * 280;
    const y = 40 + row * 130;
    const isHot = f.lines > 40;
    const fill = isHot ? "rgba(241,138,59,0.15)" : "rgba(106,182,161,0.1)";
    const stroke = isHot ? "rgba(241,138,59,0.45)" : "rgba(106,182,161,0.35)";
    return `<rect x="${x}" y="${y}" width="240" height="90" rx="16" fill="${fill}" stroke="${stroke}" stroke-width="2"/>
      <text x="${x + 18}" y="${y + 30}" font-size="14" font-weight="700" fill="#f6f0e7">${escapeHtml(basename(f.path))}</text>
      <text x="${x + 18}" y="${y + 52}" font-size="11" fill="rgba(246,240,231,0.55)">${escapeHtml(f.lastChangeType)} | ${f.lines} lines</text>
      <text x="${x + 18}" y="${y + 72}" font-size="10" fill="rgba(246,240,231,0.4)">${escapeHtml(f.path.split("/").slice(0, -1).join("/"))}</text>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>${escapeHtml(report.reportId)} - VibeGPS</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{font-family:"IBM Plex Sans","PingFang SC","Noto Sans CJK SC",sans-serif;background:#0f1218;color:#f6f0e7;line-height:1.6}
.nav{position:fixed;top:0;left:0;right:0;z-index:100;backdrop-filter:blur(16px);background:rgba(15,18,24,0.85);border-bottom:1px solid rgba(255,255,255,0.06);padding:0 24px;display:flex;align-items:center;gap:20px;height:52px}
.nav-brand{font-size:13px;font-weight:700;letter-spacing:.12em;color:rgba(241,138,59,.85);text-transform:uppercase;white-space:nowrap}
.nav a{color:rgba(246,240,231,.55);text-decoration:none;font-size:13px;padding:6px 12px;border-radius:8px;transition:color .2s,background .2s}
.nav a:hover{color:#f6f0e7;background:rgba(255,255,255,.06)}
.section{max-width:1200px;margin:0 auto;padding:100px 32px 60px}
.section+.section{padding-top:60px}
.hero-section{padding-top:120px;text-align:center}
.hero-graphic{width:180px;height:180px;margin:0 auto 32px;animation:pulse 4s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:.8;transform:scale(1)}50%{opacity:1;transform:scale(1.05)}}
h1{font-family:"Iowan Old Style","Noto Serif CJK SC",Georgia,serif;font-size:clamp(40px,5.5vw,72px);line-height:1;letter-spacing:-.03em;margin-bottom:18px}
h2{font-family:"Iowan Old Style","Noto Serif CJK SC",Georgia,serif;font-size:clamp(28px,3.5vw,48px);line-height:1.1;margin-bottom:20px}
h3{font-size:20px;margin-bottom:12px;font-family:"Iowan Old Style","Noto Serif CJK SC",Georgia,serif}
.kicker{font-size:12px;letter-spacing:.2em;text-transform:uppercase;color:rgba(241,138,59,.8);margin-bottom:14px;font-weight:700}
.subtitle{color:rgba(246,240,231,.5);font-size:16px;margin-bottom:16px}
.overview{color:rgba(246,240,231,.7);font-size:18px;line-height:1.75;max-width:740px;margin:0 auto 36px}
.stats-row{display:flex;justify-content:center;gap:40px;flex-wrap:wrap;margin-top:32px}
.stat{text-align:center;padding:20px 24px;border-radius:20px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06)}
.stat strong{display:block;font-size:36px;font-family:"Iowan Old Style",Georgia,serif;color:#f18a3b;line-height:1.1}
.stat span{font-size:12px;color:rgba(246,240,231,.45);text-transform:uppercase;letter-spacing:.12em}
.svg-board{margin:28px 0;border-radius:22px;border:1px solid rgba(255,255,255,.06);background:linear-gradient(180deg,rgba(255,255,255,.025),rgba(255,255,255,.01));padding:24px;overflow-x:auto}
.svg-board svg{width:100%;display:block}
.two-col{display:grid;grid-template-columns:1.3fr 1fr;gap:40px;align-items:start;margin-top:24px}
.narrative-text{color:rgba(246,240,231,.72);font-size:17px;line-height:1.8}
.narrative-text p{margin-bottom:16px}
.change-item{padding:12px 16px;border-left:3px solid rgba(241,138,59,.35);margin-bottom:12px;background:rgba(255,255,255,.02);border-radius:0 12px 12px 0}
.file-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px;margin-top:24px}
.file-card{padding:18px;border-radius:18px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);transition:transform .2s,border-color .2s}
.file-card:hover{transform:translateY(-2px)}
.file-card-type{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:rgba(241,138,59,.7);margin-bottom:6px}
.file-card h4{font-size:16px;margin-bottom:4px;font-family:"Iowan Old Style","Noto Serif CJK SC",Georgia,serif}
.file-card-path{font-size:12px;color:rgba(246,240,231,.4);word-break:break-all;margin-bottom:10px}
.file-card-stats{display:flex;gap:16px;font-size:12px;color:rgba(246,240,231,.5)}
.risk-stack{display:grid;gap:14px;margin-top:24px}
.risk-card{padding:18px 20px;border-radius:16px;background:rgba(255,255,255,.025);border-left:4px solid}
.risk-card h4{font-size:16px;margin-bottom:6px}
.risk-card p{font-size:14px;color:rgba(246,240,231,.6);line-height:1.6}
.risk-badge{display:inline-block;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:700;color:#0f1218;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px}
.review-list{display:grid;gap:12px;margin-top:24px}
.review-item{display:grid;grid-template-columns:48px 1fr;gap:14px;align-items:center;padding:14px 16px;border-radius:14px;background:rgba(255,255,255,.02)}
.review-rank{font-size:28px;font-weight:800;font-family:"Iowan Old Style",Georgia,serif;text-align:center}
.review-item strong{display:block;font-size:15px;margin-bottom:4px}
.review-item p{font-size:13px;color:rgba(246,240,231,.55);margin:0;line-height:1.5}
.alignment-box{margin-top:28px;padding:18px 22px;border-radius:18px;background:linear-gradient(135deg,rgba(241,138,59,.08),rgba(106,182,161,.06));border:1px solid rgba(241,138,59,.15)}
.alignment-box strong{color:#f18a3b;text-transform:uppercase;font-size:13px;letter-spacing:.06em}
.alignment-box p{color:rgba(246,240,231,.65);margin-top:8px;font-size:14px;line-height:1.6}
.divider{height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,.08),transparent);margin:0 auto;max-width:600px}
@media(max-width:768px){.two-col{grid-template-columns:1fr}.stats-row{gap:16px}.section{padding-left:18px;padding-right:18px}.nav{gap:10px;overflow-x:auto}}
</style>
</head>
<body>
<nav class="nav">
  <span class="nav-brand">VibeGPS</span>
  <a href="#hero">Overview</a>
  <a href="#arch">Architecture</a>
  <a href="#intent">Intent</a>
  <a href="#files">Files</a>
  <a href="#risks">Risks</a>
  <a href="#review">Review</a>
</nav>

<div class="section hero-section" id="hero">
  <svg class="hero-graphic" viewBox="0 0 200 200">
    <circle cx="100" cy="100" r="85" fill="none" stroke="rgba(241,138,59,0.2)" stroke-width="3" stroke-dasharray="12 8"/>
    <circle cx="100" cy="100" r="55" fill="none" stroke="rgba(106,182,161,0.3)" stroke-width="2.5"/>
    <circle cx="100" cy="100" r="25" fill="rgba(241,138,59,0.15)" stroke="rgba(241,138,59,0.4)" stroke-width="2"/>
    <circle cx="100" cy="40" r="8" fill="rgba(106,182,161,0.5)"/>
    <circle cx="160" cy="100" r="8" fill="rgba(241,138,59,0.5)"/>
    <circle cx="100" cy="160" r="8" fill="rgba(106,182,161,0.5)"/>
    <circle cx="40" cy="100" r="8" fill="rgba(241,138,59,0.5)"/>
  </svg>
  <h1>${escapeHtml(analysis.headline)}</h1>
  <p class="subtitle">${escapeHtml(report.gitBranch)} &middot; ${escapeHtml(report.fromCheckpointId)} &rarr; ${escapeHtml(report.toCheckpointId)} &middot; ${escapeHtml(report.trigger)}</p>
  <p class="overview">${escapeHtml(analysis.overview)}</p>
  <div class="stats-row">
    <div class="stat"><strong>${agg.deltaCount}</strong><span>Delta</span></div>
    <div class="stat"><strong>${agg.touchedFiles}</strong><span>Files</span></div>
    <div class="stat"><strong>${agg.changedLines}</strong><span>Lines</span></div>
    <div class="stat"><strong>${agg.addedFiles} / ${agg.modifiedFiles} / ${agg.deletedFiles}</strong><span>Added / Modified / Deleted</span></div>
  </div>
</div>

<div class="divider"></div>

<div class="section" id="arch">
  <p class="kicker">Architecture Overview</p>
  <h2>${escapeHtml(analysis.intent.slice(0, 80))}</h2>
  <div class="svg-board">
    <svg viewBox="0 0 900 ${Math.max(Math.ceil(agg.topFiles.length / 3) * 130 + 60, 200)}">
      ${moduleNodes || '<text x="450" y="100" text-anchor="middle" fill="rgba(246,240,231,0.4)" font-size="16">No module data available</text>'}
    </svg>
  </div>
</div>

<div class="divider"></div>

<div class="section" id="intent">
  <p class="kicker">Design Intent</p>
  <h2>${escapeHtml(analysis.keyChanges[0] || "Change Analysis")}</h2>
  <div class="two-col">
    <div class="narrative-text">
      <p>${escapeHtml(analysis.intent)}</p>
      ${analysis.keyChanges.slice(1).map((c) => `<div class="change-item">${escapeHtml(c)}</div>`).join("")}
    </div>
    <div>
      <svg viewBox="0 0 300 300">
        ${analysis.impact.slice(0, 5).map((_, i) => {
          const angle = (i / Math.max(analysis.impact.length, 1)) * Math.PI * 2 - Math.PI / 2;
          const cx = 150 + Math.cos(angle) * 105;
          const cy = 150 + Math.sin(angle) * 105;
          return `<line x1="150" y1="150" x2="${Math.round(cx)}" y2="${Math.round(cy)}" stroke="rgba(241,138,59,0.25)" stroke-width="2"/>
            <circle cx="${Math.round(cx)}" cy="${Math.round(cy)}" r="22" fill="rgba(106,182,161,0.12)" stroke="rgba(106,182,161,0.35)" stroke-width="1.5"/>`;
        }).join("")}
        <circle cx="150" cy="150" r="28" fill="rgba(241,138,59,0.12)" stroke="rgba(241,138,59,0.35)" stroke-width="2"/>
      </svg>
      ${analysis.impact.map((imp) => `<p style="font-size:13px;color:rgba(246,240,231,0.55);margin-top:8px">${escapeHtml(imp)}</p>`).join("")}
    </div>
  </div>
</div>

<div class="divider"></div>

<div class="section" id="files">
  <p class="kicker">Key Files</p>
  <h2>Construction Details</h2>
  <div class="file-grid">${topFileCards || '<p style="color:rgba(246,240,231,0.4)">No significant file changes in this window.</p>'}</div>
</div>

<div class="divider"></div>

<div class="section" id="risks">
  <p class="kicker">Quality Inspection</p>
  <h2>${analysis.risks.length > 0 ? "Risk Assessment" : "No Significant Risks"}</h2>
  <div class="risk-stack">${riskCards || '<p style="color:rgba(246,240,231,0.45)">No significant risks detected in this window.</p>'}</div>
</div>

<div class="divider"></div>

<div class="section" id="review">
  <p class="kicker">Review Priority</p>
  <h2>Recommended Review Sequence</h2>
  <div class="review-list">${reviewItems || '<p style="color:rgba(246,240,231,0.45)">No review order available.</p>'}</div>
  <div class="alignment-box">
    <strong>${escapeHtml(analysis.designAlignment.status)}</strong>
    <p>${escapeHtml(analysis.designAlignment.reason)}</p>
  </div>
</div>

<div style="height:80px"></div>
</body>
</html>`;
}


function renderDiagramsMarkdown(analysis: ReportAnalysis): string[] {
  const lines: string[] = [];
  if (analysis.structureDiagrams.length > 0) {
    lines.push("## 逻辑结构图", "");
    for (const d of analysis.structureDiagrams) {
      lines.push(`### ${d.title}`, "", d.summary, "");
      lines.push(`Before: ${d.before.nodes.map((n) => n.title).join(" -> ")}`);
      lines.push(`After: ${d.after.nodes.map((n) => n.title).join(" -> ")}`);
      lines.push("", `${d.contentTitle}: ${d.content}`);
      lines.push(`${d.reasonTitle}: ${d.reason}`, "");
    }
  }
  if (analysis.runtimeDiagrams.length > 0) {
    lines.push("## 逻辑运行图", "");
    for (const d of analysis.runtimeDiagrams) {
      lines.push(`### ${d.title}`, "", d.summary, "");
      lines.push(`Before: ${d.before.steps.map((s) => s.label).join(" -> ")}`);
      lines.push(`After: ${d.after.steps.map((s) => s.label).join(" -> ")}`);
      lines.push("", `${d.contentTitle}: ${d.content}`);
      lines.push(`${d.reasonTitle}: ${d.reason}`, "");
    }
  }
  return lines;
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
    ...renderDiagramsMarkdown(analysis),
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
  const analyzerContext = buildAnalyzerContext(
    {
      workspaceRoot: input.workspaceRoot,
      branchTrack: input.branchTrack,
      currentCheckpoint: input.currentCheckpoint,
      config: input.config,
      deltaPatchesDir: input.deltaPatchesDir,
      trigger: input.trigger
    },
    window
  );
  const analysis = analyzeReport(analyzerContext, input.config);

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

  // Try Codex visual report first, fall back to heuristic
  const visualHtml = generateVisualReportHtml(analyzerContext, input.config);
  const htmlContent = visualHtml ?? buildFallbackVisualHtml(report, window, analysis, input.deltaPatchesDir);
  writeFileSync(htmlPath, htmlContent, "utf8");

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
