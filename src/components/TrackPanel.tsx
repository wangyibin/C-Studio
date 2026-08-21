import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Eye, EyeOff, SlidersHorizontal } from "lucide-react";
import {
  assemblyContigDisplayName,
  buildAssemblyEditModel,
  selectedBlockIds,
} from "../state/assemblyEditing";
import {
  buildAssemblyBoundaryBands,
  fallbackAssemblyBoundaryViewportWidthPx,
} from "../state/assemblyBoundaryLod";
import {
  horizontalViewportDragDeltaMb,
  horizontalViewportFocusRatio,
  type ContactViewport,
} from "../state/contactViewport";
import type { CoverageView } from "../state/coverageView";
import type { ContactMapLayoutBlock } from "../state/importers";
import type { UiAction, UiState } from "../state/uiState";

interface TrackPanelProps {
  coverageView: CoverageView | null;
  assemblyBlocks?: ContactMapLayoutBlock[];
  viewport?: ContactViewport;
  uiState: UiState;
  onUiAction: (action: UiAction) => void;
  onContextMenu?: (event: ReactMouseEvent<HTMLDivElement>) => void;
  totalSpanMb?: number;
}

export interface CoverageTrackBar {
  xBin: number;
  value: number;
  blockId: string | null;
  leftRatio: number;
  widthRatio: number;
}

export interface CoverageScaleDomain {
  min: number;
  max: number;
}

export interface CoverageSelectionRange {
  id: string;
  leftRatio: number;
  widthRatio: number;
}

export interface CoverageChromosomeBoundary {
  positionBp: number;
  leftRatio: number;
}

interface CoverageSelectionModifiers {
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}

interface CoverageSelectionDrag {
  pointerId: number;
  startClientX: number;
  startRatio: number;
  currentRatio: number;
  moved: boolean;
}

interface CoveragePanDrag {
  pointerId: number;
  startClientX: number;
  lastClientX: number;
  moved: boolean;
}

const defaultCoverageMultiplier = 2.5;
const minimumCoverageMultiplier = 1;
const maximumCoverageMultiplier = 100;
const coverageDragThresholdPx = 4;
const adaptiveCoverageHighPercentile = 0.98;
export const maximumCoverageRenderBars = 4_096;

/** At most one coverage bar per CSS pixel, with a fixed ultrawide safety ceiling. */
export function coverageRenderBarLimitForWidth(viewportWidthPx: number) {
  const safeWidth = Number.isFinite(viewportWidthPx)
    ? Math.max(1, Math.ceil(viewportWidthPx))
    : 1;
  return Math.min(maximumCoverageRenderBars, safeWidth);
}

