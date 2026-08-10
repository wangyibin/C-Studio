import type { ContactViewport } from "./contactViewport";
import type { ContactMapLayoutBlock } from "./importers";
import type { ContactNormalization } from "./uiState";

export interface ContactMapTileKey {
  tileX: number;
  tileY: number;
}

export const contactTileSizeBins = 256;

const layoutScopeCache = new WeakMap<ContactMapLayoutBlock[], string>();
const projectionBlockCache = new WeakMap<ContactMapLayoutBlock[], ProjectionBlock[]>();
const tileCacheKeyResolverCache = new WeakMap<
  ContactMapLayoutBlock[],
  Map<string, ContactTileCacheKeyResolver>
>();
const utf8Encoder = new TextEncoder();

interface ProjectionBlock {
  visualStart: number;
  visualEnd: number;
  sourceBytes: Uint8Array;
  sourceStart: number;
  sourceEnd: number;
  reverse: boolean;
}

interface ProjectionSegment {
  relativeVisualStart: number;
  relativeVisualEnd: number;
  sourceBytes: Uint8Array;
  sourceStart: number;
  sourceEnd: number;
  reverse: boolean;
}

export type ContactTileCacheKeyResolver = (tile: ContactMapTileKey) => string;

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

export function contactTileDataScope(
  coolPath: string,
  targetResolution: number,
  tileSizeBins: number,
  normalization: ContactNormalization,
): string {
  return `${coolPath}|${targetResolution}|${tileSizeBins}|${normalization}`;
}

export function contactTileScope(
  coolPath: string,
  targetResolution: number,
  tileSizeBins: number,
  normalization: ContactNormalization,
  layoutBlocks: ContactMapLayoutBlock[],
): string {
  let layoutFingerprint = layoutScopeCache.get(layoutBlocks);
  if (!layoutFingerprint) {
    const projectionBlocks = projectionBlocksForLayout(layoutBlocks);
    const visualEnd = projectionBlocks.reduce(
      (maximum, block) => Math.max(maximum, block.visualEnd),
      0,
    );
    // This scope is a render revision, not the per-tile cache identity. Keep it
    // global so an old complete frame can never cover a newly edited layout,
    // while ignoring labels that do not affect heatmap pixels.
    layoutFingerprint = projectionAxisFingerprint(projectionBlocks, 0, visualEnd);
    layoutScopeCache.set(layoutBlocks, layoutFingerprint);
  }

  return `${contactTileDataScope(
    coolPath,
    targetResolution,
    tileSizeBins,
    normalization,
  )}|${layoutFingerprint}`;
}

/**
 * Returns the layout identity for one canonical 2D tile. Each axis is hashed
 * independently from only the source projection intersecting that axis tile.
 * A flip therefore changes one row/column, while a move changes only the
 * old-to-new corridor and its crossings.
 */
export function contactTileProjectionFingerprint(
  tile: ContactMapTileKey,
  targetResolution: number,
  tileSizeBins: number,
  layoutBlocks: ContactMapLayoutBlock[],
): string {
  const canonical = canonicalContactTile(tile);
  const tileSpan = safePositiveInteger(targetResolution) * safePositiveInteger(tileSizeBins);
  const projectionBlocks = projectionBlocksForLayout(layoutBlocks);
  const axisFingerprints = new Map<number, string>();
  const fingerprintForAxis = (axis: number) => {
    const cached = axisFingerprints.get(axis);
    if (cached) {
      return cached;
    }
    const tileStart = safeCoordinate(axis) * tileSpan;
    const fingerprint = projectionAxisFingerprint(
      projectionBlocks,
      tileStart,
      tileStart + tileSpan,
    );
    axisFingerprints.set(axis, fingerprint);
    return fingerprint;
  };

  return `${fingerprintForAxis(canonical.tileX)}:${fingerprintForAxis(canonical.tileY)}`;
}

/**
 * Builds a memoized key resolver shared by the cache, tile-world projection,
 * and in-flight request registry. The global render scope deliberately stays
 * separate from this tile-local identity.
 */
export function createContactTileCacheKeyResolver(
  coolPath: string,
  targetResolution: number,
  tileSizeBins: number,
  normalization: ContactNormalization,
  layoutBlocks: ContactMapLayoutBlock[],
): ContactTileCacheKeyResolver {
  const dataScope = contactTileDataScope(
    coolPath,
    targetResolution,
    tileSizeBins,
    normalization,
  );
  let byDataScope = tileCacheKeyResolverCache.get(layoutBlocks);
  if (!byDataScope) {
    byDataScope = new Map();
    tileCacheKeyResolverCache.set(layoutBlocks, byDataScope);
  }
  const cachedResolver = byDataScope.get(dataScope);
  if (cachedResolver) {
    return cachedResolver;
  }

  const tileSpan = safePositiveInteger(targetResolution) * safePositiveInteger(tileSizeBins);
  const projectionBlocks = projectionBlocksForLayout(layoutBlocks);
  const axisFingerprints = new Map<number, string>();
  const tileKeys = new Map<string, string>();
  const fingerprintForAxis = (axis: number) => {
    const cached = axisFingerprints.get(axis);
    if (cached) {
      return cached;
    }
    const tileStart = safeCoordinate(axis) * tileSpan;
    const fingerprint = projectionAxisFingerprint(
      projectionBlocks,
      tileStart,
      tileStart + tileSpan,
    );
    axisFingerprints.set(axis, fingerprint);
    return fingerprint;
  };
  const resolver: ContactTileCacheKeyResolver = (tile) => {
    const canonical = canonicalContactTile(tile);
    const coordinateKey = contactTileKey(canonical);
    const cached = tileKeys.get(coordinateKey);
    if (cached) {
      return cached;
    }
    const projectionFingerprint = [
      fingerprintForAxis(canonical.tileX),
      fingerprintForAxis(canonical.tileY),
    ].join(":");
    const key = contactTileCacheKey(`${dataScope}|${projectionFingerprint}`, canonical);
    tileKeys.set(coordinateKey, key);
    return key;
  };
  byDataScope.set(dataScope, resolver);
  return resolver;
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
  cacheKeyForTile: ContactTileCacheKeyResolver = (tile) => contactTileCacheKey(scope, tile),
): ContactMapTileKey[] {
  return requiredTiles.filter((tile) => !cache.has(cacheKeyForTile(tile)));
}

