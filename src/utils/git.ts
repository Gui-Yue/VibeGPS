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

function tryRunGit(root: string, args: string[]): string | null {
  try {
    return runGit(root, args);
  } catch {
    return null;
  }
}

export function getGitState(root: string): GitState {
  // Ensure we still fail fast when the current directory is not a git repository.
  runGit(root, ["rev-parse", "--git-dir"]);

  const branchName = tryRunGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const gitHead = tryRunGit(root, ["rev-parse", "--verify", "HEAD"]);

  if (branchName) {
    return {
      gitBranch: branchName,
      gitHead,
      branchType: "named"
    };
  }

  if (gitHead) {
    return {
      gitBranch: `detached:${gitHead.slice(0, 12)}`,
      gitHead,
      branchType: "detached"
    };
  }

  throw new Error("Failed to resolve git branch or HEAD.");
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
