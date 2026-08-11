import { describe, expect, it } from "vitest";
import {
  contactAutoColorScaleKey,
  contactCountSampleForColorScale,
  estimateContactColorScale,
  normalizeContactValue,
} from "./contactColorScale";

function sortedPercentileOracle(counts: number[]): number {
  const values = counts
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);

  if (values.length === 0) {
    return 1;
  }

  const thresholdIndex = Math.min(values.length - 1, Math.floor((95 / 100) * values.length));
  return values[thresholdIndex];
}

describe("contactAutoColorScaleKey", () => {
  it("keeps a shared comparison scale for one dataset and resolution", () => {
    expect(contactAutoColorScaleKey("/tmp/input.cool", 10_000, 256, false)).toBe(
      "/tmp/input.cool|10000|256|linear",
    );
    expect(contactAutoColorScaleKey("/tmp/input.cool", 10_000, 256, true)).toBe(
      "/tmp/input.cool|10000|256|log",
    );
  });
});

describe("estimateContactColorScale", () => {
  it("matches a full-sort oracle across deterministic mixed distributions", () => {
    let state = 0x12345678;
    const pseudoRandomValues = Array.from({ length: 4_097 }, () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return (state % 257) - 16;
    });
    const samples = [
      [7],
      [8, 1, 5, 3, 13, 2, 21, 1],
      [0, -3, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
      [...pseudoRandomValues, 0.25, 0.5, 10_000, Number.NaN],
    ];

    for (const counts of samples) {
      expect(estimateContactColorScale(counts, false).max).toBe(sortedPercentileOracle(counts));
    }
  });

  it("uses Juicebox's nearest-index P95 as the automatic threshold", () => {
    const scale = estimateContactColorScale(
      Array.from({ length: 100 }, (_, index) => index + 1),
      false,
    );

    expect(scale).toEqual({ log: false, min: 0, max: 96, auto: true });
  });

  it("clips a long-tail outlier without inflating the P95 threshold", () => {
    const scale = estimateContactColorScale(
      [...Array.from({ length: 100 }, (_, index) => index + 1), 2_500],
      false,
    );

    expect(scale.max).toBe(96);
  });

  it("keeps the same percentile rule on both sides of the old 1,000-value boundary", () => {
    const values999 = Array.from({ length: 999 }, (_, index) => index + 1);
    const values1000 = Array.from({ length: 1_000 }, (_, index) => index + 1);

    expect(estimateContactColorScale(values999, false).max).toBe(950);
    expect(estimateContactColorScale(values1000, false).max).toBe(951);
  });

  it("handles repeated values on and around the percentile boundary", () => {
    const values = [
      ...Array.from({ length: 9_500 }, (_, index) => (index % 2 === 0 ? 7 : 5)),
      ...Array.from({ length: 500 }, () => 23),
    ];

    expect(estimateContactColorScale(values, false).max).toBe(23);
    expect(estimateContactColorScale(Array.from({ length: 10_000 }, () => 7), false).max).toBe(7);
  });

  it("returns the same result for ascending and descending samples", () => {
    const ascending = Array.from({ length: 10_001 }, (_, index) => index + 1);
    const descending = [...ascending].reverse();
    const expected = sortedPercentileOracle(ascending);

    expect(estimateContactColorScale(ascending, false).max).toBe(expected);
    expect(estimateContactColorScale(descending, false).max).toBe(expected);
  });

  it("does not modify the caller's sample", () => {
    const counts = [7, 3, Number.NaN, -1, 4, Number.POSITIVE_INFINITY, 2, 7];
    const original = [...counts];

    estimateContactColorScale(counts, true);

    expect(counts).toEqual(original);
  });

  it("adapts each resolution independently while retaining a zero baseline", () => {
    const coarseScale = estimateContactColorScale(
      Array.from({ length: 100 }, (_, index) => 40 + index * 2),
      false,
    );
    const fineScale = estimateContactColorScale(
      Array.from({ length: 100 }, (_, index) => 0.05 + index * 0.01),
      false,
    );

    expect(coarseScale).toEqual({ log: false, min: 0, max: 230, auto: true });
    expect(fineScale.min).toBe(0);
    expect(fineScale.max).toBeCloseTo(1, 10);
  });

  it("falls back to a usable zero-based range when no stored positive counts are visible", () => {
    expect(estimateContactColorScale([0, Number.NaN, Number.POSITIVE_INFINITY], false)).toEqual({
      log: false,
      min: 0,
      max: 1,
      auto: true,
    });
  });
});

describe("normalizeContactValue", () => {
  it("uses Juicebox's linear zero-to-threshold mapping by default", () => {
    const scale = { log: false, min: 0, max: 100 };

    expect(normalizeContactValue(0, scale)).toBe(0);
    expect(normalizeContactValue(25, scale)).toBe(0.25);
    expect(normalizeContactValue(100, scale)).toBe(1);
    expect(normalizeContactValue(500, scale)).toBe(1);
  });
});

describe("contactCountSampleForColorScale", () => {
  it("uses all stored counts from visible tiles and excludes prefetched cached tiles", () => {
    const visibleCounts = Array.from({ length: 20_005 }, (_, index) => index + 1);
    const counts = contactCountSampleForColorScale({
      resolution: 1_000,
      viewport: { xStart: 0, xEnd: 512_000, yStart: 0, yEnd: 512_000 },
      cells: [],
      tileSizeBins: 256,
      tiles: [
        {
          tileX: 0,
          tileY: 0,
          cells: visibleCounts.map((count, index) => ({ xBin: index, yBin: 1, count })),
        },
      ],
      cachedTiles: [
        {
          tileX: 1,
          tileY: 1,
          cells: [{ xBin: 300, yBin: 300, count: 999_999 }],
        },
      ],
    });

    expect(counts).toHaveLength(visibleCounts.length);
    expect(counts[0]).toBe(1);
    expect(counts[counts.length - 1]).toBe(20_005);
    expect(counts).not.toContain(999_999);
  });

  it("samples packed visible counts without materializing contact cells", () => {
    const packedTile = {
      tileX: 2,
      tileY: 3,
      cells: [],
      packedCells: {
        xLocal: new Uint16Array([1, 2, 3]),
        yLocal: new Uint16Array([4, 5, 6]),
        counts: new Float64Array([0.25, 7, 42]),
      },
    };
    const counts = contactCountSampleForColorScale({
      resolution: 1_000,
      viewport: { xStart: 0, xEnd: 1_000_000, yStart: 0, yEnd: 1_000_000 },
      cells: [],
      tileSizeBins: 256,
      tiles: [packedTile],
      cachedTiles: [{
        tileX: 0,
        tileY: 0,
        cells: [],
        packedCells: {
          xLocal: new Uint16Array([0]),
          yLocal: new Uint16Array([0]),
          counts: new Float64Array([999_999]),
        },
      }],
    });

    expect(counts).toEqual([0.25, 7, 42]);
  });
});
