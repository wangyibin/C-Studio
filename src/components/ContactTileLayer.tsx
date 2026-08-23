import {
  useCallback,
  useEffect,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ContactMapTile, ContactMapView } from "../App";
import { contactColorLut } from "../state/contactColor";
import {
  contactCountSampleForColorScale,
  estimateContactColorScale,
  type ContactColorScale,
} from "../state/contactColorScale";
import { contactTileCellCount } from "../state/contactTileData";
import { traceContactPanCamera } from "../state/contactPanCameraTrace";
import type {
  ContactTileDeltaBatch,
  ContactTileDeltaRenderStream,
  ContactTileDenseDeltaBuffer,
} from "../state/contactTileDelta";
import { contactTilesWithPreviewFallback } from "../state/contactMapView";
import { rasterizeContactMapCells } from "../state/contactMapRaster";
import {
  rasterizeContactTile,
  rasterizeContactTileDelta,
  rasterizeContactTileDenseBuffer,
} from "../state/contactTileRaster";
import { canonicalContactTile, contactTileKey } from "../state/contactTiles";
import type { ContactViewport } from "../state/contactViewport";
import { isContactTilePerformanceEnabled } from "../state/contactTilePerformance";
import type { ContactColormap } from "../state/uiState";
import {
  contactOverviewFloatTextureData,
  contactOverviewTextureBins,
  contactTileGpuTextureBudgetBytes,
  createContactTileGpuRenderer,
  type ContactTileGpuBoundary,
  type ContactTileGpuOverview,
  type ContactTileGpuRenderer,
  type ContactTileGpuScene,
} from "./contactTileGpu";

export interface ContactTileLayerPaintEvent {
  renderEpoch: number;
  canvasCount: number;
  paintRevision?: number;
  /** Captured during React's commit phase, before canvas layout effects. */
  commitTimestamp?: number;
}

export interface ContactTileLayerProps {
  boundaries?: readonly ContactTileGpuBoundary[];
  contactMap: ContactMapView | null;
  deltaStream?: ContactTileDeltaRenderStream | null;
  overviewContactMap?: ContactMapView | null;
  viewport?: ContactViewport;
  /** Exact pointer-up camera retained until the matching pan target is painted. */
  committedPanViewport?: ContactViewport | null;
  renderStyle: ContactTileRenderStyle;
  /** One cached tile beyond the viewport, only on the active pan axes. */
  overscanDirection?: ContactTileOverscanMode;
  /** Keep the currently presented style while a target resolution is loading. */
  freezePresentedStyle?: boolean;
  layerRef: React.RefObject<HTMLDivElement>;
  transformRef?: React.RefObject<HTMLDivElement>;
  /** Imperative camera used during pointer movement without translating the canvas element. */
  panRendererRef?: MutableRefObject<ContactTileGpuRenderer | null>;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (event: React.PointerEvent<HTMLDivElement>) => void;
  /** Immutable revision attached to callbacks, normally the tile generation. */
  paintRevision?: number;
  /** Reports the DOM commit milestone captured before tile layout effects. */
  onTileLayerCommit?: (event: ContactTileLayerPaintEvent) => void;
  /** Fires after every visible canvas in that epoch is ready for presentation. */
  onTileLayerPaintComplete?: (event: ContactTileLayerPaintEvent) => void;
  /** Reports whether the presented surface owns assembly-boundary visuals. */
  onGpuAvailabilityChange?: (available: boolean) => void;
}

export interface ContactTileRenderStyle {
  colormap: ContactColormap;
  colorScale: Pick<ContactColorScale, "log" | "min" | "max">;
}

export type ContactTileOverscanAxisDirection = -1 | 0 | 1;

export interface ContactTileOverscanDirection {
  x: ContactTileOverscanAxisDirection;
  y: ContactTileOverscanAxisDirection;
}

/** Prewarm every edge while idle, then retain only the leading edge while panning. */
export type ContactTileOverscanMode = ContactTileOverscanDirection | "all";

export interface ContactTileCanvasDescriptor {
  key: string;
  tile: ContactMapTile;
  transpose: boolean;
}

type ContactTileBufferSlot = 0 | 1;

export const contactTileGpuSlotTextureBudgetBytes = Math.floor(
  contactTileGpuTextureBudgetBytes / 2,
);
/** The production GPU path owns one context and one global atlas budget. */
export const contactTileGpuSharedTextureBudgetBytes = contactTileGpuTextureBudgetBytes;

/** Back off transient presentation misses without turning them into GPU loss. */
export function contactTileGpuPresentationRetryDelay(attempt: number) {
  const boundedAttempt = Math.min(4, Math.max(0, Math.floor(attempt)));
  return Math.min(250, 16 * (2 ** boundedAttempt));
}

export interface ContactTileLayerFrame {
  contactMap: ContactMapView;
  renderStyle: ContactTileRenderStyle;
}

interface ContactTileBufferedGpuScene {
  slot: ContactTileBufferSlot;
  frame: ContactTileLayerFrame;
  scene: ContactTileGpuScene;
  canvasCount: number;
  paintRevision?: number;
}

export interface ContactTileLayerBufferState {
  slots: [ContactTileLayerFrame | null, ContactTileLayerFrame | null];
  frontSlot: ContactTileBufferSlot | null;
  stagingSlot: ContactTileBufferSlot | null;
  revealRevision: number;
  revealEvent: ContactTileLayerPaintEvent | null;
}

/** Keep a retained-resolution delta stream in the slot that will become front. */
export function contactTileDeltaStagingSlot(
  state: ContactTileLayerBufferState,
  stream: ContactTileDeltaRenderStream | null | undefined,
): ContactTileBufferSlot | null {
  if (!stream?.retainPreviousFrame || state.frontSlot === null) {
    return null;
  }
  const frontFrame = state.slots[state.frontSlot];
  if (frontFrame?.contactMap.renderGeneration === stream.generation) {
    return state.frontSlot;
  }
  return state.stagingSlot ?? (state.frontSlot === 0 ? 1 : 0);
}

/** Hidden retained-frame staging has no useful intermediate GPU presentation. */
export function deferContactTileGpuDeltaUpdates(
  stream: Pick<ContactTileDeltaRenderStream, "retainPreviousFrame">,
) {
  return stream.retainPreviousFrame === true;
}

export interface ContactTilePaintCoordinator {
  prepareCommit: (timestamp: number) => void;
  commit: () => void;
  reportCanvasPaint: (canvasKey: string) => void;
  reportCanvasUnavailable: (canvasKey: string) => void;
  cancel: () => void;
}

interface ContactTilePaintCoordinatorInput {
  event: ContactTileLayerPaintEvent;
  canvasKeys: readonly string[];
  isCurrent: () => boolean;
  onCommit?: (event: ContactTileLayerPaintEvent) => void;
  onComplete?: (event: ContactTileLayerPaintEvent) => void;
  onUnavailable?: (event: ContactTileLayerPaintEvent) => void;
}

interface ContactTileCanvasBoxInput {
  tileX: number;
  tileY: number;
  resolution: number;
  tileSizeBins: number;
  viewport: ContactViewport;
  viewportPixelSize: number;
}

export type ContactTileCanvasPaintDependencyValues = readonly [
  resolution: number,
  tile: ContactMapTile,
  tileSizeBins: number,
  transpose: boolean,
  colormap: ContactColormap,
  log: boolean,
  min: number,
  max: number,
];

const usePrePaintEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
const useCommitPreparationEffect = typeof window === "undefined" ? useEffect : useInsertionEffect;
const tileImageDataCache = new WeakMap<HTMLCanvasElement, ImageData>();
const contactTileIdentityCache = new WeakMap<ContactMapTile, number>();
let nextContactTileIdentity = 1;

function emitContactTileGpuPerformance(line: string) {
  console.info(line);
  void invoke("log_contact_frontend_performance", { line }).catch(() => undefined);
}

/**
 * Keep canvas paint invalidation tied to pixel-affecting values. In particular,
 * cache merges may recreate the color-scale object without changing its values;
 * React should reuse the existing raster in that case.
 */
export function contactTileCanvasPaintDependencyValues(
  resolution: number,
  tile: ContactMapTile,
  tileSizeBins: number,
  transpose: boolean,
  renderStyle: ContactTileRenderStyle,
): ContactTileCanvasPaintDependencyValues {
  return [
    resolution,
    tile,
    tileSizeBins,
    transpose,
    renderStyle.colormap,
    renderStyle.colorScale.log,
    renderStyle.colorScale.min,
    renderStyle.colorScale.max,
  ];
}

/**
 * Track authoritative visible tile replacement without coupling paint timing to
 * cached padding arrays. Array recreation with the same immutable tile objects
 * deliberately preserves the signature.
 */
export function contactVisibleTileIdentitySignature(
  visibleTiles: readonly ContactMapTile[] | undefined,
  fallbackTiles: readonly ContactMapTile[],
): string {
  const canonicalTiles = new Map<string, ContactMapTile>();
  for (const tile of visibleTiles ?? fallbackTiles) {
    const key = contactTileKey(tile);
    const existing = canonicalTiles.get(key);
    if (!existing || contactTileCellCount(tile) > contactTileCellCount(existing)) {
      canonicalTiles.set(key, tile);
    }
  }

  return [...canonicalTiles.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, tile]) => {
      let identity = contactTileIdentityCache.get(tile);
      if (identity === undefined) {
        identity = nextContactTileIdentity;
        nextContactTileIdentity += 1;
        contactTileIdentityCache.set(tile, identity);
      }
      return `${key}@${identity}`;
    })
    .join("|");
}

