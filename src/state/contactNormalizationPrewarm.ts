/**
 * Prewarm only the displayed matrix level and its immediate native neighbors.
 * This matches the three-entry reader LRU and prevents an idle normalization
 * sweep from reopening every fine MCOOL index after slider preview warmed the
 * probable next level.
 */
export function contactNormalizationPrewarmResolutions(
  displayedResolution: number,
  storedResolutions: readonly number[],
  isMcool: boolean,
): number[] {
  const native = storedResolutions.filter((resolution, index) => (
    Number.isSafeInteger(resolution)
    && resolution > 0
    && storedResolutions.indexOf(resolution) === index
  ));
  const displayedIndex = native.indexOf(displayedResolution);
  const candidates = isMcool && displayedIndex >= 0
    ? [
        displayedResolution,
        native[displayedIndex - 1],
        native[displayedIndex + 1],
      ]
    : [displayedResolution];
  const seen = new Set<number>();
  return candidates.filter((resolution): resolution is number => {
    if (
      resolution === undefined
      || !Number.isSafeInteger(resolution)
      || resolution <= 0
      || seen.has(resolution)
    ) {
      return false;
    }
    seen.add(resolution);
    return true;
  });
}
