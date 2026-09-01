import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import {
  assemblyContigDisplayName,
  buildAssemblyEditModel,
  type AssemblySelectionModifiers,
} from "../state/assemblyEditing";
import {
  buildAssemblyBoundaryBands,
  fallbackAssemblyBoundaryViewportWidthPx,
} from "../state/assemblyBoundaryLod";
import {
  horizontalViewportDragDeltaMb,
  horizontalViewportFocusRatio,
} from "../state/contactViewport";
import { contactWheelPanIntent } from "../state/contactWheel";
import type { ContactMapLayoutBlock } from "../state/importers";
import {
  buildSyntenyViewport,
  type SyntenyBlockView,
  type SyntenyView,
} from "../state/syntenyView";
import type { UiAction, UiState } from "../state/uiState";
import {
  AssemblyContextMenu,
  type AssemblyContextMenuPosition,
} from "./AssemblyContextMenu";

export type SyntenySelectionModifiers = AssemblySelectionModifiers;

export interface DotplotTargetLane {
  id: string;
  top: number;
  height: number;
  targetLength: number;
}

export interface DotplotBlock {
  key: string;
  assemblyBlockId: string;
  targetId: string;
  left: number;
  top: number;
  targetTop: number;
  targetHeight: number;
  width: number;
  angle: number;
  strand: string;
  mapq: number;
  title: string;
}

export interface DotplotLayout {
  blocks: DotplotBlock[];
  targetLanes: DotplotTargetLane[];
}

interface SyntenyDotplotProps {
  syntenyView: SyntenyView | null;
  assemblyBlocks?: ContactMapLayoutBlock[];
  emptyLabel?: string;
  interactionMode?: "preview" | "interactive";
  onDoubleClick?: () => void;
  onSelectBlock?: (assemblyBlockId: string, modifiers: SyntenySelectionModifiers) => void;
  onSelectBlocks?: (assemblyBlockIds: string[]) => void;
  selectedAssemblyBlockIds?: string[];
  uiState?: UiState;
  onUiAction?: (action: UiAction) => void;
  totalSpanMb?: number;
}

interface SyntenySelectionDrag {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  currentClientX: number;
  currentClientY: number;
  startLocalX: number;
  startLocalY: number;
  currentLocalX: number;
  currentLocalY: number;
  startBlockId: string | null;
  startChromosomeId: string | null;
  moved: boolean;
}

interface SyntenyPanDrag {
  pointerId: number;
  startClientX: number;
  lastClientX: number;
  moved: boolean;
}

export interface SyntenySelectionCandidate {
  id: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Dotplot has one continuous assembly axis; map either wheel axis onto X. */
export function syntenyHorizontalWheelDelta(deltaX: number, deltaY: number): number {
  const safeDeltaX = Number.isFinite(deltaX) ? deltaX : 0;
  const safeDeltaY = Number.isFinite(deltaY) ? deltaY : 0;
  return Math.abs(safeDeltaX) >= Math.abs(safeDeltaY) ? safeDeltaX : safeDeltaY;
}

const syntenyDragThresholdPx = 4;
const syntenyWheelZoomCooldownMs = 140;
const syntenyPlotLeftPercent = 9;
const syntenyPlotRightPercent = 97;
const syntenyPlotTopPercent = 7;
const syntenyPlotBottomPercent = 93;
export const maximumSyntenyDotplotSegments = 2_000;

export function SyntenyDotplot({
  syntenyView,
  assemblyBlocks = [],
  emptyLabel = "No reference alignments in the heatmap X region",
  interactionMode = "interactive",
  onDoubleClick,
  onSelectBlock,
  onSelectBlocks,
  selectedAssemblyBlockIds = [],
  uiState,
  onUiAction,
  totalSpanMb,
}: SyntenyDotplotProps) {
  const isInteractive = interactionMode === "interactive";
  const canvasRef = useRef<HTMLDivElement>(null);
  const wheelZoomReadyAtRef = useRef(0);
  const [canvasAspectRatio, setCanvasAspectRatio] = useState(1);
  const [canvasWidthPx, setCanvasWidthPx] = useState(
    fallbackAssemblyBoundaryViewportWidthPx,
  );
  const synchronizedSyntenyView = useMemo(() => {
    if (!syntenyView || !uiState) {
      return syntenyView;
    }
    const assemblyTotalSpanBp = assemblyBlocks.reduce(
      (largestEnd, block) => Math.max(largestEnd, block.visualEnd),
      0,
    );
    const resolvedTotalSpanBp = Math.max(
      1,
      (totalSpanMb ?? uiState.contact.totalSpanMb) * 1_000_000,
      assemblyTotalSpanBp,
    );
    return {
      ...syntenyView,
      viewport: buildSyntenyViewport({
        centerXMb: uiState.contact.viewportCenterXMb,
        totalSpanBp: resolvedTotalSpanBp,
        windowSizeBp: uiState.contact.viewportSpanMb * 1_000_000,
        viewportWidthPx: uiState.contact.viewportWidthPx,
        viewportHeightPx: uiState.contact.viewportHeightPx,
      }),
    };
  }, [assemblyBlocks, syntenyView, totalSpanMb, uiState]);
  const displaySyntenyView = useMemo(
    () => syntenyViewForAssemblyExtent(synchronizedSyntenyView, assemblyBlocks),
    [assemblyBlocks, synchronizedSyntenyView],
  );
  const layout = useMemo(
    () => buildDotplotLayout(displaySyntenyView, canvasAspectRatio),
    [canvasAspectRatio, displaySyntenyView],
  );
  const assemblyTrack = useMemo(
    () => buildAssemblyTrack(
      displaySyntenyView,
      assemblyBlocks,
      canvasWidthPx * ((syntenyPlotRightPercent - syntenyPlotLeftPercent) / 100),
    ),
    [assemblyBlocks, canvasWidthPx, displaySyntenyView],
  );
  const dominantTargetByChromosome = useMemo(
    () => dominantSyntenyTargetByChromosome(syntenyView, assemblyBlocks),
    [assemblyBlocks, syntenyView],
  );
  const lastVisibleBoundaryBandId = assemblyTrack.chromosomeBands[
    assemblyTrack.chromosomeBands.length - 1
  ]?.id;
  const selected = new Set(selectedAssemblyBlockIds);
  const selectedContigRanges = syntenySelectedContigRanges(assemblyTrack.contigs, selected);
  const selectedReferenceRanges = syntenySelectedReferenceRanges(layout.blocks, selected);
  const [contextMenu, setContextMenu] = useState<AssemblyContextMenuPosition | null>(null);
  const [selectionDrag, setSelectionDrag] = useState<SyntenySelectionDrag | null>(null);
  const selectionDragRef = useRef<SyntenySelectionDrag | null>(null);
  const [panDrag, setPanDrag] = useState<SyntenyPanDrag | null>(null);
  const panDragRef = useRef<SyntenyPanDrag | null>(null);
  const suppressClickRef = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const updateAspectRatio = (width: number, height: number) => {
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return;
      }
      setCanvasWidthPx((currentWidth) => (
        Math.abs(currentWidth - width) < 0.5 ? currentWidth : width
      ));
      const nextAspectRatio = width / height;
      setCanvasAspectRatio((currentAspectRatio) => (
        Math.abs(currentAspectRatio - nextAspectRatio) < 0.0001
          ? currentAspectRatio
          : nextAspectRatio
      ));
    };