export function TrackPanel({
  assemblyBlocks,
  coverageView: sourceCoverageView,
  onContextMenu,
  onUiAction,
  uiState,
  viewport,
  totalSpanMb = uiState.contact.totalSpanMb,
}: TrackPanelProps) {
  const activeAssemblyBlocks = assemblyBlocks ?? uiState.assembly.blocks;
  const [scaleOverride, setScaleOverride] = useState<CoverageScaleDomain | null>(null);
  const [automaticMultiplier, setAutomaticMultiplier] = useState(defaultCoverageMultiplier);
  const [automaticMultiplierInput, setAutomaticMultiplierInput] = useState(
    formatCoverageMultiplier(defaultCoverageMultiplier),
  );
  const [coverageSelectionDrag, setCoverageSelectionDrag] = useState<CoverageSelectionDrag | null>(null);
  const coverageSelectionDragRef = useRef<CoverageSelectionDrag | null>(null);
  const [coveragePanDrag, setCoveragePanDrag] = useState<CoveragePanDrag | null>(null);
  const coveragePanDragRef = useRef<CoveragePanDrag | null>(null);
  const coverageScaleControlRef = useRef<HTMLDetailsElement | null>(null);
  const coverageBarsRef = useRef<HTMLDivElement | null>(null);
  const [coverageViewportWidthPx, setCoverageViewportWidthPx] = useState(
    fallbackAssemblyBoundaryViewportWidthPx,
  );
  const lastDragSelectionSignatureRef = useRef("");
  const suppressCoverageClickRef = useRef(false);
  const coverageView = useMemo(() => (
    sourceCoverageView && viewport
      ? {
          ...sourceCoverageView,
          viewport: {
            ...viewport,
            yStart: sourceCoverageView.viewport.yStart,
            yEnd: sourceCoverageView.viewport.yEnd,
          },
        }
      : sourceCoverageView
  ), [sourceCoverageView, viewport]);
  const coverageRenderBarLimit = coverageRenderBarLimitForWidth(coverageViewportWidthPx);
  const bars = useMemo(
    () => buildCoverageTrackBars(
      coverageView,
      activeAssemblyBlocks,
      coverageRenderBarLimit,
    ),
    [activeAssemblyBlocks, coverageRenderBarLimit, coverageView],
  );
  const selectedIds = new Set(selectedBlockIds(
    activeAssemblyBlocks,
    uiState.assembly.selection,
  ));
  const selectionRanges = buildCoverageSelectionRanges(
    coverageView?.viewport ?? null,
    activeAssemblyBlocks,
    selectedIds,
  );
  const interactiveRanges = buildCoverageSelectionRanges(
    coverageView?.viewport ?? null,
    activeAssemblyBlocks,
    new Set(activeAssemblyBlocks.map((block) => block.id)),
  );
  const blocksById = new Map(activeAssemblyBlocks.map((block) => [block.id, block]));
  const chromosomeBoundaries = buildCoverageChromosomeBoundaries(
    coverageView?.viewport ?? null,
    activeAssemblyBlocks,
    coverageViewportWidthPx,
  );
  const coverageValues = bars.map((bar) => bar.value);
  const automaticScale = coverageAutoScaleDomain(coverageValues, automaticMultiplier);
  const scale = scaleOverride ?? automaticScale;
  const referenceDepth = coverageReferenceDepth(coverageValues);
  const referenceLines = coverageReferenceMultiples(coverageValues, referenceDepth)
    .map((multiple) => ({ multiple, value: (referenceDepth ?? 0) * multiple }));

  useEffect(() => {
    function abandonCoverageSelection(event: KeyboardEvent) {
      if (event.key !== "Escape" || (
        !coverageSelectionDragRef.current && !coveragePanDragRef.current
      )) {
        return;
      }
      suppressCoverageClickRef.current = true;
      storeCoverageSelectionDrag(null);
      storeCoveragePanDrag(null);
    }
    function releaseCoverageClickSuppression() {
      if (suppressCoverageClickRef.current) {
        setTimeout(() => {
          suppressCoverageClickRef.current = false;
        }, 0);
      }
    }
    window.addEventListener("keydown", abandonCoverageSelection);
    window.addEventListener("pointerup", releaseCoverageClickSuppression, true);
    window.addEventListener("pointercancel", releaseCoverageClickSuppression, true);
    return () => {
      window.removeEventListener("keydown", abandonCoverageSelection);
      window.removeEventListener("pointerup", releaseCoverageClickSuppression, true);
      window.removeEventListener("pointercancel", releaseCoverageClickSuppression, true);
    };
  }, []);

  useEffect(() => {
    function closeCoverageScaleOnOutsidePointer(event: PointerEvent) {
      const control = coverageScaleControlRef.current;
      if (!control?.open) {
        return;
      }
      if (!(event.target instanceof Node) || !control.contains(event.target)) {
        control.open = false;
      }
    }

    window.addEventListener("pointerdown", closeCoverageScaleOnOutsidePointer);
    return () => window.removeEventListener("pointerdown", closeCoverageScaleOnOutsidePointer);
  }, []);

  useEffect(() => {
    const bars = coverageBarsRef.current;
    if (!bars) {
      return;
    }

    const updateWidth = (width: number) => {
      if (!Number.isFinite(width) || width <= 0) {
        return;
      }
      setCoverageViewportWidthPx((current) => (
        Math.abs(current - width) < 0.5 ? current : width
      ));
    };

    updateWidth(bars.clientWidth);
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(([entry]) => {
      if (entry) {
        updateWidth(entry.contentRect.width);
      }
    });
    observer.observe(bars);
    return () => observer.disconnect();
  }, [uiState.tracks.coverageVisible]);

  function setScaleBoundary(field: keyof CoverageScaleDomain, value: number) {
    if (!Number.isFinite(value)) {
      return;
    }

    setScaleOverride((current) => {
      const next = { ...(current ?? automaticScale), [field]: value };
      if (next.max <= next.min) {
        return field === "min"
          ? { min: value, max: value + 1 }
          : { min: value - 1, max: value };
      }
      return next;
    });
  }

  function updateAutomaticMultiplier(value: string) {
    setAutomaticMultiplierInput(value);
    const parsed = Number(value);
    if (value.trim() && Number.isFinite(parsed)
      && parsed >= minimumCoverageMultiplier && parsed <= maximumCoverageMultiplier) {
      setAutomaticMultiplier(parsed);
      setScaleOverride(null);
    }
  }

  function commitAutomaticMultiplier() {
    const parsed = automaticMultiplierInput.trim()
      ? Number(automaticMultiplierInput)
      : Number.NaN;
    const multiplier = normalizeCoverageMultiplier(
      parsed,
      automaticMultiplier,
    );
    setAutomaticMultiplier(multiplier);
    setAutomaticMultiplierInput(formatCoverageMultiplier(multiplier));
    setScaleOverride(null);
  }

  function storeCoverageSelectionDrag(drag: CoverageSelectionDrag | null) {
    coverageSelectionDragRef.current = drag;
    setCoverageSelectionDrag(drag);
  }

  function storeCoveragePanDrag(drag: CoveragePanDrag | null) {
    coveragePanDragRef.current = drag;
    setCoveragePanDrag(drag);
  }

  function suppressNextCoverageClick() {
    suppressCoverageClickRef.current = true;
    setTimeout(() => {
      suppressCoverageClickRef.current = false;
    }, 0);
  }

  function selectCoverageContig(
    id: string,
    modifiers: CoverageSelectionModifiers,
  ) {
    if (suppressCoverageClickRef.current) {
      return;
    }

    if (coverageSelectionIsAdditive(modifiers)) {
      onUiAction({ type: "selectAssemblyContig", id, additive: true });
      return;
    }

    onUiAction({
      type: "selectAssemblyContig",
      id,
      additive: false,
    });
  }

  function startCoverageSelectionDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (!event.shiftKey || event.metaKey || event.ctrlKey || event.button !== 0) {
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width <= 0) {
      return;
    }
    const ratio = clamp01((event.clientX - bounds.left) / bounds.width);
    event.preventDefault();
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    lastDragSelectionSignatureRef.current = "";
    storeCoverageSelectionDrag({
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startRatio: ratio,
      currentRatio: ratio,
      moved: false,
    });
  }

  function moveCoverageSelectionDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = coverageSelectionDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width <= 0) {
      return;
    }
    const currentRatio = clamp01((event.clientX - bounds.left) / bounds.width);
    const moved = drag.moved
      || Math.abs(event.clientX - drag.startClientX) >= coverageDragThresholdPx;
    const nextDrag = { ...drag, currentRatio, moved };
    storeCoverageSelectionDrag(nextDrag);
    if (!moved) {
      return;
    }

    event.preventDefault();
    const ids = coverageContigIdsInRatioRange(
      coverageView?.viewport ?? null,
      activeAssemblyBlocks,
      nextDrag.startRatio,
      nextDrag.currentRatio,
    );
    const signature = ids.join("\u0000");
    if (signature !== lastDragSelectionSignatureRef.current) {
      lastDragSelectionSignatureRef.current = signature;
      onUiAction({ type: "selectAssemblyContigs", ids });
    }
  }

  function stopCoverageSelectionDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = coverageSelectionDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    if (drag.moved) {
      event.preventDefault();
      const bounds = event.currentTarget.getBoundingClientRect();
      const currentRatio = bounds.width > 0
        ? clamp01((event.clientX - bounds.left) / bounds.width)
        : drag.currentRatio;
      const ids = coverageContigIdsInRatioRange(
        coverageView?.viewport ?? null,
        activeAssemblyBlocks,
        drag.startRatio,
        currentRatio,
      );
      onUiAction({ type: "selectAssemblyContigs", ids });
    } else {
      const id = coverageBlockIdAtRatio(
        coverageView?.viewport ?? null,
        activeAssemblyBlocks,
        drag.startRatio,
      );
      if (id) {
        selectCoverageContig(id, { shiftKey: true, metaKey: false, ctrlKey: false });
      }
    }
    suppressNextCoverageClick();

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    storeCoverageSelectionDrag(null);
  }

  function cancelCoverageSelectionDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = coverageSelectionDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    storeCoverageSelectionDrag(null);
  }

  function startCoveragePanDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.shiftKey || event.metaKey || event.ctrlKey || event.button !== 0) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    storeCoveragePanDrag({
      pointerId: event.pointerId,
      startClientX: event.clientX,
      lastClientX: event.clientX,
      moved: false,
    });
  }

  function moveCoveragePanDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = coveragePanDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    const moved = drag.moved
      || Math.abs(event.clientX - drag.startClientX) >= coverageDragThresholdPx;
    if (!moved) {
      return;
    }
    event.preventDefault();
    const deltaXPx = event.clientX - (drag.moved ? drag.lastClientX : drag.startClientX);
    const deltaXMb = coverageView
      ? horizontalViewportDragDeltaMb(deltaXPx, bounds.width, coverageView.viewport)
      : 0;
    if (deltaXMb !== 0) {
      onUiAction({ type: "panContactViewport", deltaXMb, deltaYMb: 0 });
    }
    storeCoveragePanDrag({ ...drag, lastClientX: event.clientX, moved: true });
  }

  function stopCoveragePanDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = coveragePanDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    if (drag.moved) {
      event.preventDefault();
      suppressNextCoverageClick();
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    storeCoveragePanDrag(null);
  }

  function cancelCoveragePanDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (coveragePanDragRef.current?.pointerId !== event.pointerId) {
      return;
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    storeCoveragePanDrag(null);
  }

  function zoomCoverageAtPointer(event: ReactMouseEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    onUiAction({
      type: "zoomContactViewport",
      direction: "in",
      focusRatioX: horizontalViewportFocusRatio(event.clientX, bounds.left, bounds.width),
      snapToResolution: true,
      totalSpanMb,
    });
  }

  function startCoveragePointer(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.shiftKey) {
      startCoverageSelectionDrag(event);
    } else {
      startCoveragePanDrag(event);
    }
  }

  function moveCoveragePointer(event: ReactPointerEvent<HTMLDivElement>) {
    if (coverageSelectionDragRef.current) {
      moveCoverageSelectionDrag(event);
    } else {
      moveCoveragePanDrag(event);
    }
  }

  function stopCoveragePointer(event: ReactPointerEvent<HTMLDivElement>) {
    if (coverageSelectionDragRef.current) {
      stopCoverageSelectionDrag(event);
    } else {
      stopCoveragePanDrag(event);
    }
  }

  function cancelCoveragePointer(event: ReactPointerEvent<HTMLDivElement>) {
    if (coverageSelectionDragRef.current) {
      cancelCoverageSelectionDrag(event);
    } else {
      cancelCoveragePanDrag(event);
    }
  }

  return (
    <section
      className={`track-panel coverage-track ${uiState.tracks.coverageVisible ? "" : "track-hidden"}`}
      aria-label="Coverage track"
    >
      <div className="coverage-controls">
        <div className="coverage-control-buttons">
          <button
            className="coverage-control-button coverage-visibility-control"
            type="button"
            aria-label={uiState.tracks.coverageVisible ? "Hide coverage track" : "Show coverage track"}
            title={uiState.tracks.coverageVisible ? "Hide coverage track" : "Show coverage track"}
            onClick={() => onUiAction({ type: "toggleTrackVisibility", track: "coverage" })}
          >
            {uiState.tracks.coverageVisible ? <Eye size={13} aria-hidden="true" /> : <EyeOff size={13} aria-hidden="true" />}
          </button>
          <details ref={coverageScaleControlRef} className="coverage-scale-control">
            <summary
              className="coverage-control-button"
              aria-label="Set coverage range"
              title={`Coverage range ${formatCoverageScale(scale.min)}–${formatCoverageScale(scale.max)}`}
            >
              <SlidersHorizontal size={13} aria-hidden="true" />
            </summary>
            <div className="coverage-scale-popover" aria-label="Coverage range settings">
            <label>
              <span>Min</span>
              <input
                type="number"
                step="any"
                value={formatCoverageScale(scale.min)}
                aria-label="Coverage minimum"
                onChange={(event) => setScaleBoundary("min", Number(event.currentTarget.value))}
              />
            </label>
            <label>
              <span>Max</span>
              <input
                type="number"
                step="any"
                value={formatCoverageScale(scale.max)}
                aria-label="Coverage maximum"
                onChange={(event) => setScaleBoundary("max", Number(event.currentTarget.value))}
              />
            </label>
            <label className="coverage-multiplier-field">
              <span>Auto max</span>
              <span className="coverage-multiplier-input">
                <input
                  type="number"
                  min={minimumCoverageMultiplier}
                  max={maximumCoverageMultiplier}
                  step="0.1"
                  inputMode="decimal"
                  value={automaticMultiplierInput}
                  aria-label="Coverage automatic multiplier"
                  onChange={(event) => updateAutomaticMultiplier(event.currentTarget.value)}
                  onBlur={commitAutomaticMultiplier}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.currentTarget.blur();
                    }
                  }}
                />
                <span aria-hidden="true">×</span>
              </span>
            </label>
            <button
              type="button"
              className={scaleOverride === null ? "active" : ""}
              aria-pressed={scaleOverride === null}
              onClick={commitAutomaticMultiplier}
            >
              Auto {formatCoverageMultiplier(automaticMultiplier)}×
            </button>
            </div>
          </details>
        </div>
        {uiState.tracks.coverageVisible && referenceLines.length > 0 ? (
          <div className="coverage-axis-labels" aria-hidden="true">
            {referenceLines.map((reference) => (
              <span
                key={reference.multiple}
                className={`coverage-axis-label coverage-axis-label-${reference.multiple}x`}
                style={{
                  bottom: `clamp(6px, ${coverageValueHeightRatio(reference.value, scale) * 100}%, calc(100% - 6px))`,
                }}
              >
                {reference.multiple}×
              </span>
            ))}
          </div>
        ) : null}
      </div>
      {uiState.tracks.coverageVisible ? (
        <div
          ref={coverageBarsRef}
          className={`coverage-bars ${coverageSelectionDrag ? "coverage-range-dragging" : ""} ${
            coveragePanDrag?.moved ? "coverage-panning" : ""
          }`}
          aria-label="Coverage distribution; drag horizontally to pan the heatmap X region, double-click zooms in at the pointer, click replaces the current selection, Shift-drag selects multiple contigs, and Command or Control-click toggles individual contigs"
          data-resolution={coverageView?.resolution ?? undefined}
          data-viewport-x-start={coverageView?.viewport.xStart ?? undefined}
          data-viewport-x-end={coverageView?.viewport.xEnd ?? undefined}
          data-rendered-bar-count={bars.length}
          data-scale-min={scale.min}
          data-scale-max={scale.max}
          data-auto-multiplier={automaticMultiplier}
          data-coverage-reference-depth={referenceDepth ?? undefined}
          onPointerDown={startCoveragePointer}
          onPointerMove={moveCoveragePointer}
          onPointerUp={stopCoveragePointer}
          onPointerCancel={cancelCoveragePointer}
          onDoubleClick={zoomCoverageAtPointer}
          onContextMenu={onContextMenu}
        >
          {bars.map((bar) => (
            <span
              key={bar.xBin}
              className={`coverage-bin ${bar.value > scale.max ? "coverage-bin-clipped" : ""}`}
              aria-hidden="true"
              style={{
                left: `${bar.leftRatio * 100}%`,
                width: `${bar.widthRatio * 100}%`,
                height: `${coverageValueHeightRatio(bar.value, scale) * 100}%`,
              }}
            />
          ))}
          {referenceLines.length > 0 ? (
            <div className="coverage-reference-lines" aria-hidden="true">
              {referenceLines.map((reference) => (
                <span
                  key={reference.multiple}
                  className={`coverage-reference-line coverage-reference-${reference.multiple}x`}
                  data-coverage-multiple={reference.multiple}
                  data-coverage-value={reference.value}
                  style={{
                    bottom: `${coverageValueHeightRatio(reference.value, scale) * 100}%`,
                  }}
                />
              ))}
            </div>
          ) : null}
          <div className="coverage-chromosome-grid" aria-hidden="true">
            {chromosomeBoundaries.map((boundary) => (
              <span
                key={boundary.positionBp}
                data-boundary-bp={boundary.positionBp}
                style={{ left: `${boundary.leftRatio * 100}%` }}
              />
            ))}
          </div>
          <div className="coverage-contig-hit-layer">
            {interactiveRanges.map((range) => {
              const block = blocksById.get(range.id);
              const blockName = block ? assemblyContigDisplayName(block) : range.id;
              return (
                <button
                  key={range.id}
                  type="button"
                  data-block-id={range.id}
                  aria-pressed={selectedIds.has(range.id)}
                  aria-label={`Select ${blockName} in coverage`}
                  title={`${blockName} · Click to replace · Shift-drag multiple · Cmd/Ctrl-click toggle`}
                  style={{
                    left: `${range.leftRatio * 100}%`,
                    width: `${range.widthRatio * 100}%`,
                  }}
                  onClick={(event) => selectCoverageContig(range.id, event)}
                />
              );
            })}
          </div>
          <div className="coverage-selection-layer" aria-hidden="true">
            {selectionRanges.map((range) => (
              <span
                key={range.id}
                data-block-id={range.id}
                style={{
                  left: `${range.leftRatio * 100}%`,
                  width: `${range.widthRatio * 100}%`,
                }}
              />
            ))}
          </div>
          {coverageSelectionDrag?.moved ? (
            <div
              className="coverage-range-selection-preview"
              aria-hidden="true"
              style={coverageRatioWindowStyle(
                coverageSelectionDrag.startRatio,
                coverageSelectionDrag.currentRatio,
              )}
            />
          ) : null}
        </div>
      ) : (
        <div className="coverage-bars coverage-bars-hidden" aria-hidden="true" />
      )}
      <div className="coverage-track-end" aria-hidden="true" />
    </section>
  );
}

