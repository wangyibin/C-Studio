import { describe, expect, it } from "vitest";
import {
  cacheAutoColorScale,
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

  const position = (99 * (values.length + 1)) / 100;
  if (position < 1) {
    return values[0];
  }
  if (position >= values.length) {
    return values[values.length - 1];
  }
  const lowerPosition = Math.floor(position);
  const lower = values[lowerPosition - 1];
  const upper = values[lowerPosition];
  return Math.fround(lower + (position - lowerPosition) * (upper - lower));
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

  it("uses Juicebox Desktop's interpolated whole-genome P99 threshold", () => {
    const scale = estimateContactColorScale(
      Array.from({ length: 100 }, (_, index) => index + 1),
      false,
    );

    expect(scale).toEqual({ log: false, min: 0, max: Math.fround(99.99), auto: true });
  });

  it("clips a sparse long-tail outlier at the P99 threshold", () => {
    const scale = estimateContactColorScale(
      [...Array.from({ length: 1_000 }, (_, index) => index + 1), 25_000],
      false,
    );

    expect(scale.max).toBe(Math.fround(991.98));
  });

  it("uses the Apache legacy N-plus-one interpolation between adjacent records", () => {
    const values = Array.from({ length: 1_000 }, (_, index) => index + 1);
    expect(estimateContactColorScale(values, false).max).toBe(Math.fround(990.99));
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

    expect(coarseScale).toEqual({ log: false, min: 0, max: Math.fround(237.98), auto: true });
    expect(fineScale.min).toBe(0);
    expect(fineScale.max).toBeCloseTo(1.0399, 6);
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
  const viewport = { xStart: 0, xEnd: 8000, yStart: 0, yEnd: 8000 };
  it("excludes offscreen and diagonal values but includes mirrored visible bins", () => {
    const cells = [
      { xBin: 1, yBin: 2, count: 4 },
      { xBin: 1, yBin: 1, count: 99999 },
      { xBin: 30, yBin: 31, count: 99999 },
      { xBin: 2, yBin: 3, count: 12 },
    ];
    expect(contactCountSampleForColorScale({ resolution: 1000, viewport, cells })).toEqual([4, 12]);
    expect(contactCountSampleForColorScale({ resolution: 1000,
      viewport: { xStart: 2000, xEnd: 3000, yStart: 1000, yEnd: 2000 }, cells })).toEqual([4]);
  });

  it("uses identical samples for sparse, packed and dense representations", () => {
    const cells = Array.from({ length: 128 * 128 }, (_, i) => ({
      xBin: i % 128, yBin: Math.floor(i / 128), count: i % 13 === 0 ? 0 : i + 1,
    }));
    const base = { resolution: 1000,
      viewport: { xStart: 0, xEnd: 128000, yStart: 0, yEnd: 128000 }, cells: [], tileSizeBins: 128 };
    const sparse = contactCountSampleForColorScale({ ...base,
      tiles: [{ tileX: 0, tileY: 0, cells }] });
    const dense = contactCountSampleForColorScale({ ...base,
      tiles: [{ tileX: 0, tileY: 0, cells: [], denseOccupiedCount: cells.length, denseValues: new Float32Array(cells.map(c => c.count)) }] });
    const packed = contactCountSampleForColorScale({ ...base,
      tiles: [{ tileX: 0, tileY: 0, cells: [], packedCells: {
        xLocal: new Uint16Array(cells.map(c => c.xBin)),
        yLocal: new Uint16Array(cells.map(c => c.yBin)),
        counts: new Float64Array(cells.map(c => c.count)),
      } }] });
    expect(dense).toEqual(sparse);
    expect(packed).toEqual(sparse);
    expect(estimateContactColorScale(contactCountSampleForColorScale({ ...base, cells: [...cells].reverse() }), false))
      .toEqual(estimateContactColorScale(sparse, false));
  });

  it("does not lose fine-resolution signals between stride positions", () => {
    const cells = Array.from({ length: 21 }, (_, i) => ({ xBin: i, yBin: 30, count: i === 9 ? 100 : 1 }));
    const counts = contactCountSampleForColorScale({ resolution: 1000,
      viewport: { xStart: 0, xEnd: 64000, yStart: 0, yEnd: 64000 }, cells });
    expect(counts).toHaveLength(21);
    expect(estimateContactColorScale(counts, false).max).toBe(100);
  });

  it("keeps Max during pan and refits the current view only on explicit Auto", () => {
    const cells = [
      { xBin: 1, yBin: 2, count: 100 },
      { xBin: 20, yBin: 21, count: 2 },
    ];
    const bright = { resolution: 1000, viewport, cells };
    const faint = { ...bright, viewport: { xStart: 20000, xEnd: 24000, yStart: 20000, yEnd: 24000 } };
    expect(estimateContactColorScale(contactCountSampleForColorScale(bright), false).max).toBe(100);
    expect(estimateContactColorScale(contactCountSampleForColorScale(faint), false).max).toBe(2);
    const cache = new Map();
    const key = contactAutoColorScaleKey("test", 1000, 256, false);
    cacheAutoColorScale(cache, key, estimateContactColorScale(contactCountSampleForColorScale(bright), false));
    // Panning retains the estimate; explicit Auto uses a fresh revision.
    expect(cache.get(contactAutoColorScaleKey("test", 1000, 256, false)).max).toBe(100);
    const refitKey = contactAutoColorScaleKey("test", 1000, 256, false, 1);
    expect(cache.has(refitKey)).toBe(false);
    cacheAutoColorScale(cache, refitKey, estimateContactColorScale(contactCountSampleForColorScale(faint), false));
    expect(cache.get(refitKey).max).toBe(2);
    expect(cache.has(contactAutoColorScaleKey("test", 5000, 256, false))).toBe(false);
  });
});

it("bounds the automatic resolution cache", () => {
  const cache = new Map();
  for (let i = 0; i < 200; i++) cacheAutoColorScale(cache, String(i), { min: 0, max: i + 1, auto: true, log: false });
  expect(cache.size).toBe(128);
  expect(cache.has("0")).toBe(false);
  expect(cache.get("199").max).toBe(200);
});
