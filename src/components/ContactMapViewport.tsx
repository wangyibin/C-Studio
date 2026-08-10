import { ArrowDownLeft, MoveDiagonal2, RotateCcw, Scissors } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ContactMapCell, ContactMapView, ExampleDatasetSummary } from "../App";
import {
  buildAssemblyEditModel,
  contigIdsInScreenSelection,
  hitTestAssemblyLayout,
  insertionTargetAtScreenPoint,
  type AssemblyEditModel,
  type AssemblyHit,
} from "../state/assemblyEditing";
import { contactColorCss } from "../state/contactColor";
import { normalizeContactValue } from "../state/contactColorScale";
import {
  buildContactLayoutRasterPlan,
  contactLayoutRasterPlanCoversViewport,
} from "../state/contactLayoutPreview";
import { contactCellsForViewport } from "../state/contactMapView";
import { contactRenderGeometry } from "../state/contactRenderGeometry";
import { buildCenteredContactViewport, type ContactViewport } from "../state/contactViewport";
import type { CoverageView } from "../state/coverageView";
import type { UiAction, UiState } from "../state/uiState";
import {
  AssemblyContextMenu,
  type AssemblyContextMenuPosition,
} from "./AssemblyContextMenu";
import { ContactLayoutRasterPreview } from "./ContactLayoutRasterPreview";
import { ContactTileLayer } from "./ContactTileLayer";
import { GenomeAxisNavigator } from "./GenomeAxisNavigator";
import { TrackPanel } from "./TrackPanel";

interface ContactMapViewportProps {
  dataset: ExampleDatasetSummary | null;
  contactMap: ContactMapView | null;
  coverageView: CoverageView | null;
  uiState: UiState;
  onUiAction: (action: UiAction) => void;
}

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  width: number;
  height: number;
  previewViewport: ContactViewport | null;
}

interface PendingPanFrame {
  sourceContactMap: ContactMapView;
  previewContactMap: ContactMapView;
  width: number;
  height: number;
}

interface AssemblySelectionDragState {
  pointerId: number;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  startLocalX: number;
  startLocalY: number;
  currentLocalX: number;
  currentLocalY: number;
  startHit: AssemblyHit | null;
}

interface AssemblyPointerState {
  kind: "cut" | "insert" | "select";
  blockId: string | null;
  visualPosition: number | null;
}

const maxBufferedContactCells = 360_000;
const shiftSelectionClassName = "shift-selection-active";
const wheelLinePixels = 16;
const wheelDeltaLineMode = 1;
const wheelDeltaPageMode = 2;

interface ContactWheelPanInput {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  shiftKey: boolean;
  bounds: {
    width: number;
    height: number;
  };
  viewport: ContactViewport;
}

export interface ContactWheelPanIntent {
  deltaXPx: number;
  deltaYPx: number;
  deltaXMb: number;
  deltaYMb: number;
}

export type AssemblyShiftClickIntent =
  | { type: "clear-selection" }
  | { type: "select-contig"; id: string; additive: boolean }
  | { type: "select-chromosome"; id: string };

export function assemblyShiftClickIntent(
  hasSelection: boolean,
  hit: AssemblyHit | null,
  hitIsSelected = false,
): AssemblyShiftClickIntent {
  if (hit === null) {
    return { type: "clear-selection" };
  }
  if (hitIsSelected) {
    return { type: "clear-selection" };
  }

  return hit.kind === "contig"
    ? { type: "select-contig", id: hit.id, additive: hasSelection }
    : { type: "select-chromosome", id: hit.id };
}

export function contactViewportSizePxFromBounds(bounds: { width: number; height: number }) {
  const side = Math.min(bounds.width, bounds.height);

  return Number.isFinite(side) && side > 0 ? side : null;
}

interface AxisNavigatorViewportInput {
  axis: "x" | "y";
  centerRatio: number;
  totalSpanMb: number;
  viewportSpanMb: number;
  viewportWidthPx: number;
  viewportHeightPx: number;
  centerXMb: number;
  centerYMb: number;
}

/** Build the transient viewport shown while one whole-genome navigator is dragged. */
export function contactViewportForAxisNavigator({
  axis,
  centerRatio,
  totalSpanMb,
  viewportSpanMb,
  viewportWidthPx,
  viewportHeightPx,
  centerXMb,
  centerYMb,
}: AxisNavigatorViewportInput): ContactViewport {
  const safeTotalSpanMb = Number.isFinite(totalSpanMb) ? Math.max(0.000001, totalSpanMb) : 0.000001;
  const safeViewportSpanMb = Number.isFinite(viewportSpanMb)
    ? Math.max(0.000001, viewportSpanMb)
    : safeTotalSpanMb;
  const safeCenterRatio = Number.isFinite(centerRatio) ? clamp01(centerRatio) : 0.5;
  const axisCenterMb = safeCenterRatio * safeTotalSpanMb;
  const currentCenterXMb = Number.isFinite(centerXMb) ? centerXMb : safeTotalSpanMb / 2;
  const currentCenterYMb = Number.isFinite(centerYMb) ? centerYMb : safeTotalSpanMb / 2;
  const nextCenterXMb = axis === "x" ? axisCenterMb : currentCenterXMb;
  const nextCenterYMb = axis === "y" ? axisCenterMb : currentCenterYMb;

  return buildCenteredContactViewport({
    centerMb: (nextCenterXMb + nextCenterYMb) / 2,
    centerXMb: nextCenterXMb,
    centerYMb: nextCenterYMb,
    totalSpanBp: safeTotalSpanMb * 1_000_000,
    windowSizeBp: safeViewportSpanMb * 1_000_000,
    viewportWidthPx,
    viewportHeightPx,
  });
}

export function contactWheelPanIntent({
  deltaX,
  deltaY,
  deltaMode,
  shiftKey,
  bounds,
  viewport,
}: ContactWheelPanInput): ContactWheelPanIntent | null {
  if (
    !Number.isFinite(bounds.width)
    || !Number.isFinite(bounds.height)
    || bounds.width <= 0
    || bounds.height <= 0
  ) {
    return null;
  }

  const rawDeltaX = Number.isFinite(deltaX) ? deltaX : 0;
  const rawDeltaY = Number.isFinite(deltaY) ? deltaY : 0;
  const mappedDeltaX = shiftKey
    ? (rawDeltaX !== 0 ? rawDeltaX : rawDeltaY)
    : rawDeltaX;
  const mappedDeltaY = shiftKey ? 0 : rawDeltaY;
  const deltaScaleX = deltaMode === wheelDeltaLineMode
    ? wheelLinePixels
    : deltaMode === wheelDeltaPageMode
      ? bounds.width
      : 1;
  const deltaScaleY = deltaMode === wheelDeltaLineMode
    ? wheelLinePixels
    : deltaMode === wheelDeltaPageMode
      ? bounds.height
      : 1;
  const deltaXPx = mappedDeltaX * deltaScaleX;
  const deltaYPx = mappedDeltaY * deltaScaleY;
  if (deltaXPx === 0 && deltaYPx === 0) {
    return null;
  }

  const viewportWidthMb = (viewport.xEnd - viewport.xStart) / 1_000_000;
  const viewportHeightMb = (viewport.yEnd - viewport.yStart) / 1_000_000;
  if (
    !Number.isFinite(viewportWidthMb)
    || !Number.isFinite(viewportHeightMb)
    || viewportWidthMb <= 0
    || viewportHeightMb <= 0
  ) {
    return null;
  }

  return {
    deltaXPx,
    deltaYPx,
    deltaXMb: (deltaXPx / bounds.width) * viewportWidthMb,
    deltaYMb: (deltaYPx / bounds.height) * viewportHeightMb,
  };
}

