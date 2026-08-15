import { describe, expect, it } from "vitest";
import {
  contactTileFloatTextureData,
  contactTileGpuDrawCoverageIsComplete,
} from "./contactTileGpu";

describe("contactTileFloatTextureData", () => {
  it("packs typed tile counts and completes a diagonal tile symmetrically", () => {
    const values = contactTileFloatTextureData({
      tileX: 2,
      tileY: 2,
      cells: [],
      packedCells: {
        xLocal: new Uint16Array([1, 3]),
        yLocal: new Uint16Array([2, 3]),
        counts: new Float64Array([7.5, 11]),
      },
    }, 4);

    expect(values[2 * 4 + 1]).toBe(7.5);
    expect(values[1 * 4 + 2]).toBe(7.5);
    expect(values[3 * 4 + 3]).toBe(11);
    expect(values[0]).toBe(-1);
  });

  it("keeps an off-diagonal source texture canonical for UV mirror reuse", () => {
    const values = contactTileFloatTextureData({
      tileX: 1,
      tileY: 3,
      cells: [{ xBin: 5, yBin: 14, count: 9 }],
    }, 4);

    expect(values[2 * 4 + 1]).toBe(9);
    expect(values[1 * 4 + 2]).toBe(-1);
  });

  it("rejects invalid texture dimensions", () => {
    expect(() => contactTileFloatTextureData({
      tileX: 0,
      tileY: 0,
      cells: [],
    }, 0)).toThrow(/positive integer/);
  });

  it("rejects a frame when one populated high-resolution tile was skipped", () => {
    const descriptors = Array.from({ length: 16 }, (_, index) => ({
      key: `${index}:source`,
      tile: {
        tileX: index % 4,
        tileY: Math.floor(index / 4) + 8,
        cells: [{ xBin: index % 4, yBin: index, count: index + 1 }],
      },
      transpose: false,
    }));
    const allDrawn = new Set(descriptors.map(({ key }) => key));
    const oneMissing = new Set(allDrawn);
    oneMissing.delete("7:source");

    expect(contactTileGpuDrawCoverageIsComplete(descriptors, allDrawn)).toBe(true);
    expect(contactTileGpuDrawCoverageIsComplete(descriptors, oneMissing)).toBe(false);
  });

  it("allows explicit empty tiles to use the white framebuffer clear", () => {
    expect(contactTileGpuDrawCoverageIsComplete([{
      key: "empty:source",
      tile: { tileX: 0, tileY: 0, cells: [] },
      transpose: false,
    }], new Set())).toBe(true);
  });
});
