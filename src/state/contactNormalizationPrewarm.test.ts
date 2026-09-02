import { describe, expect, it } from "vitest";
import {
  buildContactNormalizationWeightPrewarmPlan,
  contactNormalizationBackgroundWorkBlocked,
  contactNormalizationPrewarmResolutions,
  retainContactNormalizationHistory,
} from "./contactNormalizationPrewarm";

describe("contact normalization prewarm planning", () => {
  it("keeps normalization work on only the displayed resolution", () => {
    expect(contactNormalizationPrewarmResolutions(
      10_000,
      [2_500_000, 500_000, 10_000, 1_000],
      true,
    )).toEqual([10_000]);
  });

  it("does not multiply coarse normalization work across neighboring levels", () => {
    expect(contactNormalizationPrewarmResolutions(
      2_500_000,
      [2_500_000, 500_000, 10_000, 1_000],
      true,
    )).toEqual([2_500_000]);
  });

  it("warms only the displayed level for a plain cool file", () => {
    expect(contactNormalizationPrewarmResolutions(
      1_000,
      [2_500_000, 500_000],
      false,
    )).toEqual([1_000]);
  });

  it("drops invalid resolution values", () => {
    expect(contactNormalizationPrewarmResolutions(
      1_000,
      [0, -1, Number.NaN, 1_000],
      true,
    )).toEqual([1_000]);
    expect(contactNormalizationPrewarmResolutions(
      Number.NaN,
      [1_000],
      true,
    )).toEqual([]);
  });

  it("keeps the current and most recently used normalization first", () => {
    expect(retainContactNormalizationHistory(
      ["raw", "ice", "kr"],
      "kr",
      3,
    )).toEqual(["kr", "raw", "ice"]);
  });

  it("warms all alternative coarse vectors inside one combined budget", () => {
    const plan = buildContactNormalizationWeightPrewarmPlan({
      activeNormalization: "raw",
      history: ["raw", "kr"],
      resolution: 2_500_000,
      totalSpanBp: 3_165_218_438,
    });

    expect(plan.normalizations).toEqual(["kr", "ice", "vc", "vc_sqrt"]);
    expect(plan.estimatedBytes).toBe(
      plan.estimatedBytesPerVector * plan.normalizations.length,
    );
    expect(plan.estimatedBytes).toBeLessThan(16 * 1024 * 1024);
  });

  it("does not sweep 1 kb alfalfa vectors beyond the byte budget", () => {
    const plan = buildContactNormalizationWeightPrewarmPlan({
      activeNormalization: "raw",
      history: ["raw", "kr"],
      resolution: 1_000,
      totalSpanBp: 3_165_218_438,
    });

    expect(plan.estimatedBytesPerVector).toBeGreaterThan(16 * 1024 * 1024);
    expect(plan.normalizations).toEqual([]);
    expect(plan.estimatedBytes).toBe(0);
  });

  it("uses the combined byte budget to keep only recent fine alternatives", () => {
    const plan = buildContactNormalizationWeightPrewarmPlan({
      activeNormalization: "ice",
      history: ["ice", "vc", "kr"],
      resolution: 5_000,
      totalSpanBp: 3_165_218_438,
      budgetBytes: 11 * 1024 * 1024,
    });

    expect(plan.normalizations).toEqual(["vc", "kr"]);
  });

  it("defers normalization work behind both exact and main-LOD flights", () => {
    const idle = {
      tileFlights: 0,
      mainLodFlights: 0,
      normalizationPrewarmActive: false,
      resolutionReaderPrewarmActive: false,
    };

    expect(contactNormalizationBackgroundWorkBlocked(idle)).toBe(false);
    expect(contactNormalizationBackgroundWorkBlocked({
      ...idle,
      tileFlights: 1,
    })).toBe(true);
    expect(contactNormalizationBackgroundWorkBlocked({
      ...idle,
      mainLodFlights: 1,
    })).toBe(true);
  });
});