export function createContactTileLayerBufferState(
  frame: ContactTileLayerFrame | null,
): ContactTileLayerBufferState {
  const presentableFrame = frame && contactTileLayerFrameCanPresent(frame)
    ? frame
    : null;
  return {
    slots: [presentableFrame, null],
    frontSlot: presentableFrame ? 0 : null,
    stagingSlot: null,
    revealRevision: 0,
    revealEvent: null,
  };
}

/**
 * A streamed projected layer is not a presentation surface until every
 * visible tile is present. An exact source-layout projection is the exception:
 * its source pages are complete and the GPU coverage gate still verifies them
 * before the atomic framebuffer swap.
 */
function contactTileLayerFrameCanPresent(frame: ContactTileLayerFrame) {
  return frame.contactMap.visibleLayerComplete !== false
    || frame.contactMap.sourceLayout !== undefined;
}

/**
 * Keep same-surface updates direct, but stage presentation-changing updates in
 * the back slot so the browser never exposes a half-redrawn generation.
 */
export function syncContactTileLayerBuffer(
  state: ContactTileLayerBufferState,
  incoming: ContactTileLayerFrame | null,
  freezePresentedStyle: boolean,
  promoteViewportInPlace = false,
): ContactTileLayerBufferState {
  if (!incoming) {
    return state.frontSlot === null && state.stagingSlot === null
      ? state
      : {
          ...state,
          slots: [null, null],
          frontSlot: null,
          stagingSlot: null,
          revealEvent: null,
        };
  }

  if (!contactTileLayerFrameCanPresent(incoming)) {
    if (state.stagingSlot === null) {
      return state;
    }
    const front = state.frontSlot === null ? null : state.slots[state.frontSlot];
    return {
      ...state,
      slots: state.frontSlot === 0 ? [front, null] : [null, front],
      stagingSlot: null,
      revealEvent: null,
    };
  }

  if (state.frontSlot === null) {
    return {
      ...state,
      slots: [incoming, null],
      frontSlot: 0,
      stagingSlot: null,
      revealEvent: null,
    };
  }

  const front = state.slots[state.frontSlot];
  if (!front) {
    return {
      ...state,
      slots: [incoming, null],
      frontSlot: 0,
      stagingSlot: null,
      revealEvent: null,
    };
  }

  if (freezePresentedStyle) {
    const canRestoreCompleteFront = incoming.contactMap.visibleLayerComplete === true
      && sameContactTileDataSurface(front.contactMap, incoming.contactMap)
      && front.contactMap !== incoming.contactMap;
    if (canRestoreCompleteFront) {
      const restored = {
        contactMap: incoming.contactMap,
        renderStyle: front.renderStyle,
      };
      return {
        ...state,
        slots: state.frontSlot === 0 ? [restored, null] : [null, restored],
        stagingSlot: null,
        revealEvent: null,
      };
    }
    return state.stagingSlot === null
      ? state
      : {
          ...state,
          slots: state.frontSlot === 0 ? [front, null] : [null, front],
          stagingSlot: null,
          revealEvent: null,
        };
  }

  if (sameContactTileLayerFrame(front, incoming)) {
    return state.stagingSlot === null
      ? state
      : {
          ...state,
          slots: state.frontSlot === 0 ? [front, null] : [null, front],
          stagingSlot: null,
          revealEvent: null,
        };
  }

  if (requiresAtomicContactTileSwap(front, incoming)) {
    if (
      promoteViewportInPlace
      && canPromoteContactTilePanInPlace(front, incoming)
    ) {
      const slots: ContactTileLayerBufferState["slots"] = state.frontSlot === 0
        ? [incoming, null]
        : [null, incoming];
      return {
        ...state,
        slots,
        stagingSlot: null,
        revealEvent: null,
      };
    }
    const backSlot: ContactTileBufferSlot = state.frontSlot === 0 ? 1 : 0;
    if (
      state.stagingSlot === backSlot
      && sameContactTileLayerFrame(state.slots[backSlot], incoming)
    ) {
      return state;
    }
    const slots: ContactTileLayerBufferState["slots"] = state.frontSlot === 0
      ? [front, incoming]
      : [incoming, front];
    return {
      ...state,
      slots,
      stagingSlot: backSlot,
      revealEvent: null,
    };
  }

  const slots: ContactTileLayerBufferState["slots"] = state.frontSlot === 0
    ? [incoming, null]
    : [null, incoming];
  return {
    ...state,
    slots,
    stagingSlot: null,
    revealEvent: null,
  };
}

/** A pure viewport commit may reuse the live WebGL context after GPU prefetch. */
export function canPromoteContactTilePanInPlace(
  current: ContactTileLayerFrame,
  incoming: ContactTileLayerFrame,
) {
  return incoming.contactMap.visibleLayerComplete === true
    && !sameContactTileViewport(current.contactMap.viewport, incoming.contactMap.viewport)
    && sameContactTileDataSurface(current.contactMap, incoming.contactMap)
    && current.contactMap.requestedResolution === incoming.contactMap.requestedResolution
    && sameContactTileRenderStyle(current.renderStyle, incoming.renderStyle);
}

export function discardContactTileStagingBuffer(
  state: ContactTileLayerBufferState,
  slot: ContactTileBufferSlot,
  frame: ContactTileLayerFrame,
): ContactTileLayerBufferState {
  if (state.stagingSlot !== slot || state.slots[slot] !== frame) {
    return state;
  }
  const front = state.frontSlot === null ? null : state.slots[state.frontSlot];
  return {
    ...state,
    slots: state.frontSlot === 0 ? [front, null] : [null, front],
    stagingSlot: null,
    revealEvent: null,
  };
}

export function revealContactTileLayerBuffer(
  state: ContactTileLayerBufferState,
  slot: ContactTileBufferSlot,
  frame: ContactTileLayerFrame,
  event: ContactTileLayerPaintEvent,
): ContactTileLayerBufferState {
  if (
    state.stagingSlot !== slot
    || state.slots[slot] !== frame
    || (
      frame.contactMap.renderGeneration !== undefined
      && event.paintRevision !== frame.contactMap.renderGeneration
    )
  ) {
    return state;
  }

  const slots: ContactTileLayerBufferState["slots"] = slot === 0
    ? [frame, null]
    : [null, frame];
  return {
    slots,
    frontSlot: slot,
    stagingSlot: null,
    revealRevision: state.revealRevision + 1,
    revealEvent: event,
  };
}

function sameContactTileLayerFrame(
  left: ContactTileLayerFrame | null,
  right: ContactTileLayerFrame | null,
) {
  return Boolean(
    left
    && right
    && left.contactMap === right.contactMap
    && sameContactTileRenderStyle(left.renderStyle, right.renderStyle),
  );
}

function requiresAtomicContactTileSwap(
  current: ContactTileLayerFrame,
  incoming: ContactTileLayerFrame,
) {
  // Pointer motion may keep using the live front camera, but the committed
  // target must paint in the hidden slot. Replacing the visible scene in place
  // exposes its overview/clear pass and makes a completed drag look like a
  // refresh instead of one continuous sheet.
  return !sameContactTileViewport(current.contactMap.viewport, incoming.contactMap.viewport)
    || current.contactMap.resolution !== incoming.contactMap.resolution
    || current.contactMap.requestedResolution !== incoming.contactMap.requestedResolution
    || (current.contactMap.tileSizeBins ?? 256) !== (incoming.contactMap.tileSizeBins ?? 256)
    || current.contactMap.normalization !== incoming.contactMap.normalization
    || !sameContactTileRenderStyle(current.renderStyle, incoming.renderStyle);
}

function sameContactTileViewport(left: ContactViewport, right: ContactViewport) {
  return left.xStart === right.xStart
    && left.xEnd === right.xEnd
    && left.yStart === right.yStart
    && left.yEnd === right.yEnd;
}

/**
 * A staging surface and the fine-grained front buffer it replaces must keep
 * their own cameras. Applying the incoming whole-genome viewport to both
 * surfaces makes the old fine layer redraw just before it is discarded.
 */
export function contactTileViewportForBufferedSurface(
  phase: "presented" | "staging",
  frame: ContactTileLayerFrame,
  incomingFrame: ContactTileLayerFrame | null,
  liveViewport?: ContactViewport,
  committedPanViewport?: ContactViewport | null,
): ContactViewport {
  if (phase === "staging") {
    return frame.contactMap.viewport;
  }
  // The shared GPU front has already moved to this exact camera during the
  // pointer gesture. Never reconstruct it from the old buffered frame while
  // the authoritative target is arriving: that creates target -> source ->
  // target on every pointer-up. Resolution/layout swaps have no committed pan
  // camera and continue to freeze their old front below.
  if (committedPanViewport) {
    return committedPanViewport;
  }
  const supersededByAtomicSwap = Boolean(
    incomingFrame
    && frame !== incomingFrame
    && requiresAtomicContactTileSwap(frame, incomingFrame),
  );
  return supersededByAtomicSwap
    ? frame.contactMap.viewport
    : liveViewport ?? frame.contactMap.viewport;
}

