import { describe, expect, it } from "vitest";
import {
  ContactTileDeltaAccumulator,
  mergeCompleteContactTilesIntoDeltaAccumulator,
} from "./contactTileDelta";

describe("ContactTileDeltaAccumulator", () => {
  it("adds repeated sparse deltas and preserves requested empty tiles", () => {
    const accumulator = new ContactTileDeltaAccumulator([
      { tileX: 0, tileY: 0 },
      { tileX: 1, tileY: 1 },
    ], 4);

    const batches: string[][] = [];
    accumulator.subscribe((batch) => batches.push([...batch.changedTileKeys]));
    accumulator.merge([{
      tileX: 0,
      tileY: 0,
      cells: [{ xBin: 1, yBin: 2, count: 3 }],
    }]);
    const changed = accumulator.merge([{
      tileX: 0,
      tileY: 0,
      cells: [],
      packedCells: {
        xLocal: new Uint16Array([1, 3]),
        yLocal: new Uint16Array([2, 0]),
        counts: new Float64Array([4, 5]),
      },
    }]);

    expect(changed).toEqual(["0:0"]);
    expect(batches).toEqual([["0:0"], ["0:0"]]);
    expect(accumulator.snapshotBuildCount).toBe(0);
    const finished = accumulator.finish();
    expect([...finished[0]!.packedCells!.counts]).toEqual([5, 7]);
    expect(finished).toHaveLength(2);
    expect(finished[1]!.packedCells!.counts).toHaveLength(0);
    expect(accumulator.snapshotBuildCount).toBe(2);
  });

  it("uses a fixed bounded buffer per requested tile", () => {
    const accumulator = new ContactTileDeltaAccumulator(
      Array.from({ length: 16 }, (_, tileX) => ({ tileX, tileY: tileX })),
      256,
    );

    expect(accumulator.allocatedBytes).toBe(16 * 256 * 256 * 9);
  });

  it("rejects deltas for tiles outside the request", () => {
    const accumulator = new ContactTileDeltaAccumulator([{ tileX: 0, tileY: 0 }], 4);
    expect(() => accumulator.merge([{
      tileX: 1,
      tileY: 1,
      cells: [{ xBin: 4, yBin: 4, count: 1 }],
    }])).toThrow(/unrequested tile/);
  });

  it("does not rebuild cumulative snapshots for repeated streamed batches", () => {
    const accumulator = new ContactTileDeltaAccumulator(
      Array.from({ length: 16 }, (_, tileX) => ({ tileX, tileY: tileX })),
      256,
    );

    for (let batch = 0; batch < 40; batch += 1) {
      accumulator.merge([{
        tileX: batch % 16,
        tileY: batch % 16,
        cells: [],
        packedCells: {
          xLocal: new Uint16Array([batch % 256]),
          yLocal: new Uint16Array([(batch * 7) % 256]),
          counts: new Float64Array([1]),
        },
      }]);
    }

    expect(accumulator.snapshotBuildCount).toBe(0);
    accumulator.finish();
    expect(accumulator.snapshotBuildCount).toBe(16);
  });

  it("labels pre-sentinel snapshots as partial and keeps finish as the authoritative boundary", () => {
    const accumulator = new ContactTileDeltaAccumulator([{ tileX: 0, tileY: 0 }], 4);
    accumulator.merge([{
      tileX: 0,
      tileY: 0,
      cells: [{ xBin: 1, yBin: 2, count: 3 }],
    }]);

    const preview = accumulator.previewBatch(["0:0"]);
    expect(preview.completeness).toBe("partial");
    expect([...preview.tiles[0]!.packedCells!.counts]).toEqual([3]);

    accumulator.merge([{
      tileX: 0,
      tileY: 0,
      cells: [{ xBin: 1, yBin: 2, count: 4 }],
    }]);
    expect([...accumulator.finish()[0]!.packedCells!.counts]).toEqual([7]);
  });

  it("seeds cached and progressive complete tiles exactly once for GPU staging", () => {
    const accumulator = new ContactTileDeltaAccumulator([{ tileX: 0, tileY: 0 }], 4);
    const mergedKeys = new Set<string>();
    const tile = {
      tileX: 0,
      tileY: 0,
      cells: [{ xBin: 1, yBin: 2, count: 7 }],
    };

    expect(mergeCompleteContactTilesIntoDeltaAccumulator(
      accumulator,
      mergedKeys,
      [tile],
    )).toEqual(["0:0"]);
    expect(mergeCompleteContactTilesIntoDeltaAccumulator(
      accumulator,
      mergedKeys,
      [tile],
    )).toEqual([]);
    expect([...accumulator.finish()[0]!.packedCells!.counts]).toEqual([7]);
  });
});
