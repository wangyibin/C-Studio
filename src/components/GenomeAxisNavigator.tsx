import { useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { createPortal } from "react-dom";

export type GenomeAxis = "x" | "y";

export interface GenomeAssemblyBlock {
  id: string;
  objectId: string;
  visualStart: number;
  visualEnd: number;
}

export interface GenomeAxisNavigatorProps {
  axis: GenomeAxis;
  totalSpanMb: number;
  viewportSpanMb: number;
  centerMb: number;
  assemblyBlocks: readonly GenomeAssemblyBlock[];
  onPreview?: (centerRatio: number) => void;
  onPreviewCancel?: () => void;
  onCommit: (centerRatio: number) => void;
  ariaLabel?: string;
}

export interface GenomeViewportWindow {
  startMb: number;
  endMb: number;
  centerMb: number;
  startRatio: number;
  endRatio: number;
  centerRatio: number;
  spanRatio: number;
}

export interface GenomeSegment {
  id: string;
  objectId: string;
  startMb: number;
  endMb: number;
  startRatio: number;
  endRatio: number;
  spanRatio: number;
  blockCount: number;
}

interface DragSession {
  pointerId: number;
  startPointerRatio: number;
  startCenterRatio: number;
  currentCenterRatio: number;
  moved: boolean;
}

interface AxisPointerPosition {
  clientX: number;
  clientY: number;
  currentTarget: HTMLDivElement;
}

interface HoveredGenomeSegment {
  objectId: string;
  clientX: number;
  clientY: number;
}

const MB = 1_000_000;
const DRAG_EPSILON = 0.001;

/** Clamp a finite value to an inclusive range. Non-finite values resolve to the lower bound. */
export function clamp(value: number, minimum: number, maximum: number): number {
  const lower = Math.min(minimum, maximum);
  const upper = Math.max(minimum, maximum);
  if (!Number.isFinite(value)) {
    return lower;
  }
  return Math.min(upper, Math.max(lower, value));
}

/**
 * Calculate a viewport window in both megabases and normalized genome coordinates.
 * The center is shifted at either edge so the window never extends outside the genome.
 */
export function calculateViewportWindow(
  totalSpanMb: number,
  viewportSpanMb: number,
  centerMb: number,
): GenomeViewportWindow {
  const total = Number.isFinite(totalSpanMb) ? Math.max(0, totalSpanMb) : 0;
  const span = Number.isFinite(viewportSpanMb)
    ? clamp(viewportSpanMb, 0, total)
    : 0;

  if (total === 0) {
    return {
      startMb: 0,
      endMb: 0,
      centerMb: 0,
      startRatio: 0,
      endRatio: 0,
      centerRatio: 0,
      spanRatio: 0,
    };
  }

  const halfSpan = span / 2;
  const safeCenter = clamp(centerMb, halfSpan, total - halfSpan);
  const startMb = safeCenter - halfSpan;
  const endMb = safeCenter + halfSpan;

  return {
    startMb,
    endMb,
    centerMb: safeCenter,
    startRatio: startMb / total,
    endRatio: endMb / total,
    centerRatio: safeCenter / total,
    spanRatio: span / total,
  };
}

/** Keep a normalized center far enough from each edge to contain the viewport. */
export function clampCenterRatio(centerRatio: number, viewportSpanRatio: number): number {
  const safeSpanRatio = clamp(viewportSpanRatio, 0, 1);
  const halfSpanRatio = safeSpanRatio / 2;
  return clamp(centerRatio, halfSpanRatio, 1 - halfSpanRatio);
}

/**
 * Aggregate adjacent assembly blocks with the same object id into chromosome-scale
 * segments. Assembly coordinates are expressed in base pairs; the public result is Mb.
 */
export function buildGenomeSegments(
  assemblyBlocks: readonly GenomeAssemblyBlock[],
  totalSpanMb: number,
): GenomeSegment[] {
  const total = Number.isFinite(totalSpanMb) ? Math.max(0, totalSpanMb) : 0;
  const totalBp = total * MB;
  if (totalBp <= 0) {
    return [];
  }

  const orderedBlocks = assemblyBlocks
    .filter((block) => (
      block.objectId.length > 0
      && Number.isFinite(block.visualStart)
      && Number.isFinite(block.visualEnd)
      && block.visualEnd > block.visualStart
      && block.visualEnd > 0
      && block.visualStart < totalBp
    ))
    .map((block) => ({
      ...block,
      visualStart: clamp(block.visualStart, 0, totalBp),
      visualEnd: clamp(block.visualEnd, 0, totalBp),
    }))
    .filter((block) => block.visualEnd > block.visualStart)
    .sort((left, right) => (
      left.visualStart - right.visualStart
      || left.visualEnd - right.visualEnd
      || left.objectId.localeCompare(right.objectId)
    ));

  interface SegmentRun {
    objectId: string;
    startBp: number;
    endBp: number;
    blockCount: number;
  }

  const runs: SegmentRun[] = [];
  for (const block of orderedBlocks) {
    const previous = runs[runs.length - 1];
    if (previous?.objectId === block.objectId) {
      previous.startBp = Math.min(previous.startBp, block.visualStart);
      previous.endBp = Math.max(previous.endBp, block.visualEnd);
      previous.blockCount += 1;
      continue;
    }

    runs.push({
      objectId: block.objectId,
      startBp: block.visualStart,
      endBp: block.visualEnd,
      blockCount: 1,
    });
  }

  return runs.map((run, index) => {
    const startRatio = run.startBp / totalBp;
    const endRatio = run.endBp / totalBp;
    return {
      id: `${run.objectId}:${index}`,
      objectId: run.objectId,
      startMb: run.startBp / MB,
      endMb: run.endBp / MB,
      startRatio,
      endRatio,
      spanRatio: endRatio - startRatio,
      blockCount: run.blockCount,
    };
  });
}

/** Return the next normalized center for a supported slider key. */
export function centerRatioForKey(
  key: string,
  centerRatio: number,
  viewportSpanRatio: number,
): number | null {
  const safeSpanRatio = clamp(viewportSpanRatio, 0, 1);
  const arrowStep = Math.max(0.001, Math.min(0.05, safeSpanRatio * 0.1));
  const pageStep = Math.max(arrowStep, Math.min(1, safeSpanRatio * 0.9));
  let nextCenter = centerRatio;

  switch (key) {
    case "ArrowLeft":
    case "ArrowUp":
      nextCenter -= arrowStep;
      break;
    case "ArrowRight":
    case "ArrowDown":
      nextCenter += arrowStep;
      break;
    case "PageUp":
      nextCenter -= pageStep;
      break;
    case "PageDown":
      nextCenter += pageStep;
      break;
    case "Home":
      nextCenter = 0;
      break;
    case "End":
      nextCenter = 1;
      break;
    default:
      return null;
  }

  return clampCenterRatio(nextCenter, safeSpanRatio);
}

export function genomeSegmentAtRatio(
  segments: readonly GenomeSegment[],
  ratio: number,
) {
  const safeRatio = clamp(ratio, 0, 1);
  return segments.find((segment, index) => (
    safeRatio >= segment.startRatio
    && (safeRatio < segment.endRatio || (
      index === segments.length - 1 && safeRatio <= segment.endRatio
    ))
  )) ?? null;
}

function ratioFromPointer(
  event: AxisPointerPosition,
  axis: GenomeAxis,
): number {
  const bounds = event.currentTarget.getBoundingClientRect();
  if (axis === "x") {
    return bounds.width > 0 ? clamp((event.clientX - bounds.left) / bounds.width, 0, 1) : 0;
  }
  return bounds.height > 0 ? clamp((event.clientY - bounds.top) / bounds.height, 0, 1) : 0;
}

function formatMb(value: number): string {
  if (value >= 100) {
    return Math.round(value).toLocaleString();
  }
  if (value >= 10) {
    return value.toFixed(1).replace(/\.0$/, "");
  }
  return value.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

export function GenomeAxisNavigator({
  ariaLabel,
  assemblyBlocks,
  axis,
  centerMb,
  onCommit,
  onPreview,
  onPreviewCancel,
  totalSpanMb,
  viewportSpanMb,
}: GenomeAxisNavigatorProps) {
  const safeTotalSpanMb = Number.isFinite(totalSpanMb) ? Math.max(0, totalSpanMb) : 0;
  const controlledWindow = calculateViewportWindow(safeTotalSpanMb, viewportSpanMb, centerMb);
  const segments = useMemo(
    () => buildGenomeSegments(assemblyBlocks, safeTotalSpanMb),
    [assemblyBlocks, safeTotalSpanMb],
  );
  const dragSession = useRef<DragSession | null>(null);
  const [previewCenterRatio, setPreviewCenterRatio] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [hoveredSegment, setHoveredSegment] = useState<HoveredGenomeSegment | null>(null);
  const displayedCenterMb = previewCenterRatio === null
    ? controlledWindow.centerMb
    : previewCenterRatio * safeTotalSpanMb;
  const displayedWindow = calculateViewportWindow(safeTotalSpanMb, viewportSpanMb, displayedCenterMb);
  const axisLabel = ariaLabel ?? `${axis.toUpperCase()} axis genome navigator`;
  const minimumCenterMb = displayedWindow.spanRatio * safeTotalSpanMb / 2;
  const maximumCenterMb = Math.max(minimumCenterMb, safeTotalSpanMb - minimumCenterMb);
  const viewBox = axis === "x" ? "0 0 100 20" : "0 0 20 100";

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || safeTotalSpanMb <= 0) {
      return;
    }

    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    const startPointerRatio = ratioFromPointer(event, axis);
    dragSession.current = {
      pointerId: event.pointerId,
      startPointerRatio,
      startCenterRatio: displayedWindow.centerRatio,
      currentCenterRatio: displayedWindow.centerRatio,
      moved: false,
    };
    setIsDragging(true);
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    const drag = dragSession.current;
    const pointerRatio = ratioFromPointer(event, axis);
    if (!drag || drag.pointerId !== event.pointerId) {
      const segment = genomeSegmentAtRatio(segments, pointerRatio);
      setHoveredSegment(segment ? {
        objectId: segment.objectId,
        clientX: event.clientX,
        clientY: event.clientY,
      } : null);
      return;
    }

    event.preventDefault();
    setHoveredSegment(null);
    const pointerDelta = pointerRatio - drag.startPointerRatio;
    const nextCenterRatio = clampCenterRatio(
      drag.startCenterRatio + pointerDelta,
      controlledWindow.spanRatio,
    );
    drag.currentCenterRatio = nextCenterRatio;
    drag.moved ||= Math.abs(pointerDelta) >= DRAG_EPSILON;
    setPreviewCenterRatio(nextCenterRatio);
    onPreview?.(nextCenterRatio);
  }

  function finishPointerDrag(event: PointerEvent<HTMLDivElement>, commit: boolean) {
    const drag = dragSession.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    if (commit) {
      const pointerDelta = ratioFromPointer(event, axis) - drag.startPointerRatio;
      drag.currentCenterRatio = clampCenterRatio(
        drag.startCenterRatio + pointerDelta,
        controlledWindow.spanRatio,
      );
      drag.moved ||= Math.abs(pointerDelta) >= DRAG_EPSILON;
      if (drag.moved) {
        onPreview?.(drag.currentCenterRatio);
      }
    }

    dragSession.current = null;
    setIsDragging(false);
    setPreviewCenterRatio(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (commit && drag.moved) {
      onCommit(drag.currentCenterRatio);
    } else if (!commit && drag.moved) {
      onPreviewCancel?.();
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const nextCenterRatio = centerRatioForKey(
      event.key,
      displayedWindow.centerRatio,
      displayedWindow.spanRatio,
    );
    if (nextCenterRatio === null) {
      return;
    }

    event.preventDefault();
    onCommit(nextCenterRatio);
  }

  const windowStart = displayedWindow.startRatio * 100;
  const windowSpan = displayedWindow.spanRatio * 100;

  return (
    <div
      className={`genome-axis-navigator axis-${axis}${isDragging ? " dragging" : ""}`}
      data-axis={axis}
      role="slider"
      tabIndex={0}
      aria-label={axisLabel}
      aria-orientation={axis === "x" ? "horizontal" : "vertical"}
      aria-valuemin={Number(minimumCenterMb.toFixed(6))}
      aria-valuemax={Number(maximumCenterMb.toFixed(6))}
      aria-valuenow={Number(displayedWindow.centerMb.toFixed(6))}
      aria-valuetext={`${axis.toUpperCase()} ${formatMb(displayedWindow.startMb)}–${formatMb(displayedWindow.endMb)} Mb of ${formatMb(safeTotalSpanMb)} Mb`}
      aria-disabled={safeTotalSpanMb <= 0}
      style={{ touchAction: "none", userSelect: "none" }}
      onDoubleClick={(event) => {
        if (safeTotalSpanMb <= 0) {
          return;
        }
        event.preventDefault();
        onCommit(clampCenterRatio(ratioFromPointer(event, axis), controlledWindow.spanRatio));
      }}
      onKeyDown={handleKeyDown}
      onPointerCancel={(event) => finishPointerDrag(event, false)}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerLeave={() => {
        if (!dragSession.current) {
          setHoveredSegment(null);
        }
      }}
      onPointerUp={(event) => finishPointerDrag(event, true)}
      onLostPointerCapture={(event) => finishPointerDrag(event, false)}
    >
      {hoveredSegment && !isDragging && typeof document !== "undefined"
        ? createPortal(
            <span
              className={`genome-axis-hover-label axis-${axis}`}
              aria-hidden="true"
              style={{ left: hoveredSegment.clientX, top: hoveredSegment.clientY }}
            >
              {hoveredSegment.objectId}
            </span>,
            document.body,
          )
        : null}
      <svg
        className="genome-axis-rail"
        viewBox={viewBox}
        preserveAspectRatio="none"
        width="100%"
        height="100%"
        aria-hidden="true"
        focusable="false"
      >
        {axis === "x" ? (
          <rect className="genome-axis-track" x="0" y="2" width="100" height="16" rx="2" />
        ) : (
          <rect className="genome-axis-track" x="2" y="0" width="16" height="100" rx="2" />
        )}

        <g className="genome-axis-segments genome-axis-chromosome-track">
          {segments.map((segment, index) => {
            const start = segment.startRatio * 100;
            const span = segment.spanRatio * 100;
            return axis === "x" ? (
              <rect
                className={`genome-axis-segment segment-tone-${index % 5}`}
                data-object-id={segment.objectId}
                key={segment.id}
                x={start}
                y="2"
                width={span}
                height="16"
                rx="0.7"
                onPointerEnter={(event) => setHoveredSegment({
                  objectId: segment.objectId,
                  clientX: event.clientX,
                  clientY: event.clientY,
                })}
                onPointerLeave={() => {
                  if (!dragSession.current) {
                    setHoveredSegment(null);
                  }
                }}
              >
                <title>{`${segment.objectId}: ${formatMb(segment.startMb)}–${formatMb(segment.endMb)} Mb`}</title>
              </rect>
            ) : (
              <rect
                className={`genome-axis-segment segment-tone-${index % 5}`}
                data-object-id={segment.objectId}
                key={segment.id}
                x="2"
                y={start}
                width="16"
                height={span}
                rx="0.7"
                onPointerEnter={(event) => setHoveredSegment({
                  objectId: segment.objectId,
                  clientX: event.clientX,
                  clientY: event.clientY,
                })}
                onPointerLeave={() => {
                  if (!dragSession.current) {
                    setHoveredSegment(null);
                  }
                }}
              >
                <title>{`${segment.objectId}: ${formatMb(segment.startMb)}–${formatMb(segment.endMb)} Mb`}</title>
              </rect>
            );
          })}
        </g>

        <g className="genome-axis-window-group">
          {axis === "x" ? (
            <>
              <rect
                className="genome-axis-window"
                x={windowStart}
                y="2"
                width={windowSpan}
                height="16"
                rx="1.5"
              />
              <line
                className="genome-axis-handle handle-start"
                x1={windowStart}
                y1="3"
                x2={windowStart}
                y2="17"
              />
              <line
                className="genome-axis-handle handle-end"
                x1={windowStart + windowSpan}
                y1="3"
                x2={windowStart + windowSpan}
                y2="17"
              />
            </>
          ) : (
            <>
              <rect
                className="genome-axis-window"
                x="2"
                y={windowStart}
                width="16"
                height={windowSpan}
                rx="1.5"
              />
              <line
                className="genome-axis-handle handle-start"
                x1="3"
                y1={windowStart}
                x2="17"
                y2={windowStart}
              />
              <line
                className="genome-axis-handle handle-end"
                x1="3"
                y1={windowStart + windowSpan}
                x2="17"
                y2={windowStart + windowSpan}
              />
            </>
          )}
        </g>
      </svg>
    </div>
  );
}
