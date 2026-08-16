export interface ContactViewport {
  xStart: number;
  xEnd: number;
  yStart: number;
  yEnd: number;
}

interface CenteredViewportInput {
  centerMb: number;
  centerXMb?: number;
  centerYMb?: number;
  totalSpanBp: number;
  windowSizeBp?: number;
  viewportWidthPx?: number;
  viewportHeightPx?: number;
}

export interface ContactViewportAxisSpans {
  xSpanBp: number;
  ySpanBp: number;
}

export interface ContactViewportVelocity {
  xBpPerMs: number;
  yBpPerMs: number;
}

export interface ContactViewportVelocitySample extends ContactViewportVelocity {
  viewport: ContactViewport;
  sampledAt: number;
}

const defaultWindowSizeBp = 200_000_000;
const minimumVelocityLeadTiles = 0.5;
const maximumVelocityLeadTiles = 1.5;
const maximumLeadVelocityTilesPerSecond = 4;
const minimumDirectionalVelocityTilesPerSecond = 0.05;
const minimumVelocitySampleIntervalMs = 4;
const maximumVelocitySampleIntervalMs = 250;

export function buildCenteredContactViewport({
  centerMb,
  centerXMb = centerMb,
  centerYMb = centerMb,
  totalSpanBp,
  windowSizeBp = defaultWindowSizeBp,
  viewportWidthPx = 1,
  viewportHeightPx = 1,
}: CenteredViewportInput): ContactViewport {
  const safeTotalSpan = Math.max(1, totalSpanBp);
  const { xSpanBp, ySpanBp } = contactViewportAxisSpans(
    safeTotalSpan,
    windowSizeBp,
    viewportWidthPx,
    viewportHeightPx,
  );
  const maxXStart = Math.max(0, safeTotalSpan - xSpanBp);
  const maxYStart = Math.max(0, safeTotalSpan - ySpanBp);
  const centerXBp = clamp(centerXMb * 1_000_000, 0, safeTotalSpan);
  const centerYBp = clamp(centerYMb * 1_000_000, 0, safeTotalSpan);
  const xStart = Math.round(clamp(centerXBp - xSpanBp / 2, 0, maxXStart));
  const yStart = Math.round(clamp(centerYBp - ySpanBp / 2, 0, maxYStart));

  return {
    xStart,
    xEnd: Math.round(xStart + xSpanBp),
    yStart,
    yEnd: Math.round(yStart + ySpanBp),
  };
}

/**
 * Keep one genomic scale on both screen axes. The shorter pixel axis uses the
 * requested span; the longer axis shows proportionally more sequence. The
 * spans may extend beyond the genome so resizing the screen never changes the
 * genomic scale. Callers render the uncovered area as empty canvas.
 */
export function contactViewportAxisSpans(
  totalSpanBp: number,
  windowSizeBp: number,
  viewportWidthPx: number,
  viewportHeightPx: number,
): ContactViewportAxisSpans {
  const safeTotalSpan = Number.isFinite(totalSpanBp) ? Math.max(1, totalSpanBp) : 1;
  const safeWindowSize = Number.isFinite(windowSizeBp)
    ? Math.max(1, windowSizeBp)
    : safeTotalSpan;
  const safeWidthPx = Number.isFinite(viewportWidthPx) ? Math.max(1, viewportWidthPx) : 1;
  const safeHeightPx = Number.isFinite(viewportHeightPx) ? Math.max(1, viewportHeightPx) : 1;
  const shortestSidePx = Math.min(safeWidthPx, safeHeightPx);
  const rawXSpan = safeWindowSize * (safeWidthPx / shortestSidePx);
  const rawYSpan = safeWindowSize * (safeHeightPx / shortestSidePx);

  return {
    xSpanBp: Math.max(1, Math.round(rawXSpan)),
    ySpanBp: Math.max(1, Math.round(rawYSpan)),
  };
}

export function buildWholeGenomeContactViewport(totalSpanBp: number): ContactViewport {
  const safeTotalSpan = Math.max(1, Math.round(totalSpanBp));

  return {
    xStart: 0,
    xEnd: safeTotalSpan,
    yStart: 0,
    yEnd: safeTotalSpan,
  };
}

/**
 * Shift a transient pan viewport toward its current motion so the next tile
 * edge can be requested before it becomes visible. The displayed viewport is
 * unchanged; this viewport is only a prefetch hint.
 */
export function contactViewportWithDirectionalLead(
  source: ContactViewport,
  target: ContactViewport,
  leadBp: number,
  totalSpanBp: number,
): ContactViewport {
  const safeLead = Number.isFinite(leadBp) ? Math.max(0, leadBp) : 0;
  const safeTotalSpan = Number.isFinite(totalSpanBp) ? Math.max(1, totalSpanBp) : 1;
  const direction = (sourceStart: number, sourceEnd: number, targetStart: number, targetEnd: number) => (
    Math.sign((targetStart + targetEnd) - (sourceStart + sourceEnd))
  );
  const shiftAxis = (start: number, end: number, axisDirection: number) => {
    const span = Math.max(1, end - start);
    const maxStart = Math.max(0, safeTotalSpan - span);
    const nextStart = clamp(start + axisDirection * safeLead, 0, maxStart);
    return [nextStart, nextStart + span] as const;
  };
  const [xStart, xEnd] = shiftAxis(
    target.xStart,
    target.xEnd,
    direction(source.xStart, source.xEnd, target.xStart, target.xEnd),
  );
  const [yStart, yEnd] = shiftAxis(
    target.yStart,
    target.yEnd,
    direction(source.yStart, source.yEnd, target.yStart, target.yEnd),
  );

  return { xStart, xEnd, yStart, yEnd };
}

