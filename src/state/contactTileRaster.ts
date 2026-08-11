import { contactColorLutIndex, contactColorLutSize } from "./contactColor";
import type { ContactColorScale } from "./contactColorScale";
import {
  validatedPackedContactTileCells,
  type ContactTileData,
} from "./contactTileData";
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
  const packed = validatedPackedContactTileCells(tile);

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
) {
  const alpha = colorLut[colorOffset + 3];
  if (alpha === 0) {
    return;
  }

  const pixelOffset = pixelIndex * rgbaChannels;
  pixels[pixelOffset] = colorLut[colorOffset];
  pixels[pixelOffset + 1] = colorLut[colorOffset + 1];
  pixels[pixelOffset + 2] = colorLut[colorOffset + 2];
  pixels[pixelOffset + 3] = alpha;
}
