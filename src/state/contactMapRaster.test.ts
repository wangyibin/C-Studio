import { describe, expect, it } from "vitest";
import { contactColorLut } from "./contactColor";
import { rasterizeContactMapCells } from "./contactMapRaster";

function pixel(pixels: Uint8ClampedArray, width: number, x: number, y: number) {
  const offset = (y * width + x) * 4;
  return [...pixels.slice(offset, offset + 4)];
}

describe("contact map screen raster", () => {
  it("writes a mirrored LOD with one dense white-backed RGBA buffer", () => {
    const pixels = rasterizeContactMapCells({
      cells: [
        { xBin: 0, yBin: 1, count: 10 },
        { xBin: 2, yBin: 2, count: 10 },
      ],
      resolution: 1,
      viewport: { xStart: 0, xEnd: 4, yStart: 0, yEnd: 4 },
      width: 4,
      height: 4,
      colorScale: { log: false, min: 0, max: 10 },
      colormap: "Reds",
      colorLut: contactColorLut("Reds", 0.88),
    });

    expect(pixel(pixels, 4, 0, 1)).toEqual([255, 0, 0, 255]);
    expect(pixel(pixels, 4, 1, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(pixels, 4, 2, 2)).toEqual([255, 0, 0, 255]);
    expect(pixel(pixels, 4, 3, 3)).toEqual([255, 255, 255, 255]);
  });

  it("reuses a caller-owned target without clearing earlier raster cells", () => {
    const input = {
      resolution: 1,
      viewport: { xStart: 0, xEnd: 2, yStart: 0, yEnd: 2 },
      width: 2,
      height: 2,
      colorScale: { log: false, min: 0, max: 1 },
      colormap: "Reds" as const,
      colorLut: contactColorLut("Reds", 0.88),
    };
    const target = rasterizeContactMapCells({
      ...input,
      cells: [{ xBin: 0, yBin: 0, count: 1 }],
    });

    expect(rasterizeContactMapCells({
      ...input,
      cells: [{ xBin: 1, yBin: 1, count: 1 }],
    }, target, false)).toBe(target);
    expect(pixel(target, 2, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(target, 2, 1, 1)).toEqual([255, 0, 0, 255]);
  });
});
