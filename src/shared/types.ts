export type ReportTrigger = "threshold" | "manual" | "daily" | "weekly";

export type CheckpointKind = "init" | "branch_init" | "turn_end" | "manual" | "report_anchor";

export type GitBranchType = "named" | "detached";

export type SnapshotFileKind = "text" | "binary" | "unknown";

export type ChangeType = "added" | "modified" | "deleted" | "binary_modified";

export type AnalysisConfidence = "high" | "medium" | "low";

export type RiskSeverity = "high" | "medium" | "low";

export type ReviewPriority = "high" | "medium" | "low";

export type DesignAlignmentStatus = "aligned" | "partial" | "unclear" | "deviated";

export interface VibegpsConfig {
  version: 1;
  thresholds: {
    changedFiles: number;
    changedLines: number;
  };
  report: {
    defaultFormat: "html" | "md";
    alsoEmitMarkdown: boolean;
    analyzer: "codex" | "heuristic";
    autoGenerate: boolean;
    maxContextFiles: number;
    maxPatchCharsPerFile: number;
  };
  tracking: {
    ignoreGitDir: boolean;
    ignoreVibegpsDir: boolean;
    respectGitignore: boolean;
    ignoreGlobs: string[];
  };
}

export interface GitState {
  gitBranch: string;
  gitHead: string;
  branchType: GitBranchType;
}

export interface BranchTrack {
  branchTrackId: string;
  workspaceId: string;
  gitBranch: string;
  gitHead: string | null;
  branchType: GitBranchType;
  createdAt: string;
  updatedAt: string;
}

export interface SnapshotFileEntry {
  path: string;
  hash: string;
  size: number;
  mtimeMs: number;
  kind: SnapshotFileKind;
  lineCount?: number;
  contentRef?: string;
}

export interface Snapshot {
  snapshotId: string;
  workspaceId: string;
  createdAt: string;
  fileCount: number;
  entries: SnapshotFileEntry[];
}

export interface Checkpoint {
  checkpointId: string;
  workspaceId: string;
  branchTrackId: string;
  gitBranch: string;
  gitHead?: string;
  createdAt: string;
  kind: CheckpointKind;
  parentCheckpointId?: string;
  triggerRef?: {
    source: "codex_notify" | "manual" | "scheduled" | "init";
    turnId?: string;
  };
  snapshotRef: string;
  fileCount: number;
}

export interface FileDelta {
  path: string;
  changeType: ChangeType;
  beforeHash?: string;
  afterHash?: string;
  addedLines?: number;
  deletedLines?: number;
  patchRef?: string;
  summary?: string;
}

export interface Delta {
  deltaId: string;
  workspaceId: string;
  branchTrackId: string;
  gitBranch: string;
  fromCheckpointId: string;
  toCheckpointId: string;
  createdAt: string;
  source: "codex_turn_end" | "manual";
  codexTurnId?: string;
  promptPreview?: string;
  changedFiles: number;
  changedLines: number;
  addedFiles: string[];
  modifiedFiles: string[];
  deletedFiles: string[];
  items: FileDelta[];
}

export interface Report {
  reportId: string;
  workspaceId: string;
  branchTrackId: string;
  gitBranch: string;
  createdAt: string;
  fromCheckpointId: string;
  toCheckpointId: string;
  trigger: ReportTrigger;
  format: "html" | "md" | "json";
  summary: string;
  path: string;
}

export interface DeltaRecord {
  deltaId: string;
  changedFiles: number;
  changedLines: number;
  fromCheckpointId: string;
  toCheckpointId: string;
  createdAt: string;
  dataRef: string;
}

export interface ReportRisk {
  severity: RiskSeverity;
  title: string;
  detail: string;
  relatedFiles?: string[];
}

export interface ReportReviewItem {
  path: string;
  priority: ReviewPriority;
  reason: string;
  patchRef?: string;
}

export interface ReportDesignAlignment {
  status: DesignAlignmentStatus;
  reason: string;
  evidence?: string;
}

export interface ReportAnalysis {
  headline: string;
  overview: string;
  intent: string;
  keyChanges: string[];
  impact: string[];
  risks: ReportRisk[];
  designAlignment: ReportDesignAlignment;
  reviewOrder: ReportReviewItem[];
  nextQuestions: string[];
  confidence: AnalysisConfidence;
  analyzerRuntime: "codex" | "heuristic";
}

export interface HookRuntimeMetadata {
  nodeExecutable: string;
  cliEntrypoint: string;
  workspacePath: string;
  forwardedNotify?: string[];
}

export interface ProjectDigestModule {
  name: string;
  paths: string[];
  purpose: string;
}

export interface ProjectDigest {
  workspaceId: string;
  generatedAt: string;
  summary: string;
  keyPaths: string[];
  modules: ProjectDigestModule[];
  designDocSummary?: string;
}

export interface GlobalProjectIndexEntry {
  workspaceId: string;
  workspaceRoot: string;
  initializedAt: string;
  lastUsedAt: string;
}

export interface RecentReportIndexEntry {
  workspaceId: string;
  workspaceRoot: string;
  reportId: string;
  reportPath: string;
  gitBranch: string;
  createdAt: string;
  summary: string;
}