function contactTileBufferedGpuScene(
  slot: ContactTileBufferSlot,
  phase: "presented" | "staging",
  frame: ContactTileLayerFrame,
  incomingFrame: ContactTileLayerFrame | null,
  liveViewport: ContactViewport | undefined,
  committedPanViewport: ContactViewport | null | undefined,
  boundaries: readonly ContactTileGpuBoundary[],
  overview: ContactTileGpuOverview | null,
  overviewContactMap: ContactMapView | null | undefined,
  overscanDirection: ContactTileOverscanMode,
): ContactTileBufferedGpuScene {
  const map = frame.contactMap;
  const tileSizeBins = map.tileSizeBins ?? 256;
  const tiles = canonicalTilesForRendering(contactTilesWithPreviewFallback(
    map.cachedTiles ?? map.tiles ?? [],
    map.previewTiles ?? [],
  ));
  const viewport = contactTileViewportForBufferedSurface(
    phase,
    frame,
    incomingFrame,
    liveViewport,
    committedPanViewport,
  );
  const acceptsOverview = Boolean(
    overviewContactMap
    && map.layoutBlocks === overviewContactMap.layoutBlocks
    && (map.normalization ?? "raw") === (overviewContactMap.normalization ?? "raw"),
  );
  const visibleTiles = canonicalTilesForRendering(map.tiles ?? tiles);
  return {
    slot,
    frame,
    canvasCount: contactTileCanvasDescriptorsForViewport(
      visibleTiles,
      map.resolution,
      tileSizeBins,
      map.viewport,
      { x: 0, y: 0 },
    ).length,
    paintRevision: map.renderGeneration,
    scene: {
      boundaries,
      dataScope: `${map.layoutScope ?? ""}|${map.normalization ?? "raw"}`,
      descriptors: contactTileCanvasDescriptorsForViewport(
        tiles,
        map.resolution,
        tileSizeBins,
        map.viewport,
        overscanDirection,
      ),
      generation: map.renderGeneration,
      overview: acceptsOverview ? overview : null,
      resolution: map.resolution,
      tileSizeBins,
      visibleLayerComplete: map.visibleLayerComplete === true,
      viewport,
      renderStyle: frame.renderStyle,
      sourceLayout: contactTileGpuSourceLayout(map),
    },
  };
}

function sameContactTileDataSurface(left: ContactMapView, right: ContactMapView) {
  return left.resolution === right.resolution
    && (left.tileSizeBins ?? 256) === (right.tileSizeBins ?? 256)
    && left.normalization === right.normalization
    && left.layoutScope === right.layoutScope;
}

function sameContactTileRenderStyle(
  left: ContactTileRenderStyle,
  right: ContactTileRenderStyle,
) {
  return left.colormap === right.colormap
    && left.colorScale.log === right.colorScale.log
    && left.colorScale.min === right.colorScale.min
    && left.colorScale.max === right.colorScale.max;
}

/**
 * Coordinates the commit milestone with child layout effects. Completion is
 * emitted only once both the commit and every expected canvas paint exist.
 */
export function createContactTilePaintCoordinator({
  event,
  canvasKeys,
  isCurrent,
  onCommit,
  onComplete,
  onUnavailable,
}: ContactTilePaintCoordinatorInput): ContactTilePaintCoordinator {
  const expectedCanvasKeys = new Set(canvasKeys);
  const paintedCanvasKeys = new Set<string>();
  let committed = false;
  let completed = false;
  let cancelled = false;
  let committedEvent = event;

  const completeIfReady = () => {
    if (
      cancelled
      || completed
      || !committed
      || !isCurrent()
      || paintedCanvasKeys.size !== expectedCanvasKeys.size
    ) {
      return;
    }
    completed = true;
    onComplete?.(committedEvent);
  };

  return {
    prepareCommit: (timestamp) => {
      if (cancelled || committed || !Number.isFinite(timestamp)) {
        return;
      }
      committedEvent = { ...event, commitTimestamp: timestamp };
    },
    commit: () => {
      if (cancelled || committed || !isCurrent()) {
        return;
      }
      committed = true;
      onCommit?.(committedEvent);
      completeIfReady();
    },
    reportCanvasPaint: (canvasKey) => {
      if (cancelled || completed || !expectedCanvasKeys.has(canvasKey)) {
        return;
      }
      paintedCanvasKeys.add(canvasKey);
      completeIfReady();
    },
    reportCanvasUnavailable: (canvasKey) => {
      if (
        cancelled
        || completed
        || !isCurrent()
        || !expectedCanvasKeys.has(canvasKey)
      ) {
        return;
      }
      cancelled = true;
      onUnavailable?.(committedEvent);
    },
    cancel: () => {
      cancelled = true;
    },
  };
}

