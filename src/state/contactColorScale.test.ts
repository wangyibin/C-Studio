import { describe, expect, it } from "vitest";
import {
  contactCountSampleForColorScale,
  estimateContactColorScale,
  normalizeContactValue,
} from "./contactColorScale";

describe("estimateContactColorScale", () => {
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
});
