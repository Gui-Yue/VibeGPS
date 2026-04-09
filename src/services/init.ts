import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG, normalizeConfig, type VibegpsConfig } from "../shared";
import { patchCodexConfig, patchCodexHooksFile } from "../utils/codex-hooks";
import { createId } from "../utils/ids";
import { readJson, writeJson } from "../utils/json";
import { getGitState } from "../utils/git";
import { ensureWorkspaceDirectories, getWorkspacePaths, type WorkspacePaths } from "../utils/workspace";
import { createSnapshot } from "./snapshot";
import { openDatabase, ensureWorkspaceRecord, getLatestCheckpoint } from "./db";
import { resolveBranchTrack } from "./branch";
import { createCheckpoint } from "./checkpoint";
import { touchGlobalProjectIndex } from "./global-index";
import { generateProjectDigest } from "./project-digest";

function upsertConfig(paths: WorkspacePaths): VibegpsConfig {
  if (existsSync(paths.configFile)) {
    const normalized = normalizeConfig(readJson<VibegpsConfig>(paths.configFile));
    writeJson(paths.configFile, normalized);
    return normalized;
  }

  const normalized = normalizeConfig(DEFAULT_CONFIG);
  writeJson(paths.configFile, normalized);
  return normalized;
}

function ensureGitignore(root: string): void {
  const gitignorePath = join(root, ".gitignore");
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
  if (existing.includes(".vibegps/")) {
    return;
  }
  const next = existing.length > 0 && !existing.endsWith("\n") ? `${existing}\n.vibegps/\n` : `${existing}.vibegps/\n`;
  writeFileSync(gitignorePath, next, "utf8");
}

export interface InitResult {
  workspaceId: string;
  gitBranch: string;
  branchTrackId: string;
  checkpointId: string;
  workspaceRoot: string;
}

export function runInit(workspaceRoot: string, _cliEntrypoint: string): InitResult {
  const paths = getWorkspacePaths(workspaceRoot);
  ensureWorkspaceDirectories(paths);
  ensureGitignore(workspaceRoot);
  const config = upsertConfig(paths);

  const db = openDatabase(paths.stateDbFile);
  const workspace = ensureWorkspaceRecord(db, createId("ws"), workspaceRoot);
  const gitState = getGitState(workspaceRoot);
  const branchTrack = resolveBranchTrack(db, workspace.workspaceId, gitState);

  patchCodexConfig(paths);
  patchCodexHooksFile(paths);

  const existingInit = getLatestCheckpoint(db, branchTrack.branchTrackId);
  if (!existingInit) {
    const snapshot = createSnapshot(workspace.workspaceId, paths, config.tracking);
    createCheckpoint(db, {
      workspaceId: workspace.workspaceId,
      branchTrack,
      snapshot,
      checkpointsDir: paths.checkpointsDir,
      kind: "init"
    });
  }

  const latestCheckpoint = getLatestCheckpoint(db, branchTrack.branchTrackId);
  db.close();
  generateProjectDigest(workspaceRoot, workspace.workspaceId, paths);
  touchGlobalProjectIndex(workspaceRoot, workspace.workspaceId);

  return {
    workspaceId: workspace.workspaceId,
    gitBranch: branchTrack.gitBranch,
    branchTrackId: branchTrack.branchTrackId,
    checkpointId: latestCheckpoint?.checkpointId ?? "",
    workspaceRoot
  };
}
