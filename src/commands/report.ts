import { existsSync } from "node:fs";
import { Command } from "commander";
import { DEFAULT_CONFIG, normalizeConfig, type VibegpsConfig } from "../shared";
import { getGitState } from "../utils/git";
import { readJson } from "../utils/json";
import { getWorkspacePaths } from "../utils/workspace";
import { resolveBranchTrack } from "../services/branch";
import { ensureWorkspaceRecord, getInitCheckpoint, getLatestCheckpoint, openDatabase } from "../services/db";
import { touchGlobalProjectIndex } from "../services/global-index";
import { generateProjectDigest } from "../services/project-digest";
import { generateReport } from "../services/report";

export function registerReportCommand(program: Command): void {
  program
    .command("report")
    .description("Generate a manual report for the current branch track")
    .action(() => {
      const root = process.cwd();
      const paths = getWorkspacePaths(root);
      if (!existsSync(paths.stateDbFile)) {
        console.log("VibeGPS is not initialized in this workspace.");
        return;
      }

      const config = existsSync(paths.configFile)
        ? normalizeConfig(readJson<VibegpsConfig>(paths.configFile))
        : normalizeConfig(DEFAULT_CONFIG);
      const db = openDatabase(paths.stateDbFile);
      const workspace = ensureWorkspaceRecord(db, root, root);
      touchGlobalProjectIndex(root, workspace.workspaceId);
      const branchTrack = resolveBranchTrack(db, workspace.workspaceId, getGitState(root));
      const initCheckpoint = getInitCheckpoint(db, branchTrack.branchTrackId);
      const latestCheckpoint = getLatestCheckpoint(db, branchTrack.branchTrackId);

      if (!initCheckpoint || !latestCheckpoint) {
        console.log("No checkpoint data found for the current branch.");
        db.close();
        return;
      }

      const report = generateReport(db, {
        workspaceId: workspace.workspaceId,
        workspaceRoot: root,
        branchTrack,
        currentCheckpoint: latestCheckpoint,
        initCheckpoint,
        config,
        reportsDir: paths.reportsDir,
        deltaPatchesDir: paths.deltaPatchesDir,
        trigger: "manual"
      });

      generateProjectDigest(root, workspace.workspaceId, paths);
      console.log(`Report: ${report.path}`);
      db.close();
    });
}
