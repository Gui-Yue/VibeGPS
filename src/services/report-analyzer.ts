import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import type { Delta, DiagramTone, ReportAnalysis, ReportReviewItem, ReportRisk, ReviewPriority, RuntimeDiagram, StructureDiagram, VibegpsConfig } from "../shared";

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

const diagramToneSchema = z.enum(["add", "mod", "del", "keep"]);

const legendItemSchema = z.object({
  label: z.string(),
  tone: diagramToneSchema
});

const structureNodeSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  x: z.number(),
  y: z.number(),
  tone: diagramToneSchema
});

const structureSideSchema = z.object({
  title: z.string(),
  nodes: z.array(structureNodeSchema),
  edges: z.array(z.tuple([z.string(), z.string()]))
});

const structureDiagramSchema = z.object({
  title: z.string(),
  summary: z.string(),
  contentTitle: z.string(),
  content: z.string(),
  reasonTitle: z.string(),
  reason: z.string(),
  legend: z.array(legendItemSchema),
  before: structureSideSchema,
  after: structureSideSchema
});

const runtimeStepSchema = z.object({
  label: z.string(),
  tone: diagramToneSchema
});

const runtimeSideSchema = z.object({
  title: z.string(),
  steps: z.array(runtimeStepSchema)
});

const runtimeDiagramSchema = z.object({
  title: z.string(),
  summary: z.string(),
  contentTitle: z.string(),
  content: z.string(),
  reasonTitle: z.string(),
  reason: z.string(),
  legend: z.array(legendItemSchema),
  before: runtimeSideSchema,
  after: runtimeSideSchema
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
  confidence: z.enum(["high", "medium", "low"]),
  structureDiagrams: z.array(structureDiagramSchema).default([]),
  runtimeDiagrams: z.array(runtimeDiagramSchema).default([])
});

const diagramToneJsonSchema = { type: "string", enum: ["add", "mod", "del", "keep"] } as const;

const legendItemJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["label", "tone"],
  properties: {
    label: { type: "string" },
    tone: diagramToneJsonSchema
  }
} as const;

const structureNodeJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "title", "body", "x", "y", "tone"],
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    body: { type: "string" },
    x: { type: "number" },
    y: { type: "number" },
    tone: diagramToneJsonSchema
  }
} as const;

const structureSideJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "nodes", "edges"],
  properties: {
    title: { type: "string" },
    nodes: { type: "array", items: structureNodeJsonSchema },
    edges: { type: "array", items: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2 } }
  }
} as const;

const structureDiagramJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "summary", "contentTitle", "content", "reasonTitle", "reason", "legend", "before", "after"],
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    contentTitle: { type: "string" },
    content: { type: "string" },
    reasonTitle: { type: "string" },
    reason: { type: "string" },
    legend: { type: "array", items: legendItemJsonSchema },
    before: structureSideJsonSchema,
    after: structureSideJsonSchema
  }
} as const;

const runtimeStepJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["label", "tone"],
  properties: {
    label: { type: "string" },
    tone: diagramToneJsonSchema
  }
} as const;

const runtimeSideJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "steps"],
  properties: {
    title: { type: "string" },
    steps: { type: "array", items: runtimeStepJsonSchema }
  }
} as const;

const runtimeDiagramJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "summary", "contentTitle", "content", "reasonTitle", "reason", "legend", "before", "after"],
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    contentTitle: { type: "string" },
    content: { type: "string" },
    reasonTitle: { type: "string" },
    reason: { type: "string" },
    legend: { type: "array", items: legendItemJsonSchema },
    before: runtimeSideJsonSchema,
    after: runtimeSideJsonSchema
  }
} as const;

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
    "confidence",
    "structureDiagrams",
    "runtimeDiagrams"
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
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    structureDiagrams: { type: "array", items: structureDiagramJsonSchema },
    runtimeDiagrams: { type: "array", items: runtimeDiagramJsonSchema }
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeStructureDiagrams(diagrams: z.infer<typeof structureDiagramSchema>[]): StructureDiagram[] {
  return diagrams.map((d) => ({
    ...d,
    before: {
      ...d.before,
      nodes: d.before.nodes.map((n) => ({ ...n, x: clamp(n.x, 40, 460), y: clamp(n.y, 40, 380) }))
    },
    after: {
      ...d.after,
      nodes: d.after.nodes.map((n) => ({ ...n, x: clamp(n.x, 560, 1060), y: clamp(n.y, 40, 380) }))
    }
  }));
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
    structureDiagrams: normalizeStructureDiagrams(normalized.structureDiagrams),
    runtimeDiagrams: normalized.runtimeDiagrams,
    analyzerRuntime: "codex"
  };
}

