import type { ContactMapCell } from "../App";
import { contactColorLutIndex } from "./contactColor";
import type { ContactColorScale } from "./contactColorScale";
import { normalizeContactValue } from "./contactColorScale";
import type { ContactColormap } from "./uiState";

const rgbaChannels = 4;

export interface ContactMapRasterInput {
  cells: readonly ContactMapCell[];
  resolution: number;
  viewport: {
    xStart: number;
    xEnd: number;
    yStart: number;
    yEnd: number;
  };
  width: number;
  height: number;
  colorScale: Pick<ContactColorScale, "log" | "min" | "max">;
  colormap: ContactColormap;
  colorLut: Uint8ClampedArray;
}

/**
 * Rasterize a cell-only screen LOD into one dense RGBA buffer. Sparse cells are
 * mirrored across the diagonal and alpha-composited onto white exactly once;
 * the caller can then publish the complete frame with one putImageData call.
 */
export function rasterizeContactMapCells(
  input: ContactMapRasterInput,
  target?: Uint8ClampedArray,
  clear = true,
): Uint8ClampedArray {
  const width = positiveInteger(input.width, "contact map raster width");
  const height = positiveInteger(input.height, "contact map raster height");
  const resolution = Number.isFinite(input.resolution) && input.resolution > 0
    ? input.resolution
    : 1;
  const requiredBytes = width * height * rgbaChannels;
  const pixels = target ?? new Uint8ClampedArray(requiredBytes);
  if (pixels.length !== requiredBytes) {
    throw new RangeError(`contact map raster target must contain ${requiredBytes} bytes`);
  }
  if (input.colorLut.length !== 256 * rgbaChannels) {
    throw new RangeError("contact map raster color LUT must contain 1024 bytes");
  }
  if (clear) {
    pixels.fill(255);
  }

  const xSpan = Math.max(1, input.viewport.xEnd - input.viewport.xStart);
  const ySpan = Math.max(1, input.viewport.yEnd - input.viewport.yStart);
  for (const cell of input.cells) {
    if (
      !Number.isFinite(cell.xBin)
      || !Number.isFinite(cell.yBin)
      || !Number.isFinite(cell.count)
    ) {
      continue;
    }
    const colorOffset = contactColorLutIndex(
      input.colormap,
      normalizeContactValue(cell.count, input.colorScale),
    ) * rgbaChannels;
    const xBase = cell.xBin * resolution;
    const yBase = cell.yBin * resolution;
    fillContactRasterBin(
      pixels,
      width,
      height,
      xBase,
      yBase,
      resolution,
      input.viewport,
      xSpan,
      ySpan,
      input.colorLut,
      colorOffset,
    );
    if (cell.xBin !== cell.yBin) {
      fillContactRasterBin(
        pixels,
        width,
        height,
        yBase,
        xBase,
        resolution,
        input.viewport,
        xSpan,
        ySpan,
        input.colorLut,
        colorOffset,
      );
    }
  }

  return pixels;
}

function fillContactRasterBin(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  xBase: number,
  yBase: number,
  resolution: number,
  viewport: ContactMapRasterInput["viewport"],
  xSpan: number,
  ySpan: number,
  colorLut: Uint8ClampedArray,
  colorOffset: number,
) {
  const left = Math.max(0, Math.floor(((xBase - viewport.xStart) / xSpan) * width));
  const right = Math.min(
    width,
    Math.ceil(((xBase + resolution - viewport.xStart) / xSpan) * width),
  );
  const top = Math.max(0, Math.floor(((yBase - viewport.yStart) / ySpan) * height));
  const bottom = Math.min(
    height,
    Math.ceil(((yBase + resolution - viewport.yStart) / ySpan) * height),
  );
  if (left >= right || top >= bottom) {
    return;
  }

  const alpha = (colorLut[colorOffset + 3] ?? 0) / 255;
  const red = Math.round((colorLut[colorOffset] ?? 0) * alpha + 255 * (1 - alpha));
  const green = Math.round((colorLut[colorOffset + 1] ?? 0) * alpha + 255 * (1 - alpha));
  const blue = Math.round((colorLut[colorOffset + 2] ?? 0) * alpha + 255 * (1 - alpha));
  for (let y = top; y < bottom; y += 1) {
    let pixelOffset = (y * width + left) * rgbaChannels;
    for (let x = left; x < right; x += 1) {
      pixels[pixelOffset] = red;
      pixels[pixelOffset + 1] = green;
      pixels[pixelOffset + 2] = blue;
      pixels[pixelOffset + 3] = 255;
      pixelOffset += rgbaChannels;
    }
  }
}

function positiveInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive integer`);
  }
  return value;
}
