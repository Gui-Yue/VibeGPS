import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { runDiff } from "./diff-command";
import { getWorkspacePaths } from "../utils/workspace";

export interface StopHookOutput {
  continue: true;
  reportPath: string | null;
  systemMessage: string | null;
  error?: string;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return "";
  }

  let content = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    content += chunk;
  }
  return content;
}

function parseTurnId(payloadText: string): string {
  try {
    const payload = payloadText ? JSON.parse(payloadText) as { turn_id?: unknown } : {};
    return typeof payload.turn_id === "string" ? payload.turn_id : "";
  } catch {
    return "";
  }
}

function sanitizeTurnId(turnId: string): string {
  return turnId.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function buildSystemMessage(reportPath: string): string {
  return `[VibeGPS] Report ready: ${reportPath}\nOpen in browser: xdg-open ${JSON.stringify(reportPath)}`;
}

export async function runStopHook(workspaceRoot: string): Promise<StopHookOutput> {
  const paths = getWorkspacePaths(workspaceRoot);
  const logPath = join(paths.logsDir, "codex-stop-hook.log");
  mkdirSync(paths.tmpDir, { recursive: true });
  mkdirSync(paths.logsDir, { recursive: true });

  try {
    const payloadText = await readStdin();
    const turnId = parseTurnId(payloadText);
    const safeTurnId = sanitizeTurnId(turnId);
    const payloadFile = join(paths.tmpDir, safeTurnId ? `stop-${safeTurnId}.json` : "hook-payload-latest.json");
    const hookOutputFile = join(paths.tmpDir, safeTurnId ? `stop-${safeTurnId}.hook.json` : "hook-output-latest.json");

    writeFileSync(payloadFile, payloadText, "utf8");

    const diffResult = runDiff({
      workspaceRoot,
      hookSource: "codex_stop",
      hookPayloadFile: payloadFile,
      hookTurnId: turnId || undefined
    });

    const output: StopHookOutput = diffResult.reportPath
      ? {
          continue: true,
          reportPath: diffResult.reportPath,
          systemMessage: buildSystemMessage(diffResult.reportPath)
        }
      : {
          continue: true,
          reportPath: null,
          systemMessage: null
        };

    writeFileSync(hookOutputFile, JSON.stringify(output, null, 2), "utf8");
    return output;
  } catch (error) {
    const output: StopHookOutput = {
      continue: true,
      reportPath: null,
      systemMessage: null,
      error: String(error instanceof Error ? error.message : error)
    };
    writeFileSync(join(paths.tmpDir, "hook-output-latest.json"), JSON.stringify(output, null, 2), "utf8");
    appendFileSync(
      logPath,
      `[${new Date().toISOString()}] stop hook failure\n${String(error instanceof Error && error.stack ? error.stack : error)}\n\n`,
      "utf8"
    );
    return output;
  }
}
