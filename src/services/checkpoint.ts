import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BranchTrack, Checkpoint, CheckpointKind, Snapshot } from "../shared";
import { createId } from "../utils/ids";
import { nowIso } from "../utils/time";
import { insertCheckpoint } from "./db";
import type Database from "better-sqlite3";

export function createCheckpoint(
  db: Database.Database,
  input: {
    workspaceId: string;
    branchTrack: BranchTrack;
    snapshot: Snapshot;
    checkpointsDir: string;
    kind: CheckpointKind;
    parentCheckpointId?: string;
    triggerRef?: Checkpoint["triggerRef"];
  }
): Checkpoint {
  const checkpointId = createId("cp");
  const snapshotRef = join(input.checkpointsDir, `${checkpointId}.snapshot.json`);
  const manifestRef = join(input.checkpointsDir, `${checkpointId}.json`);

  writeFileSync(snapshotRef, JSON.stringify(input.snapshot, null, 2), "utf8");

  const checkpoint: Checkpoint = {
    checkpointId,
    workspaceId: input.workspaceId,
    branchTrackId: input.branchTrack.branchTrackId,
    gitBranch: input.branchTrack.gitBranch,
    gitHead: input.branchTrack.gitHead ?? undefined,
    createdAt: nowIso(),
    kind: input.kind,
    parentCheckpointId: input.parentCheckpointId,
    triggerRef: input.triggerRef,
    snapshotRef,
    fileCount: input.snapshot.fileCount
  };

  writeFileSync(manifestRef, JSON.stringify(checkpoint, null, 2), "utf8");
  insertCheckpoint(db, checkpoint);
  return checkpoint;
}
