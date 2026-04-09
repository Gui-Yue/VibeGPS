import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { runInit } from "../src/services/init";
import { listIndexedProjects } from "../src/services/global-index";
import { getWorkspacePaths } from "../src/utils/workspace";
import { readJson } from "../src/utils/json";
import { openDatabase, getLatestCheckpoint, listBranchTracks } from "../src/services/db";
import type { HookRuntimeMetadata, ProjectDigest } from "../src/shared";
import { shellCommand } from "./test-utils";

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

afterEach(() => {
  delete process.env.VIBEGPS_HOME;
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

describe("runInit", () => {
  it("creates the workspace, hook shim, initial checkpoint, digest, and global index", () => {
    const root = makeRepo();
    const paths = getWorkspacePaths(root);

    const first = runInit(root, "C:/bin/vibegps.js");
    const second = runInit(root, "C:/bin/vibegps.js");

    expect(first.workspaceRoot).toBe(root);
    expect(second.workspaceId).toBe(first.workspaceId);
    expect(existsSync(paths.vibegpsDir)).toBe(true);
    expect(existsSync(paths.configFile)).toBe(true);
    expect(existsSync(paths.stateDbFile)).toBe(true);
    expect(existsSync(join(paths.hooksDir, "codex-turn-end.js"))).toBe(true);
    expect(existsSync(paths.projectDigestFile)).toBe(true);

    const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
    expect(gitignore).toContain(".vibegps/");

    const codexConfig = readFileSync(join(paths.codexDir, "config.toml"), "utf8");
    expect(codexConfig).toContain("# vibegps:start");
    expect(codexConfig).toContain('notify = ["node"');

    const runtime = readJson<HookRuntimeMetadata>(join(paths.hooksDir, "runtime.json"));
    expect(runtime.cliEntrypoint).toBe("C:/bin/vibegps.js");
    expect(runtime.workspacePath).toBe(root);

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
});
