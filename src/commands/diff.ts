import { Command } from "commander";
import { runDiff } from "../services/diff-command";

export function registerDiffCommand(program: Command): void {
  program
    .command("diff")
    .description("Create a new delta and checkpoint from the current branch baseline")
    .option("--hook-source <source>", "hook source name")
    .option("--hook-payload-file <file>", "file containing hook payload")
    .option("--manual", "run diff manually")
    .action((options: { hookSource?: string; hookPayloadFile?: string; manual?: boolean }) => {
      const result = runDiff({
        workspaceRoot: process.cwd(),
        hookSource: options.hookSource,
        hookPayloadFile: options.hookPayloadFile,
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