function inferModuleTone(candidates: Array<{ path: string; changeType: string }>, area: string): DiagramTone {
  const areaFiles = candidates.filter((c) => c.path.startsWith(area + "/") || c.path.startsWith(area));
  if (areaFiles.length === 0) return "keep";
  const allAdded = areaFiles.every((f) => f.changeType === "added");
  const allDeleted = areaFiles.every((f) => f.changeType === "deleted");
  if (allAdded) return "add";
  if (allDeleted) return "del";
  return "mod";
}

const MODULE_PURPOSES: Record<string, string> = {
  "src/services": "核心业务逻辑",
  "src/commands": "CLI 命令入口",
  "src/shared": "共享类型与配置",
  "src/utils": "工具函数集合",
  "src/extension": "扩展集成层",
  tests: "测试验证层"
};

const MODULE_PIPELINE: [string, string][] = [
  ["src/shared", "src/services"],
  ["src/services", "src/commands"],
  ["src/utils", "src/services"]
];

function buildHeuristicStructureDiagram(context: AnalyzerContext): StructureDiagram[] {
  const candidates = context.reviewCandidates.map((c) => ({ path: c.path, changeType: c.changeType }));
  const areas = inferAreas(candidates.map((c) => ({ path: c.path, lines: 1 })));
  if (areas.length < 2) return [];

  const yStart = 80;
  const yStep = 120;
  const beforeNodes = areas.map((area, i) => ({
    id: area.replaceAll("/", "_"),
    title: area.split("/").pop() ?? area,
    body: MODULE_PURPOSES[area] ?? "项目模块",
    x: 70,
    y: yStart + i * yStep,
    tone: "keep" as DiagramTone
  }));

  const afterNodes = areas.map((area, i) => ({
    id: area.replaceAll("/", "_"),
    title: area.split("/").pop() ?? area,
    body: MODULE_PURPOSES[area] ?? "项目模块",
    x: 650,
    y: yStart + i * yStep,
    tone: inferModuleTone(candidates, area)
  }));

  const edges: [string, string][] = MODULE_PIPELINE
    .filter(([from, to]) => areas.includes(from) && areas.includes(to))
    .map(([from, to]) => [from.replaceAll("/", "_"), to.replaceAll("/", "_")]);

  return [
    {
      title: `模块级变更分布：${areas.slice(0, 2).join("、")}`,
      summary: `本轮改动主要集中在 ${areas.join("、")} 等模块，此图展示这些模块在改动前后的职责状态变化。`,
      contentTitle: "改动内容",
      content: `${areas.length} 个模块受到本轮变更影响，其中涉及职责变化的模块已标注为"重组"。`,
      reasonTitle: "改动原因",
      reason: "文件级 diff 无法直观展示模块边界是否发生了位移，结构图帮助 reviewer 快速判断模块职责划分是否仍然合理。",
      legend: [
        { label: "新增模块", tone: "add" },
        { label: "职责变化", tone: "mod" },
        { label: "移除模块", tone: "del" },
        { label: "保持不变", tone: "keep" }
      ],
      before: { title: "改动前", nodes: beforeNodes, edges },
      after: { title: "改动后", nodes: afterNodes, edges }
    }
  ];
}

