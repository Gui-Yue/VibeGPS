import { Command } from "commander";
import { runDiff } from "../services/diff-command";

export function registerDiffCommand(program: Command): void {
  program
    .command("diff")
    .description("Create a new delta and checkpoint from the current branch baseline")
    .option("--manual", "run diff manually")
    .action((options: { manual?: boolean }) => {
      const result = runDiff({
        workspaceRoot: process.cwd(),
        manual: options.manual
      });
      console.log(`Delta: ${result.deltaId}`);
      console.log(`Checkpoint: ${result.checkpointId}`);
      console.log(`Branch: ${result.gitBranch}`);
      if (result.reportPath) {
        console.log(`Report: ${result.reportPath}`);
      }
    });
}
