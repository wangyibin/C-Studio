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
 * Juicebox's manual resolution selector resets pixels-per-bin to
 * max(1, minPixelSize). For the square whole-assembly view this reduces to the
 * selected bin span at one pixel per bin, capped by the loaded assembly span.
 */
export function contactViewportSpanForResolution(
  resolution: ContactResolution,
  viewportSizePx: number,
  totalSpanMb: number,
) {
  const safeTotalSpanMb = sanitizeTotalSpanMb(totalSpanMb);
  const binSizeMb = contactResolutionToBasePairs(resolution) / 1_000_000;

  return Math.min(safeTotalSpanMb, sanitizeViewportSizePx(viewportSizePx) * binSizeMb);
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
