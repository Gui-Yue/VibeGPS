import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { MANAGED_NOTIFY_END, MANAGED_NOTIFY_START } from "../shared";
import { readJson, writeJson } from "./json";
import type { WorkspacePaths } from "./workspace";

const STOP_EVENT = "Stop";
export const MANAGED_HOOK_COMMAND = "vibegps hook-stop";
export const MANAGED_HOOKS_PATH = "./hooks.json";

interface CodexHookCommandConfig {
  type: "command";
  command: string;
  timeout?: number;
  async?: boolean;
}

interface CodexHookMatcherGroup {
  matcher: string;
  hooks: CodexHookCommandConfig[];
}

interface CodexHookEvents {
  Stop?: CodexHookMatcherGroup[];
}

type CodexHooksConfig = Record<string, unknown> & {
  hooks?: CodexHookEvents;
};

function stripManagedBlocks(configText: string): string {
  return configText.replace(new RegExp(`${MANAGED_NOTIFY_START}[\\s\\S]*?${MANAGED_NOTIFY_END}\\n?`, "g"), "");
}

function splitConfigLines(configText: string): string[] {
  const trimmed = stripManagedBlocks(configText).trimEnd();
  return trimmed.length > 0 ? trimmed.split(/\r?\n/) : [];
}

function joinConfigLines(lines: string[]): string {
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function removeRootHooksSetting(lines: string[]): string[] {
  let inRootTable = true;

  return lines.filter((line) => {
    if (/^\s*\[.*\]\s*$/.test(line)) {
      inRootTable = false;
      return true;
    }

    return !(inRootTable && /^\s*hooks\s*=/.test(line));
  });
}

function upsertHooksPathBlock(lines: string[]): string[] {
  const managedLines = [MANAGED_NOTIFY_START, `hooks = "${MANAGED_HOOKS_PATH}"`, MANAGED_NOTIFY_END];
  const firstSectionIndex = lines.findIndex((line) => /^\s*\[.*\]\s*$/.test(line));
  const beforeSections = firstSectionIndex === -1 ? lines : lines.slice(0, firstSectionIndex);
  const afterSections = firstSectionIndex === -1 ? [] : lines.slice(firstSectionIndex);
  const trimmedBeforeSections = beforeSections.filter((line, index, source) => {
    return index < source.length - 1 || line.trim().length > 0;
  });

  return trimmedBeforeSections.length > 0
    ? [...trimmedBeforeSections, ...managedLines, "", ...afterSections]
    : [...managedLines, ...(afterSections.length > 0 ? ["", ...afterSections] : [])];
}

function upsertFeatureFlagBlock(lines: string[]): string[] {
  const featureHeaderIndex = lines.findIndex((line) => line.trim() === "[features]");
  const managedLines = [MANAGED_NOTIFY_START, "codex_hooks = true", MANAGED_NOTIFY_END];

  if (featureHeaderIndex === -1) {
    return [...lines, ...(lines.length > 0 ? [""] : []), "[features]", ...managedLines];
  }

  let featureSectionEnd = lines.length;
  for (let index = featureHeaderIndex + 1; index < lines.length; index += 1) {
    if (/^\s*\[.*\]\s*$/.test(lines[index]!)) {
      featureSectionEnd = index;
      break;
    }
  }

  const beforeFeatureSection = lines.slice(0, featureHeaderIndex + 1);
  const featureBody = lines
    .slice(featureHeaderIndex + 1, featureSectionEnd)
    .filter((line) => !/^\s*codex_hooks\s*=/.test(line));
  const afterFeatureSection = lines.slice(featureSectionEnd);
  const trimmedFeatureBody = [...featureBody];

  while (trimmedFeatureBody.length > 0 && trimmedFeatureBody[trimmedFeatureBody.length - 1]!.trim().length === 0) {
    trimmedFeatureBody.pop();
  }

  return [
    ...beforeFeatureSection,
    ...trimmedFeatureBody,
    ...(trimmedFeatureBody.length > 0 ? [""] : []),
    ...managedLines,
    ...(afterFeatureSection.length > 0 ? [""] : []),
    ...afterFeatureSection
  ];
}

function isManagedStopHookGroup(group: CodexHookMatcherGroup): boolean {
  return group.hooks.some((hook) => hook.type === "command" && hook.command.trim() === MANAGED_HOOK_COMMAND);
}

export function patchCodexConfig(paths: WorkspacePaths): void {
  const configPath = join(paths.codexDir, "config.toml");
  const existing = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const nextLines = upsertFeatureFlagBlock(upsertHooksPathBlock(removeRootHooksSetting(splitConfigLines(existing))));
  const nextConfig = joinConfigLines(nextLines);
  writeFileSync(configPath, nextConfig, "utf8");
}

export function patchCodexHooksFile(paths: WorkspacePaths): void {
  const hooksFile = join(paths.codexDir, "hooks.json");
  const existing = existsSync(hooksFile) ? readJson<CodexHooksConfig>(hooksFile) : {};
  const existingHooks = existing.hooks && typeof existing.hooks === "object" ? existing.hooks : {};
  const stopGroups = Array.isArray(existingHooks[STOP_EVENT]) ? (existingHooks[STOP_EVENT] as CodexHookMatcherGroup[]) : [];
  const preservedStopGroups = stopGroups.filter((group) => !isManagedStopHookGroup(group));

  const nextHooks: CodexHooksConfig = {
    ...existing,
    hooks: {
      ...existingHooks,
      [STOP_EVENT]: [
        ...preservedStopGroups,
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: MANAGED_HOOK_COMMAND
            }
          ]
        }
      ]
    }
  };

  writeJson(hooksFile, nextHooks);
}

export function extractStopHookCommands(hooksConfig: unknown): string[] {
  if (!hooksConfig || typeof hooksConfig !== "object") {
    return [];
  }

  const hooks = (hooksConfig as CodexHooksConfig).hooks;
  if (!hooks || typeof hooks !== "object") {
    return [];
  }

  const stopGroups = hooks[STOP_EVENT];
  if (!Array.isArray(stopGroups)) {
    return [];
  }

  return stopGroups.flatMap((group) => {
    if (!group || typeof group !== "object" || !Array.isArray((group as CodexHookMatcherGroup).hooks)) {
      return [];
    }

    return (group as CodexHookMatcherGroup).hooks
      .filter((hook) => hook?.type === "command" && typeof hook.command === "string")
      .map((hook) => hook.command);
  });
}

function getFeaturesSection(configText: string): string {
  const match = configText.match(/^\s*\[features\]\s*$([\s\S]*?)(?=^\s*\[|\s*$)/m);
  return match?.[1] ?? "";
}

export function isCodexHooksEnabled(configText: string): boolean {
  return /^\s*codex_hooks\s*=\s*true\s*$/m.test(getFeaturesSection(configText));
}

export function extractHooksConfigPath(configText: string): string | undefined {
  const match = configText.match(/^\s*hooks\s*=\s*"([^"]+)"\s*$/m);
  return match?.[1];
}

export function resolveHooksConfigPath(root: string, configuredPath: string): string {
  return normalize(isAbsolute(configuredPath) ? configuredPath : join(root, ".codex", configuredPath));
}

export function getExpectedHooksConfigPath(paths: WorkspacePaths): string {
  return normalize(join(paths.codexDir, "hooks.json"));
}

export function getExpectedStopHookCommand(): string {
  return MANAGED_HOOK_COMMAND;
}

export function validateManagedStopHookCommand(command: string | undefined): boolean {
  return typeof command === "string" && command.trim() === MANAGED_HOOK_COMMAND;
}
