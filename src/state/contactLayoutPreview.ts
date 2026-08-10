import type { ContactMapLayoutBlock } from "./importers";

export interface ContactLayoutRasterSegment {
  sourceStart: number;
  sourceEnd: number;
  targetStart: number;
  targetEnd: number;
  flipped: boolean;
}

export interface ContactLayoutRasterPlan {
  segments: ContactLayoutRasterSegment[];
  changesPixels: boolean;
}

export interface ContactLayoutRasterSlice {
  sourceStartPx: number;
  sourceEndPx: number;
  targetStartPx: number;
  targetEndPx: number;
  flipped: boolean;
}

/**
 * Describes a pure move/reverse as independent one-dimensional raster strips.
 * Source identity and span must be unchanged; split/copy/delete operations
 * deliberately fall back to the authoritative tile renderer.
 */
export function buildContactLayoutRasterPlan(
  previousBlocks: ContactMapLayoutBlock[],
  nextBlocks: ContactMapLayoutBlock[],
): ContactLayoutRasterPlan | null {
  if (previousBlocks.length === 0 || previousBlocks.length !== nextBlocks.length) {
    return null;
  }

  const nextById = new Map(nextBlocks.map((block) => [block.id, block]));
  if (nextById.size !== nextBlocks.length) {
    return null;
  }

  let changesPixels = false;
  const segments: ContactLayoutRasterSegment[] = [];
  for (const previous of previousBlocks) {
    const next = nextById.get(previous.id);
    const sourceSpan = previous.sourceEnd - previous.sourceStart;
    if (
      !next
      || next.sourceId !== previous.sourceId
      || next.sourceStart !== previous.sourceStart
      || next.sourceEnd !== previous.sourceEnd
      || sourceSpan <= 0
      || previous.visualEnd - previous.visualStart !== sourceSpan
      || next.visualEnd - next.visualStart !== sourceSpan
    ) {
      return null;
    }

    const flipped = previous.orientation !== next.orientation;
    changesPixels ||= previous.visualStart !== next.visualStart || flipped;
    segments.push({
      sourceStart: previous.visualStart,
      sourceEnd: previous.visualEnd,
      targetStart: next.visualStart,
      targetEnd: next.visualEnd,
      flipped,
    });
  }

  return { segments, changesPixels };
}

/**
 * A raster preview is complete only when every destination strip visible in
 * the viewport can be sourced from the previous complete frame.
 */
export function contactLayoutRasterPlanCoversViewport(
  plan: ContactLayoutRasterPlan,
  viewportStart: number,
  viewportEnd: number,
): boolean {
  const epsilon = Math.max(1, viewportEnd - viewportStart) * 1e-9;
  return plan.segments.every((segment) => {
    const targetStart = Math.max(viewportStart, segment.targetStart);
    const targetEnd = Math.min(viewportEnd, segment.targetEnd);
    if (targetEnd <= targetStart) {
      return true;
    }

    const span = segment.targetEnd - segment.targetStart;
    const startRatio = (targetStart - segment.targetStart) / span;
    const endRatio = (targetEnd - segment.targetStart) / span;
    const sourceStart = segment.flipped
      ? segment.sourceEnd - endRatio * span
      : segment.sourceStart + startRatio * span;
    const sourceEnd = segment.flipped
      ? segment.sourceEnd - startRatio * span
      : segment.sourceStart + endRatio * span;
    return sourceStart >= viewportStart - epsilon && sourceEnd <= viewportEnd + epsilon;
  });
}

/** Converts one clipped genomic strip into source/target raster coordinates. */
export function contactLayoutRasterSlice(
  segment: ContactLayoutRasterSegment,
  viewportStart: number,
  viewportEnd: number,
  pixelSpan: number,
): ContactLayoutRasterSlice | null {
  const sourceStart = Math.max(viewportStart, segment.sourceStart);
  const sourceEnd = Math.min(viewportEnd, segment.sourceEnd);
  if (sourceEnd <= sourceStart || viewportEnd <= viewportStart || pixelSpan <= 0) {
    return null;
  }

  const segmentSpan = segment.sourceEnd - segment.sourceStart;
  const startRatio = (sourceStart - segment.sourceStart) / segmentSpan;
  const endRatio = (sourceEnd - segment.sourceStart) / segmentSpan;
  const mappedStart = segment.flipped
    ? segment.targetEnd - endRatio * segmentSpan
    : segment.targetStart + startRatio * segmentSpan;
  const mappedEnd = segment.flipped
    ? segment.targetEnd - startRatio * segmentSpan
    : segment.targetStart + endRatio * segmentSpan;
  const toPixel = (position: number) => (
    ((position - viewportStart) / (viewportEnd - viewportStart)) * pixelSpan
  );

  return {
    sourceStartPx: toPixel(sourceStart),
    sourceEndPx: toPixel(sourceEnd),
    targetStartPx: toPixel(mappedStart),
    targetEndPx: toPixel(mappedEnd),
    flipped: segment.flipped,
  };
}
