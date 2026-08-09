export interface ContactRenderGeometryInput {
  resolution: number;
  viewportWidth: number;
  viewportHeight: number;
  canvasWidth: number;
  canvasHeight: number;
}

export interface ContactRenderGeometry {
  mode: "point" | "rect";
  widthPx: number;
  heightPx: number;
}

const pointModeThresholdPx = 3;
const pointSizePx = 1;

export function contactRenderGeometry({
  resolution,
  viewportWidth,
  viewportHeight,
  canvasWidth,
  canvasHeight,
}: ContactRenderGeometryInput): ContactRenderGeometry {
  const projectedWidth = Math.max(1, (resolution / Math.max(1, viewportWidth)) * canvasWidth);
  const projectedHeight = Math.max(1, (resolution / Math.max(1, viewportHeight)) * canvasHeight);
  const pointMode = projectedWidth <= pointModeThresholdPx && projectedHeight <= pointModeThresholdPx;

  return pointMode
    ? { mode: "point", widthPx: pointSizePx, heightPx: pointSizePx }
    : { mode: "rect", widthPx: projectedWidth, heightPx: projectedHeight };
}
