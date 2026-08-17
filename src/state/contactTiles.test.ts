import { describe, expect, it } from "vitest";
import type { ContactMapLayoutBlock } from "./importers";
import { buildCenteredContactViewport } from "./contactViewport";
import { createInitialUiState, reduceUiState } from "./uiState";
import {
  canonicalContactTile,
  contactTileCacheKey,
  contactTileDataScope,
  contactTileKey,
  contactTileProjectionFingerprint,
  contactTileScope,
  contactTileViewportRequestKey,
  contactTileViewportSignature,
  contactTilesForViewport,
  createContactTileCacheKeyResolver,
  missingContactTiles,
} from "./contactTiles";

const localInvalidationSources = ["A", "B", "C", "D", "E", "F"];

function localInvalidationLayout(
  order = localInvalidationSources,
  reverseSource?: string,
): ContactMapLayoutBlock[] {
  return order.map((sourceId, index) => ({
    id: `block-${sourceId}`,
    objectId: "Chr01",
    sourceId,
    sourceStart: 0,
    sourceEnd: 100,
    visualStart: index * 100,
    visualEnd: (index + 1) * 100,
    orientation: sourceId === reverseSource ? "-" : "+",
  }));
}

function canonicalTileGrid(size: number) {
  const tiles = [];
  for (let tileY = 0; tileY < size; tileY += 1) {
    for (let tileX = 0; tileX <= tileY; tileX += 1) {
      tiles.push({ tileX, tileY });
    }
  }
  return tiles;
}

