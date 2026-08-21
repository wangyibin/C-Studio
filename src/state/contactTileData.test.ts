import { describe, expect, it, vi } from "vitest";
import {
  appendContactTileCounts,
  contactTileCellCount,
  forEachContactTileCell,
  materializeContactTileCells,
  type ContactTileData,
} from "./contactTileData";

const objectTile: ContactTileData = {
  tileX: 2,
  tileY: 3,
  cells: [
    { xBin: 513, yBin: 770, count: 4.5 },
    { xBin: 515, yBin: 775, count: 8 },
  ],
};

const packedTile: ContactTileData = {
  tileX: 2,
  tileY: 3,
  cells: [],
  packedCells: {
    xLocal: new Uint16Array([1, 3]),
    yLocal: new Uint16Array([2, 7]),
    counts: new Float64Array([4.5, 8]),
  },
};

describe("contact tile cell access", () => {
  it("keeps legacy object cells and packed cells observationally equivalent", () => {
    expect(contactTileCellCount(objectTile)).toBe(2);
    expect(contactTileCellCount(packedTile)).toBe(2);
    expect(materializeContactTileCells(packedTile, 256)).toEqual(objectTile.cells);
    expect(materializeContactTileCells(objectTile, 256)).toEqual(objectTile.cells);

    const objectCounts: number[] = [];
    const packedCounts: number[] = [];
    expect(appendContactTileCounts(objectTile, objectCounts)).toBe(objectCounts);
    expect(appendContactTileCounts(packedTile, packedCounts)).toBe(packedCounts);
    expect(packedCounts).toEqual(objectCounts);
  });

  it("iterates packed local coordinates as global bins without cell allocation", () => {
    const visitor = vi.fn();
    forEachContactTileCell(packedTile, 256, visitor);

    expect(visitor.mock.calls).toEqual([
      [513, 770, 4.5, 0],
      [515, 775, 8, 1],
    ]);
  });

  it("reads dense Float32 tiles without rebuilding sparse columns", () => {
    const values = new Float32Array(16);
    values.fill(-1);
    values[9] = 4.5;
    values[15] = 8;
    const dense: ContactTileData = {
      tileX: 2,
      tileY: 3,
      cells: [],
      denseValues: values,
      denseOccupiedCount: 2,
    };

    expect(contactTileCellCount(dense)).toBe(2);
    expect(materializeContactTileCells(dense, 4)).toEqual([
      { xBin: 9, yBin: 14, count: 4.5 },
      { xBin: 11, yBin: 15, count: 8 },
    ]);
    expect(appendContactTileCounts(dense, [])).toEqual([4.5, 8]);
  });

  it("reads dense R16F tiles without expanding their retained storage", () => {
    const values = new Uint16Array(16);
    values.fill(0xbc00);
    values[9] = 0x4480;
    values[15] = 0x4800;
    const dense: ContactTileData = {
      tileX: 2,
      tileY: 3,
      cells: [],
      denseR16fValues: values,
      denseOccupiedCount: 2,
    };

    expect(contactTileCellCount(dense)).toBe(2);
    expect(materializeContactTileCells(dense, 4)).toEqual([
      { xBin: 9, yBin: 14, count: 4.5 },
      { xBin: 11, yBin: 15, count: 8 },
    ]);
    expect(appendContactTileCounts(dense, [])).toEqual([4.5, 8]);
    expect(values.byteLength).toBe(16 * 2);
  });

  it("uses packed arrays as the authority during a transitional mixed payload", () => {
    const mixed: ContactTileData = {
      ...packedTile,
      cells: [{ xBin: 999, yBin: 999, count: 999 }],
    };

    expect(contactTileCellCount(mixed)).toBe(2);
    expect(materializeContactTileCells(mixed, 256)).toEqual(objectTile.cells);
    expect(appendContactTileCounts(mixed, [])).toEqual([4.5, 8]);
  });

  it("honors materialization limits and empty packed tiles", () => {
    expect(materializeContactTileCells(packedTile, 256, 1)).toEqual([
      { xBin: 513, yBin: 770, count: 4.5 },
    ]);
    expect(materializeContactTileCells(packedTile, 256, 0)).toEqual([]);

    const empty: ContactTileData = {
      tileX: 0,
      tileY: 0,
      cells: [],
      packedCells: {
        xLocal: new Uint16Array(),
        yLocal: new Uint16Array(),
        counts: new Float64Array(),
      },
    };
    expect(contactTileCellCount(empty)).toBe(0);
    expect(materializeContactTileCells(empty, 256)).toEqual([]);
    expect(appendContactTileCounts(empty, [7])).toEqual([7]);
  });

  it("rejects mismatched packed arrays from every public access path", () => {
    const malformed: ContactTileData = {
      tileX: 0,
      tileY: 0,
      cells: [],
      packedCells: {
        xLocal: new Uint16Array([1, 2]),
        yLocal: new Uint16Array([3]),
        counts: new Float64Array([4, 5]),
      },
    };

    expect(() => contactTileCellCount(malformed)).toThrow(/identical lengths/);
    expect(() => forEachContactTileCell(malformed, 256, () => undefined)).toThrow(
      /identical lengths/,
    );
    expect(() => materializeContactTileCells(malformed, 256)).toThrow(/identical lengths/);
    expect(() => appendContactTileCounts(malformed, [])).toThrow(/identical lengths/);
  });

  it("rejects invalid tile sizes and materialization limits", () => {
    expect(() => forEachContactTileCell(packedTile, 0, () => undefined)).toThrow(
      /positive integer/,
    );
    expect(() => materializeContactTileCells(packedTile, 256, -1)).toThrow(
      /non-negative integer/,
    );
  });
});
