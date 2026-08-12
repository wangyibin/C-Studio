import { describe, expect, it } from "vitest";
import type { ContactMapCell, ContactMapTile } from "../App";
import { contactColorAt, contactColorLut } from "./contactColor";
import { normalizeContactValue, type ContactColorScale } from "./contactColorScale";
import type { ContactTileData } from "./contactTileData";
import { ContactTileDeltaAccumulator } from "./contactTileDelta";
import {
  rasterizeContactTile,
  rasterizeContactTileDelta,
  rasterizeContactTileDenseBuffer,
} from "./contactTileRaster";
import type { ContactColormap } from "./uiState";

const tileSizeBins = 4;
const paletteOpacity = 0.88;

function rgbaAt(pixels: Uint8ClampedArray, x: number, y: number): number[] {
  const offset = (y * tileSizeBins + x) * 4;
  return Array.from(pixels.slice(offset, offset + 4));
}

function referencePixel(
  colormap: ContactColormap,
  count: number,
  colorScale: Pick<ContactColorScale, "log" | "min" | "max">,
): number[] {
  const intensity = normalizeContactValue(count, colorScale);
  const color = contactColorAt(colormap, intensity, paletteOpacity);
  const alpha = Math.round(color.alpha * 255);
  return alpha === 0
    ? [0, 0, 0, 0]
    : [color.red, color.green, color.blue, alpha];
}

function rasterize(
  tile: ContactTileData,
  colormap: ContactColormap,
  colorScale: Pick<ContactColorScale, "log" | "min" | "max">,
  transpose = false,
  target?: Uint8ClampedArray,
) {
  return rasterizeContactTile({
    tile,
    tileSizeBins,
    transpose,
    colorScale,
    colormap,
    colorLut: contactColorLut(colormap, paletteOpacity),
  }, target);
}

