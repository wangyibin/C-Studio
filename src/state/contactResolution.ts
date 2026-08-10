import type { ContactResolution } from "./uiState";

/**
 * Cooler resolutions are ordered from coarsest to finest, matching the control.
 * Juicebox selects the finest level whose bin is still at least one screen pixel.
 */
export const contactResolutionLevels: readonly ContactResolution[] = [
  "2.5 Mb",
  "2 Mb",
  "1 Mb",
  "500 kb",
  "250 kb",
  "100 kb",
  "50 kb",
  "25 kb",
  "10 kb",
  "5 kb",
];

export const maxContactPixelSize = 128;
export const defaultContactBinSizePx = 1;

export function contactResolutionToBasePairs(resolution: ContactResolution) {
  const [amount, unit] = resolution.split(" ");
  const value = Number(amount);

  return unit === "Mb" ? value * 1_000_000 : value * 1_000;
}

export function chooseContactResolutionForBpPerPixel(bpPerPixel: number): ContactResolution {
  const target = Number.isFinite(bpPerPixel) ? Math.max(0, bpPerPixel) : Infinity;

  for (let index = contactResolutionLevels.length - 1; index >= 0; index -= 1) {
    const resolution = contactResolutionLevels[index];
    if (resolution && contactResolutionToBasePairs(resolution) >= target) {
      return resolution;
    }
  }

  return contactResolutionLevels[0];
}

/**
 * Compatibility wrapper for callers/tests that reason in genomic span. New view
 * state code should pass its measured viewport size explicitly or use
 * chooseContactResolutionForBpPerPixel directly.
 */
export function chooseContactResolutionForSpan(
  viewportSpanMb: number,
  viewportSizePx = 200,
): ContactResolution {
  const safeViewportSizePx = sanitizeViewportSizePx(viewportSizePx);
  const spanBp = Number.isFinite(viewportSpanMb)
    ? Math.max(0, viewportSpanMb) * 1_000_000
    : Infinity;

  return chooseContactResolutionForBpPerPixel(spanBp / safeViewportSizePx);
}

/**
 * Select the finest available bin that can still cover the fitted viewport
 * without making a bin smaller than the default one-CSS-pixel point.
 */
export function wholeGenomeContactResolutionForViewport(
  wholeGenomeViewportSpanMb: number,
  viewportSizePx: number,
): ContactResolution {
  const bpPerPixel = (
    sanitizeTotalSpanMb(wholeGenomeViewportSpanMb) * 1_000_000
  ) / sanitizeViewportSizePx(viewportSizePx);

  return chooseContactResolutionForBpPerPixel(bpPerPixel * defaultContactBinSizePx);
}

/**
 * Coarser bins than the fitted whole-genome level only enlarge the same full
 * view. Excluding that plateau leaves one whole-map level followed by true
 * zoom levels, while preserving the dataset's resolution order.
 */
export function contactResolutionLevelsForViewport(
  wholeGenomeViewportSpanMb: number,
  viewportSizePx: number,
): readonly ContactResolution[] {
  const wholeGenomeResolution = wholeGenomeContactResolutionForViewport(
    wholeGenomeViewportSpanMb,
    viewportSizePx,
  );
  const firstResolutionIndex = contactResolutionLevels.indexOf(wholeGenomeResolution);

  return firstResolutionIndex < 0
    ? contactResolutionLevels
    : contactResolutionLevels.slice(firstResolutionIndex);
}

export function clampContactResolutionToViewport(
  resolution: ContactResolution,
  wholeGenomeViewportSpanMb: number,
  viewportSizePx: number,
): ContactResolution {
  const levels = contactResolutionLevelsForViewport(
    wholeGenomeViewportSpanMb,
    viewportSizePx,
  );

  return levels.includes(resolution) ? resolution : levels[0] ?? resolution;
}

export function contactWholeGenomeViewportSpanMb(
  totalSpanMb: number,
  _viewportWidthPx: number,
  _viewportHeightPx: number,
) {
  // The heatmap itself is a square. Fitting the whole genome therefore means
  // placing that square on the viewport's shorter side and leaving any surplus
  // on the longer side empty; cropping one axis to fill a rectangle would no
  // longer be a whole-map view.
  return sanitizeTotalSpanMb(totalSpanMb);
}

/**
 * Juicebox-style default geometry: each matrix bin is approximately one CSS
 * pixel. The fitted level is capped by the complete heatmap span; every finer
 * level therefore shrinks the genomic window while retaining the same point
 * size on screen.
 *
 * `wholeGenomeViewportSpanMb` is the fitted span along the viewport's shorter
 * axis. For a rectangular viewport callers should derive it from both canvas
 * dimensions before calling this helper.
 */
export function contactViewportSpanForResolution(
  resolution: ContactResolution,
  viewportSizePx: number,
  wholeGenomeViewportSpanMb: number,
) {
  const safeWholeGenomeSpanMb = sanitizeTotalSpanMb(wholeGenomeViewportSpanMb);
  const wholeGenomeResolution = wholeGenomeContactResolutionForViewport(
    safeWholeGenomeSpanMb,
    viewportSizePx,
  );
  if (resolution === wholeGenomeResolution) {
    return safeWholeGenomeSpanMb;
  }

  const binSizeMb = contactResolutionToBasePairs(resolution) / 1_000_000;
  const onePointPerBinSpanMb = (
    sanitizeViewportSizePx(viewportSizePx) * binSizeMb
  ) / defaultContactBinSizePx;

  return Math.min(safeWholeGenomeSpanMb, onePointPerBinSpanMb);
}

export function minimumContactViewportSpanMb(
  resolution: ContactResolution,
  viewportSizePx: number,
) {
  const binSizeMb = contactResolutionToBasePairs(resolution) / 1_000_000;

  return Math.max(0.000001, (sanitizeViewportSizePx(viewportSizePx) * binSizeMb) / maxContactPixelSize);
}

function sanitizeViewportSizePx(viewportSizePx: number) {
  return Number.isFinite(viewportSizePx) ? Math.max(1, viewportSizePx) : 1;
}

function sanitizeTotalSpanMb(totalSpanMb: number) {
  return Number.isFinite(totalSpanMb) ? Math.max(0.000001, totalSpanMb) : 0.000001;
}
