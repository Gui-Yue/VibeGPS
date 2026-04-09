import { Command } from "commander";
import { listIndexedProjects, listRecentReports } from "../services/global-index";

export function registerLsCommand(program: Command): void {
  program
    .command("ls")
    .description("List VibeGPS workspaces from the global index")
    .option("--reports", "show recent reports instead of projects")
    .action((options: { reports?: boolean }) => {
      if (options.reports) {
        const reports = listRecentReports();
        if (reports.length === 0) {
          console.log("No recent reports recorded yet.");
          return;
        }

        for (const report of reports) {
          console.log(`${report.createdAt} | ${report.gitBranch} | ${report.workspaceRoot}`);
          console.log(`  ${report.reportId} -> ${report.reportPath}`);
          console.log(`  ${report.summary}`);
        }
        return;
      }

      const projects = listIndexedProjects();
      if (projects.length === 0) {
        console.log("No VibeGPS workspaces indexed yet. Run `vibegps init` inside a project first.");
        return;
      }

      for (const project of projects) {
        console.log(`${project.workspaceRoot}`);
        console.log(`  workspaceId=${project.workspaceId}`);
        console.log(`  initializedAt=${project.initializedAt}`);
        console.log(`  lastUsedAt=${project.lastUsedAt}`);
      }
    });
}