describe("rasterizeContactTile", () => {
  it("keeps direct incremental paint byte-identical to one final sparse snapshot", () => {
    const scale = { log: false, min: 0, max: 100 };
    const colorLut = contactColorLut("Viridis", paletteOpacity);
    const deltas: ContactMapTile[] = [
      {
        tileX: 2,
        tileY: 3,
        cells: [],
        packedCells: {
          xLocal: new Uint16Array([1, 3]),
          yLocal: new Uint16Array([2, 0]),
          counts: new Float64Array([25, 50]),
        },
      },
      {
        tileX: 2,
        tileY: 3,
        cells: [],
        packedCells: {
          xLocal: new Uint16Array([1, 0]),
          yLocal: new Uint16Array([2, 3]),
          counts: new Float64Array([50, 100]),
        },
      },
    ];

    for (const transpose of [false, true]) {
      const accumulator = new ContactTileDeltaAccumulator([{ tileX: 2, tileY: 3 }], 4);
      const buffer = accumulator.denseBuffer({ tileX: 2, tileY: 3 })!;
      const incremental = new Uint8ClampedArray(4 * 4 * 4);
      for (const delta of deltas) {
        accumulator.merge([delta]);
        rasterizeContactTileDelta({
          buffer,
          delta,
          tileSizeBins: 4,
          transpose,
          colorScale: scale,
          colormap: "Viridis",
          colorLut,
        }, incremental);
      }
      const finalTile = accumulator.finish()[0]!;
      expect(incremental).toEqual(rasterize(finalTile, "Viridis", scale, transpose));
      expect(rasterizeContactTileDenseBuffer({
        buffer,
        tileSizeBins: 4,
        transpose,
        colorScale: scale,
        colormap: "Viridis",
        colorLut,
      })).toEqual(incremental);
    }
  });
  it("matches the old color calculation for every palette and hard stop boundary", () => {
    const counts = [
      0,
      1,
      20,
      25,
      40,
      50,
      60,
      75,
      80,
      100,
      150,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      33,
      67,
    ];
    const scale = { log: false, min: 0, max: 100 };
    const cells = counts.map((count, index): ContactMapCell => ({
      xBin: index % tileSizeBins,
      yBin: tileSizeBins + Math.floor(index / tileSizeBins),
      count,
    }));
    const tile = { tileX: 0, tileY: 1, cells };

    for (const colormap of ["Reds", "Viridis", "Magma", "Inferno", "Turbo"] as const) {
      const pixels = rasterize(tile, colormap, scale);
      counts.forEach((count, index) => {
        expect(rgbaAt(pixels, index % tileSizeBins, Math.floor(index / tileSizeBins))).toEqual(
          referencePixel(colormap, count, scale),
        );
      });
    }
  });

  it("matches the old normalization in log mode, including non-finite counts", () => {
    const counts = [0, 1, 9, 99, 999, -2, Number.NaN, Number.POSITIVE_INFINITY];
    const scale = { log: true, min: 0, max: 99 };
    const tile = {
      tileX: 0,
      tileY: 1,
      cells: counts.map((count, index) => ({
        xBin: index % tileSizeBins,
        yBin: tileSizeBins + Math.floor(index / tileSizeBins),
        count,
      })),
    };
    const pixels = rasterize(tile, "Reds", scale);

    counts.forEach((count, index) => {
      expect(rgbaAt(pixels, index % tileSizeBins, Math.floor(index / tileSizeBins))).toEqual(
        referencePixel("Reds", count, scale),
      );
    });
  });

  it("writes diagonal cells once and reflects off-diagonal cells inside a diagonal tile", () => {
    const scale = { log: false, min: 0, max: 100 };
    const tile = {
      tileX: 0,
      tileY: 0,
      cells: [
        { xBin: 0, yBin: 2, count: 50 },
        { xBin: 3, yBin: 3, count: 100 },
      ],
    };
    const pixels = rasterize(tile, "Reds", scale);

    expect(rgbaAt(pixels, 0, 2)).toEqual(referencePixel("Reds", 50, scale));
    expect(rgbaAt(pixels, 2, 0)).toEqual(referencePixel("Reds", 50, scale));
    expect(rgbaAt(pixels, 3, 3)).toEqual(referencePixel("Reds", 100, scale));
    expect(rgbaAt(pixels, 0, 0)).toEqual([0, 0, 0, 0]);
  });

  it("transposes an off-diagonal tile into its symmetric canvas", () => {
    const scale = { log: false, min: 0, max: 100 };
    const tile = {
      tileX: 2,
      tileY: 3,
      cells: [{ xBin: 9, yBin: 14, count: 75 }],
    };

    expect(rgbaAt(rasterize(tile, "Viridis", scale), 1, 2)).toEqual(
      referencePixel("Viridis", 75, scale),
    );
    expect(rgbaAt(rasterize(tile, "Viridis", scale, true), 2, 1)).toEqual(
      referencePixel("Viridis", 75, scale),
    );
  });

  it("keeps packed and object raster output byte-for-byte equivalent", () => {
    const scale = { log: false, min: 0, max: 100 };
    const objectTile: ContactTileData = {
      tileX: 2,
      tileY: 3,
      cells: [
        { xBin: 8, yBin: 12, count: 0 },
        { xBin: 9, yBin: 14, count: 75 },
        { xBin: 11, yBin: 15, count: Number.POSITIVE_INFINITY },
      ],
    };
    const packedTile: ContactTileData = {
      tileX: 2,
      tileY: 3,
      cells: [],
      packedCells: {
        xLocal: new Uint16Array([0, 1, 3]),
        yLocal: new Uint16Array([0, 2, 3]),
        counts: new Float64Array([0, 75, Number.POSITIVE_INFINITY]),
      },
    };

    for (const transpose of [false, true]) {
      expect(rasterize(packedTile, "Viridis", scale, transpose)).toEqual(
        rasterize(objectTile, "Viridis", scale, transpose),
      );
    }
  });

  it("mirrors packed off-diagonal cells exactly once inside a diagonal tile", () => {
    const scale = { log: false, min: 0, max: 100 };
    const packedTile: ContactTileData = {
      tileX: 4,
      tileY: 4,
      cells: [],
      packedCells: {
        xLocal: new Uint16Array([0, 3]),
        yLocal: new Uint16Array([2, 3]),
        counts: new Float64Array([50, 100]),
      },
    };
    const pixels = rasterize(packedTile, "Reds", scale);

    expect(rgbaAt(pixels, 0, 2)).toEqual(referencePixel("Reds", 50, scale));
    expect(rgbaAt(pixels, 2, 0)).toEqual(referencePixel("Reds", 50, scale));
    expect(rgbaAt(pixels, 3, 3)).toEqual(referencePixel("Reds", 100, scale));
    expect(rgbaAt(pixels, 0, 0)).toEqual([0, 0, 0, 0]);
  });

  it("accepts the four tile edges and ignores out-of-range or fractional bins", () => {
    const scale = { log: false, min: 0, max: 10 };
    const tile = {
      tileX: 1,
      tileY: 2,
      cells: [
        { xBin: 4, yBin: 8, count: 10 },
        { xBin: 7, yBin: 11, count: 10 },
        { xBin: 3, yBin: 8, count: 10 },
        { xBin: 8, yBin: 11, count: 10 },
        { xBin: 4.5, yBin: 9, count: 10 },
        { xBin: 5, yBin: Number.NaN, count: 10 },
      ],
    };
    const pixels = rasterize(tile, "Reds", scale);

    expect(rgbaAt(pixels, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(rgbaAt(pixels, 3, 3)).toEqual([255, 0, 0, 255]);
    expect(rgbaAt(pixels, 1, 1)).toEqual([0, 0, 0, 0]);
  });

  it("clears a reused target when the replacement tile is empty", () => {
    const target = new Uint8ClampedArray(tileSizeBins * tileSizeBins * 4).fill(255);
    const pixels = rasterize(
      { tileX: 0, tileY: 0, cells: [] },
      "Reds",
      { log: false, min: 0, max: 1 },
      false,
      target,
    );

    expect(pixels).toBe(target);
    expect(new Set(pixels)).toEqual(new Set([0]));
  });

  it("clears a reused target for an empty packed tile", () => {
    const target = new Uint8ClampedArray(tileSizeBins * tileSizeBins * 4).fill(255);
    const pixels = rasterize(
      {
        tileX: 0,
        tileY: 0,
        cells: [],
        packedCells: {
          xLocal: new Uint16Array(),
          yLocal: new Uint16Array(),
          counts: new Float64Array(),
        },
      },
      "Reds",
      { log: false, min: 0, max: 1 },
      false,
      target,
    );

    expect(pixels).toBe(target);
    expect(new Set(pixels)).toEqual(new Set([0]));
  });

  it("rejects malformed packed arrays before rasterizing", () => {
    const malformed: ContactTileData = {
      tileX: 0,
      tileY: 0,
      cells: [],
      packedCells: {
        xLocal: new Uint16Array([0, 1]),
        yLocal: new Uint16Array([0]),
        counts: new Float64Array([1, 2]),
      },
    };

    expect(() => rasterize(
      malformed,
      "Reds",
      { log: false, min: 0, max: 2 },
    )).toThrow(/identical lengths/);
  });

  it("rejects malformed tile sizes, LUTs, and target buffers", () => {
    const tile = { tileX: 0, tileY: 0, cells: [] };
    const scale = { log: false, min: 0, max: 1 };
    const lut = contactColorLut("Reds");

    expect(() => rasterizeContactTile({
      tile,
      tileSizeBins: 0,
      transpose: false,
      colorScale: scale,
      colormap: "Reds",
      colorLut: lut,
    })).toThrow(/positive integer/);
    expect(() => rasterizeContactTile({
      tile,
      tileSizeBins,
      transpose: false,
      colorScale: scale,
      colormap: "Reds",
      colorLut: new Uint8ClampedArray(4),
    })).toThrow(/1024 bytes/);
    expect(() => rasterizeContactTile({
      tile,
      tileSizeBins,
      transpose: false,
      colorScale: scale,
      colormap: "Reds",
      colorLut: lut,
    }, new Uint8ClampedArray(4))).toThrow(/64 bytes/);
  });
});
