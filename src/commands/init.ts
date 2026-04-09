import { Command } from "commander";
import { runInit } from "../services/init";

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Initialize .vibegps and connect the Codex Stop hook")
    .action(() => {
      const result = runInit(process.cwd(), process.argv[1]);
      console.log(`Initialized VibeGPS in ${result.workspaceRoot}`);
      console.log(`Branch: ${result.gitBranch}`);
      console.log(`BranchTrack: ${result.branchTrackId}`);
      console.log(`Checkpoint: ${result.checkpointId}`);
    });
}
