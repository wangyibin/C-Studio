import { describe, expect, it } from "vitest";
import {
  buildContactMainLodPlan,
  buildContactMainLodNormalizationResidencyPlan,
  buildContactMainLodWholeResidencyPlan,
  combineContactMainLodVisibleBatches,
  contactMainLodPlanChangesSampling,
  contactMainLodR16fBytesPerTexel,
  contactMainLodTileCacheLimits,
  contactMainLodTileSizeBins,
  contactMainLodVisibleBatchSize,
  contactMainLodWholeResidencyBudgetBytes,
  maxAdaptiveMcoolExactTiles,
  shouldUseContactMainLod,
} from "./contactMainLod";
import { contactTileCacheKey, contactTileKey } from "./contactTiles";
import { buildContactTileLoadPlan, buildContactTileWorld } from "./contactTileWorld";

const wholePojViewport = {
  xStart: 0,
  xEnd: 10_327_171_329,
  yStart: 0,
  yEnd: 10_327_171_329,
};

describe("main contact-map LOD planning", () => {
  it("keeps a same-resolution tile-count crossing on the warm exact pipeline", () => {
    const plan = buildContactMainLodPlan({
      viewport: {
        xStart: 5_750_000_000,
        xEnd: 6_770_000_000,
        yStart: 5_303_000_000,
        yEnd: 6_014_000_000,
      },
      selectedResolution: 1_000_000,
      viewportWidthPx: 1_020,
      viewportHeightPx: 711,
      visibleTileCount: 19,
    }, [1_000_000, 2_500_000]);

    expect(plan).toMatchObject({
      sourceResolution: 1_000_000,
      targetResolution: 1_000_000,
    });
    expect(contactMainLodPlanChangesSampling(plan, 1_000_000)).toBe(false);
  });

  it("retains LOD when it actually changes stored or displayed sampling", () => {
    expect(contactMainLodPlanChangesSampling({
      sourceResolution: 100_000,
      targetResolution: 200_000,
      viewport: { xStart: 0, xEnd: 1, yStart: 0, yEnd: 1 },
      binsPerPixel: 2,
    }, 50_000)).toBe(true);
  });

  it("combines center-first presentation batches into one visible LOD request", () => {
    expect(combineContactMainLodVisibleBatches([
      [{ tileX: 0, tileY: 0 }],
      [{ tileX: 0, tileY: 1 }, { tileX: 1, tileY: 1 }],
    ])).toEqual([
      { tileX: 0, tileY: 0 },
      { tileX: 0, tileY: 1 },
      { tileX: 1, tileY: 1 },
    ]);
  });

  it("keeps coarse navigation tiles in a bounded cache separate from exact tiles", () => {
    expect(contactMainLodTileSizeBins).toBe(256);
    expect(contactMainLodTileCacheLimits).toEqual({
      maxScopes: 5,
      maxTiles: 96,
      maxCells: 6_000_000,
      maxBytes: 32 * 1024 * 1024,
    });
  });

  it("keeps the complete 2.5 Mb alfalfa interaction level inside the hard budget", () => {
    const plan = buildContactMainLodWholeResidencyPlan({
      totalSpanBp: 3_165_218_438,
      resolution: 2_500_000,
    });

    expect(plan).toMatchObject({
      axisTileCount: 5,
      estimatedCells: 15 * 256 * 256,
      estimatedBytes: 15 * 256 * 256 * contactMainLodR16fBytesPerTexel,
    });
    expect(plan?.tiles).toHaveLength(15);
    expect(plan?.tiles[0]).toEqual({ tileX: 0, tileY: 0 });
    expect(plan!.tiles[plan!.tiles.length - 1]).toEqual({ tileX: 4, tileY: 4 });
    expect(plan!.estimatedBytes).toBeLessThan(contactMainLodWholeResidencyBudgetBytes);
  });

  it("keeps finer alfalfa levels on bounded viewport streaming", () => {
    expect(buildContactMainLodWholeResidencyPlan({
      totalSpanBp: 3_165_218_438,
      resolution: 1_000_000,
    })).toBeNull();
    expect(buildContactMainLodWholeResidencyPlan({
      totalSpanBp: 3_165_218_438,
      resolution: 500_000,
    })).toBeNull();
  });

  it("fits all coarse alfalfa normalization variants under one combined budget", () => {
    const wholeResidencyPlan = buildContactMainLodWholeResidencyPlan({
      totalSpanBp: 3_165_218_438,
      resolution: 2_500_000,
    });
    const plan = buildContactMainLodNormalizationResidencyPlan({
      activeNormalization: "raw",
      availableNormalizations: ["raw", "ice", "kr", "vc", "vc_sqrt"],
      history: ["raw", "kr"],
      wholeResidencyPlan: wholeResidencyPlan!,
    });

    expect(plan.normalizations).toEqual(["raw", "kr", "ice", "vc", "vc_sqrt"]);
    expect(plan.tileCount).toBe(75);
    expect(plan.estimatedBytes).toBe(5 * 15 * 256 * 256 * 2);
    expect(plan.estimatedBytes).toBeLessThan(16 * 1024 * 1024);
  });

  it("keeps the active coarse normalization when variants cross the combined cap", () => {
    const wholeResidencyPlan = buildContactMainLodWholeResidencyPlan({
      totalSpanBp: 3_165_218_438,
      resolution: 2_500_000,
    });
    const plan = buildContactMainLodNormalizationResidencyPlan({
      activeNormalization: "vc",
      availableNormalizations: ["raw", "ice", "kr", "vc", "vc_sqrt"],
      history: ["vc", "raw", "kr"],
      wholeResidencyPlan: wholeResidencyPlan!,
      budgetBytes: wholeResidencyPlan!.estimatedBytes * 2,
    });

    expect(plan.normalizations).toEqual(["vc", "raw"]);
  });

  it("rejects a whole level when its dense R16F bytes cross the explicit cap", () => {
    const input = {
      totalSpanBp: 1_000,
      resolution: 100,
      tileSizeBins: 4,
      maxTiles: 100,
      maxCells: 10_000,
    };
    const expectedBytes = 6 * 4 * 4 * contactMainLodR16fBytesPerTexel;

    expect(buildContactMainLodWholeResidencyPlan({
      ...input,
      budgetBytes: expectedBytes,
    })?.estimatedBytes).toBe(expectedBytes);
    expect(buildContactMainLodWholeResidencyPlan({
      ...input,
      budgetBytes: expectedBytes - 1,
    })).toBeNull();
  });

  it("reuses overlapping coarse tiles and requests only the newly exposed edge", () => {
    const resolution = 17_500_000;
    const tileSpan = resolution * contactMainLodTileSizeBins;
    const scope = "lod|17.5m|256|layout";
    const firstWorld = buildContactTileWorld({
      viewport: {
        xStart: 0,
        xEnd: tileSpan * 2,
        yStart: 0,
        yEnd: tileSpan * 2,
      },
      resolution,
      tileSizeBins: contactMainLodTileSizeBins,
      totalSpanBp: wholePojViewport.xEnd,
      scope,
      cache: new Map(),
    });
    const cache = new Map(firstWorld.visibleTiles.map((tile) => {
      const cachedTile = { ...tile, cells: [] };
      return [contactTileCacheKey(scope, tile), cachedTile] as const;
    }));
    const pannedWorld = buildContactTileWorld({
      viewport: {
        xStart: tileSpan,
        xEnd: wholePojViewport.xEnd,
        yStart: 0,
        yEnd: tileSpan * 2,
      },
      resolution,
      tileSizeBins: contactMainLodTileSizeBins,
      totalSpanBp: wholePojViewport.xEnd,
      scope,
      cache,
    });
    const loadPlan = buildContactTileLoadPlan(
      pannedWorld,
      0,
      contactMainLodVisibleBatchSize,
    );

    expect(firstWorld.visibleTiles.map(contactTileKey)).toEqual(["0:0", "0:1", "1:1"]);
    expect(pannedWorld.cachedVisibleTiles.map(contactTileKey)).toEqual(["0:1", "1:1"]);
    expect(pannedWorld.missingVisibleTiles.map(contactTileKey)).toEqual(["0:2", "1:2"]);
    expect(loadPlan.visibleBatches).toHaveLength(1);
    expect(loadPlan.visibleBatches[0]).toHaveLength(2);
  });

  it("bounds recursive mcool refinement to one local 2x2 tile neighborhood", () => {
    expect(maxAdaptiveMcoolExactTiles).toBe(4);
  });

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

  it("never reads a stored level finer than the navigation pixel grid", () => {
    const plan = buildContactMainLodPlan({
      viewport: {
        xStart: 0,
        xEnd: 44_800_000,
        yStart: 0,
        yEnd: 44_800_000,
      },
      selectedResolution: 25_000,
      viewportWidthPx: 640,
      viewportHeightPx: 640,
      visibleTileCount: 18,
    }, [25_000, 50_000, 100_000, 250_000]);

    // 70 kb per pixel sits closer to 50 kb, but 100 kb avoids reading and
    // discarding four 50 kb cells for every displayed pixel.
    expect(plan).toMatchObject({
      sourceResolution: 100_000,
      targetResolution: 100_000,
    });
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

  it("lets adaptive mcool callers lower the exact tile limit to four", () => {
    expect(shouldUseContactMainLod({
      viewport: {
        xStart: 0,
        xEnd: 1_280_000_000,
        yStart: 0,
        yEnd: 1_280_000_000,
      },
      selectedResolution: 2_500_000,
      viewportWidthPx: 640,
      viewportHeightPx: 640,
      visibleTileCount: 5,
      exactTileLimit: maxAdaptiveMcoolExactTiles,
    })).toBe(true);
  });

  it("keeps a 1 kb local view exact but terminates a large 2.5 Mb jump at stored LOD", () => {
    const fineLocalPlan = buildContactMainLodPlan({
      viewport: {
        xStart: 5_000_000_000,
        xEnd: 5_000_640_000,
        yStart: 5_000_000_000,
        yEnd: 5_000_640_000,
      },
      selectedResolution: 1_000,
      viewportWidthPx: 640,
      viewportHeightPx: 640,
      visibleTileCount: 9,
    }, [1_000, 2_500_000]);

    const coarseJumpPlan = buildContactMainLodPlan({
      viewport: {
        xStart: 4_000_000_000,
        xEnd: 5_600_000_000,
        yStart: 4_000_000_000,
        yEnd: 5_600_000_000,
      },
      selectedResolution: 2_500_000,
      viewportWidthPx: 640,
      viewportHeightPx: 640,
      visibleTileCount: 9,
      exactTileLimit: maxAdaptiveMcoolExactTiles,
    }, [1_000, 2_500_000]);

    expect(fineLocalPlan).toBeNull();
    expect(coarseJumpPlan).toMatchObject({
      sourceResolution: 2_500_000,
      targetResolution: 2_500_000,
    });
  });
});