export function coverageAutoScaleDomain(
  values: number[],
  multiplier = defaultCoverageMultiplier,
): CoverageScaleDomain {
  const finiteValues = values.filter(Number.isFinite);
  const minimum = Math.min(0, ...finiteValues);
  const safeMultiplier = normalizeCoverageMultiplier(multiplier);
  const referenceDepth = coverageReferenceDepth(finiteValues);
  if (referenceDepth === null) {
    return { min: minimum, max: minimum + safeMultiplier };
  }
  const referenceMultiples = coverageReferenceMultiples(finiteValues, referenceDepth);
  const highestReference = referenceMultiples[referenceMultiples.length - 1] ?? 2;
  const effectiveMultiplier = Math.max(
    safeMultiplier,
    highestReference >= 3 ? highestReference + 0.25 : safeMultiplier,
  );

  return {
    min: minimum,
    max: minimum + referenceDepth * effectiveMultiplier,
  };
}

export function coverageReferenceDepth(values: number[]) {
  const positiveValues = values
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);
  if (positiveValues.length === 0) {
    return null;
  }

  const midpoint = Math.floor(positiveValues.length / 2);
  return positiveValues.length % 2 === 1
    ? positiveValues[midpoint]
    : (positiveValues[midpoint - 1] + positiveValues[midpoint]) / 2;
}

