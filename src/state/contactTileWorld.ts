import type { ContactMapTile, ContactMapView } from "../App";
import type { ContactViewport } from "./contactViewport";
import {
  canonicalContactTile,
  contactTileCacheKey,
  contactTileKey,
  contactTilesForViewport,
  type ContactTileCacheKeyResolver,
  type ContactMapTileKey,
} from "./contactTiles";

export const contactTileWorldPrefetchPadding = 1;

export interface ContactTileWorldInput {
  viewport: ContactViewport;
  resolution: number;
  tileSizeBins: number;
  scope: string;
  cache: Map<string, ContactMapTile>;
  cacheKeyForTile?: ContactTileCacheKeyResolver;
}

export interface ContactTileWorld {
  viewport: ContactViewport;
  resolution: number;
  tileSizeBins: number;
  scope: string;
  visibleTiles: ContactMapTileKey[];
  prefetchTiles: ContactMapTileKey[];
  cachedVisibleTiles: ContactMapTile[];
  cachedPrefetchTiles: ContactMapTile[];
  missingVisibleTiles: ContactMapTileKey[];
  missingPrefetchTiles: ContactMapTileKey[];
}

export interface ContactTileLoadPlan {
  visibleBatches: ContactMapTileKey[][];
  prefetchBatches: ContactMapTileKey[][];
}

export function buildContactTileWorld({
  viewport,
  resolution,
  tileSizeBins,
  scope,
  cache,
  cacheKeyForTile = (tile) => contactTileCacheKey(scope, tile),
}: ContactTileWorldInput): ContactTileWorld {
  const visibleTiles = contactTilesForViewport(viewport, resolution, tileSizeBins);
  const prefetchTiles = padTileKeys(visibleTiles, contactTileWorldPrefetchPadding);
  const cachedVisibleTiles = visibleTiles
    .map((tile) => cache.get(cacheKeyForTile(tile)))
    .filter((tile): tile is ContactMapTile => Boolean(tile));
  const cachedPrefetchTiles = prefetchTiles
    .map((tile) => cache.get(cacheKeyForTile(tile)))
    .filter((tile): tile is ContactMapTile => Boolean(tile));
  const missingVisibleTiles = visibleTiles.filter(
    (tile) => !cache.has(cacheKeyForTile(tile)),
  );
  const missingPrefetchTiles = prefetchTiles.filter(
    (tile) => !cache.has(cacheKeyForTile(tile)),
  );

  return {
    viewport,
    resolution,
    tileSizeBins,
    scope,
    visibleTiles,
    prefetchTiles,
    cachedVisibleTiles,
    cachedPrefetchTiles,
    missingVisibleTiles,
    missingPrefetchTiles,
  };
}

export function projectContactTileWorldView(world: ContactTileWorld): ContactMapView {
  return {
    resolution: world.resolution,
    viewport: world.viewport,
    cells: [],
    tileSizeBins: world.tileSizeBins,
    tiles: world.cachedVisibleTiles,
    cachedTiles: world.cachedPrefetchTiles,
  };
}

export function buildContactTileLoadPlan(
  world: ContactTileWorld,
  maxPrefetchTiles: number,
  visibleBatchSize = 4,
  prefetchBatchSize = visibleBatchSize,
): ContactTileLoadPlan {
  const safeVisibleBatchSize = Math.max(1, Math.floor(visibleBatchSize));
  const safePrefetchBatchSize = Math.max(1, Math.floor(prefetchBatchSize));
  const tileSpan = Math.max(1, world.resolution * world.tileSizeBins);
  const centerTileX = ((world.viewport.xStart + world.viewport.xEnd) / 2) / tileSpan;
  const centerTileY = ((world.viewport.yStart + world.viewport.yEnd) / 2) / tileSpan;
  const distanceFromViewportCenter = (tile: ContactMapTileKey) => {
    const direct = (tile.tileX + 0.5 - centerTileX) ** 2
      + (tile.tileY + 0.5 - centerTileY) ** 2;
    const transposed = (tile.tileY + 0.5 - centerTileX) ** 2
      + (tile.tileX + 0.5 - centerTileY) ** 2;
    return Math.min(direct, transposed);
  };
  const byDistance = (left: ContactMapTileKey, right: ContactMapTileKey) => {
    const distance = distanceFromViewportCenter(left) - distanceFromViewportCenter(right);
    return distance || left.tileY - right.tileY || left.tileX - right.tileX;
  };
  const visible = [...world.missingVisibleTiles].sort(byDistance);
  const visibleKeys = new Set(world.visibleTiles.map(contactTileKey));
  const prefetch = world.missingPrefetchTiles
    .filter((tile) => !visibleKeys.has(contactTileKey(tile)))
    .sort(byDistance)
    .slice(0, Math.max(0, Math.floor(maxPrefetchTiles)));

  return {
    visibleBatches: chunkTiles(visible, safeVisibleBatchSize),
    prefetchBatches: chunkTiles(prefetch, safePrefetchBatchSize),
  };
}

function chunkTiles(tiles: ContactMapTileKey[], batchSize: number): ContactMapTileKey[][] {
  const batches: ContactMapTileKey[][] = [];
  for (let index = 0; index < tiles.length; index += batchSize) {
    batches.push(tiles.slice(index, index + batchSize));
  }
  return batches;
}

function padTileKeys(tiles: ContactMapTileKey[], padding: number): ContactMapTileKey[] {
  const paddedTiles = new Map<string, ContactMapTileKey>();

  for (const tile of tiles) {
    for (let tileY = Math.max(0, tile.tileY - padding); tileY <= tile.tileY + padding; tileY += 1) {
      for (let tileX = Math.max(0, tile.tileX - padding); tileX <= tile.tileX + padding; tileX += 1) {
        const paddedTile = canonicalContactTile({ tileX, tileY });
        paddedTiles.set(contactTileKey(paddedTile), paddedTile);
      }
    }
  }

  return [...paddedTiles.values()];
}
