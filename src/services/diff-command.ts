import { readFileSync } from "node:fs";
import { DEFAULT_CONFIG, normalizeConfig, type Snapshot, type VibegpsConfig } from "../shared";
import { getGitState } from "../utils/git";
import { readJson } from "../utils/json";
import { getWorkspacePaths } from "../utils/workspace";
import { resolveBranchTrack } from "./branch";
import { createCheckpoint } from "./checkpoint";
import { getInitCheckpoint, getLatestCheckpoint, insertDelta, openDatabase, ensureWorkspaceRecord } from "./db";
import { buildDelta } from "./delta";
import { touchGlobalProjectIndex } from "./global-index";
import { generateProjectDigest } from "./project-digest";
import { generateReport, resolveReportWindow, shouldTriggerReport } from "./report";
import { createEmptySnapshot, createSnapshot, createSnapshotFromGitHead } from "./snapshot";

export interface DiffOptions {
  workspaceRoot: string;
  hookSource?: string;
  hookPayloadFile?: string;
  hookTurnId?: string;
  manual?: boolean;
}

export interface DiffResult {
  deltaId: string;
  checkpointId: string;
  gitBranch: string;
  reportPath?: string;
  createdBranchBaseline?: boolean;
}

function loadConfig(configFile: string): VibegpsConfig {
  try {
    return normalizeConfig(readJson<VibegpsConfig>(configFile));
  } catch {
    return normalizeConfig(DEFAULT_CONFIG);
  }
}

export function runDiff(options: DiffOptions): DiffResult {
  const paths = getWorkspacePaths(options.workspaceRoot);
  const db = openDatabase(paths.stateDbFile);
  const workspace = ensureWorkspaceRecord(db, options.workspaceRoot, options.workspaceRoot);
  touchGlobalProjectIndex(options.workspaceRoot, workspace.workspaceId);
  const config = loadConfig(paths.configFile);
  const gitState = getGitState(options.workspaceRoot);
  const branchTrack = resolveBranchTrack(db, workspace.workspaceId, gitState);
  let baseline = getLatestCheckpoint(db, branchTrack.branchTrackId);
  let createdBranchBaseline = false;

  if (!baseline) {
    baseline = createCheckpoint(db, {
      workspaceId: workspace.workspaceId,
      branchTrack,
      snapshot: gitState.gitHead
        ? createSnapshotFromGitHead(workspace.workspaceId, paths, gitState.gitHead)
        : createEmptySnapshot(workspace.workspaceId),
      checkpointsDir: paths.checkpointsDir,
      kind: "branch_init",
      triggerRef: {
        source: options.manual ? "manual" : "codex_hook"
      }
    });
    createdBranchBaseline = true;
  }

  const beforeSnapshot = readJson<Snapshot>(baseline.snapshotRef);
  const afterSnapshot = createSnapshot(workspace.workspaceId, paths, config.tracking);
  const nextCheckpoint = createCheckpoint(db, {
    workspaceId: workspace.workspaceId,
    branchTrack,
    snapshot: afterSnapshot,
    checkpointsDir: paths.checkpointsDir,
    kind: "turn_end",
    parentCheckpointId: baseline.checkpointId,
    triggerRef: {
      source: options.manual ? "manual" : "codex_hook",
      turnId: options.hookTurnId
    }
  });

  const promptPreview = options.hookPayloadFile ? readFileSync(options.hookPayloadFile, "utf8").slice(0, 200) : undefined;
  const { delta, deltaPath } = buildDelta({
    workspaceId: workspace.workspaceId,
    branchTrackId: branchTrack.branchTrackId,
    gitBranch: branchTrack.gitBranch,
    fromCheckpointId: baseline.checkpointId,
    toCheckpointId: nextCheckpoint.checkpointId,
    source: options.manual ? "manual" : "codex_turn_end",
    snapshotBefore: beforeSnapshot,
    snapshotAfter: afterSnapshot,
    snapshotContentDir: paths.snapshotsContentDir,
    deltasDir: paths.deltasDir,
    deltaPatchesDir: paths.deltaPatchesDir,
    promptPreview,
    codexTurnId: options.hookTurnId
  });

  insertDelta(db, delta, deltaPath);

  let reportPath: string | undefined;
  const initCheckpoint = getInitCheckpoint(db, branchTrack.branchTrackId);
  if (initCheckpoint) {
    const window = resolveReportWindow(db, branchTrack.branchTrackId, initCheckpoint, nextCheckpoint);
    if (shouldTriggerReport(config, window.aggregate)) {
      const report = generateReport(db, {
        workspaceId: workspace.workspaceId,
        workspaceRoot: options.workspaceRoot,
        branchTrack,
        currentCheckpoint: nextCheckpoint,
        initCheckpoint,
        config,
        reportsDir: paths.reportsDir,
        deltaPatchesDir: paths.deltaPatchesDir,
        trigger: "threshold"
      });
      reportPath = report.path;
    }
  }

  db.close();
  generateProjectDigest(options.workspaceRoot, workspace.workspaceId, paths);
  return {
    deltaId: delta.deltaId,
    checkpointId: nextCheckpoint.checkpointId,
    gitBranch: branchTrack.gitBranch,
    reportPath,
    createdBranchBaseline
  };
}
