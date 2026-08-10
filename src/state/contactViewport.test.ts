import { describe, expect, it } from "vitest";
import {
  buildCenteredContactViewport,
  buildWholeGenomeContactViewport,
  contactViewportAxisSpans,
} from "./contactViewport";

describe("buildCenteredContactViewport", () => {
  it("builds a centered square viewport in base pairs", () => {
    expect(buildCenteredContactViewport({ centerMb: 150, totalSpanBp: 300_000_000 })).toEqual({
      xStart: 50_000_000,
      xEnd: 250_000_000,
      yStart: 50_000_000,
      yEnd: 250_000_000,
    });
  });

  it("clamps centered viewport to the global span", () => {
    expect(buildCenteredContactViewport({ centerMb: 10, totalSpanBp: 300_000_000 })).toEqual({
      xStart: 0,
      xEnd: 200_000_000,
      yStart: 0,
      yEnd: 200_000_000,
    });

    expect(buildCenteredContactViewport({ centerMb: 290, totalSpanBp: 300_000_000 })).toEqual({
      xStart: 100_000_000,
      xEnd: 300_000_000,
      yStart: 100_000_000,
      yEnd: 300_000_000,
    });
  });

  it("keeps one base-pair scale across a wide adaptive viewport", () => {
    const spans = contactViewportAxisSpans(300_000_000, 100_000_000, 1200, 800);
    expect(spans).toEqual({
      xSpanBp: 150_000_000,
      ySpanBp: 100_000_000,
    });
    const chromosomeSpanBp = 30_000_000;
    expect((chromosomeSpanBp / spans.xSpanBp) * 1200).toBeCloseTo(240);
    expect((chromosomeSpanBp / spans.ySpanBp) * 800).toBeCloseTo(240);
    expect(buildCenteredContactViewport({
      centerMb: 150,
      totalSpanBp: 300_000_000,
      windowSizeBp: 100_000_000,
      viewportWidthPx: 1200,
      viewportHeightPx: 800,
    })).toEqual({
      xStart: 75_000_000,
      xEnd: 225_000_000,
      yStart: 100_000_000,
      yEnd: 200_000_000,
    });
  });

  it("keeps scale beyond the genome edge and leaves the uncovered field empty", () => {
    expect(buildCenteredContactViewport({
      centerMb: 150,
      totalSpanBp: 300_000_000,
      windowSizeBp: 300_000_000,
      viewportWidthPx: 1200,
      viewportHeightPx: 800,
    })).toEqual({
      xStart: 0,
      xEnd: 450_000_000,
      yStart: 0,
      yEnd: 300_000_000,
    });
  });

  it("builds a whole-genome square viewport", () => {
    expect(buildWholeGenomeContactViewport(123_456_789)).toEqual({
      xStart: 0,
      xEnd: 123_456_789,
      yStart: 0,
      yEnd: 123_456_789,
    });
  });
});
