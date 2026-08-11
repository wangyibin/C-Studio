import type { ContactMapCell, ContactMapTile, ContactMapView } from "../App";
import {
  contactTileCellCount,
  forEachContactTileCell,
  validatedPackedContactTileCells,
  type ContactTileData,
} from "./contactTileData";
import { contactTileKey } from "./contactTiles";
import type { ContactMapLayoutBlock } from "./importers";

export const maxDrawableContactCells = 120_000;
export const maxInteractivePreviewContactCells = 30_000;

export function contactCellsForViewport(
  contactMap: ContactMapView,
  maxCells = maxDrawableContactCells,
): ContactMapCell[] {
  const tileSizeBins = contactMap.tileSizeBins ?? 256;
  const hasTileLayers = contactMap.cachedTiles !== undefined
    || contactMap.tiles !== undefined
    || contactMap.previewTiles !== undefined;
  if (!hasTileLayers) {
    return thinContactCellsForDrawing(contactMap.cells, maxCells);
  }
  const tiles = contactTilesWithPreviewFallback(
    contactMap.cachedTiles ?? contactMap.tiles ?? [],
    contactMap.previewTiles ?? [],
  );

  const visibleTiles = tiles.filter((tile) => {
    const tileStartX = tile.tileX * tileSizeBins * contactMap.resolution;
    const tileEndX = tileStartX + tileSizeBins * contactMap.resolution;
    const tileStartY = tile.tileY * tileSizeBins * contactMap.resolution;
    const tileEndY = tileStartY + tileSizeBins * contactMap.resolution;
    if (
      tileEndX < contactMap.viewport.xStart ||
      tileStartX > contactMap.viewport.xEnd ||
      tileEndY < contactMap.viewport.yStart ||
      tileStartY > contactMap.viewport.yEnd
    ) {
      return false;
    }

    return true;
  });

  return thinContactTileCellsForDrawing(visibleTiles, tileSizeBins, maxCells);
}

export function displayContactMapForPendingLayer(
  pendingContactMap: ContactMapView,
  previousContactMap: ContactMapView | null,
  visibleLayerComplete = true,
): ContactMapView {
  const hasPendingVisibleTiles = pendingContactMap.cells.length > 0
    || (pendingContactMap.tiles?.length ?? 0) > 0
    || (pendingContactMap.previewTiles?.length ?? 0) > 0;
  if (hasPendingVisibleTiles || !previousContactMap) {
    return pendingContactMap;
  }

  const layersAreCompatible = !visibleLayerComplete
    && pendingContactMap.resolution === previousContactMap.resolution
    && (pendingContactMap.tileSizeBins ?? 256) === (previousContactMap.tileSizeBins ?? 256)
    && pendingContactMap.layoutScope !== undefined
    && pendingContactMap.layoutScope === previousContactMap.layoutScope;
  if (layersAreCompatible) {
    return {
      ...previousContactMap,
      viewport: pendingContactMap.viewport,
    };
  }

  return pendingContactMap;
}

/** Returns whether a resolution/layout transition needs a retained front buffer. */
export function shouldHoldPreviousContactMapFrame(
  previousContactMap: ContactMapView | null,
  nextResolution: number,
  nextTileSizeBins: number,
  nextLayoutScope: string,
): boolean {
  return Boolean(
    previousContactMap
    && (
      previousContactMap.resolution !== nextResolution
      || (previousContactMap.tileSizeBins ?? 256) !== nextTileSizeBins
      || previousContactMap.layoutScope !== nextLayoutScope
    ),
  );
}

/**
 * Resolution and layout transitions use double buffering: keep the previous
 * complete generation visible until every tile in the new viewport is ready.
 */
export function shouldPublishContactMapLayer(
  holdsPreviousCompleteFrame: boolean,
  visibleLayerComplete: boolean,
): boolean {
  return !holdsPreviousCompleteFrame || visibleLayerComplete;
}

/**
 * Builds a fast, bounded preview after a pure layout permutation (move/reverse).
 * The authoritative source-contact tiles still replace this preview in the
 * background, but editing no longer has to wait for an IPC round trip.
 */
