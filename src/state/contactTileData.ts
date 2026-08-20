import type { ContactMapCell } from "../App";

export interface PackedContactTileCells {
  xLocal: Uint16Array;
  yLocal: Uint16Array;
  counts: Float64Array;
}

/**
 * Structural tile shape shared by legacy JSON cells, sparse packed IPC, and
 * completed dense Float32 display-cache responses. Dense data is authoritative
 * when present; producers should leave `cells` empty so data is not retained twice.
 */
export interface ContactTileData {
  tileX: number;
  tileY: number;
  cells: readonly ContactMapCell[];
  packedCells?: PackedContactTileCells;
  denseValues?: Float32Array;
  denseOccupiedCount?: number;
}

export type ContactTileCellVisitor = (
  xBin: number,
  yBin: number,
  count: number,
  index: number,
) => void;

export function contactTileCellCount(tile: ContactTileData): number {
  const dense = validatedDenseContactTileValues(tile);
  if (dense) {
    return dense.occupiedCount;
  }
  const packed = validatedPackedContactTileCells(tile);
  return packed?.counts.length ?? tile.cells.length;
}

/** Iterate global bin coordinates without allocating one object per packed cell. */
export function forEachContactTileCell(
  tile: ContactTileData,
  tileSizeBins: number,
  visitor: ContactTileCellVisitor,
): void {
  const safeTileSizeBins = validateTileSizeBins(tileSizeBins);
  const dense = validatedDenseContactTileValues(tile);
  if (dense) {
    if (dense.values.length !== safeTileSizeBins * safeTileSizeBins) {
      throw new RangeError("dense contact tile does not match tileSizeBins");
    }
    const tileStartX = tile.tileX * safeTileSizeBins;
    const tileStartY = tile.tileY * safeTileSizeBins;
    for (let index = 0; index < dense.values.length; index += 1) {
      const count = dense.values[index];
      if (count === -1) {
        continue;
      }
      visitor(
        tileStartX + index % safeTileSizeBins,
        tileStartY + Math.floor(index / safeTileSizeBins),
        count,
        index,
      );
    }
    return;
  }
  const packed = validatedPackedContactTileCells(tile);
  if (packed) {
    const tileStartX = tile.tileX * safeTileSizeBins;
    const tileStartY = tile.tileY * safeTileSizeBins;
    for (let index = 0; index < packed.counts.length; index += 1) {
      visitor(
        tileStartX + packed.xLocal[index],
        tileStartY + packed.yLocal[index],
        packed.counts[index],
        index,
      );
    }
    return;
  }

  for (let index = 0; index < tile.cells.length; index += 1) {
    const cell = tile.cells[index];
    visitor(cell.xBin, cell.yBin, cell.count, index);
  }
}

/**
 * Materialize at most `limit` cells. Hot rendering and sampling paths should
 * prefer `forEachContactTileCell` so a dense packed tile stays allocation-free.
 */
export function materializeContactTileCells(
  tile: ContactTileData,
  tileSizeBins: number,
  limit = Number.POSITIVE_INFINITY,
): ContactMapCell[] {
  const safeLimit = validateMaterializeLimit(limit);
  const safeTileSizeBins = validateTileSizeBins(tileSizeBins);
  if (safeLimit === 0) {
    // Validate compact shapes even when the caller asks for no output.
    if (validatedDenseContactTileValues(tile)) {
      return [];
    }
    validatedPackedContactTileCells(tile);
    return [];
  }

  const dense = validatedDenseContactTileValues(tile);
  if (dense) {
    const cells: ContactMapCell[] = [];
    forEachContactTileCell(tile, safeTileSizeBins, (xBin, yBin, count) => {
      if (cells.length < safeLimit) {
        cells.push({ xBin, yBin, count });
      }
    });
    return cells;
  }
  const packed = validatedPackedContactTileCells(tile);
  const cells: ContactMapCell[] = [];
  if (packed) {
    const length = Math.min(packed.counts.length, safeLimit);
    const tileStartX = tile.tileX * safeTileSizeBins;
    const tileStartY = tile.tileY * safeTileSizeBins;
    for (let index = 0; index < length; index += 1) {
      cells.push({
        xBin: tileStartX + packed.xLocal[index],
        yBin: tileStartY + packed.yLocal[index],
        count: packed.counts[index],
      });
    }
    return cells;
  }

  const length = Math.min(tile.cells.length, safeLimit);
  for (let index = 0; index < length; index += 1) {
    const cell = tile.cells[index];
    cells.push({ xBin: cell.xBin, yBin: cell.yBin, count: cell.count });
  }
  return cells;
}

export function appendContactTileCounts(tile: ContactTileData, out: number[]): number[] {
  const dense = validatedDenseContactTileValues(tile);
  if (dense) {
    for (const count of dense.values) {
      if (count !== -1) {
        out.push(count);
      }
    }
    return out;
  }
  const packed = validatedPackedContactTileCells(tile);
  if (packed) {
    for (let index = 0; index < packed.counts.length; index += 1) {
      out.push(packed.counts[index]);
    }
    return out;
  }

  for (const cell of tile.cells) {
    out.push(cell.count);
  }
  return out;
}

export function validatedDenseContactTileValues(
  tile: ContactTileData,
): { values: Float32Array; occupiedCount: number } | undefined {
  const values = tile.denseValues;
  const occupiedCount = tile.denseOccupiedCount;
  if (!values) {
    if (occupiedCount !== undefined) {
      throw new RangeError("dense contact tile count requires dense values");
    }
    return undefined;
  }
  if (
    !Number.isSafeInteger(occupiedCount)
    || occupiedCount! < 0
    || occupiedCount! > values.length
  ) {
    throw new RangeError("dense contact tile occupied count is invalid");
  }
  return { values, occupiedCount: occupiedCount! };
}

/** Validate once before a packed hot loop and return the authoritative arrays. */
export function validatedPackedContactTileCells(
  tile: ContactTileData,
): PackedContactTileCells | undefined {
  const packed = tile.packedCells;
  if (!packed) {
    return undefined;
  }

  const count = packed.counts.length;
  if (packed.xLocal.length !== count || packed.yLocal.length !== count) {
    throw new RangeError(
      "packed contact tile arrays must have identical lengths",
    );
  }
  return packed;
}

function validateTileSizeBins(tileSizeBins: number): number {
  if (!Number.isSafeInteger(tileSizeBins) || tileSizeBins <= 0) {
    throw new RangeError("contact tile size must be a positive integer");
  }
  return tileSizeBins;
}

function validateMaterializeLimit(limit: number): number {
  if (limit === Number.POSITIVE_INFINITY) {
    return limit;
  }
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError("contact tile materialization limit must be a non-negative integer");
  }
  return limit;
}