export function ContactTileLayer({
  boundaries = [],
  committedPanViewport,
  contactMap,
  deltaStream,
  freezePresentedStyle = false,
  layerRef,
  transformRef,
  paintRevision,
  onTileLayerCommit,
  onTileLayerPaintComplete,
  onGpuAvailabilityChange,
  onPointerCancel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  overviewContactMap,
  overscanDirection = "all",
  panRendererRef,
  renderStyle,
  viewport,
}: ContactTileLayerProps) {
  const overview = useMemo(
    () => overviewContactMap
      ? contactOverviewFloatTextureData(
          overviewContactMap,
          contactOverviewTextureBins,
          estimateContactColorScale(
            contactCountSampleForColorScale(overviewContactMap),
            renderStyle.colorScale.log,
          ),
        )
      : null,
    [overviewContactMap, renderStyle.colorScale.log],
  );
  const incomingFrame = useMemo<ContactTileLayerFrame | null>(
    () => contactMap
      ? {
          contactMap,
          renderStyle: {
            colormap: renderStyle.colormap,
            colorScale: {
              log: renderStyle.colorScale.log,
              min: renderStyle.colorScale.min,
              max: renderStyle.colorScale.max,
            },
          },
        }
      : null,
    [
      contactMap,
      renderStyle.colormap,
      renderStyle.colorScale.log,
      renderStyle.colorScale.max,
      renderStyle.colorScale.min,
    ],
  );
  const [buffer, setBuffer] = useState(() => createContactTileLayerBufferState(incomingFrame));
  const bufferRef = useRef(buffer);
  bufferRef.current = buffer;
  const incomingFrameRef = useRef(incomingFrame);
  incomingFrameRef.current = incomingFrame;
  const freezePresentedStyleRef = useRef(freezePresentedStyle);
  freezePresentedStyleRef.current = freezePresentedStyle;
  const onTileLayerCommitRef = useRef(onTileLayerCommit);
  onTileLayerCommitRef.current = onTileLayerCommit;
  const onTileLayerPaintCompleteRef = useRef(onTileLayerPaintComplete);
  onTileLayerPaintCompleteRef.current = onTileLayerPaintComplete;
  const preparedRevealRef = useRef<{ revision: number; timestamp: number } | null>(null);
  const publishedRevealRevisionRef = useRef(0);
  const slotZeroLayerRef = useRef<HTMLDivElement>(null);
  const slotOneLayerRef = useRef<HTMLDivElement>(null);
  const [sharedGpuAvailable, setSharedGpuAvailable] = useState(
    () => typeof document !== "undefined",
  );
  const disableSharedGpu = useCallback(() => {
    setSharedGpuAvailable(false);
    if (panRendererRef) {
      panRendererRef.current = null;
    }
    onGpuAvailabilityChange?.(false);
  }, [onGpuAvailabilityChange, panRendererRef]);

  const incomingGpuScene = useMemo<ContactTileGpuScene | null>(() => {
    if (!incomingFrame) {
      return null;
    }
    const map = incomingFrame.contactMap;
    const tileSizeBins = map.tileSizeBins ?? 256;
    const tiles = canonicalTilesForRendering(contactTilesWithPreviewFallback(
      map.cachedTiles ?? map.tiles ?? [],
      map.previewTiles ?? [],
    ));
    const acceptsOverview = Boolean(
      overviewContactMap
      && map.layoutBlocks === overviewContactMap.layoutBlocks
      && (map.normalization ?? "raw") === (overviewContactMap.normalization ?? "raw"),
    );
    return {
      boundaries,
      dataScope: `${map.layoutScope ?? ""}|${map.normalization ?? "raw"}`,
      descriptors: contactTileCanvasDescriptorsForViewport(
        tiles,
        map.resolution,
        tileSizeBins,
        map.viewport,
        overscanDirection,
      ),
      generation: map.renderGeneration,
      overview: acceptsOverview ? overview : null,
      resolution: map.resolution,
      tileSizeBins,
      visibleLayerComplete: map.visibleLayerComplete === true,
      viewport: committedPanViewport ?? viewport ?? map.viewport,
      renderStyle: incomingFrame.renderStyle,
      sourceLayout: contactTileGpuSourceLayout(map),
    };
  }, [
    boundaries,
    committedPanViewport,
    incomingFrame,
    overview,
    overviewContactMap,
    overscanDirection,
    viewport,
  ]);

  usePrePaintEffect(() => {
    const current = bufferRef.current;
    const front = current.frontSlot === null ? null : current.slots[current.frontSlot];
    const promotionEligible = Boolean(
      front
      && incomingFrame
      && incomingGpuScene
      && !freezePresentedStyle
      && canPromoteContactTilePanInPlace(front, incomingFrame),
    );
    const promoteViewportInPlace = Boolean(
      promotionEligible
      && incomingGpuScene
      && panRendererRef?.current?.promoteScene(incomingGpuScene),
    );
    if (incomingGpuScene) {
      traceContactPanCamera("layer_promotion_result", {
        viewport: incomingGpuScene.viewport,
        generation: incomingGpuScene.generation,
        promotionEligible,
        promoted: promoteViewportInPlace,
        frontViewport: front?.contactMap.viewport,
        frontGeneration: front?.contactMap.renderGeneration,
      });
    }
    setBuffer((current) => syncContactTileLayerBuffer(
      current,
      incomingFrame,
      freezePresentedStyle,
      promoteViewportInPlace,
    ));
  }, [freezePresentedStyle, incomingFrame, incomingGpuScene, panRendererRef]);

  const reportSlotCommit = useCallback((slot: ContactTileBufferSlot, event: ContactTileLayerPaintEvent) => {
    const current = bufferRef.current;
    if (
      current.frontSlot === slot
      && current.slots[slot]?.contactMap.visibleLayerComplete !== false
    ) {
      onTileLayerCommitRef.current?.(event);
    }
  }, []);
  const reportSlotPaintComplete = useCallback((
    slot: ContactTileBufferSlot,
    event: ContactTileLayerPaintEvent,
  ) => {
    const current = bufferRef.current;
    if (current.frontSlot === slot) {
      if (current.slots[slot]?.contactMap.visibleLayerComplete !== false) {
        onTileLayerPaintCompleteRef.current?.(event);
      }
      return;
    }
    if (current.stagingSlot !== slot || freezePresentedStyleRef.current) {
      return;
    }
    const frame = current.slots[slot];
    const latest = incomingFrameRef.current;
    if (!frame || !sameContactTileLayerFrame(frame, latest)) {
      return;
    }

    setBuffer((state) => {
      if (
        freezePresentedStyleRef.current
        || !sameContactTileLayerFrame(frame, incomingFrameRef.current)
      ) {
        return state;
      }
      return revealContactTileLayerBuffer(state, slot, frame, event);
    });
  }, []);
  const reportSlotUnavailable = useCallback((slot: ContactTileBufferSlot) => {
    const current = bufferRef.current;
    if (current.stagingSlot !== slot) {
      return;
    }
    const frame = current.slots[slot];
    if (!frame) {
      return;
    }
    setBuffer((state) => discardContactTileStagingBuffer(state, slot, frame));
  }, []);
  const reportSlotZeroCommit = useCallback(
    (event: ContactTileLayerPaintEvent) => reportSlotCommit(0, event),
    [reportSlotCommit],
  );
  const reportSlotOneCommit = useCallback(
    (event: ContactTileLayerPaintEvent) => reportSlotCommit(1, event),
    [reportSlotCommit],
  );
  const reportSlotZeroPaintComplete = useCallback(
    (event: ContactTileLayerPaintEvent) => reportSlotPaintComplete(0, event),
    [reportSlotPaintComplete],
  );
  const reportSlotOnePaintComplete = useCallback(
    (event: ContactTileLayerPaintEvent) => reportSlotPaintComplete(1, event),
    [reportSlotPaintComplete],
  );
  const reportSlotZeroUnavailable = useCallback(
    () => reportSlotUnavailable(0),
    [reportSlotUnavailable],
  );
  const reportSlotOneUnavailable = useCallback(
    () => reportSlotUnavailable(1),
    [reportSlotUnavailable],
  );

  useCommitPreparationEffect(() => {
    if (
      !buffer.revealEvent
      || buffer.revealRevision <= publishedRevealRevisionRef.current
    ) {
      return;
    }
    preparedRevealRef.current = {
      revision: buffer.revealRevision,
      timestamp: frontendPerformanceTimestamp(),
    };
  }, [buffer.revealEvent, buffer.revealRevision]);

  usePrePaintEffect(() => {
    if (
      !buffer.revealEvent
      || buffer.revealRevision <= publishedRevealRevisionRef.current
    ) {
      return;
    }
    const prepared = preparedRevealRef.current;
    const commitTimestamp = prepared?.revision === buffer.revealRevision
      ? prepared.timestamp
      : frontendPerformanceTimestamp();
    const event = { ...buffer.revealEvent, commitTimestamp };
    publishedRevealRevisionRef.current = buffer.revealRevision;
    onTileLayerCommitRef.current?.(event);
    onTileLayerPaintCompleteRef.current?.(event);
  }, [buffer.revealEvent, buffer.revealRevision]);

  const slots = [0, 1] as const;
  const deltaStagingSlot = contactTileDeltaStagingSlot(buffer, deltaStream);
  const bufferedGpuScenes = useMemo(() => slots.map((slot) => {
    const frame = buffer.slots[slot];
    if (!frame) {
      return null;
    }
    return contactTileBufferedGpuScene(
      slot,
      buffer.frontSlot === slot ? "presented" : "staging",
      frame,
      incomingFrame,
      viewport,
      committedPanViewport,
      boundaries,
      overview,
      overviewContactMap,
      overscanDirection,
    );
  }), [
    boundaries,
    buffer,
    committedPanViewport,
    incomingFrame,
    overview,
    overviewContactMap,
    overscanDirection,
    viewport,
  ]);
  const frontGpuScene = buffer.frontSlot === null
    ? null
    : bufferedGpuScenes[buffer.frontSlot];
  const stagingGpuScene = buffer.stagingSlot === null
    ? null
    : bufferedGpuScenes[buffer.stagingSlot];

  return (
    <div
      className={`contact-tile-viewport${contactMap ? "" : " delta-only"}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <div ref={transformRef} className="contact-tile-transform-stack">
        {sharedGpuAvailable ? (
          <div className="contact-tile-surface" data-phase="presented">
            <div ref={layerRef} className="contact-tile-layer">
              <ContactTileSharedGpuCanvas
                front={frontGpuScene}
                staging={stagingGpuScene}
                onGpuAvailabilityChange={onGpuAvailabilityChange}
                onSlotCommit={reportSlotCommit}
                onSlotPaintComplete={reportSlotPaintComplete}
                onUnavailable={disableSharedGpu}
                panRendererRef={panRendererRef}
              />
            </div>
          </div>
        ) : slots.map((slot) => {
          const frame = buffer.slots[slot];
          const stagedDeltaStream = deltaStagingSlot === slot ? deltaStream : null;
          if (!frame && !stagedDeltaStream) {
            return null;
          }
          const phase = buffer.frontSlot === slot ? "presented" : "staging";
          const surfaceViewport = frame
            ? contactTileViewportForBufferedSurface(
                phase,
                frame,
                incomingFrame,
                viewport,
              )
            : stagedDeltaStream!.viewport;
          const frameAcceptsOverview = !frame || Boolean(
            overviewContactMap
            && frame.contactMap.layoutBlocks === overviewContactMap.layoutBlocks
            && (frame.contactMap.normalization ?? "raw")
              === (overviewContactMap.normalization ?? "raw"),
          );
          return (
            <ContactTileSurface
              key={slot}
              boundaries={boundaries}
              contactMap={frame?.contactMap ?? null}
              deltaStream={stagedDeltaStream}
              layerRef={phase === "presented"
                ? layerRef
                : slot === 0
                  ? slotZeroLayerRef
                  : slotOneLayerRef}
              onTileLayerCommit={slot === 0 ? reportSlotZeroCommit : reportSlotOneCommit}
              onTileLayerPaintComplete={slot === 0
                ? reportSlotZeroPaintComplete
                : reportSlotOnePaintComplete}
              onTileLayerPaintUnavailable={slot === 0
                ? reportSlotZeroUnavailable
                : reportSlotOneUnavailable}
              onGpuAvailabilityChange={phase === "presented"
                ? onGpuAvailabilityChange
                : undefined}
              overview={frameAcceptsOverview ? overview : null}
              overviewContactMap={frameAcceptsOverview ? overviewContactMap ?? null : null}
              paintRevision={frame?.contactMap.renderGeneration ?? paintRevision}
              panRendererRef={phase === "presented" ? panRendererRef : undefined}
              phase={phase}
              gpuEnabled={false}
              renderStyle={frame?.renderStyle ?? renderStyle}
              overscanDirection={overscanDirection}
              viewport={surfaceViewport}
            />
          );
        })}
        {deltaStream && deltaStagingSlot === null ? (
          <ContactTileDeltaOverlay
            stream={deltaStream}
            renderStyle={renderStyle}
          />
        ) : null}
      </div>
    </div>
  );
}

function ContactTileDeltaOverlay({
  renderStyle,
  stream,
}: {
  renderStyle: ContactTileRenderStyle;
  stream: ContactTileDeltaRenderStream;
}) {
  const descriptors = useMemo(() => contactTileCanvasDescriptorsForViewport(
    stream.accumulator.denseBuffers().map(({ tile }) => ({
      tileX: tile.tileX,
      tileY: tile.tileY,
      cells: [],
    })),
    stream.resolution,
    stream.accumulator.tileSizeBins,
    stream.viewport,
    { x: 0, y: 0 },
  ), [stream]);

  return (
    <div className="contact-tile-delta-overlay" aria-hidden="true">
      {descriptors.map(({ key, tile, transpose }) => {
        const buffer = stream.accumulator.denseBuffer(tile);
        return buffer ? (
          <ContactTileDeltaCanvas
            key={key}
            buffer={buffer}
            renderStyle={renderStyle}
            stream={stream}
            transpose={transpose}
          />
        ) : null;
      })}
    </div>
  );
}

function ContactTileDeltaCanvas({
  buffer,
  renderStyle,
  stream,
  transpose,
}: {
  buffer: ContactTileDenseDeltaBuffer;
  renderStyle: ContactTileRenderStyle;
  stream: ContactTileDeltaRenderStream;
  transpose: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tileSizeBins = stream.accumulator.tileSizeBins;
  const box = contactTileCanvasBox({
    tileX: transpose ? buffer.tile.tileY : buffer.tile.tileX,
    tileY: transpose ? buffer.tile.tileX : buffer.tile.tileY,
    resolution: stream.resolution,
    tileSizeBins,
    viewport: stream.viewport,
    viewportPixelSize: 100,
  });

  usePrePaintEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) {
      return;
    }
    const imageData = context.createImageData(tileSizeBins, tileSizeBins);
    const colorLut = contactColorLut(renderStyle.colormap, 0.88);
    const rasterInput = {
      buffer,
      tileSizeBins,
      transpose,
      colorScale: renderStyle.colorScale,
      colormap: renderStyle.colormap,
      colorLut,
    };
    let animationFrame: number | null = null;
    let painted = false;
    const publish = () => {
      animationFrame = null;
      context.putImageData(imageData, 0, 0);
      if (!painted) {
        painted = true;
        stream.onFirstPaint?.();
      }
    };
    const scheduleBatch = (batch: ContactTileDeltaBatch) => {
      let changed = batch.denseCompleteTileKeys?.includes(contactTileKey(buffer.tile)) ?? false;
      if (changed) {
        rasterizeContactTileDenseBuffer(rasterInput, imageData.data);
      }
      for (const delta of batch.deltas) {
        if (contactTileKey(delta) === contactTileKey(buffer.tile)) {
          rasterizeContactTileDelta({ ...rasterInput, delta }, imageData.data);
          changed = true;
        }
      }
      if (changed && animationFrame === null) {
        animationFrame = window.requestAnimationFrame(publish);
      }
    };
    const unsubscribe = stream.accumulator.subscribe(scheduleBatch);
    rasterizeContactTileDenseBuffer(rasterInput, imageData.data);
    context.putImageData(imageData, 0, 0);
    if (buffer.occupiedCount > 0) {
      painted = true;
      stream.onFirstPaint?.();
    }
    return () => {
      unsubscribe();
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
      }
    };
  }, [
    buffer,
    renderStyle.colormap,
    renderStyle.colorScale.log,
    renderStyle.colorScale.max,
    renderStyle.colorScale.min,
    stream,
    tileSizeBins,
    transpose,
  ]);

  return (
    <canvas
      ref={canvasRef}
      className="contact-tile-canvas"
      width={tileSizeBins}
      height={tileSizeBins}
      style={{
        left: `${box.left}%`,
        top: `${box.top}%`,
        width: `${box.width}%`,
        height: `${box.height}%`,
      }}
    />
  );
}

function ContactTileSharedGpuCanvas({
  front,
  onGpuAvailabilityChange,
  onSlotCommit,
  onSlotPaintComplete,
  onUnavailable,
  panRendererRef,
  staging,
}: {
  front: ContactTileBufferedGpuScene | null;
  staging: ContactTileBufferedGpuScene | null;
  onSlotCommit: (slot: ContactTileBufferSlot, event: ContactTileLayerPaintEvent) => void;
  onSlotPaintComplete: (
    slot: ContactTileBufferSlot,
    event: ContactTileLayerPaintEvent,
  ) => void;
  onUnavailable: () => void;
  onGpuAvailabilityChange?: (available: boolean) => void;
  panRendererRef?: MutableRefObject<ContactTileGpuRenderer | null>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<ContactTileGpuRenderer | null>(null);
  const presentedRef = useRef<ContactTileBufferedGpuScene | null>(null);
  const paintEpochRef = useRef(0);
  const onUnavailableRef = useRef(onUnavailable);
  const onSlotCommitRef = useRef(onSlotCommit);
  const onSlotPaintCompleteRef = useRef(onSlotPaintComplete);
  const onGpuAvailabilityChangeRef = useRef(onGpuAvailabilityChange);
  onUnavailableRef.current = onUnavailable;
  onSlotCommitRef.current = onSlotCommit;
  onSlotPaintCompleteRef.current = onSlotPaintComplete;
  onGpuAvailabilityChangeRef.current = onGpuAvailabilityChange;

  usePrePaintEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      traceContactPanCamera("gpu_unavailable", { reason: "missing-canvas" });
      onUnavailableRef.current();
      return;
    }
    const renderer = createContactTileGpuRenderer(canvas, contactTileGpuSharedTextureBudgetBytes, {
      performanceEnabled: isContactTilePerformanceEnabled(),
      emitPerformance: emitContactTileGpuPerformance,
    });
    if (!renderer) {
      traceContactPanCamera("gpu_unavailable", { reason: "renderer-create-failed" });
      onUnavailableRef.current();
      return;
    }
    rendererRef.current = renderer;
    if (panRendererRef) {
      panRendererRef.current = renderer;
    }
    onGpuAvailabilityChangeRef.current?.(true);
    const handleContextLost = (event: Event) => {
      event.preventDefault();
      traceContactPanCamera("gpu_unavailable", { reason: "context-lost" });
      onUnavailableRef.current();
    };
    canvas.addEventListener("webglcontextlost", handleContextLost);
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
          if (presentedRef.current && !renderer.redraw()) {
            // A redraw can be rejected while an atlas upload or presentation
            // fence is in flight. The retained front FBO is still valid, so a
            // temporary hold is not evidence that WebGL has been lost.
            traceContactPanCamera("gpu_redraw_hold", {
              viewport: presentedRef.current.scene.viewport,
              generation: presentedRef.current.scene.generation,
            });
          }
        });
    observer?.observe(canvas);
    return () => {
      observer?.disconnect();
      canvas.removeEventListener("webglcontextlost", handleContextLost);
      if (panRendererRef?.current === renderer) {
        panRendererRef.current = null;
      }
      rendererRef.current = null;
      presentedRef.current = null;
      renderer.destroy();
      onGpuAvailabilityChangeRef.current?.(false);
    };
  }, [panRendererRef]);

  usePrePaintEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) {
      return;
    }
    const candidate = staging ?? front;
    if (!candidate || sameContactTileBufferedGpuPresentation(presentedRef.current, candidate)) {
      return;
    }
    const activeRenderer = renderer;
    const activeCandidate = candidate;
    const event: ContactTileLayerPaintEvent = {
      renderEpoch: ++paintEpochRef.current,
      canvasCount: candidate.canvasCount,
      paintRevision: candidate.paintRevision,
      commitTimestamp: frontendPerformanceTimestamp(),
    };
    traceContactPanCamera("layer_scene_candidate", {
      mode: staging ? "staging" : "front",
      viewport: candidate.scene.viewport,
      generation: candidate.scene.generation,
      slot: candidate.slot,
    });
    onSlotCommitRef.current(candidate.slot, event);
    let active = true;
    let completed = false;
    let retryAttempt = 0;
    let retryTimer: number | null = null;
    const scheduleRetry = (reason: "async-miss" | "sync-miss") => {
      if (!active || completed || retryTimer !== null) {
        return;
      }
      const delay = contactTileGpuPresentationRetryDelay(retryAttempt++);
      traceContactPanCamera("layer_scene_retry", {
        reason,
        delay,
        attempt: retryAttempt,
        mode: staging ? "staging" : "front",
        viewport: candidate.scene.viewport,
        generation: candidate.scene.generation,
        slot: candidate.slot,
      });
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        attemptPresentation();
      }, delay);
    };
    const onPresented = (painted: boolean) => {
      if (!active || completed) {
        return;
      }
      if (!painted) {
        scheduleRetry("async-miss");
        return;
      }
      completed = true;
      presentedRef.current = candidate;
      traceContactPanCamera("layer_scene_presented", {
        mode: staging ? "staging" : "front",
        viewport: candidate.scene.viewport,
        generation: candidate.scene.generation,
        slot: candidate.slot,
        retries: retryAttempt,
      });
      onSlotPaintCompleteRef.current(candidate.slot, event);
    };
    function attemptPresentation() {
      if (!active || completed) {
        return;
      }
      const accepted = staging
        ? activeRenderer.stageScene(activeCandidate.scene, onPresented)
        : activeRenderer.setScene(activeCandidate.scene, onPresented);
      if (!accepted) {
        scheduleRetry("sync-miss");
      }
    }
    attemptPresentation();
    return () => {
      active = false;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
    };
  }, [front, staging]);

  return (
    <canvas
      ref={canvasRef}
      className="contact-tile-canvas contact-tile-gpu-canvas"
      data-gpu-context="shared"
      aria-hidden="true"
    />
  );
}

function sameContactTileBufferedGpuPresentation(
  left: ContactTileBufferedGpuScene | null,
  right: ContactTileBufferedGpuScene,
) {
  if (!left || left.frame !== right.frame) {
    return false;
  }
  const leftScene = left.scene;
  const rightScene = right.scene;
  return leftScene.boundaries === rightScene.boundaries
    && leftScene.overview === rightScene.overview
    && leftScene.sourceLayout?.xMap === rightScene.sourceLayout?.xMap
    && leftScene.sourceLayout?.yMap === rightScene.sourceLayout?.yMap
    && leftScene.sourceLayout?.generation === rightScene.sourceLayout?.generation
    && leftScene.viewport.xStart === rightScene.viewport.xStart
    && leftScene.viewport.xEnd === rightScene.viewport.xEnd
    && leftScene.viewport.yStart === rightScene.viewport.yStart
    && leftScene.viewport.yEnd === rightScene.viewport.yEnd
    && leftScene.descriptors.length === rightScene.descriptors.length
    && leftScene.descriptors.every((descriptor, index) => {
      const candidate = rightScene.descriptors[index];
      return candidate?.key === descriptor.key
        && candidate.transpose === descriptor.transpose
        && candidate.tile === descriptor.tile;
    });
}

function ContactTileSurface({
  boundaries,
  contactMap,
  deltaStream,
  gpuEnabled = true,
  layerRef,
  overview,
  overviewContactMap,
  paintRevision,
  onTileLayerCommit,
  onTileLayerPaintComplete,
  onTileLayerPaintUnavailable,
  onGpuAvailabilityChange,
  panRendererRef,
  phase,
  renderStyle,
  overscanDirection,
  viewport,
}: {
  boundaries: readonly ContactTileGpuBoundary[];
  contactMap: ContactMapView | null;
  deltaStream?: ContactTileDeltaRenderStream | null;
  gpuEnabled?: boolean;
  layerRef: React.RefObject<HTMLDivElement>;
  paintRevision?: number;
  onTileLayerCommit: (event: ContactTileLayerPaintEvent) => void;
  onTileLayerPaintComplete: (event: ContactTileLayerPaintEvent) => void;
  onTileLayerPaintUnavailable: (event: ContactTileLayerPaintEvent) => void;
  onGpuAvailabilityChange?: (available: boolean) => void;
  overview: ContactTileGpuOverview | null;
  overviewContactMap: ContactMapView | null;
  panRendererRef?: MutableRefObject<ContactTileGpuRenderer | null>;
  phase: "presented" | "staging";
  renderStyle: ContactTileRenderStyle;
  overscanDirection: ContactTileOverscanMode;
  viewport: ContactViewport;
}) {
  const rawTiles = contactMap?.cachedTiles ?? contactMap?.tiles;
  const previewTiles = contactMap?.previewTiles;
  // Keep the GPU camera on the pointer-stable live viewport, but choose tile
  // textures around the newest loaded preview viewport. The imperative pan
  // offset then moves those ahead-of-camera textures into view without a
  // React render for every pointer sample.
  const tileSelectionViewport = contactMap?.viewport ?? viewport;
  const tiles = useMemo(
    () => canonicalTilesForRendering(contactTilesWithPreviewFallback(
      rawTiles ?? [],
      previewTiles ?? [],
    )),
    [previewTiles, rawTiles],
  );
  const tileSizeBins = contactMap?.tileSizeBins ?? deltaStream?.accumulator.tileSizeBins ?? 256;
  const renderCanvases = useMemo(
    () => contactMap
      ? contactTileCanvasDescriptorsForViewport(
          tiles,
          contactMap.resolution,
          tileSizeBins,
          tileSelectionViewport,
          overscanDirection,
        )
      : [],
    [
      contactMap,
      typeof overscanDirection === "string" ? overscanDirection : overscanDirection.x,
      typeof overscanDirection === "string" ? overscanDirection : overscanDirection.y,
      tileSizeBins,
      tiles,
      tileSelectionViewport.xEnd,
      tileSelectionViewport.xStart,
      tileSelectionViewport.yEnd,
      tileSelectionViewport.yStart,
    ],
  );
  const paintEpochCounterRef = useRef(0);
  const activePaintCoordinatorRef = useRef<ContactTilePaintCoordinator | null>(null);
  const paintCanvasKeySignature = useMemo(
    () => contactMap
      ? contactTileCanvasDescriptorsForViewport(
          canonicalTilesForRendering(contactMap.tiles ?? tiles),
          contactMap.resolution,
          tileSizeBins,
          tileSelectionViewport,
          { x: 0, y: 0 },
        ).map(({ key }) => key).join("|")
      : "",
    [
      contactMap,
      tileSizeBins,
      tiles,
      tileSelectionViewport.xEnd,
      tileSelectionViewport.xStart,
      tileSelectionViewport.yEnd,
      tileSelectionViewport.yStart,
    ],
  );
  const visibleTileIdentitySignature = contactMap
    ? contactVisibleTileIdentitySignature(contactMap.tiles, tiles)
    : "";
  const paintCanvasKeys = useMemo(
    () => paintCanvasKeySignature === "" ? [] : paintCanvasKeySignature.split("|"),
    [paintCanvasKeySignature],
  );
  const paintCoordinator = useMemo(() => {
    if (!contactMap) {
      return null;
    }
    paintEpochCounterRef.current += 1;
    const event: ContactTileLayerPaintEvent = {
      renderEpoch: paintEpochCounterRef.current,
      canvasCount: paintCanvasKeys.length,
      paintRevision,
    };
    let coordinator!: ContactTilePaintCoordinator;
    coordinator = createContactTilePaintCoordinator({
      event,
      canvasKeys: paintCanvasKeys,
      isCurrent: () => activePaintCoordinatorRef.current === coordinator,
      onCommit: onTileLayerCommit,
      onComplete: onTileLayerPaintComplete,
      onUnavailable: onTileLayerPaintUnavailable,
    });
    return coordinator;
  }, [
    contactMap,
    onTileLayerCommit,
    onTileLayerPaintComplete,
    onTileLayerPaintUnavailable,
    paintCanvasKeys,
    paintRevision,
    tileSizeBins,
    renderStyle.colormap,
    renderStyle.colorScale.log,
    renderStyle.colorScale.min,
    renderStyle.colorScale.max,
    visibleTileIdentitySignature,
  ]);

  useCommitPreparationEffect(() => {
    if (!paintCoordinator) {
      activePaintCoordinatorRef.current = null;
      return;
    }
    activePaintCoordinatorRef.current = paintCoordinator;
    paintCoordinator.prepareCommit(frontendPerformanceTimestamp());
    return () => {
      paintCoordinator.cancel();
      if (activePaintCoordinatorRef.current === paintCoordinator) {
        activePaintCoordinatorRef.current = null;
      }
    };
  }, [paintCoordinator]);

  usePrePaintEffect(() => {
    paintCoordinator?.commit();
  }, [paintCoordinator]);

  const [gpuAvailable, setGpuAvailable] = useState(
    () => gpuEnabled && typeof document !== "undefined",
  );
  const disableGpu = useCallback(() => {
    setGpuAvailable(false);
    onGpuAvailabilityChange?.(false);
  }, [onGpuAvailabilityChange]);

  usePrePaintEffect(() => {
    if (!gpuAvailable && panRendererRef) {
      panRendererRef.current = null;
    }
  }, [gpuAvailable, panRendererRef]);

  return (
    <div className="contact-tile-surface" data-phase={phase} aria-hidden={phase === "staging"}>
      <div ref={layerRef} className="contact-tile-layer">
        {gpuEnabled && gpuAvailable ? (
          <ContactTileGpuCanvas
            boundaries={boundaries}
            contactMap={contactMap}
            deltaStream={deltaStream}
            descriptors={renderCanvases}
            onUnavailable={disableGpu}
            onGpuAvailabilityChange={onGpuAvailabilityChange}
            paintCanvasKeys={paintCanvasKeys}
            paintCoordinator={paintCoordinator}
            panRendererRef={panRendererRef}
            overview={overview}
            renderStyle={renderStyle}
            tileSizeBins={tileSizeBins}
            textureBudgetBytes={contactTileGpuSlotTextureBudgetBytes}
            viewport={viewport}
          />
        ) : (
          <>
            {overviewContactMap ? (
              <ContactOverviewCanvas
                contactMap={overviewContactMap}
                renderStyle={renderStyle}
                viewport={viewport}
              />
            ) : null}
            {contactMap ? renderCanvases.map(({ key, tile, transpose }) => (
              <ContactTileCanvas
                key={key}
                contactMap={contactMap}
                tile={tile}
                tileSizeBins={tileSizeBins}
                transpose={transpose}
                paintCanvasKey={key}
                paintCoordinator={paintCoordinator}
                renderStyle={renderStyle}
                viewport={viewport}
              />
            )) : null}
          </>
        )}
      </div>
    </div>
  );
}

function ContactTileGpuCanvas({
  boundaries,
  contactMap,
  deltaStream,
  descriptors,
  onUnavailable,
  onGpuAvailabilityChange,
  paintCanvasKeys,
  paintCoordinator,
  panRendererRef,
  overview,
  renderStyle,
  tileSizeBins,
  textureBudgetBytes,
  viewport,
}: {
  boundaries: readonly ContactTileGpuBoundary[];
  contactMap: ContactMapView | null;
  deltaStream?: ContactTileDeltaRenderStream | null;
  descriptors: readonly ContactTileCanvasDescriptor[];
  onUnavailable: () => void;
  onGpuAvailabilityChange?: (available: boolean) => void;
  paintCanvasKeys: readonly string[];
  paintCoordinator: ContactTilePaintCoordinator | null;
  panRendererRef?: MutableRefObject<ContactTileGpuRenderer | null>;
  overview: ContactTileGpuOverview | null;
  renderStyle: ContactTileRenderStyle;
  tileSizeBins: number;
  textureBudgetBytes: number;
  viewport: ContactViewport;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<ContactTileGpuRenderer | null>(null);
  const gpuAvailabilityChangeRef = useRef(onGpuAvailabilityChange);
  gpuAvailabilityChangeRef.current = onGpuAvailabilityChange;
  const deltaDescriptors = useMemo(
    () => deltaStream
      ? contactTileCanvasDescriptorsForViewport(
          deltaStream.accumulator.denseBuffers().map(({ tile }) => ({
            tileX: tile.tileX,
            tileY: tile.tileY,
            cells: [],
          })),
          deltaStream.resolution,
          deltaStream.accumulator.tileSizeBins,
          deltaStream.viewport,
          { x: 0, y: 0 },
        )
      : [],
    [deltaStream],
  );

  usePrePaintEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      onUnavailable();
      return;
    }
    const renderer = createContactTileGpuRenderer(canvas, textureBudgetBytes, {
      performanceEnabled: isContactTilePerformanceEnabled(),
      emitPerformance: emitContactTileGpuPerformance,
    });
    if (!renderer) {
      onUnavailable();
      return;
    }
    rendererRef.current = renderer;
    gpuAvailabilityChangeRef.current?.(true);
    const handleContextLost = (event: Event) => {
      event.preventDefault();
      onUnavailable();
    };
    canvas.addEventListener("webglcontextlost", handleContextLost);
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
          if (!renderer.redraw()) {
            onUnavailable();
          }
        });
    observer?.observe(canvas);
    return () => {
      observer?.disconnect();
      canvas.removeEventListener("webglcontextlost", handleContextLost);
      if (panRendererRef?.current === renderer) {
        panRendererRef.current = null;
      }
      rendererRef.current = null;
      renderer.destroy();
      gpuAvailabilityChangeRef.current?.(false);
    };
  }, [onUnavailable, textureBudgetBytes]);

  usePrePaintEffect(() => {
    if (!rendererRef.current || !onGpuAvailabilityChange) {
      return;
    }
    onGpuAvailabilityChange(true);
    // Losing the "presented" role does not destroy this GPU surface; it only
    // becomes the staging slot. Reporting false from an effect cleanup would
    // briefly remount every DOM boundary during an atomic front/back swap.
    // Real renderer loss is reported by disableGpu or the destroy cleanup.
  }, [onGpuAvailabilityChange]);

  usePrePaintEffect(() => {
    const renderer = rendererRef.current;
    if (!panRendererRef || !renderer) {
      return;
    }
    panRendererRef.current = renderer;
    return () => {
      if (panRendererRef.current === renderer) {
        panRendererRef.current = null;
      }
    };
  }, [panRendererRef]);

  usePrePaintEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !contactMap) {
      return;
    }
    let active = true;
    const reportPainted = (painted: boolean) => {
      if (!active) {
        return;
      }
      if (!painted) {
        onUnavailable();
        return;
      }
      for (const key of paintCanvasKeys) {
        paintCoordinator?.reportCanvasPaint(key);
      }
    };
    const painted = renderer.setScene({
      boundaries,
      dataScope: `${contactMap.layoutScope ?? ""}|${contactMap.normalization ?? "raw"}`,
      descriptors,
      generation: contactMap.renderGeneration,
      overview,
      resolution: contactMap.resolution,
      tileSizeBins,
      visibleLayerComplete: contactMap.visibleLayerComplete === true,
      viewport,
      renderStyle,
    }, reportPainted);
    if (!painted) {
      active = false;
      onUnavailable();
      return;
    }
    return () => {
      active = false;
    };
  }, [
    boundaries,
    contactMap,
    descriptors,
    onUnavailable,
    overview,
    paintCanvasKeys,
    paintCoordinator,
    renderStyle.colormap,
    renderStyle.colorScale.log,
    renderStyle.colorScale.max,
    renderStyle.colorScale.min,
    tileSizeBins,
    viewport.xEnd,
    viewport.xStart,
    viewport.yEnd,
    viewport.yStart,
  ]);

  usePrePaintEffect(() => {
    const renderer = rendererRef.current;
    if (
      !renderer
      || !deltaStream
      || contactMap?.renderGeneration === deltaStream.generation
    ) {
      return;
    }
    let animationFrame: number | null = null;
    let firstPaintReported = false;
    const changedTileKeys = new Set<string>();
    const deferTextureUpdates = deferContactTileGpuDeltaUpdates(deltaStream);
    const reportFirstPaint = () => {
      if (firstPaintReported) {
        return;
      }
      firstPaintReported = true;
      deltaStream.onFirstPaint?.();
    };
    const publish = () => {
      animationFrame = null;
      const changed = [...changedTileKeys];
      changedTileKeys.clear();
      if (changed.length === 0) {
        return;
      }
      if (!renderer.updateDeltaTiles(changed)) {
        onUnavailable();
        return;
      }
      reportFirstPaint();
    };
    const painted = renderer.setDeltaScene({
      boundaries,
      dataScope: contactMap
        ? `${contactMap.layoutScope ?? ""}|${contactMap.normalization ?? "raw"}`
        : undefined,
      buffers: deltaStream.accumulator.denseBuffers(),
      deferTextureUpdates,
      descriptors: deltaDescriptors,
      generation: deltaStream.generation,
      overview,
      resolution: deltaStream.resolution,
      tileSizeBins: deltaStream.accumulator.tileSizeBins,
      viewport: deltaStream.viewport,
      renderStyle,
    });
    if (!painted) {
      onUnavailable();
      return;
    }
    if (deferTextureUpdates) {
      return;
    }
    if (deltaStream.accumulator.denseBuffers().some((buffer) => buffer.occupiedCount > 0)) {
      reportFirstPaint();
    }
    const unsubscribe = deltaStream.accumulator.subscribe((batch) => {
      for (const key of batch.changedTileKeys) {
        changedTileKeys.add(key);
      }
      if (animationFrame === null) {
        animationFrame = window.requestAnimationFrame(publish);
      }
    });
    return () => {
      unsubscribe();
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
      }
    };
  }, [
    boundaries,
    contactMap?.renderGeneration,
    deltaDescriptors,
    deltaStream,
    onUnavailable,
    overview,
    renderStyle.colormap,
    renderStyle.colorScale.log,
    renderStyle.colorScale.max,
    renderStyle.colorScale.min,
  ]);

  return (
    <canvas
      ref={canvasRef}
      className="contact-tile-canvas contact-tile-gpu-canvas"
      aria-hidden="true"
    />
  );
}

export function canonicalTilesForRendering(tiles: ContactMapTile[]): ContactMapTile[] {
  const unique = new Map<string, ContactMapTile>();
  for (const tile of tiles) {
    const canonical = canonicalContactTile(tile);
    const normalized = tile.tileX <= tile.tileY
      ? tile
      : {
          tileX: canonical.tileX,
          tileY: canonical.tileY,
          cells: tile.cells.map((cell) => ({
            xBin: cell.yBin,
            yBin: cell.xBin,
            count: cell.count,
          })),
          packedCells: tile.packedCells
            ? {
                xLocal: tile.packedCells.yLocal,
                yLocal: tile.packedCells.xLocal,
                counts: tile.packedCells.counts,
              }
            : undefined,
          denseValues: tile.denseValues
            ? transposeDenseContactTileValues(tile.denseValues)
            : undefined,
          denseR16fValues: tile.denseR16fValues
            ? transposeDenseContactTileValues(tile.denseR16fValues)
            : undefined,
          denseOccupiedCount: tile.denseOccupiedCount,
        };
    const key = contactTileKey(canonical);
    const existing = unique.get(key);
    if (!existing || contactTileCellCount(normalized) > contactTileCellCount(existing)) {
      unique.set(key, normalized);
    }
  }
  return [...unique.values()];
}

function contactTileGpuSourceLayout(
  map: ContactMapView,
): ContactTileGpuScene["sourceLayout"] {
  const sourceLayout = map.sourceLayout;
  if (
    !sourceLayout
    || sourceLayout.resolution !== map.resolution
    || sourceLayout.tileSizeBins !== (map.tileSizeBins ?? 256)
  ) {
    return undefined;
  }
  const descriptors = canonicalTilesForRendering([...sourceLayout.tiles]).flatMap((tile) => {
    const source: ContactTileCanvasDescriptor = {
      key: `source:${tile.tileX}:${tile.tileY}:source`,
      tile,
      transpose: false,
    };
    return tile.tileX === tile.tileY
      ? [source]
      : [
          source,
          {
            key: `source:${tile.tileX}:${tile.tileY}:mirror`,
            tile,
            transpose: true,
          },
        ];
  });
  return {
    dataScope: sourceLayout.dataScope,
    descriptors,
    generation: sourceLayout.generation,
    sourceTiles: sourceLayout.sourceTiles,
    xMap: sourceLayout.xMap,
    yMap: sourceLayout.yMap,
  };
}

function transposeDenseContactTileValues(values: Float32Array): Float32Array;
function transposeDenseContactTileValues(values: Uint16Array): Uint16Array;
function transposeDenseContactTileValues(
  values: Float32Array | Uint16Array,
): Float32Array | Uint16Array {
  const tileSize = Math.sqrt(values.length);
  if (!Number.isSafeInteger(tileSize)) {
    throw new RangeError("dense contact tile must contain a square value grid");
  }
  const transposed = values instanceof Float32Array
    ? new Float32Array(values.length)
    : new Uint16Array(values.length);
  for (let y = 0; y < tileSize; y += 1) {
    for (let x = 0; x < tileSize; x += 1) {
      transposed[x * tileSize + y] = values[y * tileSize + x];
    }
  }
  return transposed;
}

export function contactTileCanvasDescriptorsForViewport(
  tiles: readonly ContactMapTile[],
  resolution: number,
  tileSizeBins: number,
  viewport: ContactViewport,
  overscanDirection: ContactTileOverscanMode,
): ContactTileCanvasDescriptor[] {
  if (viewport.xEnd <= viewport.xStart || viewport.yEnd <= viewport.yStart) {
    return [];
  }
  const tileSpanBp = Math.max(1, resolution * tileSizeBins);
  const minVisibleTileX = Math.floor(viewport.xStart / tileSpanBp);
  const maxVisibleTileX = Math.ceil(viewport.xEnd / tileSpanBp) - 1;
  const minVisibleTileY = Math.floor(viewport.yStart / tileSpanBp);
  const maxVisibleTileY = Math.ceil(viewport.yEnd / tileSpanBp) - 1;
  if (maxVisibleTileX < minVisibleTileX || maxVisibleTileY < minVisibleTileY) {
    return [];
  }

  const warmAllDirections = overscanDirection === "all";
  const directionX = warmAllDirections ? 0 : overscanDirection.x;
  const directionY = warmAllDirections ? 0 : overscanDirection.y;
  const minTileX = minVisibleTileX - (warmAllDirections || directionX < 0 ? 1 : 0);
  const maxTileX = maxVisibleTileX + (warmAllDirections || directionX > 0 ? 1 : 0);
  const minTileY = minVisibleTileY - (warmAllDirections || directionY < 0 ? 1 : 0);
  const maxTileY = maxVisibleTileY + (warmAllDirections || directionY > 0 ? 1 : 0);
  const descriptors: ContactTileCanvasDescriptor[] = [];
  const addIfVisible = (
    tile: ContactMapTile,
    transpose: boolean,
    renderedTileX: number,
    renderedTileY: number,
  ) => {
    if (
      renderedTileX < minTileX
      || renderedTileX > maxTileX
      || renderedTileY < minTileY
      || renderedTileY > maxTileY
    ) {
      return;
    }
    descriptors.push({
      key: `${tile.tileX}:${tile.tileY}:${transpose ? "mirror" : "source"}`,
      tile,
      transpose,
    });
  };

  for (const tile of tiles) {
    addIfVisible(tile, false, tile.tileX, tile.tileY);
    if (tile.tileX !== tile.tileY) {
      addIfVisible(tile, true, tile.tileY, tile.tileX);
    }
  }
  return descriptors;
}

function frontendPerformanceTimestamp(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

export function contactTileCanvasBox({
  resolution,
  tileSizeBins,
  tileX,
  tileY,
  viewport,
  viewportPixelSize,
}: ContactTileCanvasBoxInput) {
  const viewportWidth = Math.max(1, viewport.xEnd - viewport.xStart);
  const viewportHeight = Math.max(1, viewport.yEnd - viewport.yStart);
  const tileSpanBp = tileSizeBins * resolution;
  const left = ((tileX * tileSpanBp - viewport.xStart) / viewportWidth) * viewportPixelSize;
  const top = ((tileY * tileSpanBp - viewport.yStart) / viewportHeight) * viewportPixelSize;
  const width = (tileSpanBp / viewportWidth) * viewportPixelSize;
  const height = (tileSpanBp / viewportHeight) * viewportPixelSize;

  return { left, top, width, height };
}

function ContactOverviewCanvas({
  contactMap,
  renderStyle,
  viewport,
}: {
  contactMap: ContactMapView;
  renderStyle: ContactTileRenderStyle;
  viewport: ContactViewport;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportWidth = Math.max(1, viewport.xEnd - viewport.xStart);
  const viewportHeight = Math.max(1, viewport.yEnd - viewport.yStart);
  const box = {
    left: ((contactMap.viewport.xStart - viewport.xStart) / viewportWidth) * 100,
    top: ((contactMap.viewport.yStart - viewport.yStart) / viewportHeight) * 100,
    width: ((contactMap.viewport.xEnd - contactMap.viewport.xStart) / viewportWidth) * 100,
    height: ((contactMap.viewport.yEnd - contactMap.viewport.yStart) / viewportHeight) * 100,
  };

  usePrePaintEffect(() => {
    const context = canvasRef.current?.getContext("2d");
    if (!context) {
      return;
    }
    const imageData = context.createImageData(
      contactOverviewTextureBins,
      contactOverviewTextureBins,
    );
    rasterizeContactMapCells({
      cells: contactMap.cells,
      resolution: contactMap.resolution,
      viewport: contactMap.viewport,
      width: contactOverviewTextureBins,
      height: contactOverviewTextureBins,
      colorScale: renderStyle.colorScale,
      colormap: renderStyle.colormap,
      colorLut: contactColorLut(renderStyle.colormap, 0.88),
    }, imageData.data);
    context.putImageData(imageData, 0, 0);
  }, [
    contactMap,
    renderStyle.colormap,
    renderStyle.colorScale.log,
    renderStyle.colorScale.max,
    renderStyle.colorScale.min,
  ]);

  return (
    <canvas
      ref={canvasRef}
      className="contact-tile-canvas contact-overview-base-canvas"
      aria-hidden="true"
      width={contactOverviewTextureBins}
      height={contactOverviewTextureBins}
      style={{
        left: `${box.left}%`,
        top: `${box.top}%`,
        width: `${box.width}%`,
        height: `${box.height}%`,
      }}
    />
  );
}

function ContactTileCanvas({
  contactMap,
  tile,
  tileSizeBins,
  transpose,
  paintCanvasKey,
  paintCoordinator,
  renderStyle,
  viewport,
}: {
  contactMap: ContactMapView;
  tile: ContactMapTile;
  tileSizeBins: number;
  transpose: boolean;
  paintCanvasKey: string;
  paintCoordinator: ContactTilePaintCoordinator | null;
  renderStyle: ContactTileRenderStyle;
  viewport: ContactViewport;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const paintResultRef = useRef<ContactTileCanvasPaintResult>("unavailable");
  const box = contactTileCanvasBox({
    tileX: transpose ? tile.tileY : tile.tileX,
    tileY: transpose ? tile.tileX : tile.tileY,
    resolution: contactMap.resolution,
    tileSizeBins,
    viewport,
    viewportPixelSize: 100,
  });
  const paintDependencyValues = contactTileCanvasPaintDependencyValues(
    contactMap.resolution,
    tile,
    tileSizeBins,
    transpose,
    renderStyle,
  );

  usePrePaintEffect(() => {
    paintResultRef.current = drawTileCanvas(
      canvasRef.current,
      tile,
      tileSizeBins,
      transpose,
      renderStyle,
    );
  }, paintDependencyValues);

  // Keep diagnostics separate from drawing: a new measurement epoch may reuse
  // an already-painted canvas and must not force an otherwise unnecessary redraw.
  usePrePaintEffect(() => {
    if (paintResultRef.current !== "unavailable") {
      paintCoordinator?.reportCanvasPaint(paintCanvasKey);
    } else {
      paintCoordinator?.reportCanvasUnavailable(paintCanvasKey);
    }
  }, [paintCanvasKey, paintCoordinator]);

  return (
    <canvas
      ref={canvasRef}
      className="contact-tile-canvas contact-tile-exact-canvas"
      aria-hidden="true"
      width={tileSizeBins}
      height={tileSizeBins}
      style={{
        left: `${box.left}%`,
        top: `${box.top}%`,
        width: `${box.width}%`,
        height: `${box.height}%`,
      }}
    />
  );
}

export type ContactTileCanvasPaintResult = "painted" | "cleared" | "unavailable";

export function drawTileCanvas(
  canvas: HTMLCanvasElement | null,
  tile: ContactMapTile,
  tileSizeBins: number,
  transpose: boolean,
  renderStyle: ContactTileRenderStyle,
): ContactTileCanvasPaintResult {
  if (!canvas) {
    return "unavailable";
  }
  if (canvas.width !== tileSizeBins || canvas.height !== tileSizeBins) {
    throw new RangeError("contact tile canvas backing size must match tileSizeBins");
  }

  const context = canvas.getContext("2d");
  if (!context) {
    return "unavailable";
  }
  if (contactTileCellCount(tile) === 0) {
    context.clearRect(0, 0, tileSizeBins, tileSizeBins);
    return "cleared";
  }

  let imageData = tileImageDataCache.get(canvas);
  if (!imageData || imageData.width !== tileSizeBins || imageData.height !== tileSizeBins) {
    imageData = context.createImageData(tileSizeBins, tileSizeBins);
    tileImageDataCache.set(canvas, imageData);
  }
  rasterizeContactTile({
    tile,
    tileSizeBins,
    transpose,
    colorScale: renderStyle.colorScale,
    colormap: renderStyle.colormap,
    colorLut: contactColorLut(renderStyle.colormap, 0.88),
  }, imageData.data);
  context.putImageData(imageData, 0, 0);
  return "painted";
}
