import { describe, expect, it } from "vitest";
import {
  buildContactMainLodPlan,
  shouldUseContactMainLod,
} from "./contactMainLod";

const wholePojViewport = {
  xStart: 0,
  xEnd: 10_327_171_329,
  yStart: 0,
  yEnd: 10_327_171_329,
};

describe("main contact-map LOD planning", () => {
  it("routes a 153-tile whole-genome view to a screen-scale mcool level", () => {
    const plan = buildContactMainLodPlan({
      viewport: wholePojViewport,
      selectedResolution: 2_500_000,
      viewportWidthPx: 640,
      viewportHeightPx: 640,
      visibleTileCount: 153,
    }, [
      1_000,
      10_000,
      100_000,
      500_000,
      2_500_000,
    ]);

    expect(plan).toMatchObject({
      sourceResolution: 2_500_000,
      targetResolution: 17_500_000,
      viewport: wholePojViewport,
    });
    expect(Math.ceil(wholePojViewport.xEnd / plan!.targetResolution)).toBe(591);
  });

  it("uses the native cool resolution as the streaming source", () => {
    const plan = buildContactMainLodPlan({
      viewport: wholePojViewport,
      selectedResolution: 2_500_000,
      viewportWidthPx: 640,
      viewportHeightPx: 640,
      visibleTileCount: 153,
    }, [1_000]);

    expect(plan?.sourceResolution).toBe(1_000);
    expect(plan?.targetResolution).toBe(16_137_000);
  });

  it("keeps a local editing view on exact ordinary tiles", () => {
    const input = {
      viewport: {
        xStart: 2_000_000_000,
        xEnd: 2_640_000_000,
        yStart: 2_000_000_000,
        yEnd: 2_640_000_000,
      },
      selectedResolution: 2_500_000,
      viewportWidthPx: 640,
      viewportHeightPx: 640,
      visibleTileCount: 1,
    };

    expect(shouldUseContactMainLod(input)).toBe(false);
    expect(buildContactMainLodPlan(input, [1_000, 2_500_000])).toBeNull();
  });

  it("uses LOD when bin density is excessive even before tile count crosses the limit", () => {
    expect(shouldUseContactMainLod({
      viewport: { xStart: 0, xEnd: 1_000_000_000, yStart: 0, yEnd: 1_000_000_000 },
      selectedResolution: 100_000,
      viewportWidthPx: 640,
      viewportHeightPx: 640,
      visibleTileCount: 16,
    })).toBe(true);
  });
});
