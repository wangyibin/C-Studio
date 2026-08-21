import {
  ArrowDownLeft,
  ArrowDownRight,
  ArrowUpLeft,
  Maximize2,
  MoveDiagonal2,
  RotateCcw,
  Scissors,
  X,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ContactMapView, ExampleDatasetSummary } from "../App";
import {
  assemblyContigDisplayName,
  assemblyRenameTarget,
  buildAssemblyEditModel,
  contigIdsInScreenSelection,
  hasDeletableGap,
  hitTestAssemblyLayout,
  insertionTargetAtScreenPoint,
  selectedBlockIds,
  type AssemblyEditModel,
  type AssemblyHit,
  type AssemblySelection,
} from "../state/assemblyEditing";
import { assemblyShortcutIntent } from "../state/assemblyShortcuts";
import { contactColorLut } from "../state/contactColor";
import type { ContactPanPreview } from "../state/contactPanPerformance";
import type { ContactPanPrefetchBridge } from "../state/contactPanPrefetch";
import type { ContactTileDeltaRenderStream } from "../state/contactTileDelta";
import type { ContactTileRenderMilestone } from "../state/contactTilePerformance";
import {
  buildContactLayoutRasterPlan,
  contactLayoutRasterPlanCoversViewport,
} from "../state/contactLayoutPreview";
import { contactCellsForViewport } from "../state/contactMapView";
import { rasterizeContactMapCells } from "../state/contactMapRaster";
import { contactOverviewBaseIsCompatible } from "../state/contactOverviewTiles";
import { contactResolutionToBasePairs } from "../state/contactResolution";
import {
  buildCenteredContactViewport,
  type ContactViewport,
} from "../state/contactViewport";
import { contactTileViewportRequestKey } from "../state/contactTiles";
import {
  contactWheelNavigationMode,
  contactWheelPanMode,
  contactWheelPanIntent,
} from "../state/contactWheel";
export {
  contactWheelNavigationMode,
  contactWheelPanMode,
  contactWheelPanIntent,
} from "../state/contactWheel";
import type { CoverageView } from "../state/coverageView";
import type { ContactMapLayoutBlock } from "../state/importers";
import { defaultGfaHomologPattern } from "../state/gfaHomologLayout";
import { isEditableShortcutTarget } from "../state/juiceboxShortcuts";
import {
  availableContactResolutions,
  contactNormalizationForBackend,
  storedContactResolutionsForDataset,
  type ContactNormalization,
  type ContactResolution,
  type OperationRecord,
  type UiAction,
  type UiState,
} from "../state/uiState";
import {
  AssemblyContextMenu,
  type AssemblyContextMenuPosition,
} from "./AssemblyContextMenu";
import { ContactLayoutRasterPreview } from "./ContactLayoutRasterPreview";
import {
  ContactTileLayer,
  contactTileCanvasDescriptorsForViewport,
  type ContactTileLayerPaintEvent,
  type ContactTileOverscanAxisDirection,
  type ContactTileOverscanDirection,
} from "./ContactTileLayer";
import type {
  ContactTileGpuBoundary,
  ContactTileGpuRenderer,
} from "./contactTileGpu";
import { GenomeAxisNavigator } from "./GenomeAxisNavigator";
import { TrackPanel } from "./TrackPanel";

const usePrePaintEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

interface ContactMapViewportProps {
  dataset: ExampleDatasetSummary | null;
  assemblyBlocks?: ContactMapLayoutBlock[];
  contactMap: ContactMapView | null;
  contactTileDeltaStream?: ContactTileDeltaRenderStream | null;
  overviewContactMap?: ContactMapView | null;
  coverageView: CoverageView | null;
  uiState: UiState;
  homologPattern?: string;
  onUiAction: (action: UiAction) => void;
  useStoredResolutionOptions?: boolean;
  availableResolutionBasePairs?: number[];
  onClosePanel?: () => void;
  onExpandPanel?: () => void;
  onContactPanGestureStart?: () => void;
  onContactPanTilePrefetch?: (viewport: ContactViewport) => void;
  onContactViewportPreview?: (preview: ContactPanPreview | null) => void;
  contactPanPrefetchBridge?: ContactPanPrefetchBridge;
  onContactTileLayerCommit?: (event: ContactTileRenderMilestone) => void;
  onContactTileLayerPaintComplete?: (event: ContactTileRenderMilestone) => void;
}