function buildHeuristicRuntimeDiagram(context: AnalyzerContext): RuntimeDiagram[] {
  if (context.aggregate.deltaCount < 2) return [];
  const hasHook = context.reviewCandidates.some((c) => c.path.includes("hook") || c.path.includes("codex"));
  const hasService = context.reviewCandidates.some((c) => c.path.includes("services/"));
  if (!hasHook && !hasService) return [];

  const beforeSteps = [
    { label: "事件触发", tone: "keep" as DiagramTone },
    { label: "执行核心逻辑", tone: "keep" as DiagramTone },
    { label: "输出结果", tone: "keep" as DiagramTone }
  ];

  const afterSteps: Array<{ label: string; tone: DiagramTone }> = [
    { label: "事件触发", tone: "keep" }
  ];
  if (hasHook) afterSteps.push({ label: "Hook 链路处理", tone: "mod" });
  afterSteps.push({ label: "执行核心逻辑", tone: "mod" });
  if (context.aggregate.touchedFiles >= 4) afterSteps.push({ label: "多模块协调", tone: "add" });
  afterSteps.push({ label: "输出结果", tone: "keep" });

  return [
    {
      title: "事件处理链路变化",
      summary: "本轮改动涉及事件处理流程的调整，此图展示触发事件后的执行步骤如何变化。",
      contentTitle: "改动内容",
      content: `事件处理链路从 ${beforeSteps.length} 步变为 ${afterSteps.length} 步，新增或调整了中间处理环节。`,
      reasonTitle: "改动原因",
      reason: "运行时链路的变化在静态 diff 中不直观，运行图帮助 reviewer 理解执行顺序和分支判断的变化。",
      legend: [
        { label: "新增步骤", tone: "add" },
        { label: "重组步骤", tone: "mod" },
        { label: "移除步骤", tone: "del" },
        { label: "保留步骤", tone: "keep" }
      ],
      before: { title: "改动前", steps: beforeSteps },
      after: { title: "改动后", steps: afterSteps }
    }
  ];
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
        reason: "\u5F53\u524D\u672A\u68C0\u6D4B\u5230\u660E\u786E\u7684\u8BBE\u8BA1\u6587\u6863\u8F93\u5165\uFF0C\u65E0\u6CD5\u5BF9\u300C\u662F\u5426\u504F\u79BB\u8BBE\u8BA1\u300D\u7ED9\u51FA\u9AD8\u7F6E\u4FE1\u5224\u65AD\u3002"
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
      analyzerRuntime: "heuristic",
      structureDiagrams: [],
      runtimeDiagrams: []
    };
  }

  return {
    headline: `VibeGPS 判断当前阶段的主线集中在 ${primaryArea}，已经值得用户进行一次阶段性 review。`,
    overview:
      context.aggregate.deltaCount > 1
        ? "\u8FD9\u4E0D\u662F\u5355\u6B21\u96F6\u6563\u6539\u52A8\uFF0C\u800C\u662F\u4E00\u6BB5\u7D2F\u8BA1\u591A\u8F6E\u7684 agent \u63A8\u8FDB\u8FC7\u7A0B\u3002\u6B64\u65F6\u76F4\u63A5\u770B diff \u5F88\u96BE\u6062\u590D\u4E0A\u4E0B\u6587\uFF0Creport \u7684\u4EFB\u52A1\u662F\u628A\u300C\u53D1\u751F\u4E86\u4EC0\u4E48\u3001\u4E3A\u4F55\u91CD\u8981\u3001\u5148\u770B\u54EA\u91CC\u300D\u7FFB\u8BD1\u6210\u4EBA\u7C7B\u53EF\u63A7\u7684\u53D9\u4E8B\u3002"
        : `虽然当前只累计了 1 个 delta，但本次改动已经触达 ${context.aggregate.touchedFiles} 个文件并带来 ${context.aggregate.changedLines} 行变化，继续仅靠 diff 会降低用户对系统状态的掌控感。`,
    intent:
      promptHints[0]
        ? `结合最近的 prompt 片段，系统推断这段改动的目标大概率与"${promptHints[0].slice(0, 80)}"相关；若该片段不完整，建议结合 review 顺序进一步确认。`
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
    analyzerRuntime: "heuristic",
    structureDiagrams: buildHeuristicStructureDiagram(context),
    runtimeDiagrams: buildHeuristicRuntimeDiagram(context)
  };
}