export function coverageReferenceMultiples(
  values: number[],
  referenceDepth = coverageReferenceDepth(values),
) {
  if (referenceDepth === null || referenceDepth <= 0) {
    return [];
  }

  const positiveValues = values
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);
  if (positiveValues.length === 0) {
    return [];
  }

  const percentileIndex = Math.min(
    positiveValues.length - 1,
    Math.floor((positiveValues.length - 1) * adaptiveCoverageHighPercentile),
  );
  const robustUpperDepth = positiveValues[percentileIndex];
  return robustUpperDepth >= referenceDepth * 3
    ? [1, 2, 3]
    : [1, 2];
}

export function normalizeCoverageMultiplier(
  value: number,
  fallback = defaultCoverageMultiplier,
) {
  const safeFallback = Number.isFinite(fallback)
    ? Math.min(maximumCoverageMultiplier, Math.max(minimumCoverageMultiplier, fallback))
    : defaultCoverageMultiplier;
  if (!Number.isFinite(value)) {
    return safeFallback;
  }
  return Math.min(maximumCoverageMultiplier, Math.max(minimumCoverageMultiplier, value));
}

export function coverageValueHeightRatio(value: number, scale: CoverageScaleDomain) {
  if (!Number.isFinite(value) || !Number.isFinite(scale.min) || !Number.isFinite(scale.max)) {
    return 0;
  }

  return clamp01((value - scale.min) / Math.max(Number.EPSILON, scale.max - scale.min));
}

