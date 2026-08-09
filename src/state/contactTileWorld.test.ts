import { describe, expect, it } from "vitest";
import type { ContactMapTile } from "../App";
import { contactTileCacheKey } from "./contactTiles";
import {
  buildContactTileWorld,
  buildContactTileLoadPlan,
  contactTileWorldPrefetchPadding,
  projectContactTileWorldView,
} from "./contactTileWorld";

describe("contact tile world", () => {
  const viewport = { xStart: 0, xEnd: 512_000, yStart: 256_000, yEnd: 768_000 };
  const scope = "dataset|1000|256|layout";

  it("tracks visible tiles separately from padded prefetch tiles", () => {
    const world = buildContactTileWorld({
      viewport,
      resolution: 1_000,
      tileSizeBins: 256,
      scope,
      cache: new Map(),
    });

    expect(world.visibleTiles).toEqual([
      { tileX: 0, tileY: 1 },
      { tileX: 1, tileY: 1 },
      { tileX: 0, tileY: 2 },
      { tileX: 1, tileY: 2 },
    ]);
    expect(world.prefetchTiles).toContainEqual({ tileX: 0, tileY: 0 });
    expect(world.prefetchTiles).toContainEqual({ tileX: 2, tileY: 3 });
    expect(world.prefetchTiles.every((tile) => tile.tileX <= tile.tileY)).toBe(true);
    expect(new Set(world.prefetchTiles.map((tile) => `${tile.tileX}:${tile.tileY}`)).size)
      .toBe(world.prefetchTiles.length);
    expect(world.prefetchTiles.length).toBeGreaterThan(world.visibleTiles.length);
    expect(contactTileWorldPrefetchPadding).toBe(1);
  });

  it("requests only cache-missing padded tiles while projecting cached visible tiles", () => {
    const visibleTile: ContactMapTile = {
      tileX: 0,
      tileY: 1,
      cells: [{ xBin: 4, yBin: 260, count: 7 }],
    };
    const prefetchedTile: ContactMapTile = {
      tileX: 0,
      tileY: 0,
      cells: [{ xBin: 1, yBin: 2, count: 3 }],
    };
    const cache = new Map([
      [contactTileCacheKey(scope, visibleTile), visibleTile],
      [contactTileCacheKey(scope, prefetchedTile), prefetchedTile],
    ]);

    const world = buildContactTileWorld({
      viewport,
      resolution: 1_000,
      tileSizeBins: 256,
      scope,
      cache,
    });
    const view = projectContactTileWorldView(world);

    expect(world.cachedVisibleTiles).toEqual([visibleTile]);
    expect(world.missingVisibleTiles).not.toContainEqual({ tileX: 0, tileY: 1 });
    expect(world.missingVisibleTiles).toContainEqual({ tileX: 1, tileY: 1 });
    expect(world.missingPrefetchTiles).not.toContainEqual({ tileX: 0, tileY: 0 });
    expect(world.missingPrefetchTiles).not.toContainEqual({ tileX: 0, tileY: 1 });
    expect(view).toEqual({
      resolution: 1_000,
      viewport,
      cells: [],
      tileSizeBins: 256,
      tiles: [visibleTile],
      cachedTiles: [prefetchedTile, visibleTile],
    });
  });

  it("loads visible tiles first in small batches, then bounded nearby prefetch tiles", () => {
    const world = buildContactTileWorld({
      viewport,
      resolution: 1_000,
      tileSizeBins: 256,
      scope,
      cache: new Map(),
    });
    const plan = buildContactTileLoadPlan(world, 5, 2);

    expect(plan.visibleBatches.flat()).toHaveLength(world.missingVisibleTiles.length);
    expect(plan.visibleBatches.every((batch) => batch.length <= 2)).toBe(true);
    expect(plan.prefetchBatches.flat()).toHaveLength(5);
    expect(plan.prefetchBatches.every((batch) => batch.length <= 2)).toBe(true);
    expect(plan.prefetchBatches.flat()).not.toContainEqual({ tileX: 0, tileY: 1 });
  });
});
