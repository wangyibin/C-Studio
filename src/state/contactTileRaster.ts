import { contactColorLutIndex, contactColorLutSize } from "./contactColor";
import type { ContactColorScale } from "./contactColorScale";
import {
  contactTileDenseValueAt,
  forEachContactTileCell,
  validatedDenseContactTileValues,
  validatedPackedContactTileCells,
  type ContactTileData,
} from "./contactTileData";
import type { ContactTileDenseDeltaBuffer } from "./contactTileDelta";
import {
  contactTileR16fEmptySentinel,
  contactTileR16fToFloat32,
} from "./contactTileR16f";
import type { ContactColormap } from "./uiState";

const rgbaChannels = 4;
const contactColorLutBytes = contactColorLutSize * rgbaChannels;

export interface ContactTileRasterInput {
  tile: ContactTileData;
  tileSizeBins: number;
  transpose: boolean;
  colorScale: Pick<ContactColorScale, "log" | "min" | "max">;
  colormap: ContactColormap;
  colorLut: Uint8ClampedArray;
}

export interface ContactTileDenseRasterInput {
  buffer: ContactTileDenseDeltaBuffer;
  tileSizeBins: number;
  transpose: boolean;
  colorScale: Pick<ContactColorScale, "log" | "min" | "max">;
  colormap: ContactColormap;
  colorLut: Uint8ClampedArray;
}

export interface ContactTileDeltaRasterInput extends ContactTileDenseRasterInput {
  delta: ContactTileData;
}

/**
 * Rasterize one contact tile directly into an RGBA byte buffer. The backend
 * aggregates contacts by bin, so each source cell owns at most one pixel.
 */
export function rasterizeContactTile(
  {
    tile,
    tileSizeBins,
    transpose,
    colorScale,
    colormap,
    colorLut,
  }: ContactTileRasterInput,
  target?: Uint8ClampedArray,
): Uint8ClampedArray {
  if (!Number.isSafeInteger(tileSizeBins) || tileSizeBins <= 0) {
    throw new RangeError("contact tile size must be a positive integer");
  }
  if (colorLut.length !== contactColorLutBytes) {
    throw new RangeError(`contact color LUT must contain ${contactColorLutBytes} bytes`);
  }
  const requiredBytes = tileSizeBins * tileSizeBins * rgbaChannels;
  const pixels = target ?? new Uint8ClampedArray(requiredBytes);
  if (pixels.length !== requiredBytes) {
    throw new RangeError(`contact tile raster target must contain ${requiredBytes} bytes`);
  }
  pixels.fill(0);

  const normalize = createContactValueNormalizer(colorScale);
  const tileStartX = tile.tileX * tileSizeBins;
  const tileStartY = tile.tileY * tileSizeBins;
  const mirrorsDiagonal = !transpose && tile.tileX === tile.tileY;

  const dense = validatedDenseContactTileValues(tile);
  if (dense) {
    if (dense.values.length !== tileSizeBins * tileSizeBins) {
      throw new RangeError("dense contact tile does not match tileSizeBins");
    }
    for (let index = 0; index < dense.values.length; index += 1) {
      const raw = dense.values[index];
      if (
        (dense.format === "float32" && raw === -1)
        || (dense.format === "r16f" && raw === contactTileR16fEmptySentinel)
      ) {
        continue;
      }
      const value = contactTileDenseValueAt(dense, index);
      const sourceX = index % tileSizeBins;
      const sourceY = Math.floor(index / tileSizeBins);
      const xBin = transpose ? sourceY : sourceX;
      const yBin = transpose ? sourceX : sourceY;
      const colorOffset = contactColorLutIndex(colormap, normalize(value)) * rgbaChannels;
      writeContactPixel(pixels, yBin * tileSizeBins + xBin, colorLut, colorOffset);
      if (mirrorsDiagonal && xBin !== yBin) {
        writeContactPixel(pixels, xBin * tileSizeBins + yBin, colorLut, colorOffset);
      }
    }
    return pixels;
  }

  const packed = validatedPackedContactTileCells(tile);
  if (packed) {
    // Packed coordinates are already tile-local. Keep this loop separate from
    // the compatibility path so rasterization creates no per-cell objects.
    for (let index = 0; index < packed.counts.length; index += 1) {
      const sourceX = packed.xLocal[index];
      const sourceY = packed.yLocal[index];
      const xBin = transpose ? sourceY : sourceX;
      const yBin = transpose ? sourceX : sourceY;
      if (xBin >= tileSizeBins || yBin >= tileSizeBins) {
        continue;
      }

      const colorOffset = contactColorLutIndex(
        colormap,
        normalize(packed.counts[index]),
      ) * rgbaChannels;
      writeContactPixel(pixels, yBin * tileSizeBins + xBin, colorLut, colorOffset);
      if (mirrorsDiagonal && xBin !== yBin) {
        writeContactPixel(pixels, xBin * tileSizeBins + yBin, colorLut, colorOffset);
      }
    }
    return pixels;
  }

  for (const cell of tile.cells) {
    const sourceX = cell.xBin - tileStartX;
    const sourceY = cell.yBin - tileStartY;
    const xBin = transpose ? sourceY : sourceX;
    const yBin = transpose ? sourceX : sourceY;
    if (
      xBin < 0
      || yBin < 0
      || xBin >= tileSizeBins
      || yBin >= tileSizeBins
      || !Number.isInteger(xBin)
      || !Number.isInteger(yBin)
    ) {
      continue;
    }

    const colorOffset = contactColorLutIndex(colormap, normalize(cell.count)) * rgbaChannels;
    writeContactPixel(pixels, yBin * tileSizeBins + xBin, colorLut, colorOffset);
    if (mirrorsDiagonal && xBin !== yBin) {
      writeContactPixel(pixels, xBin * tileSizeBins + yBin, colorLut, colorOffset);
    }
  }

  return pixels;
}

