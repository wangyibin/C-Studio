import { describe, expect, it } from "vitest";
import { contactRenderGeometry } from "./contactRenderGeometry";

describe("contactRenderGeometry", () => {
  it("uses fixed one-pixel points for small projected bins", () => {
    expect(
      contactRenderGeometry({
        resolution: 25_000,
        viewportWidth: 10_000_000,
        viewportHeight: 10_000_000,
        canvasWidth: 500,
        canvasHeight: 500,
      }),
    ).toEqual({ mode: "point", widthPx: 1, heightPx: 1 });
  });

  it("uses true bin rectangles after deep zoom", () => {
    expect(
      contactRenderGeometry({
        resolution: 25_000,
        viewportWidth: 1_000_000,
        viewportHeight: 1_000_000,
        canvasWidth: 500,
        canvasHeight: 500,
      }),
    ).toEqual({ mode: "rect", widthPx: 12.5, heightPx: 12.5 });
  });

});
