import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectDigest } from "../shared";
import { nowIso } from "../utils/time";
import { writeJson } from "../utils/json";
import type { WorkspacePaths } from "../utils/workspace";

function firstNonEmptyLine(input: string): string | undefined {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

function summarizeReadme(workspaceRoot: string): string | undefined {
  const readmePath = join(workspaceRoot, "README.md");
  if (!existsSync(readmePath)) {
    return undefined;
  }

  const readme = readFileSync(readmePath, "utf8").replace(/^\uFEFF/, "");
  const heading = readme.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const bodyLine = firstNonEmptyLine(
    readme
      .split(/\r?\n/)
      .filter((line) => !line.startsWith("#"))
      .join("\n")
  );

  if (heading && bodyLine) {
    return `${heading}: ${bodyLine}`;
  }

  return heading ?? bodyLine;
}

function summarizePackageJson(workspaceRoot: string): string | undefined {
  const packageJsonPath = join(workspaceRoot, "package.json");
  if (!existsSync(packageJsonPath)) {
    return undefined;
  }

  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8").replace(/^\uFEFF/, "")) as {
      name?: string;
      description?: string;
    };
    if (pkg.name && pkg.description) {
      return `${pkg.name}: ${pkg.description}`;
    }
    return pkg.description ?? pkg.name;
  } catch {
    return undefined;
  }
}

function summarizeDesignDocs(workspaceRoot: string): string | undefined {
  const docsDir = join(workspaceRoot, "docs");
  if (!existsSync(docsDir)) {
    return undefined;
  }

  const docFile = readdirSync(docsDir)
    .filter((file) => /design|concept|spec/i.test(file) && file.toLowerCase().endsWith(".md"))
    .map((file) => join(docsDir, file))[0];

  if (!docFile) {
    return undefined;
  }

  const content = readFileSync(docFile, "utf8").replace(/^\uFEFF/, "");
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const bodyLine = firstNonEmptyLine(
    content
      .split(/\r?\n/)
      .filter((line) => !line.startsWith("#") && !line.startsWith(">"))
      .join("\n")
  );

  if (heading && bodyLine) {
    return `${heading}: ${bodyLine}`;
  }

  return heading ?? bodyLine;
}

function inferModulePurpose(name: string): string {
  if (name === "commands") {
    return "CLI command handlers and user-facing entry points.";
  }
  if (name === "services") {
    return "Core runtime logic for checkpoints, deltas, reports, and Codex integration.";
  }
  if (name === "shared") {
    return "Shared types, config defaults, and constants used across the CLI.";
  }
  if (name === "utils") {
    return "Filesystem, git, JSON, and workspace helpers.";
  }
  if (name === "extension") {
    return "VS Code frontend bridge and extension-side integration code.";
  }
  if (name === "tests") {
    return "Verification coverage for core workflows and regressions.";
  }

  return "Project module tracked by VibeGPS.";
}

export function generateProjectDigest(
  workspaceRoot: string,
  workspaceId: string,
  paths: WorkspacePaths
): ProjectDigest {
  const packageSummary = summarizePackageJson(workspaceRoot);
  const readmeSummary = summarizeReadme(workspaceRoot);
  const designDocSummary = summarizeDesignDocs(workspaceRoot);
  const srcDir = join(workspaceRoot, "src");
  const testsDir = join(workspaceRoot, "tests");

  const modules = [
    ...(existsSync(srcDir)
      ? readdirSync(srcDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => ({
            name: entry.name,
            paths: [`src/${entry.name}`],
            purpose: inferModulePurpose(entry.name)
          }))
      : []),
    ...(existsSync(testsDir)
      ? [
          {
            name: "tests",
            paths: ["tests"],
            purpose: inferModulePurpose("tests")
          }
        ]
      : [])
  ];

  const keyPaths = ["package.json", "README.md", "docs", "src", "tests"].filter((relativePath) =>
    existsSync(join(workspaceRoot, relativePath))
  );

  const summary = [packageSummary, readmeSummary, designDocSummary]
    .filter((value): value is string => Boolean(value))
    .slice(0, 2)
    .join(" | ");

  const digest: ProjectDigest = {
    workspaceId,
    generatedAt: nowIso(),
    summary: summary || "VibeGPS workspace with branch-aware checkpoint, delta, and report tracking.",
    keyPaths,
    modules,
    designDocSummary
  };

  writeJson(paths.projectDigestFile, digest);
  return digest;
}
