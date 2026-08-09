import { describe, expect, it } from "vitest";
import {
  assemblyShiftClickIntent,
  contactCanvasBackingSizeFromBounds,
  contactViewportForAxisNavigator,
  contactViewportSizePxFromBounds,
  contactWheelPanIntent,
} from "./ContactMapViewport";

const bounds = {
  width: 400,
  height: 200,
};
const viewport = {
  xStart: 50_000_000,
  xEnd: 250_000_000,
  yStart: 75_000_000,
  yEnd: 175_000_000,
};

describe("contactWheelPanIntent", () => {
  it("maps trackpad movement independently across both genomic axes", () => {
    expect(contactWheelPanIntent({
      deltaX: 40,
      deltaY: 20,
      deltaMode: 0,
      shiftKey: false,
      bounds,
      viewport,
    })).toEqual({
      deltaXPx: 40,
      deltaYPx: 20,
      deltaXMb: 20,
      deltaYMb: 10,
    });

    expect(contactWheelPanIntent({
      deltaX: -80,
      deltaY: 0,
      deltaMode: 0,
      shiftKey: false,
      bounds,
      viewport,
    })).toMatchObject({ deltaXMb: -40, deltaYMb: 0 });
  });

  it("uses Shift-wheel for horizontal movement and normalizes line/page delta modes", () => {
    expect(contactWheelPanIntent({
      deltaX: 0,
      deltaY: 25,
      deltaMode: 0,
      shiftKey: true,
      bounds,
      viewport,
    })).toEqual({ deltaXPx: 25, deltaYPx: 0, deltaXMb: 12.5, deltaYMb: 0 });

    expect(contactWheelPanIntent({
      deltaX: 1,
      deltaY: -2,
      deltaMode: 1,
      shiftKey: false,
      bounds,
      viewport,
    })).toEqual({ deltaXPx: 16, deltaYPx: -32, deltaXMb: 8, deltaYMb: -16 });

    expect(contactWheelPanIntent({
      deltaX: 1,
      deltaY: -0.5,
      deltaMode: 2,
      shiftKey: false,
      bounds,
      viewport,
    })).toEqual({ deltaXPx: 400, deltaYPx: -100, deltaXMb: 200, deltaYMb: -50 });
  });

  it("ignores empty, invalid, or dimensionless wheel input", () => {
    expect(contactWheelPanIntent({
      deltaX: 0,
      deltaY: 0,
      deltaMode: 0,
      shiftKey: false,
      bounds,
      viewport,
    })).toBeNull();
    expect(contactWheelPanIntent({
      deltaX: Number.NaN,
      deltaY: Number.NaN,
      deltaMode: 0,
      shiftKey: false,
      bounds,
      viewport,
    })).toBeNull();
    expect(contactWheelPanIntent({
      deltaX: 10,
      deltaY: 10,
      deltaMode: 0,
      shiftKey: false,
      bounds: { width: 0, height: 200 },
      viewport,
    })).toBeNull();
  });
});

describe("contactViewportSizePxFromBounds", () => {
  it("reports the shortest visible side for square viewport resolution decisions", () => {
    expect(contactViewportSizePxFromBounds({ width: 536, height: 640 })).toBe(536);
    expect(contactViewportSizePxFromBounds({ width: 1200, height: 700 })).toBe(700);
    expect(contactViewportSizePxFromBounds({ width: 700, height: 1200 })).toBe(700);
    expect(contactViewportSizePxFromBounds({ width: 0, height: 640 })).toBeNull();
    expect(contactViewportSizePxFromBounds({ width: Number.NaN, height: 640 })).toBeNull();
  });
});

describe("contactViewportForAxisNavigator", () => {
  it("moves only the X viewport during a live navigator preview and clamps at the genome edge", () => {
    expect(contactViewportForAxisNavigator({
      axis: "x",
      centerRatio: 0.95,
      totalSpanMb: 400,
      viewportSpanMb: 100,
      viewportWidthPx: 500,
      viewportHeightPx: 500,
      centerXMb: 125,
      centerYMb: 275,
    })).toEqual({
      xStart: 300_000_000,
      xEnd: 400_000_000,
      yStart: 225_000_000,
      yEnd: 325_000_000,
    });
  });

  it("moves only the Y viewport during a live navigator preview and clamps invalid input", () => {
    expect(contactViewportForAxisNavigator({
      axis: "y",
      centerRatio: -0.25,
      totalSpanMb: 400,
      viewportSpanMb: 100,
      viewportWidthPx: 500,
      viewportHeightPx: 500,
      centerXMb: 125,
      centerYMb: 275,
    })).toEqual({
      xStart: 75_000_000,
      xEnd: 175_000_000,
      yStart: 0,
      yEnd: 100_000_000,
    });

    expect(contactViewportForAxisNavigator({
      axis: "x",
      centerRatio: Number.NaN,
      totalSpanMb: 200,
      viewportSpanMb: Number.NaN,
      viewportWidthPx: 500,
      viewportHeightPx: 500,
      centerXMb: Number.NaN,
      centerYMb: Number.NaN,
    })).toEqual({
      xStart: 0,
      xEnd: 200_000_000,
      yStart: 0,
      yEnd: 200_000_000,
    });
  });
});

describe("contactCanvasBackingSizeFromBounds", () => {
  it("resizes rectangular heatmaps on both axes independently", () => {
    expect(contactCanvasBackingSizeFromBounds({ width: 800, height: 520 }, 1)).toEqual({
      width: 2400,
      height: 1560,
    });
    expect(contactCanvasBackingSizeFromBounds({ width: 520, height: 800 }, 1)).toEqual({
      width: 1560,
      height: 2400,
    });
  });

  it("caps density and backing dimensions while rejecting empty bounds", () => {
    expect(contactCanvasBackingSizeFromBounds({ width: 400, height: 200 }, 3)).toEqual({
      width: 1800,
      height: 900,
    });
    expect(contactCanvasBackingSizeFromBounds({ width: 3000, height: 3000 }, 2)).toEqual({
      width: 4095,
      height: 4095,
    });
    expect(contactCanvasBackingSizeFromBounds({ width: 0, height: 200 }, 1)).toBeNull();
  });
});

describe("assemblyShiftClickIntent", () => {
  it("adds a new contig or clears when the Shift-click hit is already selected", () => {
    expect(assemblyShiftClickIntent(true, { kind: "contig", id: "ctg2" })).toEqual({
      type: "select-contig",
      id: "ctg2",
      additive: true,
    });
    expect(assemblyShiftClickIntent(true, { kind: "chromosome-boundary", id: "Chr02" })).toEqual({
      type: "select-chromosome",
      id: "Chr02",
    });
    expect(assemblyShiftClickIntent(true, { kind: "contig", id: "ctg2" }, true)).toEqual({
      type: "clear-selection",
    });
  });

  it("selects a hit only when there is no current selection", () => {
    expect(assemblyShiftClickIntent(false, { kind: "contig", id: "ctg2" })).toEqual({
      type: "select-contig",
      id: "ctg2",
      additive: false,
    });
    expect(assemblyShiftClickIntent(false, { kind: "chromosome-boundary", id: "Chr02" })).toEqual({
      type: "select-chromosome",
      id: "Chr02",
    });
    expect(assemblyShiftClickIntent(false, null)).toEqual({ type: "clear-selection" });
  });
});
