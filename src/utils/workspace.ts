import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { CODEX_DIRNAME, VIBEGPS_DIRNAME } from "../shared";

export interface WorkspacePaths {
  root: string;
  vibegpsDir: string;
  codexDir: string;
  configFile: string;
  stateDbFile: string;
  checkpointsDir: string;
  snapshotsContentDir: string;
  deltasDir: string;
  deltaPatchesDir: string;
  reportsDir: string;
  hooksDir: string;
  cacheDir: string;
  projectDigestFile: string;
  logsDir: string;
  tmpDir: string;
}

export function getWorkspacePaths(root: string): WorkspacePaths {
  const vibegpsDir = join(root, VIBEGPS_DIRNAME);
  return {
    root,
    vibegpsDir,
    codexDir: join(root, CODEX_DIRNAME),
    configFile: join(vibegpsDir, "config.json"),
    stateDbFile: join(vibegpsDir, "state.db"),
    checkpointsDir: join(vibegpsDir, "checkpoints"),
    snapshotsContentDir: join(vibegpsDir, "checkpoints", "_snapshot_files"),
    deltasDir: join(vibegpsDir, "deltas"),
    deltaPatchesDir: join(vibegpsDir, "deltas", "_patches"),
    reportsDir: join(vibegpsDir, "reports"),
    hooksDir: join(vibegpsDir, "hooks"),
    cacheDir: join(vibegpsDir, "cache"),
    projectDigestFile: join(vibegpsDir, "cache", "project-digest.json"),
    logsDir: join(vibegpsDir, "logs"),
    tmpDir: join(vibegpsDir, "tmp")
  };
}

export function ensureWorkspaceDirectories(paths: WorkspacePaths): void {
  const dirs = [
    paths.vibegpsDir,
    paths.codexDir,
    paths.checkpointsDir,
    paths.snapshotsContentDir,
    paths.deltasDir,
    paths.deltaPatchesDir,
    paths.reportsDir,
    paths.hooksDir,
    paths.cacheDir,
    paths.logsDir,
    paths.tmpDir
  ];

  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
  }
}
