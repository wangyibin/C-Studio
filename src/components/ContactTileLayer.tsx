import {
  useCallback,
  useEffect,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ContactMapTile, ContactMapView } from "../App";
import { contactColorLut } from "../state/contactColor";
import type { ContactColorScale } from "../state/contactColorScale";
import { contactTileCellCount } from "../state/contactTileData";
import { contactTilesWithPreviewFallback } from "../state/contactMapView";
import { rasterizeContactTile } from "../state/contactTileRaster";
import { canonicalContactTile, contactTileKey } from "../state/contactTiles";
import type { ContactViewport } from "../state/contactViewport";
import type { ContactColormap } from "../state/uiState";

export interface ContactTileLayerPaintEvent {
  renderEpoch: number;
  canvasCount: number;
  paintRevision?: number;
  /** Captured during React's commit phase, before canvas layout effects. */
  commitTimestamp?: number;
}

export interface ContactTileLayerProps {
  contactMap: ContactMapView | null;
  viewport?: ContactViewport;
  renderStyle: ContactTileRenderStyle;
  /** Keep the currently presented style while a target resolution is loading. */
  freezePresentedStyle?: boolean;
  layerRef: React.RefObject<HTMLDivElement>;
  transformRef?: React.RefObject<HTMLDivElement>;
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
  /** Notifies ref consumers after presented canvas contents or identity change. */
  onPresentedSurfaceChange?: () => void;
}

export interface ContactTileRenderStyle {
  colormap: ContactColormap;
  colorScale: Pick<ContactColorScale, "log" | "min" | "max">;
}

type ContactTileBufferSlot = 0 | 1;

export interface ContactTileLayerFrame {
  contactMap: ContactMapView;
  renderStyle: ContactTileRenderStyle;
}

export interface ContactTileLayerBufferState {
  slots: [ContactTileLayerFrame | null, ContactTileLayerFrame | null];
  frontSlot: ContactTileBufferSlot | null;
  stagingSlot: ContactTileBufferSlot | null;
  revealRevision: number;
  revealEvent: ContactTileLayerPaintEvent | null;
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
  return {
    slots: [frame, null],
    frontSlot: frame ? 0 : null,
    stagingSlot: null,
    revealRevision: 0,
    revealEvent: null,
  };
}

/**
 * Keep same-surface updates direct, but stage presentation-changing updates in
 * the back slot so the browser never exposes a half-redrawn generation.
 */
export function syncContactTileLayerBuffer(
  state: ContactTileLayerBufferState,
  incoming: ContactTileLayerFrame | null,
  freezePresentedStyle: boolean,
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
    if (incoming.contactMap.visibleLayerComplete === false) {
      return state;
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
  return current.contactMap.resolution !== incoming.contactMap.resolution
    || (current.contactMap.tileSizeBins ?? 256) !== (incoming.contactMap.tileSizeBins ?? 256)
    || current.contactMap.normalization !== incoming.contactMap.normalization
    || !sameContactTileRenderStyle(current.renderStyle, incoming.renderStyle);
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
  contactMap,
  freezePresentedStyle = false,
  layerRef,
  transformRef,
  paintRevision,
  onTileLayerCommit,
  onTileLayerPaintComplete,
  onPresentedSurfaceChange,
  onPointerCancel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  renderStyle,
  viewport,
}: ContactTileLayerProps) {
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
  const onPresentedSurfaceChangeRef = useRef(onPresentedSurfaceChange);
  onPresentedSurfaceChangeRef.current = onPresentedSurfaceChange;
  const preparedRevealRef = useRef<{ revision: number; timestamp: number } | null>(null);
  const publishedRevealRevisionRef = useRef(0);
  const slotZeroLayerRef = useRef<HTMLDivElement>(null);
  const slotOneLayerRef = useRef<HTMLDivElement>(null);

  usePrePaintEffect(() => {
    setBuffer((current) => syncContactTileLayerBuffer(
      current,
      incomingFrame,
      freezePresentedStyle,
    ));
  }, [freezePresentedStyle, incomingFrame]);

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
      onPresentedSurfaceChangeRef.current?.();
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
    onPresentedSurfaceChangeRef.current?.();
    onTileLayerCommitRef.current?.(event);
    onTileLayerPaintCompleteRef.current?.(event);
  }, [buffer.revealEvent, buffer.revealRevision]);

  const slots = [0, 1] as const;

  return (
    <div
      className="contact-tile-viewport"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <div ref={transformRef} className="contact-tile-transform-stack">
        {slots.map((slot) => {
          const frame = buffer.slots[slot];
          if (!frame) {
            return null;
          }
          const phase = buffer.frontSlot === slot ? "presented" : "staging";
          return (
            <ContactTileSurface
              key={slot}
              contactMap={frame.contactMap}
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
              paintRevision={frame.contactMap.renderGeneration ?? paintRevision}
              phase={phase}
              renderStyle={frame.renderStyle}
              viewport={viewport ?? frame.contactMap.viewport}
            />
          );
        })}
      </div>
    </div>
  );
}