function projectionBlocksForLayout(layoutBlocks: ContactMapLayoutBlock[]): ProjectionBlock[] {
  const cached = projectionBlockCache.get(layoutBlocks);
  if (cached) {
    return cached;
  }

  const projectionBlocks = layoutBlocks
    .map((block): ProjectionBlock | null => {
      const sourceStart = safeCoordinate(block.sourceStart);
      const sourceEnd = safeCoordinate(block.sourceEnd);
      const visualStart = safeCoordinate(block.visualStart);
      const span = sourceEnd - sourceStart;
      if (span <= 0) {
        return null;
      }
      const sourceId = String(block.sourceId);
      return {
        visualStart,
        // Derive this from the source span exactly as the Rust renderer does;
        // visualEnd and object/id labels do not participate in contact pixels.
        visualEnd: visualStart + span,
        sourceBytes: utf8Encoder.encode(sourceId),
        sourceStart,
        sourceEnd,
        reverse: isReverseOrientation(String(block.orientation)),
      };
    })
    .filter((block): block is ProjectionBlock => block !== null)
    .sort(compareProjectionBlocks);
  projectionBlockCache.set(layoutBlocks, projectionBlocks);
  return projectionBlocks;
}

function projectionAxisFingerprint(
  projectionBlocks: ProjectionBlock[],
  tileStart: number,
  tileEnd: number,
): string {
  const segments: ProjectionSegment[] = [];
  if (tileEnd > tileStart) {
    for (const block of projectionBlocks) {
      if (block.visualStart >= tileEnd) {
        break;
      }
      if (block.visualEnd <= tileStart) {
        continue;
      }
      const overlapStart = Math.max(tileStart, block.visualStart);
      const overlapEnd = Math.min(tileEnd, block.visualEnd);
      if (overlapStart >= overlapEnd) {
        continue;
      }
      const startOffset = overlapStart - block.visualStart;
      const endOffset = overlapEnd - block.visualStart;
      segments.push({
        relativeVisualStart: overlapStart - tileStart,
        relativeVisualEnd: overlapEnd - tileStart,
        sourceBytes: block.sourceBytes,
        sourceStart: block.reverse
          ? block.sourceEnd - endOffset
          : block.sourceStart + startOffset,
        sourceEnd: block.reverse
          ? block.sourceEnd - startOffset
          : block.sourceStart + endOffset,
        reverse: block.reverse,
      });
    }
  }
  segments.sort(compareProjectionSegments);

  let hash = 0xcbf29ce484222325n;
  const writeByte = (byte: number) => {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  };
  const writeU64 = (value: number | bigint) => {
    let remaining = typeof value === "bigint" ? value : BigInt(safeCoordinate(value));
    for (let index = 0; index < 8; index += 1) {
      writeByte(Number(remaining & 0xffn));
      remaining >>= 8n;
    }
  };
  for (const byte of [0x43, 0x53, 0x54, 0x4c, 0x01]) {
    writeByte(byte);
  }
  writeU64(segments.length);
  for (const segment of segments) {
    writeU64(segment.relativeVisualStart);
    writeU64(segment.relativeVisualEnd);
    writeU64(segment.sourceStart);
    writeU64(segment.sourceEnd);
    writeByte(segment.reverse ? 1 : 0);
    writeU64(segment.sourceBytes.length);
    for (const byte of segment.sourceBytes) {
      writeByte(byte);
    }
  }
  return hash.toString(16).padStart(16, "0");
}

function compareProjectionBlocks(left: ProjectionBlock, right: ProjectionBlock): number {
  return left.visualStart - right.visualStart
    || left.visualEnd - right.visualEnd
    || compareBytes(left.sourceBytes, right.sourceBytes)
    || left.sourceStart - right.sourceStart
    || left.sourceEnd - right.sourceEnd
    || Number(left.reverse) - Number(right.reverse);
}

function compareProjectionSegments(left: ProjectionSegment, right: ProjectionSegment): number {
  return left.relativeVisualStart - right.relativeVisualStart
    || left.relativeVisualEnd - right.relativeVisualEnd
    || compareBytes(left.sourceBytes, right.sourceBytes)
    || left.sourceStart - right.sourceStart
    || left.sourceEnd - right.sourceEnd
    || Number(left.reverse) - Number(right.reverse);
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = left[index] - right[index];
    if (difference !== 0) {
      return difference;
    }
  }
  return left.length - right.length;
}

function isReverseOrientation(orientation: string): boolean {
  return orientation === "-" || orientation.toLowerCase() === "reverse";
}

function safeCoordinate(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(value)));
}

function safePositiveInteger(value: number): number {
  return Math.max(1, safeCoordinate(value));
}