export function coverageSelectionIsAdditive({
  metaKey,
  ctrlKey,
}: CoverageSelectionModifiers) {
  return metaKey || ctrlKey;
}

export function coverageContigIdsInRatioRange(
  viewport: ContactViewport | null,
  blocks: ContactMapLayoutBlock[],
  startRatio: number,
  endRatio: number,
) {
  if (!viewport || viewport.xEnd <= viewport.xStart
    || !Number.isFinite(startRatio) || !Number.isFinite(endRatio)) {
    return [];
  }

  const lowerRatio = Math.min(clamp01(startRatio), clamp01(endRatio));
  const upperRatio = Math.max(clamp01(startRatio), clamp01(endRatio));
  if (upperRatio === lowerRatio) {
    const id = coverageBlockIdAtRatio(viewport, blocks, lowerRatio);
    return id ? [id] : [];
  }

  const span = viewport.xEnd - viewport.xStart;
  const visualStart = viewport.xStart + lowerRatio * span;
  const visualEnd = viewport.xStart + upperRatio * span;
  return [...blocks]
    .sort((left, right) => left.visualStart - right.visualStart || left.visualEnd - right.visualEnd)
    .filter((block) => block.visualEnd > visualStart && block.visualStart < visualEnd)
    .map((block) => block.id);
}

