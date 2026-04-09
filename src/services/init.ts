import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG, MANAGED_NOTIFY_END, MANAGED_NOTIFY_START, normalizeConfig, type HookRuntimeMetadata, type VibegpsConfig } from "../shared";
import { createId } from "../utils/ids";
import { readJson, writeJson } from "../utils/json";
import { extractNotifyCommand } from "../utils/notify";
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

function renderHookShim(): string {
  return `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const { mkdirSync, writeFileSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

const root = process.cwd();
const runtimePath = join(root, ".vibegps", "hooks", "runtime.json");
const runtime = JSON.parse(readFileSync(runtimePath, "utf8"));
const stdin = process.stdin.isTTY ? "" : readFileSync(0, "utf8");
const payload = process.argv.slice(2).join(" ") || stdin;
const payloadPath = join(root, ".vibegps", "tmp", "hook-payload-latest.json");
mkdirSync(join(root, ".vibegps", "tmp"), { recursive: true });
writeFileSync(payloadPath, payload, "utf8");

const diffResult = spawnSync(runtime.nodeExecutable, [runtime.cliEntrypoint, "diff", "--hook-source", "codex_notify", "--hook-payload-file", payloadPath], {
  cwd: runtime.workspacePath,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"]
});

if (diffResult.stdout) {
  process.stdout.write(diffResult.stdout);
}
if (diffResult.stderr) {
  process.stderr.write(diffResult.stderr);
}

const combinedOutput = [diffResult.stdout || "", diffResult.stderr || ""].join("\\n");
const reportMatch = combinedOutput.match(/^Report:\\s+(.+)$/m);
if (reportMatch) {
  process.stdout.write("\\n[VibeGPS] Turn report ready\\n");
  process.stdout.write("[VibeGPS] Review HTML: " + reportMatch[1] + "\\n");
  process.stdout.write("[VibeGPS] Open it before the next prompt if you want to inspect this turn's impact.\\n\\n");
}

if (Array.isArray(runtime.forwardedNotify) && runtime.forwardedNotify.length > 0) {
  const [command, ...args] = runtime.forwardedNotify;
  spawnSync(command, args, {
    cwd: runtime.workspacePath,
    stdio: "inherit"
  });
}
`;
}

function patchCodexConfig(paths: WorkspacePaths, runtimeMetadata: HookRuntimeMetadata): void {
  const configPath = join(paths.codexDir, "config.toml");
  const existing = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const forwardedNotify = extractNotifyCommand(existing);
  const shimPath = join(paths.hooksDir, "codex-turn-end.js").replaceAll("\\", "/");
  const managedBlock = `${MANAGED_NOTIFY_START}\nnotify = ["node", "${shimPath}"]\n${MANAGED_NOTIFY_END}`;
  const withoutManagedBlock = existing.replace(new RegExp(`${MANAGED_NOTIFY_START}[\\s\\S]*?${MANAGED_NOTIFY_END}\\n?`, "g"), "");
  const withoutNotify = withoutManagedBlock.replace(/^\s*notify\s*=\s*\[[^\n]+\]\s*$/m, "").trimEnd();
  const nextConfig = [withoutNotify, managedBlock].filter(Boolean).join("\n\n") + "\n";

  writeFileSync(configPath, nextConfig, "utf8");
  writeJson(join(paths.hooksDir, "runtime.json"), {
    ...runtimeMetadata,
    forwardedNotify
  });
}

export interface InitResult {
  workspaceId: string;
  gitBranch: string;
  branchTrackId: string;
  checkpointId: string;
  workspaceRoot: string;
}

export function runInit(workspaceRoot: string, cliEntrypoint: string): InitResult {
  const paths = getWorkspacePaths(workspaceRoot);
  ensureWorkspaceDirectories(paths);
  ensureGitignore(workspaceRoot);
  const config = upsertConfig(paths);
  writeFileSync(join(paths.hooksDir, "codex-turn-end.js"), renderHookShim(), "utf8");

  const db = openDatabase(paths.stateDbFile);
  const workspace = ensureWorkspaceRecord(db, createId("ws"), workspaceRoot);
  const gitState = getGitState(workspaceRoot);
  const branchTrack = resolveBranchTrack(db, workspace.workspaceId, gitState);

  patchCodexConfig(paths, {
    nodeExecutable: process.execPath,
    cliEntrypoint,
    workspacePath: workspaceRoot
  });

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
