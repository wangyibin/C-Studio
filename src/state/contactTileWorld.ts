import type { ContactMapTile, ContactMapView } from "../App";
import type { ContactViewport } from "./contactViewport";
import {
  canonicalContactTile,
  contactTileCacheKey,
  contactTileKey,
  contactTilesForViewport,
  type ContactMapTileKey,
} from "./contactTiles";

export const contactTileWorldPrefetchPadding = 1;

export interface ContactTileWorldInput {
  viewport: ContactViewport;
  resolution: number;
  tileSizeBins: number;
  scope: string;
  cache: Map<string, ContactMapTile>;
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
}: ContactTileWorldInput): ContactTileWorld {
  const visibleTiles = contactTilesForViewport(viewport, resolution, tileSizeBins);
  const prefetchTiles = padTileKeys(visibleTiles, contactTileWorldPrefetchPadding);
  const cachedVisibleTiles = visibleTiles
    .map((tile) => cache.get(contactTileCacheKey(scope, tile)))
    .filter((tile): tile is ContactMapTile => Boolean(tile));
  const cachedPrefetchTiles = prefetchTiles
    .map((tile) => cache.get(contactTileCacheKey(scope, tile)))
    .filter((tile): tile is ContactMapTile => Boolean(tile));
  const missingVisibleTiles = visibleTiles.filter(
    (tile) => !cache.has(contactTileCacheKey(scope, tile)),
  );
  const missingPrefetchTiles = prefetchTiles.filter(
    (tile) => !cache.has(contactTileCacheKey(scope, tile)),
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
  batchSize = 4,
): ContactTileLoadPlan {
  const safeBatchSize = Math.max(1, Math.floor(batchSize));
  const tileSpan = Math.max(1, world.resolution * world.tileSizeBins);
  const centerTileX = ((world.viewport.xStart + world.viewport.xEnd) / 2) / tileSpan;
  const centerTileY = ((world.viewport.yStart + world.viewport.yEnd) / 2) / tileSpan;
  const byDistance = (left: ContactMapTileKey, right: ContactMapTileKey) => {
    const leftDistance = (left.tileX + 0.5 - centerTileX) ** 2
      + (left.tileY + 0.5 - centerTileY) ** 2;
    const rightDistance = (right.tileX + 0.5 - centerTileX) ** 2
      + (right.tileY + 0.5 - centerTileY) ** 2;
    return leftDistance - rightDistance;
  };
  const visible = [...world.missingVisibleTiles].sort(byDistance);
  const visibleKeys = new Set(world.visibleTiles.map(contactTileKey));
  const prefetch = world.missingPrefetchTiles
    .filter((tile) => !visibleKeys.has(contactTileKey(tile)))
    .sort(byDistance)
    .slice(0, Math.max(0, Math.floor(maxPrefetchTiles)));

  return {
    visibleBatches: chunkTiles(visible, safeBatchSize),
    prefetchBatches: chunkTiles(prefetch, safeBatchSize),
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
