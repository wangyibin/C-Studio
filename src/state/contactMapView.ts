import type { ContactMapCell, ContactMapView } from "../App";
import type { ContactMapLayoutBlock } from "./importers";

export const maxDrawableContactCells = 120_000;
export const maxInteractivePreviewContactCells = 30_000;

export function contactCellsForViewport(
  contactMap: ContactMapView,
  maxCells = maxDrawableContactCells,
): ContactMapCell[] {
  const tileSizeBins = contactMap.tileSizeBins ?? 256;
  const tiles = contactMap.cachedTiles ?? contactMap.tiles;
  if (!tiles) {
    return thinContactCellsForDrawing(contactMap.cells, maxCells);
  }

  return thinContactCellsForDrawing(tiles.flatMap((tile) => {
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
      return [];
    }

    return tile.cells;
  }), maxCells);
}

export function displayContactMapForPendingLayer(
  pendingContactMap: ContactMapView,
  previousContactMap: ContactMapView | null,
  visibleLayerComplete = true,
): ContactMapView {
  if (!visibleLayerComplete && previousContactMap) {
    return {
      ...previousContactMap,
      viewport: pendingContactMap.viewport,
    };
  }

  const hasPendingCells = pendingContactMap.cells.length > 0
    || (pendingContactMap.tiles?.length ?? 0) > 0;
  if (hasPendingCells || !previousContactMap) {
    return pendingContactMap;
  }

  return {
    ...previousContactMap,
    viewport: pendingContactMap.viewport,
  };
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
  if (
    !isBinAlignedLayout(previousBlocks, contactMap.resolution)
    || !isBinAlignedLayout(nextBlocks, contactMap.resolution)
  ) {
    return null;
  }

  const sourceCells = contactCellsForViewport(contactMap);
  if (sourceCells.length > maxInteractivePreviewContactCells) {
    return null;
  }

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

  return {
    resolution: contactMap.resolution,
    viewport: contactMap.viewport,
    cells: [...aggregate.values()],
  };
}

function isBinAlignedLayout(blocks: ContactMapLayoutBlock[], resolution: number) {
  return blocks.every(
    (block) => block.visualStart % resolution === 0 && block.visualEnd % resolution === 0,
  );
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
  let hash = Math.imul(cell.xBin ^ 0x9e3779b9, 0x85ebca6b);
  hash ^= Math.imul(cell.yBin ^ (hash >>> 16), 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}
