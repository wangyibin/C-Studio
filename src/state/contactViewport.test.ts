import { describe, expect, it } from "vitest";
import {
  buildCenteredContactViewport,
  buildWholeGenomeContactViewport,
  sampleContactViewportVelocity,
  contactViewportAxisSpans,
  contactViewportWithDirectionalLead,
  contactViewportWithVelocityAwareLead,
  horizontalViewportDragDeltaMb,
  horizontalViewportFocusRatio,
} from "./contactViewport";
import { contactTileViewportSignature } from "./contactTiles";

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

describe("contactViewportWithDirectionalLead", () => {
  it("looks ahead independently on each moving axis without changing the displayed span", () => {
    expect(contactViewportWithDirectionalLead(
      { xStart: 100, xEnd: 300, yStart: 100, yEnd: 300 },
      { xStart: 120, xEnd: 320, yStart: 80, yEnd: 280 },
      40,
      1_000,
    )).toEqual({ xStart: 160, xEnd: 360, yStart: 40, yEnd: 240 });
  });

  it("clamps the hint at genome edges and ignores invalid lead distances", () => {
    expect(contactViewportWithDirectionalLead(
      { xStart: 700, xEnd: 900, yStart: 0, yEnd: 200 },
      { xStart: 800, xEnd: 1_000, yStart: 0, yEnd: 200 },
      80,
      1_000,
    )).toEqual({ xStart: 800, xEnd: 1_000, yStart: 0, yEnd: 200 });
    expect(contactViewportWithDirectionalLead(
      { xStart: 100, xEnd: 300, yStart: 100, yEnd: 300 },
      { xStart: 120, xEnd: 320, yStart: 100, yEnd: 300 },
      Number.NaN,
      1_000,
    )).toEqual({ xStart: 120, xEnd: 320, yStart: 100, yEnd: 300 });
  });
});

describe("velocity-aware contact prefetch", () => {
  it("grows independently from half a tile to one and a half tiles per moving axis", () => {
    const source = { xStart: 100, xEnd: 300, yStart: 100, yEnd: 300 };
    const target = { xStart: 120, xEnd: 320, yStart: 80, yEnd: 280 };

    expect(contactViewportWithVelocityAwareLead(
      source,
      target,
      40,
      { xBpPerMs: 0, yBpPerMs: 0 },
      1_000,
    )).toEqual({ xStart: 140, xEnd: 340, yStart: 60, yEnd: 260 });
    expect(contactViewportWithVelocityAwareLead(
      source,
      target,
      40,
      { xBpPerMs: 0.16, yBpPerMs: -0.08 },
      1_000,
    )).toEqual({ xStart: 180, xEnd: 380, yStart: 40, yEnd: 240 });
  });

  it("switches the prefetch side immediately when current velocity reverses", () => {
    expect(contactViewportWithVelocityAwareLead(
      { xStart: 100, xEnd: 300, yStart: 100, yEnd: 300 },
      { xStart: 140, xEnd: 340, yStart: 100, yEnd: 300 },
      40,
      { xBpPerMs: -0.04, yBpPerMs: 0 },
      1_000,
    )).toEqual({ xStart: 110, xEnd: 310, yStart: 100, yEnd: 300 });
  });

  it("samples stable velocity, resets after a pause, and preserves tile-signature deduplication", () => {
    const initial = sampleContactViewportVelocity(
      null,
      { xStart: 100, xEnd: 300, yStart: 100, yEnd: 300 },
      0,
    );
    const forward = sampleContactViewportVelocity(
      initial,
      { xStart: 120, xEnd: 320, yStart: 100, yEnd: 300 },
      100,
    );
    const reversed = sampleContactViewportVelocity(
      forward,
      { xStart: 110, xEnd: 310, yStart: 100, yEnd: 300 },
      200,
    );
    const afterPause = sampleContactViewportVelocity(
      reversed,
      { xStart: 130, xEnd: 330, yStart: 100, yEnd: 300 },
      500,
    );

    expect(forward.xBpPerMs).toBeCloseTo(0.2);
    expect(reversed.xBpPerMs).toBeCloseTo(-0.1);
    expect(afterPause.xBpPerMs).toBe(0);

    const source = { xStart: 100, xEnd: 300, yStart: 100, yEnd: 300 };
    const firstHint = contactViewportWithVelocityAwareLead(
      source,
      { xStart: 120, xEnd: 320, yStart: 100, yEnd: 300 },
      100,
      { xBpPerMs: 0, yBpPerMs: 0 },
      1_000,
    );
    const sameTileHint = contactViewportWithVelocityAwareLead(
      source,
      { xStart: 125, xEnd: 325, yStart: 100, yEnd: 300 },
      100,
      { xBpPerMs: 0, yBpPerMs: 0 },
      1_000,
    );
    expect(contactTileViewportSignature(firstHint, 1, 100, 1_000)).toBe(
      contactTileViewportSignature(sameTileHint, 1, 100, 1_000),
    );
  });
});

describe("horizontalViewportDragDeltaMb", () => {
  it("uses grab-style horizontal panning and rejects invalid geometry", () => {
    const viewport = { xStart: 100_000_000, xEnd: 300_000_000 };
    expect(horizontalViewportDragDeltaMb(50, 400, viewport)).toBe(-25);
    expect(horizontalViewportDragDeltaMb(-80, 400, viewport)).toBe(40);
    expect(horizontalViewportDragDeltaMb(50, 0, viewport)).toBe(0);
    expect(horizontalViewportDragDeltaMb(50, 400, { xStart: 10, xEnd: 10 })).toBe(0);
  });
});

describe("horizontalViewportFocusRatio", () => {
  it("maps the pointer into the horizontal viewport and clamps its edges", () => {
    expect(horizontalViewportFocusRatio(250, 50, 400)).toBe(0.5);
    expect(horizontalViewportFocusRatio(0, 50, 400)).toBe(0);
    expect(horizontalViewportFocusRatio(500, 50, 400)).toBe(1);
    expect(horizontalViewportFocusRatio(250, 50, 0)).toBe(0.5);
  });
});