interface DragState {
  pointerId: number;
  startViewport: ContactViewport;
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

interface WheelPanSession {
  sourceContactMap: ContactMapView;
  startViewport: ContactViewport;
  previewViewport: ContactViewport;
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
  targetObjectId?: string;
  chromosomeEnd?: "start" | "end";
}

interface AssemblyContextMenuState extends AssemblyContextMenuPosition {
  initialMode: "default" | "rename" | "delete";
}

interface AssemblyCutTargetInput {
  model: AssemblyEditModel;
  selectedIds: ReadonlySet<string>;
  lockedCutBlockId?: string | null;
  point: { x: number; y: number };
  widthPx: number;
  heightPx: number;
  viewportXStart: number;
  viewportXEnd: number;
  viewportYStart: number;
  viewportYEnd: number;
}

interface AssemblyPointerTargetInput extends AssemblyCutTargetInput {
  selectionKind?: AssemblySelection["kind"];
}

interface AssemblyPointerPosition {
  clientX: number;
  clientY: number;
}

export interface AssemblySelectionProjectionBands {
  vertical: { left: string; width: string } | null;
  horizontal: { top: string; height: string } | null;
}

/** Project one selected assembly interval across both contact-map axes. */
export function assemblySelectionProjectionBands(
  visualStart: number,
  visualEnd: number,
  viewport: ContactViewport,
): AssemblySelectionProjectionBands {
  const project = (start: number, end: number, viewportStart: number, viewportEnd: number) => {
    const span = Math.max(1, viewportEnd - viewportStart);
    const clippedStart = Math.max(start, viewportStart);
    const clippedEnd = Math.min(end, viewportEnd);
    if (clippedStart >= clippedEnd) {
      return null;
    }
    return {
      offset: `${((clippedStart - viewportStart) / span) * 100}%`,
      size: `${((clippedEnd - clippedStart) / span) * 100}%`,
    };
  };

  const x = project(visualStart, visualEnd, viewport.xStart, viewport.xEnd);
  const y = project(visualStart, visualEnd, viewport.yStart, viewport.yEnd);
  return {
    vertical: x ? { left: x.offset, width: x.size } : null,
    horizontal: y ? { top: y.offset, height: y.size } : null,
  };
}

const maxBufferedContactCells = 360_000;
const contactMapImageDataCache = new WeakMap<HTMLCanvasElement, ImageData>();
const shiftSelectionClassName = "shift-selection-active";
const resolutionWheelCooldownMs = 140;
// Coalesce a physical wheel burst into one committed UI viewport. Preview
// generations still start while the wheel is moving, so Windows WebView2 does
// not repeatedly cancel the first visible-tile stream before it can paint.
const wheelPanCommitDelayMs = 80;

export function contactWheelPanCommitDelta(
  startViewport: ContactViewport,
  previewViewport: ContactViewport,
) {
  const deltaXMb = (previewViewport.xStart - startViewport.xStart) / 1_000_000;
  const deltaYMb = (previewViewport.yStart - startViewport.yStart) / 1_000_000;
  return deltaXMb === 0 && deltaYMb === 0 ? null : { deltaXMb, deltaYMb };
}

export function contactPanCommitAction(
  startViewport: ContactViewport,
  previewViewport: ContactViewport,
  totalSpanMb: number,
): UiAction | null {
  return contactWheelPanCommitDelta(startViewport, previewViewport) === null
    ? null
    : {
        type: "commitContactViewportPan",
        viewport: previewViewport,
        totalSpanMb,
      };
}

export function contactPanPreviewTileSignature(
  viewport: ContactViewport,
  prefetchViewport: ContactViewport,
  resolution: number,
  tileSizeBins: number,
  totalSpanBp: number,
  urgentPrefetchTileCount = 0,
) {
  return contactTileViewportRequestKey(
    viewport,
    prefetchViewport,
    resolution,
    tileSizeBins,
    totalSpanBp,
    urgentPrefetchTileCount,
  );
}

/**
 * Pointer motion must not start a full React tile generation when the desktop
 * backend can warm its process-local tile cache instead. Repeated preview
 * generations are superseded at every crossed tile boundary and pointer-up
 * then has to restart the authoritative load, which can leave the newly
 * exposed viewport waiting on work that was just cancelled.
 */
export function contactPanPrefetchChannel(
  hasBackendPrefetch: boolean,
  hasViewportPreview: boolean,
): "backend" | "preview" | null {
  if (hasBackendPrefetch) {
    return "backend";
  }
  return hasViewportPreview ? "preview" : null;
}

/**
 * Recenter the lightweight chromosome-boundary mount window only after the
 * directional preview consumes half of its current one-viewport overscan.
 * This keeps future boxes mounted before they enter the clipped stage without
 * forcing a React overlay update for every pointer sample.
 */
export function advanceContactBoundaryMountViewport(
  current: ContactViewport | null,
  candidate: ContactViewport,
): ContactViewport {
  if (!current) {
    return candidate;
  }
  const xGuard = Math.max(1, current.xEnd - current.xStart) * 0.5;
  const yGuard = Math.max(1, current.yEnd - current.yStart) * 0.5;
  const remainsInsideGuard = candidate.xStart >= current.xStart - xGuard
    && candidate.xEnd <= current.xEnd + xGuard
    && candidate.yStart >= current.yStart - yGuard
    && candidate.yEnd <= current.yEnd + yGuard;
  return remainsInsideGuard ? current : candidate;
}

/**
 * Keep diagonal annotations mounted for one viewport beyond every visible
 * edge. The X/Y intersection is the only interval that can produce a square
 * on both axes, so unrelated off-axis blocks never become DOM nodes.
 */
export function contactBoundaryMountInterval(viewport: ContactViewport) {
  const xSpan = Math.max(1, viewport.xEnd - viewport.xStart);
  const ySpan = Math.max(1, viewport.yEnd - viewport.yStart);
  return {
    start: Math.max(viewport.xStart - xSpan, viewport.yStart - ySpan),
    end: Math.min(viewport.xEnd + xSpan, viewport.yEnd + ySpan),
  };
}

export function contactGpuAssemblyBoundaries({
  model,
  selection,
  showChromosomeBoxes,
  showBlockBoxes,
  showContigBoxes,
}: {
  model: AssemblyEditModel;
  selection: UiState["assembly"]["selection"];
  showChromosomeBoxes: boolean;
  showBlockBoxes: boolean;
  showContigBoxes: boolean;
}): ContactTileGpuBoundary[] {
  const selectedContigIds = new Set(selectedBlockIds(model.blocks, selection));
  const selectedUnitIds = new Set(
    model.assemblyBlocks
      .filter((block) => block.contigIds.some((id) => selectedContigIds.has(id)))
      .map((block) => block.id),
  );
  const compositeContigIds = new Set(
    model.assemblyBlocks
      .filter((block) => block.isComposite)
      .flatMap((block) => block.contigIds),
  );
  const boundaries: ContactTileGpuBoundary[] = [];
  const append = (
    visualStart: number,
    visualEnd: number,
    color: ContactTileGpuBoundary["color"],
    lineWidthCssPx: number,
    minimumSpanCssPx: number,
  ) => {
    if (Number.isFinite(visualStart) && Number.isFinite(visualEnd) && visualEnd > visualStart) {
      boundaries.push({
        visualStart,
        visualEnd,
        color,
        lineWidthCssPx,
        minimumSpanCssPx,
      });
    }
  };

  if (showChromosomeBoxes) {
    for (const chromosome of model.chromosomes) {
      const selected = selection?.kind === "chromosome" && selection.id === chromosome.id;
      append(
        chromosome.visualStart,
        chromosome.visualEnd,
        selected ? [0.98, 0.8, 0.08] : [0.22, 0.65, 1],
        1,
        0,
      );
    }
  }
  for (const block of model.assemblyBlocks) {
    const visible = block.isComposite
      ? showBlockBoxes
      : showBlockBoxes || showContigBoxes;
    if (!visible) {
      continue;
    }
    const selected = selectedUnitIds.has(block.id);
    append(
      block.visualStart,
      block.visualEnd,
      selected ? [0, 0, 0] : [0.13, 0.77, 0.37],
      selected ? 2 : block.isComposite ? 1 : 0.5,
      selected ? 0 : 1,
    );
  }
  if (showContigBoxes) {
    for (const contig of model.blocks) {
      if (!compositeContigIds.has(contig.id)) {
        continue;
      }
      append(contig.visualStart, contig.visualEnd, [0, 0, 0], 0.5, 1);
    }
  }
  return boundaries;
}

interface ContactResolutionWheelInput {
  deltaX: number;
  deltaY: number;
  ctrlKey: boolean;
  metaKey: boolean;
  currentResolution: ContactResolution;
  resolutionOptions: readonly ContactResolution[];
}

/** Resolve one modified wheel gesture into the adjacent displayed pyramid level. */
export function contactResolutionWheelIntent({
  deltaX,
  deltaY,
  ctrlKey,
  metaKey,
  currentResolution,
  resolutionOptions,
}: ContactResolutionWheelInput): ContactResolution | null {
  if ((!ctrlKey && !metaKey) || resolutionOptions.length === 0) {
    return null;
  }
  const wheelDelta = Math.abs(deltaY) >= Math.abs(deltaX) ? deltaY : deltaX;
  if (!Number.isFinite(wheelDelta) || wheelDelta === 0) {
    return null;
  }
  const currentIndex = resolutionOptions.indexOf(currentResolution);
  if (currentIndex < 0) {
    return null;
  }
  const nextIndex = wheelDelta < 0
    ? Math.min(resolutionOptions.length - 1, currentIndex + 1)
    : Math.max(0, currentIndex - 1);
  return resolutionOptions[nextIndex] === currentResolution
    ? null
    : resolutionOptions[nextIndex] ?? null;
}

export function lockedContactResolutionWheelZoomIntent(
  deltaX: number,
  deltaY: number,
  clientX: number,
  clientY: number,
  bounds: Pick<DOMRect, "left" | "top" | "width" | "height">,
  totalSpanMb: number,
): UiAction | null {
  const wheelDelta = Math.abs(deltaY) >= Math.abs(deltaX) ? deltaY : deltaX;
  if (!Number.isFinite(wheelDelta) || wheelDelta === 0) return null;
  const focusRatioX = bounds.width > 0 ? clamp01((clientX - bounds.left) / bounds.width) : 0.5;
  const focusRatioY = bounds.height > 0 ? clamp01((clientY - bounds.top) / bounds.height) : 0.5;
  return {
    type: "zoomContactViewport",
    direction: wheelDelta < 0 ? "in" : "out",
    focusRatioX,
    focusRatioY,
    scaleFactor: Math.min(2, Math.max(0.5, Math.exp(-wheelDelta * 0.002))),
    totalSpanMb,
  };
}

export type AssemblyShiftClickIntent =
  | { type: "clear-selection" }
  | { type: "select-contig"; id: string; additive: boolean }
  | { type: "select-chromosome"; id: string };

export function assemblyShiftClickIntent(
  _hasSelection: boolean,
  hit: AssemblyHit | null,
  _hitIsSelected = false,
): AssemblyShiftClickIntent {
  if (hit === null) {
    return { type: "clear-selection" };
  }

  return hit.kind === "contig"
    ? { type: "select-contig", id: hit.id, additive: false }
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

export function contactTileOverscanDirectionForViewports(
  source: ContactViewport,
  target: ContactViewport,
): ContactTileOverscanDirection {
  const axisDirection = (delta: number): ContactTileOverscanAxisDirection => (
    delta < 0 ? -1 : delta > 0 ? 1 : 0
  );
  return {
    x: axisDirection(
      (target.xStart + target.xEnd) - (source.xStart + source.xEnd),
    ),
    y: axisDirection(
      (target.yStart + target.yEnd) - (source.yStart + source.yEnd),
    ),
  };
}

/**
 * Keep the fully painted layer in its own camera while a selected viewport,
 * resolution, or normalization is still loading. Reprojecting an old tile set
 * into a newly committed pan viewport exposes the coarse overview underneath;
 * expanding it into a whole-genome viewport can also make the surface blank
 * and force the renderer to reconsider a much larger cached set.
 * A terminal screen LOD opts out only while it still fulfills the current
 * selection; on the next resolution change it becomes the retained old frame.
 */
export function shouldRetainPresentedContactViewport(
  contactMap: (Pick<
    ContactMapView,
    "isTransientResolutionPreview" | "normalization" | "requestedResolution" | "resolution"
  > & Partial<Pick<ContactMapView, "viewport">>) | null,
  selectedResolution: number,
  selectedNormalization: ContactNormalization,
  selectedViewport?: ContactViewport,
): boolean {
  if (!contactMap) {
    return false;
  }
  const viewportChanged = Boolean(
    selectedViewport
    && contactMap.viewport
    && (
      contactMap.viewport.xStart !== selectedViewport.xStart
      || contactMap.viewport.xEnd !== selectedViewport.xEnd
      || contactMap.viewport.yStart !== selectedViewport.yStart
      || contactMap.viewport.yEnd !== selectedViewport.yEnd
    ),
  );
  const normalizationChanged = contactMap.normalization !== undefined
    && contactMap.normalization !== selectedNormalization;
  if (contactMap.isTransientResolutionPreview === false) {
    return viewportChanged || (
      contactMap.requestedResolution !== undefined
      && (
        contactMap.requestedResolution !== selectedResolution
        || normalizationChanged
      )
    );
  }
  return viewportChanged
    || contactMap.resolution !== selectedResolution
    || normalizationChanged;
}

export interface ContactCoveragePresentationFrame {
  datasetKey: string;
  contactMap: ContactMapView;
  coverageView: CoverageView;
}

export interface PaintedContactPresentationFrame {
  datasetKey: string;
  contactMap: ContactMapView;
  coverageView: CoverageView | null;
}

export const maximumAssemblyOverlayIntervals = 2_048;
export const minimumAssemblyOverlayIntervalWidthPx = 1;

interface AssemblyOverlayInterval {
  id: string;
  visualStart: number;
  visualEnd: number;
}

/** Individual subpixel blocks are not visible, so do not turn them into DOM nodes. */
export function limitAssemblyOverlayIntervals<T extends AssemblyOverlayInterval>(
  intervals: readonly T[],
  viewportStart: number,
  viewportEnd: number,
  viewportWidthPx: number,
  priorityIds: ReadonlySet<string> = new Set(),
  maximumIntervals = maximumAssemblyOverlayIntervals,
): T[] {
  if (
    !Number.isFinite(viewportStart)
    || !Number.isFinite(viewportEnd)
    || viewportEnd <= viewportStart
  ) {
    return [];
  }
  const safeWidth = Number.isFinite(viewportWidthPx)
    ? Math.max(1, Math.ceil(viewportWidthPx))
    : 1;
  const hardLimit = Math.max(
    1,
    Math.min(
      maximumAssemblyOverlayIntervals,
      Math.floor(Number.isFinite(maximumIntervals) ? maximumIntervals : 1),
      safeWidth,
    ),
  );
  const minimumSpan = (
    (viewportEnd - viewportStart) / safeWidth
  ) * minimumAssemblyOverlayIntervalWidthPx;
  const intersecting = intervals.filter((interval) => (
    interval.visualEnd > viewportStart
    && interval.visualStart < viewportEnd
  ));
  if (intersecting.length <= hardLimit) {
    return intersecting;
  }
  const visible = intersecting.filter((interval) => (
    priorityIds.has(interval.id)
    || interval.visualEnd - interval.visualStart >= minimumSpan
  ));
  if (visible.length <= hardLimit) {
    return visible;
  }

  const priority = visible.filter((interval) => priorityIds.has(interval.id));
  const ordinary = visible.filter((interval) => !priorityIds.has(interval.id));
  const sampleEvenly = (source: T[], count: number) => {
    if (source.length <= count) {
      return source;
    }
    return Array.from({ length: count }, (_, index) => (
      source[Math.min(
        source.length - 1,
        Math.floor((index + 0.5) * source.length / count),
      )]
    ));
  };
  const retainedPriority = sampleEvenly(priority, hardLimit);
  const retainedOrdinary = sampleEvenly(
    ordinary,
    Math.max(0, hardLimit - retainedPriority.length),
  );
  return [...retainedPriority, ...retainedOrdinary].sort((left, right) => (
    left.visualStart - right.visualStart || left.visualEnd - right.visualEnd
  ));
}

/** Coverage and heatmap may be computed independently, but must be presented as one generation. */
export function contactCoverageFramesMatch(
  contactMap: ContactMapView | null,
  coverageView: CoverageView | null,
) {
  if (
    !contactMap
    || !coverageView
    || contactMap.visibleLayerComplete === false
  ) {
    return false;
  }
  const requestedResolution = contactMap.requestedResolution ?? contactMap.resolution;
  const generationsMatch = contactMap.renderGeneration === undefined
    ? coverageView.renderGeneration === undefined
    : coverageView.renderGeneration === contactMap.renderGeneration;
  return generationsMatch
    && coverageView.resolution === requestedResolution
    && Math.abs(coverageView.viewport.xStart - contactMap.viewport.xStart) <= 1
    && Math.abs(coverageView.viewport.xEnd - contactMap.viewport.xEnd) <= 1;
}

export function advanceContactCoveragePresentationFrame(
  current: ContactCoveragePresentationFrame | null,
  datasetKey: string,
  contactMap: ContactMapView | null,
  coverageView: CoverageView | null,
): ContactCoveragePresentationFrame | null {
  if (contactCoverageFramesMatch(contactMap, coverageView)) {
    if (
      current?.datasetKey === datasetKey
      && current.contactMap === contactMap
      && current.coverageView === coverageView
    ) {
      return current;
    }
    return { datasetKey, contactMap: contactMap!, coverageView: coverageView! };
  }
  return current?.datasetKey === datasetKey ? current : null;
}

/**
 * Publish annotations only after the matching tile generation is actually on
 * the presented surface. This keeps the old viewport, chromosome borders, and
 * coverage mounted while the replacement heatmap is still in its back buffer.
 */
export function advancePaintedContactPresentationFrame(
  current: PaintedContactPresentationFrame | null,
  target: PaintedContactPresentationFrame | null,
  paintedGeneration: number | undefined,
): PaintedContactPresentationFrame | null {
  if (!target) {
    return null;
  }
  const currentForDataset = current?.datasetKey === target.datasetKey ? current : null;
  const targetGeneration = target.contactMap.renderGeneration;
  if (
    targetGeneration === undefined
    || targetGeneration === paintedGeneration
    || currentForDataset?.contactMap.renderGeneration === targetGeneration
  ) {
    return target;
  }
  return currentForDataset;
}

/** Resolve a selected contig diagonal under the pointer, including compact boxes at whole-genome scale. */
export function assemblyCutTargetAtScreenPoint({
  model,
  selectedIds,
  lockedCutBlockId = null,
  point,
  widthPx,
  heightPx,
  viewportXStart,
  viewportXEnd,
  viewportYStart,
  viewportYEnd,
}: AssemblyCutTargetInput): { blockId: string; visualPosition: number } | null {
  const safeWidthPx = Math.max(1, widthPx);
  const safeHeightPx = Math.max(1, heightPx);
  const viewportXSpan = Math.max(1, viewportXEnd - viewportXStart);
  const viewportYSpan = Math.max(1, viewportYEnd - viewportYStart);
  const maxEdgeGuardPx = 18;
  const acquireTolerancePx = 12;
  const releaseTolerancePx = 36;

  interface CutCandidate {
    blockId: string;
    visualPosition: number;
    distancePx: number;
  }

  const candidateForBlock = (
    block: ContactMapLayoutBlock,
    tolerancePx: number,
  ): CutCandidate | null => {
    const blockSpan = block.visualEnd - block.visualStart;
    if (blockSpan <= 0) {
      return null;
    }

    // Use one genomic coordinate for both axes. This is the real x=y contig
    // diagonal even when the contact viewport is rectangular or independently
    // panned on X and Y.
    const fullDiagonalLengthPx = Math.hypot(
      (blockSpan / viewportXSpan) * safeWidthPx,
      (blockSpan / viewportYSpan) * safeHeightPx,
    );
    const edgeGuardPx = Math.min(
      maxEdgeGuardPx,
      Math.max(1, fullDiagonalLengthPx * 0.2),
    );
    const edgeGuardFraction = Math.min(
      0.2,
      edgeGuardPx / Math.max(1, fullDiagonalLengthPx),
    );
    const safeVisualStart = block.visualStart + blockSpan * edgeGuardFraction;
    const safeVisualEnd = block.visualEnd - blockSpan * edgeGuardFraction;
    const visibleStart = Math.max(
      safeVisualStart,
      viewportXStart,
      viewportYStart,
    );
    const visibleEnd = Math.min(
      safeVisualEnd,
      viewportXEnd,
      viewportYEnd,
    );
    if (visibleStart >= visibleEnd) {
      return null;
    }

    const startX = ((visibleStart - viewportXStart) / viewportXSpan) * safeWidthPx;
    const startY = ((visibleStart - viewportYStart) / viewportYSpan) * safeHeightPx;
    const endX = ((visibleEnd - viewportXStart) / viewportXSpan) * safeWidthPx;
    const endY = ((visibleEnd - viewportYStart) / viewportYSpan) * safeHeightPx;
    const diagonalX = endX - startX;
    const diagonalY = endY - startY;
    const diagonalLengthSquared = diagonalX * diagonalX + diagonalY * diagonalY;
    if (diagonalLengthSquared <= 0) {
      return null;
    }

    const projectionRatio = clamp01(
      ((point.x - startX) * diagonalX + (point.y - startY) * diagonalY)
      / diagonalLengthSquared,
    );
    const projectedX = startX + projectionRatio * diagonalX;
    const projectedY = startY + projectionRatio * diagonalY;
    const distancePx = Math.hypot(point.x - projectedX, point.y - projectedY);
    if (distancePx > tolerancePx) {
      return null;
    }

    return {
      blockId: block.id,
      visualPosition: Math.round(
        visibleStart + projectionRatio * (visibleEnd - visibleStart),
      ),
      distancePx,
    };
  };

  // Once acquired, keep the same contig locked inside a wider corridor. The
  // scissors follows the projected diagonal point and releases only after the
  // pointer clearly leaves that corridor.
  if (lockedCutBlockId && selectedIds.has(lockedCutBlockId)) {
    const lockedBlock = model.blocks.find((block) => block.id === lockedCutBlockId);
    if (lockedBlock) {
      const lockedCandidate = candidateForBlock(lockedBlock, releaseTolerancePx);
      if (lockedCandidate) {
        return {
          blockId: lockedCandidate.blockId,
          visualPosition: lockedCandidate.visualPosition,
        };
      }
    }
  }

  let closestCandidate: CutCandidate | null = null;
  for (const block of model.blocks) {
    if (!selectedIds.has(block.id)) {
      continue;
    }
    const candidate = candidateForBlock(block, acquireTolerancePx);
    if (candidate && (!closestCandidate || candidate.distancePx < closestCandidate.distancePx)) {
      closestCandidate = candidate;
    }
  }

  return closestCandidate
    ? {
        blockId: closestCandidate.blockId,
        visualPosition: closestCandidate.visualPosition,
      }
    : null;
}

/** Resolve the current cut/insert/select affordance from one screen point. */
export function assemblyPointerStateAtScreenPoint(
  input: AssemblyPointerTargetInput,
): AssemblyPointerState {
  if (input.selectedIds.size === 0) {
    return { kind: "select", blockId: null, visualPosition: null };
  }

  const cutTarget = assemblyCutTargetAtScreenPoint(input);
  if (cutTarget) {
    return {
      kind: "cut",
      blockId: cutTarget.blockId,
      visualPosition: cutTarget.visualPosition,
    };
  }

  const insertTarget = insertionTargetAtScreenPoint(
    input.model,
    input.selectedIds,
    input.point,
    {
      widthPx: Math.max(1, input.widthPx),
      heightPx: Math.max(1, input.heightPx),
      tolerancePx: 7,
      viewportXStart: input.viewportXStart,
      viewportXEnd: input.viewportXEnd,
      viewportYStart: input.viewportYStart,
      viewportYEnd: input.viewportYEnd,
      selectionKind: input.selectionKind,
    },
  );
  if (insertTarget) {
    return {
      kind: "insert",
      blockId: insertTarget.targetBlockId,
      visualPosition: insertTarget.visualPosition,
      targetObjectId: insertTarget.targetObjectId,
      chromosomeEnd: insertTarget.chromosomeEnd,
    };
  }

  return { kind: "select", blockId: null, visualPosition: null };
}

function setShiftSelectionCursor(active: boolean) {
  document.documentElement.classList.toggle(shiftSelectionClassName, active);
}

export function ContactMapViewport({
  assemblyBlocks: displayAssemblyBlocks,
  contactMap: incomingContactMap,
  contactTileDeltaStream,
  overviewContactMap,
  coverageView: incomingCoverageView,
  dataset,
  onContactTileLayerCommit,
  onContactTileLayerPaintComplete,
  onUiAction,
  onContactPanGestureStart,
  onContactPanTilePrefetch,
  onContactViewportPreview,
  contactPanPrefetchBridge,
  useStoredResolutionOptions = false,
  availableResolutionBasePairs = [],
  onClosePanel,
  onExpandPanel,
  uiState,
  homologPattern = defaultGfaHomologPattern,
}: ContactMapViewportProps) {
  const mapLayoutRef = useRef<HTMLDivElement>(null);
  const mapContentRef = useRef<HTMLDivElement>(null);
  const canvasFrameRef = useRef<HTMLDivElement>(null);
  const contactTileLayerRef = useRef<HTMLDivElement>(null);
  const contactTileTransformRef = useRef<HTMLDivElement>(null);
  const contactTilePanRendererRef = useRef<ContactTileGpuRenderer | null>(null);
  const panPrefetchPresentFrameRef = useRef<number | null>(null);
  useEffect(() => {
    const presentPendingDescriptors = () => {
      if (panPrefetchPresentFrameRef.current !== null) {
        return;
      }
      panPrefetchPresentFrameRef.current = window.requestAnimationFrame(() => {
        panPrefetchPresentFrameRef.current = null;
        // Tile completion may happen while the pointer is stationary. Present
        // only appended or refreshed quads so the exposed edge fills and each
        // cumulative batch appears immediately, without a React map frame.
        contactTilePanRendererRef.current?.presentAppendedSceneDescriptors();
      });
    };
    const unsubscribe = contactPanPrefetchBridge?.subscribe((batch) => {
      const renderer = contactTilePanRendererRef.current;
      if (!renderer) {
        return;
      }
      if (renderer.appendSceneDescriptors({
        descriptors: contactTileCanvasDescriptorsForViewport(
          batch.tiles,
          batch.resolution,
          batch.tileSizeBins,
          batch.viewport,
          "all",
        ),
        generation: batch.generation,
        resolution: batch.resolution,
        tileSizeBins: batch.tileSizeBins,
      })) {
        presentPendingDescriptors();
      }
    });
    return () => {
      unsubscribe?.();
      if (panPrefetchPresentFrameRef.current !== null) {
        window.cancelAnimationFrame(panPrefetchPresentFrameRef.current);
        panPrefetchPresentFrameRef.current = null;
      }
    };
  }, [contactPanPrefetchBridge]);
  const assemblyOverlayLayerRef = useRef<HTMLDivElement>(null);
  const assemblySelectionVerticalBandRef = useRef<HTMLSpanElement>(null);
  const assemblySelectionHorizontalBandRef = useRef<HTMLSpanElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const latestContactMapRef = useRef<ContactMapView | null>(null);
  const latestDisplayContactMapRef = useRef<ContactMapView | null>(null);
  const latestUiStateRef = useRef(uiState);
  latestUiStateRef.current = uiState;
  const resolutionWheelReadyAtRef = useRef(0);
  const [contextMenu, setContextMenu] = useState<AssemblyContextMenuState | null>(null);
  const contextMenuRef = useRef(contextMenu);
  contextMenuRef.current = contextMenu;
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false);
  const deleteConfirmationOpenRef = useRef(deleteConfirmationOpen);
  deleteConfirmationOpenRef.current = deleteConfirmationOpen;
  const [dragState, setDragState] = useState<DragState | null>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const panLoadingSuspendedRef = useRef(false);
  const panTilePrefetchSignatureRef = useRef<string | null>(null);
  const panPreviewSequenceRef = useRef(0);
  const wheelPanSessionRef = useRef<WheelPanSession | null>(null);
  const wheelPanCommitTimerRef = useRef<number | null>(null);
  const [assemblyBoundaryPanViewport, setAssemblyBoundaryPanViewport] = useState<
    ContactViewport | null
  >(null);
  const assemblyBoundaryPanViewportRef = useRef<ContactViewport | null>(null);
  const [gpuAssemblyBoundariesActive, setGpuAssemblyBoundariesActive] = useState(() => (
    typeof document !== "undefined"
    && Boolean(
      incomingContactMap?.tiles
      || incomingContactMap?.cachedTiles
      || incomingContactMap?.previewTiles
    )
  ));
  const panAnimationFrameRef = useRef<number | null>(null);
  const redrawAnimationFrameRef = useRef<number | null>(null);
  const prepaintedCellContactMapRef = useRef<ContactMapView | null>(null);
  const pendingPanFrameRef = useRef<PendingPanFrame | null>(null);
  const [assemblySelectionDrag, setAssemblySelectionDrag] = useState<AssemblySelectionDragState | null>(null);
  const [assemblyPointerState, setAssemblyPointerState] = useState<AssemblyPointerState>({
    kind: "select",
    blockId: null,
    visualPosition: null,
  });
  const assemblyPointerStateRef = useRef(assemblyPointerState);
  const lastAssemblyPointerRef = useRef<AssemblyPointerPosition | null>(null);
  const [tilePresentedSurfaceRevision, setTilePresentedSurfaceRevision] = useState(0);
  const [presentedContactCoverageFrame, setPresentedContactCoverageFrame] = useState<
    ContactCoveragePresentationFrame | null
  >(null);
  const [paintedContactPresentationFrame, setPaintedContactPresentationFrame] = useState<
    PaintedContactPresentationFrame | null
  >(null);
  const targetContactPresentationFrameRef = useRef<PaintedContactPresentationFrame | null>(null);
  const tileRenderStyle = useMemo(() => ({
    colormap: uiState.contact.colormap,
    colorScale: uiState.contact.colorScale,
  }), [uiState.contact.colormap, uiState.contact.colorScale]);
  const reportPresentedSurfaceChange = useCallback(() => {
    setTilePresentedSurfaceRevision((revision) => revision + 1);
  }, []);
  const reportTileLayerCommit = useCallback((event: ContactTileLayerPaintEvent) => {
    if (event.paintRevision !== undefined) {
      onContactTileLayerCommit?.({
        renderEpoch: event.renderEpoch,
        canvasCount: event.canvasCount,
        generation: event.paintRevision,
        commitTimestamp: event.commitTimestamp,
      });
    }
  }, [onContactTileLayerCommit]);
  const reportTileLayerPaintComplete = useCallback((event: ContactTileLayerPaintEvent) => {
    const target = targetContactPresentationFrameRef.current?.contactMap;
    if (
      event.paintRevision !== undefined
      && target?.renderGeneration === event.paintRevision
    ) {
      // The translated front remains visible while this generation paints in
      // the hidden slot. Rebase the heatmap and annotations only when that
      // complete target is being atomically revealed.
      resetPanTransform();
    }
    setPaintedContactPresentationFrame((current) => advancePaintedContactPresentationFrame(
      current,
      targetContactPresentationFrameRef.current,
      event.paintRevision,
    ));
    if (event.paintRevision !== undefined) {
      onContactTileLayerPaintComplete?.({
        renderEpoch: event.renderEpoch,
        canvasCount: event.canvasCount,
        generation: event.paintRevision,
        commitTimestamp: event.commitTimestamp,
      });
    }
  }, [onContactTileLayerPaintComplete]);
  const hasContactMap = Boolean(dataset?.mcool_path);
  const contactSize = dataset?.mcool_size_bytes ? formatBytes(dataset.mcool_size_bytes) : null;
  const hasCoverageTrack = Boolean(dataset?.coverage_path || incomingCoverageView);
  const activeAssemblyBlocks = displayAssemblyBlocks ?? (
    uiState.assembly.blocks.length > 0
      ? uiState.assembly.blocks
      : dataset?.agp_layout.blocks ?? []
  );
  const compatibleOverviewContactMap = useMemo(
    () => contactOverviewBaseIsCompatible(
      overviewContactMap ?? null,
      activeAssemblyBlocks,
      contactNormalizationForBackend(uiState.normalization),
    )
      ? overviewContactMap ?? null
      : null,
    [activeAssemblyBlocks, overviewContactMap, uiState.normalization],
  );
  const activeAssemblyTotalBp = useMemo(
    () => activeAssemblyBlocks.reduce(
      (largestEnd, block) => Math.max(largestEnd, block.visualEnd),
      0,
    ),
    [activeAssemblyBlocks],
  );
  const liveTotalSpanBp = Math.max(
    1,
    displayAssemblyBlocks !== undefined
      ? activeAssemblyTotalBp
      : activeAssemblyTotalBp
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
  const presentationDatasetKey = `${dataset?.mcool_path ?? ""}|${dataset?.coverage_path ?? ""}`;
  usePrePaintEffect(() => {
    setPresentedContactCoverageFrame((current) => advanceContactCoveragePresentationFrame(
      current,
      presentationDatasetKey,
      incomingContactMap,
      incomingCoverageView,
    ));
  }, [
    incomingContactMap,
    incomingCoverageView,
    presentationDatasetKey,
  ]);
  const synchronizedFrame = presentedContactCoverageFrame?.datasetKey === presentationDatasetKey
    ? presentedContactCoverageFrame
    : null;
  const usesAtomicCoverageFrame = Boolean(
    hasCoverageTrack
    && uiState.tracks.coverageVisible
    && synchronizedFrame,
  );
  const contactMap = usesAtomicCoverageFrame
    ? synchronizedFrame!.contactMap
    : incomingContactMap;
  const coverageView = usesAtomicCoverageFrame
    ? synchronizedFrame!.coverageView
    : incomingCoverageView;
  const renderGeneration = contactMap?.renderGeneration;
  const freezePresentedTileStyle = shouldRetainPresentedContactViewport(
    contactMap,
    contactResolutionToBasePairs(uiState.contact.resolution),
    contactNormalizationForBackend(uiState.normalization),
    liveViewport,
  );
  const usesTiledRenderer = Boolean(
    contactMap?.tiles || contactMap?.cachedTiles || contactMap?.previewTiles,
  );
  const targetContactPresentationFrame = useMemo<PaintedContactPresentationFrame | null>(
    () => contactMap ? {
      datasetKey: presentationDatasetKey,
      contactMap,
      coverageView,
    } : null,
    [contactMap, coverageView, presentationDatasetKey],
  );
  targetContactPresentationFrameRef.current = targetContactPresentationFrame;
  usePrePaintEffect(() => {
    setPaintedContactPresentationFrame((current) => advancePaintedContactPresentationFrame(
      current,
      targetContactPresentationFrame,
      usesTiledRenderer ? undefined : renderGeneration,
    ));
  }, [renderGeneration, targetContactPresentationFrame, usesTiledRenderer]);
  const paintedPresentationFrame = paintedContactPresentationFrame?.datasetKey === presentationDatasetKey
    ? paintedContactPresentationFrame
    : null;
  const waitsForTilePaint = usesTiledRenderer && renderGeneration !== undefined;
  const presentationFrame = waitsForTilePaint
    ? paintedPresentationFrame
    : targetContactPresentationFrame;
  const presentationContactMap = presentationFrame?.contactMap ?? contactMap;
  const presentationCoverageView = presentationFrame?.coverageView ?? (
    waitsForTilePaint ? null : coverageView
  );
  const presentationReady = !waitsForTilePaint || presentationFrame !== null;
  // Resolution changes may update the requested viewport immediately. Until
  // the replacement frame is ready, keep the complete front buffer and all of
  // its overlays in the camera in which it was painted.
  const tileLiveViewport = freezePresentedTileStyle && contactMap
    ? contactMap.viewport
    : liveViewport;
  const tileDisplayViewport = dragState?.previewViewport ?? tileLiveViewport;
  const freezePresentedAnnotationViewport = shouldRetainPresentedContactViewport(
    presentationContactMap,
    contactResolutionToBasePairs(uiState.contact.resolution),
    contactNormalizationForBackend(uiState.normalization),
    liveViewport,
  );
  const presentedLiveViewport = freezePresentedAnnotationViewport && presentationContactMap
    ? presentationContactMap.viewport
    : liveViewport;
  const displayViewport = dragState?.previewViewport ?? presentedLiveViewport;
  usePrePaintEffect(() => {
    // The retained front, axes, and annotations stay in the source camera until
    // the painted presentation frame reaches this target viewport. React has now
    // projected every layer into target coordinates, so clear the imperative pan
    // offset once, before the browser can paint either coordinate system alone.
    resetPanTransform();
  }, [
    displayViewport.xEnd,
    displayViewport.xStart,
    displayViewport.yEnd,
    displayViewport.yStart,
  ]);
  // Keep the same overscanned boundary population across pointer release.
  // Falling back to the committed viewport only when it leaves the guard
  // avoids the old release-time unmount/remount pass.
  const assemblyBoundaryMountViewport = assemblyBoundaryPanViewport
    && advanceContactBoundaryMountViewport(
      assemblyBoundaryPanViewport,
      displayViewport,
    ) === assemblyBoundaryPanViewport
    ? assemblyBoundaryPanViewport
    : displayViewport;
  const historyPreviewOperation = useMemo(
    () => uiState.historyPreviewOperationId === null
      ? null
      : [...uiState.operationHistory, ...uiState.redoStack]
          .find((operation) => operation.id === uiState.historyPreviewOperationId) ?? null,
    [uiState.historyPreviewOperationId, uiState.operationHistory, uiState.redoStack],
  );
  const liveContactMap = useMemo(
    () => presentationContactMap ? { ...presentationContactMap, viewport: liveViewport } : null,
    [liveViewport, presentationContactMap],
  );
  const displayContactMap = useMemo(
    () => presentationContactMap ? { ...presentationContactMap, viewport: displayViewport } : null,
    [displayViewport, presentationContactMap],
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
    : presentationContactMap?.layoutBlocks ?? activeAssemblyBlocks;
  // The raster preview is a temporary 2D surface layered above WebGL. Keep the
  // DOM outline fallback only for that short edit preview (or when WebGL is
  // unavailable); ordinary navigation leaves every visual boundary on the GPU.
  const usesDomAssemblyBoundaries = !gpuAssemblyBoundariesActive || showsLayoutRasterPreview;
  const assemblyModel = useMemo(() => buildAssemblyEditModel(assemblyBlocks), [assemblyBlocks]);
  const gpuAssemblyBoundaries = useMemo(
    () => contactGpuAssemblyBoundaries({
      model: assemblyModel,
      selection: uiState.assembly.selection,
      showChromosomeBoxes: uiState.assembly.showChromosomeBoxes,
      showBlockBoxes: uiState.assembly.showBlockBoxes,
      showContigBoxes: uiState.assembly.showContigBoxes,
    }),
    [
      assemblyModel,
      uiState.assembly.selection,
      uiState.assembly.showBlockBoxes,
      uiState.assembly.showChromosomeBoxes,
      uiState.assembly.showContigBoxes,
    ],
  );
  const selectedAssemblyBlockIds = useMemo(
    () => new Set(selectedBlockIds(assemblyModel.blocks, uiState.assembly.selection)),
    [assemblyModel, uiState.assembly.selection],
  );
  const selectedAssemblyUnitIds = useMemo(
    () => new Set(
      assemblyModel.assemblyBlocks
        .filter((block) => block.contigIds.some((id) => selectedAssemblyBlockIds.has(id)))
        .map((block) => block.id),
    ),
    [assemblyModel, selectedAssemblyBlockIds],
  );
  const compositeAssemblyContigIds = useMemo(
    () => new Set(
      assemblyModel.assemblyBlocks
        .filter((block) => block.isComposite)
        .flatMap((block) => block.contigIds),
    ),
    [assemblyModel],
  );
  const showsCompositeContigLayer = uiState.assembly.showContigBoxes
    && compositeAssemblyContigIds.size > 0;
  const boundaryMountInterval = contactBoundaryMountInterval(assemblyBoundaryMountViewport);
  const boundaryMountWidthPx = Math.max(1, uiState.contact.viewportWidthPx * 3);
  const overlayLayerCount = (
    uiState.assembly.showBlockBoxes || uiState.assembly.showContigBoxes ? 1 : 0
  ) + (showsCompositeContigLayer ? 1 : 0);
  const overlayIntervalBudget = Math.max(
    1,
    Math.floor(
      Math.min(
        maximumAssemblyOverlayIntervals,
        boundaryMountWidthPx,
      ) / Math.max(1, overlayLayerCount),
    ),
  );
  const visibleAssemblyContigs = useMemo(
    () => !usesDomAssemblyBoundaries ? [] : limitAssemblyOverlayIntervals(
      assemblyModel.blocks.filter((block) => compositeAssemblyContigIds.has(block.id)),
      boundaryMountInterval.start,
      boundaryMountInterval.end,
      boundaryMountWidthPx,
      selectedAssemblyBlockIds,
      overlayIntervalBudget,
    ),
    [
      assemblyModel,
      boundaryMountInterval.end,
      boundaryMountInterval.start,
      boundaryMountWidthPx,
      compositeAssemblyContigIds,
      overlayIntervalBudget,
      selectedAssemblyBlockIds,
      usesDomAssemblyBoundaries,
    ],
  );
  const visibleAssemblyBlocks = useMemo(
    () => !usesDomAssemblyBoundaries ? [] : limitAssemblyOverlayIntervals(
      assemblyModel.assemblyBlocks,
      boundaryMountInterval.start,
      boundaryMountInterval.end,
      boundaryMountWidthPx,
      selectedAssemblyUnitIds,
      overlayIntervalBudget,
    ),
    [
      assemblyModel,
      boundaryMountInterval.end,
      boundaryMountInterval.start,
      boundaryMountWidthPx,
      overlayIntervalBudget,
      selectedAssemblyUnitIds,
      usesDomAssemblyBoundaries,
    ],
  );
  const visibleAssemblyChromosomes = useMemo(
    () => {
      if (!usesDomAssemblyBoundaries) {
        return [];
      }
      const xSpan = assemblyBoundaryMountViewport.xEnd - assemblyBoundaryMountViewport.xStart;
      const ySpan = assemblyBoundaryMountViewport.yEnd - assemblyBoundaryMountViewport.yStart;
      return assemblyModel.chromosomes.filter(
        (chromosome) => chromosome.visualEnd > assemblyBoundaryMountViewport.xStart - xSpan
          && chromosome.visualStart < assemblyBoundaryMountViewport.xEnd + xSpan
          && chromosome.visualEnd > assemblyBoundaryMountViewport.yStart - ySpan
          && chromosome.visualStart < assemblyBoundaryMountViewport.yEnd + ySpan,
      );
    },
    [
      assemblyBoundaryMountViewport.xEnd,
      assemblyBoundaryMountViewport.xStart,
      assemblyBoundaryMountViewport.yEnd,
      assemblyBoundaryMountViewport.yStart,
      assemblyModel,
      usesDomAssemblyBoundaries,
    ],
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
      setDeleteConfirmationOpen(false);
    }

    function handleAssemblyShortcut(event: KeyboardEvent) {
      const intent = assemblyShortcutIntent({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        repeat: event.repeat,
        editable: isEditableShortcutTarget(event.target),
      });
      if (!intent) {
        return false;
      }

      const latestState = latestUiStateRef.current;
      const selection = latestState.assembly.selection;
      const hasSelection = selection !== null;
      const openShortcutMenu = (initialMode: AssemblyContextMenuState["initialMode"]) => {
        setContextMenu({
          x: Math.max(8, window.innerWidth / 2 - 109),
          y: Math.max(8, window.innerHeight / 2 - 120),
          initialMode,
        });
      };
      let action: UiAction | null = null;
      if (intent === "rename") {
        if (!assemblyRenameTarget(latestState.assembly.blocks, selection)) {
          return false;
        }
        openShortcutMenu("rename");
      } else if (intent === "delete-contig") {
        if (
          selection?.kind !== "contigs"
          || selectedBlockIds(latestState.assembly.blocks, selection).length === 0
        ) {
          return false;
        }
        setDeleteConfirmationOpen(true);
        openShortcutMenu("delete");
      } else if (intent === "delete-gap") {
        if (!hasDeletableGap(latestState.assembly.blocks, selection)) {
          return false;
        }
        action = { type: "deleteAssemblyGaps" };
      } else if (hasSelection) {
        action = intent === "reverse"
          ? { type: "reverseAssemblySelection" }
          : intent === "copy"
            ? { type: "copyAssemblySelection" }
            : { type: "moveAssemblySelectionToDebris" };
      } else {
        return false;
      }

      event.preventDefault();
      event.stopPropagation();
      if (action) {
        closeContextMenu();
        onUiAction(action);
      }
      return true;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (deleteConfirmationOpenRef.current) {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          closeContextMenu();
        }
        return;
      }
      if (isEditableShortcutTarget(event.target)) {
        if (event.key === "Escape") {
          if (contextMenuRef.current) {
            event.preventDefault();
            closeContextMenu();
            return;
          }
          onUiAction({ type: "clearAssemblySelection" });
          dragStateRef.current = null;
          panLoadingSuspendedRef.current = false;
          panTilePrefetchSignatureRef.current = null;
          onContactViewportPreview?.(null);
          resetPanTransform();
          setDragState(null);
          setAssemblySelectionDrag(null);
          setAssemblyPointerStateIfChanged({ kind: "select", blockId: null, visualPosition: null });
        }
        return;
      }
      if (handleAssemblyShortcut(event)) {
        return;
      }
      closeContextMenu();
      if (event.key === "Shift") {
        setShiftSelectionCursor(true);
        return;
      }
      if (event.key !== "Escape") {
        return;
      }

      onUiAction({ type: "clearAssemblySelection" });
      dragStateRef.current = null;
      panLoadingSuspendedRef.current = false;
      panTilePrefetchSignatureRef.current = null;
      onContactViewportPreview?.(null);
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
      lastAssemblyPointerRef.current = null;
      finishWheelPan();
      if (dragStateRef.current) {
        dragStateRef.current = null;
        panLoadingSuspendedRef.current = false;
        panTilePrefetchSignatureRef.current = null;
        setDragState(null);
        resetPanTransform();
        onContactViewportPreview?.(null);
      }
      setAssemblyPointerStateIfChanged({ kind: "select", blockId: null, visualPosition: null });
    }

    window.addEventListener("click", closeContextMenu);
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("blur", handleWindowBlur);

    return () => {
      if (wheelPanCommitTimerRef.current !== null) {
        window.clearTimeout(wheelPanCommitTimerRef.current);
        wheelPanCommitTimerRef.current = null;
      }
      wheelPanSessionRef.current = null;
      panLoadingSuspendedRef.current = false;
      panTilePrefetchSignatureRef.current = null;
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
      onContactViewportPreview?.(null);
    };
  }, [onContactViewportPreview]);

