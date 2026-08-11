import { describe, expect, it } from "vitest";
import {
  buildContactOverviewTilePlan,
  contactOverviewGenerationIsReady,
  contactOverviewRequestIsReady,
  overviewResolutionForSpan,
  shouldResumeContactBackgroundSchedulingAfterFailure,
  type ContactOverviewRequestReadiness,
} from "./contactOverviewTiles";

describe("contact overview tile planning", () => {
  it("keeps a whole-genome overview close to the 320-bin canvas budget", () => {
    const plan = buildContactOverviewTilePlan(476_713_192, 256);

    expect(plan.targetResolution).toBe(2_000_000);
    expect(plan.viewport).toEqual({
      xStart: 0,
      xEnd: 476_713_192,
      yStart: 0,
      yEnd: 476_713_192,
    });
    expect(plan.tiles).toEqual([{ tileX: 0, tileY: 0 }]);
  });

  it("uses the largest supported coarse resolution for very large spans", () => {
    expect(overviewResolutionForSpan(10_000_000_000)).toBe(10_000_000);
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
