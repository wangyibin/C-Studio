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

const defaultWindowSizeBp = 200_000_000;

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
 * requested span; the longer axis shows proportionally more sequence. When a
 * whole-genome fit would exceed either boundary, both spans shrink together.
 */
export function contactViewportAxisSpans(
  totalSpanBp: number,
  windowSizeBp: number,
  viewportWidthPx: number,
  viewportHeightPx: number,
): ContactViewportAxisSpans {
  const safeTotalSpan = Number.isFinite(totalSpanBp) ? Math.max(1, totalSpanBp) : 1;
  const safeWindowSize = Number.isFinite(windowSizeBp)
    ? Math.min(Math.max(1, windowSizeBp), safeTotalSpan)
    : safeTotalSpan;
  const safeWidthPx = Number.isFinite(viewportWidthPx) ? Math.max(1, viewportWidthPx) : 1;
  const safeHeightPx = Number.isFinite(viewportHeightPx) ? Math.max(1, viewportHeightPx) : 1;
  const shortestSidePx = Math.min(safeWidthPx, safeHeightPx);
  const rawXSpan = safeWindowSize * (safeWidthPx / shortestSidePx);
  const rawYSpan = safeWindowSize * (safeHeightPx / shortestSidePx);
  const fitScale = Math.min(1, safeTotalSpan / rawXSpan, safeTotalSpan / rawYSpan);

  return {
    xSpanBp: Math.min(safeTotalSpan, Math.max(1, Math.round(rawXSpan * fitScale))),
    ySpanBp: Math.min(safeTotalSpan, Math.max(1, Math.round(rawYSpan * fitScale))),
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

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
