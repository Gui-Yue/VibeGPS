import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, normalize } from "node:path";
import { Command } from "commander";
import { DEFAULT_CONFIG, normalizeConfig, type VibegpsConfig } from "../shared";
import { getWorkspaceRecordByRoot, getBranchTrack, getLatestCheckpoint, getLatestReport, openDatabase } from "../services/db";
import { getGlobalIndexRoot } from "../services/global-index";
import {
  extractHooksConfigPath,
  extractStopHookCommands,
  getExpectedHooksConfigPath,
  getExpectedStopHookCommand,
  isCodexHooksEnabled,
  resolveHooksConfigPath,
  validateManagedStopHookCommand
} from "../utils/codex-hooks";
import { readJson } from "../utils/json";
import { getGitState } from "../utils/git";
import { getWorkspacePaths } from "../utils/workspace";

function checkCommand(name: string, args: string[] = ["--version"]): boolean {
  const result = spawnSync(name, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return result.status === 0;
}

function ok(label: string, detail: string): void {
  console.log(`[ok] ${label}: ${detail}`);
}

function warn(label: string, detail: string): void {
  console.log(`[warn] ${label}: ${detail}`);
}

function fail(label: string, detail: string): void {
  console.log(`[fail] ${label}: ${detail}`);
}

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Diagnose whether the current workspace is ready for VibeGPS tracking")
    .action(() => {
      const root = process.cwd();
      const paths = getWorkspacePaths(root);
      let hasFailure = false;

      console.log(`Workspace: ${root}`);
      console.log(`Global index root: ${getGlobalIndexRoot()}`);
      console.log("");

      if (checkCommand("git")) {
        ok("git", "git executable is available");
      } else {
        fail("git", "git executable is not available in PATH");
        hasFailure = true;
      }

      if (checkCommand("codex")) {
        ok("codex", "codex executable is available");
      } else {
        warn("codex", "codex executable is not available in PATH");
      }

      try {
        const gitState = getGitState(root);
        ok("repository", `inside git repo on branch ${gitState.gitBranch}`);
      } catch {
        fail("repository", "current directory is not a valid git repository");
        hasFailure = true;
      }

      if (existsSync(paths.vibegpsDir)) {
        ok("workspace", ".vibegps directory exists");
      } else {
        fail("workspace", ".vibegps directory is missing, run `vibegps init`");
        hasFailure = true;
      }

      let config: VibegpsConfig | undefined;
      if (existsSync(paths.configFile)) {
        try {
          config = normalizeConfig(readJson<VibegpsConfig>(paths.configFile));
          ok("config", `loaded config, analyzer=${config.report.analyzer}, format=${config.report.defaultFormat}`);
        } catch {
          fail("config", "failed to parse .vibegps/config.json");
          hasFailure = true;
        }
      } else {
        fail("config", ".vibegps/config.json is missing");
        hasFailure = true;
      }

      if (existsSync(paths.stateDbFile)) {
        try {
          const db = openDatabase(paths.stateDbFile);
          const workspace = getWorkspaceRecordByRoot(db, root);
          const branchTrack = workspace ? getBranchTrack(db, workspace.workspaceId, getGitState(root).gitBranch) : undefined;
          const latestCheckpoint = branchTrack ? getLatestCheckpoint(db, branchTrack.branchTrackId) : undefined;
          const latestReport = branchTrack ? getLatestReport(db, branchTrack.branchTrackId) : undefined;
          ok(
            "database",
            `state.db is readable${workspace ? `, workspaceId=${workspace.workspaceId}` : ""}${branchTrack ? `, branchTrack=${branchTrack.branchTrackId}` : ""}${latestCheckpoint ? `, checkpoint=${latestCheckpoint.checkpointId}` : ""}${latestReport ? `, report=${latestReport.reportId}` : ""}`
          );
          db.close();
        } catch {
          fail("database", "failed to open or query .vibegps/state.db");
          hasFailure = true;
        }
      } else {
        fail("database", ".vibegps/state.db is missing");
        hasFailure = true;
      }

      const codexConfigPath = join(paths.codexDir, "config.toml");
      if (existsSync(codexConfigPath)) {
        const configText = readFileSync(codexConfigPath, "utf8");
        const managed = configText.includes("# vibegps:start") && configText.includes("# vibegps:end");
        const configuredHooksPath = extractHooksConfigPath(configText);
        const expectedHooksPath = getExpectedHooksConfigPath(paths);

        if (managed && isCodexHooksEnabled(configText) && configuredHooksPath) {
          const resolvedHooksPath = resolveHooksConfigPath(root, configuredHooksPath);
          if (!existsSync(resolvedHooksPath)) {
            fail("codex hook", `hooks config points to a missing file: ${configuredHooksPath}`);
            hasFailure = true;
          } else if (normalize(resolvedHooksPath) !== expectedHooksPath) {
            warn("codex hook", `hooks config resolves to ${resolvedHooksPath}; expected ${expectedHooksPath}.`);
          } else {
            try {
              const hooksConfig = readJson<unknown>(resolvedHooksPath);
              const stopCommands = extractStopHookCommands(hooksConfig);
              const expectedCommand = getExpectedStopHookCommand();
              const managedCommand = stopCommands.find((command) => validateManagedStopHookCommand(command));

              if (!managedCommand) {
                warn("codex hook", `Stop hook is enabled, but no managed VibeGPS command matches \`${expectedCommand}\`.`);
              } else {
                ok("codex hook", `Stop hook is configured via ${configuredHooksPath} -> ${managedCommand}`);
              }
            } catch {
              fail("codex hook", "failed to parse .codex/hooks.json");
              hasFailure = true;
            }
          }
        } else {
          warn("codex hook", "managed Stop hook config was not found or codex_hooks is not enabled");
        }
      } else {
        warn("codex hook", ".codex/config.toml is missing; run `vibegps init` to install the Stop hook");
      }

      if (existsSync(paths.projectDigestFile)) {
        ok("project digest", "cached project digest is available");
      } else {
        warn("project digest", "project digest is missing and will be regenerated on init/report");
      }

      console.log("");
      if (hasFailure) {
        console.log("Doctor summary: failures detected. Run `vibegps init` or fix the failed items above.");
        process.exitCode = 1;
        return;
      }

      console.log("Doctor summary: workspace is ready for VibeGPS tracking.");
    });
}