function setShiftSelectionCursor(active: boolean) {
  document.documentElement.classList.toggle(shiftSelectionClassName, active);
}

export function ContactMapViewport({ contactMap, coverageView, dataset, onUiAction, uiState }: ContactMapViewportProps) {
  const mapLayoutRef = useRef<HTMLDivElement>(null);
  const mapContentRef = useRef<HTMLDivElement>(null);
  const canvasFrameRef = useRef<HTMLDivElement>(null);
  const contactTileLayerRef = useRef<HTMLDivElement>(null);
  const assemblyOverlayLayerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const latestContactMapRef = useRef<ContactMapView | null>(null);
  const latestDisplayContactMapRef = useRef<ContactMapView | null>(null);
  const latestUiStateRef = useRef(uiState);
  latestUiStateRef.current = uiState;
  const [contextMenu, setContextMenu] = useState<AssemblyContextMenuPosition | null>(null);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const panAnimationFrameRef = useRef<number | null>(null);
  const redrawAnimationFrameRef = useRef<number | null>(null);
  const pendingPanFrameRef = useRef<PendingPanFrame | null>(null);
  const [assemblySelectionDrag, setAssemblySelectionDrag] = useState<AssemblySelectionDragState | null>(null);
  const [assemblyPointerState, setAssemblyPointerState] = useState<AssemblyPointerState>({
    kind: "select",
    blockId: null,
    visualPosition: null,
  });
  const hasContactMap = Boolean(dataset?.mcool_path);
  const usesTiledRenderer = Boolean(
    contactMap?.tiles || contactMap?.cachedTiles || contactMap?.previewTiles,
  );
  const contactSize = dataset?.mcool_size_bytes ? formatBytes(dataset.mcool_size_bytes) : null;
  const hasCoverageTrack = Boolean(dataset?.coverage_path);
  const activeAssemblyBlocks = uiState.assembly.blocks.length > 0
    ? uiState.assembly.blocks
    : dataset?.agp_layout.blocks ?? [];
  const activeAssemblyTotalBp = useMemo(
    () => activeAssemblyBlocks.reduce(
      (largestEnd, block) => Math.max(largestEnd, block.visualEnd),
      0,
    ),
    [activeAssemblyBlocks],
  );
  const liveTotalSpanBp = Math.max(
    1,
    activeAssemblyTotalBp
      || dataset?.agp_layout.totalSpan
      || uiState.contact.totalSpanMb * 1_000_000,
  );
  const liveViewport = useMemo(() => buildCenteredContactViewport({
    centerMb: uiState.contact.viewportCenterMb,
    centerXMb: uiState.contact.viewportCenterXMb,
    centerYMb: uiState.contact.viewportCenterYMb,
    totalSpanBp: liveTotalSpanBp,
    windowSizeBp: uiState.contact.viewportSpanMb * 1_000_000,
    viewportWidthPx: uiState.contact.viewportWidthPx,
    viewportHeightPx: uiState.contact.viewportHeightPx,
  }), [
    liveTotalSpanBp,
    uiState.contact.viewportCenterMb,
    uiState.contact.viewportCenterXMb,
    uiState.contact.viewportCenterYMb,
    uiState.contact.viewportHeightPx,
    uiState.contact.viewportSpanMb,
    uiState.contact.viewportWidthPx,
  ]);
  const displayViewport = dragState?.previewViewport ?? liveViewport;
  const liveContactMap = useMemo(
    () => contactMap ? { ...contactMap, viewport: liveViewport } : null,
    [contactMap, liveViewport],
  );
  const displayContactMap = useMemo(
    () => contactMap ? { ...contactMap, viewport: displayViewport } : null,
    [contactMap, displayViewport],
  );
  latestContactMapRef.current = liveContactMap;
  latestDisplayContactMapRef.current = displayContactMap;
  const viewportXStartMb = displayViewport.xStart / 1_000_000;
  const viewportXEndMb = displayViewport.xEnd / 1_000_000;
  const viewportXCenterMb = (viewportXStartMb + viewportXEndMb) / 2 || uiState.contact.viewportCenterXMb;
  const viewportYStartMb = displayViewport.yStart / 1_000_000;
  const viewportYEndMb = displayViewport.yEnd / 1_000_000;
  const viewportYCenterMb = (viewportYStartMb + viewportYEndMb) / 2 || uiState.contact.viewportCenterYMb;
  const viewportXSpanMb = Math.max(0.000001, viewportXEndMb - viewportXStartMb);
  const viewportYSpanMb = Math.max(0.000001, viewportYEndMb - viewportYStartMb);
  const layoutRasterPlan = useMemo(
    () => contactMap?.layoutBlocks
      ? buildContactLayoutRasterPlan(contactMap.layoutBlocks, activeAssemblyBlocks)
      : null,
    [activeAssemblyBlocks, contactMap?.layoutBlocks],
  );
  const showsLayoutRasterPreview = Boolean(
    usesTiledRenderer
    && contactMap?.visibleLayerComplete
    && layoutRasterPlan?.changesPixels
    && contactLayoutRasterPlanCoversViewport(
      layoutRasterPlan,
      displayViewport.xStart,
      displayViewport.xEnd,
    )
    && contactLayoutRasterPlanCoversViewport(
      layoutRasterPlan,
      displayViewport.yStart,
      displayViewport.yEnd,
    ),
  );
  // During a pure move/reverse, pixels and annotations switch to the edited
  // geometry together via the raster preview. If a complete preview cannot be
  // produced (for example, data moved in from outside the viewport), retain
  // the matching authoritative layout until the new visible layer is ready.
  const assemblyBlocks = layoutRasterPlan && (
    !layoutRasterPlan.changesPixels || showsLayoutRasterPreview
  )
    ? activeAssemblyBlocks
    : contactMap?.layoutBlocks ?? activeAssemblyBlocks;
  const assemblyModel = useMemo(() => buildAssemblyEditModel(assemblyBlocks), [assemblyBlocks]);
  const selectedAssemblyBlockIds = useMemo(
    () => selectedBlockIds(assemblyModel, uiState.assembly.selection),
    [assemblyModel, uiState.assembly.selection],
  );
  const visibleAssemblyBlocks = useMemo(
    () =>
      assemblyModel.blocks.filter(
        (block) => block.visualEnd > displayViewport.xStart && block.visualStart < displayViewport.xEnd,
      ),
    [assemblyModel, displayViewport.xStart, displayViewport.xEnd],
  );
  const visibleAssemblyChromosomes = useMemo(
    () =>
      assemblyModel.chromosomes.filter(
        (chromosome) => chromosome.visualEnd > displayViewport.xStart && chromosome.visualStart < displayViewport.xEnd,
      ),
    [assemblyModel, displayViewport.xStart, displayViewport.xEnd],
  );
  const totalSpanMb = Math.max(
    0.000001,
    (
      activeAssemblyTotalBp
      || assemblyModel.totalSpan
      || dataset?.agp_layout.totalSpan
      || uiState.contact.totalSpanMb * 1_000_000
    ) / 1_000_000,
  );
  const xAxisTicks = axisTicks(viewportXStartMb, viewportXEndMb);
  const yAxisTicks = axisTicks(viewportYStartMb, viewportYEndMb);

  useEffect(() => {
    function closeContextMenu() {
      setContextMenu(null);
    }

    function handleKeyDown(event: KeyboardEvent) {
      setContextMenu(null);
      if (event.key === "Shift") {
        setShiftSelectionCursor(true);
        return;
      }
      if (event.key !== "Escape") {
        return;
      }

      onUiAction({ type: "clearAssemblySelection" });
      dragStateRef.current = null;
      resetPanTransform();
      setDragState(null);
      setAssemblySelectionDrag(null);
      setAssemblyPointerStateIfChanged({ kind: "select", blockId: null, visualPosition: null });
    }

    function handleKeyUp(event: KeyboardEvent) {
      if (event.key === "Shift") {
        setShiftSelectionCursor(false);
      }
    }

    function handleWindowBlur() {
      setShiftSelectionCursor(false);
    }

    window.addEventListener("click", closeContextMenu);
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("blur", handleWindowBlur);

    return () => {
      window.removeEventListener("click", closeContextMenu);
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("blur", handleWindowBlur);
      setShiftSelectionCursor(false);
    };
  }, [onUiAction]);

  useEffect(() => {
    return () => {
      cancelScheduledPanFrame();
    };
  }, []);

  useEffect(() => {
    const stage = mapContentRef.current;
    if (!stage) {
      return;
    }

    function handleWheelPan(event: WheelEvent) {
      const sourceContactMap = latestContactMapRef.current;
      if (!sourceContactMap) {
        return;
      }

      const bounds = canvasFrameRef.current?.getBoundingClientRect()
        ?? stage!.getBoundingClientRect();
      const latestUiState = latestUiStateRef.current;
      const currentViewport = buildCenteredContactViewport({
        centerMb: latestUiState.contact.viewportCenterMb,
        centerXMb: latestUiState.contact.viewportCenterXMb,
        centerYMb: latestUiState.contact.viewportCenterYMb,
        totalSpanBp: totalSpanMb * 1_000_000,
        windowSizeBp: latestUiState.contact.viewportSpanMb * 1_000_000,
        viewportWidthPx: latestUiState.contact.viewportWidthPx,
        viewportHeightPx: latestUiState.contact.viewportHeightPx,
      });
      const intent = contactWheelPanIntent({
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        shiftKey: event.shiftKey,
        bounds,
        viewport: currentViewport,
      });
      if (!intent) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      const currentContactMap = { ...sourceContactMap, viewport: currentViewport };
      const previewContactMap = contactMapWithPannedViewport(
        currentContactMap,
        -intent.deltaXPx,
        -intent.deltaYPx,
        bounds.width,
        bounds.height,
        totalSpanMb * 1_000_000,
      );
      const deltaXMb = (previewContactMap.viewport.xStart - currentViewport.xStart) / 1_000_000;
      const deltaYMb = (previewContactMap.viewport.yStart - currentViewport.yStart) / 1_000_000;
      if (deltaXMb === 0 && deltaYMb === 0) {
        return;
      }

      schedulePanTransform(
        currentContactMap,
        previewContactMap,
        bounds.width,
        bounds.height,
      );
      onUiAction({ type: "panContactViewport", deltaXMb, deltaYMb });
    }

    stage.addEventListener("wheel", handleWheelPan, { passive: false });
    return () => stage.removeEventListener("wheel", handleWheelPan);
  }, [onUiAction, totalSpanMb]);

  useEffect(() => {
    const frame = canvasFrameRef.current;
    if (!frame) {
      return;
    }

    const reportMetricsAndRedraw = () => {
      const bounds = frame.getBoundingClientRect();
      const viewportSizePx = contactViewportSizePxFromBounds(bounds);
      if (viewportSizePx !== null) {
        onUiAction({
          type: "setContactViewportMetrics",
          viewportSizePx,
          viewportWidthPx: bounds.width,
          viewportHeightPx: bounds.height,
          totalSpanMb,
        });
      }

      const canvas = canvasRef.current;
      if (canvas && resizeContactMapCanvas(canvas, frame)) {
        drawContactMapBuffer(
          canvas,
          latestDisplayContactMapRef.current,
          latestUiStateRef.current,
        );
      }
    };
    reportMetricsAndRedraw();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(reportMetricsAndRedraw);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [onUiAction, totalSpanMb, usesTiledRenderer]);

  useEffect(() => {
    if (redrawAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(redrawAnimationFrameRef.current);
    }
    redrawAnimationFrameRef.current = window.requestAnimationFrame(() => {
      redrawAnimationFrameRef.current = null;
      drawContactMapBuffer(canvasRef.current, displayContactMap, uiState);
      resetPanTransform();
    });
    return () => {
      if (redrawAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(redrawAnimationFrameRef.current);
        redrawAnimationFrameRef.current = null;
      }
    };
  }, [displayContactMap, uiState.contact.colormap, uiState.contact.colorScale]);

  function openContextMenu(event: React.MouseEvent<HTMLDivElement>) {
    event.preventDefault();

    const bounds = mapLayoutRef.current?.getBoundingClientRect();
    const mapX = bounds ? event.clientX - bounds.left : event.clientX;
    const mapY = bounds ? event.clientY - bounds.top : event.clientY;

    setContextMenu({
      x: mapX,
      y: mapY,
    });
  }

  function startPan(event: React.PointerEvent<HTMLElement>) {
    if (!liveContactMap || event.button !== 0) {
      return;
    }

    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    event.currentTarget.setPointerCapture(event.pointerId);
    const bounds = canvasFrameRef.current?.getBoundingClientRect()
      ?? event.currentTarget.getBoundingClientRect();
    const nextDragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      currentX: event.clientX,
      currentY: event.clientY,
      width: Math.max(1, bounds.width),
      height: Math.max(1, bounds.height),
      previewViewport: null,
    };
    dragStateRef.current = nextDragState;
    setDragState(nextDragState);
  }

  function movePan(event: React.PointerEvent<HTMLElement>) {
    const currentDragState = dragStateRef.current;
    if (!currentDragState || !liveContactMap || currentDragState.pointerId !== event.pointerId) {
      return;
    }

    const latestPointer = latestPointerCoordinates(event.nativeEvent);
    const deltaX = latestPointer.clientX - currentDragState.startX;
    const deltaY = latestPointer.clientY - currentDragState.startY;
    if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) {
      return;
    }

    const previewContactMap = contactMapWithPannedViewport(
      liveContactMap,
      deltaX,
      deltaY,
      currentDragState.width,
      currentDragState.height,
      totalSpanMb * 1_000_000,
    );
    dragStateRef.current = {
      ...currentDragState,
      currentX: latestPointer.clientX,
      currentY: latestPointer.clientY,
      previewViewport: previewContactMap.viewport,
    };
    schedulePanTransform(
      liveContactMap,
      previewContactMap,
      currentDragState.width,
      currentDragState.height,
    );
  }

  function stopPan(event: React.PointerEvent<HTMLElement>) {
    const currentDragState = dragStateRef.current;
    if (currentDragState?.pointerId !== event.pointerId || !liveContactMap) {
      return;
    }

    const deltaX = event.clientX - currentDragState.startX;
    const deltaY = event.clientY - currentDragState.startY;
    const finalContactMap = contactMapWithPannedViewport(
      liveContactMap,
      deltaX,
      deltaY,
      currentDragState.width,
      currentDragState.height,
      totalSpanMb * 1_000_000,
    );
    const deltaXMb = ((finalContactMap.viewport.xStart - liveViewport.xStart) / 1_000_000);
    const deltaYMb = ((finalContactMap.viewport.yStart - liveViewport.yStart) / 1_000_000);
    cancelScheduledPanFrame();
    applyPanTransform(
      liveContactMap,
      finalContactMap,
      currentDragState.width,
      currentDragState.height,
    );
    dragStateRef.current = null;
    setDragState(null);
    if (Math.hypot(deltaXMb, deltaYMb) >= 0.05) {
      onUiAction({ type: "panContactViewport", deltaXMb, deltaYMb });
    } else {
      resetPanTransform();
      drawContactMapBuffer(canvasRef.current, liveContactMap, uiState);
    }
  }

  function applyPanTransform(
    sourceContactMap: ContactMapView,
    previewContactMap: ContactMapView,
    width: number,
    height: number,
  ) {
    const viewportWidth = Math.max(1, sourceContactMap.viewport.xEnd - sourceContactMap.viewport.xStart);
    const viewportHeight = Math.max(1, sourceContactMap.viewport.yEnd - sourceContactMap.viewport.yStart);
    const rawOffsetX = -((previewContactMap.viewport.xStart - sourceContactMap.viewport.xStart) / viewportWidth) * width;
    const rawOffsetY = -((previewContactMap.viewport.yStart - sourceContactMap.viewport.yStart) / viewportHeight) * height;
    const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
    const offsetX = Math.round(rawOffsetX * pixelRatio) / pixelRatio;
    const offsetY = Math.round(rawOffsetY * pixelRatio) / pixelRatio;
    const transform = `translate(${offsetX}px, ${offsetY}px)`;

    if (canvasRef.current) {
      canvasRef.current.style.transform = transform;
    }
    if (contactTileLayerRef.current) {
      contactTileLayerRef.current.style.transform = transform;
    }
    if (assemblyOverlayLayerRef.current) {
      assemblyOverlayLayerRef.current.style.transform = transform;
    }
  }

  function schedulePanTransform(
    sourceContactMap: ContactMapView,
    previewContactMap: ContactMapView,
    width: number,
    height: number,
  ) {
    pendingPanFrameRef.current = { sourceContactMap, previewContactMap, width, height };
    if (panAnimationFrameRef.current !== null) {
      return;
    }
    panAnimationFrameRef.current = window.requestAnimationFrame(() => {
      panAnimationFrameRef.current = null;
      const pendingFrame = pendingPanFrameRef.current;
      pendingPanFrameRef.current = null;
      if (pendingFrame) {
        applyPanTransform(
          pendingFrame.sourceContactMap,
          pendingFrame.previewContactMap,
          pendingFrame.width,
          pendingFrame.height,
        );
      }
    });
  }

  function cancelScheduledPanFrame() {
    if (panAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(panAnimationFrameRef.current);
      panAnimationFrameRef.current = null;
    }
    pendingPanFrameRef.current = null;
  }

  function resetPanTransform() {
    if (canvasRef.current) {
      canvasRef.current.style.transform = "";
    }
    if (contactTileLayerRef.current) {
      contactTileLayerRef.current.style.transform = "";
    }
    if (assemblyOverlayLayerRef.current) {
      assemblyOverlayLayerRef.current.style.transform = "";
    }
  }

  function previewAxisNavigator(axis: "x" | "y", centerRatio: number) {
    if (!liveContactMap) {
      return;
    }

    const bounds = canvasFrameRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
      return;
    }

    const previewViewport = contactViewportForAxisNavigator({
      axis,
      centerRatio,
      totalSpanMb,
      viewportSpanMb: uiState.contact.viewportSpanMb,
      viewportWidthPx: uiState.contact.viewportWidthPx,
      viewportHeightPx: uiState.contact.viewportHeightPx,
      centerXMb: uiState.contact.viewportCenterXMb,
      centerYMb: uiState.contact.viewportCenterYMb,
    });
    schedulePanTransform(
      liveContactMap,
      { ...liveContactMap, viewport: previewViewport },
      bounds.width,
      bounds.height,
    );
  }

  function cancelAxisNavigatorPreview() {
    cancelScheduledPanFrame();
    resetPanTransform();
  }

  function commitAxisNavigator(axis: "x" | "y", centerRatio: number) {
    previewAxisNavigator(axis, centerRatio);
    onUiAction({
      type: "setContactViewportAxisFromNavigator",
      axis,
      ratio: centerRatio,
      totalSpanMb,
    });
  }

  function handleAssemblyDoubleClick(event: React.MouseEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const focusRatioX = bounds.width > 0 ? (event.clientX - bounds.left) / bounds.width : 0.5;
    const focusRatioY = bounds.height > 0 ? (event.clientY - bounds.top) / bounds.height : 0.5;

    onUiAction({
      type: "zoomContactViewport",
      direction: "in",
      focusRatioX,
      focusRatioY,
      snapToResolution: true,
      totalSpanMb,
    });
  }

  function setAssemblyPointerStateIfChanged(nextState: AssemblyPointerState) {
    setAssemblyPointerState((current) =>
      current.kind === nextState.kind
      && current.blockId === nextState.blockId
      && current.visualPosition === nextState.visualPosition
        ? current
        : nextState,
    );
  }

  function startAssemblyPointer(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || assemblyModel.blocks.length === 0) {
      return;
    }

    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    const bounds = event.currentTarget.getBoundingClientRect();
    const point = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    const hit = hitTestAssemblyLayout(assemblyModel, point, {
      widthPx: Math.max(1, bounds.width),
      heightPx: Math.max(1, bounds.height),
      tolerancePx: event.shiftKey ? 10 : 6,
      viewportXStart: displayViewport.xStart,
      viewportXEnd: displayViewport.xEnd,
      viewportYStart: displayViewport.yStart,
      viewportYEnd: displayViewport.yEnd,
    });

    if (!event.shiftKey && assemblyPointerState.kind === "cut" && assemblyPointerState.blockId) {
      event.stopPropagation();
      onUiAction({
        type: "splitAssemblyContig",
        blockId: assemblyPointerState.blockId,
        visualPosition: visualPositionFromPointer(point.x, bounds.width, liveViewport.xStart, liveViewport.xEnd),
      });
      return;
    }

    const confirmedInsertTarget = insertionTargetAtScreenPoint(
      assemblyModel,
      selectedAssemblyBlockIds,
      point,
      {
        widthPx: Math.max(1, bounds.width),
        heightPx: Math.max(1, bounds.height),
        tolerancePx: 7,
        viewportXStart: displayViewport.xStart,
        viewportXEnd: displayViewport.xEnd,
        viewportYStart: displayViewport.yStart,
        viewportYEnd: displayViewport.yEnd,
        selectionKind: uiState.assembly.selection?.kind,
      },
    );
    if (
      !event.shiftKey
      && assemblyPointerState.kind === "insert"
      && confirmedInsertTarget !== null
      && assemblyPointerState.blockId === confirmedInsertTarget.targetBlockId
      && assemblyPointerState.visualPosition === confirmedInsertTarget.visualPosition
    ) {
      event.stopPropagation();
      onUiAction({
        type: "moveAssemblySelectionBefore",
        targetBlockId: confirmedInsertTarget.targetBlockId,
      });
      setAssemblyPointerStateIfChanged({ kind: "select", blockId: null, visualPosition: null });
      return;
    }

    if (!event.shiftKey) {
      startPan(event);
      return;
    }

    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setAssemblySelectionDrag({
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      currentX: event.clientX,
      currentY: event.clientY,
      startLocalX: point.x,
      startLocalY: point.y,
      currentLocalX: point.x,
      currentLocalY: point.y,
      startHit: hit,
    });
  }

  function moveAssemblyHover(event: React.PointerEvent<HTMLDivElement>) {
    // Panning is a compositor-only operation. Do not mix it with the O(n)
    // contig cut/insert hit-test path on every pointer sample.
    if (dragStateRef.current || assemblySelectionDrag) {
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    const point = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    const selectedIds = selectedAssemblyBlockIds;
    if (selectedIds.size === 0) {
      setAssemblyPointerStateIfChanged({ kind: "select", blockId: null, visualPosition: null });
      return;
    }

    const viewportXStart = displayViewport.xStart;
    const viewportXEnd = displayViewport.xEnd;
    const viewportYStart = displayViewport.yStart;
    const viewportYEnd = displayViewport.yEnd;
    const viewportXSpan = Math.max(1, viewportXEnd - viewportXStart);
    const viewportYSpan = Math.max(1, viewportYEnd - viewportYStart);
    const handlePx = 18;
    const diagonalTolerancePx = 8;

    for (const block of assemblyModel.blocks) {
      if (!selectedIds.has(block.id)) {
        continue;
      }

      const clippedXStart = Math.max(block.visualStart, viewportXStart);
      const clippedXEnd = Math.min(block.visualEnd, viewportXEnd);
      const clippedYStart = Math.max(block.visualStart, viewportYStart);
      const clippedYEnd = Math.min(block.visualEnd, viewportYEnd);
      if (clippedXStart >= clippedXEnd || clippedYStart >= clippedYEnd) {
        continue;
      }

      const leftPx = ((clippedXStart - viewportXStart) / viewportXSpan) * bounds.width;
      const topPx = ((clippedYStart - viewportYStart) / viewportYSpan) * bounds.height;
      const widthPx = Math.max(4, ((clippedXEnd - clippedXStart) / viewportXSpan) * bounds.width);
      const heightPx = Math.max(4, ((clippedYEnd - clippedYStart) / viewportYSpan) * bounds.height);
      const localX = point.x - leftPx;
      const localY = point.y - topPx;
      const insideBox = localX >= 0 && localY >= 0 && localX <= widthPx && localY <= heightPx;
      if (!insideBox) {
        continue;
      }

      const farEnoughFromEnds = localX > handlePx && localY > handlePx && localX < widthPx - handlePx && localY < heightPx - handlePx;
      const normalizedDiagonalDistance = Math.abs(localX / widthPx - localY / heightPx) * Math.min(widthPx, heightPx);
      if (farEnoughFromEnds && normalizedDiagonalDistance <= diagonalTolerancePx) {
        setAssemblyPointerStateIfChanged({ kind: "cut", blockId: block.id, visualPosition: null });
        return;
      }
    }

    const insertTargetId = insertionTargetAtScreenPoint(assemblyModel, selectedIds, point, {
      widthPx: Math.max(1, bounds.width),
      heightPx: Math.max(1, bounds.height),
      tolerancePx: 7,
      viewportXStart,
      viewportXEnd,
      viewportYStart,
      viewportYEnd,
      selectionKind: uiState.assembly.selection?.kind,
    });

    if (insertTargetId) {
      setAssemblyPointerStateIfChanged({
        kind: "insert",
        blockId: insertTargetId.targetBlockId,
        visualPosition: insertTargetId.visualPosition,
      });
      return;
    }

    setAssemblyPointerStateIfChanged({ kind: "select", blockId: null, visualPosition: null });
  }

  function moveAssemblyPointer(event: React.PointerEvent<HTMLDivElement>) {
    if (!assemblySelectionDrag || assemblySelectionDrag.pointerId !== event.pointerId) {
      movePan(event);
      return;
    }

    const bounds = event.currentTarget.getBoundingClientRect();
    setAssemblySelectionDrag({
      ...assemblySelectionDrag,
      currentX: event.clientX,
      currentY: event.clientY,
      currentLocalX: event.clientX - bounds.left,
      currentLocalY: event.clientY - bounds.top,
    });
  }

  function stopAssemblyPointer(event: React.PointerEvent<HTMLDivElement>) {
    if (assemblySelectionDrag?.pointerId === event.pointerId) {
      const bounds = event.currentTarget.getBoundingClientRect();
      const moved = Math.hypot(
        event.clientX - assemblySelectionDrag.startX,
        event.clientY - assemblySelectionDrag.startY,
      );

      if (moved < 8) {
        const intent = assemblyShiftClickIntent(
          uiState.assembly.selection !== null,
          assemblySelectionDrag.startHit,
          assemblySelectionDrag.startHit?.kind === "contig"
            ? selectedAssemblyBlockIds.has(assemblySelectionDrag.startHit.id)
            : assemblySelectionDrag.startHit?.kind === "chromosome-boundary"
              ? uiState.assembly.selection?.kind === "chromosome"
                && uiState.assembly.selection.id === assemblySelectionDrag.startHit.id
              : false,
        );
        if (intent.type === "clear-selection") {
          onUiAction({ type: "clearAssemblySelection" });
        } else if (intent.type === "select-contig") {
          onUiAction({ type: "selectAssemblyContig", id: intent.id, additive: intent.additive });
        } else {
          onUiAction({ type: "selectAssemblyChromosome", id: intent.id });
        }
      } else {
        const ids = contigIdsInScreenSelection(
          assemblyModel,
          {
            x: assemblySelectionDrag.startLocalX,
            y: assemblySelectionDrag.startLocalY,
          },
          { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
          {
            widthPx: Math.max(1, bounds.width),
            heightPx: Math.max(1, bounds.height),
            tolerancePx: 0,
            viewportXStart: displayViewport.xStart,
            viewportXEnd: displayViewport.xEnd,
            viewportYStart: displayViewport.yStart,
            viewportYEnd: displayViewport.yEnd,
          },
        );
        onUiAction({
          type: "selectAssemblyContigs",
          ids: [...selectedAssemblyBlockIds, ...ids],
        });
      }

      setAssemblySelectionDrag(null);
      return;
    }

    const currentPan = dragStateRef.current;
    if (currentPan?.pointerId === event.pointerId) {
      const moved = Math.hypot(
        event.clientX - currentPan.startX,
        event.clientY - currentPan.startY,
      );
      if (moved < 6) {
        dragStateRef.current = null;
        setDragState(null);
        cancelScheduledPanFrame();
        resetPanTransform();
        return;
      }
    }

    stopPan(event);
  }

  return (
    <section className="contact-map" aria-label="Contact map viewport">
      <div
        ref={mapLayoutRef}
        className={`map-content${hasCoverageTrack
          ? uiState.tracks.coverageVisible
            ? " has-coverage-track"
            : " has-collapsed-coverage-track"
          : ""}`}
      >
        <div className="map-axis-corner" aria-hidden="true" />
        <div className="map-axis-ticks map-axis-ticks-x" aria-hidden="true">
          {xAxisTicks.map((tick) => (
            <span key={tick.value} style={{ left: `${tick.ratio * 100}%` }}>
              {formatMb(tick.value)}
            </span>
          ))}
        </div>
        <div className="map-axis-ticks map-axis-ticks-y" aria-hidden="true">
          {yAxisTicks.map((tick) => (
            <span key={tick.value} style={{ top: `${tick.ratio * 100}%` }}>
              {formatMb(tick.value)}
            </span>
          ))}
        </div>
        {hasCoverageTrack ? (
          <TrackPanel
            coverageView={coverageView}
            viewport={displayViewport}
            uiState={uiState}
            onUiAction={onUiAction}
            onContextMenu={openContextMenu}
          />
        ) : null}
        <div
          ref={mapContentRef}
          className="heatmap-stage"
          onContextMenu={openContextMenu}
          onPointerDownCapture={(event) => {
            if (event.shiftKey) {
              setShiftSelectionCursor(true);
            }
          }}
          onPointerMoveCapture={(event) => {
            if (event.shiftKey) {
              setShiftSelectionCursor(true);
            }
          }}
        >
          <div ref={canvasFrameRef} className="contact-map-canvas-frame">
            {usesTiledRenderer ? (
              <ContactTileLayer
                contactMap={contactMap}
                layerRef={contactTileLayerRef}
                onPointerDown={startPan}
                onPointerMove={movePan}
                onPointerUp={stopPan}
                onPointerCancel={stopPan}
                uiState={uiState}
                viewport={displayViewport}
              />
            ) : (
              <canvas
                ref={canvasRef}
                className={`contact-map-buffer-canvas ${hasContactMap ? "loaded-contact-canvas" : "empty-contact-canvas"}`}
                width="2880"
                height="2880"
                aria-label={hasContactMap ? "Imported contact map" : "Contact map canvas placeholder"}
              />
            )}
            {showsLayoutRasterPreview && contactMap && layoutRasterPlan ? (
              <ContactLayoutRasterPreview
                sourceLayerRef={contactTileLayerRef}
                segments={layoutRasterPlan.segments}
                viewport={displayViewport}
                sourceRevision={[
                  contactMap.layoutScope,
                  contactMap.resolution,
                  uiState.contact.colormap,
                  uiState.contact.colorScale.min,
                  uiState.contact.colorScale.max,
                  uiState.contact.colorScale.log,
                ].join("|")}
              />
            ) : null}
          </div>
          <AssemblyOverlay
            overlayLayerRef={assemblyOverlayLayerRef}
            model={assemblyModel}
            viewportXStart={displayViewport.xStart}
            viewportXEnd={displayViewport.xEnd}
            viewportYStart={displayViewport.yStart}
            viewportYEnd={displayViewport.yEnd}
            selection={uiState.assembly.selection}
            showChromosomeBoxes={uiState.assembly.showChromosomeBoxes}
            showContigBoxes={uiState.assembly.showContigBoxes}
            visibleBlocks={visibleAssemblyBlocks}
            visibleChromosomes={visibleAssemblyChromosomes}
            selectionBox={assemblySelectionDrag ? {
              left: Math.min(assemblySelectionDrag.startLocalX, assemblySelectionDrag.currentLocalX),
              top: Math.min(assemblySelectionDrag.startLocalY, assemblySelectionDrag.currentLocalY),
              width: Math.abs(assemblySelectionDrag.currentLocalX - assemblySelectionDrag.startLocalX),
              height: Math.abs(assemblySelectionDrag.currentLocalY - assemblySelectionDrag.startLocalY),
            } : null}
            pointerState={assemblyPointerState}
            onReverseSelection={() => onUiAction({ type: "reverseAssemblySelection" })}
            onResizeSelection={(ids) => onUiAction({ type: "selectAssemblyContigs", ids })}
            onDoubleClick={handleAssemblyDoubleClick}
            onPointerDown={startAssemblyPointer}
            onPointerMove={(event) => {
              moveAssemblyPointer(event);
              moveAssemblyHover(event);
            }}
            onPointerUp={stopAssemblyPointer}
            onPointerCancel={(event) => {
              setAssemblySelectionDrag(null);
              stopPan(event);
              setAssemblyPointerStateIfChanged({ kind: "select", blockId: null, visualPosition: null });
            }}
            onPointerLeave={() => {
              if (!assemblySelectionDrag && !dragStateRef.current) {
                setAssemblyPointerStateIfChanged({ kind: "select", blockId: null, visualPosition: null });
              }
            }}
          />
        </div>
        {contextMenu ? (
          <AssemblyContextMenu
            position={contextMenu}
            uiState={uiState}
            onUiAction={onUiAction}
            onClose={() => setContextMenu(null)}
          />
        ) : null}
        <div className="genome-navigator-shell genome-navigator-y">
          <span className="genome-navigator-label" aria-hidden="true">Y</span>
          <GenomeAxisNavigator
            axis="y"
            totalSpanMb={totalSpanMb}
            viewportSpanMb={viewportYSpanMb}
            centerMb={viewportYCenterMb}
            assemblyBlocks={assemblyBlocks}
            ariaLabel="Y axis whole-genome navigator"
            onPreview={(ratio) => previewAxisNavigator("y", ratio)}
            onPreviewCancel={cancelAxisNavigatorPreview}
            onCommit={(ratio) => commitAxisNavigator("y", ratio)}
          />
        </div>
        <div className="genome-navigator-shell genome-navigator-x">
          <span className="genome-navigator-label" aria-hidden="true">X</span>
          <GenomeAxisNavigator
            axis="x"
            totalSpanMb={totalSpanMb}
            viewportSpanMb={viewportXSpanMb}
            centerMb={viewportXCenterMb}
            assemblyBlocks={assemblyBlocks}
            ariaLabel="X axis whole-genome navigator"
            onPreview={(ratio) => previewAxisNavigator("x", ratio)}
            onPreviewCancel={cancelAxisNavigatorPreview}
            onCommit={(ratio) => commitAxisNavigator("x", ratio)}
          />
        </div>
        <div className="map-navigator-corner" aria-hidden="true" />
      </div>
    </section>
  );
}

interface AssemblyOverlayProps {
  overlayLayerRef: React.RefObject<HTMLDivElement>;
  model: AssemblyEditModel;
  viewportXStart: number;
  viewportXEnd: number;
  viewportYStart: number;
  viewportYEnd: number;
  selection: UiState["assembly"]["selection"];
  showChromosomeBoxes: boolean;
  showContigBoxes: boolean;
  visibleBlocks: AssemblyEditModel["blocks"];
  visibleChromosomes: AssemblyEditModel["chromosomes"];
  selectionBox: { left: number; top: number; width: number; height: number } | null;
  pointerState: AssemblyPointerState;
  onReverseSelection: () => void;
  onResizeSelection: (ids: string[]) => void;
  onDoubleClick: (event: React.MouseEvent<HTMLDivElement>) => void;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerLeave: () => void;
}

function AssemblyOverlay({
  overlayLayerRef,
  model,
  viewportXStart,
  viewportXEnd,
  viewportYStart,
  viewportYEnd,
  selection,
  showChromosomeBoxes,
  showContigBoxes,
  visibleBlocks,
  visibleChromosomes,
  selectionBox,
  pointerState,
  onReverseSelection,
  onResizeSelection,
  onDoubleClick,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onPointerLeave,
}: AssemblyOverlayProps) {
  const [resizeState, setResizeState] = useState<{
    pointerId: number;
    side: "start" | "end";
    fixedIndex: number;
  } | null>(null);
  const viewportXSpan = Math.max(1, viewportXEnd - viewportXStart);
  const viewportYSpan = Math.max(1, viewportYEnd - viewportYStart);

  if (model.blocks.length === 0 || model.totalSpan <= 0) {
    return null;
  }

  const selectedIds = selectedBlockIds(model, selection);
  const selectedBlocks = model.blocks.filter((block) => selectedIds.has(block.id));
  const selectedIndexes = model.blocks
    .map((block, index) => (selectedIds.has(block.id) ? index : -1))
    .filter((index) => index >= 0);
  const selectedGroupBox = selectedBlocks.length > 0
    ? intervalBox(
        Math.min(...selectedBlocks.map((block) => block.visualStart)),
        Math.max(...selectedBlocks.map((block) => block.visualEnd)),
        viewportXStart,
        viewportXEnd,
        viewportXSpan,
        viewportYStart,
        viewportYEnd,
        viewportYSpan,
      )
    : null;

  function startResizeSelection(
    event: React.PointerEvent<HTMLButtonElement>,
    side: "start" | "end",
  ) {
    if (selectedIndexes.length === 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizeState({
      pointerId: event.pointerId,
      side,
      fixedIndex: side === "start"
        ? Math.max(...selectedIndexes)
        : Math.min(...selectedIndexes),
    });
  }

  function moveResizeSelection(event: React.PointerEvent<HTMLButtonElement>) {
    if (!resizeState || resizeState.pointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const overlay = event.currentTarget.closest(".assembly-overlay");
    const bounds = overlay?.getBoundingClientRect();
    if (!bounds) {
      return;
    }

    const visualPosition = viewportXStart
      + ((event.clientX - bounds.left) / Math.max(1, bounds.width)) * viewportXSpan;
    const pointerIndex = nearestAssemblyBlockIndex(model, visualPosition);
    const startIndex = resizeState.side === "start"
      ? Math.min(pointerIndex, resizeState.fixedIndex)
      : resizeState.fixedIndex;
    const endIndex = resizeState.side === "end"
      ? Math.max(pointerIndex, resizeState.fixedIndex)
      : resizeState.fixedIndex;
    onResizeSelection(model.blocks.slice(startIndex, endIndex + 1).map((block) => block.id));
  }

  function stopResizeSelection(event: React.PointerEvent<HTMLButtonElement>) {
    if (resizeState?.pointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setResizeState(null);
  }

  return (
    <div
      className="assembly-overlay"
      onDoubleClick={onDoubleClick}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerLeave={onPointerLeave}
    >
      {selectionBox ? (
        <span
          className="assembly-selection-box"
          style={{
            left: selectionBox.left,
            top: selectionBox.top,
            width: selectionBox.width,
            height: selectionBox.height,
          }}
        />
      ) : null}
      <div ref={overlayLayerRef} className="assembly-overlay-layer">
        {showChromosomeBoxes
          ? visibleChromosomes.map((chromosome) => {
          const box = intervalBox(
            chromosome.visualStart,
            chromosome.visualEnd,
            viewportXStart,
            viewportXEnd,
            viewportXSpan,
            viewportYStart,
            viewportYEnd,
            viewportYSpan,
          );
          if (!box) {
            return null;
          }

          return (
            <span
              key={chromosome.id}
              className={`assembly-box chromosome-box ${
                selection?.kind === "chromosome" && selection.id === chromosome.id ? "selected" : ""
              }`}
              style={box}
              title={chromosome.id}
            />
          );
        })
          : null}
        {showContigBoxes ? visibleBlocks.map((block) => {
        const box = intervalBox(
          block.visualStart,
          block.visualEnd,
          viewportXStart,
          viewportXEnd,
          viewportXSpan,
          viewportYStart,
          viewportYEnd,
          viewportYSpan,
        );
        if (!box) {
          return null;
        }
        const selected = selectedIds.has(block.id);
        return (
          <span key={block.id} className={`assembly-box contig-box ${selected ? "selected" : ""}`} style={box} title={`${block.sourceId} ${block.orientation}`}>
            {selected && pointerState.kind === "cut" && pointerState.blockId === block.id ? <span className="contig-handle cut-handle active"><Scissors size={11} /></span> : null}
            {selected ? <span className="contig-frame" /> : null}
          </span>
        );
      }) : null}
        {selectedIds.size > 0 && pointerState.kind === "insert" && pointerState.visualPosition !== null ? (() => {
          const left = ((pointerState.visualPosition - viewportXStart) / viewportXSpan) * 100;
          const top = ((pointerState.visualPosition - viewportYStart) / viewportYSpan) * 100;
          return (
            <span
              className="assembly-insert-marker"
              style={{
                left: `clamp(4px, ${left}%, calc(100% - 13px))`,
                top: `clamp(13px, ${top}%, calc(100% - 4px))`,
              }}
            >
              <ArrowDownLeft size={16} strokeWidth={2} absoluteStrokeWidth />
            </span>
          );
        })() : null}
        {selectedGroupBox ? (
          <span className="assembly-selected-group" style={selectedGroupBox}>
            <button
              className="assembly-resize-handle start"
              type="button"
              title="Drag to adjust selection start"
              aria-label="Adjust selection start"
              onPointerDown={(event) => startResizeSelection(event, "start")}
              onPointerMove={moveResizeSelection}
              onPointerUp={stopResizeSelection}
              onPointerCancel={stopResizeSelection}
              onDoubleClick={(event) => event.stopPropagation()}
            >
              <MoveDiagonal2 size={13} />
            </button>
            <button
              className="assembly-resize-handle end"
              type="button"
              title="Drag to adjust selection end"
              aria-label="Adjust selection end"
              onPointerDown={(event) => startResizeSelection(event, "end")}
              onPointerMove={moveResizeSelection}
              onPointerUp={stopResizeSelection}
              onPointerCancel={stopResizeSelection}
              onDoubleClick={(event) => event.stopPropagation()}
            >
              <MoveDiagonal2 size={13} />
            </button>
            <button
              className="assembly-rotate-button"
              type="button"
              title="Reverse selected contig order and orientation"
              aria-label="Reverse selected contig order and orientation"
              onPointerDown={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onReverseSelection();
              }}
            >
              <RotateCcw size={14} />
            </button>
          </span>
        ) : null}
      </div>
    </div>
  );
}

function nearestAssemblyBlockIndex(model: AssemblyEditModel, visualPosition: number) {
  let nearestIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < model.blocks.length; index += 1) {
    const block = model.blocks[index];
    if (visualPosition >= block.visualStart && visualPosition < block.visualEnd) {
      return index;
    }
    const distance = Math.min(
      Math.abs(visualPosition - block.visualStart),
      Math.abs(visualPosition - block.visualEnd),
    );
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  }
  return nearestIndex;
}

function intervalBox(
  visualStart: number,
  visualEnd: number,
  viewportXStart: number,
  viewportXEnd: number,
  viewportXSpan: number,
  viewportYStart: number,
  viewportYEnd: number,
  viewportYSpan: number,
) {
  const clippedXStart = Math.max(visualStart, viewportXStart);
  const clippedXEnd = Math.min(visualEnd, viewportXEnd);
  const clippedYStart = Math.max(visualStart, viewportYStart);
  const clippedYEnd = Math.min(visualEnd, viewportYEnd);
  if (clippedXStart >= clippedXEnd || clippedYStart >= clippedYEnd) {
    return null;
  }

  const left = ((clippedXStart - viewportXStart) / viewportXSpan) * 100;
  const top = ((clippedYStart - viewportYStart) / viewportYSpan) * 100;
  const width = ((clippedXEnd - clippedXStart) / viewportXSpan) * 100;
  const height = ((clippedYEnd - clippedYStart) / viewportYSpan) * 100;
  return {
    left: `${left}%`,
    top: `${top}%`,
    width: `${width}%`,
    height: `${height}%`,
  };
}

function selectedBlockIds(model: AssemblyEditModel, selection: UiState["assembly"]["selection"]) {
  if (!selection) {
    return new Set<string>();
  }

  if (selection.kind === "contigs") {
    return new Set(selection.ids);
  }

  return new Set(
    model.blocks.filter((block) => block.objectId === selection.id).map((block) => block.id),
  );
}

function singleSelectedContig(uiState: UiState) {
  const selection = uiState.assembly.selection;
  if (selection?.kind !== "contigs" || selection.ids.length !== 1) {
    return null;
  }

  return selection.ids[0];
}

function visualPositionFromPointer(
  x: number,
  width: number,
  viewportStart: number,
  viewportEnd: number,
) {
  const viewportSpan = Math.max(1, viewportEnd - viewportStart);

  return Math.round(viewportStart + (x / Math.max(1, width)) * viewportSpan);
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
  }

  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  }

  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function formatMb(value: number) {
  return `${Number(value.toFixed(2)).toLocaleString()} Mb`;
}

function axisTicks(startMb: number, endMb: number, count = 5) {
  const span = Math.max(0, endMb - startMb);
  return Array.from({ length: count }, (_, index) => {
    const ratio = count <= 1 ? 0 : index / (count - 1);
    return {
      ratio,
      value: startMb + span * ratio,
    };
  });
}

const maxContactCanvasSide = 4095;
const maxContactCanvasPixelRatio = 1.5;

export interface ContactCanvasBackingSize {
  width: number;
  height: number;
}

export function contactCanvasBackingSizeFromBounds(
  bounds: { width: number; height: number },
  devicePixelRatio: number,
): ContactCanvasBackingSize | null {
  if (
    !Number.isFinite(bounds.width)
    || !Number.isFinite(bounds.height)
    || bounds.width <= 0
    || bounds.height <= 0
  ) {
    return null;
  }

  const pixelRatio = Math.min(
    maxContactCanvasPixelRatio,
    Math.max(1, Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1),
  );

  return {
    width: Math.min(
      maxContactCanvasSide,
      Math.max(3, Math.ceil((bounds.width * 3 * pixelRatio) / 3) * 3),
    ),
    height: Math.min(
      maxContactCanvasSide,
      Math.max(3, Math.ceil((bounds.height * 3 * pixelRatio) / 3) * 3),
    ),
  };
}

function resizeContactMapCanvas(
  canvas: HTMLCanvasElement,
  frame: HTMLElement,
): boolean {
  const bounds = frame.getBoundingClientRect();
  const targetSize = contactCanvasBackingSizeFromBounds(bounds, window.devicePixelRatio || 1);
  if (!targetSize) {
    return false;
  }
  if (canvas.width === targetSize.width && canvas.height === targetSize.height) {
    return false;
  }
  canvas.width = targetSize.width;
  canvas.height = targetSize.height;
  return true;
}

function latestPointerCoordinates(event: PointerEvent) {
  const coalescedEvents = event.getCoalescedEvents?.() ?? [];
  const latest = coalescedEvents[coalescedEvents.length - 1] ?? event;
  return { clientX: latest.clientX, clientY: latest.clientY };
}

function drawContactMapBuffer(
  canvas: HTMLCanvasElement | null,
  contactMap: ContactMapView | null,
  uiState: UiState,
) {
  if (!canvas) {
    return;
  }

  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }
  context.imageSmoothingEnabled = false;

  const { width, height } = canvas;
  const frameWidth = width / 3;
  const frameHeight = height / 3;
  const frameOffsetX = frameWidth;
  const frameOffsetY = frameHeight;

  if (!contactMap) {
    context.clearRect(0, 0, width, height);
    drawEmptyGrid(context, width, height);
    return;
  }

  if (
    contactMap.tiles
    && contactMap.tiles.length === 0
    && (contactMap.cachedTiles?.length ?? 0) === 0
    && contactMap.cells.length === 0
  ) {
    return;
  }

  const viewportWidth = Math.max(1, contactMap.viewport.xEnd - contactMap.viewport.xStart);
  const viewportHeight = Math.max(1, contactMap.viewport.yEnd - contactMap.viewport.yStart);
  const bufferContactMap: ContactMapView = {
    ...contactMap,
    viewport: {
      xStart: Math.max(0, contactMap.viewport.xStart - viewportWidth),
      xEnd: contactMap.viewport.xEnd + viewportWidth,
      yStart: Math.max(0, contactMap.viewport.yStart - viewportHeight),
      yEnd: contactMap.viewport.yEnd + viewportHeight,
    },
  };
  const geometry = contactRenderGeometry({
    resolution: contactMap.resolution,
    viewportWidth,
    viewportHeight,
    canvasWidth: frameWidth,
    canvasHeight: frameHeight,
  });

  context.clearRect(0, 0, width, height);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);

  const drawCells = (cells: ContactMapCell[]) => {
    for (const cell of cells) {
      const xBase = cell.xBin * contactMap.resolution;
      const yBase = cell.yBin * contactMap.resolution;

      const x = frameOffsetX + ((xBase - contactMap.viewport.xStart) / viewportWidth) * frameWidth;
      const y = frameOffsetY + ((yBase - contactMap.viewport.yStart) / viewportHeight) * frameHeight;
      const intensity = normalizeContactValue(cell.count, uiState.contact.colorScale);

      context.fillStyle = contactColorCss(uiState.contact.colormap, intensity, 0.88);
      context.fillRect(x, y, geometry.widthPx, geometry.heightPx);
      if (cell.xBin !== cell.yBin) {
        const mirroredX = frameOffsetX + ((yBase - contactMap.viewport.xStart) / viewportWidth) * frameWidth;
        const mirroredY = frameOffsetY + ((xBase - contactMap.viewport.yStart) / viewportHeight) * frameHeight;
        context.fillRect(mirroredX, mirroredY, geometry.widthPx, geometry.heightPx);
      }
    }
  };

  drawCells(contactCellsForViewport(bufferContactMap, maxBufferedContactCells));
  if (contactMap.cachedTiles) {
    drawCells(contactCellsForViewport({ ...contactMap, cachedTiles: undefined }));
  }
}

