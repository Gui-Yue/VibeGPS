import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { Snapshot } from "../src/shared";
import { buildDelta } from "../src/services/delta";

function writeTextFile(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
}

describe("buildDelta", () => {
  it("generates line-aware patch artifacts for text modifications", () => {
    const root = mkdtempSync(join(tmpdir(), "vibegps-delta-"));
    const snapshotContentDir = join(root, "_snapshot_files");
    const deltaPatchesDir = join(root, "_patches");
    const deltasDir = join(root, "deltas");

    mkdirSync(snapshotContentDir, { recursive: true });
    mkdirSync(deltaPatchesDir, { recursive: true });
    mkdirSync(deltasDir, { recursive: true });

    const beforeRef = "snap_before/src/app.ts";
    const afterRef = "snap_after/src/app.ts";
    writeTextFile(join(snapshotContentDir, ...beforeRef.split("/")), "const a = 1;\nconsole.log(a);\n");
    writeTextFile(join(snapshotContentDir, ...afterRef.split("/")), "const a = 2;\nconsole.log(a);\nconsole.log('done');\n");

    const beforeSnapshot: Snapshot = {
      snapshotId: "snap_before",
      workspaceId: "ws_1",
      createdAt: "2026-04-09T00:00:00.000Z",
      fileCount: 1,
      entries: [
        {
          path: "src/app.ts",
          hash: "before_hash",
          size: 30,
          mtimeMs: 0,
          kind: "text",
          lineCount: 2,
          contentRef: beforeRef
        }
      ]
    };

    const afterSnapshot: Snapshot = {
      snapshotId: "snap_after",
      workspaceId: "ws_1",
      createdAt: "2026-04-09T00:01:00.000Z",
      fileCount: 1,
      entries: [
        {
          path: "src/app.ts",
          hash: "after_hash",
          size: 54,
          mtimeMs: 1,
          kind: "text",
          lineCount: 3,
          contentRef: afterRef
        }
      ]
    };

    try {
      const { delta, deltaPath } = buildDelta({
        workspaceId: "ws_1",
        branchTrackId: "bt_1",
        gitBranch: "main",
        fromCheckpointId: "cp_1",
        toCheckpointId: "cp_2",
        source: "manual",
        snapshotBefore: beforeSnapshot,
        snapshotAfter: afterSnapshot,
        snapshotContentDir,
        deltasDir,
        deltaPatchesDir
      });

      expect(delta.changedFiles).toBe(1);
      expect(delta.changedLines).toBe(3);
      expect(delta.items[0]?.changeType).toBe("modified");
      expect(delta.items[0]?.patchRef).toBeTruthy();
      expect(delta.items[0]?.addedLines).toBe(2);
      expect(delta.items[0]?.deletedLines).toBe(1);
      expect(existsSync(deltaPath)).toBe(true);

      const patchPath = join(deltaPatchesDir, ...(delta.items[0]?.patchRef?.split("/") ?? []));
      expect(existsSync(patchPath)).toBe(true);

      const patch = readFileSync(patchPath, "utf8");
      expect(patch).toContain("-const a = 1;");
      expect(patch).toContain("+const a = 2;");
      expect(patch).toContain("+console.log('done');");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