export function coverageRatioWindowStyle(startRatio: number, endRatio: number) {
  const leftRatio = Math.min(clamp01(startRatio), clamp01(endRatio));
  const rightRatio = Math.max(clamp01(startRatio), clamp01(endRatio));
  return {
    left: `${Number((leftRatio * 100).toFixed(6))}%`,
    width: `${Number(((rightRatio - leftRatio) * 100).toFixed(6))}%`,
  };
}

export function buildCoverageSelectionRanges(
  viewport: ContactViewport | null,
  blocks: ContactMapLayoutBlock[],
  selectedIds: ReadonlySet<string>,
): CoverageSelectionRange[] {
  if (!viewport || viewport.xEnd <= viewport.xStart || selectedIds.size === 0) {
    return [];
  }

  const span = viewport.xEnd - viewport.xStart;
  return blocks.flatMap((block) => {
    if (!selectedIds.has(block.id)) {
      return [];
    }
    const visibleStart = Math.max(viewport.xStart, block.visualStart);
    const visibleEnd = Math.min(viewport.xEnd, block.visualEnd);
    if (visibleEnd <= visibleStart) {
      return [];
    }

    return [{
      id: block.id,
      leftRatio: (visibleStart - viewport.xStart) / span,
      widthRatio: (visibleEnd - visibleStart) / span,
    }];
  });
}

