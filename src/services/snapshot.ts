import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import fg from "fast-glob";
import type { Snapshot, SnapshotFileEntry, VibegpsConfig } from "../shared";
import { createId } from "../utils/ids";
import { listGitHeadFiles, readGitHeadFile } from "../utils/git";
import { nowIso } from "../utils/time";
import type { WorkspacePaths } from "../utils/workspace";

function toPosixPath(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}

function detectFileKind(buffer: Buffer): SnapshotFileEntry["kind"] {
  return buffer.includes(0) ? "binary" : "text";
}

function countLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }

  const lines = text.split("\n").length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

function readGitignorePatterns(root: string): string[] {
  const gitignorePath = join(root, ".gitignore");
  if (!existsSync(gitignorePath)) {
    return [];
  }

  const lines = readFileSync(gitignorePath, "utf8").split(/\r?\n/);
  const patterns: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) {
      continue;
    }

    const normalized = line.replace(/^\.\//, "").replaceAll("\\", "/");
    patterns.push(normalized);

    if (normalized.endsWith("/")) {
      patterns.push(`${normalized}**`);
    }
  }

  return patterns;
}

function buildSnapshotEntry(
  snapshotDir: string,
  snapshotId: string,
  filePath: string,
  buffer: Buffer,
  stats?: {
    size: number;
    mtimeMs: number;
  }
): SnapshotFileEntry {
  const normalizedPath = toPosixPath(filePath);
  const kind = detectFileKind(buffer);

  let lineCount: number | undefined;
  let contentRef: string | undefined;

  if (kind === "text") {
    const text = buffer.toString("utf8");
    const storedPath = join(snapshotDir, normalizedPath);
    mkdirSync(dirname(storedPath), { recursive: true });
    writeFileSync(storedPath, text, "utf8");
    lineCount = countLines(text);
    contentRef = `${snapshotId}/${normalizedPath}`;
  }

  return {
    path: normalizedPath,
    hash: createHash("sha256").update(buffer).digest("hex"),
    size: stats?.size ?? buffer.byteLength,
    mtimeMs: stats?.mtimeMs ?? 0,
    kind,
    lineCount,
    contentRef
  };
}

export function createSnapshot(
  workspaceId: string,
  paths: WorkspacePaths,
  tracking: VibegpsConfig["tracking"]
): Snapshot {
  const snapshotId = createId("snap");
  const snapshotDir = join(paths.snapshotsContentDir, snapshotId);
  mkdirSync(snapshotDir, { recursive: true });

  const ignore = [...tracking.ignoreGlobs];
  if (tracking.ignoreGitDir) {
    ignore.push(".git/**");
  }
  if (tracking.ignoreVibegpsDir) {
    ignore.push(".vibegps/**");
  }
  if (tracking.respectGitignore) {
    ignore.push(...readGitignorePatterns(paths.root));
  }

  const files = fg.sync(["**/*"], {
    cwd: paths.root,
    dot: true,
    onlyFiles: true,
    ignore
  });

  const entries: SnapshotFileEntry[] = files.sort().map((filePath) => {
    const absolutePath = join(paths.root, filePath);
    const buffer = readFileSync(absolutePath);
    const stat = statSync(absolutePath);
    return buildSnapshotEntry(snapshotDir, snapshotId, relative(paths.root, absolutePath), buffer, {
      size: stat.size,
      mtimeMs: stat.mtimeMs
    });
  });

  return {
    snapshotId,
    workspaceId,
    createdAt: nowIso(),
    fileCount: entries.length,
    entries
  };
}

export function createSnapshotFromGitHead(
  workspaceId: string,
  paths: WorkspacePaths,
  gitRef: string
): Snapshot {
  const snapshotId = createId("snap");
  const snapshotDir = join(paths.snapshotsContentDir, snapshotId);
  mkdirSync(snapshotDir, { recursive: true });

  const entries = listGitHeadFiles(paths.root, gitRef)
    .sort()
    .map((filePath) => buildSnapshotEntry(snapshotDir, snapshotId, filePath, readGitHeadFile(paths.root, gitRef, filePath)));

  return {
    snapshotId,
    workspaceId,
    createdAt: nowIso(),
    fileCount: entries.length,
    entries
  };
}
