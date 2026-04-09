import { Command } from "commander";
import { runStopHook } from "../services/hook-stop";

export function registerHookStopCommand(program: Command): void {
  program
    .command("hook-stop")
    .description("Internal Codex Stop hook entrypoint")
    .action(async () => {
      const output = await runStopHook(process.cwd());
      if (output.systemMessage) {
        process.stdout.write(JSON.stringify(output));
      }
    });
}
