import { describe, expect, it } from "vitest";
import {
  buildContactOverviewTilePlan,
  contactResolutionAtOrAbove,
  closestContactResolution,
  contactOverviewBaseIsCompatible,
  contactOverviewGenerationIsReady,
  contactOverviewRequestIsReady,
  overviewResolutionForSpan,
  retainContactOverviewRequestId,
  shouldResumeContactBackgroundSchedulingAfterFailure,
  wholeAssemblyOverviewFromCoveringMap,
  type ContactOverviewRequestReadiness,
} from "./contactOverviewTiles";

describe("contact overview tile planning", () => {
  it("keeps a whole-genome overview close to the 320-bin canvas budget", () => {
    const plan = buildContactOverviewTilePlan(476_713_192, [1_000]);

    expect(plan).toMatchObject({
      sourceResolution: 1_000,
      targetResolution: 1_490_000,
      targetBins: 320,
    });
    expect(plan.viewport).toEqual({
      xStart: 0,
      xEnd: 476_713_192,
      yStart: 0,
      yEnd: 476_713_192,
    });
  });

  it("reads the mcool level nearest to the overview pixel scale", () => {
    const levels = [20_000_000, 10_000_000, 2_500_000, 1_000];
    const plan = buildContactOverviewTilePlan(10_327_171_329, levels);

    expect(plan.sourceResolution).toBe(20_000_000);
    expect(plan.targetResolution).toBe(40_000_000);
    expect(Math.ceil(10_327_171_329 / plan.targetResolution)).toBeLessThanOrEqual(320);
  });

  it("uses the coarsest stored level when a large mcool has no screen-scale level", () => {
    const levels = [
      2_500_000,
      1_000_000,
      500_000,
      250_000,
      100_000,
      50_000,
      25_000,
      10_000,
      5_000,
      2_000,
      1_000,
    ];
    const plan = buildContactOverviewTilePlan(10_327_171_329, levels);

    expect(plan.sourceResolution).toBe(2_500_000);
    expect(plan.targetResolution).toBe(32_500_000);
    expect(Math.ceil(10_327_171_329 / plan.targetResolution)).toBe(318);
  });

  it("aggregates a single-resolution cool directly to the overview scale", () => {
    expect(overviewResolutionForSpan(10_000_000_000, [1_000])).toBe(31_250_000);
  });

  it("prefers the coarser level when two stored levels are equally close", () => {
    expect(closestContactResolution(15_000_000, [10_000_000, 20_000_000]))
      .toBe(20_000_000);
  });

  it("uses the first stored level at or above the navigation pixel scale", () => {
    expect(contactResolutionAtOrAbove(70_000, [25_000, 50_000, 100_000]))
      .toBe(100_000);
    expect(contactResolutionAtOrAbove(20_000_000, [1_000, 2_500_000]))
      .toBe(2_500_000);
  });
});

describe("contact overview request readiness", () => {
  const ready: ContactOverviewRequestReadiness = {
    currentGeneration: 42,
    backendStartedGeneration: 42,
    paintedGeneration: 42,
    completeLayerGeneration: 42,
    documentHidden: false,
  };

  it("requires both backend generation acknowledgement and complete-layer paint", () => {
    expect(contactOverviewRequestIsReady(ready)).toBe(true);
    expect(contactOverviewGenerationIsReady(ready)).toBe(true);
    expect(contactOverviewRequestIsReady({
      ...ready,
      backendStartedGeneration: 41,
    })).toBe(false);
    expect(contactOverviewRequestIsReady({
      ...ready,
      paintedGeneration: 41,
    })).toBe(false);
    expect(contactOverviewRequestIsReady({
      ...ready,
      completeLayerGeneration: 41,
    })).toBe(false);
  });

  it("defers while the document is hidden", () => {
    expect(contactOverviewRequestIsReady({ ...ready, documentHidden: true })).toBe(false);
  });

  it("keeps the adjacent-to-overview chain alive after spatial prefetch fails", () => {
    expect(shouldResumeContactBackgroundSchedulingAfterFailure(true)).toBe(true);
    expect(shouldResumeContactBackgroundSchedulingAfterFailure(false)).toBe(false);
  });

  it("retains one active whole-map fallback across foreground pan generations", () => {
    expect(retainContactOverviewRequestId([11, 12], 13)).toEqual([11, 12, 13]);
    expect(retainContactOverviewRequestId([11, 13], 13)).toEqual([11, 13]);
    expect(retainContactOverviewRequestId([11], null)).toEqual([11]);
  });
});

describe("contact overview reuse", () => {
  it("admits only a complete overview from the active layout and normalization", () => {
    const activeLayout = [{
      id: "block-1",
      objectId: "chr1",
      sourceId: "ctg1",
      visualStart: 0,
      visualEnd: 1_000,
      sourceStart: 0,
      sourceEnd: 1_000,
      orientation: "+" as const,
    }];
    const overview = {
      resolution: 10,
      normalization: "raw" as const,
      viewport: { xStart: 0, xEnd: 1_000, yStart: 0, yEnd: 1_000 },
      cells: [],
      layoutBlocks: activeLayout,
      visibleLayerComplete: true,
    };

    expect(contactOverviewBaseIsCompatible(overview, activeLayout, "raw")).toBe(true);
    expect(contactOverviewBaseIsCompatible(overview, [...activeLayout], "raw")).toBe(false);
    expect(contactOverviewBaseIsCompatible(overview, activeLayout, "ice")).toBe(false);
    expect(contactOverviewBaseIsCompatible({
      ...overview,
      visibleLayerComplete: false,
    }, activeLayout, "raw")).toBe(false);
  });

  it("crops a covering rectangular main LOD without copying its cells", () => {
    const cells = [{ xBin: 1, yBin: 2, count: 3 }];
    const map = {
      resolution: 10_000,
      normalization: "raw" as const,
      viewport: {
        xStart: 0,
        xEnd: 14_000_000_000,
        yStart: 0,
        yEnd: 10_000_000_000,
      },
      cells,
      visibleLayerComplete: true,
    };

    const overview = wholeAssemblyOverviewFromCoveringMap(map, 10_000_000_000);

    expect(overview).not.toBeNull();
    expect(overview?.viewport).toEqual({
      xStart: 0,
      xEnd: 10_000_000_000,
      yStart: 0,
      yEnd: 10_000_000_000,
    });
    expect(overview?.cells).toBe(cells);
    expect(wholeAssemblyOverviewFromCoveringMap({
      ...map,
      viewport: { ...map.viewport, xStart: 1 },
    }, 10_000_000_000)).toBeNull();
  });
});
