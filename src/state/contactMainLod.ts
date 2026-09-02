import type { ContactViewport } from "./contactViewport";
import { contactResolutionAtOrAbove } from "./contactOverviewTiles";
import { contactNormalizationModes } from "./contactNormalizationPrewarm";
import type { ContactMapTileKey } from "./contactTiles";
import type { ContactNormalization } from "./uiState";

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
  maxScopes: 5,
  maxTiles: 96,
  maxCells: 6_000_000,
  maxBytes: 32 * 1024 * 1024,
});
/**
 * Whole-level residency is reserved for genuinely small interaction LODs. The
 * GPU byte cap is deliberately below the atlas and frontend cache budgets so
 * the current exact layer, overview, page table, and staging frame still have
 * headroom. Finer levels keep using viewport + directional-corridor streaming.
 */
export const contactMainLodWholeResidencyBudgetBytes = 16 * 1024 * 1024;
export const contactMainLodR16fBytesPerTexel = 2;
export const contactMainLodWholeResidencyMaxTiles = 64;
export const contactMainLodWholeResidencyMaxCells = 1_500_000;
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

export interface ContactMainLodWholeResidencyPlan {
  axisTileCount: number;
  estimatedBytes: number;
  estimatedCells: number;
  tiles: ContactMapTileKey[];
}

export interface ContactMainLodNormalizationResidencyPlan {
  estimatedBytes: number;
  estimatedCells: number;
  normalizations: ContactNormalization[];
  tileCount: number;
}

/**
 * Return the complete canonical upper-triangle tile set only when its dense
 * R16F representation also fits every dedicated main-LOD cache safety valve.
 * A null result is the explicit signal to stay on bounded viewport streaming.
 */
export function buildContactMainLodWholeResidencyPlan({
  totalSpanBp,
  resolution,
  tileSizeBins = contactMainLodTileSizeBins,
  bytesPerTexel = contactMainLodR16fBytesPerTexel,
  budgetBytes = contactMainLodWholeResidencyBudgetBytes,
  maxTiles = contactMainLodWholeResidencyMaxTiles,
  maxCells = contactMainLodWholeResidencyMaxCells,
}: {
  totalSpanBp: number;
  resolution: number;
  tileSizeBins?: number;
  bytesPerTexel?: number;
  budgetBytes?: number;
  maxTiles?: number;
  maxCells?: number;
}): ContactMainLodWholeResidencyPlan | null {
  const values = [
    totalSpanBp,
    resolution,
    tileSizeBins,
    bytesPerTexel,
    budgetBytes,
    maxTiles,
    maxCells,
  ];
  if (values.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    return null;
  }

  const tileSpanBp = resolution * tileSizeBins;
  if (!Number.isSafeInteger(tileSpanBp)) {
    return null;
  }
  const axisTileCount = Math.ceil(totalSpanBp / tileSpanBp);
  const tileCount = axisTileCount * (axisTileCount + 1) / 2;
  const cellsPerTile = tileSizeBins * tileSizeBins;
  const estimatedCells = tileCount * cellsPerTile;
  const estimatedBytes = estimatedCells * bytesPerTexel;
  if (
    !Number.isSafeInteger(tileCount)
    || !Number.isSafeInteger(cellsPerTile)
    || !Number.isSafeInteger(estimatedCells)
    || !Number.isSafeInteger(estimatedBytes)
    || tileCount > maxTiles
    || estimatedCells > maxCells
    || estimatedBytes > budgetBytes
  ) {
    return null;
  }

  const tiles: ContactMapTileKey[] = [];
  for (let tileY = 0; tileY < axisTileCount; tileY += 1) {
    for (let tileX = 0; tileX <= tileY; tileX += 1) {
      tiles.push({ tileX, tileY });
    }
  }
  return {
    axisTileCount,
    estimatedBytes,
    estimatedCells,
    tiles,
  };
}

/**
 * Fit complete coarse display variants into one shared CPU/GPU budget. The
 * active normalization is first, the most recently used alternatives follow,
 * and cold modes are admitted only while every cache safety valve still fits.
 */
export function buildContactMainLodNormalizationResidencyPlan({
  activeNormalization,
  availableNormalizations,
  history,
  wholeResidencyPlan,
  budgetBytes = contactMainLodWholeResidencyBudgetBytes,
  maxTiles = contactMainLodTileCacheLimits.maxTiles,
  maxCells = contactMainLodTileCacheLimits.maxCells,
}: {
  activeNormalization: ContactNormalization;
  availableNormalizations: readonly ContactNormalization[];
  history: readonly ContactNormalization[];
  wholeResidencyPlan: ContactMainLodWholeResidencyPlan;
  budgetBytes?: number;
  maxTiles?: number;
  maxCells?: number;
}): ContactMainLodNormalizationResidencyPlan {
  const available = new Set<ContactNormalization>([
    activeNormalization,
    ...availableNormalizations,
  ]);
  const ordered = [
    activeNormalization,
    ...history,
    ...contactNormalizationModes,
  ];
  const normalizations: ContactNormalization[] = [];
  const seen = new Set<ContactNormalization>();
  const tileCountPerNormalization = wholeResidencyPlan.tiles.length;
  for (const normalization of ordered) {
    if (seen.has(normalization) || !available.has(normalization)) {
      continue;
    }
    seen.add(normalization);
    const variantCount = normalizations.length + 1;
    if (
      variantCount * wholeResidencyPlan.estimatedBytes > budgetBytes
      || variantCount * wholeResidencyPlan.estimatedCells > maxCells
      || variantCount * tileCountPerNormalization > maxTiles
    ) {
      break;
    }
    normalizations.push(normalization);
  }
  return {
    estimatedBytes: normalizations.length * wholeResidencyPlan.estimatedBytes,
    estimatedCells: normalizations.length * wholeResidencyPlan.estimatedCells,
    normalizations,
    tileCount: normalizations.length * tileCountPerNormalization,
  };
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