export function buildCoverageChromosomeBoundaries(
  viewport: ContactViewport | null,
  blocks: ContactMapLayoutBlock[],
  viewportWidthPx = fallbackAssemblyBoundaryViewportWidthPx,
): CoverageChromosomeBoundary[] {
  if (!viewport || viewport.xEnd <= viewport.xStart || blocks.length === 0) {
    return [];
  }

  const span = viewport.xEnd - viewport.xStart;
  const positions = new Set<number>();
  const boundaryBands = buildAssemblyBoundaryBands(
    buildAssemblyEditModel(blocks).chromosomes,
    viewport,
    viewportWidthPx,
  );
  for (const band of boundaryBands) {
    if (band.visualStart > viewport.xStart && band.visualStart < viewport.xEnd) {
      positions.add(band.visualStart);
    }
    if (band.visualEnd > viewport.xStart && band.visualEnd < viewport.xEnd) {
      positions.add(band.visualEnd);
    }
  }

  return [...positions]
    .sort((left, right) => left - right)
    .map((positionBp) => ({
      positionBp,
      leftRatio: (positionBp - viewport.xStart) / span,
    }));
}

export function coverageBlockIdAtRatio(
  viewport: ContactViewport | null,
  blocks: ContactMapLayoutBlock[],
  ratio: number,
) {
  if (!viewport || viewport.xEnd <= viewport.xStart || !Number.isFinite(ratio)) {
    return null;
  }

  const clampedRatio = clamp01(ratio);
  const visualPosition = Math.min(
    viewport.xEnd - 0.000001,
    viewport.xStart + clampedRatio * (viewport.xEnd - viewport.xStart),
  );
  return blocks.find((block) => (
    visualPosition >= block.visualStart && visualPosition < block.visualEnd
  ))?.id ?? null;
}

