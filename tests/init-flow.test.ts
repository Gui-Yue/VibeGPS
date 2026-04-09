import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { runInit } from "../src/services/init";
import { listIndexedProjects } from "../src/services/global-index";
import { getWorkspacePaths } from "../src/utils/workspace";
import { readJson } from "../src/utils/json";
import { openDatabase, getLatestCheckpoint, listBranchTracks } from "../src/services/db";
import type { ProjectDigest } from "../src/shared";
import { MANAGED_HOOK_COMMAND } from "../src/utils/codex-hooks";
import { shellCommand } from "./test-utils";
import { getGitState } from "../src/utils/git";

const tempRoots: string[] = [];

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "vibegps-init-"));
  tempRoots.push(root);
  process.env.VIBEGPS_HOME = join(root, "_global");

  shellCommand("git init", root);
  shellCommand('git config user.email "test@example.com"', root);
  shellCommand('git config user.name "VibeGPS Test"', root);

  writeFileSync(join(root, "README.md"), "# Demo Repo\n\n用于验证 init 流程。\n", "utf8");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "demo-repo", description: "init flow" }, null, 2), "utf8");
  writeFileSync(join(root, "index.ts"), "export const demo = 1;\n", "utf8");

  shellCommand("git add .", root);
  shellCommand('git commit -m "init repo"', root);

  return root;
}

function makeRepoWithoutCommit(): string {
  const root = mkdtempSync(join(tmpdir(), "vibegps-init-unborn-"));
  tempRoots.push(root);
  process.env.VIBEGPS_HOME = join(root, "_global");

  shellCommand("git init", root);
  shellCommand('git config user.email "test@example.com"', root);
  shellCommand('git config user.name "VibeGPS Test"', root);

  writeFileSync(join(root, "README.md"), "# Demo Repo\n\nunborn branch init.\n", "utf8");
  writeFileSync(join(root, "index.ts"), "export const demo = 1;\n", "utf8");

  return root;
}

afterEach(() => {
  delete process.env.VIBEGPS_HOME;
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

describe("runInit", () => {
  it("creates the workspace, Stop hook config, initial checkpoint, digest, and global index", () => {
    const root = makeRepo();
    const paths = getWorkspacePaths(root);

    const first = runInit(root, "C:/bin/vibegps.js");
    const second = runInit(root, "C:/bin/vibegps.js");

    expect(first.workspaceRoot).toBe(root);
    expect(second.workspaceId).toBe(first.workspaceId);
    expect(existsSync(paths.vibegpsDir)).toBe(true);
    expect(existsSync(paths.configFile)).toBe(true);
    expect(existsSync(paths.stateDbFile)).toBe(true);
    expect(existsSync(join(paths.codexDir, "hooks.json"))).toBe(true);
    expect(existsSync(paths.projectDigestFile)).toBe(true);
    expect(existsSync(join(paths.hooksDir, "codex-stop-hook.js"))).toBe(false);
    expect(existsSync(join(paths.hooksDir, "runtime.json"))).toBe(false);

    const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
    expect(gitignore).toContain(".vibegps/");

    const codexConfig = readFileSync(join(paths.codexDir, "config.toml"), "utf8");
    expect(codexConfig).toContain("# vibegps:start");
    expect(codexConfig).toContain('hooks = "./hooks.json"');
    expect(codexConfig).toContain("codex_hooks = true");

    const hooksConfig = readJson<Record<string, unknown>>(join(paths.codexDir, "hooks.json"));
    expect((hooksConfig.hooks as Record<string, unknown> | undefined)?.Stop).toBeTruthy();
    expect(JSON.stringify(hooksConfig)).toContain(MANAGED_HOOK_COMMAND);

    const digest = readJson<ProjectDigest>(paths.projectDigestFile);
    expect(digest.summary).toContain("demo-repo");

    const db = openDatabase(paths.stateDbFile);
    try {
      const tracks = listBranchTracks(db, first.workspaceId);
      expect(tracks).toHaveLength(1);
      const latestCheckpoint = getLatestCheckpoint(db, tracks[0]!.branchTrackId);
      expect(latestCheckpoint?.kind).toBe("init");
    } finally {
      db.close();
    }

    const indexedProjects = listIndexedProjects();
    expect(indexedProjects).toHaveLength(1);
    expect(indexedProjects[0]?.workspaceRoot).toBe(root);
  });

  it("initializes cleanly in a git repo with an unborn HEAD", () => {
    const root = makeRepoWithoutCommit();
    const paths = getWorkspacePaths(root);

    const gitState = getGitState(root);
    const result = runInit(root, "C:/bin/vibegps.js");

    expect(gitState.branchType).toBe("named");
    expect(gitState.gitBranch).not.toBe("HEAD");
    expect(gitState.gitHead).toBeNull();
    expect(result.gitBranch).toBe(gitState.gitBranch);
    expect(existsSync(paths.stateDbFile)).toBe(true);

    const db = openDatabase(paths.stateDbFile);
    try {
      const tracks = listBranchTracks(db, result.workspaceId);
      expect(tracks).toHaveLength(1);
      expect(tracks[0]?.gitBranch).toBe(gitState.gitBranch);
      expect(tracks[0]?.gitHead).toBeNull();

      const latestCheckpoint = getLatestCheckpoint(db, tracks[0]!.branchTrackId);
      expect(latestCheckpoint?.kind).toBe("init");
      expect(latestCheckpoint?.gitHead ?? null).toBeNull();
    } finally {
      db.close();
    }
  });

  it("writes the managed Stop hook command instead of generating a shim", () => {
    const root = makeRepo();
    const paths = getWorkspacePaths(root);
    runInit(root, "C:/bin/vibegps.js");

    const hooksConfig = readJson<Record<string, unknown>>(join(paths.codexDir, "hooks.json"));
    expect(JSON.stringify(hooksConfig)).toContain(MANAGED_HOOK_COMMAND);
    expect(existsSync(join(paths.hooksDir, "codex-stop-hook.js"))).toBe(false);
    expect(existsSync(join(paths.hooksDir, "runtime.json"))).toBe(false);
  });
});
