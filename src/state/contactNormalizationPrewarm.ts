/**
 * Prewarm the displayed matrix level first. Native mcool levels follow in
 * their supplied order; a plain cool file has only its displayed level.
 */
export function contactNormalizationPrewarmResolutions(
  displayedResolution: number,
  storedResolutions: readonly number[],
  isMcool: boolean,
): number[] {
  const candidates = isMcool
    ? [displayedResolution, ...storedResolutions]
    : [displayedResolution];
  const seen = new Set<number>();
  return candidates.filter((resolution) => {
    if (!Number.isSafeInteger(resolution) || resolution <= 0 || seen.has(resolution)) {
      return false;
    }
    seen.add(resolution);
    return true;
  });
}
