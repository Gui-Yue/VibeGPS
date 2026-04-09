import type { BranchTrack, GitState } from "../shared";
import { createId } from "../utils/ids";
import { nowIso } from "../utils/time";
import { getBranchTrack, insertBranchTrack, updateBranchTrackHead } from "./db";
import type Database from "better-sqlite3";

export function resolveBranchTrack(
  db: Database.Database,
  workspaceId: string,
  gitState: GitState
): BranchTrack {
  const existing = getBranchTrack(db, workspaceId, gitState.gitBranch);
  if (existing) {
    updateBranchTrackHead(db, existing.branchTrackId, gitState.gitHead);
    return {
      ...existing,
      gitHead: gitState.gitHead,
      updatedAt: nowIso()
    };
  }

  const timestamp = nowIso();
  const branchTrack: BranchTrack = {
    branchTrackId: createId("bt"),
    workspaceId,
    gitBranch: gitState.gitBranch,
    gitHead: gitState.gitHead,
    branchType: gitState.branchType,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  insertBranchTrack(db, branchTrack);
  return branchTrack;
}
