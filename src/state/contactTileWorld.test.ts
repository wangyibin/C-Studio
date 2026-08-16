import { describe, expect, it } from "vitest";
import type { ContactMapTile } from "../App";
import type { ContactMapLayoutBlock } from "./importers";
import {
  contactTileCacheKey,
  contactTileKey,
  createContactTileCacheKeyResolver,
} from "./contactTiles";
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

  it("uses a directional look-ahead viewport only for prefetch coverage", () => {
    const prefetchViewport = {
      xStart: 512_000,
      xEnd: 1_024_000,
      yStart: 256_000,
      yEnd: 768_000,
    };
    const world = buildContactTileWorld({
      viewport,
      prefetchViewport,
      resolution: 1_000,
      tileSizeBins: 256,
      totalSpanBp: 2_000_000,
      scope,
      cache: new Map(),
    });

    expect(world.visibleTiles).toEqual([
      { tileX: 0, tileY: 1 },
      { tileX: 1, tileY: 1 },
      { tileX: 0, tileY: 2 },
      { tileX: 1, tileY: 2 },
    ]);
    expect(world.prefetchViewport).toEqual(prefetchViewport);
    expect(world.prefetchTiles).toContainEqual({ tileX: 3, tileY: 4 });
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
    const plan = buildContactTileLoadPlan(world, 5, 2, 4);

    expect(plan.visibleBatches.flat()).toHaveLength(world.missingVisibleTiles.length);
    expect(plan.visibleBatches.every((batch) => batch.length <= 2)).toBe(true);
    expect(plan.prefetchBatches.flat()).toHaveLength(5);
    expect(plan.urgentPrefetchTiles).toEqual([]);
    expect(plan.prefetchBatches.every((batch) => batch.length <= 4)).toBe(true);
    expect(plan.visibleBatches.length).toBeGreaterThan(1);
    expect(plan.prefetchBatches.flat()).not.toContainEqual({ tileX: 0, tileY: 1 });
  });

  it("promotes the closest directional look-ahead tiles without expanding the total budget", () => {
    const prefetchViewport = {
      xStart: 512_000,
      xEnd: 1_024_000,
      yStart: 256_000,
      yEnd: 768_000,
    };
    const world = buildContactTileWorld({
      viewport,
      prefetchViewport,
      resolution: 1_000,
      tileSizeBins: 256,
      totalSpanBp: 2_000_000,
      scope,
      cache: new Map(),
    });
    const plan = buildContactTileLoadPlan(world, 5, 2, 4, 3);
    const background = plan.prefetchBatches.flat();

    expect(plan.urgentPrefetchTiles).toHaveLength(3);
    expect(background).toHaveLength(2);
    expect([...plan.urgentPrefetchTiles, ...background]).toHaveLength(5);
    expect(background).not.toEqual(expect.arrayContaining(plan.urgentPrefetchTiles));
    expect(plan.urgentPrefetchTiles).toContainEqual({ tileX: 2, tileY: 2 });
  });

  it("bounds visible and prefetched tiles at the genome edge while the viewport shows empty field", () => {
    const world = buildContactTileWorld({
      viewport: { xStart: 0, xEnd: 1_024_000, yStart: 0, yEnd: 1_024_000 },
      resolution: 1_000,
      tileSizeBins: 256,
      totalSpanBp: 500_000,
      scope,
      cache: new Map(),
    });

    expect(world.visibleTiles).toEqual([
      { tileX: 0, tileY: 0 },
      { tileX: 0, tileY: 1 },
      { tileX: 1, tileY: 1 },
    ]);
    expect(world.prefetchTiles.every((tile) => tile.tileX <= 1 && tile.tileY <= 1)).toBe(true);
  });

  it("prioritizes the on-screen center below the diagonal after tile canonicalization", () => {
    const tileSpan = 256_000;
    const belowDiagonalWorld = buildContactTileWorld({
      viewport: {
        xStart: 10 * tileSpan,
        xEnd: 13 * tileSpan,
        yStart: 0,
        yEnd: 3 * tileSpan,
      },
      resolution: 1_000,
      tileSizeBins: 256,
      scope,
      cache: new Map(),
    });
    const plan = buildContactTileLoadPlan(belowDiagonalWorld, 0, 1, 4);

    expect(plan.visibleBatches[0]).toEqual([{ tileX: 1, tileY: 11 }]);
  });

  it("projects only locally valid cached tiles after flip and insertion edits", () => {
    const layout = (order: string[], reverseSource?: string): ContactMapLayoutBlock[] => (
      order.map((sourceId, index) => ({
        id: `block-${sourceId}`,
        objectId: "Chr01",
        sourceId,
        sourceStart: 0,
        sourceEnd: 100,
        visualStart: index * 100,
        visualEnd: (index + 1) * 100,
        orientation: sourceId === reverseSource ? "-" : "+",
      }))
    );
    const sources = ["A", "B", "C", "D", "E", "F"];
    const before = layout(sources);
    const beforeKey = createContactTileCacheKeyResolver("/tmp/input.cool", 10, 10, "raw", before);
    const cache = new Map<string, ContactMapTile>();
    for (let tileY = 0; tileY < 6; tileY += 1) {
      for (let tileX = 0; tileX <= tileY; tileX += 1) {
        const tile = { tileX, tileY, cells: [] };
        cache.set(beforeKey(tile), tile);
      }
    }
    const buildEditedWorld = (blocks: ContactMapLayoutBlock[]) => buildContactTileWorld({
      viewport: { xStart: 0, xEnd: 600, yStart: 0, yEnd: 600 },
      resolution: 10,
      tileSizeBins: 10,
      scope: "new-render-revision",
      cache,
      cacheKeyForTile: createContactTileCacheKeyResolver(
        "/tmp/input.cool",
        10,
        10,
        "raw",
        blocks,
      ),
    });

    const flipped = buildEditedWorld(layout(sources, "B"));
    expect(flipped.cachedVisibleTiles).toHaveLength(15);
    expect(flipped.missingVisibleTiles.map(contactTileKey)).toEqual([
      "0:1", "1:1", "1:2", "1:3", "1:4", "1:5",
    ]);

    const inserted = buildEditedWorld(layout(["A", "C", "D", "B", "E", "F"]));
    expect(inserted.cachedVisibleTiles).toHaveLength(6);
    expect(inserted.missingVisibleTiles).toHaveLength(15);

    const labelsOnly = buildEditedWorld(before.map((block, index) => ({
      ...block,
      id: `renamed-${index}`,
      objectId: index === 1 ? "Chr02" : block.objectId,
    })));
    expect(labelsOnly.cachedVisibleTiles).toHaveLength(21);
    expect(labelsOnly.missingVisibleTiles).toEqual([]);
  });
});