/**
 * Build a data-only look-ahead viewport from current pan velocity. Slow motion
 * retains the existing half-tile lead while fast motion grows smoothly to one
 * and a half tiles. The displayed viewport is never changed by this hint.
 */
export function contactViewportWithVelocityAwareLead(
  source: ContactViewport,
  target: ContactViewport,
  tileSpanBp: number,
  velocity: ContactViewportVelocity,
  totalSpanBp: number,
): ContactViewport {
  const safeTileSpan = Number.isFinite(tileSpanBp) ? Math.max(0, tileSpanBp) : 0;
  if (safeTileSpan === 0) {
    return target;
  }
  const safeTotalSpan = Number.isFinite(totalSpanBp) ? Math.max(1, totalSpanBp) : 1;
  const shiftAxis = (
    sourceStart: number,
    sourceEnd: number,
    targetStart: number,
    targetEnd: number,
    rawVelocityBpPerMs: number,
  ) => {
    const velocityBpPerMs = Number.isFinite(rawVelocityBpPerMs) ? rawVelocityBpPerMs : 0;
    const velocityTilesPerSecond = (velocityBpPerMs * 1_000) / safeTileSpan;
    const fallbackDirection = Math.sign(
      (targetStart + targetEnd) - (sourceStart + sourceEnd),
    );
    const direction = Math.abs(velocityTilesPerSecond)
      >= minimumDirectionalVelocityTilesPerSecond
      ? Math.sign(velocityTilesPerSecond)
      : fallbackDirection;
    if (direction === 0) {
      return [targetStart, targetEnd] as const;
    }
    const velocityRatio = Math.min(
      1,
      Math.abs(velocityTilesPerSecond) / maximumLeadVelocityTilesPerSecond,
    );
    const leadTiles = minimumVelocityLeadTiles
      + velocityRatio * (maximumVelocityLeadTiles - minimumVelocityLeadTiles);
    const span = Math.max(1, targetEnd - targetStart);
    const maxStart = Math.max(0, safeTotalSpan - span);
    const nextStart = clamp(targetStart + direction * safeTileSpan * leadTiles, 0, maxStart);
    return [nextStart, nextStart + span] as const;
  };
  const [xStart, xEnd] = shiftAxis(
    source.xStart,
    source.xEnd,
    target.xStart,
    target.xEnd,
    velocity.xBpPerMs,
  );
  const [yStart, yEnd] = shiftAxis(
    source.yStart,
    source.yEnd,
    target.yStart,
    target.yEnd,
    velocity.yBpPerMs,
  );
  return { xStart, xEnd, yStart, yEnd };
}

/** Coalesce noisy pointer samples into a stable genomic pan velocity. */
export function sampleContactViewportVelocity(
  previous: ContactViewportVelocitySample | null,
  viewport: ContactViewport,
  sampledAt: number,
): ContactViewportVelocitySample {
  const safeSampledAt = Number.isFinite(sampledAt) ? sampledAt : 0;
  if (!previous) {
    return { viewport, sampledAt: safeSampledAt, xBpPerMs: 0, yBpPerMs: 0 };
  }
  const elapsedMs = safeSampledAt - previous.sampledAt;
  if (elapsedMs > 0 && elapsedMs < minimumVelocitySampleIntervalMs) {
    return previous;
  }
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0 || elapsedMs > maximumVelocitySampleIntervalMs) {
    return { viewport, sampledAt: safeSampledAt, xBpPerMs: 0, yBpPerMs: 0 };
  }
  const instantaneousX = (viewport.xStart - previous.viewport.xStart) / elapsedMs;
  const instantaneousY = (viewport.yStart - previous.viewport.yStart) / elapsedMs;
  const smoothAxis = (current: number, instantaneous: number) => {
    if (!Number.isFinite(instantaneous)) {
      return current;
    }
    // A real reversal must change the prefetch side immediately. Otherwise an
    // exponential moving average prevents one noisy pointer sample from
    // expanding or shrinking the requested tile set.
    if (current === 0 || Math.sign(current) !== Math.sign(instantaneous)) {
      return instantaneous;
    }
    return current * 0.6 + instantaneous * 0.4;
  };
  return {
    viewport,
    sampledAt: safeSampledAt,
    xBpPerMs: smoothAxis(previous.xBpPerMs, instantaneousX),
    yBpPerMs: smoothAxis(previous.yBpPerMs, instantaneousY),
  };
}

export function horizontalViewportDragDeltaMb(
  deltaXPx: number,
  widthPx: number,
  viewport: Pick<ContactViewport, "xStart" | "xEnd">,
) {
  if (!Number.isFinite(deltaXPx) || !Number.isFinite(widthPx) || widthPx <= 0) {
    return 0;
  }
  const spanBp = viewport.xEnd - viewport.xStart;
  if (!Number.isFinite(spanBp) || spanBp <= 0) {
    return 0;
  }
  return -(deltaXPx / widthPx) * (spanBp / 1_000_000);
}

export function horizontalViewportFocusRatio(
  clientX: number,
  leftPx: number,
  widthPx: number,
) {
  if (
    !Number.isFinite(clientX)
    || !Number.isFinite(leftPx)
    || !Number.isFinite(widthPx)
    || widthPx <= 0
  ) {
    return 0.5;
  }
  return clamp((clientX - leftPx) / widthPx, 0, 1);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
