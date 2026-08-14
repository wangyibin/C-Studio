import type { ContactViewport } from "./contactViewport";

const wheelLinePixels = 16;
const wheelDeltaLineMode = 1;
const wheelDeltaPageMode = 2;

interface ContactWheelPanInput {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  panMode?: ContactWheelPanMode;
  bounds: {
    width: number;
    height: number;
  };
  viewport: ContactViewport;
}

export interface ContactWheelPanIntent {
  deltaXPx: number;
  deltaYPx: number;
  deltaXMb: number;
  deltaYMb: number;
}

interface ContactWheelModifierInput {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export type ContactWheelNavigationMode = "pan" | "resolution";
export type ContactWheelPanMode = "natural" | "horizontal" | "diagonal" | "vertical";

/** Shift reserves a modified wheel gesture for panning instead of resolution changes. */
export function contactWheelNavigationMode({
  ctrlKey,
  metaKey,
  shiftKey,
}: ContactWheelModifierInput): ContactWheelNavigationMode {
  return (ctrlKey || metaKey) && !shiftKey ? "resolution" : "pan";
}

/** Map heatmap wheel modifiers without changing the Command/Ctrl resolution gesture. */
export function contactWheelPanMode({
  ctrlKey,
  metaKey,
  shiftKey,
}: ContactWheelModifierInput): ContactWheelPanMode {
  const commandKey = ctrlKey || metaKey;
  if (commandKey && shiftKey) {
    return "vertical";
  }
  if (shiftKey) {
    return "horizontal";
  }
  return commandKey ? "natural" : "diagonal";
}

/** Shared Contact Map / Dotplot wheel-to-viewport pan normalization. */
export function contactWheelPanIntent({
  deltaX,
  deltaY,
  deltaMode,
  panMode = "natural",
  bounds,
  viewport,
}: ContactWheelPanInput): ContactWheelPanIntent | null {
  if (
    !Number.isFinite(bounds.width)
    || !Number.isFinite(bounds.height)
    || bounds.width <= 0
    || bounds.height <= 0
  ) {
    return null;
  }

  const rawDeltaX = Number.isFinite(deltaX) ? deltaX : 0;
  const rawDeltaY = Number.isFinite(deltaY) ? deltaY : 0;
  const primaryDelta = Math.abs(rawDeltaY) >= Math.abs(rawDeltaX)
    ? rawDeltaY
    : rawDeltaX;
  const mappedDeltaX = panMode === "diagonal"
    ? primaryDelta
    : panMode === "vertical"
      ? 0
      : panMode === "horizontal"
        ? (rawDeltaX !== 0 ? rawDeltaX : rawDeltaY)
        : rawDeltaX;
  const mappedDeltaY = panMode === "diagonal" || panMode === "vertical"
    ? primaryDelta
    : panMode === "horizontal"
      ? 0
      : rawDeltaY;
  const deltaScaleX = deltaMode === wheelDeltaLineMode
    ? wheelLinePixels
    : deltaMode === wheelDeltaPageMode
      ? bounds.width
      : 1;
  const deltaScaleY = deltaMode === wheelDeltaLineMode
    ? wheelLinePixels
    : deltaMode === wheelDeltaPageMode
      ? bounds.height
      : 1;
  const deltaXPx = mappedDeltaX * deltaScaleX;
  const deltaYPx = mappedDeltaY * deltaScaleY;
  if (deltaXPx === 0 && deltaYPx === 0) {
    return null;
  }

  const viewportWidthMb = (viewport.xEnd - viewport.xStart) / 1_000_000;
  const viewportHeightMb = (viewport.yEnd - viewport.yStart) / 1_000_000;
  if (
    !Number.isFinite(viewportWidthMb)
    || !Number.isFinite(viewportHeightMb)
    || viewportWidthMb <= 0
    || viewportHeightMb <= 0
  ) {
    return null;
  }

  return {
    deltaXPx,
    deltaYPx,
    deltaXMb: (deltaXPx / bounds.width) * viewportWidthMb,
    deltaYMb: (deltaYPx / bounds.height) * viewportHeightMb,
  };
}
