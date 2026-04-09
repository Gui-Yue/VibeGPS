import { existsSync } from "node:fs";
import { Command } from "commander";
import { getWorkspacePaths } from "../utils/workspace";
import { openDatabase, ensureWorkspaceRecord, listBranchTracks } from "../services/db";

export function registerBranchesCommand(program: Command): void {
  program
    .command("branches")
    .description("List tracked branch tracks in the current workspace")
    .action(() => {
      const root = process.cwd();
      const paths = getWorkspacePaths(root);
      if (!existsSync(paths.stateDbFile)) {
        console.log("VibeGPS is not initialized in this workspace.");
        return;
      }

      const db = openDatabase(paths.stateDbFile);
      const workspace = ensureWorkspaceRecord(db, root, root);
      const tracks = listBranchTracks(db, workspace.workspaceId);

      if (tracks.length === 0) {
        console.log("No branch tracks found.");
      } else {
        for (const track of tracks) {
          console.log(`${track.gitBranch} -> ${track.branchTrackId}`);
        }
      }

      db.close();
    });
}
