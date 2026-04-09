import { Command } from "commander";
import { registerBranchesCommand } from "./commands/branches";
import { registerDoctorCommand } from "./commands/doctor";
import { registerDiffCommand } from "./commands/diff";
import { registerHookStopCommand } from "./commands/hook-stop";
import { registerInitCommand } from "./commands/init";
import { registerLsCommand } from "./commands/ls";
import { registerReportCommand } from "./commands/report";
import { registerStatusCommand } from "./commands/status";

export function buildCli(): Command {
  const program = new Command();
  program.name("vibegps").description("Branch-aware evolution tracking for Codex vibecoding").version("0.1.0");

  registerInitCommand(program);
  registerDiffCommand(program);
  registerHookStopCommand(program);
  registerStatusCommand(program);
  registerBranchesCommand(program);
  registerReportCommand(program);
  registerLsCommand(program);
  registerDoctorCommand(program);

  return program;
}
