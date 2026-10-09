import type { ContactViewport } from "../state/contactViewport";
import type { ContactTileGpuBoundary } from "./contactTileGpu";

// Only the transparent overlay lives on the client; no matrix/GPU tile atlas.
const maximumBoundaryCanvasPixels = 2_097_152;
const boundaryColors = new WeakMap<ContactTileGpuBoundary, string>();

/** Draw the same world-space edges and visibility thresholds as the local GPU scene. */
export function drawContactAssemblyBoundaries(
  canvas: HTMLCanvasElement | null,
  boundaries: readonly ContactTileGpuBoundary[],
  viewport: ContactViewport,
  width: number,
  height: number,
  pixelRatio = globalThis.devicePixelRatio || 1,
) {
  if (!canvas || width <= 0 || height <= 0) return;
  const scale = Math.min(Math.max(1, pixelRatio), 2,
    Math.sqrt(maximumBoundaryCanvasPixels / (width * height)));
  const backingWidth = Math.max(1, Math.floor(width * scale));
  const backingHeight = Math.max(1, Math.floor(height * scale));
  if (canvas.width !== backingWidth) canvas.width = backingWidth;
  if (canvas.height !== backingHeight) canvas.height = backingHeight;
  const context = canvas.getContext("2d");
  if (!context) return;
  context.setTransform(backingWidth / width, 0, 0, backingHeight / height, 0, 0);
  context.clearRect(0, 0, width, height);
  const scaleX = width / Math.max(1, viewport.xEnd - viewport.xStart);
  const scaleY = height / Math.max(1, viewport.yEnd - viewport.yStart);
  for (const boundary of boundaries) {
    const span = boundary.visualEnd - boundary.visualStart;
    if (span <= 0 || span * Math.min(scaleX, scaleY) < boundary.minimumSpanCssPx) continue;
    const left = (boundary.visualStart - viewport.xStart) * scaleX;
    const top = (boundary.visualStart - viewport.yStart) * scaleY;
    const right = (boundary.visualEnd - viewport.xStart) * scaleX;
    const bottom = (boundary.visualEnd - viewport.yStart) * scaleY;
    const line = Math.max(0.5, boundary.lineWidthCssPx);
    const half = line / 2;
    if (right + half < 0 || bottom + half < 0 || left - half > width || top - half > height) continue;
    let color = boundaryColors.get(boundary);
    if (!color) {
      color = `rgb(${boundary.color.map(value => Math.round(value * 255)).join(",")})`;
      boundaryColors.set(boundary, color);
    }
    context.fillStyle = color;
    // Clip each real edge, never the interval itself: clipping the interval
    // would invent a border along the viewport edge when zoomed into a block.
    const xStart = Math.max(0, left), xEnd = Math.min(width, right);
    const yStart = Math.max(0, top), yEnd = Math.min(height, bottom);
    if (xEnd > xStart) {
      if (top + half >= 0 && top - half <= height) context.fillRect(xStart, top - half, xEnd - xStart, line);
      if (bottom + half >= 0 && bottom - half <= height) context.fillRect(xStart, bottom - half, xEnd - xStart, line);
    }
    if (yEnd > yStart) {
      if (left + half >= 0 && left - half <= width) context.fillRect(left - half, yStart, line, yEnd - yStart);
      if (right + half >= 0 && right - half <= width) context.fillRect(right - half, yStart, line, yEnd - yStart);
    }
  }
}
