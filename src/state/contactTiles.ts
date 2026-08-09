import type { ContactViewport } from "./contactViewport";
import type { ContactMapLayoutBlock } from "./importers";

export interface ContactMapTileKey {
  tileX: number;
  tileY: number;
}

export const contactTileSizeBins = 256;

const layoutScopeCache = new WeakMap<ContactMapLayoutBlock[], string>();

export function canonicalContactTile(tile: ContactMapTileKey): ContactMapTileKey {
  return tile.tileX <= tile.tileY
    ? tile
    : { tileX: tile.tileY, tileY: tile.tileX };
}

export function contactTileKey(tile: ContactMapTileKey): string {
  const canonical = canonicalContactTile(tile);
  return `${canonical.tileX}:${canonical.tileY}`;
}

export function contactTileCacheKey(scope: string, tile: ContactMapTileKey): string {
  return `${scope}:${contactTileKey(tile)}`;
}

export function contactTileScope(
  coolPath: string,
  targetResolution: number,
  tileSizeBins: number,
  layoutBlocks: ContactMapLayoutBlock[],
): string {
  let layoutFingerprint = layoutScopeCache.get(layoutBlocks);
  if (!layoutFingerprint) {
    // Keep cache keys fixed-size. Embedding a fragmented assembly's complete AGP
    // in every tile key makes otherwise O(1) Map lookups copy megabytes of text.
    let first = 0x811c9dc5;
    let second = 0x9e3779b9;
    for (const block of layoutBlocks) {
      const fields = [
        block.id,
        block.objectId,
        block.sourceId,
        block.sourceStart,
        block.sourceEnd,
        block.visualStart,
        block.visualEnd,
        block.orientation,
      ];
      for (const field of fields) {
        const value = String(field);
        for (let index = 0; index < value.length; index += 1) {
          const code = value.charCodeAt(index);
          first = Math.imul(first ^ code, 0x01000193);
          second = Math.imul(second ^ code, 0x85ebca6b);
        }
        first = Math.imul(first ^ 0xff, 0x01000193);
        second = Math.imul(second ^ 0xff, 0xc2b2ae35);
      }
    }
    layoutFingerprint = `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
    layoutScopeCache.set(layoutBlocks, layoutFingerprint);
  }

  return `${coolPath}|${targetResolution}|${tileSizeBins}|${layoutFingerprint}`;
}

export function contactTilesForViewport(
  viewport: ContactViewport,
  resolution: number,
  tileSizeBins: number,
): ContactMapTileKey[] {
  const safeResolution = Math.max(1, Math.round(resolution));
  const safeTileSizeBins = Math.max(1, Math.round(tileSizeBins));
  const xStartBin = Math.floor(Math.max(0, viewport.xStart) / safeResolution);
  const xEndBin = Math.max(xStartBin + 1, Math.ceil(Math.max(0, viewport.xEnd) / safeResolution));
  const yStartBin = Math.floor(Math.max(0, viewport.yStart) / safeResolution);
  const yEndBin = Math.max(yStartBin + 1, Math.ceil(Math.max(0, viewport.yEnd) / safeResolution));
  const minTileX = Math.floor(xStartBin / safeTileSizeBins);
  const maxTileX = Math.floor((xEndBin - 1) / safeTileSizeBins);
  const minTileY = Math.floor(yStartBin / safeTileSizeBins);
  const maxTileY = Math.floor((yEndBin - 1) / safeTileSizeBins);
  const tiles = new Map<string, ContactMapTileKey>();

  for (let tileY = minTileY; tileY <= maxTileY; tileY += 1) {
    for (let tileX = minTileX; tileX <= maxTileX; tileX += 1) {
      const tile = canonicalContactTile({ tileX, tileY });
      tiles.set(contactTileKey(tile), tile);
    }
  }

  return [...tiles.values()];
}

export function missingContactTiles<Tile extends ContactMapTileKey>(
  requiredTiles: ContactMapTileKey[],
  cache: Map<string, Tile>,
  scope: string,
): ContactMapTileKey[] {
  return requiredTiles.filter((tile) => !cache.has(contactTileCacheKey(scope, tile)));
}