export function buildCoverageTrackBars(
  coverageView: CoverageView | null,
  blocks: ContactMapLayoutBlock[],
  maximumBars = Number.MAX_SAFE_INTEGER,
): CoverageTrackBar[] {
  if (!coverageView || coverageView.resolution <= 0) {
    return [];
  }

  const startBin = Math.floor(coverageView.viewport.xStart / coverageView.resolution);
  const endBin = Math.ceil(coverageView.viewport.xEnd / coverageView.resolution) - 1;
  const sourceBinCount = Math.max(0, endBin - startBin + 1);
  if (sourceBinCount === 0) {
    return [];
  }
  const renderBarCount = Math.min(
    sourceBinCount,
    Number.isFinite(maximumBars)
      ? Math.max(1, Math.floor(maximumBars))
      : sourceBinCount,
  );
  const values = new Map(coverageView.bins.map((bin) => [bin.xBin, bin.value]));
  const bucketSums = new Float64Array(renderBarCount);
  for (const [xBin, value] of values) {
    const sourceIndex = xBin - startBin;
    if (sourceIndex < 0 || sourceIndex >= sourceBinCount || !Number.isFinite(value)) {
      continue;
    }
    const bucketIndex = Math.min(
      renderBarCount - 1,
      Math.floor(sourceIndex * renderBarCount / sourceBinCount),
    );
    bucketSums[bucketIndex] += value;
  }
  const viewportSpan = Math.max(1, coverageView.viewport.xEnd - coverageView.viewport.xStart);
  const orderedBlocks = [...blocks].sort((left, right) => left.visualStart - right.visualStart);
  let blockIndex = 0;

  return Array.from({ length: renderBarCount }, (_, index) => {
    const bucketStartOffset = Math.ceil(index * sourceBinCount / renderBarCount);
    const bucketEndOffset = Math.ceil((index + 1) * sourceBinCount / renderBarCount);
    const bucketBinCount = Math.max(1, bucketEndOffset - bucketStartOffset);
    const xBin = startBin + bucketStartOffset;
    const binStart = xBin * coverageView.resolution;
    const binEnd = (startBin + bucketEndOffset) * coverageView.resolution;
    const visibleStart = Math.max(binStart, coverageView.viewport.xStart);
    const visibleEnd = Math.min(binEnd, coverageView.viewport.xEnd);
    const visualPosition = (visibleStart + visibleEnd) / 2;
    while (orderedBlocks[blockIndex] && visualPosition >= orderedBlocks[blockIndex].visualEnd) {
      blockIndex += 1;
    }
    const candidate = orderedBlocks[blockIndex];
    const block = candidate
      && visualPosition >= candidate.visualStart
      && visualPosition < candidate.visualEnd
      ? candidate
      : null;
    return {
      xBin,
      value: bucketSums[index] / bucketBinCount,
      blockId: block?.id ?? null,
      leftRatio: (visibleStart - coverageView.viewport.xStart) / viewportSpan,
      widthRatio: Math.max(0, visibleEnd - visibleStart) / viewportSpan,
    };
  });
}

function formatCoverageScale(value: number) {
  return Number(value.toFixed(2));
}

function formatCoverageMultiplier(value: number) {
  return String(Number(value.toFixed(2)));
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}
