import { describe, expect, it } from "vitest";
import type { ContactMapLayoutBlock } from "./importers";
import { buildCenteredContactViewport } from "./contactViewport";
import { createInitialUiState, reduceUiState } from "./uiState";
import {
  canonicalContactTile,
  contactTileCacheKey,
  contactTileKey,
  contactTileScope,
  contactTilesForViewport,
  missingContactTiles,
} from "./contactTiles";

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
    const lowResolutionScope = contactTileScope("/tmp/input.mcool", 10_000, 256, layoutBlocks);
    const highResolutionScope = contactTileScope("/tmp/input.mcool", 50_000, 256, layoutBlocks);
    const cachedTile = { tileX: 0, tileY: 0, cells: [] };
    const cache = new Map([[contactTileCacheKey(lowResolutionScope, cachedTile), cachedTile]]);

    expect(missingContactTiles([cachedTile], cache, highResolutionScope)).toEqual([cachedTile]);
    expect(lowResolutionScope).not.toEqual(highResolutionScope);
  });

  it("changes scope when AGP layout changes", () => {
    const first = contactTileScope("/tmp/input.mcool", 10_000, 256, [
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
    const flipped = contactTileScope("/tmp/input.mcool", 10_000, 256, [
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

    const scope = contactTileScope("/tmp/input.mcool", 10_000, 256, fragmented);
    expect(scope.length).toBeLessThan(100);
    expect(contactTileScope("/tmp/input.mcool", 10_000, 256, fragmented)).toBe(scope);
  });
});
