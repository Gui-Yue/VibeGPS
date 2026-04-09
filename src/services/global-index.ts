import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GlobalProjectIndexEntry, RecentReportIndexEntry, Report } from "../shared";
import { nowIso } from "../utils/time";
import { readJson, writeJson } from "../utils/json";

interface GlobalPaths {
  root: string;
  cacheDir: string;
  projectsFile: string;
  recentReportsFile: string;
}

export function getGlobalIndexRoot(): string {
  return process.env.VIBEGPS_HOME || join(homedir(), ".vibegps");
}

function getGlobalPaths(): GlobalPaths {
  const root = getGlobalIndexRoot();
  return {
    root,
    cacheDir: join(root, "cache"),
    projectsFile: join(root, "projects.json"),
    recentReportsFile: join(root, "recent-reports.json")
  };
}

function ensureGlobalDirectories(paths: GlobalPaths): void {
  mkdirSync(paths.root, { recursive: true });
  mkdirSync(paths.cacheDir, { recursive: true });
}

function loadArrayFile<T>(filePath: string): T[] {
  if (!existsSync(filePath)) {
    return [];
  }

  try {
    const value = readJson<T[]>(filePath);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export function touchGlobalProjectIndex(workspaceRoot: string, workspaceId: string): void {
  const paths = getGlobalPaths();
  ensureGlobalDirectories(paths);
  const now = nowIso();
  const entries = loadArrayFile<GlobalProjectIndexEntry>(paths.projectsFile);
  const existing = entries.find((entry) => entry.workspaceRoot === workspaceRoot);

  if (existing) {
    existing.workspaceId = workspaceId;
    existing.lastUsedAt = now;
  } else {
    entries.push({
      workspaceId,
      workspaceRoot,
      initializedAt: now,
      lastUsedAt: now
    });
  }

  entries.sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt));
  writeJson(paths.projectsFile, entries);
}

export function recordRecentReport(workspaceRoot: string, workspaceId: string, report: Report): void {
  const paths = getGlobalPaths();
  ensureGlobalDirectories(paths);
  const entries = loadArrayFile<RecentReportIndexEntry>(paths.recentReportsFile).filter(
    (entry) => !(entry.workspaceRoot === workspaceRoot && entry.reportId === report.reportId)
  );

  entries.unshift({
    workspaceId,
    workspaceRoot,
    reportId: report.reportId,
    reportPath: report.path,
    gitBranch: report.gitBranch,
    createdAt: report.createdAt,
    summary: report.summary
  });

  writeJson(paths.recentReportsFile, entries.slice(0, 50));
}

export function listIndexedProjects(): GlobalProjectIndexEntry[] {
  return loadArrayFile<GlobalProjectIndexEntry>(getGlobalPaths().projectsFile);
}

export function listRecentReports(): RecentReportIndexEntry[] {
  return loadArrayFile<RecentReportIndexEntry>(getGlobalPaths().recentReportsFile);
}
