import type { ContactViewport } from "./contactViewport";
import { contactResolutionAtOrAbove } from "./contactOverviewTiles";

export const maxExactMainContactTiles = 16;
export const maxExactMainContactBinsPerPixel = 2;
/** Fixed genomic grid for reusable screen-scale LOD tiles. */
export const contactMainLodTileSizeBins = 256;
/** Keep foreground chunks small so the center of a cold LOD view arrives first. */
export const contactMainLodVisibleBatchSize = 2;
export const contactMainLodPrefetchBatchSize = 4;
export const maxContactMainLodPrefetchTiles = 8;
/**
 * Coarse navigation data must not evict exact editing tiles. These limits are
 * therefore enforced by a dedicated LRU owned by the main LOD layer.
 */
export const contactMainLodTileCacheLimits = Object.freeze({
  maxScopes: 4,
  maxTiles: 64,
  maxCells: 1_500_000,
});
// Adaptive 2.5 Mb refinement can descend to 1 kb around AGP boundaries. Keep
// that expensive path inside one local 2x2 tile neighborhood; wider exact
// views use the native stored level without recursive refinement.
export const maxAdaptiveMcoolExactTiles = 4;

/**
 * Source-resolution LOD work is one complete HDF5 scan even when its response
 * is presented as several center-first chunks. Keep the visible request whole
 * so slower Windows storage and WebView2 pay for one scan and one IPC decode.
 */
export function combineContactMainLodVisibleBatches<T>(
  batches: readonly (readonly T[])[],
): T[] {
  return batches.flatMap((batch) => batch);
}

export interface ContactMainLodDecisionInput {
  viewport: ContactViewport;
  selectedResolution: number;
  viewportWidthPx: number;
  viewportHeightPx: number;
  visibleTileCount: number;
  exactTileLimit?: number;
}

export interface ContactMainLodPlan {
  sourceResolution: number;
  targetResolution: number;
  viewport: ContactViewport;
  binsPerPixel: number;
}

/** A same-resolution plan would only move identical tiles into a cold LOD cache. */
export function contactMainLodPlanChangesSampling(
  plan: ContactMainLodPlan | null,
  selectedResolution: number,
) {
  return Boolean(
    plan
    && (
      plan.sourceResolution !== selectedResolution
      || plan.targetResolution !== selectedResolution
    ),
  );
}

/**
 * Large navigation views are terminal screen-density renders instead of an
 * invitation to load every exact tile. Local views stay on the AGP-aware
 * ordinary tile path used for editing.
 */
export function shouldUseContactMainLod({
  viewport,
  selectedResolution,
  viewportWidthPx,
  viewportHeightPx,
  visibleTileCount,
  exactTileLimit = maxExactMainContactTiles,
}: ContactMainLodDecisionInput) {
  const safeResolution = Math.max(1, selectedResolution);
  const xBinsPerPixel = Math.max(0, viewport.xEnd - viewport.xStart)
    / safeResolution
    / Math.max(1, viewportWidthPx);
  const yBinsPerPixel = Math.max(0, viewport.yEnd - viewport.yStart)
    / safeResolution
    / Math.max(1, viewportHeightPx);
  return visibleTileCount > Math.max(0, exactTileLimit)
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
  const sourceResolution = contactResolutionAtOrAbove(
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