/** Paint the current dense accumulator state once, without a sparse snapshot. */
export function rasterizeContactTileDenseBuffer(
  input: ContactTileDenseRasterInput,
  target?: Uint8ClampedArray,
): Uint8ClampedArray {
  const pixels = validateDenseRasterInput(input, target);
  pixels.fill(0);
  const normalize = createContactValueNormalizer(input.colorScale);
  const completeValues = input.buffer.completeValues ?? input.buffer.completeR16fValues;
  if (completeValues) {
    const r16f = input.buffer.completeR16fValues !== undefined;
    for (let index = 0; index < completeValues.length; index += 1) {
      if (completeValues[index] !== (r16f ? contactTileR16fEmptySentinel : -1)) {
        paintDenseContactValue(input, pixels, index, normalize);
      }
    }
    return pixels;
  }
  for (let index = 0; index < input.buffer.occupied.length; index += 1) {
    if (input.buffer.occupied[index] === 0) {
      continue;
    }
    paintDenseContactValue(input, pixels, index, normalize);
  }
  return pixels;
}

/**
 * Apply only cells named by one streamed delta. The delta has already been
 * merged, so colors are read from the exact cumulative dense buffer.
 */
export function rasterizeContactTileDelta(
  input: ContactTileDeltaRasterInput,
  target: Uint8ClampedArray,
): Uint8ClampedArray {
  const pixels = validateDenseRasterInput(input, target);
  const normalize = createContactValueNormalizer(input.colorScale);
  const tileStartX = input.buffer.tile.tileX * input.tileSizeBins;
  const tileStartY = input.buffer.tile.tileY * input.tileSizeBins;
  forEachContactTileCell(input.delta, input.tileSizeBins, (xBin, yBin) => {
    const xLocal = xBin - tileStartX;
    const yLocal = yBin - tileStartY;
    if (
      xLocal < 0
      || xLocal >= input.tileSizeBins
      || yLocal < 0
      || yLocal >= input.tileSizeBins
      || !Number.isInteger(xLocal)
      || !Number.isInteger(yLocal)
    ) {
      throw new RangeError("contact tile raster delta is outside its dense buffer");
    }
    paintDenseContactValue(
      input,
      pixels,
      yLocal * input.tileSizeBins + xLocal,
      normalize,
    );
  });
  return pixels;
}

