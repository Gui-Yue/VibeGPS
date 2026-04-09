function normalizeQuotedArray(rawArray: string): string[] | undefined {
  const normalized = rawArray.replace(/'/g, '"');
  try {
    const parsed = JSON.parse(normalized) as unknown;
    if (Array.isArray(parsed) && parsed.every((value) => typeof value === "string")) {
      return parsed;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function extractNotifyCommand(configText: string): string[] | undefined {
  const match = configText.match(/^\s*notify\s*=\s*(\[[^\n]+\])\s*$/m);
  if (!match) {
    return undefined;
  }
  return normalizeQuotedArray(match[1]);
}
