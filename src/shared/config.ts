import type { VibegpsConfig } from "./types";

export const DEFAULT_TRACKING_IGNORE_GLOBS = [
  "node_modules/**",
  "**/node_modules/**",
  "dist/**",
  "**/dist/**",
  ".vite/**",
  "**/.vite/**",
  "coverage/**",
  "**/coverage/**",
  "*.tsbuildinfo",
  "**/*.tsbuildinfo",
  "*.map",
  "**/*.map"
] as const;

export const DEFAULT_CONFIG: VibegpsConfig = {
  version: 1,
  thresholds: {
    changedFiles: 8,
    changedLines: 200
  },
  report: {
    defaultFormat: "html",
    alsoEmitMarkdown: true,
    analyzer: "auto",
    autoGenerate: true,
    maxContextFiles: 6,
    maxPatchCharsPerFile: 1800
  },
  tracking: {
    ignoreGitDir: true,
    ignoreVibegpsDir: true,
    respectGitignore: true,
    ignoreGlobs: [...DEFAULT_TRACKING_IGNORE_GLOBS]
  }
};

export function normalizeConfig(input?: Partial<VibegpsConfig>): VibegpsConfig {
  return {
    ...DEFAULT_CONFIG,
    ...input,
    thresholds: {
      ...DEFAULT_CONFIG.thresholds,
      ...input?.thresholds
    },
    report: {
      ...DEFAULT_CONFIG.report,
      ...input?.report
    },
    tracking: {
      ...DEFAULT_CONFIG.tracking,
      ...input?.tracking,
      ignoreGlobs: input?.tracking?.ignoreGlobs ? [...input.tracking.ignoreGlobs] : [...DEFAULT_CONFIG.tracking.ignoreGlobs]
    }
  };
}