  useEffect(() => {
    const stage = mapContentRef.current;
    if (!stage) {
      return;
    }

    function handleWheelPan(event: WheelEvent) {
      const sourceContactMap = latestContactMapRef.current;
      const navigationMode = contactWheelNavigationMode(event);
      if (navigationMode === "resolution") {
        finishWheelPan();
        event.preventDefault();
        event.stopPropagation();
        if (!sourceContactMap) {
          return;
        }
        const latestUiState = latestUiStateRef.current;
        if (latestUiState.contact.resolutionLocked) {
          const bounds = canvasFrameRef.current?.getBoundingClientRect()
            ?? stage!.getBoundingClientRect();
          const zoomAction = lockedContactResolutionWheelZoomIntent(
            event.deltaX,
            event.deltaY,
            event.clientX,
            event.clientY,
            bounds,
            totalSpanMb,
          );
          if (zoomAction) onUiAction(zoomAction);
          return;
        }
        const viewportResolutionOptions = availableContactResolutions(
          latestUiState.contact,
          totalSpanMb,
          false,
        );
        // Do not let an mcool fall back to generic resolution levels while
        // metadata is unavailable; an empty list intentionally disables the
        // resolution-wheel action until the physical pyramid is known.
        const resolutionOptions = useStoredResolutionOptions
          ? storedContactResolutionsForDataset(availableResolutionBasePairs)
          : viewportResolutionOptions;
        const nextResolution = contactResolutionWheelIntent({
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          currentResolution: latestUiState.contact.resolution,
          resolutionOptions,
        });
        const now = performance.now();
        if (!nextResolution || now < resolutionWheelReadyAtRef.current) {
          return;
        }
        resolutionWheelReadyAtRef.current = now + resolutionWheelCooldownMs;
        onUiAction({
          type: "setContactResolution",
          resolution: nextResolution,
        });
        return;
      }
      if (!sourceContactMap) {
        return;
      }

      const bounds = canvasFrameRef.current?.getBoundingClientRect()
        ?? stage!.getBoundingClientRect();
      const latestUiState = latestUiStateRef.current;
      let wheelSession = wheelPanSessionRef.current;
      const startsWheelSession = wheelSession === null;
      if (!wheelSession) {
        const startViewport = buildCenteredContactViewport({
          centerMb: latestUiState.contact.viewportCenterMb,
          centerXMb: latestUiState.contact.viewportCenterXMb,
          centerYMb: latestUiState.contact.viewportCenterYMb,
          totalSpanBp: totalSpanMb * 1_000_000,
          windowSizeBp: latestUiState.contact.viewportSpanMb * 1_000_000,
          viewportWidthPx: latestUiState.contact.viewportWidthPx,
          viewportHeightPx: latestUiState.contact.viewportHeightPx,
        });
        wheelSession = {
          sourceContactMap: { ...sourceContactMap, viewport: startViewport },
          startViewport,
          previewViewport: startViewport,
          width: Math.max(1, bounds.width),
          height: Math.max(1, bounds.height),
        };
        // The first real wheel delta should immediately schedule diagonal
        // warming, even if the visible viewport remains inside the same tile.
        panTilePrefetchSignatureRef.current = null;
        wheelPanSessionRef.current = wheelSession;
      }
      const currentViewport = wheelSession.previewViewport;
      const intent = contactWheelPanIntent({
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        panMode: contactWheelPanMode(event),
        bounds,
        viewport: currentViewport,
      });
      if (!intent) {
        if (startsWheelSession) {
          wheelPanSessionRef.current = null;
          panTilePrefetchSignatureRef.current = null;
        }
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      const currentContactMap = {
        ...wheelSession.sourceContactMap,
        viewport: currentViewport,
      };
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
        if (startsWheelSession) {
          wheelPanSessionRef.current = null;
          panTilePrefetchSignatureRef.current = null;
        }
        return;
      }

      if (!panLoadingSuspendedRef.current) {
        panLoadingSuspendedRef.current = true;
        onContactPanGestureStart?.();
      }

      wheelSession.previewViewport = previewContactMap.viewport;
      wheelSession.width = Math.max(1, bounds.width);
      wheelSession.height = Math.max(1, bounds.height);
      preparePanViewport(previewContactMap.viewport);
      schedulePanTransform(
        wheelSession.sourceContactMap,
        { ...wheelSession.sourceContactMap, viewport: previewContactMap.viewport },
        bounds.width,
        bounds.height,
      );
      if (wheelPanCommitTimerRef.current !== null) {
        window.clearTimeout(wheelPanCommitTimerRef.current);
      }
      wheelPanCommitTimerRef.current = window.setTimeout(
        finishWheelPan,
        wheelPanCommitDelayMs,
      );
    }

    stage.addEventListener("wheel", handleWheelPan, { passive: false });
    return () => stage.removeEventListener("wheel", handleWheelPan);
  }, [
    availableResolutionBasePairs,
    onContactPanGestureStart,
    onContactPanTilePrefetch,
    onUiAction,
    useStoredResolutionOptions,
    onContactViewportPreview,
    totalSpanMb,
  ]);

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