export function reprojectContactMapLayout(
  contactMap: ContactMapView,
  previousBlocks: ContactMapLayoutBlock[],
  nextBlocks: ContactMapLayoutBlock[],
): ContactMapView | null {
  if (!isLayoutPermutation(previousBlocks, nextBlocks)) {
    return null;
  }
  // This is a display-only preview, so bins crossing a contig boundary may be
  // approximated by their center and corrected by authoritative tiles later.
  // Deterministic thinning keeps the synchronous edit path bounded even for a
  // very dense map.
  const sourceCells = contactCellsForViewport(contactMap, maxInteractivePreviewContactCells);

  const nextById = new Map(nextBlocks.map((block) => [block.id, block]));
  const aggregate = new Map<string, ContactMapCell>();

  for (const cell of sourceCells) {
    const xBin = reprojectBin(cell.xBin, contactMap.resolution, previousBlocks, nextById);
    const yBin = reprojectBin(cell.yBin, contactMap.resolution, previousBlocks, nextById);
    if (xBin === null || yBin === null) {
      continue;
    }

    const orderedX = Math.min(xBin, yBin);
    const orderedY = Math.max(xBin, yBin);
    const key = `${orderedX}:${orderedY}`;
    const existing = aggregate.get(key);
    if (existing) {
      existing.count += cell.count;
    } else {
      aggregate.set(key, { xBin: orderedX, yBin: orderedY, count: cell.count });
    }
  }

  const cells = [...aggregate.values()];
  const tileSizeBins = contactMap.tileSizeBins ?? 256;
  return {
    resolution: contactMap.resolution,
    viewport: contactMap.viewport,
    cells,
    tileSizeBins,
    previewTiles: contactPreviewTilesFromCells(cells, tileSizeBins),
    layoutBlocks: nextBlocks,
  };
}

/**
 * Composes one display layer without contaminating the authoritative cache.
 * Exact tiles always win, including exact empty tiles, so each backend arrival
 * replaces only the matching preview canvas.
 */
export function contactTilesWithPreviewFallback(
  authoritativeTiles: ContactMapTile[],
  previewTiles: ContactMapTile[],
): ContactMapTile[] {
  const tilesByKey = new Map<string, ContactMapTile>();
  for (const tile of previewTiles) {
    tilesByKey.set(contactTileKey(tile), tile);
  }
  for (const tile of authoritativeTiles) {
    tilesByKey.set(contactTileKey(tile), tile);
  }
  return [...tilesByKey.values()].sort(
    (left, right) => left.tileY - right.tileY || left.tileX - right.tileX,
  );
}

export function contactPreviewTilesForMissing(
  previewTiles: ContactMapTile[],
  missingTiles: Array<{ tileX: number; tileY: number }>,
): ContactMapTile[] {
  const missingKeys = new Set(missingTiles.map(contactTileKey));
  return previewTiles.filter((tile) => missingKeys.has(contactTileKey(tile)));
}

function contactPreviewTilesFromCells(cells: ContactMapCell[], tileSizeBins: number) {
  const tilesByKey = new Map<string, ContactMapTile>();
  for (const cell of cells) {
    const tileX = Math.floor(cell.xBin / tileSizeBins);
    const tileY = Math.floor(cell.yBin / tileSizeBins);
    const key = contactTileKey({ tileX, tileY });
    const existing = tilesByKey.get(key);
    if (existing) {
      existing.cells.push(cell);
    } else {
      tilesByKey.set(key, { tileX, tileY, cells: [cell] });
    }
  }
  return [...tilesByKey.values()];
}

function isLayoutPermutation(
  previousBlocks: ContactMapLayoutBlock[],
  nextBlocks: ContactMapLayoutBlock[],
) {
  if (previousBlocks.length === 0 || previousBlocks.length !== nextBlocks.length) {
    return false;
  }

  const previousById = new Map(previousBlocks.map((block) => [block.id, block]));
  return nextBlocks.every((block) => {
    const previous = previousById.get(block.id);
    return previous
      && previous.sourceId === block.sourceId
      && previous.sourceStart === block.sourceStart
      && previous.sourceEnd === block.sourceEnd;
  });
}

