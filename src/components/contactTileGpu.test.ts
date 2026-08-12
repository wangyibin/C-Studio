import { describe, expect, it } from "vitest";
import { contactTileFloatTextureData } from "./contactTileGpu";

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
});