  usePrePaintEffect(() => {
    if (usesTiledRenderer || !displayContactMap) {
      prepaintedCellContactMapRef.current = null;
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const frame = canvasFrameRef.current;
    if (frame) {
      resizeContactMapCanvas(canvas, frame);
    }
    drawContactMapBuffer(canvas, displayContactMap, uiState);
    resetPanTransform();
    prepaintedCellContactMapRef.current = displayContactMap;
  }, [displayContactMap?.renderGeneration, usesTiledRenderer]);

  useEffect(() => {
    if (prepaintedCellContactMapRef.current === displayContactMap) {
      prepaintedCellContactMapRef.current = null;
      return;
    }
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

    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      initialMode: "default",
    });
  }

  function finishWheelPan() {
    if (wheelPanCommitTimerRef.current !== null) {
      window.clearTimeout(wheelPanCommitTimerRef.current);
      wheelPanCommitTimerRef.current = null;
    }
    const session = wheelPanSessionRef.current;
    wheelPanSessionRef.current = null;
    panLoadingSuspendedRef.current = false;
    panTilePrefetchSignatureRef.current = null;
    if (!session) {
      return;
    }

    cancelScheduledPanFrame();
    applyPanTransform(
      session.sourceContactMap,
      { ...session.sourceContactMap, viewport: session.previewViewport },
      session.width,
      session.height,
    );
    const commitAction = contactPanCommitAction(
      session.startViewport,
      session.previewViewport,
      totalSpanMb,
    );
    if (commitAction) {
      onUiAction(commitAction);
    } else {
      resetPanTransform();
    }
    onContactViewportPreview?.(null);
  }

