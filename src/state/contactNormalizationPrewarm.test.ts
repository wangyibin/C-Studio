import { describe, expect, it } from "vitest";
import { contactNormalizationPrewarmResolutions } from "./contactNormalizationPrewarm";

describe("contact normalization prewarm planning", () => {
  it("keeps only the displayed mcool resolution and its two neighbors", () => {
    expect(contactNormalizationPrewarmResolutions(
      10_000,
      [2_500_000, 500_000, 10_000, 1_000],
      true,
    )).toEqual([10_000, 500_000, 1_000]);
  });

  it("keeps one neighbor at a pyramid edge", () => {
    expect(contactNormalizationPrewarmResolutions(
      2_500_000,
      [2_500_000, 500_000, 10_000, 1_000],
      true,
    )).toEqual([2_500_000, 500_000]);
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
  });
});
