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
  prefetchViewport?: ContactViewport;
  resolution: number;
  tileSizeBins: number;
  totalSpanBp?: number;
  scope: string;
  cache: Map<string, ContactMapTile>;
  cacheKeyForTile?: ContactTileCacheKeyResolver;
}

export interface ContactTileWorld {
  viewport: ContactViewport;
  prefetchViewport: ContactViewport;
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
  /** Directionally leading tiles that should start beside the visible request. */
  urgentPrefetchTiles: ContactMapTileKey[];
  prefetchBatches: ContactMapTileKey[][];
}

export function buildContactTileWorld({
  viewport,
  prefetchViewport = viewport,
  resolution,
  tileSizeBins,
  totalSpanBp,
  scope,
  cache,
  cacheKeyForTile = (tile) => contactTileCacheKey(scope, tile),
}: ContactTileWorldInput): ContactTileWorld {
  const visibleTiles = contactTilesForViewport(
    viewport,
    resolution,
    tileSizeBins,
    totalSpanBp,
  );
  const maximumTileIndex = Number.isFinite(totalSpanBp)
    ? Math.max(0, Math.ceil(totalSpanBp! / Math.max(1, resolution * tileSizeBins)) - 1)
    : Number.POSITIVE_INFINITY;
  const prefetchBasisTiles = contactTilesForViewport(
    prefetchViewport,
    resolution,
    tileSizeBins,
    totalSpanBp,
  );
  const prefetchTiles = padTileKeys(prefetchBasisTiles, contactTileWorldPrefetchPadding)
    .filter((tile) => tile.tileX <= maximumTileIndex && tile.tileY <= maximumTileIndex);
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
    prefetchViewport,
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
  urgentPrefetchTileCount = 0,
): ContactTileLoadPlan {
  const safeVisibleBatchSize = Math.max(1, Math.floor(visibleBatchSize));
  const safePrefetchBatchSize = Math.max(1, Math.floor(prefetchBatchSize));
  const tileSpan = Math.max(1, world.resolution * world.tileSizeBins);
  const centerTileX = ((world.viewport.xStart + world.viewport.xEnd) / 2) / tileSpan;
  const centerTileY = ((world.viewport.yStart + world.viewport.yEnd) / 2) / tileSpan;
  const prefetchCenterTileX = (
    (world.prefetchViewport.xStart + world.prefetchViewport.xEnd) / 2
  ) / tileSpan;
  const prefetchCenterTileY = (
    (world.prefetchViewport.yStart + world.prefetchViewport.yEnd) / 2
  ) / tileSpan;
  const distanceFromCenter = (
    tile: ContactMapTileKey,
    centerX: number,
    centerY: number,
  ) => {
    const direct = (tile.tileX + 0.5 - centerX) ** 2
      + (tile.tileY + 0.5 - centerY) ** 2;
    const transposed = (tile.tileY + 0.5 - centerX) ** 2
      + (tile.tileX + 0.5 - centerY) ** 2;
    return Math.min(direct, transposed);
  };
  const byDistanceFrom = (centerX: number, centerY: number) => (
    left: ContactMapTileKey,
    right: ContactMapTileKey,
  ) => {
    const distance = distanceFromCenter(left, centerX, centerY)
      - distanceFromCenter(right, centerX, centerY);
    return distance || left.tileY - right.tileY || left.tileX - right.tileX;
  };
  const visible = [...world.missingVisibleTiles].sort(byDistanceFrom(centerTileX, centerTileY));
  const visibleKeys = new Set(world.visibleTiles.map(contactTileKey));
  const prefetch = world.missingPrefetchTiles
    .filter((tile) => !visibleKeys.has(contactTileKey(tile)))
    .sort(byDistanceFrom(prefetchCenterTileX, prefetchCenterTileY))
    .slice(0, Math.max(0, Math.floor(maxPrefetchTiles)));
  const urgentCount = Math.min(
    prefetch.length,
    Math.max(0, Math.floor(
      Number.isFinite(urgentPrefetchTileCount) ? urgentPrefetchTileCount : 0,
    )),
  );
  const urgentPrefetchTiles = prefetch.slice(0, urgentCount);
  const backgroundPrefetchTiles = prefetch.slice(urgentCount);

  return {
    visibleBatches: chunkTiles(visible, safeVisibleBatchSize),
    urgentPrefetchTiles,
    prefetchBatches: chunkTiles(backgroundPrefetchTiles, safePrefetchBatchSize),
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