function buildPrompt(context: AnalyzerContext): string {
  const lines = [
    "\u4F60\u662F VibeGPS \u7684 report analyzer\u3002",
    "\u4EFB\u52A1\u4E0D\u662F\u590D\u8FF0 diff\uFF0C\u800C\u662F\u5E2E\u52A9\u7528\u6237\u6062\u590D\u5BF9 agent \u9020\u6210\u7684\u9879\u76EE\u6F14\u5316\u7684\u638C\u63A7\u611F\u3002",
    "\u8BF7\u6839\u636E\u8F93\u5165\u4E0A\u4E0B\u6587\uFF0C\u8F93\u51FA\u4E25\u683C JSON\uFF0C\u5B57\u6BB5\u5FC5\u987B\u7B26\u5408 schema\u3002",
    "",
    "## \u57FA\u672C\u8981\u6C42",
    "1. \u4F7F\u7528\u4E2D\u6587\u3002",
    "2. \u4E0D\u8981\u53EA\u8BF4\u54EA\u4E9B\u6587\u4EF6\u53D8\u4E86\uFF0C\u8981\u89E3\u91CA\u672C\u9636\u6BB5\u76EE\u6807\u3001\u5F71\u54CD\u3001\u98CE\u9669\u3001\u4F18\u5148 review \u987A\u5E8F\u3002",
    "3. \u5982\u679C\u8BC1\u636E\u4E0D\u8DB3\uFF0C\u660E\u786E\u8BF4\u4E0D\u786E\u5B9A\uFF0C\u4E0D\u8981\u7F16\u9020\u3002",
    "4. headline \u548C overview \u8981\u8BA9\u7528\u6237\u5FEB\u901F\u7406\u89E3\u300C\u73B0\u5728\u4E3A\u4EC0\u4E48\u503C\u5F97\u770B\u8FD9\u4EFD report\u300D\u3002",
    "5. designAlignment \u82E5\u6CA1\u6709\u8BBE\u8BA1\u8BC1\u636E\uFF0C\u5E94\u8F93\u51FA unclear\u3002",
    "6. tests \u6587\u4EF6\u901A\u5E38\u4E0D\u662F\u7B2C\u4E00 review \u4F18\u5148\u7EA7\uFF0C\u9664\u975E\u6CA1\u6709\u66F4\u5173\u952E\u7684\u5B9E\u73B0\u6587\u4EF6\u3002",
    "7. patchRef\u3001evidence\u3001relatedFiles \u82E5\u4E0D\u786E\u5B9A\u8BF7\u8F93\u51FA null\uFF0C\u800C\u4E0D\u662F\u7701\u7565\u5B57\u6BB5\u3002",
  ];

  lines.push(
    "",
    "## \u903B\u8F91\u56FE\u8C31\u751F\u6210\u8981\u6C42\uFF08structureDiagrams / runtimeDiagrams\uFF09",
    "",
    "### structureDiagrams\uFF08\u903B\u8F91\u7ED3\u6784\u56FE\uFF09\u2014 \u9759\u6001\u67B6\u6784\u89C6\u89D2",
    "\u6BCF\u5F20\u56FE\u5FC5\u987B\u6709\u4E00\u4E2A\u660E\u786E\u7684\u67B6\u6784\u8BBA\u70B9\uFF08title\uFF09\uFF0C\u4F8B\u5982\u300C\u62A5\u544A\u751F\u6210\u7BA1\u7EBF\u4ECE\u7EBF\u6027\u62D3\u6251\u91CD\u7EC4\u4E3A\u5206\u652F\u62D3\u6251\u300D\u3002",
    "\u8282\u70B9\u4EE3\u8868\u6A21\u5757\u3001\u5B50\u7CFB\u7EDF\u6216\u67B6\u6784\u8FB9\u754C\u2014\u2014\u4E0D\u662F\u5355\u4E2A\u6587\u4EF6\u3002",
    "- title: \u6982\u5FF5\u6A21\u5757\u540D\uFF08\u5982\u300C\u53D8\u66F4\u91C7\u96C6\u300D\u3001\u300C\u9608\u503C\u5224\u65AD\u300D\u3001\u300C\u62A5\u544A\u6E32\u67D3\u300D\uFF09",
    "- body: \u7528 5-10 \u5B57\u63CF\u8FF0\u8BE5\u6A21\u5757\u7684\u6838\u5FC3\u804C\u8D23",
    "- \u8FB9\uFF08edges\uFF09\u4EE3\u8868\u4F9D\u8D56\u3001\u6570\u636E\u6D41\u6216\u8C03\u7528\u5173\u7CFB",
    "",
    "before/after \u5BF9\u6BD4\u5C55\u793A\u540C\u4E00\u7CFB\u7EDF\u5728\u4E24\u4E2A\u65F6\u95F4\u70B9\u7684\u67B6\u6784\u72B6\u6001\u3002",
    "tone \u8BED\u4E49: add=\u65B0\u5F15\u5165\u7684\u6A21\u5757, mod=\u804C\u8D23\u6216\u8FB9\u754C\u53D1\u751F\u53D8\u5316, del=\u79FB\u9664\u6216\u5F31\u5316, keep=\u4FDD\u6301\u4E0D\u53D8\u3002",
    "",
    "\u8282\u70B9\u5750\u6807\u89C4\u5219\uFF08SVG viewBox 1120x420\uFF09:",
    "- before \u4FA7\u8282\u70B9 x \u8303\u56F4 [40, 460], after \u4FA7\u8282\u70B9 x \u8303\u56F4 [600, 1060]",
    "- y \u8303\u56F4 [60, 380], \u540C\u4FA7\u8282\u70B9\u95F4 y \u95F4\u8DDD >= 100",
    "- \u8282\u70B9\u5C3A\u5BF8\u56FA\u5B9A 170x74, \u8BF7\u786E\u4FDD\u8282\u70B9\u4E0D\u91CD\u53E0",
    "",
    "\u751F\u6210 0-3 \u5F20\u7ED3\u6784\u56FE\u3002\u5982\u679C\u6CA1\u6709\u6709\u610F\u4E49\u7684\u67B6\u6784\u91CD\u7EC4\uFF0C\u8FD4\u56DE\u7A7A\u6570\u7EC4 []\u3002",
    "",
    "\u5173\u952E\u539F\u5219:",
    "- \u4E0D\u8981\u590D\u8FF0 diff, \u8981\u63ED\u793A diff \u4E2D\u4E0D\u53EF\u89C1\u7684\u6A21\u5757\u7EA7\u67B6\u6784\u6A21\u5F0F",
    "- \u60F3\u8C61\u4F60\u5728\u7ED9\u4E00\u4E2A\u521A\u52A0\u5165\u56E2\u961F\u7684\u5DE5\u7A0B\u5E08\u89E3\u91CA\u300C\u8FD9\u8F6E\u6539\u52A8\u5728\u67B6\u6784\u5C42\u9762\u505A\u4E86\u4EC0\u4E48\u300D",
    "- content \u63CF\u8FF0\u300C\u6539\u4E86\u4EC0\u4E48\u7ED3\u6784\u300D, reason \u89E3\u91CA\u300C\u4E3A\u4EC0\u4E48 reviewer \u9700\u8981\u770B\u7ED3\u6784\u56FE\u800C\u4E0D\u662F\u53EA\u770B diff\u300D",
    "",
    "### runtimeDiagrams\uFF08\u903B\u8F91\u8FD0\u884C\u56FE\uFF09\u2014 \u52A8\u6001\u6267\u884C\u89C6\u89D2",
    "\u6BCF\u5F20\u56FE\u805A\u7126\u4E00\u4E2A\u4E8B\u4EF6/\u8BF7\u6C42\u7684\u5904\u7406\u94FE\u8DEF\u5728\u672C\u8F6E\u6539\u52A8\u524D\u540E\u7684\u53D8\u5316\u3002",
    "\u6B65\u9AA4\uFF08steps\uFF09\u7528\u7948\u4F7F\u52A8\u8BCD\u77ED\u8BED\u63CF\u8FF0\uFF08\u5982\u300C\u8BA1\u7B97 diff\u300D\u3001\u300C\u5224\u65AD\u9608\u503C\u300D\u3001\u300C\u751F\u6210\u62A5\u544A\u300D\u3001\u300C\u56DE\u5199\u7ED3\u679C\u8DEF\u5F84\u300D\uFF09\u3002",
    "",
    "before/after \u5BF9\u6BD4\u5C55\u793A\u540C\u4E00\u89E6\u53D1\u4E8B\u4EF6\u7684\u5904\u7406\u65B9\u5F0F\u5982\u4F55\u53D8\u5316\u3002",
    "tone \u8BED\u4E49\u540C\u4E0A: add=\u65B0\u589E\u6B65\u9AA4, mod=\u6B65\u9AA4\u884C\u4E3A\u53D8\u5316, del=\u79FB\u9664\u6B65\u9AA4, keep=\u4FDD\u6301\u4E0D\u53D8\u3002",
    "",
    "\u751F\u6210 0-3 \u5F20\u8FD0\u884C\u56FE\u3002\u5982\u679C\u6CA1\u6709\u6267\u884C\u6D41\u53D8\u5316\uFF0C\u8FD4\u56DE\u7A7A\u6570\u7EC4 []\u3002",
    "",
    "\u5173\u952E\u539F\u5219:",
    "- \u73B0\u4EE3\u8F6F\u4EF6\u5F88\u591A PR \u771F\u6B63\u6539\u7684\u662F\u8FD0\u884C\u65F6\u94FE\u8DEF\uFF0C\u800C\u4E0D\u662F\u9759\u6001\u6587\u4EF6\u7ED3\u6784",
    "- \u8FD0\u884C\u56FE\u5E2E reviewer \u770B\u51FA\u6267\u884C\u987A\u5E8F\u3001\u5206\u652F\u5224\u65AD\u548C\u8F93\u51FA\u65F6\u673A\u5230\u5E95\u5982\u4F55\u53D8\u5316",
    "- content \u63CF\u8FF0\u300C\u52A8\u6001\u6267\u884C\u5982\u4F55\u53D8\u5316\u300D, reason \u89E3\u91CA\u300C\u4E3A\u4EC0\u4E48\u9700\u8981\u770B\u8FD0\u884C\u56FE\u300D",
    "",
    "## \u4E0A\u4E0B\u6587 JSON",
    JSON.stringify(context, null, 2)
  );

  return lines.join("\n");
}

