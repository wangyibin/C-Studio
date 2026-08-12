import type { ContactViewport } from "./contactViewport";
import { closestContactResolution } from "./contactOverviewTiles";

export const maxExactMainContactTiles = 16;
export const maxExactMainContactBinsPerPixel = 2;

export interface ContactMainLodDecisionInput {
  viewport: ContactViewport;
  selectedResolution: number;
  viewportWidthPx: number;
  viewportHeightPx: number;
  visibleTileCount: number;
}

export interface ContactMainLodPlan {
  sourceResolution: number;
  targetResolution: number;
  viewport: ContactViewport;
  binsPerPixel: number;
}

/**
 * Large navigation views are previews, so matrix work should follow screen
 * density instead of the manually selected exact pyramid level. Local views
 * stay on the AGP-aware ordinary tile path used for editing.
 */
export function shouldUseContactMainLod({
  viewport,
  selectedResolution,
  viewportWidthPx,
  viewportHeightPx,
  visibleTileCount,
}: ContactMainLodDecisionInput) {
  const safeResolution = Math.max(1, selectedResolution);
  const xBinsPerPixel = Math.max(0, viewport.xEnd - viewport.xStart)
    / safeResolution
    / Math.max(1, viewportWidthPx);
  const yBinsPerPixel = Math.max(0, viewport.yEnd - viewport.yStart)
    / safeResolution
    / Math.max(1, viewportHeightPx);
  return visibleTileCount > maxExactMainContactTiles
    || Math.max(xBinsPerPixel, yBinsPerPixel) > maxExactMainContactBinsPerPixel;
}

export function buildContactMainLodPlan(
  input: ContactMainLodDecisionInput,
  availableResolutions: readonly number[],
): ContactMainLodPlan | null {
  if (!shouldUseContactMainLod(input)) {
    return null;
  }

  const xResolution = Math.max(1, input.viewport.xEnd - input.viewport.xStart)
    / Math.max(1, input.viewportWidthPx);
  const yResolution = Math.max(1, input.viewport.yEnd - input.viewport.yStart)
    / Math.max(1, input.viewportHeightPx);
  const displayResolution = Math.max(1, Math.ceil(Math.max(xResolution, yResolution)));
  const sourceResolution = closestContactResolution(
    displayResolution,
    availableResolutions,
  );
  const targetResolution = Math.max(
    sourceResolution,
    Math.ceil(displayResolution / sourceResolution) * sourceResolution,
  );

  return {
    sourceResolution,
    targetResolution,
    viewport: input.viewport,
    binsPerPixel: Math.max(
      xResolution / input.selectedResolution,
      yResolution / input.selectedResolution,
    ),
  };
}