function contactMapWithPannedViewport(
  contactMap: ContactMapView,
  deltaX: number,
  deltaY: number,
  width: number,
  height: number,
  totalSpanBp: number,
): ContactMapView {
  const viewportWidth = Math.max(1, contactMap.viewport.xEnd - contactMap.viewport.xStart);
  const viewportHeight = Math.max(1, contactMap.viewport.yEnd - contactMap.viewport.yStart);
  const deltaXBp = Math.round(-(deltaX / width) * viewportWidth);
  const deltaYBp = Math.round(-(deltaY / height) * viewportHeight);
  const safeTotalSpanBp = Math.max(1, totalSpanBp);
  const maxXStart = Math.max(0, safeTotalSpanBp - viewportWidth);
  const maxYStart = Math.max(0, safeTotalSpanBp - viewportHeight);
  const xStart = clamp(contactMap.viewport.xStart + deltaXBp, 0, maxXStart);
  const yStart = clamp(contactMap.viewport.yStart + deltaYBp, 0, maxYStart);

  return {
    ...contactMap,
    viewport: {
      xStart,
      xEnd: xStart + viewportWidth,
      yStart,
      yEnd: yStart + viewportHeight,
    },
  };
}

function drawEmptyGrid(context: CanvasRenderingContext2D, width: number, height: number) {
  context.fillStyle = "#eeeeee";
  context.fillRect(0, 0, width, height);
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
