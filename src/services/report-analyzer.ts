import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import type { Delta, ReportAnalysis, ReportReviewItem, ReportRisk, ReviewPriority, VibegpsConfig } from "../shared";

export interface ReportAggregate {
  deltaCount: number;
  touchedFiles: number;
  changedLines: number;
  addedFiles: number;
  modifiedFiles: number;
  deletedFiles: number;
  topFiles: Array<{
    path: string;
    touches: number;
    lines: number;
    lastChangeType: string;
    patchRef?: string;
  }>;
  timeline: Array<{
    deltaId: string;
    createdAt: string;
    changedFiles: number;
    changedLines: number;
    summary: string;
    promptPreview?: string;
  }>;
}

export interface AnalyzerContext {
  workspaceRoot: string;
  gitBranch: string;
  fromCheckpointId: string;
  toCheckpointId: string;
  trigger: string;
  aggregate: ReportAggregate;
  deltas: Delta[];
  designContext?: string;
  projectContext?: string;
  reviewCandidates: Array<{
    path: string;
    patchRef?: string;
    patchExcerpt?: string;
    lines: number;
    changeType: string;
    summary?: string;
  }>;
}

const riskSchema = z.object({
  severity: z.enum(["high", "medium", "low"]),
  title: z.string(),
  detail: z.string(),
  relatedFiles: z.array(z.string()).nullable().optional()
});

const reviewItemSchema = z.object({
  path: z.string(),
  priority: z.enum(["high", "medium", "low"]),
  reason: z.string(),
  patchRef: z.string().nullable().optional()
});

const reportAnalysisBaseSchema = z.object({
  headline: z.string(),
  overview: z.string(),
  intent: z.string(),
  keyChanges: z.array(z.string()),
  impact: z.array(z.string()),
  risks: z.array(riskSchema),
  designAlignment: z.object({
    status: z.enum(["aligned", "partial", "unclear", "deviated"]),
    reason: z.string(),
    evidence: z.string().nullable().optional()
  }),
  reviewOrder: z.array(reviewItemSchema),
  nextQuestions: z.array(z.string()),
  confidence: z.enum(["high", "medium", "low"])
});

const reportAnalysisJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "headline",
    "overview",
    "intent",
    "keyChanges",
    "impact",
    "risks",
    "designAlignment",
    "reviewOrder",
    "nextQuestions",
    "confidence"
  ],
  properties: {
    headline: { type: "string" },
    overview: { type: "string" },
    intent: { type: "string" },
    keyChanges: { type: "array", items: { type: "string" } },
    impact: { type: "array", items: { type: "string" } },
    risks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "title", "detail", "relatedFiles"],
        properties: {
          severity: { type: "string", enum: ["high", "medium", "low"] },
          title: { type: "string" },
          detail: { type: "string" },
          relatedFiles: {
            anyOf: [
              { type: "array", items: { type: "string" } },
              { type: "null" }
            ]
          }
        }
      }
    },
    designAlignment: {
      type: "object",
      additionalProperties: false,
      required: ["status", "reason", "evidence"],
      properties: {
        status: { type: "string", enum: ["aligned", "partial", "unclear", "deviated"] },
        reason: { type: "string" },
        evidence: {
          anyOf: [
            { type: "string" },
            { type: "null" }
          ]
        }
      }
    },
    reviewOrder: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "priority", "reason", "patchRef"],
        properties: {
          path: { type: "string" },
          priority: { type: "string", enum: ["high", "medium", "low"] },
          reason: { type: "string" },
          patchRef: {
            anyOf: [
              { type: "string" },
              { type: "null" }
            ]
          }
        }
      }
    },
    nextQuestions: { type: "array", items: { type: "string" } },
    confidence: { type: "string", enum: ["high", "medium", "low"] }
  }
} as const;

function isTestFile(path: string): boolean {
  return /(^|\/)(tests?|__tests__)\//.test(path) || /\.(test|spec)\./.test(path);
}

function getReviewScore(path: string, lines: number): number {
  let score = lines;

  if (path.includes("src/services/")) {
    score += 120;
  } else if (path.includes("src/shared/")) {
    score += 90;
  } else if (path.includes("src/commands/")) {
    score += 70;
  } else if (path.includes("src/utils/")) {
    score += 45;
  }

  if (isTestFile(path)) {
    score -= 80;
  }

  return score;
}

function inferAreas(
  candidates: Array<{
    path: string;
    lines: number;
  }>
): string[] {
  const preferred = candidates.filter((item) => !isTestFile(item.path));
  const source = preferred.length > 0 ? preferred : candidates;
  const areaMap = new Map<string, number>();

  for (const { path: filePath, lines } of source) {
    const parts = filePath.split("/");
    const area = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0] ?? filePath;
    areaMap.set(area, (areaMap.get(area) ?? 0) + Math.max(lines, 1));
  }

  return [...areaMap.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 4)
    .map(([area]) => area);
}