function validateDenseRasterInput(
  input: ContactTileDenseRasterInput,
  target?: Uint8ClampedArray,
): Uint8ClampedArray {
  const { tileSizeBins, buffer, colorLut } = input;
  if (!Number.isSafeInteger(tileSizeBins) || tileSizeBins <= 0) {
    throw new RangeError("contact tile size must be a positive integer");
  }
  if (colorLut.length !== contactColorLutBytes) {
    throw new RangeError(`contact color LUT must contain ${contactColorLutBytes} bytes`);
  }
  const cellCapacity = tileSizeBins * tileSizeBins;
  const completeValues = buffer.completeValues ?? buffer.completeR16fValues;
  if (completeValues) {
    if (completeValues.length !== cellCapacity) {
      throw new RangeError("completed dense contact tile does not match tileSizeBins");
    }
  } else if (buffer.counts.length !== cellCapacity || buffer.occupied.length !== cellCapacity) {
    throw new RangeError("contact tile dense buffer does not match tileSizeBins");
  }
  const requiredBytes = cellCapacity * rgbaChannels;
  const pixels = target ?? new Uint8ClampedArray(requiredBytes);
  if (pixels.length !== requiredBytes) {
    throw new RangeError(`contact tile raster target must contain ${requiredBytes} bytes`);
  }
  return pixels;
}

function paintDenseContactValue(
  input: ContactTileDenseRasterInput,
  pixels: Uint8ClampedArray,
  sourceIndex: number,
  normalize: (value: number) => number,
) {
  const sourceX = sourceIndex % input.tileSizeBins;
  const sourceY = Math.floor(sourceIndex / input.tileSizeBins);
  const xBin = input.transpose ? sourceY : sourceX;
  const yBin = input.transpose ? sourceX : sourceY;
  const colorOffset = contactColorLutIndex(
    input.colormap,
    normalize(input.buffer.completeValues?.[sourceIndex]
      ?? (input.buffer.completeR16fValues
        ? contactTileR16fToFloat32(input.buffer.completeR16fValues[sourceIndex])
        : input.buffer.counts[sourceIndex])),
  ) * rgbaChannels;
  writeContactPixel(
    pixels,
    yBin * input.tileSizeBins + xBin,
    input.colorLut,
    colorOffset,
    true,
  );
  if (
    !input.transpose
    && input.buffer.tile.tileX === input.buffer.tile.tileY
    && xBin !== yBin
  ) {
    writeContactPixel(
      pixels,
      xBin * input.tileSizeBins + yBin,
      input.colorLut,
      colorOffset,
      true,
    );
  }
}

function createContactValueNormalizer(
  scale: Pick<ContactColorScale, "log" | "min" | "max">,
): (value: number) => number {
  const min = Math.max(0, scale.min);
  const max = Math.max(min, scale.max);

  if (max === min) {
    return (value) => value >= max ? 1 : 0;
  }

  if (!scale.log) {
    const range = max - min;
    return (value) => clampContactIntensity((value - min) / range);
  }

  const logMin = Math.log10(min + 1);
  const logRange = Math.log10(max + 1) - logMin;
  return (value) => clampContactIntensity((Math.log10(value + 1) - logMin) / logRange);
}

function clampContactIntensity(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function writeContactPixel(
  pixels: Uint8ClampedArray,
  pixelIndex: number,
  colorLut: Uint8ClampedArray,
  colorOffset: number,
  clearTransparent = false,
) {
  const alpha = colorLut[colorOffset + 3];
  if (alpha === 0) {
    if (clearTransparent) {
      const pixelOffset = pixelIndex * rgbaChannels;
      pixels.fill(0, pixelOffset, pixelOffset + rgbaChannels);
    }
    return;
  }

  const pixelOffset = pixelIndex * rgbaChannels;
  pixels[pixelOffset] = colorLut[colorOffset];
  pixels[pixelOffset + 1] = colorLut[colorOffset + 1];
  pixels[pixelOffset + 2] = colorLut[colorOffset + 2];
  pixels[pixelOffset + 3] = alpha;
}
