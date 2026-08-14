import type { ContactMapView } from "../App";
import type { ContactViewport } from "./contactViewport";

export const overviewTargetBins = 320;
const fallbackCoolResolution = 1_000;

export interface ContactOverviewTilePlan {
  sourceResolution: number;
  targetResolution: number;
  targetBins: number;
  viewport: ContactViewport;
}

export interface ContactOverviewRequestReadiness {
  currentGeneration: number;
  backendStartedGeneration: number | null;
  paintedGeneration: number | null;
  completeLayerGeneration: number | null;
  documentHidden: boolean;
}

/**
 * Reuse an already complete screen-scale layer as the inspector overview when
 * it covers the assembly. The square viewport prevents a rectangular main
 * canvas from inflating the overview's coordinate span and, crucially, avoids
 * a second full scan of a single-resolution `.cool` file.
 */
export function wholeAssemblyOverviewFromCoveringMap(
  map: ContactMapView,
  totalSpanBp: number,
): ContactMapView | null {
  const span = Math.max(1, Math.round(totalSpanBp));
  if (
    map.viewport.xStart > 0
    || map.viewport.yStart > 0
    || map.viewport.xEnd < span
    || map.viewport.yEnd < span
  ) {
    return null;
  }
  if (
    map.viewport.xStart === 0
    && map.viewport.xEnd === span
    && map.viewport.yStart === 0
    && map.viewport.yEnd === span
  ) {
    return map;
  }
  return {
    ...map,
    viewport: {
      xStart: 0,
      xEnd: span,
      yStart: 0,
      yEnd: span,
    },
  };
}

type ContactOverviewGenerationReadiness = Omit<
  ContactOverviewRequestReadiness,
  "documentHidden"
>;

export function overviewResolutionForSpan(
  totalSpanBp: number,
  availableResolutions: readonly number[] = [fallbackCoolResolution],
) {
  const safeTotalSpanBp = Math.max(1, Math.round(totalSpanBp));
  const rawResolution = Math.max(1, Math.ceil(safeTotalSpanBp / overviewTargetBins));
  const sourceResolution = closestContactResolution(rawResolution, availableResolutions);
  return Math.max(
    sourceResolution,
    Math.ceil(rawResolution / sourceResolution) * sourceResolution,
  );
}

export function buildContactOverviewTilePlan(
  totalSpanBp: number,
  availableResolutions: readonly number[] = [fallbackCoolResolution],
): ContactOverviewTilePlan {
  const safeTotalSpanBp = Math.max(1, Math.round(totalSpanBp));
  const sourceResolution = closestContactResolution(
    Math.max(1, Math.ceil(safeTotalSpanBp / overviewTargetBins)),
    availableResolutions,
  );
  const targetResolution = overviewResolutionForSpan(
    safeTotalSpanBp,
    availableResolutions,
  );
  const viewport = {
    xStart: 0,
    xEnd: safeTotalSpanBp,
    yStart: 0,
    yEnd: safeTotalSpanBp,
  };

  return {
    sourceResolution,
    targetResolution,
    targetBins: overviewTargetBins,
    viewport,
  };
}

/**
 * Use the stored matrix level nearest to one overview pixel. The overview
 * command may aggregate that level further, but never falls back to the
 * finest `.mcool` level merely because the exact display resolution is absent.
 */
export function closestContactResolution(
  targetResolution: number,
  availableResolutions: readonly number[],
) {
  const target = Number.isFinite(targetResolution)
    ? Math.max(1, Math.round(targetResolution))
    : 1;
  const available = [...new Set(
    availableResolutions
      .filter((resolution) => Number.isFinite(resolution) && resolution > 0)
      .map((resolution) => Math.round(resolution)),
  )];
  if (available.length === 0) {
    return fallbackCoolResolution;
  }

  return available.reduce((closest, resolution) => {
    const distance = Math.abs(resolution - target);
    const closestDistance = Math.abs(closest - target);
    return distance < closestDistance
      || (distance === closestDistance && resolution > closest)
      ? resolution
      : closest;
  });
}

/**
 * Overview work is strictly subordinate to the visible layer. In particular,
 * a frontend cache hit may paint before the backend generation-begin command
 * resolves, so both milestones are required instead of relying on idle timing.
 */
export function contactOverviewGenerationIsReady({
  currentGeneration,
  backendStartedGeneration,
  paintedGeneration,
  completeLayerGeneration,
}: ContactOverviewGenerationReadiness) {
  return backendStartedGeneration === currentGeneration
    && paintedGeneration === currentGeneration
    && completeLayerGeneration === currentGeneration;
}

export function contactOverviewRequestIsReady(readiness: ContactOverviewRequestReadiness) {
  return contactOverviewGenerationIsReady(readiness)
    && !readiness.documentHidden;
}

/**
 * A failed spatial-prefetch batch must not strand the lower-priority pipeline
 * once the visible layer is already complete. Adjacent prefetch owns its own
 * opportunistic error handling and eventually settles the overview gate.
 */
export function shouldResumeContactBackgroundSchedulingAfterFailure(
  visibleLayerComplete: boolean,
) {
  return visibleLayerComplete;
}