function detectRiskLevel(path: string, changeType: string, lines: number): ReportRisk | null {
  if (path.endsWith("config.toml") || path.endsWith("config.json") || path.includes("hooks/")) {
    return {
      severity: "high",
      title: "配置或 Hook 链路被改动",
      detail: `文件 ${path} 涉及配置或 hook 路径，若逻辑不稳定会直接影响 VibeGPS 与 Codex 的接入体验。`,
      relatedFiles: [path]
    };
  }

  if (path.includes("services/") && lines >= 40) {
    return {
      severity: "medium",
      title: "核心服务逻辑变动较集中",
      detail: `文件 ${path} 本次改动规模较大，建议优先确认行为是否仍与设计一致。`,
      relatedFiles: [path]
    };
  }

  if (changeType === "deleted") {
    return {
      severity: "medium",
      title: "存在删除型变更",
      detail: `文件 ${path} 被删除，建议确认是否会影响引用关系、脚本入口或历史兼容路径。`,
      relatedFiles: [path]
    };
  }

  return null;
}

function choosePriority(path: string, lines: number): ReviewPriority {
  if (isTestFile(path)) {
    return lines >= 80 ? "medium" : "low";
  }

  if (path.includes("services/") || path.includes("shared/") || lines >= 40) {
    return "high";
  }

  if (path.includes("commands/") || path.includes("utils/") || lines >= 15) {
    return "medium";
  }

  return "low";
}

function normalizeCodexAnalysis(parsed: unknown): ReportAnalysis {
  const normalized = reportAnalysisBaseSchema.parse(parsed);

  return {
    ...normalized,
    risks: normalized.risks.map((risk) => ({
      ...risk,
      relatedFiles: risk.relatedFiles ?? undefined
    })),
    designAlignment: {
      ...normalized.designAlignment,
      evidence: normalized.designAlignment.evidence ?? undefined
    },
    reviewOrder: normalized.reviewOrder.map((item) => ({
      ...item,
      patchRef: item.patchRef ?? undefined
    })),
    analyzerRuntime: "codex"
  };
}

function buildHeuristicAnalysis(context: AnalyzerContext): ReportAnalysis {
  const sortedCandidates = [...context.reviewCandidates].sort((left, right) => {
    const scoreDiff = getReviewScore(right.path, right.lines) - getReviewScore(left.path, left.lines);
    if (scoreDiff !== 0) {
      return scoreDiff;
    }

    return right.lines - left.lines;
  });
  const areas = inferAreas(
    sortedCandidates.map((item) => ({
      path: item.path,
      lines: item.lines
    }))
  );
  const primaryArea = areas[0] ?? context.gitBranch;
  const promptHints = context.deltas
    .map((delta) => delta.promptPreview?.trim())
    .filter((value): value is string => Boolean(value));

  const reviewOrder: ReportReviewItem[] = sortedCandidates.slice(0, 6).map((item) => ({
    path: item.path,
    priority: choosePriority(item.path, item.lines),
    reason:
      isTestFile(item.path)
        ? "这是验证层改动，建议在核心实现确认后再回看，检查测试是否真实覆盖了新行为。"
        : item.lines >= 40
          ? "改动体量较大，且落在关键实现路径，适合优先 review。"
          : item.changeType === "deleted"
            ? "存在删除型变更，建议确认引用与兼容性。"
            : "该文件是当前阶段改动的主要承载点之一。",
    patchRef: item.patchRef
  }));

  const risks = sortedCandidates
    .map((item) => detectRiskLevel(item.path, item.changeType, item.lines))
    .filter((value): value is ReportRisk => value !== null)
    .slice(0, 4);

  const keyChanges = sortedCandidates.slice(0, 5).map((item) => {
    const lineText = item.lines > 0 ? `${item.lines} 行` : "少量结构变更";
    return `${item.path}：${item.summary ?? item.changeType}，本次窗口内属于主要变化承载点（${lineText}）。`;
  });

  const impact = [
    `这次 report 覆盖了 ${context.aggregate.deltaCount} 个 delta，说明用户已经累积了一段可感知的演化过程，而不是单轮噪声。`,
    `主要影响范围集中在 ${areas.join("、") || "当前工作区核心目录"}，这意味着 agent 正在推动一段相对集中的模块调整。`,
    `本窗口共触达 ${context.aggregate.touchedFiles} 个文件、${context.aggregate.changedLines} 行变更，已经足以让用户失去对上下文的直接把握，因此需要解释层恢复认知。`
  ];

  const designAlignment = context.designContext
    ? {
        status: "partial" as const,
        reason: "已注入项目说明/设计上下文，但当前仍需人工确认关键实现是否完全贴合设计约束。",
        evidence: context.designContext.slice(0, 120)
      }
    : {
        status: "unclear" as const,
        reason: "当前未检测到明确的设计文档输入，无法对“是否偏离设计”给出高置信判断。"
      };

  if (context.aggregate.deltaCount === 0) {
    return {
      headline: `VibeGPS 未检测到从 ${context.fromCheckpointId} 到 ${context.toCheckpointId} 之间的新变更。`,
      overview: "当前窗口没有新的 delta，因此这份报告更像一次状态确认，而不是阶段性复盘。",
      intent: "本次没有捕获到新的 agent 变更，说明当前 branch 自上次 report 锚点以来尚未形成新的演化窗口。",
      keyChanges: ["当前窗口没有新增文件级变更。"],
      impact: [
        "因为没有新的 delta，这份 report 不应解读为一次新的开发推进。",
        "如果你预期这里应该有内容，优先检查 diff hook、checkpoint 生成和 branch track 绑定是否正常。",
        "在没有新增变更的情况下，重复生成 report 只会返回状态确认信息。"
      ],
      risks,
      designAlignment,
      reviewOrder,
      nextQuestions: [
        "这次本来应该捕获到新的 turn 吗？",
        "当前工作区是否真的有尚未被 checkpoint 记录的改动？",
        "是否需要回看 hook 是否触发、或手动执行一次 vibegps diff？"
      ],
      confidence: "high",
      analyzerRuntime: "heuristic"
    };
  }

  return {
    headline: `VibeGPS 判断当前阶段的主线集中在 ${primaryArea}，已经值得用户进行一次阶段性 review。`,
    overview:
      context.aggregate.deltaCount > 1
        ? "这不是单次零散改动，而是一段累计多轮的 agent 推进过程。此时直接看 diff 很难恢复上下文，report 的任务是把“发生了什么、为何重要、先看哪里”翻译成人类可控的叙事。"
        : `虽然当前只累计了 1 个 delta，但本次改动已经触达 ${context.aggregate.touchedFiles} 个文件并带来 ${context.aggregate.changedLines} 行变化，继续仅靠 diff 会降低用户对系统状态的掌控感。`,
    intent:
      promptHints[0]
        ? `结合最近的 prompt 片段，系统推断这段改动的目标大概率与“${promptHints[0].slice(0, 80)}”相关；若该片段不完整，建议结合 review 顺序进一步确认。`
        : `当前没有足够的 prompt 证据，系统只能根据改动路径推断：agent 很可能在围绕 ${primaryArea} 做集中实现或重构。`,
    keyChanges,
    impact,
    risks,
    designAlignment,
    reviewOrder,
    nextQuestions: [
      "这段改动是否真正完成了当前阶段的目标，还是只做了中间态拼接？",
      "关键服务或配置改动是否补上了相应测试与异常路径处理？",
      "如果用户此刻不满意，应该从哪一个 review 入口开始回溯或修正？"
    ],
    confidence: promptHints.length > 0 ? "medium" : "low",
    analyzerRuntime: "heuristic"
  };
}

