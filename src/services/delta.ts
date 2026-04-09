import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createTwoFilesPatch, diffLines } from "diff";
import type { Delta, FileDelta, Snapshot, SnapshotFileEntry } from "../shared";
import { createId } from "../utils/ids";
import { nowIso } from "../utils/time";

interface DeltaBuildInput {
  workspaceId: string;
  branchTrackId: string;
  gitBranch: string;
  fromCheckpointId: string;
  toCheckpointId: string;
  source: Delta["source"];
  snapshotBefore: Snapshot;
  snapshotAfter: Snapshot;
  snapshotContentDir: string;
  deltasDir: string;
  deltaPatchesDir: string;
  promptPreview?: string;
  codexTurnId?: string;
}

function countChangedLines(value: string): number {
  if (value.length === 0) {
    return 0;
  }

  const lines = value.split("\n").length;
  return value.endsWith("\n") ? lines - 1 : lines;
}

function buildPatchSummary(beforeText: string, afterText: string): { addedLines: number; deletedLines: number; summary: string } {
  const changes = diffLines(beforeText, afterText);
  let addedLines = 0;
  let deletedLines = 0;

  for (const change of changes) {
    const lines = countChangedLines(change.value);
    if (change.added) {
      addedLines += lines;
    } else if (change.removed) {
      deletedLines += lines;
    }
  }

  return {
    addedLines,
    deletedLines,
    summary: `+${addedLines} / -${deletedLines}`
  };
}

function toRelativeArtifactPath(...parts: string[]): string {
  return parts.join("/").replaceAll("\\", "/");
}

function readSnapshotText(snapshotContentDir: string, entry: SnapshotFileEntry | undefined): string | undefined {
  if (!entry || entry.kind !== "text" || !entry.contentRef) {
    return undefined;
  }

  const absolutePath = join(snapshotContentDir, ...entry.contentRef.split("/"));
  return readFileSync(absolutePath, "utf8");
}

function writePatch(
  deltaPatchesDir: string,
  deltaId: string,
  relativePath: string,
  beforeText: string,
  afterText: string,
  oldFileName: string,
  newFileName: string
): string {
  const patch = createTwoFilesPatch(oldFileName, newFileName, beforeText, afterText, "", "", { context: 3 });
  const patchRef = toRelativeArtifactPath(deltaId, `${relativePath}.patch`);
  const patchPath = join(deltaPatchesDir, ...patchRef.split("/"));
  mkdirSync(dirname(patchPath), { recursive: true });
  writeFileSync(patchPath, patch, "utf8");
  return patchRef;
}

export function buildDelta(input: DeltaBuildInput): { delta: Delta; deltaPath: string } {
  const beforeMap = new Map<string, SnapshotFileEntry>(input.snapshotBefore.entries.map((entry) => [entry.path, entry]));
  const afterMap = new Map<string, SnapshotFileEntry>(input.snapshotAfter.entries.map((entry) => [entry.path, entry]));
  const allPaths = [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort();

  const deltaId = createId("delta");
  const items: FileDelta[] = [];
  const addedFiles: string[] = [];
  const modifiedFiles: string[] = [];
  const deletedFiles: string[] = [];

  for (const path of allPaths) {
    const before = beforeMap.get(path);
    const after = afterMap.get(path);

    if (!before && after) {
      if (after.kind === "text") {
        const afterText = readSnapshotText(input.snapshotContentDir, after) ?? "";
        const patchRef = writePatch(input.deltaPatchesDir, deltaId, path, "", afterText, "/dev/null", `b/${path}`);
        const patchSummary = buildPatchSummary("", afterText);
        items.push({
          path,
          changeType: "added",
          afterHash: after.hash,
          addedLines: patchSummary.addedLines,
          deletedLines: patchSummary.deletedLines,
          patchRef,
          summary: `新增文本文件，${patchSummary.addedLines} 行`
        });
      } else {
        items.push({
          path,
          changeType: "added",
          afterHash: after.hash,
          summary: "新增二进制文件"
        });
      }
      addedFiles.push(path);
      continue;
    }

    if (before && !after) {
      if (before.kind === "text") {
        const beforeText = readSnapshotText(input.snapshotContentDir, before) ?? "";
        const patchRef = writePatch(input.deltaPatchesDir, deltaId, path, beforeText, "", `a/${path}`, "/dev/null");
        const patchSummary = buildPatchSummary(beforeText, "");
        items.push({
          path,
          changeType: "deleted",
          beforeHash: before.hash,
          addedLines: patchSummary.addedLines,
          deletedLines: patchSummary.deletedLines,
          patchRef,
          summary: `删除文本文件，${patchSummary.deletedLines} 行`
        });
      } else {
        items.push({
          path,
          changeType: "deleted",
          beforeHash: before.hash,
          summary: "删除二进制文件"
        });
      }
      deletedFiles.push(path);
      continue;
    }

    if (!before || !after || before.hash === after.hash) {
      continue;
    }

    if (before.kind === "binary" || after.kind === "binary") {
      items.push({
        path,
        changeType: "binary_modified",
        beforeHash: before.hash,
        afterHash: after.hash,
        summary: "二进制文件发生变更"
      });
      modifiedFiles.push(path);
      continue;
    }

    const beforeText = readSnapshotText(input.snapshotContentDir, before) ?? "";
    const afterText = readSnapshotText(input.snapshotContentDir, after) ?? "";
    const patchSummary = buildPatchSummary(beforeText, afterText);
    const patchRef = writePatch(input.deltaPatchesDir, deltaId, path, beforeText, afterText, `a/${path}`, `b/${path}`);

    items.push({
      path,
      changeType: "modified",
      beforeHash: before.hash,
      afterHash: after.hash,
      addedLines: patchSummary.addedLines,
      deletedLines: patchSummary.deletedLines,
      patchRef,
      summary: patchSummary.summary
    });
    modifiedFiles.push(path);
  }

  const changedLines = items.reduce((sum, item) => sum + (item.addedLines ?? 0) + (item.deletedLines ?? 0), 0);
  const delta: Delta = {
    deltaId,
    workspaceId: input.workspaceId,
    branchTrackId: input.branchTrackId,
    gitBranch: input.gitBranch,
    fromCheckpointId: input.fromCheckpointId,
    toCheckpointId: input.toCheckpointId,
    createdAt: nowIso(),
    source: input.source,
    codexTurnId: input.codexTurnId,
    promptPreview: input.promptPreview,
    changedFiles: items.length,
    changedLines,
    addedFiles,
    modifiedFiles,
    deletedFiles,
    items
  };

  const deltaPath = join(input.deltasDir, `${delta.deltaId}.json`);
  writeFileSync(deltaPath, JSON.stringify(delta, null, 2), "utf8");
  return { delta, deltaPath };
}

