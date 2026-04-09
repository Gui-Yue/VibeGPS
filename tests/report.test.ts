import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { insertBranchTrack, insertCheckpoint, insertDelta, insertReport, openDatabase, type WorkspaceRecord } from "../src/services/db";
import { analyzeReport } from "../src/services/report-analyzer";
import { resolveReportWindow } from "../src/services/report";
import type { BranchTrack, Checkpoint, Delta, Report } from "../src/shared";
import { DEFAULT_CONFIG } from "../src/shared";

function writeDelta(root: string, delta: Delta): string {
  const deltaPath = join(root, `${delta.deltaId}.json`);
  writeFileSync(deltaPath, JSON.stringify(delta, null, 2), "utf8");
  return deltaPath;
}

describe("report window and analysis", () => {
  it("aggregates only the deltas after the latest report anchor", () => {
    const root = mkdtempSync(join(tmpdir(), "vibegps-report-"));
    const db = openDatabase(join(root, "state.db"));

    try {
      const workspace: WorkspaceRecord = {
        workspaceId: "ws_1",
        rootPath: root,
        createdAt: "2026-04-09T00:00:00.000Z",
        updatedAt: "2026-04-09T00:00:00.000Z"
      };
      db.prepare("INSERT INTO workspaces (workspace_id, root_path, created_at, updated_at) VALUES (?, ?, ?, ?)")
        .run(workspace.workspaceId, workspace.rootPath, workspace.createdAt, workspace.updatedAt);

      const branchTrack: BranchTrack = {
        branchTrackId: "bt_main",
        workspaceId: workspace.workspaceId,
        gitBranch: "main",
        gitHead: "head_1",
        branchType: "named",
        createdAt: "2026-04-09T00:00:00.000Z",
        updatedAt: "2026-04-09T00:00:00.000Z"
      };
      insertBranchTrack(db, branchTrack);

      const initCheckpoint: Checkpoint = {
        checkpointId: "cp_init",
        workspaceId: workspace.workspaceId,
        branchTrackId: branchTrack.branchTrackId,
        gitBranch: "main",
        gitHead: "head_1",
        createdAt: "2026-04-09T00:00:00.000Z",
        kind: "init",
        snapshotRef: join(root, "snapshot-init.json"),
        fileCount: 3
      };
      const checkpointOne: Checkpoint = {
        checkpointId: "cp_1",
        workspaceId: workspace.workspaceId,
        branchTrackId: branchTrack.branchTrackId,
        gitBranch: "main",
        gitHead: "head_2",
        createdAt: "2026-04-09T00:02:00.000Z",
        kind: "turn_end",
        parentCheckpointId: initCheckpoint.checkpointId,
        snapshotRef: join(root, "snapshot-1.json"),
        fileCount: 4
      };
      const checkpointTwo: Checkpoint = {
        checkpointId: "cp_2",
        workspaceId: workspace.workspaceId,
        branchTrackId: branchTrack.branchTrackId,
        gitBranch: "main",
        gitHead: "head_3",
        createdAt: "2026-04-09T00:05:00.000Z",
        kind: "turn_end",
        parentCheckpointId: checkpointOne.checkpointId,
        snapshotRef: join(root, "snapshot-2.json"),
        fileCount: 5
      };
      insertCheckpoint(db, initCheckpoint);
      insertCheckpoint(db, checkpointOne);
      insertCheckpoint(db, checkpointTwo);

      const firstDelta: Delta = {
        deltaId: "delta_1",
        workspaceId: workspace.workspaceId,
        branchTrackId: branchTrack.branchTrackId,
        gitBranch: "main",
        fromCheckpointId: initCheckpoint.checkpointId,
        toCheckpointId: checkpointOne.checkpointId,
        createdAt: "2026-04-09T00:01:00.000Z",
        source: "manual",
        changedFiles: 2,
        changedLines: 30,
        addedFiles: ["src/a.ts"],
        modifiedFiles: ["src/b.ts"],
        deletedFiles: [],
        items: [
          { path: "src/a.ts", changeType: "added", addedLines: 20, deletedLines: 0, summary: "新增入口" },
          { path: "src/b.ts", changeType: "modified", addedLines: 5, deletedLines: 5, summary: "补充逻辑" }
        ]
      };
      const secondDelta: Delta = {
        deltaId: "delta_2",
        workspaceId: workspace.workspaceId,
        branchTrackId: branchTrack.branchTrackId,
        gitBranch: "main",
        fromCheckpointId: checkpointOne.checkpointId,
        toCheckpointId: checkpointTwo.checkpointId,
        createdAt: "2026-04-09T00:04:00.000Z",
        source: "manual",
        changedFiles: 3,
        changedLines: 80,
        addedFiles: [],
        modifiedFiles: ["src/report.ts", "src/ui.tsx"],
        deletedFiles: ["src/legacy.ts"],
        items: [
          { path: "src/report.ts", changeType: "modified", addedLines: 35, deletedLines: 12, summary: "重写 report 逻辑" },
          { path: "src/ui.tsx", changeType: "modified", addedLines: 18, deletedLines: 5, summary: "补充展示层" },
          { path: "src/legacy.ts", changeType: "deleted", addedLines: 0, deletedLines: 10, summary: "移除旧实现" }
        ]
      };

      insertDelta(db, firstDelta, writeDelta(root, firstDelta));
      insertDelta(db, secondDelta, writeDelta(root, secondDelta));

      const reportAnchor: Report = {
        reportId: "report_1",
        workspaceId: workspace.workspaceId,
        branchTrackId: branchTrack.branchTrackId,
        gitBranch: "main",
        createdAt: "2026-04-09T00:03:00.000Z",
        fromCheckpointId: initCheckpoint.checkpointId,
        toCheckpointId: checkpointOne.checkpointId,
        trigger: "threshold",
        format: "html",
        summary: "阶段总结",
        path: join(root, "report_1", "index.html")
      };
      insertReport(db, reportAnchor);

      const window = resolveReportWindow(db, branchTrack.branchTrackId, initCheckpoint, checkpointTwo);

      expect(window.fromCheckpointId).toBe(checkpointOne.checkpointId);
      expect(window.toCheckpointId).toBe(checkpointTwo.checkpointId);
      expect(window.aggregate.deltaCount).toBe(1);
      expect(window.aggregate.changedLines).toBe(80);
      expect(window.aggregate.touchedFiles).toBe(3);
      expect(window.deltas.map((delta) => delta.deltaId)).toEqual(["delta_2"]);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("includes the delta that leads to the current checkpoint even when timestamps drift", () => {
    const root = mkdtempSync(join(tmpdir(), "vibegps-report-"));
    const db = openDatabase(join(root, "state.db"));

    try {
      const workspace: WorkspaceRecord = {
        workspaceId: "ws_2",
        rootPath: root,
        createdAt: "2026-04-09T00:00:00.000Z",
        updatedAt: "2026-04-09T00:00:00.000Z"
      };
      db.prepare("INSERT INTO workspaces (workspace_id, root_path, created_at, updated_at) VALUES (?, ?, ?, ?)")
        .run(workspace.workspaceId, workspace.rootPath, workspace.createdAt, workspace.updatedAt);

      const branchTrack: BranchTrack = {
        branchTrackId: "bt_drift",
        workspaceId: workspace.workspaceId,
        gitBranch: "main",
        gitHead: "head_1",
        branchType: "named",
        createdAt: "2026-04-09T00:00:00.000Z",
        updatedAt: "2026-04-09T00:00:00.000Z"
      };
      insertBranchTrack(db, branchTrack);

      const initCheckpoint: Checkpoint = {
        checkpointId: "cp_init",
        workspaceId: workspace.workspaceId,
        branchTrackId: branchTrack.branchTrackId,
        gitBranch: "main",
        gitHead: "head_1",
        createdAt: "2026-04-09T00:00:00.000Z",
        kind: "init",
        snapshotRef: join(root, "snapshot-init.json"),
        fileCount: 1
      };
      const currentCheckpoint: Checkpoint = {
        checkpointId: "cp_now",
        workspaceId: workspace.workspaceId,
        branchTrackId: branchTrack.branchTrackId,
        gitBranch: "main",
        gitHead: "head_2",
        createdAt: "2026-04-09T00:01:00.100Z",
        kind: "turn_end",
        parentCheckpointId: initCheckpoint.checkpointId,
        snapshotRef: join(root, "snapshot-now.json"),
        fileCount: 2
      };
      insertCheckpoint(db, initCheckpoint);
      insertCheckpoint(db, currentCheckpoint);

      const driftDelta: Delta = {
        deltaId: "delta_drift",
        workspaceId: workspace.workspaceId,
        branchTrackId: branchTrack.branchTrackId,
        gitBranch: "main",
        fromCheckpointId: initCheckpoint.checkpointId,
        toCheckpointId: currentCheckpoint.checkpointId,
        createdAt: "2026-04-09T00:01:00.250Z",
        source: "manual",
        changedFiles: 1,
        changedLines: 12,
        addedFiles: [],
        modifiedFiles: ["src/app.ts"],
        deletedFiles: [],
        items: [
          { path: "src/app.ts", changeType: "modified", addedLines: 8, deletedLines: 4, summary: "补充主流程" }
        ]
      };
      insertDelta(db, driftDelta, writeDelta(root, driftDelta));

      const window = resolveReportWindow(db, branchTrack.branchTrackId, initCheckpoint, currentCheckpoint);

      expect(window.aggregate.deltaCount).toBe(1);
      expect(window.aggregate.changedLines).toBe(12);
      expect(window.deltas[0]?.deltaId).toBe("delta_drift");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns a clear zero-delta state when no new changes exist", () => {
    const analysis = analyzeReport(
      {
        workspaceRoot: "C:/repo/VibeGPS",
        gitBranch: "main",
        fromCheckpointId: "cp_1",
        toCheckpointId: "cp_1",
        trigger: "manual",
        aggregate: {
          deltaCount: 0,
          touchedFiles: 0,
          changedLines: 0,
          addedFiles: 0,
          modifiedFiles: 0,
          deletedFiles: 0,
          topFiles: [],
          timeline: []
        },
        deltas: [],
        designContext: "# Design\nreport 不是 diff 列表，而是解释层。",
        projectContext: '{ "name": "vibegps" }',
        reviewCandidates: []
      },
      {
        ...DEFAULT_CONFIG,
        report: {
          ...DEFAULT_CONFIG.report,
          analyzer: "heuristic"
        }
      }
    );

    expect(analysis.analyzerRuntime).toBe("heuristic");
    expect(analysis.headline).toContain("未检测到");
    expect(analysis.keyChanges).toEqual(["当前窗口没有新增文件级变更。"]);
    expect(analysis.impact[0]).toContain("没有新的 delta");
    expect(analysis.confidence).toBe("high");
  });

  it("prioritizes implementation files ahead of tests in heuristic review order", () => {
    const analysis = analyzeReport(
      {
        workspaceRoot: "C:/repo/VibeGPS",
        gitBranch: "main",
        fromCheckpointId: "cp_1",
        toCheckpointId: "cp_2",
        trigger: "threshold",
        aggregate: {
          deltaCount: 1,
          touchedFiles: 3,
          changedLines: 201,
          addedFiles: 0,
          modifiedFiles: 3,
          deletedFiles: 0,
          topFiles: [
            {
              path: "tests/report.test.ts",
              touches: 1,
              lines: 127,
              lastChangeType: "modified"
            },
            {
              path: "src/services/report.ts",
              touches: 1,
              lines: 50,
              lastChangeType: "modified"
            },
            {
              path: "src/services/report-analyzer.ts",
              touches: 1,
              lines: 24,
              lastChangeType: "modified"
            }
          ],
          timeline: [
            {
              deltaId: "delta_1",
              createdAt: "2026-04-09T00:03:00.000Z",
              changedFiles: 3,
              changedLines: 201,
              summary: "report analyzer 与测试一起调整"
            }
          ]
        },
        deltas: [],
        designContext: "# Design\nreport 不是 diff 列表，而是解释层。",
        projectContext: '{ "name": "vibegps" }',
        reviewCandidates: [
          {
            path: "tests/report.test.ts",
            lines: 127,
            changeType: "modified",
            summary: "补充测试覆盖"
          },
          {
            path: "src/services/report.ts",
            lines: 50,
            changeType: "modified",
            summary: "调整 report 聚合逻辑"
          },
          {
            path: "src/services/report-analyzer.ts",
            lines: 24,
            changeType: "modified",
            summary: "修复 codex schema"
          }
        ]
      },
      {
        ...DEFAULT_CONFIG,
        report: {
          ...DEFAULT_CONFIG.report,
          analyzer: "heuristic"
        }
      }
    );

    expect(analysis.reviewOrder[0]?.path).toBe("src/services/report.ts");
    expect(analysis.reviewOrder[1]?.path).toBe("src/services/report-analyzer.ts");
    expect(analysis.reviewOrder[2]?.path).toBe("tests/report.test.ts");
  });

  it("builds a meaningful heuristic analysis when codex runtime is not used", () => {
    const analysis = analyzeReport(
      {
        workspaceRoot: "C:/repo/VibeGPS",
        gitBranch: "main",
        fromCheckpointId: "cp_1",
        toCheckpointId: "cp_2",
        trigger: "threshold",
        aggregate: {
          deltaCount: 2,
          touchedFiles: 4,
          changedLines: 120,
          addedFiles: 1,
          modifiedFiles: 3,
          deletedFiles: 0,
          topFiles: [
            {
              path: "src/services/report.ts",
              touches: 2,
              lines: 64,
              lastChangeType: "modified",
              patchRef: "delta_x/src/services/report.ts.patch"
            },
            {
              path: "src/commands/report.ts",
              touches: 1,
              lines: 18,
              lastChangeType: "modified"
            }
          ],
          timeline: [
            {
              deltaId: "delta_1",
              createdAt: "2026-04-09T00:01:00.000Z",
              changedFiles: 2,
              changedLines: 40,
              summary: "初步接通 report 入口",
              promptPreview: "实现有意义的变更分析报告"
            },
            {
              deltaId: "delta_2",
              createdAt: "2026-04-09T00:03:00.000Z",
              changedFiles: 2,
              changedLines: 80,
              summary: "补充分析与展示",
              promptPreview: "继续优化 report 分析层"
            }
          ]
        },
        deltas: [],
        designContext: "# Design\nreport 不是 diff 列表，而是解释层。",
        projectContext: '{ "name": "vibegps" }',
        reviewCandidates: [
          {
            path: "src/services/report.ts",
            lines: 64,
            changeType: "modified",
            summary: "重构报告窗口与渲染逻辑",
            patchRef: "delta_x/src/services/report.ts.patch",
            patchExcerpt: "@@ ..."
          },
          {
            path: "src/commands/report.ts",
            lines: 18,
            changeType: "modified",
            summary: "接入手动报告命令"
          }
        ]
      },
      {
        ...DEFAULT_CONFIG,
        report: {
          ...DEFAULT_CONFIG.report,
          analyzer: "heuristic"
        }
      }
    );

    expect(analysis.analyzerRuntime).toBe("heuristic");
    expect(analysis.headline).toContain("VibeGPS");
    expect(analysis.keyChanges.length).toBeGreaterThan(0);
    expect(analysis.reviewOrder[0]?.path).toBe("src/services/report.ts");
    expect(analysis.designAlignment.status).toBe("partial");
  });
});