function buildPrompt(context: AnalyzerContext): string {
  return [
    "你是 VibeGPS 的 report analyzer。",
    "任务不是复述 diff，而是帮助用户恢复对 agent 造成的项目演化的掌控感。",
    "请根据输入上下文，输出严格 JSON，字段必须符合 schema。",
    "要求：",
    "1. 使用中文。",
    "2. 不要只说哪些文件变了，要解释本阶段目标、影响、风险、优先 review 顺序。",
    "3. 如果证据不足，明确说不确定，不要编造。",
    "4. headline 和 overview 要让用户快速理解“现在为什么值得看这份 report”。",
    "5. designAlignment 若没有设计证据，应输出 unclear。",
    "6. tests 文件通常不是第一 review 优先级，除非没有更关键的实现文件。",
    "7. patchRef、evidence、relatedFiles 若不确定请输出 null，而不是省略字段。",
    "",
    "上下文 JSON：",
    JSON.stringify(context, null, 2)
  ].join("\n");
}

function runCodexAnalyzer(context: AnalyzerContext): ReportAnalysis | null {
  const tempRoot = mkdtempSync(join(tmpdir(), "vibegps-report-"));
  const schemaPath = join(tempRoot, "report-analysis.schema.json");
  const outputPath = join(tempRoot, "report-analysis.json");

  try {
    writeFileSync(schemaPath, JSON.stringify(reportAnalysisJsonSchema, null, 2), "utf8");
    const prompt = buildPrompt(context);
    const result = spawnSync(
      "codex",
      [
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "-C",
        context.workspaceRoot,
        "-s",
        "read-only",
        "--output-schema",
        schemaPath,
        "-o",
        outputPath,
        "-"
      ],
      {
        input: prompt,
        encoding: "utf8",
        timeout: 180000,
        stdio: ["pipe", "pipe", "pipe"]
      }
    );

    if (result.status !== 0 || !existsSync(outputPath)) {
      return null;
    }

    const parsed = JSON.parse(readFileSync(outputPath, "utf8"));
    return normalizeCodexAnalysis(parsed);
  } catch {
    return null;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function analyzeReport(context: AnalyzerContext, config: VibegpsConfig): ReportAnalysis {
  if (config.report.analyzer === "codex") {
    const codexResult = runCodexAnalyzer(context);
    if (codexResult) {
      return codexResult;
    }
  }

  return buildHeuristicAnalysis(context);
}