    updateAspectRatio(canvas.clientWidth, canvas.clientHeight);
    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(([entry]) => {
      if (entry) {
        updateAspectRatio(entry.contentRect.width, entry.contentRect.height);
      }
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    function abandonSyntenySelection(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }
      setContextMenu(null);
      if (!selectionDragRef.current && !panDragRef.current) {
        return;
      }
      suppressClickRef.current = true;
      storeSelectionDrag(null);
      storePanDrag(null);
    }
    function releaseSyntenyClickSuppression() {
      if (suppressClickRef.current) {
        setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      }
    }
    window.addEventListener("keydown", abandonSyntenySelection);
    window.addEventListener("pointerup", releaseSyntenyClickSuppression, true);
    window.addEventListener("pointercancel", releaseSyntenyClickSuppression, true);
    return () => {
      window.removeEventListener("keydown", abandonSyntenySelection);
      window.removeEventListener("pointerup", releaseSyntenyClickSuppression, true);
      window.removeEventListener("pointercancel", releaseSyntenyClickSuppression, true);
    };
  }, []);

  function selectBlock(id: string, event: ReactMouseEvent<HTMLElement>) {
    event.stopPropagation();
    if (!isInteractive || suppressClickRef.current) {
      return;
    }
    onSelectBlock?.(id, selectionModifiers(event));
  }

  function storeSelectionDrag(drag: SyntenySelectionDrag | null) {
    selectionDragRef.current = drag;
    setSelectionDrag(drag);
  }

  function storePanDrag(drag: SyntenyPanDrag | null) {
    panDragRef.current = drag;
    setPanDrag(drag);
  }

  function suppressNextClick() {
    suppressClickRef.current = true;
    setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
  }

  function startSelectionDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (!event.shiftKey || event.metaKey || event.ctrlKey || event.button !== 0) {
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    const pointerTarget = event.target instanceof Element ? event.target : null;
    const target = pointerTarget?.closest<HTMLElement>("[data-block-id]") ?? null;
    const chromosomeTarget = pointerTarget?.closest<HTMLElement>("[data-chromosome-id]") ?? null;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    storeSelectionDrag({
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      currentClientX: event.clientX,
      currentClientY: event.clientY,
      startLocalX: event.clientX - bounds.left,
      startLocalY: event.clientY - bounds.top,
      currentLocalX: event.clientX - bounds.left,
      currentLocalY: event.clientY - bounds.top,
      startBlockId: target?.dataset.blockId ?? null,
      startChromosomeId: chromosomeTarget?.dataset.chromosomeId ?? null,
      moved: false,
    });
  }

  function moveSelectionDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = selectionDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    const moved = drag.moved || Math.hypot(
      event.clientX - drag.startClientX,
      event.clientY - drag.startClientY,
    ) >= syntenyDragThresholdPx;
    if (moved) {
      event.preventDefault();
    }
    storeSelectionDrag({
      ...drag,
      currentClientX: event.clientX,
      currentClientY: event.clientY,
      currentLocalX: event.clientX - bounds.left,
      currentLocalY: event.clientY - bounds.top,
      moved,
    });
  }

  function stopSelectionDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = selectionDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (drag.moved) {
      const candidates = [...event.currentTarget.querySelectorAll<HTMLElement>(".dotplot-segment")]
        .map((element) => {
          const bounds = element.getBoundingClientRect();
          return {
            id: element.dataset.blockId ?? "",
            left: bounds.left,
            right: bounds.right,
            top: bounds.top,
            bottom: bounds.bottom,
          };
        })
        .filter((candidate) => candidate.id);
      onSelectBlocks?.(syntenyBlockIdsInSelection(
        candidates,
        { x: drag.startClientX, y: drag.startClientY },
        { x: event.clientX, y: event.clientY },
      ));
    } else if (drag.startChromosomeId) {
      selectChromosome(drag.startChromosomeId);
    } else if (drag.startBlockId) {
      onSelectBlock?.(drag.startBlockId, { shiftKey: false, metaKey: false, ctrlKey: false });
    } else {
      onSelectBlocks?.([]);
    }
    suppressNextClick();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    storeSelectionDrag(null);
  }

  function selectChromosome(id: string) {
    if (onUiAction) {
      onUiAction({ type: "selectAssemblyChromosome", id });
    } else {
      onSelectBlocks?.(assemblyBlocks
        .filter((block) => block.objectId === id)
        .map((block) => block.id));
    }
  }

  function selectChromosomeBand(id: string, event: ReactMouseEvent<HTMLButtonElement>) {
    if (!isInteractive || !event.shiftKey || suppressClickRef.current) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    selectChromosome(id);
  }

  function cancelSelectionDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (selectionDragRef.current?.pointerId !== event.pointerId) {
      return;
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    storeSelectionDrag(null);
  }

  function startPanDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.shiftKey || event.metaKey || event.ctrlKey || event.button !== 0) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    storePanDrag({
      pointerId: event.pointerId,
      startClientX: event.clientX,
      lastClientX: event.clientX,
      moved: false,
    });
  }

  function movePanDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = panDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    const moved = drag.moved
      || Math.abs(event.clientX - drag.startClientX) >= syntenyDragThresholdPx;
    if (!moved) {
      return;
    }
    event.preventDefault();
    const deltaXPx = event.clientX - (drag.moved ? drag.lastClientX : drag.startClientX);
    const deltaXMb = syntenyView
      ? horizontalViewportDragDeltaMb(deltaXPx, bounds.width, syntenyView.viewport)
      : 0;
    if (deltaXMb !== 0) {
      onUiAction?.({ type: "panContactViewport", deltaXMb, deltaYMb: 0 });
    }
    storePanDrag({ ...drag, lastClientX: event.clientX, moved: true });
  }

  function stopPanDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = panDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    if (drag.moved) {
      event.preventDefault();
      suppressNextClick();
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    storePanDrag(null);
  }

  function cancelPanDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (panDragRef.current?.pointerId !== event.pointerId) {
      return;
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    storePanDrag(null);
  }

  function zoomSyntenyAtPointer(event: ReactMouseEvent<HTMLDivElement>) {
    if (!isInteractive) {
      event.preventDefault();
      event.stopPropagation();
      onDoubleClick?.();
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    const assemblyTotalSpanMb = assemblyBlocks.reduce(
      (largestEnd, block) => Math.max(largestEnd, block.visualEnd),
      0,
    ) / 1_000_000;
    onUiAction?.({
      type: "zoomContactViewport",
      direction: "in",
      focusRatioX: horizontalViewportFocusRatio(event.clientX, bounds.left, bounds.width),
      snapToResolution: true,
      totalSpanMb: Math.max(
        0.000001,
        totalSpanMb ?? (assemblyTotalSpanMb || uiState?.contact.totalSpanMb || 0),
      ),
    });
  }

  function handleSyntenyWheel(event: ReactWheelEvent<HTMLDivElement>) {
    if (!isInteractive || !onUiAction || !syntenyView) {
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    const assemblyTotalSpanMb = assemblyBlocks.reduce(
      (largestEnd, block) => Math.max(largestEnd, block.visualEnd),
      0,
    ) / 1_000_000;
    const resolvedTotalSpanMb = Math.max(
      0.000001,
      totalSpanMb ?? (assemblyTotalSpanMb || uiState?.contact.totalSpanMb || 0),
    );

    if (event.ctrlKey || event.metaKey) {
      const wheelDelta = Math.abs(event.deltaY) >= Math.abs(event.deltaX)
        ? event.deltaY
        : event.deltaX;
      if (!Number.isFinite(wheelDelta) || wheelDelta === 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const now = performance.now();
      if (now < wheelZoomReadyAtRef.current) {
        return;
      }
      wheelZoomReadyAtRef.current = now + syntenyWheelZoomCooldownMs;
      onUiAction({
        type: "zoomContactViewport",
        direction: wheelDelta < 0 ? "in" : "out",
        focusRatioX: horizontalViewportFocusRatio(event.clientX, bounds.left, bounds.width),
        snapToResolution: true,
        totalSpanMb: resolvedTotalSpanMb,
      });
      return;
    }

    const horizontalDelta = syntenyHorizontalWheelDelta(event.deltaX, event.deltaY);
    const intent = contactWheelPanIntent({
      deltaX: horizontalDelta,
      deltaY: 0,
      deltaMode: event.deltaMode,
      bounds,
      viewport: syntenyView.viewport,
    });
    if (!intent) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    onUiAction({
      type: "panContactViewport",
      deltaXMb: intent.deltaXMb,
      deltaYMb: 0,
    });
  }

  function startSyntenyPointer(event: ReactPointerEvent<HTMLDivElement>) {
    if (!isInteractive) {
      startPanDrag(event);
    } else if (event.shiftKey) {
      startSelectionDrag(event);
    } else {
      startPanDrag(event);
    }
  }

  function moveSyntenyPointer(event: ReactPointerEvent<HTMLDivElement>) {
    if (isInteractive && selectionDragRef.current) {
      moveSelectionDrag(event);
    } else {
      movePanDrag(event);
    }
  }

  function stopSyntenyPointer(event: ReactPointerEvent<HTMLDivElement>) {
    if (isInteractive && selectionDragRef.current) {
      stopSelectionDrag(event);
    } else {
      stopPanDrag(event);
    }
  }

  function cancelSyntenyPointer(event: ReactPointerEvent<HTMLDivElement>) {
    if (isInteractive && selectionDragRef.current) {
      cancelSelectionDrag(event);
    } else {
      cancelPanDrag(event);
    }
  }

  function openContextMenu(event: ReactMouseEvent<HTMLElement>, id?: string) {
    event.preventDefault();
    event.stopPropagation();
    if (!isInteractive) {
      return;
    }
    if (id && !selected.has(id)) {
      onSelectBlock?.(id, { shiftKey: false, metaKey: false, ctrlKey: false });
    }
    setContextMenu({ x: event.clientX, y: event.clientY });
  }

  return (
    <div className="synteny-view">
      <div
        ref={canvasRef}
        className={`synteny-canvas ${!isInteractive ? "synteny-preview-only" : ""} ${
          panDrag?.moved ? "synteny-panning" : ""
        }`}
        aria-label={isInteractive
          ? "Interactive synteny dotplot; vertical or horizontal wheel movement pans the shared assembly X axis, Command or Control-wheel zooms at the pointer, drag horizontally pans, double-click zooms in, click replaces selection, Shift-drag selects multiple contigs, Shift-click inside that selection clears it, and Command or Control-click toggles individual contigs"
          : "Synteny preview; drag horizontally to pan the shared assembly X region and double-click to open the interactive synteny view"}
        onDoubleClick={zoomSyntenyAtPointer}
        onWheel={handleSyntenyWheel}
        onClick={() => {
          if (!suppressClickRef.current) {
            setContextMenu(null);
          }
        }}
        onContextMenu={(event) => openContextMenu(event)}
        onPointerDown={startSyntenyPointer}
        onPointerMove={moveSyntenyPointer}
        onPointerUp={stopSyntenyPointer}
        onPointerCancel={cancelSyntenyPointer}
        onLostPointerCapture={cancelSyntenyPointer}
      >
        <div className="synteny-plot-frame" aria-hidden="true" />
        <div className="synteny-axis query-axis">Assembly</div>
        <div className="synteny-axis target-axis">Reference</div>

        <div className="synteny-query-track" aria-label="Assembly contigs in heatmap X region">
          {selectedContigRanges.map((range) => (
            <span
              className="synteny-contig-selection-range"
              key={`contig-selection:${range.firstId}:${range.lastId}`}
              aria-hidden="true"
              style={{ left: `${range.left}%`, width: `${range.width}%` }}
            />
          ))}
          {assemblyTrack.chromosomeBands.map((band) => (
            <span
              className={`synteny-chromosome-band ${
                band.id === lastVisibleBoundaryBandId ? "last-visible" : ""
              }`}
              key={band.id}
              data-chromosome-id={band.objectIds.length === 1 ? band.objectIds[0] : undefined}
              data-boundary-object-count={band.objectIds.length}
              style={{ left: `${band.left}%`, width: `${band.width}%` }}
              title={band.objectIds.length === 1
                ? band.objectIds[0]
                : `${band.objectIds.length} compact assembly objects`}
            />
          ))}
          {isInteractive ? (
            assemblyTrack.chromosomes.flatMap((chromosome) => {
              const dominantTargetId = dominantTargetByChromosome.get(chromosome.id);
              const dominantLane = layout.targetLanes.find((lane) => lane.id === dominantTargetId);
              const dominantLaneTop = dominantLane
                ? syntenyTargetLaneTopRatio(dominantLane.top)
                : null;
              const hitRegions = [
                { key: "top", targetId: "top", top: 0 },
                ...(dominantTargetId && dominantLaneTop !== null && dominantLaneTop > 0
                  ? [{
                      key: dominantTargetId,
                      targetId: dominantTargetId,
                      top: dominantLaneTop * 100,
                    }]
                  : []),
              ];

              return hitRegions.map((region) => (
                <button
                  type="button"
                  className={`synteny-chromosome-hit${
                    uiState?.assembly.selection?.kind === "chromosome"
                    && uiState.assembly.selection.id === chromosome.id
                      ? " selected"
                      : ""
                  }`}
                  key={`${chromosome.id}:${region.key}`}
                  data-chromosome-id={chromosome.id}
                  data-target-id={region.targetId}
                  aria-label={`Shift-click to select chromosome ${chromosome.id}${
                    region.targetId === "top" ? " at the top" : ` in ${region.targetId}`
                  }`}
                  title={`${chromosome.id} · ${
                    region.targetId === "top" ? "top" : region.targetId
                  } · Shift-click to select chromosome`}
                  style={{
                    left: `${chromosome.left}%`,
                    top: `${region.top}%`,
                    width: `${chromosome.width}%`,
                  }}
                  onClick={(event) => selectChromosomeBand(chromosome.id, event)}
                />
              ));
            })
          ) : null}
          {assemblyTrack.contigs.map((contig) => (
            <button
              type="button"
              className={`synteny-contig-segment ${selected.has(contig.id) ? "selected" : ""}`}
              key={contig.id}
              data-block-id={contig.id}
              aria-label={`Select ${contig.displayName} in synteny`}
              aria-pressed={selected.has(contig.id)}
              aria-disabled={!isInteractive || undefined}
              tabIndex={isInteractive ? 0 : -1}
              title={`${contig.objectId} · ${contig.displayName}`}
              style={{ left: `${contig.left}%`, width: `${contig.width}%` }}
              onClick={(event) => selectBlock(contig.id, event)}
              onContextMenu={(event) => openContextMenu(event, contig.id)}
            />
          ))}
        </div>

        {layout.targetLanes.map((lane) => (
          <div
            className="synteny-target-lane"
            key={lane.id}
            data-target-id={lane.id}
            style={{ top: `${lane.top}%`, height: `${lane.height}%` }}
          >
            <span>{lane.id}</span>
          </div>
        ))}

        {selectedReferenceRanges.map((range) => (
            <span
              className="synteny-contig-reference-shadow"
              key={`reference-shadow:${range.targetId}`}
              data-target-id={range.targetId}
              aria-hidden="true"
              style={{
                top: `${range.top}%`,
                height: `${range.height}%`,
              }}
            />
          ))}

        {layout.blocks.map((block) => {
          const shade = Math.max(0.32, Math.min(1, block.mapq / 60));
          const isSelected = selected.has(block.assemblyBlockId);

          return (
            <button
              type="button"
              className={`dotplot-segment ${block.strand === "-" ? "reverse" : ""} ${
                isSelected ? "selected" : ""
              }`}
              key={block.key}
              data-block-id={block.assemblyBlockId}
              data-target-id={block.targetId}
              title={block.title}
              aria-label={`Select ${block.assemblyBlockId} synteny block`}
              aria-pressed={isSelected}
              aria-disabled={!isInteractive || undefined}
              tabIndex={isInteractive ? 0 : -1}
              onClick={(event) => selectBlock(block.assemblyBlockId, event)}
              onContextMenu={(event) => openContextMenu(event, block.assemblyBlockId)}
              style={{
                left: `${block.left}%`,
                top: `${block.top}%`,
                width: `${block.width}%`,
                opacity: shade,
                transform: `rotate(${block.angle}deg)`,
              }}
            />
          );
        })}

        {selectionDrag?.moved ? (
          <span
            className="synteny-selection-preview"
            aria-hidden="true"
            style={{
              left: Math.min(selectionDrag.startLocalX, selectionDrag.currentLocalX),
              top: Math.min(selectionDrag.startLocalY, selectionDrag.currentLocalY),
              width: Math.abs(selectionDrag.currentLocalX - selectionDrag.startLocalX),
              height: Math.abs(selectionDrag.currentLocalY - selectionDrag.startLocalY),
            }}
          />
        ) : null}

        {layout.blocks.length === 0 ? <p>{emptyLabel}</p> : null}
        {displaySyntenyView ? (
          <small className="dotplot-range">
            X {formatMb(displaySyntenyView.viewport.xStart)}–{
              formatMb(displaySyntenyView.viewport.xEnd)
            } Mb
          </small>
        ) : null}
      </div>

      {isInteractive && contextMenu && uiState && onUiAction ? (
        <AssemblyContextMenu
          position={contextMenu}
          uiState={uiState}
          onUiAction={onUiAction}
          onClose={() => setContextMenu(null)}
          fixed
        />
      ) : null}
    </div>
  );
}

export function buildDotplotLayout(
  syntenyView: SyntenyView | null,
  canvasAspectRatio = 1,
): DotplotLayout {
  if (!syntenyView || syntenyView.viewport.xEnd <= syntenyView.viewport.xStart) {
    return { blocks: [], targetLanes: [] };
  }

  const targetOrder: string[] = [];
  const targetLengths = new Map<string, number>();
  for (const block of syntenyView.blocks) {
    if (!targetLengths.has(block.targetId)) {
      targetOrder.push(block.targetId);
    }
    targetLengths.set(
      block.targetId,
      Math.max(
        targetLengths.get(block.targetId) ?? 1,
        Number.isFinite(block.targetLength) ? block.targetLength : 0,
        block.targetEnd,
        1,
      ),
    );
  }
  targetOrder.sort((left, right) => left.localeCompare(right, undefined, {
    numeric: true,
    sensitivity: "base",
  }));

  const plotLeft = syntenyPlotLeftPercent;
  const plotRight = syntenyPlotRightPercent;
  const plotTop = syntenyPlotTopPercent;
  const plotBottom = syntenyPlotBottomPercent;
  const plotWidth = plotRight - plotLeft;
  const plotHeight = plotBottom - plotTop;
  const totalTargetLength = Math.max(
    1,
    targetOrder.reduce((total, id) => total + (targetLengths.get(id) ?? 1), 0),
  );
  let laneTop = plotTop;
  const targetLanes = targetOrder.map((id) => {
    const targetLength = targetLengths.get(id) ?? 1;
    const height = (targetLength / totalTargetLength) * plotHeight;
    const top = laneTop;
    laneTop += height;
    return { id, top, height, targetLength };
  });
  const lanesById = new Map(targetLanes.map((lane) => [lane.id, lane]));
  const viewportWidth = syntenyView.viewport.xEnd - syntenyView.viewport.xStart;
  const safeCanvasAspectRatio = Number.isFinite(canvasAspectRatio) && canvasAspectRatio > 0
    ? canvasAspectRatio
    : 1;

  const visibleBlocks = syntenyView.blocks.filter((block) => (
    block.visualEnd > syntenyView.viewport.xStart
    && block.visualStart < syntenyView.viewport.xEnd
  ));
  const renderBlocks = selectSyntenyBlocksForRendering(
    visibleBlocks,
    maximumSyntenyDotplotSegments,
  );
  const blocks = renderBlocks.flatMap((block) => {
    const lane = lanesById.get(block.targetId);
    const visualSpan = block.visualEnd - block.visualStart;
    if (!lane || visualSpan <= 0) {
      return [];
    }

    const visibleStart = Math.max(block.visualStart, syntenyView.viewport.xStart);
    const visibleEnd = Math.min(block.visualEnd, syntenyView.viewport.xEnd);
    if (visibleEnd <= visibleStart) {
      return [];
    }

    const startRatio = (visibleStart - block.visualStart) / visualSpan;
    const endRatio = (visibleEnd - block.visualStart) / visualSpan;
    const targetAtVisualStart = block.strand === "-" ? block.targetEnd : block.targetStart;
    const targetAtVisualEnd = block.strand === "-" ? block.targetStart : block.targetEnd;
    const targetAtVisibleStart = interpolate(targetAtVisualStart, targetAtVisualEnd, startRatio);
    const targetAtVisibleEnd = interpolate(targetAtVisualStart, targetAtVisualEnd, endRatio);
    const x1 = plotLeft
      + ((visibleStart - syntenyView.viewport.xStart) / viewportWidth) * plotWidth;
    const x2 = plotLeft
      + ((visibleEnd - syntenyView.viewport.xStart) / viewportWidth) * plotWidth;
    const y1 = lane.top
      + (clamp(targetAtVisibleStart, 0, lane.targetLength) / lane.targetLength) * lane.height;
    const y2 = lane.top
      + (clamp(targetAtVisibleEnd, 0, lane.targetLength) / lane.targetLength) * lane.height;
    const deltaX = x2 - x1;
    const deltaY = y2 - y1;
    // CSS percentage widths resolve against the canvas width, while percentage
    // top positions resolve against its height. Convert the vertical delta into
    // width-relative units before deriving the rotated segment geometry.
    const widthRelativeDeltaY = deltaY / safeCanvasAspectRatio;

    return [{
      key: `${block.assemblyBlockId}-${block.targetId}-${block.visualStart}-${block.targetStart}`,
      assemblyBlockId: block.assemblyBlockId,
      targetId: block.targetId,
      left: x1,
      top: y1,
      targetTop: Math.min(y1, y2),
      targetHeight: Math.abs(y2 - y1),
      width: Math.hypot(deltaX, widthRelativeDeltaY),
      angle: (Math.atan2(widthRelativeDeltaY, deltaX) * 180) / Math.PI,
      strand: block.strand,
      mapq: block.mapq,
      title: `${block.querySourceId}:${Math.round(visibleStart)}-${Math.round(visibleEnd)} → ${
        block.targetId
      }:${Math.round(Math.min(targetAtVisibleStart, targetAtVisibleEnd))}-${Math.round(
        Math.max(targetAtVisibleStart, targetAtVisibleEnd),
      )}${block.alignmentCount > 1 ? ` · ${block.alignmentCount} chained fragments` : ""}`,
    }];
  });

  return { blocks, targetLanes };
}

export function selectSyntenyBlocksForRendering(
  blocks: ReadonlyArray<SyntenyBlockView>,
  maximum = maximumSyntenyDotplotSegments,
): SyntenyBlockView[] {
  const limit = Math.max(0, Math.floor(maximum));
  if (blocks.length <= limit) {
    return [...blocks];
  }
  if (limit === 0) {
    return [];
  }

  const ranked = blocks.map((block, index) => ({ block, index }));
  const compare = (
    left: (typeof ranked)[number],
    right: (typeof ranked)[number],
  ) => (
    right.block.alignmentCount - left.block.alignmentCount
    || (right.block.visualEnd - right.block.visualStart)
      - (left.block.visualEnd - left.block.visualStart)
    || right.block.mapq - left.block.mapq
    || left.index - right.index
  );
  const bestByTarget = new Map<string, (typeof ranked)[number]>();
  for (const candidate of ranked) {
    const current = bestByTarget.get(candidate.block.targetId);
    if (!current || compare(candidate, current) < 0) {
      bestByTarget.set(candidate.block.targetId, candidate);
    }
  }
  const selected = new Set(
    [...bestByTarget.values()]
      .sort(compare)
      .slice(0, limit)
      .map((candidate) => candidate.index),
  );
  for (const candidate of ranked.sort(compare)) {
    if (selected.size >= limit) {
      break;
    }
    selected.add(candidate.index);
  }
  return blocks.filter((_, index) => selected.has(index));
}

export function syntenyViewForAssemblyExtent(
  syntenyView: SyntenyView | null,
  assemblyBlocks: ContactMapLayoutBlock[],
): SyntenyView | null {
  if (!syntenyView || assemblyBlocks.length === 0) {
    return syntenyView;
  }
  const assemblyStart = Math.min(...assemblyBlocks.map((block) => block.visualStart));
  const assemblyEnd = Math.max(...assemblyBlocks.map((block) => block.visualEnd));
  const xStart = Math.max(syntenyView.viewport.xStart, assemblyStart);
  const xEnd = Math.min(syntenyView.viewport.xEnd, assemblyEnd);
  if (xEnd <= xStart) {
    return syntenyView;
  }
  return {
    ...syntenyView,
    viewport: {
      ...syntenyView.viewport,
      xStart,
      xEnd,
    },
  };
}

export function syntenyBlockIdsInSelection(
  candidates: SyntenySelectionCandidate[],
  start: { x: number; y: number },
  end: { x: number; y: number },
) {
  const left = Math.min(start.x, end.x);
  const right = Math.max(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const bottom = Math.max(start.y, end.y);
  return [...new Set(candidates
    .filter((candidate) => (
      candidate.right >= left
      && candidate.left <= right
      && candidate.bottom >= top
      && candidate.top <= bottom
    ))
    .map((candidate) => candidate.id))];
}

export function syntenyTargetLaneTopRatio(laneTopPercent: number) {
  const plotHeightPercent = syntenyPlotBottomPercent - syntenyPlotTopPercent;
  return clamp((laneTopPercent - syntenyPlotTopPercent) / plotHeightPercent, 0, 1);
}

export function dominantSyntenyTargetByChromosome(
  syntenyView: SyntenyView | null,
  assemblyBlocks: ContactMapLayoutBlock[],
) {
  const chromosomeByBlockId = new Map(
    assemblyBlocks.map((block) => [block.id, block.objectId]),
  );
  const targetSpansByChromosome = new Map<string, Map<string, number>>();

  for (const block of syntenyView?.blocks ?? []) {
    const chromosomeId = chromosomeByBlockId.get(block.assemblyBlockId);
    if (!chromosomeId) {
      continue;
    }
    const targetSpans = targetSpansByChromosome.get(chromosomeId) ?? new Map<string, number>();
    const alignedSpan = Math.max(1, block.visualEnd - block.visualStart);
    targetSpans.set(block.targetId, (targetSpans.get(block.targetId) ?? 0) + alignedSpan);
    targetSpansByChromosome.set(chromosomeId, targetSpans);
  }

  return new Map([...targetSpansByChromosome].flatMap(([chromosomeId, targetSpans]) => {
    const dominantTarget = [...targetSpans].sort((left, right) => (
      right[1] - left[1] || left[0].localeCompare(right[0])
    ))[0]?.[0];
    return dominantTarget ? [[chromosomeId, dominantTarget] as const] : [];
  }));
}

interface AssemblyTrackSegment {
  id: string;
  left: number;
  width: number;
}

interface AssemblyBoundaryTrackSegment extends AssemblyTrackSegment {
  objectIds: string[];
}

interface AssemblyContigTrackSegment extends AssemblyTrackSegment {
  objectId: string;
  sourceId: string;
  displayName: string;
}

export function syntenySelectedContigRanges(
  contigs: AssemblyContigTrackSegment[],
  selectedIds: ReadonlySet<string>,
) {
  const ranges: Array<{
    firstId: string;
    lastId: string;
    left: number;
    width: number;
  }> = [];
  for (let index = 0; index < contigs.length; index += 1) {
    const contig = contigs[index];
    if (!selectedIds.has(contig.id)) {
      continue;
    }
    const previousContig = contigs[index - 1];
    const currentEnd = contig.left + contig.width;
    const range = ranges[ranges.length - 1];
    if (range && previousContig && selectedIds.has(previousContig.id)) {
      range.lastId = contig.id;
      range.width = Math.max(range.left + range.width, currentEnd) - range.left;
    } else {
      ranges.push({
        firstId: contig.id,
        lastId: contig.id,
        left: contig.left,
        width: contig.width,
      });
    }
  }
  return ranges;
}

export function syntenySelectedReferenceRanges(
  blocks: DotplotBlock[],
  selectedIds: ReadonlySet<string>,
) {
  const ranges = new Map<string, { targetId: string; top: number; bottom: number }>();
  for (const block of blocks) {
    if (!selectedIds.has(block.assemblyBlockId)) {
      continue;
    }
    const bottom = block.targetTop + block.targetHeight;
    const range = ranges.get(block.targetId);
    if (range) {
      range.top = Math.min(range.top, block.targetTop);
      range.bottom = Math.max(range.bottom, bottom);
    } else {
      ranges.set(block.targetId, { targetId: block.targetId, top: block.targetTop, bottom });
    }
  }
  return [...ranges.values()].map(({ targetId, top, bottom }) => ({
    targetId,
    top,
    height: bottom - top,
  }));
}

export function buildAssemblyTrack(
  syntenyView: SyntenyView | null,
  assemblyBlocks: ContactMapLayoutBlock[],
  viewportWidthPx = fallbackAssemblyBoundaryViewportWidthPx,
): {
  chromosomes: AssemblyTrackSegment[];
  chromosomeBands: AssemblyBoundaryTrackSegment[];
  contigs: AssemblyContigTrackSegment[];
} {
  if (!syntenyView || syntenyView.viewport.xEnd <= syntenyView.viewport.xStart) {
    return { chromosomes: [], chromosomeBands: [], contigs: [] };
  }
  const { xStart, xEnd } = syntenyView.viewport;
  const viewportSpan = xEnd - xStart;
  const toTrackSegment = <T extends { id: string; visualStart: number; visualEnd: number }>(item: T) => {
    const visibleStart = Math.max(xStart, item.visualStart);
    const visibleEnd = Math.min(xEnd, item.visualEnd);
    if (visibleEnd <= visibleStart) {
      return null;
    }
    return {
      ...item,
      left: ((visibleStart - xStart) / viewportSpan) * 100,
      width: ((visibleEnd - visibleStart) / viewportSpan) * 100,
    };
  };

  const assemblyChromosomes = buildAssemblyEditModel(assemblyBlocks).chromosomes;
  const chromosomes = assemblyChromosomes
    .sort((a, b) => a.visualStart - b.visualStart)
    .map(toTrackSegment)
    .filter((segment): segment is NonNullable<typeof segment> => segment !== null)
    .map(({ id, left, width }) => ({ id, left, width }));
  const chromosomeBands = buildAssemblyBoundaryBands(
    assemblyChromosomes,
    syntenyView.viewport,
    viewportWidthPx,
  )
    .map(toTrackSegment)
    .filter((segment): segment is NonNullable<typeof segment> => segment !== null)
    .map(({ id, left, width, objectIds }) => ({ id, left, width, objectIds }));
  const contigs = [...assemblyBlocks]
    .sort((a, b) => a.visualStart - b.visualStart)
    .map(toTrackSegment)
    .filter((segment): segment is NonNullable<typeof segment> => segment !== null)
    .map(({ id, objectId, sourceId, left, width, ...block }) => ({
      id,
      objectId,
      sourceId,
      displayName: assemblyContigDisplayName({
        ...block,
        id,
        objectId,
        sourceId,
      }),
      left,
      width,
    }));

  return { chromosomes, chromosomeBands, contigs };
}

function selectionModifiers(event: ReactMouseEvent<HTMLElement>): SyntenySelectionModifiers {
  return {
    shiftKey: event.shiftKey,
    metaKey: event.metaKey,
    ctrlKey: event.ctrlKey,
  };
}

function interpolate(start: number, end: number, ratio: number) {
  return start + (end - start) * ratio;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function formatMb(valueBp: number) {
  return Number((valueBp / 1_000_000).toFixed(2)).toLocaleString();
}
