import { describe, expect, it } from "vitest";
import { decodeContactTileBinaryV1 } from "./contactTileBinary";

interface BinaryTileInput {
  tileX: bigint;
  tileY: bigint;
  xLocal: number[];
  yLocal: number[];
  counts: number[];
}

const headerBytes = 16;
const directoryEntryBytes = 24;

function encodeContactTiles(tileSizeBins: number, tiles: BinaryTileInput[]): ArrayBuffer {
  const directoryEnd = headerBytes + tiles.length * directoryEntryBytes;
  const offsets: number[] = [];
  let byteLength = directoryEnd;
  for (const tile of tiles) {
    if (tile.xLocal.length !== tile.yLocal.length || tile.xLocal.length !== tile.counts.length) {
      throw new Error("test tile arrays must have equal lengths");
    }
    offsets.push(byteLength);
    byteLength = alignEight(byteLength + tile.xLocal.length * 4)
      + tile.counts.length * Float64Array.BYTES_PER_ELEMENT;
  }

  const buffer = new ArrayBuffer(byteLength);
  const view = new DataView(buffer);
  new Uint8Array(buffer, 0, 4).set([0x43, 0x53, 0x54, 0x31]);
  view.setUint16(4, 1, true);
  view.setUint16(6, 0, true);
  view.setUint32(8, tileSizeBins, true);
  view.setUint32(12, tiles.length, true);

  tiles.forEach((tile, tileIndex) => {
    const directoryOffset = headerBytes + tileIndex * directoryEntryBytes;
    const dataOffset = offsets[tileIndex] as number;
    view.setBigUint64(directoryOffset, tile.tileX, true);
    view.setBigUint64(directoryOffset + 8, tile.tileY, true);
    view.setUint32(directoryOffset + 16, tile.xLocal.length, true);
    view.setUint32(directoryOffset + 20, dataOffset, true);
    tile.xLocal.forEach((value, index) => {
      view.setUint16(dataOffset + index * 2, value, true);
    });
    const yOffset = dataOffset + tile.xLocal.length * 2;
    tile.yLocal.forEach((value, index) => {
      view.setUint16(yOffset + index * 2, value, true);
    });
    const countsOffset = alignEight(yOffset + tile.yLocal.length * 2);
    tile.counts.forEach((value, index) => {
      view.setFloat64(countsOffset + index * 8, value, true);
    });
  });
  return buffer;
}

function encodeDenseContactTiles(
  tileSizeBins: number,
  tiles: Array<{ tileX: bigint; tileY: bigint; values: number[] }>,
): ArrayBuffer {
  const directoryEnd = headerBytes + tiles.length * directoryEntryBytes;
  const valuesPerTile = tileSizeBins * tileSizeBins;
  const buffer = new ArrayBuffer(
    directoryEnd + tiles.length * valuesPerTile * Float32Array.BYTES_PER_ELEMENT,
  );
  const view = new DataView(buffer);
  new Uint8Array(buffer, 0, 4).set([0x43, 0x53, 0x54, 0x31]);
  view.setUint16(4, 1, true);
  view.setUint16(6, 1, true);
  view.setUint32(8, tileSizeBins, true);
  view.setUint32(12, tiles.length, true);
  let dataOffset = directoryEnd;
  tiles.forEach((tile, tileIndex) => {
    if (tile.values.length !== valuesPerTile) {
      throw new Error("dense test tile does not match tile size");
    }
    const directoryOffset = headerBytes + tileIndex * directoryEntryBytes;
    view.setBigUint64(directoryOffset, tile.tileX, true);
    view.setBigUint64(directoryOffset + 8, tile.tileY, true);
    view.setUint32(directoryOffset + 16, tile.values.length, true);
    view.setUint32(directoryOffset + 20, dataOffset, true);
    tile.values.forEach((value, index) => {
      view.setFloat32(dataOffset + index * Float32Array.BYTES_PER_ELEMENT, value, true);
    });
    dataOffset += tile.values.length * Float32Array.BYTES_PER_ELEMENT;
  });
  return buffer;
}

function copyAndMutate(buffer: ArrayBuffer, mutate: (view: DataView) => void): ArrayBuffer {
  const copy = buffer.slice(0);
  mutate(new DataView(copy));
  return copy;
}

function alignEight(value: number): number {
  return Math.ceil(value / 8) * 8;
}

