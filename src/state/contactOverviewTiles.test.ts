import { describe, expect, it } from "vitest";
import {
  buildContactOverviewTilePlan,
  closestContactResolution,
  contactOverviewGenerationIsReady,
  contactOverviewRequestIsReady,
  overviewResolutionForSpan,
  shouldResumeContactBackgroundSchedulingAfterFailure,
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
});
