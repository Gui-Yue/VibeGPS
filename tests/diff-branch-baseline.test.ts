import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { runDiff } from "../src/services/diff-command";
import { runInit } from "../src/services/init";
import { getBranchTrack, getInitCheckpoint, listBranchTracks, listDeltasForBranch, openDatabase } from "../src/services/db";
import type { Delta } from "../src/shared";
import { readJson } from "../src/utils/json";
import { getWorkspacePaths } from "../src/utils/workspace";
import { shellCommand } from "./test-utils";

const tempRoots: string[] = [];

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "vibegps-branch-baseline-"));
  tempRoots.push(root);
  process.env.VIBEGPS_HOME = join(root, "_global");

  shellCommand("git init", root);
  shellCommand('git config user.email "test@example.com"', root);
  shellCommand('git config user.name "VibeGPS Test"', root);
  writeFileSync(join(root, "README.md"), "# Demo Repo\n", "utf8");
  writeFileSync(join(root, "app.ts"), "export const version = 1;\n", "utf8");
  shellCommand("git add .", root);
  shellCommand('git commit -m "init repo"', root);
  shellCommand("git branch -M main", root);

  return root;
}

afterEach(() => {
  delete process.env.VIBEGPS_HOME;
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

describe("runDiff on a fresh branch", () => {
  it("auto-creates a branch baseline checkpoint and captures the first branch delta", () => {
    const root = makeRepo();
    const paths = getWorkspacePaths(root);

    const initResult = runInit(root, "C:/bin/vibegps.js");
    shellCommand("git checkout -b feature/auth", root);
    writeFileSync(join(root, "app.ts"), "export const version = 2;\nexport const feature = 'auth';\n", "utf8");
    writeFileSync(join(root, "auth.ts"), "export const authEnabled = true;\n", "utf8");

    const result = runDiff({
      workspaceRoot: root,
      manual: true
    });

    expect(result.gitBranch).toBe("feature/auth");
    expect(result.createdBranchBaseline).toBe(true);
    expect(result.deltaId).toBeTruthy();
    expect(result.checkpointId).toBeTruthy();
    expect(existsSync(paths.stateDbFile)).toBe(true);

    const db = openDatabase(paths.stateDbFile);
    try {
      const tracks = listBranchTracks(db, initResult.workspaceId);
      expect(tracks.map((track) => track.gitBranch)).toEqual(expect.arrayContaining(["main", "feature/auth"]));

      const featureTrack = getBranchTrack(db, initResult.workspaceId, "feature/auth");
      expect(featureTrack).toBeTruthy();

      const initCheckpoint = featureTrack ? getInitCheckpoint(db, featureTrack.branchTrackId) : undefined;
      expect(initCheckpoint?.kind).toBe("branch_init");

      const deltas = featureTrack ? listDeltasForBranch(db, featureTrack.branchTrackId) : [];
      expect(deltas).toHaveLength(1);

      const delta = readJson<Delta>(deltas[0]!.dataRef);
      expect(delta.changedFiles).toBeGreaterThanOrEqual(2);
      expect(delta.items.map((item) => item.path)).toEqual(expect.arrayContaining(["app.ts", "auth.ts"]));
      expect(delta.items.find((item) => item.path === "auth.ts")?.changeType).toBe("added");
      expect(delta.items.find((item) => item.path === "app.ts")?.changeType).toBe("modified");
    } finally {
      db.close();
    }
  });
});
