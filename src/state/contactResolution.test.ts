import { describe, expect, it } from "vitest";
import {
  chooseContactResolutionForBpPerPixel,
  chooseContactResolutionForSpan,
  contactResolutionLevelsForViewport,
  contactResolutionToBasePairs,
  contactViewportSpanForResolution,
  minimumContactViewportSpanMb,
  wholeGenomeContactResolutionForViewport,
} from "./contactResolution";

describe("contactResolutionToBasePairs", () => {
  it("converts Mb and kb labels into base pairs", () => {
    expect(contactResolutionToBasePairs("2.5 Mb")).toBe(2_500_000);
    expect(contactResolutionToBasePairs("2 Mb")).toBe(2_000_000);
    expect(contactResolutionToBasePairs("1 Mb")).toBe(1_000_000);
    expect(contactResolutionToBasePairs("500 kb")).toBe(500_000);
    expect(contactResolutionToBasePairs("250 kb")).toBe(250_000);
    expect(contactResolutionToBasePairs("25 kb")).toBe(25_000);
    expect(contactResolutionToBasePairs("5 kb")).toBe(5_000);
  });
});

describe("chooseContactResolutionForSpan", () => {
  it("chooses Juicebox-like pyramid levels from viewport span", () => {
    expect(chooseContactResolutionForSpan(500)).toBe("2.5 Mb");
    expect(chooseContactResolutionForSpan(200)).toBe("1 Mb");
    expect(chooseContactResolutionForSpan(100)).toBe("500 kb");
    expect(chooseContactResolutionForSpan(50)).toBe("250 kb");
    expect(chooseContactResolutionForSpan(20)).toBe("100 kb");
    expect(chooseContactResolutionForSpan(10)).toBe("50 kb");
    expect(chooseContactResolutionForSpan(5)).toBe("25 kb");
    expect(chooseContactResolutionForSpan(2)).toBe("10 kb");
    expect(chooseContactResolutionForSpan(1)).toBe("5 kb");
  });

  it("uses the measured viewport instead of a fixed span bucket", () => {
    expect(chooseContactResolutionForSpan(100, 536)).toBe("250 kb");
    expect(chooseContactResolutionForBpPerPixel(100_000_000 / 536)).toBe("250 kb");
    expect(chooseContactResolutionForBpPerPixel(3_000_000)).toBe("2.5 Mb");
  });
});

describe("Juicebox contact viewport geometry", () => {
  it("chooses the whole-map resolution from genome span and viewport size", () => {
    const wholeGenomeSpanMb = 196.84;

    expect(wholeGenomeContactResolutionForViewport(wholeGenomeSpanMb, 536)).toBe("500 kb");
    expect(wholeGenomeContactResolutionForViewport(400, 800)).toBe("500 kb");
    expect(wholeGenomeContactResolutionForViewport(30, 800)).toBe("50 kb");
    expect(contactResolutionLevelsForViewport(wholeGenomeSpanMb, 536)).toEqual([
      "500 kb",
      "250 kb",
      "100 kb",
      "50 kb",
      "25 kb",
      "10 kb",
      "5 kb",
    ]);
  });

  it("keeps finer-resolution bins at one CSS pixel while their viewport zooms in", () => {
    const wholeGenomeSpanMb = 196.84;

    expect(contactViewportSpanForResolution("500 kb", 536, wholeGenomeSpanMb)).toBe(196.84);
    expect(contactViewportSpanForResolution("250 kb", 536, wholeGenomeSpanMb)).toBe(134);
    expect(contactViewportSpanForResolution("100 kb", 536, wholeGenomeSpanMb)).toBe(53.6);
    expect(contactViewportSpanForResolution("50 kb", 536, wholeGenomeSpanMb)).toBe(26.8);

    const activeLevels = contactResolutionLevelsForViewport(wholeGenomeSpanMb, 536);
    const spans = activeLevels.map((resolution) => (
      contactViewportSpanForResolution(resolution, 536, wholeGenomeSpanMb)
    ));
    for (let index = 1; index < spans.length; index += 1) {
      expect(spans[index]).toBeLessThan(spans[index - 1] ?? Infinity);
    }
  });

  it("keeps the one-pixel-per-bin bound for very large assemblies", () => {
    expect(contactViewportSpanForResolution("2.5 Mb", 536, 10_000)).toBe(10_000);
    expect(contactViewportSpanForResolution("2 Mb", 536, 10_000)).toBe(1_072);
    expect(contactViewportSpanForResolution("1 Mb", 536, 10_000)).toBe(536);
  });

  it("derives the superzoom floor from Juicebox's 128 px per-bin cap", () => {
    expect(minimumContactViewportSpanMb("5 kb", 536)).toBeCloseTo(0.0209375, 8);
    expect(minimumContactViewportSpanMb("5 kb", 0)).toBeGreaterThanOrEqual(0.000001);
  });
});
