import { describe, expect, it } from "vitest";
import { shouldTriggerReport } from "../src/services/report";
import { DEFAULT_CONFIG } from "../src/shared";

describe("report thresholds", () => {
  it("triggers when cumulative touched files exceed threshold", () => {
    expect(
      shouldTriggerReport(DEFAULT_CONFIG, {
        deltaCount: 3,
        touchedFiles: 8,
        changedLines: 10
      })
    ).toBe(true);
  });

  it("does not trigger when auto report generation is disabled", () => {
    expect(
      shouldTriggerReport(
        {
          ...DEFAULT_CONFIG,
          report: {
            ...DEFAULT_CONFIG.report,
            autoGenerate: false
          }
        },
        {
          deltaCount: 2,
          touchedFiles: 12,
          changedLines: 400
        }
      )
    ).toBe(false);
  });
});