type AgentRuntime = "codex" | "claude";

function detectAvailableAgent(preferred: string): AgentRuntime | null {
  if (preferred === "codex" || preferred === "auto") {
    const codex = spawnSync("codex", ["--version"], { encoding: "utf8", timeout: 5000, stdio: "pipe" });
    if (codex.status === 0) return "codex";
  }
  if (preferred === "claude" || preferred === "auto") {
    const claude = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 5000, stdio: "pipe" });
    if (claude.status === 0) return "claude";
  }
  // If explicit preference failed, try the other one
  if (preferred === "codex") {
    const claude = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 5000, stdio: "pipe" });
    if (claude.status === 0) return "claude";
  }
  if (preferred === "claude") {
    const codex = spawnSync("codex", ["--version"], { encoding: "utf8", timeout: 5000, stdio: "pipe" });
    if (codex.status === 0) return "codex";
  }
  return null;
}

function runClaudeAnalyzer(context: AnalyzerContext): ReportAnalysis | null {
  const tempRoot = mkdtempSync(join(tmpdir(), "vibegps-report-claude-"));
  const outputPath = join(tempRoot, "report-analysis.json");
  const schemaPath = join(tempRoot, "report-analysis.schema.json");

  try {
    writeFileSync(schemaPath, JSON.stringify(reportAnalysisJsonSchema, null, 2), "utf8");
    const prompt = buildPrompt(context)
      + "\n\nYou MUST output valid JSON conforming to the schema at: " + schemaPath
      + "\nWrite the JSON output to: " + outputPath;
    const result = spawnSync(
      "claude",
      [
        "-p", prompt,
        "--output-file", outputPath,
        "--max-turns", "1",
        "--no-input"
      ],
      {
        encoding: "utf8",
        timeout: 180000,
        stdio: ["pipe", "pipe", "pipe"],
        cwd: context.workspaceRoot
      }
    );

    if (result.status !== 0 || !existsSync(outputPath)) {
      return null;
    }

    const raw = readFileSync(outputPath, "utf8").trim();
    // Extract JSON from possible markdown code fence
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = jsonMatch ? jsonMatch[1].trim() : raw;
    const parsed = JSON.parse(jsonStr);
    return normalizeCodexAnalysis(parsed);
  } catch {
    return null;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
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
        "-c",
        "features.codex_hooks=false",
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
  if (config.report.analyzer !== "heuristic") {
    const agent = detectAvailableAgent(config.report.analyzer);
    if (agent === "codex") {
      const result = runCodexAnalyzer(context);
      if (result) return result;
    } else if (agent === "claude") {
      const result = runClaudeAnalyzer(context);
      if (result) return result;
    }
  }

  return buildHeuristicAnalysis(context);
}

/* ------------------------------------------------------------------ */
/*  Visual report HTML generation via Codex / Claude                  */
/* ------------------------------------------------------------------ */

function buildVisualReportPrompt(context: AnalyzerContext): string {
  const topFilesText = context.aggregate.topFiles.length > 0
    ? context.aggregate.topFiles
        .map((f) => `  - ${f.path} (${f.lastChangeType}, ${f.lines} lines, ${f.touches}x)`)
        .join("\n")
    : null;

  const patchesText = context.reviewCandidates
    .filter((c) => c.patchExcerpt)
    .map((c) => `### ${c.path} (${c.changeType}, ${c.lines} lines)\n\`\`\`diff\n${c.patchExcerpt}\n\`\`\``)
    .join("\n\n");

  const timelineText = context.aggregate.timeline
    .map((t) => `  - ${t.createdAt} | ${t.changedFiles} files, ${t.changedLines} lines | ${t.summary}`)
    .join("\n");

  return [
    "You are a software architecture visualization expert. Your audience is an architect-type developer.",
    "",
    "## Identity",
    "",
    "You are not writing a diff report. You are creating a project evolution briefing for a software architect.",
    "This architect cares about: overall structure, module relationships, system engineering, design intent -- not line-by-line code changes.",
    "Your goal is to let them regain control of the project evolution in 3-5 minutes through a single visually stunning long-scroll webpage.",
    "",
    "## Output Requirements",
    "",
    "You MUST output a complete, self-contained HTML file:",
    "- Starts with <!DOCTYPE html>",
    "- No external CDN, images, or resource files",
    "- Use Chinese as the report language",
    "- Single-page long-scroll experience with distinct visual sections",
    "- A sticky or fixed navigation bar/sidebar that lets users jump between sections",
    "- Smooth scroll behavior between sections",
    "- Every section MUST combine text AND graphics (SVG/CSS). NO pure-text sections allowed.",
    "- 6-8 major sections as described below",
    "",
    "## Page Content Framework",
    "",
    "Organize sections using architectural metaphors (adjust based on actual data, but this is the minimum set):",
    "",
    "### 1. Hero / Cover Section (Engineering Nameplate)",
    `- Project/branch: ${context.gitBranch}`,
    `- Time window: ${context.fromCheckpointId} -> ${context.toCheckpointId}`,
    "- One-sentence summary of this evolution phase",
    "- A project-identifying graphic or decorative SVG",
    "- Key stats (delta count, files, lines) displayed as large visual metrics",
    "",
    "### 2. Architecture Overview (Building Floor Plan)",
    "- SVG diagram of project module structure and dependencies",
    "- Nodes = modules/directories, edges = dependency/call relationships",
    "- Highlight changed modules with accent color",
    "- This should be a prominent, large visual that dominates the section",
    "",
    "### 3. Change Intent Narrative (Design Intent Statement)",
    "- Use narrative text (not bullet lists) to explain the strategic goal",
    "- Include an intent flow diagram or concept map as SVG",
    '- Answer: "What was the agent pushing forward in this phase?"',
    "",
    "### 4. Module Relationship Changes (Structural Engineering Change Order)",
    "- Show which module connections were added, modified, or severed",
    "- Before/after comparison using side-by-side SVG diagrams",
    "- Use color coding: green=added, amber=modified, red=removed, gray=unchanged",
    "- Let the architect see at a glance what changed structurally",
    "",
    "### 5. Key File Deep Dive (Construction Details)",
    "- Visual interpretation of core changed files",
    '- Not showing raw diffs, but "before vs after" structural understanding',
    "- Use file structure diagrams, change heatmaps, function relationship diagrams, etc.",
    "- Each key file gets a visual card with metrics and a mini-diagram",
    "",
    "### 6. Risks & Recommendations (Quality Inspection Report)",
    "- Risk visualization (severity, scope) using SVG or CSS graphics",
    "- Recommended review priority order with visual ranking",
    "- Next-step action suggestions",
    "",
    "## Toolbox (optional, not mandatory)",
    "",
    "- Animation: CSS @keyframes + transition for scroll-triggered entrance effects. Encourage SVG entrance animations.",
    "- Graphics: Pure SVG and CSS for architecture diagrams, relationship graphs, flow charts, heatmaps. Every section needs a visual.",
    "- Layout: CSS Grid / Flexbox, large fonts, high contrast, generous whitespace. Each section should feel like a distinct chapter.",
    "- Color: Trust your aesthetic judgment, but ensure readability and contrast. Use a cohesive palette throughout.",
    "- Navigation: A sticky nav bar or floating sidebar with section anchors. Smooth scroll behavior. Optional scroll progress indicator.",
    "- Sections should have full-width or near-full-width layouts with generous vertical padding to create visual separation.",
    "",
    "## Project Data",
    "",
    "### Basic Info",
    `- Branch: ${context.gitBranch}`,
    `- Window: ${context.fromCheckpointId} -> ${context.toCheckpointId}`,
    `- Trigger: ${context.trigger}`,
    "",
    "### Aggregate Statistics",
    `- Delta count: ${context.aggregate.deltaCount}`,
    `- Touched files: ${context.aggregate.touchedFiles}`,
    `- Changed lines: ${context.aggregate.changedLines}`,
    `- Added files: ${context.aggregate.addedFiles}`,
    `- Modified files: ${context.aggregate.modifiedFiles}`,
    `- Deleted files: ${context.aggregate.deletedFiles}`,
    "",
    "### Top Files",
    topFilesText || "  (none)",
    "",
    "### Delta Timeline",
    timelineText || "  (none)",
    "",
    "### Patch Excerpts (for key files)",
    patchesText || "  (none)",
    "",
    context.designContext ? `### Design Context\n${context.designContext}` : "",
    context.projectContext ? `### Project Context\n${context.projectContext}` : ""
  ].join("\n");
}

function runClaudeVisualReport(context: AnalyzerContext): string | null {
  const tempRoot = mkdtempSync(join(tmpdir(), "vibegps-report-html-claude-"));
  const outputPath = join(tempRoot, "report.html");

  try {
    const prompt = buildVisualReportPrompt(context)
      + "\n\nWrite the complete HTML file to: " + outputPath;
    const result = spawnSync(
      "claude",
      [
        "-p", prompt,
        "--output-file", outputPath,
        "--max-turns", "1",
        "--no-input"
      ],
      {
        encoding: "utf8",
        timeout: 240000,
        stdio: ["pipe", "pipe", "pipe"],
        cwd: context.workspaceRoot
      }
    );

    if (result.status !== 0 || !existsSync(outputPath)) {
      return null;
    }

    const html = readFileSync(outputPath, "utf8");
    if (!html.includes("<!DOCTYPE") && !html.includes("<!doctype")) {
      return null;
    }
    return html;
  } catch {
    return null;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function runCodexVisualReport(context: AnalyzerContext): string | null {
  const tempRoot = mkdtempSync(join(tmpdir(), "vibegps-report-html-"));
  const outputPath = join(tempRoot, "report.html");

  try {
    const prompt = buildVisualReportPrompt(context);
    const result = spawnSync(
      "codex",
      [
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "-c",
        "features.codex_hooks=false",
        "-C",
        context.workspaceRoot,
        "-s",
        "read-only",
        "-o",
        outputPath,
        "-"
      ],
      {
        input: prompt,
        encoding: "utf8",
        timeout: 240000,
        stdio: ["pipe", "pipe", "pipe"]
      }
    );

    if (result.status !== 0 || !existsSync(outputPath)) {
      return null;
    }

    const html = readFileSync(outputPath, "utf8");
    if (!html.includes("<!DOCTYPE") && !html.includes("<!doctype")) {
      return null;
    }
    return html;
  } catch {
    return null;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function generateVisualReportHtml(context: AnalyzerContext, config: VibegpsConfig): string | null {
  if (config.report.analyzer === "heuristic") return null;

  const agent = detectAvailableAgent(config.report.analyzer);
  if (agent === "codex") return runCodexVisualReport(context);
  if (agent === "claude") return runClaudeVisualReport(context);
  return null;
}
