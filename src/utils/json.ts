import { readFileSync, writeFileSync } from "node:fs";

export function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

export function readJson<T>(filePath: string): T {
  const content = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(content) as T;
}
