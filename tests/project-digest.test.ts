import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { generateProjectDigest } from "../src/services/project-digest";
import { getWorkspacePaths } from "../src/utils/workspace";

const tempRoots: string[] = [];

function makeTempWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "vibegps-digest-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

describe("project digest", () => {
  it("builds a lightweight digest from package, readme, docs, src and tests", () => {
    const root = makeTempWorkspace();
    const paths = getWorkspacePaths(root);

    mkdirSync(paths.cacheDir, { recursive: true });
    mkdirSync(join(root, "src", "services"), { recursive: true });
    mkdirSync(join(root, "src", "commands"), { recursive: true });
    mkdirSync(join(root, "tests"), { recursive: true });
    mkdirSync(join(root, "docs"), { recursive: true });

    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "demo-app", description: "A test workspace for VibeGPS" }, null, 2),
      "utf8"
    );
    writeFileSync(join(root, "README.md"), "# Demo App\n\n用于验证项目摘要生成。\n", "utf8");
    writeFileSync(join(root, "docs", "design.md"), "# Design\n\nCLI 负责记录项目演化。\n", "utf8");

    const digest = generateProjectDigest(root, "ws_demo", paths);

    expect(digest.workspaceId).toBe("ws_demo");
    expect(digest.summary).toContain("demo-app");
    expect(digest.keyPaths).toContain("src");
    expect(digest.keyPaths).toContain("tests");
    expect(digest.designDocSummary).toContain("Design");
    expect(digest.modules.map((module) => module.name)).toEqual(expect.arrayContaining(["services", "commands", "tests"]));
  });
});