describe("contact tile requests", () => {
  it("covers only tiles intersecting the viewport", () => {
    expect(
      contactTilesForViewport(
        { xStart: 0, xEnd: 512_000, yStart: 256_000, yEnd: 768_000 },
        1_000,
        256,
      ),
    ).toEqual([
      { tileX: 0, tileY: 1 },
      { tileX: 1, tileY: 1 },
      { tileX: 0, tileY: 2 },
      { tileX: 1, tileY: 2 },
    ]);
  });

  it("canonicalizes lower-triangle view tiles so each symmetric pair renders once", () => {
    expect(canonicalContactTile({ tileX: 3, tileY: 1 })).toEqual({ tileX: 1, tileY: 3 });
    expect(contactTileKey({ tileX: 3, tileY: 1 })).toBe("1:3");
    expect(
      contactTilesForViewport(
        { xStart: 256_000, xEnd: 768_000, yStart: 0, yEnd: 512_000 },
        1_000,
        256,
      ),
    ).toEqual([
      { tileX: 0, tileY: 1 },
      { tileX: 0, tileY: 2 },
      { tileX: 1, tileY: 1 },
      { tileX: 1, tileY: 2 },
    ]);
  });

  it("requests three canonical tiles for a square viewport spanning a 2 by 2 grid", () => {
    expect(
      contactTilesForViewport(
        { xStart: 0, xEnd: 512_000, yStart: 0, yEnd: 512_000 },
        1_000,
        256,
      ),
    ).toEqual([
      { tileX: 0, tileY: 0 },
      { tileX: 0, tileY: 1 },
      { tileX: 1, tileY: 1 },
    ]);
  });

  it("does not request tiles in the empty field beyond the genome", () => {
    expect(
      contactTilesForViewport(
        { xStart: 0, xEnd: 1_024_000, yStart: 0, yEnd: 1_024_000 },
        1_000,
        256,
        500_000,
      ),
    ).toEqual([
      { tileX: 0, tileY: 0 },
      { tileX: 0, tileY: 1 },
      { tileX: 1, tileY: 1 },
    ]);
  });

  it("changes the viewport signature only after panning crosses a tile boundary", () => {
    const initial = contactTileViewportSignature(
      { xStart: 10_000, xEnd: 200_000, yStart: 20_000, yEnd: 210_000 },
      1_000,
      256,
      1_000_000,
    );
    const insideSameTiles = contactTileViewportSignature(
      { xStart: 20_000, xEnd: 210_000, yStart: 30_000, yEnd: 220_000 },
      1_000,
      256,
      1_000_000,
    );
    const crossesRightEdge = contactTileViewportSignature(
      { xStart: 80_000, xEnd: 270_000, yStart: 30_000, yEnd: 220_000 },
      1_000,
      256,
      1_000_000,
    );

    expect(insideSameTiles).toBe(initial);
    expect(crossesRightEdge).not.toBe(initial);
  });

  it("refreshes the request key when look-ahead crosses before the visible viewport", () => {
    const visibleViewport = {
      xStart: 10_000,
      xEnd: 250_000,
      yStart: 10_000,
      yEnd: 250_000,
    };
    const initialPrefetchViewport = {
      xStart: 20_000,
      xEnd: 250_000,
      yStart: 20_000,
      yEnd: 250_000,
    };
    const crossedPrefetchViewport = {
      xStart: 256_000,
      xEnd: 512_000,
      yStart: 256_000,
      yEnd: 512_000,
    };
    const requestKey = (prefetchViewport: typeof initialPrefetchViewport) => (
      contactTileViewportRequestKey(
        visibleViewport,
        prefetchViewport,
        1_000,
        256,
        1_000_000,
      )
    );

    expect(contactTileViewportSignature(
      visibleViewport,
      1_000,
      256,
      1_000_000,
    )).toBe("0:0");
    expect(requestKey(crossedPrefetchViewport)).not.toBe(
      requestKey(initialPrefetchViewport),
    );
  });

  it("promotes the same visible and prefetch grids when urgent pan mode starts", () => {
    const viewport = {
      xStart: 10_000,
      xEnd: 250_000,
      yStart: 10_000,
      yEnd: 250_000,
    };
    const requestKey = (urgentPrefetchTileCount: number) => (
      contactTileViewportRequestKey(
        viewport,
        viewport,
        1_000,
        256,
        1_000_000,
        urgentPrefetchTileCount,
      )
    );

    expect(requestKey(4)).not.toBe(requestKey(0));
    expect(requestKey(8)).toBe(requestKey(4));
  });

  it("bounds visible tiles by the measured viewport after selecting 5 kb", () => {
    let state = createInitialUiState("ready");
    state = reduceUiState(state, {
      type: "setContactViewportMetrics",
      viewportSizePx: 536,
      totalSpanMb: 200,
    });
    state = reduceUiState(state, { type: "setContactResolution", resolution: "5 kb" });
    const viewport = buildCenteredContactViewport({
      centerMb: state.contact.viewportCenterMb,
      centerXMb: state.contact.viewportCenterXMb,
      centerYMb: state.contact.viewportCenterYMb,
      totalSpanBp: 200_000_000,
      windowSizeBp: state.contact.viewportSpanMb * 1_000_000,
    });
    const tiles = contactTilesForViewport(viewport, 5_000, 256);

    expect(state.contact.viewportSpanMb).toBe(2.68);
    expect(tiles.length).toBeLessThanOrEqual(10);
  });

  it("returns only cache-missing tiles for a scoped dataset", () => {
    const scope = "dataset|1000|256|layout";
    const cachedTile = { tileX: 0, tileY: 1, cells: [] };
    const cache = new Map([[contactTileCacheKey(scope, cachedTile), cachedTile]]);

    expect(
      missingContactTiles(
        [
          { tileX: 0, tileY: 1 },
          { tileX: 1, tileY: 1 },
        ],
        cache,
        scope,
      ),
    ).toEqual([{ tileX: 1, tileY: 1 }]);
  });

  it("treats the same tile coordinate at a different resolution as cache-missing", () => {
    const layoutBlocks: ContactMapLayoutBlock[] = [
      {
        id: "block-1",
        objectId: "Chr01",
        sourceId: "ctg1",
        sourceStart: 0,
        sourceEnd: 100_000,
        visualStart: 0,
        visualEnd: 100_000,
        orientation: "+",
      },
    ];
    const lowResolutionScope = contactTileScope(
      "/tmp/input.mcool",
      10_000,
      256,
      "raw",
      layoutBlocks,
    );
    const highResolutionScope = contactTileScope(
      "/tmp/input.mcool",
      50_000,
      256,
      "raw",
      layoutBlocks,
    );
    const cachedTile = { tileX: 0, tileY: 0, cells: [] };
    const cache = new Map([[contactTileCacheKey(lowResolutionScope, cachedTile), cachedTile]]);

    expect(missingContactTiles([cachedTile], cache, highResolutionScope)).toEqual([cachedTile]);
    expect(lowResolutionScope).not.toEqual(highResolutionScope);
  });

  it("isolates data scopes, render scopes, and tile cache keys by normalization", () => {
    const layoutBlocks = localInvalidationLayout();
    const normalizationModes = ["raw", "ice", "kr", "vc", "vc_sqrt"] as const;
    const dataScopes = normalizationModes.map((normalization) =>
      contactTileDataScope("/tmp/input.mcool", 10_000, 256, normalization)
    );
    const renderScopes = normalizationModes.map((normalization) =>
      contactTileScope("/tmp/input.mcool", 10_000, 256, normalization, layoutBlocks)
    );
    const tileCacheKeys = normalizationModes.map((normalization) =>
      createContactTileCacheKeyResolver(
        "/tmp/input.mcool",
        10_000,
        256,
        normalization,
        layoutBlocks,
      )({ tileX: 0, tileY: 1 })
    );

    expect(new Set(dataScopes).size).toBe(normalizationModes.length);
    expect(new Set(renderScopes).size).toBe(normalizationModes.length);
    expect(new Set(tileCacheKeys).size).toBe(normalizationModes.length);
  });

  it("changes scope when AGP layout changes", () => {
    const first = contactTileScope("/tmp/input.mcool", 10_000, 256, "raw", [
      {
        id: "block-1",
        objectId: "Chr01",
        sourceId: "ctg1",
        sourceStart: 0,
        sourceEnd: 100_000,
        visualStart: 0,
        visualEnd: 100_000,
        orientation: "+",
      },
    ]);
    const flipped = contactTileScope("/tmp/input.mcool", 10_000, 256, "raw", [
      {
        id: "block-1",
        objectId: "Chr01",
        sourceId: "ctg1",
        sourceStart: 0,
        sourceEnd: 100_000,
        visualStart: 0,
        visualEnd: 100_000,
        orientation: "-",
      },
    ]);

    expect(contactTileKey({ tileX: 2, tileY: 3 })).toBe("2:3");
    expect(first).not.toEqual(flipped);
  });

  it("keeps fragmented-layout cache scopes fixed-size", () => {
    const fragmented = Array.from({ length: 2_000 }, (_, index) => ({
      id: `block-${index}`,
      objectId: "Chr01",
      sourceId: `ctg-${index}`,
      sourceStart: 0,
      sourceEnd: 1_000,
      visualStart: index * 1_000,
      visualEnd: (index + 1) * 1_000,
      orientation: "+" as const,
    }));

    const scope = contactTileScope("/tmp/input.mcool", 10_000, 256, "raw", fragmented);
    expect(scope.length).toBeLessThan(100);
    expect(contactTileScope("/tmp/input.mcool", 10_000, 256, "raw", fragmented)).toBe(scope);
  });

  it("invalidates only the selected contig row and column after a flip", () => {
    const before = localInvalidationLayout();
    const after = localInvalidationLayout(localInvalidationSources, "B");
    const beforeKey = createContactTileCacheKeyResolver("/tmp/input.cool", 10, 10, "raw", before);
    const afterKey = createContactTileCacheKeyResolver("/tmp/input.cool", 10, 10, "raw", after);
    const changed = canonicalTileGrid(6)
      .filter((tile) => beforeKey(tile) !== afterKey(tile))
      .map(contactTileKey);

    expect(changed).toEqual(["0:1", "1:1", "1:2", "1:3", "1:4", "1:5"]);
    expect(contactTileScope("/tmp/input.cool", 10, 10, "raw", before))
      .not.toBe(contactTileScope("/tmp/input.cool", 10, 10, "raw", after));
  });

  it("invalidates only the old-to-new insertion corridor and its crossings", () => {
    const before = localInvalidationLayout();
    const after = localInvalidationLayout(["A", "C", "D", "B", "E", "F"]);
    const beforeKey = createContactTileCacheKeyResolver("/tmp/input.cool", 10, 10, "raw", before);
    const afterKey = createContactTileCacheKeyResolver("/tmp/input.cool", 10, 10, "raw", after);
    const reused = canonicalTileGrid(6)
      .filter((tile) => beforeKey(tile) === afterKey(tile))
      .map(contactTileKey);

    expect(reused).toEqual(["0:0", "0:4", "4:4", "0:5", "4:5", "5:5"]);
  });

  it("does not invalidate heatmap tiles for object or block label-only changes", () => {
    const before = localInvalidationLayout();
    const after = before.map((block, index) => ({
      ...block,
      id: `renamed-${index}`,
      objectId: index === 1 ? "Chr02" : block.objectId,
    }));
    const beforeKey = createContactTileCacheKeyResolver("/tmp/input.cool", 10, 10, "raw", before);
    const afterKey = createContactTileCacheKeyResolver("/tmp/input.cool", 10, 10, "raw", after);

    expect(canonicalTileGrid(6).every((tile) => beforeKey(tile) === afterKey(tile))).toBe(true);
    expect(contactTileScope("/tmp/input.cool", 10, 10, "raw", before))
      .toBe(contactTileScope("/tmp/input.cool", 10, 10, "raw", after));
  });

  it("invalidates source-related tiles when a copy outside the tile changes signal shares", () => {
    const before = localInvalidationLayout();
    const after = [
      ...before,
      {
        ...before[0],
        id: "block-A-copy",
        visualStart: 600,
        visualEnd: 700,
      },
    ];
    const beforeKey = createContactTileCacheKeyResolver("/tmp/input.cool", 10, 10, "raw", before);
    const afterKey = createContactTileCacheKeyResolver("/tmp/input.cool", 10, 10, "raw", after);

    expect(beforeKey({ tileX: 0, tileY: 1 })).not.toBe(afterKey({ tileX: 0, tileY: 1 }));
    expect(beforeKey({ tileX: 1, tileY: 1 })).toBe(afterKey({ tileX: 1, tileY: 1 }));
  });

  it("uses the pinned UTF-8 tile projection fingerprint shared with Rust", () => {
    const layout: ContactMapLayoutBlock[] = [{
      id: "ignored-id",
      objectId: "Chr01",
      sourceId: "片段|β",
      sourceStart: 7,
      sourceEnd: 107,
      visualStart: 0,
      visualEnd: 999,
      orientation: "?",
    }];

    expect(contactTileProjectionFingerprint({ tileX: 0, tileY: 0 }, 10, 10, layout))
      .toBe("ac570d514b060508:ac570d514b060508");
  });
});