function ContactTileSurface({
  contactMap,
  layerRef,
  paintRevision,
  onTileLayerCommit,
  onTileLayerPaintComplete,
  onTileLayerPaintUnavailable,
  phase,
  renderStyle,
  viewport,
}: {
  contactMap: ContactMapView;
  layerRef: React.RefObject<HTMLDivElement>;
  paintRevision?: number;
  onTileLayerCommit: (event: ContactTileLayerPaintEvent) => void;
  onTileLayerPaintComplete: (event: ContactTileLayerPaintEvent) => void;
  onTileLayerPaintUnavailable: (event: ContactTileLayerPaintEvent) => void;
  phase: "presented" | "staging";
  renderStyle: ContactTileRenderStyle;
  viewport: ContactViewport;
}) {
  const rawTiles = contactMap.cachedTiles ?? contactMap.tiles;
  const previewTiles = contactMap.previewTiles;
  const tiles = useMemo(
    () => canonicalTilesForRendering(contactTilesWithPreviewFallback(
      rawTiles ?? [],
      previewTiles ?? [],
    )),
    [previewTiles, rawTiles],
  );
  const tileSizeBins = contactMap.tileSizeBins ?? 256;
  const paintEpochCounterRef = useRef(0);
  const activePaintCoordinatorRef = useRef<ContactTilePaintCoordinator | null>(null);
  const paintCanvasKeySignature = canvasKeysForTiles(
    canonicalTilesForRendering(contactMap.tiles ?? tiles),
  ).join("|");
  const visibleTileIdentitySignature = contactVisibleTileIdentitySignature(
    contactMap.tiles,
    tiles,
  );
  const paintCanvasKeys = useMemo(
    () => paintCanvasKeySignature === "" ? [] : paintCanvasKeySignature.split("|"),
    [paintCanvasKeySignature],
  );
  const paintCoordinator = useMemo(() => {
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
    contactMap?.resolution,
    contactMap.visibleLayerComplete,
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

  return (
    <div className="contact-tile-surface" data-phase={phase} aria-hidden={phase === "staging"}>
      <div ref={layerRef} className="contact-tile-layer">
        {tiles.flatMap((tile) => {
          const canvases = [
            <ContactTileCanvas
              key={`${tile.tileX}:${tile.tileY}:source`}
              contactMap={contactMap}
              tile={tile}
              tileSizeBins={tileSizeBins}
              transpose={false}
              paintCanvasKey={`${tile.tileX}:${tile.tileY}:source`}
              paintCoordinator={paintCoordinator}
              renderStyle={renderStyle}
              viewport={viewport}
            />,
          ];
          if (tile.tileX !== tile.tileY) {
            canvases.push(
              <ContactTileCanvas
                key={`${tile.tileX}:${tile.tileY}:mirror`}
                contactMap={contactMap}
                tile={tile}
                tileSizeBins={tileSizeBins}
                transpose
                paintCanvasKey={`${tile.tileX}:${tile.tileY}:mirror`}
                paintCoordinator={paintCoordinator}
                renderStyle={renderStyle}
                viewport={viewport}
              />,
            );
          }
          return canvases;
        })}
      </div>
    </div>
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
        };
    const key = contactTileKey(canonical);
    const existing = unique.get(key);
    if (!existing || contactTileCellCount(normalized) > contactTileCellCount(existing)) {
      unique.set(key, normalized);
    }
  }
  return [...unique.values()];
}

function canvasKeysForTiles(tiles: ContactMapTile[]): string[] {
  return tiles.flatMap((tile) => {
    const prefix = `${tile.tileX}:${tile.tileY}`;
    return tile.tileX === tile.tileY
      ? [`${prefix}:source`]
      : [`${prefix}:source`, `${prefix}:mirror`];
  });
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
      className="contact-tile-canvas"
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