  function startPan(event: React.PointerEvent<HTMLElement>) {
    finishWheelPan();
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
      startViewport: liveViewport,
      startX: event.clientX,
      startY: event.clientY,
      currentX: event.clientX,
      currentY: event.clientY,
      width: Math.max(1, bounds.width),
      height: Math.max(1, bounds.height),
      previewViewport: null,
    };
    dragStateRef.current = nextDragState;
    panLoadingSuspendedRef.current = false;
    // The first real pointer move should immediately schedule diagonal
    // warming, even if it has not crossed a visible tile boundary yet.
    panTilePrefetchSignatureRef.current = null;
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

    if (!panLoadingSuspendedRef.current) {
      panLoadingSuspendedRef.current = true;
      onContactPanGestureStart?.();
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
    preparePanViewport(previewContactMap.viewport);
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

    // The last pointer-move preview is already what the user sees. Pointer-up
    // coordinates can lag by one WebView event, so recomputing here produces a
    // visible snap backwards. Commit that exact visible camera instead.
    const finalViewport = currentDragState.previewViewport ?? contactMapWithPannedViewport(
      liveContactMap,
      event.clientX - currentDragState.startX,
      event.clientY - currentDragState.startY,
      currentDragState.width,
      currentDragState.height,
      totalSpanMb * 1_000_000,
    ).viewport;
    const finalContactMap = { ...liveContactMap, viewport: finalViewport };
    const commitAction = contactPanCommitAction(
      currentDragState.startViewport,
      finalViewport,
      totalSpanMb,
    );
    cancelScheduledPanFrame();
    applyPanTransform(
      liveContactMap,
      finalContactMap,
      currentDragState.width,
      currentDragState.height,
    );
    dragStateRef.current = null;
    panLoadingSuspendedRef.current = false;
    panTilePrefetchSignatureRef.current = null;
    setDragState(null);
    if (commitAction) {
      onUiAction(commitAction);
    } else {
      resetPanTransform();
      drawContactMapBuffer(canvasRef.current, liveContactMap, uiState);
    }
    onContactViewportPreview?.(null);
  }