function reprojectBin(
  bin: number,
  resolution: number,
  previousBlocks: ContactMapLayoutBlock[],
  nextById: Map<string, ContactMapLayoutBlock>,
) {
  const visualPosition = bin * resolution + resolution / 2;
  const previous = blockAtVisualPosition(previousBlocks, visualPosition);
  if (!previous) {
    return null;
  }

  const next = nextById.get(previous.id);
  if (!next) {
    return null;
  }

  const previousOffset = visualPosition - previous.visualStart;
  const sourcePosition = previous.orientation === "-"
    ? previous.sourceEnd - previousOffset - 1
    : previous.sourceStart + previousOffset;
  const nextOffset = next.orientation === "-"
    ? next.sourceEnd - sourcePosition - 1
    : sourcePosition - next.sourceStart;
  return Math.floor((next.visualStart + nextOffset) / resolution);
}

function blockAtVisualPosition(blocks: ContactMapLayoutBlock[], visualPosition: number) {
  let low = 0;
  let high = blocks.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const block = blocks[middle];
    if (visualPosition < block.visualStart) {
      high = middle - 1;
    } else if (visualPosition >= block.visualEnd) {
      low = middle + 1;
    } else {
      return block;
    }
  }
  return undefined;
}

function thinContactCellsForDrawing(cells: ContactMapCell[], maxCells: number) {
  if (cells.length <= maxCells) {
    return cells;
  }

  const keepRatio = Math.max(1, maxCells) / cells.length;
  const threshold = Math.floor(keepRatio * 0x1_0000_0000);
  const sampled = cells.filter((cell) => contactCellHash(cell) < threshold);
  return sampled.length <= maxCells ? sampled : sampled.slice(0, maxCells);
}

function contactCellHash(cell: ContactMapCell) {
  return contactCellCoordinateHash(cell.xBin, cell.yBin);
}

/**
 * Count first, then materialize only accepted cells. This preserves the old
 * coordinate-hash thinning rule without expanding every packed tile into a
 * large temporary object array.
 */
function thinContactTileCellsForDrawing(
  tiles: ContactTileData[],
  tileSizeBins: number,
  maxCells: number,
): ContactMapCell[] {
  const candidateCount = tiles.reduce(
    (total, tile) => total + contactTileCellCount(tile),
    0,
  );
  if (candidateCount === 0 || maxCells <= 0) {
    return [];
  }

  if (candidateCount <= maxCells) {
    const cells: ContactMapCell[] = [];
    for (const tile of tiles) {
      const packed = validatedPackedContactTileCells(tile);
      if (!packed) {
        for (const cell of tile.cells) {
          cells.push(cell);
        }
        continue;
      }
      forEachContactTileCell(tile, tileSizeBins, (xBin, yBin, count) => {
        cells.push({ xBin, yBin, count });
      });
    }
    return cells;
  }

  const keepRatio = Math.max(1, maxCells) / candidateCount;
  const threshold = Math.floor(keepRatio * 0x1_0000_0000);
  const sampled: ContactMapCell[] = [];
  for (const tile of tiles) {
    const packed = validatedPackedContactTileCells(tile);
    if (packed) {
      forEachContactTileCell(tile, tileSizeBins, (xBin, yBin, count) => {
        if (
          sampled.length < maxCells
          && contactCellCoordinateHash(xBin, yBin) < threshold
        ) {
          sampled.push({ xBin, yBin, count });
        }
      });
    } else {
      for (const cell of tile.cells) {
        if (
          sampled.length < maxCells
          && contactCellHash(cell) < threshold
        ) {
          sampled.push(cell);
        }
      }
    }
    if (sampled.length >= maxCells) {
      break;
    }
  }
  return sampled;
}

function contactCellCoordinateHash(xBin: number, yBin: number) {
  let hash = Math.imul(xBin ^ 0x9e3779b9, 0x85ebca6b);
  hash ^= Math.imul(yBin ^ (hash >>> 16), 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}
