import { contactTilesForViewport, type ContactMapTileKey } from "./contactTiles";
import type { ContactViewport } from "./contactViewport";

const overviewTargetBins = 320;
const overviewResolutionCandidates = [
  5_000,
  10_000,
  25_000,
  50_000,
  100_000,
  200_000,
  500_000,
  1_000_000,
  2_000_000,
  5_000_000,
  10_000_000,
] as const;

export interface ContactOverviewTilePlan {
  targetResolution: number;
  viewport: ContactViewport;
  tiles: ContactMapTileKey[];
}

export interface ContactOverviewRequestReadiness {
  currentGeneration: number;
  backendStartedGeneration: number | null;
  paintedGeneration: number | null;
  completeLayerGeneration: number | null;
  documentHidden: boolean;
}

type ContactOverviewGenerationReadiness = Omit<
  ContactOverviewRequestReadiness,
  "documentHidden"
>;

export function overviewResolutionForSpan(totalSpanBp: number) {
  const safeTotalSpanBp = Math.max(1, Math.round(totalSpanBp));
  const rawResolution = Math.max(1, Math.ceil(safeTotalSpanBp / overviewTargetBins));
  return overviewResolutionCandidates.find((resolution) => resolution >= rawResolution)
    ?? overviewResolutionCandidates[overviewResolutionCandidates.length - 1];
}

export function buildContactOverviewTilePlan(
  totalSpanBp: number,
  tileSizeBins: number,
): ContactOverviewTilePlan {
  const safeTotalSpanBp = Math.max(1, Math.round(totalSpanBp));
  const targetResolution = overviewResolutionForSpan(safeTotalSpanBp);
  const viewport = {
    xStart: 0,
    xEnd: safeTotalSpanBp,
    yStart: 0,
    yEnd: safeTotalSpanBp,
  };

  return {
    targetResolution,
    viewport,
    tiles: contactTilesForViewport(
      viewport,
      targetResolution,
      tileSizeBins,
      safeTotalSpanBp,
    ),
  };
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
