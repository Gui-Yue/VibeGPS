import { execFileSync } from "node:child_process";
import type { GitState } from "../shared";

function runGit(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function runGitBuffer(root: string, args: string[]): Buffer {
  return execFileSync("git", args, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

export function getGitState(root: string): GitState {
  const branchName = runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const gitHead = runGit(root, ["rev-parse", "HEAD"]);

  if (branchName === "HEAD") {
    return {
      gitBranch: `detached:${gitHead.slice(0, 12)}`,
      gitHead,
      branchType: "detached"
    };
  }

  return {
    gitBranch: branchName,
    gitHead,
    branchType: "named"
  };
}

export function listGitHeadFiles(root: string, gitRef: string): string[] {
  const output = runGit(root, ["ls-tree", "-r", "--name-only", gitRef]);
  if (output.length === 0) {
    return [];
  }

  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function readGitHeadFile(root: string, gitRef: string, filePath: string): Buffer {
  return runGitBuffer(root, ["show", `${gitRef}:${filePath}`]);
}
