import { spawnSync } from "node:child_process";

export function shellCommand(command: string, cwd: string): void {
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: "utf8",
    stdio: "pipe"
  });

  if (result.status !== 0) {
    throw new Error(`Command failed: ${command}\n${result.stderr || result.stdout}`);
  }
}