  function preparePanViewport(previewViewport: ContactViewport) {
    // Keep pointer motion as a pure camera operation in the WebView. The
    // imperative prefetch channel reuses one pan generation, fills the frontend
    // tile cache, and uploads completed diagonal layers without React renders.
    //
    // Legacy DOM boundaries still need bounded pre-mounting. GPU boundaries
    // already live in the retained scene and require no React update here.
    if (usesDomAssemblyBoundaries) {
      prefetchAssemblyBoundaryViewport(previewViewport);
    }
    const prefetchChannel = contactPanPrefetchChannel(
      Boolean(onContactPanTilePrefetch),
      Boolean(onContactViewportPreview),
    );
    if (prefetchChannel && liveContactMap) {
      const signature = contactTileViewportRequestKey(
        previewViewport,
        previewViewport,
        liveContactMap.resolution,
        liveContactMap.tileSizeBins ?? 256,
        totalSpanMb * 1_000_000,
        0,
      );
      if (signature !== panTilePrefetchSignatureRef.current) {
        panTilePrefetchSignatureRef.current = signature;
        if (prefetchChannel === "backend") {
          onContactPanTilePrefetch?.(previewViewport);
        } else if (onContactViewportPreview) {
          panPreviewSequenceRef.current += 1;
          onContactViewportPreview({
            viewport: previewViewport,
            prefetchViewport: previewViewport,
            urgentPrefetchTileCount: 0,
            sequence: panPreviewSequenceRef.current,
            pointerTimestamp: performance.now(),
          });
        }
      }
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
    // Keep the same floating-point camera on both sides of pointer release.
    // Device-pixel rounding here created a different final position from the
    // viewport projection used by the settled frame.
    const offsetX = rawOffsetX;
    const offsetY = rawOffsetY;
    const transform = `translate(${offsetX}px, ${offsetY}px)`;

    if (canvasRef.current) {
      canvasRef.current.style.transform = transform;
    }
    if (contactTileTransformRef.current) {
      if (contactTilePanRendererRef.current) {
        contactTileTransformRef.current.style.transform = "";
        contactTilePanRendererRef.current.setPanViewport(previewContactMap.viewport);
      } else {
        contactTileTransformRef.current.style.transform = transform;
      }
    }
    if (assemblyOverlayLayerRef.current) {
      assemblyOverlayLayerRef.current.style.transform = transform;
    }
    if (assemblySelectionVerticalBandRef.current) {
      assemblySelectionVerticalBandRef.current.style.transform = `translateX(${offsetX}px)`;
    }
    if (assemblySelectionHorizontalBandRef.current) {
      assemblySelectionHorizontalBandRef.current.style.transform = `translateY(${offsetY}px)`;
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
    if (contactTileTransformRef.current) {
      contactTileTransformRef.current.style.transform = "";
    }
    const authoritativeViewport = latestContactMapRef.current?.viewport;
    if (authoritativeViewport) {
      contactTilePanRendererRef.current?.setPanViewport(authoritativeViewport);
    }
    resetPanAnnotationTransform();
  }

  function resetPanAnnotationTransform() {
    if (assemblyOverlayLayerRef.current) {
      assemblyOverlayLayerRef.current.style.transform = "";
    }
    if (assemblySelectionVerticalBandRef.current) {
      assemblySelectionVerticalBandRef.current.style.transform = "";
    }
    if (assemblySelectionHorizontalBandRef.current) {
      assemblySelectionHorizontalBandRef.current.style.transform = "";
    }
  }

  function prefetchAssemblyBoundaryViewport(candidate: ContactViewport) {
    const current = assemblyBoundaryPanViewportRef.current;
    const next = advanceContactBoundaryMountViewport(current, candidate);
    if (next === current) {
      return;
    }
    assemblyBoundaryPanViewportRef.current = next;
    setAssemblyBoundaryPanViewport(next);
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
    if (!panLoadingSuspendedRef.current) {
      panLoadingSuspendedRef.current = true;
      onContactPanGestureStart?.();
    }
    preparePanViewport(previewViewport);
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
    panLoadingSuspendedRef.current = false;
    panTilePrefetchSignatureRef.current = null;
    onContactViewportPreview?.(null);
  }

  function commitAxisNavigator(axis: "x" | "y", centerRatio: number) {
    previewAxisNavigator(axis, centerRatio);
    // Do not let the final preview animation frame reapply the old annotation
    // transform after the committed viewport cleared it in the layout phase.
    cancelScheduledPanFrame();
    onUiAction({
      type: "setContactViewportAxisFromNavigator",
      axis,
      ratio: centerRatio,
      totalSpanMb,
    });
    panLoadingSuspendedRef.current = false;
    panTilePrefetchSignatureRef.current = null;
    onContactViewportPreview?.(null);
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
    const current = assemblyPointerStateRef.current;
    if (
      current.kind === nextState.kind
      && current.blockId === nextState.blockId
      && current.visualPosition === nextState.visualPosition
      && current.targetObjectId === nextState.targetObjectId
      && current.chromosomeEnd === nextState.chromosomeEnd
    ) {
      return;
    }
    assemblyPointerStateRef.current = nextState;
    setAssemblyPointerState(nextState);
  }

  function startAssemblyPointer(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || assemblyModel.blocks.length === 0) {
      return;
    }

    lastAssemblyPointerRef.current = latestPointerCoordinates(event.nativeEvent);
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

    const currentPointerState = assemblyPointerStateRef.current;
    const confirmedCutState = !event.shiftKey && currentPointerState.kind === "cut"
      ? assemblyPointerStateAtScreenPoint({
          model: assemblyModel,
          selectedIds: selectedAssemblyBlockIds,
          lockedCutBlockId: currentPointerState.blockId,
          point,
          widthPx: Math.max(1, bounds.width),
          heightPx: Math.max(1, bounds.height),
          viewportXStart: displayViewport.xStart,
          viewportXEnd: displayViewport.xEnd,
          viewportYStart: displayViewport.yStart,
          viewportYEnd: displayViewport.yEnd,
          selectionKind: uiState.assembly.selection?.kind,
        })
      : null;
    if (
      confirmedCutState?.kind === "cut"
      && confirmedCutState.blockId !== null
      && confirmedCutState.blockId === currentPointerState.blockId
      && confirmedCutState.visualPosition !== null
    ) {
      event.stopPropagation();
      onUiAction({
        type: "splitAssemblyContig",
        blockId: confirmedCutState.blockId,
        visualPosition: confirmedCutState.visualPosition,
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
      && assemblyPointerState.targetObjectId === confirmedInsertTarget.targetObjectId
      && assemblyPointerState.chromosomeEnd === confirmedInsertTarget.chromosomeEnd
    ) {
      event.stopPropagation();
      onUiAction({
        type: "moveAssemblySelectionBefore",
        targetBlockId: confirmedInsertTarget.targetBlockId,
        targetObjectId: confirmedInsertTarget.targetObjectId,
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
    const pointer = latestPointerCoordinates(event.nativeEvent);
    lastAssemblyPointerRef.current = pointer;
    // Panning is a compositor-only operation. Do not mix it with the O(n)
    // contig cut/insert hit-test path on every pointer sample.
    if (dragStateRef.current || assemblySelectionDrag) {
      return;
    }
    refreshAssemblyHoverAtClientPosition(pointer, event.currentTarget);
  }

  function refreshAssemblyHoverAtClientPosition(
    pointer: AssemblyPointerPosition,
    target: HTMLElement | null = canvasFrameRef.current,
  ) {
    if (!target) {
      return;
    }
    const bounds = target.getBoundingClientRect();
    const pointerInside = bounds.width > 0
      && bounds.height > 0
      && pointer.clientX >= bounds.left
      && pointer.clientX <= bounds.right
      && pointer.clientY >= bounds.top
      && pointer.clientY <= bounds.bottom;
    if (!pointerInside) {
      lastAssemblyPointerRef.current = null;
      setAssemblyPointerStateIfChanged({ kind: "select", blockId: null, visualPosition: null });
      return;
    }

    setAssemblyPointerStateIfChanged(assemblyPointerStateAtScreenPoint({
      model: assemblyModel,
      selectedIds: selectedAssemblyBlockIds,
      lockedCutBlockId: assemblyPointerStateRef.current.kind === "cut"
        ? assemblyPointerStateRef.current.blockId
        : null,
      point: {
        x: pointer.clientX - bounds.left,
        y: pointer.clientY - bounds.top,
      },
      widthPx: bounds.width,
      heightPx: bounds.height,
      viewportXStart: displayViewport.xStart,
      viewportXEnd: displayViewport.xEnd,
      viewportYStart: displayViewport.yStart,
      viewportYEnd: displayViewport.yEnd,
      selectionKind: uiState.assembly.selection?.kind,
    }));
  }

  usePrePaintEffect(() => {
    if (dragStateRef.current || assemblySelectionDrag) {
      return;
    }
    const pointer = lastAssemblyPointerRef.current;
    if (pointer) {
      refreshAssemblyHoverAtClientPosition(pointer);
    }
  }, [
    assemblyModel,
    assemblySelectionDrag,
    displayViewport.xEnd,
    displayViewport.xStart,
    displayViewport.yEnd,
    displayViewport.yStart,
    dragState,
    selectedAssemblyBlockIds,
    uiState.assembly.selection?.kind,
    uiState.contact.resolution,
  ]);

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
    lastAssemblyPointerRef.current = latestPointerCoordinates(event.nativeEvent);
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
            ? selectedAssemblyUnitIds.has(assemblySelectionDrag.startHit.id)
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
          ids,
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
        panLoadingSuspendedRef.current = false;
        panTilePrefetchSignatureRef.current = null;
        setDragState(null);
        cancelScheduledPanFrame();
        resetPanTransform();
        onContactViewportPreview?.(null);
        return;
      }
    }

    stopPan(event);
  }

  return (
    <section className="contact-map" aria-label="Contact map viewport">
      {onClosePanel || onExpandPanel ? (
        <div className="heatmap-panel-controls" aria-label="Heatmap window controls">
          {onExpandPanel ? (
            <button
              type="button"
              aria-label="Expand heatmap window"
              title="Expand heatmap window"
              onClick={onExpandPanel}
            >
              <Maximize2 size={11} aria-hidden="true" />
            </button>
          ) : null}
          {onClosePanel ? (
            <button
              type="button"
              aria-label="Close heatmap window"
              title="Close heatmap window"
              onClick={onClosePanel}
            >
              <X size={12} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ) : null}
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
            coverageView={presentationCoverageView}
            assemblyBlocks={assemblyBlocks}
            viewport={displayViewport}
            totalSpanMb={totalSpanMb}
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
            {!usesTiledRenderer ? (
              <canvas
                ref={canvasRef}
                className={`contact-map-buffer-canvas ${hasContactMap ? "loaded-contact-canvas" : "empty-contact-canvas"}`}
                width="2880"
                height="2880"
                aria-label={hasContactMap ? "Imported contact map" : "Contact map canvas placeholder"}
              />
            ) : null}
            {usesTiledRenderer || contactTileDeltaStream ? (
              <ContactTileLayer
                boundaries={gpuAssemblyBoundaries}
                contactMap={usesTiledRenderer ? contactMap : null}
                deltaStream={contactTileDeltaStream}
                overviewContactMap={compatibleOverviewContactMap}
                freezePresentedStyle={freezePresentedTileStyle}
                layerRef={contactTileLayerRef}
                panRendererRef={contactTilePanRendererRef}
                transformRef={contactTileTransformRef}
                onPointerDown={startPan}
                onPointerMove={movePan}
                onPointerUp={stopPan}
                onPointerCancel={stopPan}
                overscanDirection="all"
                paintRevision={renderGeneration}
                onTileLayerCommit={renderGeneration === undefined || !onContactTileLayerCommit
                  ? undefined
                  : reportTileLayerCommit}
                onTileLayerPaintComplete={renderGeneration === undefined
                  ? undefined
                  : reportTileLayerPaintComplete}
                onPresentedSurfaceChange={reportPresentedSurfaceChange}
                onGpuAvailabilityChange={setGpuAssemblyBoundariesActive}
                renderStyle={tileRenderStyle}
                viewport={tileDisplayViewport}
              />
            ) : null}
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
                  tilePresentedSurfaceRevision,
                ].join("|")}
              />
            ) : null}
          </div>
          {presentationReady ? <AssemblyOverlay
            overlayLayerRef={assemblyOverlayLayerRef}
            selectionVerticalBandRef={assemblySelectionVerticalBandRef}
            selectionHorizontalBandRef={assemblySelectionHorizontalBandRef}
            boundaryMountViewport={assemblyBoundaryMountViewport}
            renderVisualBoundaries={usesDomAssemblyBoundaries}
            model={assemblyModel}
            viewportXStart={displayViewport.xStart}
            viewportXEnd={displayViewport.xEnd}
            viewportYStart={displayViewport.yStart}
            viewportYEnd={displayViewport.yEnd}
            selection={uiState.assembly.selection}
            showChromosomeBoxes={uiState.assembly.showChromosomeBoxes}
            showBlockBoxes={uiState.assembly.showBlockBoxes}
            showContigBoxes={uiState.assembly.showContigBoxes}
            visibleBlocks={visibleAssemblyBlocks}
            visibleContigs={visibleAssemblyContigs}
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
              lastAssemblyPointerRef.current = null;
              setAssemblySelectionDrag(null);
              stopPan(event);
              setAssemblyPointerStateIfChanged({ kind: "select", blockId: null, visualPosition: null });
            }}
            onPointerLeave={() => {
              lastAssemblyPointerRef.current = null;
              if (!assemblySelectionDrag && !dragStateRef.current) {
                setAssemblyPointerStateIfChanged({ kind: "select", blockId: null, visualPosition: null });
              }
            }}
          /> : null}
          {historyPreviewOperation ? (
            <HistoryOperationPreview
              operation={historyPreviewOperation}
              viewport={displayViewport}
            />
          ) : null}
        </div>
        {contextMenu ? (
          <AssemblyContextMenu
            key={contextMenu.initialMode}
            position={contextMenu}
            uiState={uiState}
            onUiAction={onUiAction}
            initialMode={contextMenu.initialMode}
            onDeleteConfirmationChange={setDeleteConfirmationOpen}
            onClose={() => {
              setContextMenu(null);
              setDeleteConfirmationOpen(false);
            }}
            fixed
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
            homologPattern={homologPattern}
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
            homologPattern={homologPattern}
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

export interface HistoryPreviewBox {
  key: string;
  phase: "before" | "after";
  leftPercent: number;
  topPercent: number;
  widthPercent: number;
  heightPercent: number;
  orientation: ContactMapLayoutBlock["orientation"];
}

export function historyPreviewBoxes(
  operation: OperationRecord,
  viewport: ContactViewport,
): HistoryPreviewBox[] {
  const impactedSourceIds = new Set(operation.impact?.sourceIds ?? []);
  const impactedBlockIds = new Set(operation.impact?.blockIds ?? []);
  const impactedChromosomeIds = new Set(operation.impact?.chromosomeIds ?? []);
  const hasSpecificTargets = impactedSourceIds.size > 0 || impactedBlockIds.size > 0;
  const xSpan = Math.max(1, viewport.xEnd - viewport.xStart);
  const ySpan = Math.max(1, viewport.yEnd - viewport.yStart);

  function project(
    phase: HistoryPreviewBox["phase"],
    blocks: ContactMapLayoutBlock[],
  ): HistoryPreviewBox[] {
    return blocks
      .filter((block) => (
        impactedSourceIds.has(block.sourceId)
        || impactedBlockIds.has(block.id)
        || (!hasSpecificTargets && impactedChromosomeIds.has(block.objectId))
      ))
      .map((block, index) => {
        const xStart = Math.max(viewport.xStart, block.visualStart);
        const xEnd = Math.min(viewport.xEnd, block.visualEnd);
        const yStart = Math.max(viewport.yStart, block.visualStart);
        const yEnd = Math.min(viewport.yEnd, block.visualEnd);
        if (xEnd <= xStart || yEnd <= yStart) {
          return null;
        }
        return {
          key: `${phase}:${block.id}:${index}`,
          phase,
          leftPercent: ((xStart - viewport.xStart) / xSpan) * 100,
          topPercent: ((yStart - viewport.yStart) / ySpan) * 100,
          widthPercent: ((xEnd - xStart) / xSpan) * 100,
          heightPercent: ((yEnd - yStart) / ySpan) * 100,
          orientation: block.orientation,
        } satisfies HistoryPreviewBox;
      })
      .filter((box): box is HistoryPreviewBox => box !== null);
  }

  return [
    ...project("before", operation.beforeAssembly?.blocks ?? []),
    ...project("after", operation.afterAssembly?.blocks ?? []),
  ];
}

function HistoryOperationPreview({
  operation,
  viewport,
}: {
  operation: OperationRecord;
  viewport: ContactViewport;
}) {
  const boxes = historyPreviewBoxes(operation, viewport);
  return (
    <div className="history-preview-overlay" aria-label="History before and after preview">
      {boxes.map((box) => (
        <span
          key={box.key}
          className={`history-preview-box ${box.phase} ${box.orientation === "-" ? "reverse" : "forward"}`}
          style={{
            left: `${box.leftPercent}%`,
            top: `${box.topPercent}%`,
            width: `${box.widthPercent}%`,
            height: `${box.heightPercent}%`,
          }}
        >
          <i aria-hidden="true" />
        </span>
      ))}
      <span className="history-preview-legend">
        <i className="before" /> Before
        <i className="after" /> After
      </span>
    </div>
  );
}

interface AssemblyOverlayProps {
  overlayLayerRef: React.RefObject<HTMLDivElement>;
  selectionVerticalBandRef: React.RefObject<HTMLSpanElement>;
  selectionHorizontalBandRef: React.RefObject<HTMLSpanElement>;
  boundaryMountViewport: ContactViewport;
  renderVisualBoundaries: boolean;
  model: AssemblyEditModel;
  viewportXStart: number;
  viewportXEnd: number;
  viewportYStart: number;
  viewportYEnd: number;
  selection: UiState["assembly"]["selection"];
  showChromosomeBoxes: boolean;
  showBlockBoxes: boolean;
  showContigBoxes: boolean;
  visibleBlocks: AssemblyEditModel["assemblyBlocks"];
  visibleContigs: AssemblyEditModel["blocks"];
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

const AssemblyOverlay = memo(function AssemblyOverlay({
  overlayLayerRef,
  selectionVerticalBandRef,
  selectionHorizontalBandRef,
  boundaryMountViewport,
  renderVisualBoundaries,
  model,
  viewportXStart,
  viewportXEnd,
  viewportYStart,
  viewportYEnd,
  selection,
  showChromosomeBoxes,
  showBlockBoxes,
  showContigBoxes,
  visibleBlocks,
  visibleContigs,
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

  const selectedContigIds = new Set(selectedBlockIds(model.blocks, selection));
  const selectedUnitIds = new Set(
    model.assemblyBlocks
      .filter((block) => block.contigIds.some((id) => selectedContigIds.has(id)))
      .map((block) => block.id),
  );
  const selectedBlocks = model.assemblyBlocks.filter((block) => selectedUnitIds.has(block.id));
  const selectedInterval = selectedBlocks.length > 0
    ? {
        start: Math.min(...selectedBlocks.map((block) => block.visualStart)),
        end: Math.max(...selectedBlocks.map((block) => block.visualEnd)),
      }
    : null;
  const selectionProjectionBands = selectedInterval
    ? assemblySelectionProjectionBands(selectedInterval.start, selectedInterval.end, {
        xStart: viewportXStart,
        xEnd: viewportXEnd,
        yStart: viewportYStart,
        yEnd: viewportYEnd,
      })
    : null;
  const selectedIndexes = model.assemblyBlocks
    .map((block, index) => (selectedUnitIds.has(block.id) ? index : -1))
    .filter((index) => index >= 0);
  const contigsById = new Map(model.blocks.map((block) => [block.id, block]));
  const unitByContigId = new Map(
    model.assemblyBlocks.flatMap((block) => (
      block.contigIds.map((contigId) => [contigId, block] as const)
    )),
  );
  const selectedGroupBox = selectedInterval
    ? intervalBox(
        selectedInterval.start,
        selectedInterval.end,
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
    onResizeSelection(model.assemblyBlocks.slice(startIndex, endIndex + 1).map((block) => block.id));
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
      className={`assembly-overlay ${pointerState.kind === "cut" ? "cut-preview-active" : ""}`.trim()}
      data-rendered-block-count={renderVisualBoundaries ? visibleBlocks.length : 0}
      data-rendered-contig-count={renderVisualBoundaries ? visibleContigs.length : 0}
      onDoubleClick={onDoubleClick}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerLeave={onPointerLeave}
    >
      {selectionProjectionBands?.vertical ? (
        <span
          ref={selectionVerticalBandRef}
          aria-hidden="true"
          className="assembly-selection-axis-band vertical"
          style={selectionProjectionBands.vertical}
        />
      ) : null}
      {selectionProjectionBands?.horizontal ? (
        <span
          ref={selectionHorizontalBandRef}
          aria-hidden="true"
          className="assembly-selection-axis-band horizontal"
          style={selectionProjectionBands.horizontal}
        />
      ) : null}
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
        {renderVisualBoundaries && showChromosomeBoxes
          ? visibleChromosomes.map((chromosome) => {
          const boundary = overscannedBoundaryIntervalBox(
            chromosome.visualStart,
            chromosome.visualEnd,
            viewportXStart,
            viewportXEnd,
            viewportXSpan,
            viewportYStart,
            viewportYEnd,
            viewportYSpan,
            boundaryMountViewport,
          );
          if (!boundary) {
            return null;
          }

          return (
            <span
              key={chromosome.id}
              className={`assembly-box chromosome-box ${
                selection?.kind === "chromosome" && selection.id === chromosome.id ? "selected" : ""
              } ${boundary.clipClassName}`.trim()}
              style={boundary.style}
              title={chromosome.id}
            />
          );
        })
          : null}
        {renderVisualBoundaries ? visibleBlocks.map((block) => {
        const showPrimaryBox = block.isComposite
          ? showBlockBoxes
          : showBlockBoxes || showContigBoxes;
        if (!showPrimaryBox) {
          return null;
        }
        const box = overscannedBoundaryIntervalBox(
          block.visualStart,
          block.visualEnd,
          viewportXStart,
          viewportXEnd,
          viewportXSpan,
          viewportYStart,
          viewportYEnd,
          viewportYSpan,
          boundaryMountViewport,
        );
        if (!box) {
          return null;
        }
        const selected = selectedUnitIds.has(block.id);
        const singletonContig = block.isComposite ? null : contigsById.get(block.contigIds[0] ?? "");
        return (
          <span
            key={block.id}
            className={`assembly-box block-box ${block.isComposite ? "composite-block-box" : "singleton-contig-box"} ${selected ? "selected" : ""}`}
            data-block-id={block.id}
            style={box.style}
            title={block.isComposite
              ? `${block.id} · ${block.contigIds.length} contigs`
              : `${singletonContig ? assemblyContigDisplayName(singletonContig) : block.id} ${singletonContig?.orientation ?? ""}`.trim()}
          >
            {selected ? <span className="block-frame" /> : null}
          </span>
        );
      }) : null}
        {renderVisualBoundaries && showContigBoxes ? visibleContigs.map((contig) => {
          const unit = unitByContigId.get(contig.id);
          if (!unit?.isComposite) {
            return null;
          }
          const box = overscannedBoundaryIntervalBox(
            contig.visualStart,
            contig.visualEnd,
            viewportXStart,
            viewportXEnd,
            viewportXSpan,
            viewportYStart,
            viewportYEnd,
            viewportYSpan,
            boundaryMountViewport,
          );
          if (!box) {
            return null;
          }
          const selected = selectedContigIds.has(contig.id);
          return (
            <span
              key={contig.id}
              className="assembly-box contig-child-box"
              data-contig-id={contig.id}
              style={box.style}
              title={`${assemblyContigDisplayName(contig)} ${contig.orientation}`}
            >
            </span>
          );
        }) : null}
        {(showBlockBoxes || showContigBoxes)
          && selectedContigIds.size > 0
          && pointerState.kind === "insert"
          && pointerState.chromosomeEnd
          && pointerState.visualPosition !== null ? (() => {
            const left = ((pointerState.visualPosition - viewportXStart) / viewportXSpan) * 100;
            const top = ((pointerState.visualPosition - viewportYStart) / viewportYSpan) * 100;
            const isStart = pointerState.chromosomeEnd === "start";
            return (
              <span
                className={`assembly-chromosome-end-target ${pointerState.chromosomeEnd}`}
                style={{ left: `${left}%`, top: `${top}%` }}
                title={`Insert at ${pointerState.chromosomeEnd} of ${pointerState.targetObjectId}`}
              >
                {isStart
                  ? <ArrowUpLeft size={17} strokeWidth={2.25} absoluteStrokeWidth />
                  : <ArrowDownRight size={17} strokeWidth={2.25} absoluteStrokeWidth />}
              </span>
            );
          })() : null}
        {(showBlockBoxes || showContigBoxes)
          && pointerState.kind === "cut"
          && pointerState.visualPosition !== null ? (() => {
          const left = ((pointerState.visualPosition - viewportXStart) / viewportXSpan) * 100;
          const top = ((pointerState.visualPosition - viewportYStart) / viewportYSpan) * 100;
          return (
            <span
              className="assembly-cut-marker"
              aria-hidden="true"
              style={{
                left: `clamp(10px, ${left}%, calc(100% - 10px))`,
                top: `clamp(10px, ${top}%, calc(100% - 10px))`,
              }}
            >
              <span className="assembly-cut-guide" />
              <span className="assembly-cut-point" />
              <Scissors size={17} strokeWidth={2.25} absoluteStrokeWidth />
            </span>
          );
        })() : null}
        {(showBlockBoxes || showContigBoxes)
          && selectedContigIds.size > 0
          && pointerState.kind === "insert"
          && !pointerState.chromosomeEnd
          && pointerState.visualPosition !== null ? (() => {
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
        {(showBlockBoxes || showContigBoxes) && selectedGroupBox ? (
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
              title="Reverse selected block order and orientation"
              aria-label="Reverse selected block order and orientation"
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
}, sameAssemblyOverlayPresentation);

export function sameAssemblyOverlayPresentation(
  previous: AssemblyOverlayProps,
  next: AssemblyOverlayProps,
) {
  return previous.model === next.model
    && previous.boundaryMountViewport.xStart === next.boundaryMountViewport.xStart
    && previous.boundaryMountViewport.xEnd === next.boundaryMountViewport.xEnd
    && previous.boundaryMountViewport.yStart === next.boundaryMountViewport.yStart
    && previous.boundaryMountViewport.yEnd === next.boundaryMountViewport.yEnd
    && previous.renderVisualBoundaries === next.renderVisualBoundaries
    && previous.viewportXStart === next.viewportXStart
    && previous.viewportXEnd === next.viewportXEnd
    && previous.viewportYStart === next.viewportYStart
    && previous.viewportYEnd === next.viewportYEnd
    && previous.selection === next.selection
    && previous.showChromosomeBoxes === next.showChromosomeBoxes
    && previous.showBlockBoxes === next.showBlockBoxes
    && previous.showContigBoxes === next.showContigBoxes
    && previous.visibleBlocks === next.visibleBlocks
    && previous.visibleContigs === next.visibleContigs
    && previous.visibleChromosomes === next.visibleChromosomes
    && previous.selectionBox === next.selectionBox
    && previous.pointerState === next.pointerState;
}

function nearestAssemblyBlockIndex(model: AssemblyEditModel, visualPosition: number) {
  let nearestIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < model.assemblyBlocks.length; index += 1) {
    const block = model.assemblyBlocks[index];
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

function overscannedBoundaryIntervalBox(
  visualStart: number,
  visualEnd: number,
  viewportXStart: number,
  viewportXEnd: number,
  viewportXSpan: number,
  viewportYStart: number,
  viewportYEnd: number,
  viewportYSpan: number,
  mountViewport: ContactViewport,
) {
  const mountXSpan = Math.max(1, mountViewport.xEnd - mountViewport.xStart);
  const mountYSpan = Math.max(1, mountViewport.yEnd - mountViewport.yStart);
  const overscanXStart = mountViewport.xStart - mountXSpan;
  const overscanXEnd = mountViewport.xEnd + mountXSpan;
  const overscanYStart = mountViewport.yStart - mountYSpan;
  const overscanYEnd = mountViewport.yEnd + mountYSpan;
  const clippedXStart = Math.max(visualStart, overscanXStart);
  const clippedXEnd = Math.min(visualEnd, overscanXEnd);
  const clippedYStart = Math.max(visualStart, overscanYStart);
  const clippedYEnd = Math.min(visualEnd, overscanYEnd);
  if (clippedXStart >= clippedXEnd || clippedYStart >= clippedYEnd) {
    return null;
  }
  return {
    style: {
      left: `${((clippedXStart - viewportXStart) / viewportXSpan) * 100}%`,
      top: `${((clippedYStart - viewportYStart) / viewportYSpan) * 100}%`,
      width: `${((clippedXEnd - clippedXStart) / viewportXSpan) * 100}%`,
      height: `${((clippedYEnd - clippedYStart) / viewportYSpan) * 100}%`,
    },
    clipClassName: assemblyBoundaryViewportClipClassName(
      visualStart,
      visualEnd,
      overscanXStart,
      overscanXEnd,
      overscanYStart,
      overscanYEnd,
    ),
  };
}

export function assemblyBoundaryViewportClipClassName(
  visualStart: number,
  visualEnd: number,
  viewportXStart: number,
  viewportXEnd: number,
  viewportYStart: number,
  viewportYEnd: number,
) {
  return [
    visualStart < viewportXStart ? "viewport-clipped-left" : "",
    visualEnd > viewportXEnd ? "viewport-clipped-right" : "",
    visualStart < viewportYStart ? "viewport-clipped-top" : "",
    visualEnd > viewportYEnd ? "viewport-clipped-bottom" : "",
  ].filter(Boolean).join(" ");
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
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  const rasterWidth = Math.max(1, Math.round(frameWidth));
  const rasterHeight = Math.max(1, Math.round(frameHeight));
  let imageData = contactMapImageDataCache.get(canvas);
  if (!imageData || imageData.width !== rasterWidth || imageData.height !== rasterHeight) {
    imageData = context.createImageData(rasterWidth, rasterHeight);
    contactMapImageDataCache.set(canvas, imageData);
  }
  const rasterInput = {
    resolution: contactMap.resolution,
    viewport: contactMap.viewport,
    width: rasterWidth,
    height: rasterHeight,
    colorScale: uiState.contact.colorScale,
    colormap: uiState.contact.colormap,
    colorLut: contactColorLut(uiState.contact.colormap, 0.88),
  };
  rasterizeContactMapCells({
    ...rasterInput,
    cells: contactCellsForViewport(bufferContactMap, maxBufferedContactCells),
  }, imageData.data);
  if (contactMap.cachedTiles) {
    rasterizeContactMapCells({
      ...rasterInput,
      cells: contactCellsForViewport({ ...contactMap, cachedTiles: undefined }),
    }, imageData.data, false);
  }
  context.putImageData(imageData, Math.round(frameOffsetX), Math.round(frameOffsetY));
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
