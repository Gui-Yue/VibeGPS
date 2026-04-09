import { existsSync, readFileSync } from "node:fs";
import { Command } from "commander";
import type { ProjectDigest } from "../shared";
import { openDatabase, getWorkspaceRecordByRoot, getBranchTrack, getLatestCheckpoint, getLatestReport } from "../services/db";
import { extractHooksConfigPath, extractStopHookCommands, isCodexHooksEnabled } from "../utils/codex-hooks";
import { getGitState } from "../utils/git";
import { readJson } from "../utils/json";
import { getWorkspacePaths } from "../utils/workspace";

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show current workspace VibeGPS status")
    .action(() => {
      const root = process.cwd();
      const paths = getWorkspacePaths(root);
      if (!existsSync(paths.stateDbFile)) {
        console.log("VibeGPS is not initialized in this workspace.");
        return;
      }

      const db = openDatabase(paths.stateDbFile);
      const workspace = getWorkspaceRecordByRoot(db, root);
      const gitState = getGitState(root);
      const branchTrack = workspace ? getBranchTrack(db, workspace.workspaceId, gitState.gitBranch) : undefined;
      const latestCheckpoint = branchTrack ? getLatestCheckpoint(db, branchTrack.branchTrackId) : undefined;
      const latestReport = branchTrack ? getLatestReport(db, branchTrack.branchTrackId) : undefined;

      console.log(`Workspace: ${root}`);
      console.log(`Branch: ${gitState.gitBranch}`);
      console.log(`WorkspaceId: ${workspace?.workspaceId ?? "missing"}`);
      console.log(`BranchTrack: ${branchTrack?.branchTrackId ?? "not initialized"}`);
      console.log(`Latest checkpoint: ${latestCheckpoint?.checkpointId ?? "none"}`);
      console.log(`Latest report: ${latestReport?.path ?? latestReport?.reportId ?? "none"}`);
      console.log(`Config: ${paths.configFile}`);

      const codexConfigPath = `${paths.codexDir}/config.toml`;
      if (existsSync(codexConfigPath)) {
        const configText = readFileSync(codexConfigPath, "utf8");
        console.log(`Codex config: ${codexConfigPath}`);
        console.log(`Codex hooks enabled: ${isCodexHooksEnabled(configText) ? "yes" : "no"}`);
        console.log(`Codex hooks path: ${extractHooksConfigPath(configText) ?? "missing"}`);
      } else {
        console.log("Codex config: missing");
      }

      const hooksConfigPath = `${paths.codexDir}/hooks.json`;
      if (existsSync(hooksConfigPath)) {
        try {
          const hooksConfig = readJson<unknown>(hooksConfigPath);
          const stopCommands = extractStopHookCommands(hooksConfig);
          console.log(`Codex hooks: ${hooksConfigPath}`);
          console.log(`Stop hook commands: ${stopCommands.length > 0 ? stopCommands.join(", ") : "none"}`);
        } catch {
          console.log(`Codex hooks: invalid JSON at ${hooksConfigPath}`);
        }
      } else {
        console.log("Codex hooks: missing");
      }

      if (existsSync(paths.projectDigestFile)) {
        try {
          const digest = readJson<ProjectDigest>(paths.projectDigestFile);
          console.log(`Project digest: ${digest.summary}`);
        } catch {
          console.log("Project digest: invalid cache file");
        }
      } else {
        console.log("Project digest: none");
      }

      db.close();
    });
}
