import type { ContactNormalization } from "./uiState";

export const contactNormalizationModes: readonly ContactNormalization[] = Object.freeze([
  "raw",
  "ice",
  "kr",
  "vc",
  "vc_sqrt",
]);
export const contactNormalizationVectorBytesPerBin = Float64Array.BYTES_PER_ELEMENT;
export const contactNormalizationVectorPrewarmBudgetBytes = 16 * 1024 * 1024;

/**
 * Normalization switching and resolution switching are independent user
 * intents. Warm only the displayed stored level here; the resolution-prefetch
 * scheduler already owns neighboring levels and must not multiply this work.
 */
export function contactNormalizationPrewarmResolutions(
  displayedResolution: number,
  _storedResolutions: readonly number[],
  _isMcool: boolean,
): number[] {
  return Number.isSafeInteger(displayedResolution) && displayedResolution > 0
    ? [displayedResolution]
    : [];
}

/** Most-recent normalization first, with bounded stable deduplication. */
export function retainContactNormalizationHistory(
  history: readonly ContactNormalization[],
  normalization: ContactNormalization,
  limit = contactNormalizationModes.length,
): ContactNormalization[] {
  const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : 1;
  return [
    normalization,
    ...history.filter((candidate) => candidate !== normalization),
  ].slice(0, safeLimit);
}

export interface ContactNormalizationWeightPrewarmPlan {
  estimatedBytesPerVector: number;
  estimatedBytes: number;
  normalizations: ContactNormalization[];
  resolution: number;
}

export function contactNormalizationBackgroundWorkBlocked({
  mainLodFlights,
  normalizationPrewarmActive,
  resolutionReaderPrewarmActive,
  tileFlights,
}: {
  mainLodFlights: number;
  normalizationPrewarmActive: boolean;
  resolutionReaderPrewarmActive: boolean;
  tileFlights: number;
}) {
  return tileFlights > 0
    || mainLodFlights > 0
    || normalizationPrewarmActive
    || resolutionReaderPrewarmActive;
}

/**
 * Select alternative stored normalization vectors under one combined byte
 * budget. The active method is already demanded by the visible request; Raw
 * has no weight vector. Recent alternatives are prepared before cold ones.
 */
export function buildContactNormalizationWeightPrewarmPlan({
  activeNormalization,
  history,
  resolution,
  totalSpanBp,
  budgetBytes = contactNormalizationVectorPrewarmBudgetBytes,
}: {
  activeNormalization: ContactNormalization;
  history: readonly ContactNormalization[];
  resolution: number;
  totalSpanBp: number;
  budgetBytes?: number;
}): ContactNormalizationWeightPrewarmPlan {
  const valid = [resolution, totalSpanBp, budgetBytes].every(
    (value) => Number.isSafeInteger(value) && value > 0,
  );
  if (!valid) {
    return {
      estimatedBytesPerVector: 0,
      estimatedBytes: 0,
      normalizations: [],
      resolution,
    };
  }
  const binCount = Math.ceil(totalSpanBp / resolution);
  const estimatedBytesPerVector = binCount * contactNormalizationVectorBytesPerBin;
  if (
    !Number.isSafeInteger(estimatedBytesPerVector)
    || estimatedBytesPerVector > budgetBytes
  ) {
    return {
      estimatedBytesPerVector,
      estimatedBytes: 0,
      normalizations: [],
      resolution,
    };
  }
  const ordered = [...history, ...contactNormalizationModes];
  const seen = new Set<ContactNormalization>();
  const normalizations: ContactNormalization[] = [];
  let estimatedBytes = 0;
  for (const normalization of ordered) {
    if (
      normalization === "raw"
      || normalization === activeNormalization
      || seen.has(normalization)
    ) {
      continue;
    }
    seen.add(normalization);
    if (estimatedBytes + estimatedBytesPerVector > budgetBytes) {
      break;
    }
    normalizations.push(normalization);
    estimatedBytes += estimatedBytesPerVector;
  }
  return {
    estimatedBytesPerVector,
    estimatedBytes,
    normalizations,
    resolution,
  };
}
