import { existsSync } from "node:fs";
import { Command } from "commander";
import type { ProjectDigest } from "../shared";
import { openDatabase, getWorkspaceRecordByRoot, getBranchTrack, getLatestCheckpoint, getLatestReport } from "../services/db";
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
      console.log(`Latest report: ${latestReport?.reportId ?? "none"}`);
      console.log(`Config: ${paths.configFile}`);
      console.log(`Hook shim: ${existsSync(paths.hooksDir) ? `${paths.hooksDir}\\codex-turn-end.js` : "missing"}`);

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