describe("decodeContactTileBinaryV1", () => {
  it("decodes one tile with local coordinates and full Float64 precision", () => {
    const buffer = encodeContactTiles(256, [{
      tileX: 12n,
      tileY: 34n,
      xLocal: [0, 17, 255],
      yLocal: [255, 19, 1],
      counts: [Math.PI, Number.MIN_VALUE, 9_007_199_254_740.125],
    }]);

    const decoded = decodeContactTileBinaryV1(buffer);

    expect(decoded.tileSizeBins).toBe(256);
    expect(decoded.byteLength).toBe(buffer.byteLength);
    expect(decoded.transport).toBe("array_buffer");
    expect(decoded.tiles).toHaveLength(1);
    expect(decoded.tiles[0]).toMatchObject({ tileX: 12, tileY: 34, cells: [] });
    expect(Array.from(decoded.tiles[0]!.packedCells.xLocal)).toEqual([0, 17, 255]);
    expect(Array.from(decoded.tiles[0]!.packedCells.yLocal)).toEqual([255, 19, 1]);
    expect(Array.from(decoded.tiles[0]!.packedCells.counts)).toEqual([
      Math.PI,
      Number.MIN_VALUE,
      9_007_199_254_740.125,
    ]);
  });

  it("accepts an empty batch and an empty tile", () => {
    expect(decodeContactTileBinaryV1(encodeContactTiles(256, []))).toEqual({
      tileSizeBins: 256,
      tiles: [],
      byteLength: 16,
      transport: "array_buffer",
    });

    const emptyTile = decodeContactTileBinaryV1(encodeContactTiles(256, [{
      tileX: 7n,
      tileY: 9n,
      xLocal: [],
      yLocal: [],
      counts: [],
    }]));
    expect(emptyTile.tiles[0]).toMatchObject({ tileX: 7, tileY: 9, cells: [] });
    expect(emptyTile.tiles[0]!.packedCells.xLocal).toHaveLength(0);
    expect(emptyTile.tiles[0]!.packedCells.yLocal).toHaveLength(0);
    expect(emptyTile.tiles[0]!.packedCells.counts).toHaveLength(0);
  });

  it("decodes completed dense Float32 display tiles without sparse materialization", () => {
    const buffer = encodeDenseContactTiles(2, [{
      tileX: 3n,
      tileY: 7n,
      values: [-1, 1.5, 2.25, 0],
    }]);

    const decoded = decodeContactTileBinaryV1(buffer);

    expect(decoded.tiles).toEqual([]);
    expect(decoded.denseTiles).toHaveLength(1);
    expect(decoded.denseTiles![0]).toMatchObject({
      tileX: 3,
      tileY: 7,
      occupiedCount: 3,
    });
    expect(Array.from(decoded.denseTiles![0]!.values)).toEqual([-1, 1.5, 2.25, 0]);
    expect(decoded.denseTiles![0]!.values.buffer).not.toBe(buffer);
  });

  it("preserves directory order without assuming sorted tile coordinates", () => {
    const decoded = decodeContactTileBinaryV1(encodeContactTiles(8, [
      { tileX: 8n, tileY: 2n, xLocal: [7], yLocal: [0], counts: [1.25] },
      { tileX: 1n, tileY: 9n, xLocal: [3, 4], yLocal: [5, 6], counts: [2.5, 3.75] },
    ]));

    expect(decoded.tiles.map(({ tileX, tileY }) => [tileX, tileY])).toEqual([[8, 2], [1, 9]]);
    expect(Array.from(decoded.tiles[1]!.packedCells.counts)).toEqual([2.5, 3.75]);
  });

  it("rejects a truncated header, directory, or payload", () => {
    const encoded = encodeContactTiles(256, [
      { tileX: 1n, tileY: 2n, xLocal: [3], yLocal: [4], counts: [5] },
    ]);
    expect(() => decodeContactTileBinaryV1(new ArrayBuffer(15))).toThrow(/header is truncated/);
    expect(() => decodeContactTileBinaryV1(encoded.slice(0, 39))).toThrow(/directory is truncated/);
    expect(() => decodeContactTileBinaryV1(encoded.slice(0, -1))).toThrow(/payload is truncated/);
  });

  it("rejects the wrong magic, version, or flags", () => {
    const encoded = encodeContactTiles(256, []);
    const wrongMagic = encoded.slice(0);
    new Uint8Array(wrongMagic)[0] = 0;
    expect(() => decodeContactTileBinaryV1(wrongMagic)).toThrow(/magic/);
    expect(() => decodeContactTileBinaryV1(
      copyAndMutate(encoded, (view) => view.setUint16(4, 2, true)),
    )).toThrow(/version 2/);
    expect(() => decodeContactTileBinaryV1(
      copyAndMutate(encoded, (view) => view.setUint16(6, 2, true)),
    )).toThrow(/flags 2/);
  });

  it("rejects malformed dense Float32 tiles", () => {
    const encoded = encodeDenseContactTiles(2, [{
      tileX: 1n,
      tileY: 2n,
      values: [-1, 1, 2, 3],
    }]);
    expect(() => decodeContactTileBinaryV1(copyAndMutate(encoded, (view) => {
      view.setUint32(headerBytes + 16, 3, true);
    }))).toThrow(/value count/);
    expect(() => decodeContactTileBinaryV1(copyAndMutate(encoded, (view) => {
      view.setFloat32(headerBytes + directoryEntryBytes, Number.NaN, true);
    }))).toThrow(/non-finite/);
  });

  it("rejects tile coordinates that cannot be represented safely as numbers", () => {
    const encoded = encodeContactTiles(256, [
      { tileX: 1n, tileY: 2n, xLocal: [], yLocal: [], counts: [] },
    ]);
    const unsafe = copyAndMutate(encoded, (view) => {
      view.setBigUint64(headerBytes, BigInt(Number.MAX_SAFE_INTEGER) + 1n, true);
    });
    expect(() => decodeContactTileBinaryV1(unsafe)).toThrow(/MAX_SAFE_INTEGER/);
  });

  it("rejects offsets before the payload, without 8-byte alignment, or beyond the buffer", () => {
    const encoded = encodeContactTiles(256, [
      { tileX: 1n, tileY: 2n, xLocal: [3], yLocal: [4], counts: [5] },
    ]);
    expect(() => decodeContactTileBinaryV1(
      copyAndMutate(encoded, (view) => view.setUint32(headerBytes + 20, 16, true)),
    )).toThrow(/outside the payload/);
    expect(() => decodeContactTileBinaryV1(
      copyAndMutate(encoded, (view) => view.setUint32(headerBytes + 20, 41, true)),
    )).toThrow(/8-byte aligned/);
    expect(() => decodeContactTileBinaryV1(
      copyAndMutate(encoded, (view) => view.setUint32(headerBytes + 20, 0xfffffff8, true)),
    )).toThrow(/outside the payload/);
  });

  it("rejects overlapping, gapped, and trailing payload ranges", () => {
    const encoded = encodeContactTiles(256, [
      { tileX: 1n, tileY: 2n, xLocal: [3], yLocal: [4], counts: [5] },
      { tileX: 6n, tileY: 7n, xLocal: [8], yLocal: [9], counts: [10] },
    ]);
    const firstOffset = new DataView(encoded).getUint32(headerBytes + 20, true);
    expect(() => decodeContactTileBinaryV1(copyAndMutate(encoded, (view) => {
      view.setUint32(headerBytes + directoryEntryBytes + 20, firstOffset, true);
    }))).toThrow(/overlaps/);

    const withGap = new ArrayBuffer(encoded.byteLength + 8);
    new Uint8Array(withGap).set(new Uint8Array(encoded));
    const gapView = new DataView(withGap);
    const secondOffsetField = headerBytes + directoryEntryBytes + 20;
    gapView.setUint32(secondOffsetField, gapView.getUint32(secondOffsetField, true) + 8, true);
    expect(() => decodeContactTileBinaryV1(withGap)).toThrow(/leaves a gap/);

    const trailing = new ArrayBuffer(encoded.byteLength + 8);
    new Uint8Array(trailing).set(new Uint8Array(encoded));
    expect(() => decodeContactTileBinaryV1(trailing)).toThrow(/byte length/);
  });

  it("rejects tile sizes and local coordinates outside the protocol bounds", () => {
    const empty = encodeContactTiles(256, []);
    expect(() => decodeContactTileBinaryV1(
      copyAndMutate(empty, (view) => view.setUint32(8, 0, true)),
    )).toThrow(/1\.\.65536/);
    expect(() => decodeContactTileBinaryV1(
      copyAndMutate(empty, (view) => view.setUint32(8, 65_537, true)),
    )).toThrow(/1\.\.65536/);

    const badLocal = encodeContactTiles(4, [
      { tileX: 1n, tileY: 2n, xLocal: [4], yLocal: [0], counts: [1] },
    ]);
    expect(() => decodeContactTileBinaryV1(badLocal)).toThrow(/local coordinate/);
  });

  it("fails closed for JSON number arrays and typed-array wrappers", () => {
    expect(() => decodeContactTileBinaryV1([67, 83, 84, 49])).toThrow(/ArrayBuffer/);
    expect(() => decodeContactTileBinaryV1(new Uint8Array(16))).toThrow(/ArrayBuffer/);
  });

  it("copies each tile into independent arrays instead of retaining the shared batch buffer", () => {
    const buffer = encodeContactTiles(256, [
      { tileX: 1n, tileY: 2n, xLocal: [3], yLocal: [4], counts: [5.5] },
      { tileX: 6n, tileY: 7n, xLocal: [8], yLocal: [9], counts: [10.5] },
    ]);
    const decoded = decodeContactTileBinaryV1(buffer);
    const first = decoded.tiles[0]!.packedCells;
    const second = decoded.tiles[1]!.packedCells;

    for (const packed of [first, second]) {
      expect(packed.xLocal.buffer).not.toBe(buffer);
      expect(packed.yLocal.buffer).not.toBe(buffer);
      expect(packed.counts.buffer).not.toBe(buffer);
    }
    expect(first.xLocal.buffer).not.toBe(second.xLocal.buffer);
    expect(first.yLocal.buffer).not.toBe(second.yLocal.buffer);
    expect(first.counts.buffer).not.toBe(second.counts.buffer);

    new Uint8Array(buffer).fill(0);
    expect(Array.from(first.xLocal)).toEqual([3]);
    expect(Array.from(first.yLocal)).toEqual([4]);
    expect(Array.from(first.counts)).toEqual([5.5]);
    expect(Array.from(second.counts)).toEqual([10.5]);
  });
});
