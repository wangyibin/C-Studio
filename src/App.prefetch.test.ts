import { describe, expect, it } from "vitest";
import { buildContactPanPrefetchPlan } from "./App";

describe("resolution prefetch planning", () => {
  it("warms the screen-scale LOD used by a whole-genome 2.5 Mb switch", () => {
    const totalSpanBp = 10_370_812_184;
    const plan = buildContactPanPrefetchPlan({
      availableResolutions: [1_000, 100_000, 2_500_000],
      coolPath: "/tmp/example.mcool",
      normalization: "raw",
      selectedResolution: 2_500_000,
      totalSpanBp,
      viewport: {
        xStart: 0,
        xEnd: totalSpanBp,
        yStart: 0,
        yEnd: totalSpanBp,
      },
      viewportHeightPx: 640,
      viewportWidthPx: 640,
    });

    expect(plan).toMatchObject({
      adaptiveRefinement: false,
      baseResolution: 2_500_000,
      sourceResolution: 2_500_000,
      targetResolution: 17_500_000,
      tileSizeBins: 256,
      usesMainLod: true,
    });
    expect(plan.visibleTiles).toHaveLength(6);
  });

  it("uses the same bounded 2.5 Mb interaction LOD for Raw and KR", () => {
    const totalSpanBp = 3_165_218_438;
    const input = {
      availableResolutions: [1_000, 10_000, 100_000, 500_000, 2_500_000],
      coolPath: "/tmp/alfalfa.mcool",
      selectedResolution: 2_500_000,
      totalSpanBp,
      viewport: {
        xStart: 0,
        xEnd: totalSpanBp,
        yStart: 0,
        yEnd: totalSpanBp,
      },
      viewportHeightPx: 1_200,
      viewportWidthPx: 1_200,
    };
    const raw = buildContactPanPrefetchPlan({ ...input, normalization: "raw" });
    const kr = buildContactPanPrefetchPlan({ ...input, normalization: "kr" });

    expect(raw).toMatchObject({
      targetResolution: 5_000_000,
      usesMainLod: true,
    });
    expect(kr).toMatchObject({
      targetResolution: raw.targetResolution,
      tileSizeBins: raw.tileSizeBins,
      usesMainLod: true,
    });
  });
});
