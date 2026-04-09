import Database from "better-sqlite3";
import type { BranchTrack, Checkpoint, Delta, DeltaRecord, Report } from "../shared";
import { nowIso } from "../utils/time";

export interface WorkspaceRecord {
  workspaceId: string;
  rootPath: string;
  createdAt: string;
  updatedAt: string;
}

export function openDatabase(filePath: string): Database.Database {
  const db = new Database(filePath);
  db.pragma("journal_mode = WAL");
  ensureSchema(db);
  return db;
}

function ensureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      workspace_id TEXT PRIMARY KEY,
      root_path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS branch_tracks (
      branch_track_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      git_branch TEXT NOT NULL,
      git_head TEXT,
      branch_type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_branch_tracks_workspace_branch
      ON branch_tracks(workspace_id, git_branch);

    CREATE TABLE IF NOT EXISTS checkpoints (
      checkpoint_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      branch_track_id TEXT NOT NULL,
      git_branch TEXT NOT NULL,
      git_head TEXT,
      created_at TEXT NOT NULL,
      kind TEXT NOT NULL,
      parent_checkpoint_id TEXT,
      trigger_source TEXT,
      trigger_turn_id TEXT,
      snapshot_ref TEXT NOT NULL,
      file_count INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS deltas (
      delta_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      branch_track_id TEXT NOT NULL,
      git_branch TEXT NOT NULL,
      from_checkpoint_id TEXT NOT NULL,
      to_checkpoint_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      source TEXT NOT NULL,
      codex_turn_id TEXT,
      prompt_preview TEXT,
      changed_files INTEGER NOT NULL,
      changed_lines INTEGER NOT NULL,
      data_ref TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reports (
      report_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      branch_track_id TEXT NOT NULL,
      git_branch TEXT NOT NULL,
      created_at TEXT NOT NULL,
      from_checkpoint_id TEXT NOT NULL,
      to_checkpoint_id TEXT NOT NULL,
      trigger_type TEXT NOT NULL,
      format TEXT NOT NULL,
      summary TEXT NOT NULL,
      path TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS hook_installs (
      workspace_id TEXT PRIMARY KEY,
      installed_at TEXT NOT NULL,
      shim_path TEXT NOT NULL,
      codex_config_path TEXT NOT NULL
    );
  `);
}

export function ensureWorkspaceRecord(db: Database.Database, workspaceId: string, rootPath: string): WorkspaceRecord {
  const existing = getWorkspaceRecordByRoot(db, rootPath);

  if (existing) {
    db.prepare("UPDATE workspaces SET updated_at = ? WHERE workspace_id = ?").run(nowIso(), existing.workspaceId);
    return existing;
  }

  const timestamp = nowIso();
  db.prepare("INSERT INTO workspaces (workspace_id, root_path, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(workspaceId, rootPath, timestamp, timestamp);

  return {
    workspaceId,
    rootPath,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function getWorkspaceRecordByRoot(db: Database.Database, rootPath: string): WorkspaceRecord | undefined {
  return db
    .prepare("SELECT workspace_id as workspaceId, root_path as rootPath, created_at as createdAt, updated_at as updatedAt FROM workspaces WHERE root_path = ?")
    .get(rootPath) as WorkspaceRecord | undefined;
}

export function getBranchTrack(db: Database.Database, workspaceId: string, gitBranch: string): BranchTrack | undefined {
  return db
    .prepare(
      "SELECT branch_track_id as branchTrackId, workspace_id as workspaceId, git_branch as gitBranch, git_head as gitHead, branch_type as branchType, created_at as createdAt, updated_at as updatedAt FROM branch_tracks WHERE workspace_id = ? AND git_branch = ?"
    )
    .get(workspaceId, gitBranch) as BranchTrack | undefined;
}

export function insertBranchTrack(db: Database.Database, branchTrack: BranchTrack): void {
  db.prepare(
    "INSERT INTO branch_tracks (branch_track_id, workspace_id, git_branch, git_head, branch_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(
    branchTrack.branchTrackId,
    branchTrack.workspaceId,
    branchTrack.gitBranch,
    branchTrack.gitHead,
    branchTrack.branchType,
    branchTrack.createdAt,
    branchTrack.updatedAt
  );
}

export function updateBranchTrackHead(db: Database.Database, branchTrackId: string, gitHead: string | null): void {
  db.prepare("UPDATE branch_tracks SET git_head = ?, updated_at = ? WHERE branch_track_id = ?").run(gitHead, nowIso(), branchTrackId);
}

export function listBranchTracks(db: Database.Database, workspaceId: string): BranchTrack[] {
  return db
    .prepare(
      "SELECT branch_track_id as branchTrackId, workspace_id as workspaceId, git_branch as gitBranch, git_head as gitHead, branch_type as branchType, created_at as createdAt, updated_at as updatedAt FROM branch_tracks WHERE workspace_id = ? ORDER BY updated_at DESC"
    )
    .all(workspaceId) as BranchTrack[];
}

export function getLatestCheckpoint(db: Database.Database, branchTrackId: string): Checkpoint | undefined {
  return db
    .prepare(
      `SELECT checkpoint_id as checkpointId, workspace_id as workspaceId, branch_track_id as branchTrackId, git_branch as gitBranch,
              git_head as gitHead, created_at as createdAt, kind, parent_checkpoint_id as parentCheckpointId,
              snapshot_ref as snapshotRef, file_count as fileCount
       FROM checkpoints WHERE branch_track_id = ? ORDER BY created_at DESC LIMIT 1`
    )
    .get(branchTrackId) as Checkpoint | undefined;
}

export function getInitCheckpoint(db: Database.Database, branchTrackId: string): Checkpoint | undefined {
  return db
    .prepare(
      `SELECT checkpoint_id as checkpointId, workspace_id as workspaceId, branch_track_id as branchTrackId, git_branch as gitBranch,
              git_head as gitHead, created_at as createdAt, kind, parent_checkpoint_id as parentCheckpointId,
              snapshot_ref as snapshotRef, file_count as fileCount
       FROM checkpoints WHERE branch_track_id = ? AND kind IN ('init','branch_init') ORDER BY created_at ASC LIMIT 1`
    )
    .get(branchTrackId) as Checkpoint | undefined;
}

export function insertCheckpoint(db: Database.Database, checkpoint: Checkpoint): void {
  db.prepare(
    `INSERT INTO checkpoints
      (checkpoint_id, workspace_id, branch_track_id, git_branch, git_head, created_at, kind, parent_checkpoint_id, trigger_source, trigger_turn_id, snapshot_ref, file_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    checkpoint.checkpointId,
    checkpoint.workspaceId,
    checkpoint.branchTrackId,
    checkpoint.gitBranch,
    checkpoint.gitHead ?? null,
    checkpoint.createdAt,
    checkpoint.kind,
    checkpoint.parentCheckpointId ?? null,
    checkpoint.triggerRef?.source ?? null,
    checkpoint.triggerRef?.turnId ?? null,
    checkpoint.snapshotRef,
    checkpoint.fileCount
  );
}

export function insertDelta(db: Database.Database, delta: Delta, dataRef: string): void {
  db.prepare(
    `INSERT INTO deltas
      (delta_id, workspace_id, branch_track_id, git_branch, from_checkpoint_id, to_checkpoint_id, created_at, source, codex_turn_id, prompt_preview, changed_files, changed_lines, data_ref)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    delta.deltaId,
    delta.workspaceId,
    delta.branchTrackId,
    delta.gitBranch,
    delta.fromCheckpointId,
    delta.toCheckpointId,
    delta.createdAt,
    delta.source,
    delta.codexTurnId ?? null,
    delta.promptPreview ?? null,
    delta.changedFiles,
    delta.changedLines,
    dataRef
  );
}

export function listDeltasForBranch(db: Database.Database, branchTrackId: string): DeltaRecord[] {
  return db
    .prepare(
      `SELECT delta_id as deltaId, changed_files as changedFiles, changed_lines as changedLines,
              from_checkpoint_id as fromCheckpointId, to_checkpoint_id as toCheckpointId,
              created_at as createdAt, data_ref as dataRef
       FROM deltas WHERE branch_track_id = ? ORDER BY created_at ASC`
    )
    .all(branchTrackId) as DeltaRecord[];
}

export function getLatestReport(db: Database.Database, branchTrackId: string): Report | undefined {
  return db
    .prepare(
      `SELECT report_id as reportId, workspace_id as workspaceId, branch_track_id as branchTrackId, git_branch as gitBranch, created_at as createdAt,
              from_checkpoint_id as fromCheckpointId, to_checkpoint_id as toCheckpointId, trigger_type as trigger, format, summary, path
       FROM reports WHERE branch_track_id = ? ORDER BY created_at DESC LIMIT 1`
    )
    .get(branchTrackId) as Report | undefined;
}

export function insertReport(db: Database.Database, report: Report): void {
  db.prepare(
    `INSERT INTO reports
      (report_id, workspace_id, branch_track_id, git_branch, created_at, from_checkpoint_id, to_checkpoint_id, trigger_type, format, summary, path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    report.reportId,
    report.workspaceId,
    report.branchTrackId,
    report.gitBranch,
    report.createdAt,
    report.fromCheckpointId,
    report.toCheckpointId,
    report.trigger,
    report.format,
    report.summary,
    report.path
  );
}
