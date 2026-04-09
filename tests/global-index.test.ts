import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { Report } from "../src/shared";
import {
  getGlobalIndexRoot,
  listIndexedProjects,
  listRecentReports,
  recordRecentReport,
  touchGlobalProjectIndex
} from "../src/services/global-index";

const tempRoots: string[] = [];

function withGlobalHome(): string {
  const root = mkdtempSync(join(tmpdir(), "vibegps-global-"));
  tempRoots.push(root);
  process.env.VIBEGPS_HOME = root;
  return root;
}

afterEach(() => {
  delete process.env.VIBEGPS_HOME;
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

describe("global index", () => {
  it("uses VIBEGPS_HOME when provided", () => {
    const root = withGlobalHome();
    expect(getGlobalIndexRoot()).toBe(root);
  });

  it("stores indexed projects and recent reports in the isolated global directory", () => {
    withGlobalHome();
    touchGlobalProjectIndex("C:/repo/demo", "ws_demo");
    touchGlobalProjectIndex("C:/repo/demo", "ws_demo");

    const report: Report = {
      reportId: "report_demo",
      workspaceId: "ws_demo",
      branchTrackId: "bt_main",
      gitBranch: "main",
      createdAt: "2026-04-09T12:00:00.000Z",
      fromCheckpointId: "cp_1",
      toCheckpointId: "cp_2",
      trigger: "manual",
      format: "html",
      summary: "演化摘要",
      path: "C:/repo/demo/.vibegps/reports/report_demo/index.html"
    };

    recordRecentReport("C:/repo/demo", "ws_demo", report);
    recordRecentReport("C:/repo/demo", "ws_demo", report);

    const projects = listIndexedProjects();
    const reports = listRecentReports();

    expect(projects).toHaveLength(1);
    expect(projects[0]?.workspaceRoot).toBe("C:/repo/demo");
    expect(projects[0]?.workspaceId).toBe("ws_demo");

    expect(reports).toHaveLength(1);
    expect(reports[0]?.reportId).toBe("report_demo");
    expect(reports[0]?.reportPath).toContain("report_demo");
  });
});
