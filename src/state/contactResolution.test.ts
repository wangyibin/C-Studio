import { describe, expect, it } from "vitest";
import {
  chooseContactResolutionForBpPerPixel,
  chooseContactResolutionForSpan,
  contactResolutionToBasePairs,
  contactViewportSpanForResolution,
  minimumContactViewportSpanMb,
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
  it("resets manual selections to one pixel per bin and clamps to the loaded span", () => {
    expect(contactViewportSpanForResolution("50 kb", 536, 200)).toBe(26.8);
    expect(contactViewportSpanForResolution("2 Mb", 536, 196.84)).toBe(196.84);
  });

  it("derives the superzoom floor from Juicebox's 128 px per-bin cap", () => {
    expect(minimumContactViewportSpanMb("5 kb", 536)).toBeCloseTo(0.0209375, 8);
    expect(minimumContactViewportSpanMb("5 kb", 0)).toBeGreaterThanOrEqual(0.000001);
  });
});
