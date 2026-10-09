import { describe, expect, it } from "vitest";
import { drawContactAssemblyBoundaries } from "./contactAssemblyCanvas";
import type { ContactTileGpuBoundary } from "./contactTileGpu";

function canvasRecorder() {
  const rectangles: number[][] = [];
  const transforms: number[][] = [];
  const context = {
    fillStyle: "",
    setTransform: (...values: number[]) => transforms.push(values),
    clearRect: () => { rectangles.length = 0; },
    fillRect: (...values: number[]) => rectangles.push(values),
  };
  const canvas = { width: 0, height: 0, getContext: () => context } as unknown as HTMLCanvasElement;
  return { canvas, rectangles, transforms, context };
}

const boundary = (visualStart: number, visualEnd: number, minimumSpanCssPx = 1): ContactTileGpuBoundary => ({
  visualStart, visualEnd, color: [0.13, 0.77, 0.37], lineWidthCssPx: 0.5, minimumSpanCssPx,
});

describe("remote assembly boundary canvas", () => {
  it("reveals newly visible boundaries immediately on a long pan with the retained scene", () => {
    const { canvas, rectangles } = canvasRecorder();
    const scene = [boundary(230, 260)];
    drawContactAssemblyBoundaries(canvas, scene, { xStart: 0, xEnd: 100, yStart: 0, yEnd: 100 }, 400, 200, 1);
    expect(rectangles).toEqual([]);
    drawContactAssemblyBoundaries(canvas, scene, { xStart: 200, xEnd: 300, yStart: 220, yEnd: 320 }, 400, 200, 1);
    expect(rectangles).toEqual([
      [120, 19.75, 120, 0.5], [120, 79.75, 120, 0.5],
      [119.75, 20, 0.5, 60], [239.75, 20, 0.5, 60],
    ]);
  });

  it("clips real edges without drawing a false viewport frame inside a chromosome", () => {
    const { canvas, rectangles } = canvasRecorder();
    const viewport = { xStart: 100, xEnd: 200, yStart: 100, yEnd: 200 };
    drawContactAssemblyBoundaries(canvas, [boundary(0, 300)], viewport, 200, 200, 1);
    expect(rectangles).toEqual([]);
    drawContactAssemblyBoundaries(canvas, [boundary(0, 150)], viewport, 200, 200, 1);
    expect(rectangles).toEqual([[0, 99.75, 100, 0.5], [99.75, 0, 0.5, 100]]);
  });

  it("matches local subpixel thresholds on both axes while retaining selected thin intervals", () => {
    const { canvas, rectangles, context } = canvasRecorder();
    const viewport = { xStart: 0, xEnd: 100, yStart: 0, yEnd: 100 };
    const tiny = boundary(10, 10.5);
    drawContactAssemblyBoundaries(canvas, [tiny], viewport, 400, 100, 1);
    expect(rectangles).toEqual([]);
    drawContactAssemblyBoundaries(canvas, [{ ...tiny, minimumSpanCssPx: 0, color: [0, 0, 0], lineWidthCssPx: 2 }], viewport, 400, 100, 1);
    expect(rectangles).toHaveLength(4);
    expect(context.fillStyle).toBe("rgb(0,0,0)");
    expect(rectangles[0][3]).toBe(2);
  });

  it("uses display pixels for line widths and bounds the overlay memory on large displays", () => {
    const { canvas, transforms } = canvasRecorder();
    const viewport = { xStart: 0, xEnd: 100, yStart: 0, yEnd: 100 };
    drawContactAssemblyBoundaries(canvas, [], viewport, 400, 200, 2);
    expect([canvas.width, canvas.height]).toEqual([800, 400]);
    expect(transforms[transforms.length - 1]).toEqual([2, 0, 0, 2, 0, 0]);
    drawContactAssemblyBoundaries(canvas, [], viewport, 4000, 3000, 3);
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(2_097_152);
  });
});
