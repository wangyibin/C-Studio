import type { ContactMapTile, ContactMapView } from "../App";
import {
  contactGpuCompactLayoutAddressData,
  type ContactGpuLayoutMap,
} from "../state/contactSourceLayout";
import { contactColorLut } from "../state/contactColor";
import { traceContactPanCamera } from "../state/contactPanCameraTrace";
import type { ContactTileDenseDeltaBuffer } from "../state/contactTileDelta";
import {
  contactTileCellCount,
  validatedDenseContactTileValues,
  validatedPackedContactTileCells,
} from "../state/contactTileData";
import {
  contactTileR16fEmptySentinel,
  contactTileR16fValuesToFloat32,
} from "../state/contactTileR16f";
import { contactTileKey } from "../state/contactTiles";
import type { ContactViewport } from "../state/contactViewport";
import { isContactTilePerformanceEnabled } from "../state/contactTilePerformance";
import type {
  ContactTileCanvasDescriptor,
  ContactTileRenderStyle,
} from "./ContactTileLayer";

export const contactTileGpuTextureBudgetBytes = 96 * 1024 * 1024;
export const contactTileGpuVirtualTextureBudgetBytes = 32 * 1024 * 1024;
export const contactOverviewTextureBins = 320;
export const contactTileGpuR16fMaximum = 65_504;
/** Four 256x256 R32F atlas layers per frame. */
export const contactTileGpuUploadBudgetBytes = 1024 * 1024;
/** Keep texture submission below a small fraction of a 16.7 ms frame. */
export const contactTileGpuUploadBudgetMilliseconds = 2;

export type ContactTileGpuTextureFormat = "r16f" | "r32f";
export type ContactTileGpuTexturePreference = ContactTileGpuTextureFormat;
export type ContactTileGpuTextureData =
  | { format: "float32"; values: Float32Array }
  | { format: "r16f"; values: Uint16Array };

export interface ContactTileGpuPerformanceSnapshot {
  texturePreference: ContactTileGpuTexturePreference;
  uploads: number;
  fullUploads: number;
  subUploads: number;
  r16fUploads: number;
  r32fUploads: number;
  rangeFallbacks: number;
  uploadErrorFallbacks: number;
  uploadMilliseconds: number;
  evictions: number;
  evictedBytes: number;
  cacheEntries: number;
  cacheBytes: number;
  scenePromotions: number;
  scenePromotionMisses: number;
  scenePromotionMilliseconds: number;
  virtualTextureDraws: number;
  virtualTextureFallbacks: number;
  virtualTextureUploads: number;
  virtualTexturePages: number;
  virtualTextureLayers: number;
  virtualTextureBytes: number;
  virtualTextureRebuilds: number;
  sourceLayoutDraws: number;
  sourceLayoutUploads: number;
  sourceLayoutBytes: number;
  stagedSceneDraws: number;
  framebufferSwaps: number;
  uploadQueueFrames: number;
  uploadQueueDeferredFrames: number;
  uploadQueueMaxDepth: number;
  uploadQueueBytes: number;
  uploadQueueMilliseconds: number;
  uploadQueueMaxFrameBytes: number;
  uploadQueueMaxFrameMilliseconds: number;
  uploadFencePolls: number;
  uploadFenceWaitFrames: number;
  uploadFenceSignals: number;
  uploadFenceFailures: number;
}

export interface ContactTileGpuRendererOptions {
  texturePreference?: ContactTileGpuTexturePreference;
  virtualTextureEnabled?: boolean;
  performanceEnabled?: boolean;
  emitPerformance?: (line: string) => void;
  clock?: () => number;
  uploadBudgetBytes?: number;
  uploadBudgetMilliseconds?: number;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
}

export interface ContactTileGpuOverview {
  values: Float32Array;
  width: number;
  height: number;
  viewport: ContactViewport;
  /**
   * The whole-assembly overview is aggregated at a much coarser resolution
   * than the exact surface. Reusing the exact scale saturates raw counts and
   * exposes a solid-red sheet while new pan tiles are arriving.
   */
  colorScale?: ContactTileRenderStyle["colorScale"];
}

/** A diagonal assembly interval retained in world coordinates on the GPU. */
export interface ContactTileGpuBoundary {
  visualStart: number;
  visualEnd: number;
  color: readonly [red: number, green: number, blue: number];
  lineWidthCssPx: number;
  minimumSpanCssPx: number;
}

export interface ContactTileGpuScene {
  boundaries?: readonly ContactTileGpuBoundary[];
  /** Exact matrix/layout/normalization identity for shared GPU residency. */
  dataScope?: string;
  descriptors: readonly ContactTileCanvasDescriptor[];
  generation?: number;
  overview?: ContactTileGpuOverview | null;
  /** Only a terminal visible layer may replace coarse overview pixels with exact zeros. */
  visibleLayerComplete?: boolean;
  resolution: number;
  tileSizeBins: number;
  viewport: ContactViewport;
  renderStyle: ContactTileRenderStyle;
  sourceLayout?: ContactTileGpuSourceLayout;
}

export interface ContactTileGpuSourceLayout {
  dataScope: string;
  descriptors: readonly ContactTileCanvasDescriptor[];
  generation: number;
  sourceTiles: readonly number[];
  xMap: ContactGpuLayoutMap;
  yMap: ContactGpuLayoutMap;
}

export interface ContactTileGpuDeltaScene {
  boundaries?: readonly ContactTileGpuBoundary[];
  dataScope?: string;
  buffers: readonly ContactTileDenseDeltaBuffer[];
  /** Accumulate into mutable CPU buffers and upload only during terminal promotion. */
  deferTextureUpdates?: boolean;
  descriptors: readonly ContactTileCanvasDescriptor[];
  generation: number;
  overview?: ContactTileGpuOverview | null;
  resolution: number;
  tileSizeBins: number;
  viewport: ContactViewport;
  renderStyle: ContactTileRenderStyle;
}

export interface ContactTileGpuRenderer {
  setScene: (
    scene: ContactTileGpuScene,
    onPresented?: (presented: boolean) => void,
  ) => boolean;
  /**
   * Draw a replacement into the second presentation FBO, then swap it with
   * the retained front FBO in the same WebGL context. A failed staging draw
   * leaves the visible front framebuffer untouched.
   */
  stageScene: (
    scene: ContactTileGpuScene,
    onPresented?: (presented: boolean) => void,
  ) => boolean;
  /**
   * Atomically replace the current scene only when every populated target tile
   * is already resident in this WebGL context. A miss leaves the visible frame
   * untouched so the caller can retain the DOM back-buffer fallback.
   */
  promoteScene: (scene: ContactTileGpuScene) => boolean;
  appendSceneDescriptors: (input: {
    descriptors: readonly ContactTileCanvasDescriptor[];
    generation: number;
    resolution: number;
    tileSizeBins: number;
  }) => boolean;
  /**
   * Queue exact pages in the shared atlas without changing the active scene or
   * its page table. Visible and same-resolution pan uploads always run first.
   */
  ingestPrefetchedPages: (input: {
    tiles: readonly ContactMapTile[];
    dataScope: string;
    generation: number;
    resolution: number;
    tileSizeBins: number;
  }) => boolean;
  /** Present newly appended or refreshed pan-prefetch descriptors in place. */
  presentAppendedSceneDescriptors: () => boolean;
  setDeltaScene: (scene: ContactTileGpuDeltaScene) => boolean;
  updateDeltaTiles: (changedTileKeys: readonly string[]) => boolean;
  /** Move the one live GPU camera during pointer navigation. */
  setPanViewport: (viewport: ContactViewport) => void;
  /** Keep scene/data updates from replacing the pointer-owned live camera. */
  retainPanViewport: (viewport: ContactViewport) => void;
  /** Return camera ownership to the declarative scene after target paint. */
  releasePanViewport: (viewport: ContactViewport) => void;
  redraw: () => boolean;
  performanceSnapshot: () => ContactTileGpuPerformanceSnapshot;
  destroy: () => void;
}

/**
 * A WebGL frame is presentable only when every populated descriptor reached a
 * draw call. Empty tiles are already represented by the white framebuffer
 * clear, but silently skipping one failed texture upload would leave a false
 * rectangular hole and must force the 2D fallback instead.
 */
export function contactTileGpuDrawCoverageIsComplete(
  descriptors: readonly ContactTileCanvasDescriptor[],
  drawnDescriptorKeys: ReadonlySet<string>,
  requiresExplicitEmptyCoverage = false,
): boolean {
  return descriptors.every((descriptor) => (
    (!requiresExplicitEmptyCoverage && contactTileCellCount(descriptor.tile) === 0)
    || drawnDescriptorKeys.has(descriptor.key)
  ));
}

export const contactTileVirtualPageTransposeFlag = 1;
export const contactTileVirtualPageExactFlag = 2;

export interface ContactTileVirtualPage {
  pageX: number;
  pageY: number;
  tileKey: string;
  tile: ContactMapTile;
  transpose: boolean;
}

export interface ContactTileVirtualPagePlan {
  originX: number;
  originY: number;
  width: number;
  height: number;
  pages: readonly ContactTileVirtualPage[];
  populatedTiles: readonly { key: string; tile: ContactMapTile }[];
}

export type ContactTileGpuUploadPriority = "center" | "edge" | "prefetch";

export interface ContactTileGpuUploadCandidate {
  key: string;
  tile: ContactMapTile;
  priority: ContactTileGpuUploadPriority;
  priorityRank: 0 | 1 | 2;
  distance: number;
  bytes: number;
}

/**
 * Order unique atlas uploads by what can affect the current camera. Source-space
 * scenes use the AGP address maps rather than comparing source tile ids with a
 * visual viewport.
 */
export function contactTileGpuUploadPlan(
  scene: ContactTileGpuScene,
  targetFormat: ContactTileGpuTextureFormat = "r32f",
): ContactTileGpuUploadCandidate[] {
  const tiles = new Map<string, ContactMapTile>();
  const descriptors = scene.sourceLayout?.descriptors ?? scene.descriptors;
  for (const descriptor of descriptors) {
    if (contactTileCellCount(descriptor.tile) > 0) {
      tiles.set(contactTileKey(descriptor.tile), descriptor.tile);
    }
  }
  const sourceRanks = scene.sourceLayout
    ? contactSourceTilePriorityRanks(scene)
    : null;
  return [...tiles].map(([key, tile]) => {
    const ranked = sourceRanks
      ? sourceTileUploadRank(tile, sourceRanks.x, sourceRanks.y)
      : visualTileUploadRank(scene, key);
    return {
      key,
      tile,
      priority: uploadPriorityName(ranked.rank),
      priorityRank: ranked.rank,
      distance: ranked.distance,
      bytes: scene.tileSizeBins * scene.tileSizeBins * (
        targetFormat === "r16f" && tile.denseR16fValues
          ? Uint16Array.BYTES_PER_ELEMENT
          : Float32Array.BYTES_PER_ELEMENT
      ),
    };
  }).sort((left, right) => (
    left.priorityRank - right.priorityRank
    || left.distance - right.distance
    || left.key.localeCompare(right.key)
  ));
}

/** Select a byte-bounded prefix while guaranteeing progress for one oversized tile. */
export function contactTileGpuUploadBatch(
  candidates: readonly ContactTileGpuUploadCandidate[],
  byteBudget: number,
): ContactTileGpuUploadCandidate[] {
  const safeBudget = Number.isFinite(byteBudget)
    ? Math.max(1, Math.floor(byteBudget))
    : Number.MAX_SAFE_INTEGER;
  const selected: ContactTileGpuUploadCandidate[] = [];
  let bytes = 0;
  for (const candidate of candidates) {
    if (selected.length > 0 && bytes + candidate.bytes > safeBudget) {
      break;
    }
    selected.push(candidate);
    bytes += candidate.bytes;
    if (bytes >= safeBudget) {
      break;
    }
  }
  return selected;
}

/** Keep every explicit empty page, but defer populated pages outside the camera. */
export function contactTileGpuVisibleUploadScene(
  scene: ContactTileGpuScene,
): ContactTileGpuScene {
  const visiblePopulatedKeys = new Set(
    contactTileGpuUploadPlan(scene)
      .filter((candidate) => candidate.priorityRank < 2)
      .map((candidate) => candidate.key),
  );
  const filter = (descriptors: readonly ContactTileCanvasDescriptor[]) => (
    descriptors.filter((descriptor) => (
      contactTileCellCount(descriptor.tile) === 0
      || visiblePopulatedKeys.has(contactTileKey(descriptor.tile))
    ))
  );
  if (!scene.sourceLayout) {
    return { ...scene, descriptors: filter(scene.descriptors) };
  }
  return {
    ...scene,
    sourceLayout: {
      ...scene.sourceLayout,
      descriptors: filter(scene.sourceLayout.descriptors),
    },
  };
}

function uploadPriorityName(rank: 0 | 1 | 2): ContactTileGpuUploadPriority {
  return rank === 0 ? "center" : rank === 1 ? "edge" : "prefetch";
}

function visualTileUploadRank(
  scene: ContactTileGpuScene,
  tileKey: string,
): { rank: 0 | 1 | 2; distance: number } {
  const tileSpan = scene.resolution * scene.tileSizeBins;
  const viewport = scene.viewport;
  const centerX = (viewport.xStart + viewport.xEnd) / 2;
  const centerY = (viewport.yStart + viewport.yEnd) / 2;
  const centerRect = {
    xStart: viewport.xStart + (viewport.xEnd - viewport.xStart) * 0.25,
    xEnd: viewport.xEnd - (viewport.xEnd - viewport.xStart) * 0.25,
    yStart: viewport.yStart + (viewport.yEnd - viewport.yStart) * 0.25,
    yEnd: viewport.yEnd - (viewport.yEnd - viewport.yStart) * 0.25,
  };
  let rank: 0 | 1 | 2 = 2;
  let distance = Number.POSITIVE_INFINITY;
  for (const descriptor of scene.descriptors) {
    if (contactTileKey(descriptor.tile) !== tileKey) {
      continue;
    }
    const tileX = descriptor.transpose ? descriptor.tile.tileY : descriptor.tile.tileX;
    const tileY = descriptor.transpose ? descriptor.tile.tileX : descriptor.tile.tileY;
    const xStart = tileX * tileSpan;
    const xEnd = xStart + tileSpan;
    const yStart = tileY * tileSpan;
    const yEnd = yStart + tileSpan;
    const intersectsViewport = xEnd > viewport.xStart
      && xStart < viewport.xEnd
      && yEnd > viewport.yStart
      && yStart < viewport.yEnd;
    const intersectsCenter = xEnd > centerRect.xStart
      && xStart < centerRect.xEnd
      && yEnd > centerRect.yStart
      && yStart < centerRect.yEnd;
    rank = Math.min(rank, intersectsCenter ? 0 : intersectsViewport ? 1 : 2) as 0 | 1 | 2;
    const dx = (xStart + xEnd) / 2 - centerX;
    const dy = (yStart + yEnd) / 2 - centerY;
    distance = Math.min(distance, dx * dx + dy * dy);
  }
  return { rank, distance };
}

function contactSourceTilePriorityRanks(scene: ContactTileGpuScene) {
  const sourceLayout = scene.sourceLayout!;
  return {
    x: sourceAxisPriorityRanks(
      sourceLayout.xMap,
      scene.viewport.xStart,
      scene.viewport.xEnd,
    ),
    y: sourceAxisPriorityRanks(
      sourceLayout.yMap,
      scene.viewport.yStart,
      scene.viewport.yEnd,
    ),
  };
}

function sourceAxisPriorityRanks(
  map: ContactGpuLayoutMap,
  viewportStart: number,
  viewportEnd: number,
) {
  const ranks = new Map<number, 0 | 1 | 2>();
  const centerStart = viewportStart + (viewportEnd - viewportStart) * 0.25;
  const centerEnd = viewportEnd - (viewportEnd - viewportStart) * 0.25;
  for (const entry of map.entries) {
    if (!entry.valid) {
      continue;
    }
    const start = entry.visualBin * map.resolution;
    const end = start + map.resolution;
    const rank: 0 | 1 | 2 = end > centerStart && start < centerEnd
      ? 0
      : end > viewportStart && start < viewportEnd
        ? 1
        : 2;
    ranks.set(entry.sourceTile, Math.min(ranks.get(entry.sourceTile) ?? 2, rank) as 0 | 1 | 2);
  }
  return ranks;
}

function sourceTileUploadRank(
  tile: ContactMapTile,
  xRanks: ReadonlyMap<number, 0 | 1 | 2>,
  yRanks: ReadonlyMap<number, 0 | 1 | 2>,
): { rank: 0 | 1 | 2; distance: number } {
  const direct = Math.max(
    xRanks.get(tile.tileX) ?? 2,
    yRanks.get(tile.tileY) ?? 2,
  ) as 0 | 1 | 2;
  const transpose = Math.max(
    xRanks.get(tile.tileY) ?? 2,
    yRanks.get(tile.tileX) ?? 2,
  ) as 0 | 1 | 2;
  const rank = Math.min(direct, transpose) as 0 | 1 | 2;
  return {
    rank,
    distance: Math.min(
      Math.abs(tile.tileX - tile.tileY),
      Math.abs(tile.tileY - tile.tileX),
    ),
  };
}

/** Build the compact world-page rectangle sampled by the pointer shader. */
export function contactTileVirtualPagePlan(
  descriptors: readonly ContactTileCanvasDescriptor[],
): ContactTileVirtualPagePlan | null {
  if (descriptors.length === 0) {
    return null;
  }
  let minimumX = Number.POSITIVE_INFINITY;
  let maximumX = Number.NEGATIVE_INFINITY;
  let minimumY = Number.POSITIVE_INFINITY;
  let maximumY = Number.NEGATIVE_INFINITY;
  const pagesByCoordinate = new Map<string, ContactTileVirtualPage>();
  const populatedTiles = new Map<string, ContactMapTile>();
  for (const descriptor of descriptors) {
    const pageX = descriptor.transpose ? descriptor.tile.tileY : descriptor.tile.tileX;
    const pageY = descriptor.transpose ? descriptor.tile.tileX : descriptor.tile.tileY;
    if (!Number.isSafeInteger(pageX) || !Number.isSafeInteger(pageY) || pageX < 0 || pageY < 0) {
      return null;
    }
    const tileKey = contactTileKey(descriptor.tile);
    pagesByCoordinate.set(`${pageX}:${pageY}`, {
      pageX,
      pageY,
      tileKey,
      tile: descriptor.tile,
      transpose: descriptor.transpose,
    });
    if (contactTileCellCount(descriptor.tile) > 0) {
      populatedTiles.set(tileKey, descriptor.tile);
    }
    minimumX = Math.min(minimumX, pageX);
    maximumX = Math.max(maximumX, pageX);
    minimumY = Math.min(minimumY, pageY);
    maximumY = Math.max(maximumY, pageY);
  }
  const width = maximumX - minimumX + 1;
  const height = maximumY - minimumY + 1;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    return null;
  }
  return {
    originX: minimumX,
    originY: minimumY,
    width,
    height,
    pages: [...pagesByCoordinate.values()],
    populatedTiles: [...populatedTiles].map(([key, tile]) => ({ key, tile })),
  };
}

/** Build a compact NxN page table for sparse immutable source tile ids. */
export function contactTileSourcePagePlan(
  sourceTiles: readonly number[],
  descriptors: readonly ContactTileCanvasDescriptor[],
): ContactTileVirtualPagePlan | null {
  const compactBySourceTile = new Map<number, number>();
  for (const sourceTile of sourceTiles) {
    if (
      !Number.isSafeInteger(sourceTile)
      || sourceTile < 0
      || compactBySourceTile.has(sourceTile)
    ) {
      return null;
    }
    compactBySourceTile.set(sourceTile, compactBySourceTile.size);
  }
  const pagesByCoordinate = new Map<string, ContactTileVirtualPage>();
  const populatedTiles = new Map<string, ContactMapTile>();
  for (const descriptor of descriptors) {
    const worldX = descriptor.transpose ? descriptor.tile.tileY : descriptor.tile.tileX;
    const worldY = descriptor.transpose ? descriptor.tile.tileX : descriptor.tile.tileY;
    const pageX = compactBySourceTile.get(worldX);
    const pageY = compactBySourceTile.get(worldY);
    if (pageX === undefined || pageY === undefined) {
      return null;
    }
    const tileKey = contactTileKey(descriptor.tile);
    pagesByCoordinate.set(`${pageX}:${pageY}`, {
      pageX,
      pageY,
      tileKey,
      tile: descriptor.tile,
      transpose: descriptor.transpose,
    });
    if (contactTileCellCount(descriptor.tile) > 0) {
      populatedTiles.set(tileKey, descriptor.tile);
    }
  }
  const size = Math.max(1, sourceTiles.length);
  return {
    originX: 0,
    originY: 0,
    width: size,
    height: size,
    pages: [...pagesByCoordinate.values()],
    populatedTiles: [...populatedTiles].map(([key, tile]) => ({ key, tile })),
  };
}

export function contactTileVirtualPageTableData(
  plan: ContactTileVirtualPagePlan,
  layerByTileKey: ReadonlyMap<string, number>,
): Uint32Array | null {
  const values = new Uint32Array(plan.width * plan.height * 2);
  for (const page of plan.pages) {
    const offset = (
      (page.pageY - plan.originY) * plan.width
      + page.pageX - plan.originX
    ) * 2;
    const populated = contactTileCellCount(page.tile) > 0;
    const layer = populated ? layerByTileKey.get(page.tileKey) : undefined;
    if (populated && layer === undefined) {
      return null;
    }
    values[offset] = populated ? layer! + 1 : 0;
    values[offset + 1] = (
      (page.transpose ? contactTileVirtualPageTransposeFlag : 0)
      | contactTileVirtualPageExactFlag
    );
  }
  return values;
}

export interface ContactTileVirtualCamera {
  pageX: number;
  pageY: number;
  localX: number;
  localY: number;
  spanX: number;
  spanY: number;
}

/** Split large genome coordinates into exact integer pages and small shader floats. */
export function contactTileVirtualCamera(
  viewport: ContactViewport,
  resolution: number,
  tileSizeBins: number,
): ContactTileVirtualCamera {
  const tileSpan = resolution * tileSizeBins;
  if (!Number.isSafeInteger(tileSpan) || tileSpan <= 0) {
    throw new RangeError("virtual texture tile span must be a positive safe integer");
  }
  const pageX = Math.floor(viewport.xStart / tileSpan);
  const pageY = Math.floor(viewport.yStart / tileSpan);
  return {
    pageX,
    pageY,
    localX: viewport.xStart / tileSpan - pageX,
    localY: viewport.yStart / tileSpan - pageY,
    spanX: (viewport.xEnd - viewport.xStart) / tileSpan,
    spanY: (viewport.yEnd - viewport.yStart) / tileSpan,
  };
}

interface GpuTextureEntry {
  texture: WebGLTexture;
  format: ContactTileGpuTextureFormat;
  tile: ContactMapTile | null;
  deltaBuffer?: ContactTileDenseDeltaBuffer;
  panPrefetchSnapshot?: boolean;
  generation?: number;
  bytes: number;
  lastUsed: number;
}

interface GpuOverviewTextureEntry {
  texture: WebGLTexture;
  format: ContactTileGpuTextureFormat;
  values: Float32Array;
  width: number;
  height: number;
}

interface RendererResources {
  program: WebGLProgram;
  quadBuffer: WebGLBuffer;
  lutTexture: WebGLTexture;
  positionLocation: number;
  rectLocation: WebGLUniformLocation;
  canvasSizeLocation: WebGLUniformLocation;
  transposeLocation: WebGLUniformLocation;
  tileTextureLocation: WebGLUniformLocation;
  lutTextureLocation: WebGLUniformLocation;
  scaleLocation: WebGLUniformLocation;
  paletteStopCountLocation: WebGLUniformLocation;
}

interface BoundaryRendererResources {
  program: WebGLProgram;
  geometryBuffer: WebGLBuffer;
  instanceBuffer: WebGLBuffer;
  edgeLocation: number;
  intervalLocation: number;
  colorLocation: number;
  styleLocation: number;
  viewportLocation: WebGLUniformLocation;
  canvasSizeLocation: WebGLUniformLocation;
  cssSizeLocation: WebGLUniformLocation;
  cssScaleLocation: WebGLUniformLocation;
}

interface FramePresentationResources {
  framebuffer: WebGLFramebuffer;
  texture: WebGLTexture;
  width: number;
  height: number;
}

interface VirtualTextureRendererResources {
  program: WebGLProgram;
  positionLocation: number;
  tileArrayLocation: WebGLUniformLocation;
  pageTableLocation: WebGLUniformLocation;
  lutTextureLocation: WebGLUniformLocation;
  overviewTextureLocation: WebGLUniformLocation;
  cameraTilesLocation: WebGLUniformLocation;
  cameraPageLocation: WebGLUniformLocation;
  pageOriginLocation: WebGLUniformLocation;
  pageSizeLocation: WebGLUniformLocation;
  overviewUvRectLocation: WebGLUniformLocation;
  hasOverviewLocation: WebGLUniformLocation;
  scaleLocation: WebGLUniformLocation;
  overviewScaleLocation: WebGLUniformLocation;
  paletteStopCountLocation: WebGLUniformLocation;
  hasSourceLayoutLocation: WebGLUniformLocation;
  layoutXAddressLocation: WebGLUniformLocation;
  layoutYAddressLocation: WebGLUniformLocation;
  layoutXWeightLocation: WebGLUniformLocation;
  layoutYWeightLocation: WebGLUniformLocation;
  layoutSizesLocation: WebGLUniformLocation;
  layoutCameraLocation: WebGLUniformLocation;
}

interface VirtualTextureState {
  tileArray: WebGLTexture;
  pageTable: WebGLTexture;
  capacity: number;
  resolution: number;
  tileSizeBins: number;
  format: ContactTileGpuTextureFormat;
  layerByTileKey: Map<string, number>;
  tileByTileKey: Map<string, ContactMapTile>;
  generationByTileKey: Map<string, number | undefined>;
  lastUsedByTileKey: Map<string, number>;
  plan: ContactTileVirtualPagePlan;
  pageTableData: Uint32Array;
  bytes: number;
}

interface SourceLayoutTextureState {
  xAddress: WebGLTexture;
  yAddress: WebGLTexture;
  xWeight: WebGLTexture;
  yWeight: WebGLTexture;
  xMap: ContactGpuLayoutMap;
  yMap: ContactGpuLayoutMap;
  sourceTilesSignature: string;
  bytes: number;
}

function virtualTextureResidentKey(
  dataScope: string,
  resolution: number,
  tileSizeBins: number,
  tileKey: string,
) {
  return `${dataScope}|${resolution}|${tileSizeBins}|${tileKey}`;
}

function virtualTextureAtlasKey(scene: ContactTileGpuScene, tileKey: string) {
  return virtualTextureResidentKey(
    scene.sourceLayout?.dataScope ?? scene.dataScope ?? "",
    scene.resolution,
    scene.tileSizeBins,
    tileKey,
  );
}

function virtualTexturePageLayers(
  scene: ContactTileGpuScene,
  plan: ContactTileVirtualPagePlan,
  atlasLayers: ReadonlyMap<string, number>,
) {
  return new Map(plan.populatedTiles.flatMap(({ key }) => {
    const layer = atlasLayers.get(virtualTextureAtlasKey(scene, key));
    return layer === undefined ? [] : [[key, layer] as const];
  }));
}

const vertexShaderSource = `#version 300 es
in vec2 a_position;
uniform vec4 u_rect;
uniform vec2 u_canvas_size;
uniform bool u_transpose;
out vec2 v_uv;

void main() {
  vec2 pixel = u_rect.xy + a_position * u_rect.zw;
  vec2 clip = (pixel / u_canvas_size) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_uv = u_transpose ? a_position.yx : a_position;
}
`;

const fragmentShaderSource = `#version 300 es
precision highp float;
precision highp sampler2D;

uniform sampler2D u_tile;
uniform sampler2D u_lut;
uniform vec4 u_scale;
uniform float u_palette_stop_count;
in vec2 v_uv;
out vec4 out_color;

void main() {
  float value = texture(u_tile, v_uv).r;
  if (value < 0.0) {
    discard;
  }

  float minimum = u_scale.x;
  float maximum = u_scale.y;
  float intensity;
  if (maximum == minimum) {
    intensity = value >= maximum ? 1.0 : 0.0;
  } else if (u_scale.z > 0.5) {
    float log_minimum = log(minimum + 1.0) / log(10.0);
    float log_range = log(maximum + 1.0) / log(10.0) - log_minimum;
    intensity = (log(value + 1.0) / log(10.0) - log_minimum) / log_range;
  } else {
    intensity = (value - minimum) / (maximum - minimum);
  }
  intensity = clamp(intensity, 0.0, 1.0);

  float lut_index;
  if (u_palette_stop_count > 0.5) {
    float stop_index = min(
      u_palette_stop_count - 1.0,
      floor(intensity * u_palette_stop_count)
    );
    float representative = (stop_index + 0.5) / u_palette_stop_count;
    lut_index = floor(representative * 255.0);
  } else {
    lut_index = floor(intensity * 255.0);
  }
  vec4 color = texelFetch(u_lut, ivec2(int(lut_index), 0), 0);
  // The heatmap surface is white. Resolve palette alpha here instead of
  // relying on WKWebView to composite a transparent WebGL framebuffer; the
  // latter can expose black clear pixels and also applies alpha twice.
  out_color = vec4(mix(vec3(1.0), color.rgb, color.a), 1.0);
}
`;

const virtualTextureVertexShaderSource = `#version 300 es
in vec2 a_position;
out vec2 v_uv;

void main() {
  vec2 clip = a_position * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_uv = a_position;
}
`;

const virtualTextureFragmentShaderSource = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DArray;
precision highp usampler2D;

uniform sampler2DArray u_tile_array;
uniform usampler2D u_page_table;
uniform sampler2D u_lut;
uniform sampler2D u_overview;
uniform vec4 u_camera_tiles;
uniform ivec2 u_camera_page;
uniform ivec2 u_page_origin;
uniform ivec2 u_page_size;
uniform vec4 u_overview_uv_rect;
uniform bool u_has_overview;
uniform vec4 u_scale;
uniform vec4 u_overview_scale;
uniform float u_palette_stop_count;
uniform bool u_has_source_layout;
uniform usampler2D u_layout_x_address;
uniform usampler2D u_layout_y_address;
uniform sampler2D u_layout_x_weight;
uniform sampler2D u_layout_y_weight;
uniform ivec2 u_layout_sizes;
uniform vec4 u_layout_camera;
in vec2 v_uv;
out vec4 out_color;

float sample_overview(vec2 viewport_uv) {
  if (!u_has_overview) {
    return -1.0;
  }
  vec2 uv = vec2(
    u_overview_uv_rect.x + viewport_uv.x * u_overview_uv_rect.y,
    u_overview_uv_rect.z + viewport_uv.y * u_overview_uv_rect.w
  );
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThanEqual(uv, vec2(1.0)))) {
    return -1.0;
  }
  return texture(u_overview, uv).r;
}

vec4 palette(float value, vec4 scale) {
  float minimum = scale.x;
  float maximum = scale.y;
  float intensity;
  if (maximum == minimum) {
    intensity = value >= maximum ? 1.0 : 0.0;
  } else if (scale.z > 0.5) {
    float log_minimum = log(minimum + 1.0) / log(10.0);
    float log_range = log(maximum + 1.0) / log(10.0) - log_minimum;
    intensity = (log(value + 1.0) / log(10.0) - log_minimum) / log_range;
  } else {
    intensity = (value - minimum) / (maximum - minimum);
  }
  intensity = clamp(intensity, 0.0, 1.0);
  float lut_index;
  if (u_palette_stop_count > 0.5) {
    float stop_index = min(
      u_palette_stop_count - 1.0,
      floor(intensity * u_palette_stop_count)
    );
    float representative = (stop_index + 0.5) / u_palette_stop_count;
    lut_index = floor(representative * 255.0);
  } else {
    lut_index = floor(intensity * 255.0);
  }
  vec4 color = texelFetch(u_lut, ivec2(int(lut_index), 0), 0);
  return vec4(mix(vec3(1.0), color.rgb, color.a), 1.0);
}

void main() {
  if (u_has_source_layout) {
    int x_index = int(floor(u_layout_camera.x + v_uv.x * u_layout_camera.y));
    int y_index = int(floor(u_layout_camera.z + v_uv.y * u_layout_camera.w));
    bool map_in_range = x_index >= 0 && x_index < u_layout_sizes.x
      && y_index >= 0 && y_index < u_layout_sizes.y;
    uvec4 x_address = map_in_range
      ? texelFetch(u_layout_x_address, ivec2(x_index, 0), 0)
      : uvec4(0u);
    uvec4 y_address = map_in_range
      ? texelFetch(u_layout_y_address, ivec2(y_index, 0), 0)
      : uvec4(0u);
    bool exact_mapping = (x_address.b & 5u) == 5u
      && (y_address.b & 5u) == 5u;
    if (!exact_mapping) {
      out_color = vec4(1.0);
      return;
    }
    ivec2 source_page = ivec2(int(x_address.r), int(y_address.r));
    bool source_page_in_range = all(greaterThanEqual(source_page, ivec2(0)))
      && all(lessThan(source_page, u_page_size));
    uvec2 source_entry = source_page_in_range
      ? texelFetch(u_page_table, source_page, 0).rg
      : uvec2(0u);
    float source_value = -1.0;
    if (source_entry.r > 0u) {
      ivec2 source_bin = ivec2(int(x_address.g), int(y_address.g));
      if ((source_entry.g & 1u) != 0u) {
        source_bin = source_bin.yx;
      }
      source_value = texelFetch(
        u_tile_array,
        ivec3(source_bin, int(source_entry.r - 1u)),
        0
      ).r;
      float x_weight = texelFetch(u_layout_x_weight, ivec2(x_index, 0), 0).r;
      float y_weight = texelFetch(u_layout_y_weight, ivec2(y_index, 0), 0).r;
      source_value *= x_weight * y_weight;
    }
    out_color = source_value >= 0.0
      ? palette(source_value, u_scale)
      : vec4(1.0);
    return;
  }
  vec2 relative_tile = vec2(
    u_camera_tiles.x + v_uv.x * u_camera_tiles.y,
    u_camera_tiles.z + v_uv.y * u_camera_tiles.w
  );
  ivec2 world_page = u_camera_page + ivec2(floor(relative_tile));
  ivec2 page = world_page - u_page_origin;
  bool page_in_range = all(greaterThanEqual(page, ivec2(0)))
    && all(lessThan(page, u_page_size));
  uvec2 entry = page_in_range
    ? texelFetch(u_page_table, page, 0).rg
    : uvec2(0u);
  bool exact_page = (entry.g & 2u) != 0u;
  float value = -1.0;
  if (entry.r > 0u) {
    vec2 local = fract(relative_tile);
    if ((entry.g & 1u) != 0u) {
      local = local.yx;
    }
    value = texture(u_tile_array, vec3(local, float(entry.r - 1u))).r;
  }
  if (value >= 0.0) {
    out_color = palette(value, u_scale);
    return;
  }
  if (exact_page) {
    out_color = vec4(1.0);
    return;
  }
  float overview_value = sample_overview(v_uv);
  out_color = overview_value >= 0.0
    ? palette(overview_value, u_overview_scale)
    : vec4(1.0);
}
`;

const boundaryVertexShaderSource = `#version 300 es
in vec4 a_edge;
in vec2 a_interval;
in vec3 a_color;
in vec2 a_style;
uniform vec4 u_viewport;
uniform vec2 u_canvas_size;
uniform vec2 u_css_size;
uniform vec2 u_css_scale;
out vec3 v_color;

void main() {
  float axis = a_edge.x;
  float side = a_edge.y;
  float along = a_edge.z;
  float across = a_edge.w;
  float start = a_interval.x;
  float end = a_interval.y;
  float span = max(0.0, end - start);
  float span_pixels = min(
    (span / max(1.0, u_viewport.y)) * u_css_size.x,
    (span / max(1.0, u_viewport.w)) * u_css_size.y
  );
  if (span <= 0.0 || span_pixels < a_style.y) {
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
    v_color = a_color;
    return;
  }

  float edge_coordinate = mix(start, end, side);
  float along_coordinate = mix(start, end, along);
  vec2 world = axis < 0.5
    ? vec2(along_coordinate, edge_coordinate)
    : vec2(edge_coordinate, along_coordinate);
  vec2 normalized = vec2(
    (world.x - u_viewport.x) / max(1.0, u_viewport.y),
    (world.y - u_viewport.z) / max(1.0, u_viewport.w)
  );
  vec2 clip = normalized * 2.0 - 1.0;
  vec2 pixel_offset = axis < 0.5
    ? vec2(0.0, across * a_style.x * u_css_scale.y)
    : vec2(across * a_style.x * u_css_scale.x, 0.0);
  clip += vec2(
    (pixel_offset.x / u_canvas_size.x) * 2.0,
    (pixel_offset.y / u_canvas_size.y) * 2.0
  );
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_color = a_color;
}
`;

const boundaryFragmentShaderSource = `#version 300 es
precision highp float;
in vec3 v_color;
out vec4 out_color;

void main() {
  out_color = vec4(v_color, 1.0);
}
`;

const boundaryInstanceStrideFloats = 7;

/** Pack immutable world-space boundaries once; pointer pans reuse this buffer. */
export function contactTileGpuBoundaryInstanceData(
  boundaries: readonly ContactTileGpuBoundary[],
): Float32Array {
  const values = new Float32Array(boundaries.length * boundaryInstanceStrideFloats);
  let offset = 0;
  for (const boundary of boundaries) {
    values[offset] = boundary.visualStart;
    values[offset + 1] = boundary.visualEnd;
    values[offset + 2] = boundary.color[0];
    values[offset + 3] = boundary.color[1];
    values[offset + 4] = boundary.color[2];
    values[offset + 5] = Math.max(0.5, boundary.lineWidthCssPx);
    values[offset + 6] = Math.max(0, boundary.minimumSpanCssPx);
    offset += boundaryInstanceStrideFloats;
  }
  return values;
}

/**
 * Build a dense single-channel count texture. -1 marks a missing contact so
 * the shader can distinguish it from a real zero without a second occupancy
 * texture. Diagonal tiles are completed here; off-diagonal mirrors reuse the
 * same GPU texture with transposed UV coordinates.
 */
export function contactTileFloatTextureData(
  tile: ContactMapTile,
  tileSizeBins: number,
): Float32Array {
  if (!Number.isSafeInteger(tileSizeBins) || tileSizeBins <= 0) {
    throw new RangeError("contact tile size must be a positive integer");
  }
  const cellCount = tileSizeBins * tileSizeBins;
  const dense = validatedDenseContactTileValues(tile);
  if (dense) {
    if (dense.values.length !== cellCount) {
      throw new RangeError("dense contact tile does not match tile size");
    }
    const source = dense.format === "r16f"
      ? contactTileR16fValuesToFloat32(dense.values)
      : dense.values;
    if (tile.tileX !== tile.tileY) {
      return source;
    }
    const mirrored = source.slice();
    for (let index = 0; index < cellCount; index += 1) {
      const value = source[index];
      if (value === -1) {
        continue;
      }
      const x = index % tileSizeBins;
      const y = Math.floor(index / tileSizeBins);
      if (x !== y) {
        mirrored[x * tileSizeBins + y] = value;
      }
    }
    return mirrored;
  }
  const values = new Float32Array(cellCount);
  values.fill(-1);
  const packed = validatedPackedContactTileCells(tile);
  const mirrorsDiagonal = tile.tileX === tile.tileY;

  const write = (x: number, y: number, value: number) => {
    if (
      x < 0
      || y < 0
      || x >= tileSizeBins
      || y >= tileSizeBins
      || !Number.isInteger(x)
      || !Number.isInteger(y)
    ) {
      return;
    }
    values[y * tileSizeBins + x] = value;
    if (mirrorsDiagonal && x !== y) {
      values[x * tileSizeBins + y] = value;
    }
  };

  if (packed) {
    for (let index = 0; index < packed.counts.length; index += 1) {
      write(packed.xLocal[index], packed.yLocal[index], packed.counts[index]);
    }
    return values;
  }

  const tileStartX = tile.tileX * tileSizeBins;
  const tileStartY = tile.tileY * tileSizeBins;
  for (const cell of tile.cells) {
    write(cell.xBin - tileStartX, cell.yBin - tileStartY, cell.count);
  }
  return values;
}

/** Preserve GPU-ready half bits when a completed display-cache tile provides them. */
export function contactTileGpuTextureData(
  tile: ContactMapTile,
  tileSizeBins: number,
): ContactTileGpuTextureData {
  const dense = validatedDenseContactTileValues(tile);
  if (dense?.format !== "r16f") {
    return { format: "float32", values: contactTileFloatTextureData(tile, tileSizeBins) };
  }
  const cellCount = tileSizeBins * tileSizeBins;
  if (dense.values.length !== cellCount) {
    throw new RangeError("dense R16F contact tile does not match tile size");
  }
  if (tile.tileX !== tile.tileY) {
    return { format: "r16f", values: dense.values };
  }
  const mirrored = dense.values.slice();
  for (let index = 0; index < cellCount; index += 1) {
    const value = dense.values[index];
    if (value === contactTileR16fEmptySentinel) {
      continue;
    }
    const x = index % tileSizeBins;
    const y = Math.floor(index / tileSizeBins);
    if (x !== y) {
      mirrored[x * tileSizeBins + y] = value;
    }
  }
  return { format: "r16f", values: mirrored };
}

/** Fixed-size whole-assembly base texture used by the main viewport. */
export function contactOverviewFloatTextureData(
  map: Pick<ContactMapView, "cells" | "resolution" | "viewport">,
  targetBins = contactOverviewTextureBins,
  colorScale?: ContactTileRenderStyle["colorScale"],
): ContactTileGpuOverview {
  if (!Number.isSafeInteger(targetBins) || targetBins <= 0) {
    throw new RangeError("contact overview size must be a positive integer");
  }
  if (!Number.isFinite(map.resolution) || map.resolution <= 0) {
    throw new RangeError("contact overview resolution must be positive");
  }
  const xSpan = map.viewport.xEnd - map.viewport.xStart;
  const ySpan = map.viewport.yEnd - map.viewport.yStart;
  if (!(xSpan > 0) || !(ySpan > 0)) {
    throw new RangeError("contact overview viewport must have positive area");
  }

  const values = new Float32Array(targetBins * targetBins);
  values.fill(-1);
  const writeRectangle = (
    xStartBp: number,
    xEndBp: number,
    yStartBp: number,
    yEndBp: number,
    value: number,
  ) => {
    const left = Math.max(0, Math.floor(
      ((xStartBp - map.viewport.xStart) / xSpan) * targetBins,
    ));
    const right = Math.min(targetBins, Math.ceil(
      ((xEndBp - map.viewport.xStart) / xSpan) * targetBins,
    ));
    const top = Math.max(0, Math.floor(
      ((yStartBp - map.viewport.yStart) / ySpan) * targetBins,
    ));
    const bottom = Math.min(targetBins, Math.ceil(
      ((yEndBp - map.viewport.yStart) / ySpan) * targetBins,
    ));
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        const index = y * targetBins + x;
        values[index] = values[index] < 0 ? value : Math.max(values[index], value);
      }
    }
  };

  for (const cell of map.cells) {
    if (
      !Number.isFinite(cell.xBin)
      || !Number.isFinite(cell.yBin)
      || !Number.isFinite(cell.count)
    ) {
      continue;
    }
    const xStartBp = cell.xBin * map.resolution;
    const yStartBp = cell.yBin * map.resolution;
    writeRectangle(
      xStartBp,
      xStartBp + map.resolution,
      yStartBp,
      yStartBp + map.resolution,
      cell.count,
    );
    if (cell.xBin !== cell.yBin) {
      writeRectangle(
        yStartBp,
        yStartBp + map.resolution,
        xStartBp,
        xStartBp + map.resolution,
        cell.count,
      );
    }
  }

  return {
    values,
    width: targetBins,
    height: targetBins,
    viewport: map.viewport,
    colorScale,
  };
}

export function contactOverviewTextureBytes(
  width = contactOverviewTextureBins,
  height = contactOverviewTextureBins,
  format: ContactTileGpuTextureFormat = "r16f",
) {
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    throw new RangeError("contact overview dimensions must be positive integers");
  }
  return width * height * contactTileGpuBytesPerTexel(format);
}

export function contactTileGpuBytesPerTexel(format: ContactTileGpuTextureFormat) {
  return format === "r16f" ? 2 : Float32Array.BYTES_PER_ELEMENT;
}

export function contactTileGpuFloatValuesFitR16f(values: Float32Array) {
  for (const value of values) {
    if (!Number.isFinite(value) || Math.abs(value) > contactTileGpuR16fMaximum) {
      return false;
    }
  }
  return true;
}

/**
 * Pick one storage format for the complete virtual-texture atlas. A texture
 * array cannot mix R16F and R32F layers, so a single overflowing source tile
 * upgrades the whole scene before any layer is submitted. This keeps a mixed
 * display-cache response on the shared GPU path instead of failing halfway
 * through the upload queue and disabling WebGL for the layer.
 */
export function contactTileGpuSceneTextureFormat(
  scene: ContactTileGpuScene,
  preference: ContactTileGpuTexturePreference = "r16f",
): ContactTileGpuTextureFormat {
  if (preference === "r32f") {
    return "r32f";
  }
  const descriptors = scene.sourceLayout?.descriptors ?? scene.descriptors;
  const inspectedTiles = new Set<ContactMapTile>();
  for (const descriptor of descriptors) {
    const tile = descriptor.tile;
    if (inspectedTiles.has(tile) || contactTileCellCount(tile) === 0) {
      continue;
    }
    inspectedTiles.add(tile);
    const dense = validatedDenseContactTileValues(tile);
    if (dense?.format === "r16f") {
      continue;
    }
    if (dense?.format === "float32") {
      if (!contactTileGpuFloatValuesFitR16f(dense.values)) {
        return "r32f";
      }
      continue;
    }
    const packed = validatedPackedContactTileCells(tile);
    if (packed) {
      for (const value of packed.counts) {
        if (!Number.isFinite(value) || Math.abs(value) > contactTileGpuR16fMaximum) {
          return "r32f";
        }
      }
    } else {
      for (const cell of tile.cells) {
        if (!Number.isFinite(cell.count) || Math.abs(cell.count) > contactTileGpuR16fMaximum) {
          return "r32f";
        }
      }
    }
  }
  return "r16f";
}

export function contactTileGpuTexturePreference(
  search = typeof location === "undefined" ? "" : location.search,
): ContactTileGpuTexturePreference {
  return new URLSearchParams(search).get("cstudioGpuTexture") === "r32f"
    ? "r32f"
    : "r16f";
}

export function contactTileGpuVirtualTextureEnabled(
  search = typeof location === "undefined" ? "" : location.search,
) {
  return new URLSearchParams(search).get("cstudioVirtualTexture") !== "0";
}

/** Convert the mutable streamed accumulator into the single-channel texture layout. */
export function contactTileDenseFloatTextureData(
  buffer: ContactTileDenseDeltaBuffer,
  tileSizeBins: number,
  target?: Float32Array,
): Float32Array {
  if (!Number.isSafeInteger(tileSizeBins) || tileSizeBins <= 0) {
    throw new RangeError("contact tile size must be a positive integer");
  }
  const cellCount = tileSizeBins * tileSizeBins;
  if (buffer.completeR16fValues) {
    if (buffer.completeR16fValues.length !== cellCount) {
      throw new RangeError("completed dense R16F contact tile does not match tile size");
    }
    const values = contactTileR16fValuesToFloat32(buffer.completeR16fValues, target);
    if (buffer.tile.tileX !== buffer.tile.tileY) {
      return values;
    }
    for (let index = 0; index < cellCount; index += 1) {
      const value = values[index];
      if (value === -1) {
        continue;
      }
      const x = index % tileSizeBins;
      const y = Math.floor(index / tileSizeBins);
      if (x !== y) {
        values[x * tileSizeBins + y] = value;
      }
    }
    return values;
  }
  if (buffer.completeValues) {
    if (buffer.completeValues.length !== cellCount) {
      throw new RangeError("completed dense contact tile does not match tile size");
    }
    if (buffer.tile.tileX !== buffer.tile.tileY) {
      return buffer.completeValues;
    }
    const values = target ?? new Float32Array(cellCount);
    values.set(buffer.completeValues);
    for (let index = 0; index < cellCount; index += 1) {
      const value = buffer.completeValues[index];
      if (value === -1) {
        continue;
      }
      const x = index % tileSizeBins;
      const y = Math.floor(index / tileSizeBins);
      if (x !== y) {
        values[x * tileSizeBins + y] = value;
      }
    }
    return values;
  }
  if (buffer.counts.length !== cellCount || buffer.occupied.length !== cellCount) {
    throw new RangeError("contact delta buffer does not match tile size");
  }
  const values = target ?? new Float32Array(cellCount);
  if (values.length !== cellCount) {
    throw new RangeError("contact delta texture target does not match tile size");
  }
  values.fill(-1);
  const mirrorsDiagonal = buffer.tile.tileX === buffer.tile.tileY;
  for (let index = 0; index < cellCount; index += 1) {
    if (buffer.occupied[index] === 0) {
      continue;
    }
    const value = buffer.counts[index];
    values[index] = value;
    if (mirrorsDiagonal) {
      const x = index % tileSizeBins;
      const y = Math.floor(index / tileSizeBins);
      if (x !== y) {
        values[x * tileSizeBins + y] = value;
      }
    }
  }
  return values;
}

export function contactTileDenseGpuTextureData(
  buffer: ContactTileDenseDeltaBuffer,
  tileSizeBins: number,
  floatTarget?: Float32Array,
): ContactTileGpuTextureData {
  const values = buffer.completeR16fValues;
  if (!values) {
    return {
      format: "float32",
      values: contactTileDenseFloatTextureData(buffer, tileSizeBins, floatTarget),
    };
  }
  const cellCount = tileSizeBins * tileSizeBins;
  if (values.length !== cellCount) {
    throw new RangeError("completed dense R16F contact tile does not match tile size");
  }
  if (buffer.tile.tileX !== buffer.tile.tileY) {
    return { format: "r16f", values };
  }
  const mirrored = values.slice();
  for (let index = 0; index < cellCount; index += 1) {
    const value = values[index];
    if (value === contactTileR16fEmptySentinel) {
      continue;
    }
    const x = index % tileSizeBins;
    const y = Math.floor(index / tileSizeBins);
    if (x !== y) {
      mirrored[x * tileSizeBins + y] = value;
    }
  }
  return { format: "r16f", values: mirrored };
}

interface ContactTileGpuMutablePerformance extends ContactTileGpuPerformanceSnapshot {
  lastEmissionSignature: string;
}

interface ContactTileGpuUploadContext {
  preference: ContactTileGpuTexturePreference;
  performance: ContactTileGpuMutablePerformance;
  clock: () => number;
}

interface ContactTileGpuUploadResult {
  format: ContactTileGpuTextureFormat;
  bytes: number;
}

function initialContactTileGpuPerformance(
  texturePreference: ContactTileGpuTexturePreference,
): ContactTileGpuMutablePerformance {
  return {
    texturePreference,
    uploads: 0,
    fullUploads: 0,
    subUploads: 0,
    r16fUploads: 0,
    r32fUploads: 0,
    rangeFallbacks: 0,
    uploadErrorFallbacks: 0,
    uploadMilliseconds: 0,
    evictions: 0,
    evictedBytes: 0,
    cacheEntries: 0,
    cacheBytes: 0,
    scenePromotions: 0,
    scenePromotionMisses: 0,
    scenePromotionMilliseconds: 0,
    virtualTextureDraws: 0,
    virtualTextureFallbacks: 0,
    virtualTextureUploads: 0,
    virtualTexturePages: 0,
    virtualTextureLayers: 0,
    virtualTextureBytes: 0,
    virtualTextureRebuilds: 0,
    sourceLayoutDraws: 0,
    sourceLayoutUploads: 0,
    sourceLayoutBytes: 0,
    stagedSceneDraws: 0,
    framebufferSwaps: 0,
    uploadQueueFrames: 0,
    uploadQueueDeferredFrames: 0,
    uploadQueueMaxDepth: 0,
    uploadQueueBytes: 0,
    uploadQueueMilliseconds: 0,
    uploadQueueMaxFrameBytes: 0,
    uploadQueueMaxFrameMilliseconds: 0,
    uploadFencePolls: 0,
    uploadFenceWaitFrames: 0,
    uploadFenceSignals: 0,
    uploadFenceFailures: 0,
    lastEmissionSignature: "",
  };
}

function contactTileGpuPerformanceSnapshot(
  performance: ContactTileGpuMutablePerformance,
): ContactTileGpuPerformanceSnapshot {
  const { lastEmissionSignature: _lastEmissionSignature, ...snapshot } = performance;
  return { ...snapshot };
}

function formatContactTileGpuPerformanceLog(
  snapshot: ContactTileGpuPerformanceSnapshot,
  generation: number | null,
) {
  return [
    "CSTUDIO_PERF",
    "event=contact_gpu_texture",
    `generation=${generation ?? "null"}`,
    `texture_preference=${snapshot.texturePreference}`,
    `uploads=${snapshot.uploads}`,
    `full_uploads=${snapshot.fullUploads}`,
    `sub_uploads=${snapshot.subUploads}`,
    `r16f_uploads=${snapshot.r16fUploads}`,
    `r32f_uploads=${snapshot.r32fUploads}`,
    `range_fallbacks=${snapshot.rangeFallbacks}`,
    `upload_error_fallbacks=${snapshot.uploadErrorFallbacks}`,
    `upload_ms=${roundGpuMilliseconds(snapshot.uploadMilliseconds)}`,
    `evictions=${snapshot.evictions}`,
    `evicted_bytes=${snapshot.evictedBytes}`,
    `cache_entries=${snapshot.cacheEntries}`,
    `cache_bytes=${snapshot.cacheBytes}`,
    `scene_promotions=${snapshot.scenePromotions}`,
    `scene_promotion_misses=${snapshot.scenePromotionMisses}`,
    `scene_promotion_ms=${roundGpuMilliseconds(snapshot.scenePromotionMilliseconds)}`,
    `virtual_texture_draws=${snapshot.virtualTextureDraws}`,
    `virtual_texture_fallbacks=${snapshot.virtualTextureFallbacks}`,
    `virtual_texture_uploads=${snapshot.virtualTextureUploads}`,
    `virtual_texture_pages=${snapshot.virtualTexturePages}`,
    `virtual_texture_layers=${snapshot.virtualTextureLayers}`,
    `virtual_texture_bytes=${snapshot.virtualTextureBytes}`,
    `virtual_texture_rebuilds=${snapshot.virtualTextureRebuilds}`,
    `source_layout_draws=${snapshot.sourceLayoutDraws}`,
    `source_layout_uploads=${snapshot.sourceLayoutUploads}`,
    `source_layout_bytes=${snapshot.sourceLayoutBytes}`,
    `staged_scene_draws=${snapshot.stagedSceneDraws}`,
    `framebuffer_swaps=${snapshot.framebufferSwaps}`,
    `upload_queue_frames=${snapshot.uploadQueueFrames}`,
    `upload_queue_deferred_frames=${snapshot.uploadQueueDeferredFrames}`,
    `upload_queue_max_depth=${snapshot.uploadQueueMaxDepth}`,
    `upload_queue_bytes=${snapshot.uploadQueueBytes}`,
    `upload_queue_ms=${roundGpuMilliseconds(snapshot.uploadQueueMilliseconds)}`,
    `upload_queue_max_frame_bytes=${snapshot.uploadQueueMaxFrameBytes}`,
    `upload_queue_max_frame_ms=${roundGpuMilliseconds(snapshot.uploadQueueMaxFrameMilliseconds)}`,
    `upload_fence_polls=${snapshot.uploadFencePolls}`,
    `upload_fence_wait_frames=${snapshot.uploadFenceWaitFrames}`,
    `upload_fence_signals=${snapshot.uploadFenceSignals}`,
    `upload_fence_failures=${snapshot.uploadFenceFailures}`,
  ].join(" ");
}

function roundGpuMilliseconds(value: number) {
  return Math.round(Math.max(0, value) * 1_000) / 1_000;
}

export function createContactTileGpuRenderer(
  canvas: HTMLCanvasElement,
  textureBudgetBytes = contactTileGpuTextureBudgetBytes,
  options: ContactTileGpuRendererOptions = {},
): ContactTileGpuRenderer | null {
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    depth: false,
    // The retained front/staging FBOs make scene replacement atomic, but they
    // do not keep WebKit's final default framebuffer alive after compositing.
    // WKWebView can discard that opaque surface as solid black after a load or
    // resize unless it is preserved, even though the authoritative front FBO
    // is still valid.
    desynchronized: false,
    failIfMajorPerformanceCaveat: false,
    powerPreference: "high-performance",
    premultipliedAlpha: true,
    preserveDrawingBuffer: true,
    stencil: false,
  });
  if (!gl) {
    return null;
  }
  const actualContextAttributes = gl.getContextAttributes();
  traceContactPanCamera("gpu_context_created", {
    desynchronized: actualContextAttributes?.desynchronized ?? null,
    preserveDrawingBuffer: actualContextAttributes?.preserveDrawingBuffer ?? null,
  });

  const resources = createRendererResources(gl);
  if (!resources) {
    return null;
  }
  const boundaryResources = createBoundaryRendererResources(gl);
  if (!boundaryResources) {
    gl.deleteTexture(resources.lutTexture);
    gl.deleteBuffer(resources.quadBuffer);
    gl.deleteProgram(resources.program);
    return null;
  }
  // The virtual-texture program is an optional WebGL2 acceleration path. A
  // driver/compiler miss leaves the established per-tile renderer available.
  const virtualTextureEnabled = options.virtualTextureEnabled
    ?? contactTileGpuVirtualTextureEnabled();
  const virtualResources = virtualTextureEnabled
    ? createVirtualTextureRendererResources(gl)
    : null;

  // A first streamed generation may intentionally have no presentable front
  // yet. Initialize the opaque WebGL surface to the same white loading plane
  // as its container so the atomic gate cannot expose the context's default
  // black buffer while it waits for complete exact coverage.
  resizeCanvasToDisplaySize(canvas, gl);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(1, 1, 1, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);

  const texturePreference = options.texturePreference ?? contactTileGpuTexturePreference();
  const performanceEnabled = options.performanceEnabled ?? isContactTilePerformanceEnabled();
  const emitPerformance = options.emitPerformance ?? ((line: string) => console.info(line));
  const uploadBudgetBytes = Math.max(
    1,
    Math.floor(options.uploadBudgetBytes ?? contactTileGpuUploadBudgetBytes),
  );
  const uploadBudgetMilliseconds = Math.max(
    0.1,
    options.uploadBudgetMilliseconds ?? contactTileGpuUploadBudgetMilliseconds,
  );
  const requestUploadFrame = options.requestFrame ?? ((callback: FrameRequestCallback) => (
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame(callback)
      : Number(globalThis.setTimeout(() => callback(Date.now()), 16))
  ));
  const cancelUploadFrame = options.cancelFrame ?? ((handle: number) => {
    if (typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(handle);
    } else {
      globalThis.clearTimeout(handle);
    }
  });
  const uploadContext: ContactTileGpuUploadContext = {
    preference: texturePreference,
    performance: initialContactTileGpuPerformance(texturePreference),
    clock: options.clock ?? (() => (
      typeof performance === "undefined" ? Date.now() : performance.now()
    )),
  };
  const textureCache = new Map<string, GpuTextureEntry>();
  const safeTextureBudget = Math.max(1, Math.floor(textureBudgetBytes));
  let textureBytes = 0;
  let useCounter = 0;
  let scene: ContactTileGpuScene | null = null;
  let deltaScene: ContactTileGpuDeltaScene | null = null;
  let deltaBuffers = new Map<string, ContactTileDenseDeltaBuffer>();
  let deltaScratch = new Float32Array(0);
  const pendingAppendedDescriptors = new Map<string, ContactTileCanvasDescriptor>();
  let overviewTextureEntry: GpuOverviewTextureEntry | null = null;
  let destroyed = false;
  let lutColormap: ContactTileRenderStyle["colormap"] | null = null;
  let presentedCssWidth = 1;
  let presentedCssHeight = 1;
  let uploadedBoundaries: readonly ContactTileGpuBoundary[] | null = null;
  let uploadedBoundaryCount = 0;
  let framePresentation: FramePresentationResources | null = null;
  let stagingFramePresentation: FramePresentationResources | null = null;
  let hasPresentedFrontFrame = false;
  let virtualTextureState: VirtualTextureState | null = null;
  let sourceLayoutTextureState: SourceLayoutTextureState | null = null;
  let scheduledUploadFrame: number | null = null;
  let nextUploadRequestId = 1;

  interface PendingVirtualPresentation {
    id: number;
    scene: ContactTileGpuScene;
    visibleScene: ContactTileGpuScene;
    target: "front" | "staging";
    onPresented?: (presented: boolean) => void;
  }

  interface PendingPresentationFence extends PendingVirtualPresentation {
    sync: WebGLSync;
    presentation: FramePresentationResources;
  }

  let pendingVirtualPresentation: PendingVirtualPresentation | null = null;
  let retainedPanViewport: ContactViewport | null = null;
  let pendingPresentationFence: PendingPresentationFence | null = null;
  let pendingPrefetchScene: ContactTileGpuScene | null = null;
  let pendingPrefetchGeneration: number | undefined;
  let pendingPrefetchPresentationRequested = false;
  interface PendingResidentPage {
    atlasKey: string;
    generation: number;
    resolution: number;
    tileSizeBins: number;
    tile: ContactMapTile;
  }
  const pendingResidentPages = new Map<string, PendingResidentPage>();
  const virtualTextureFormatByScene = new WeakMap<
    ContactTileGpuScene,
    ContactTileGpuTextureFormat
  >();
  const virtualTextureFormatForScene = (activeScene: ContactTileGpuScene) => {
    const cached = virtualTextureFormatByScene.get(activeScene);
    if (cached) {
      return cached;
    }
    const format = contactTileGpuSceneTextureFormat(activeScene, uploadContext.preference);
    virtualTextureFormatByScene.set(activeScene, format);
    return format;
  };

  const updatePerformanceCacheState = () => {
    uploadContext.performance.cacheEntries = textureCache.size;
    uploadContext.performance.cacheBytes = textureBytes;
  };
  const emitPerformanceIfChanged = () => {
    if (!performanceEnabled) {
      return;
    }
    updatePerformanceCacheState();
    const signature = `${uploadContext.performance.uploads}:${uploadContext.performance.evictions}:${uploadContext.performance.scenePromotions}:${uploadContext.performance.scenePromotionMisses}:${uploadContext.performance.virtualTextureUploads}:${uploadContext.performance.virtualTextureFallbacks}:${uploadContext.performance.virtualTextureRebuilds}:${uploadContext.performance.sourceLayoutDraws}:${uploadContext.performance.sourceLayoutUploads}:${uploadContext.performance.framebufferSwaps}:${uploadContext.performance.uploadQueueFrames}:${uploadContext.performance.uploadQueueDeferredFrames}:${uploadContext.performance.uploadQueueBytes}:${uploadContext.performance.uploadQueueMaxFrameBytes}:${uploadContext.performance.uploadFenceSignals}:${uploadContext.performance.uploadFenceWaitFrames}:${textureCache.size}:${textureBytes}`;
    if (signature === uploadContext.performance.lastEmissionSignature) {
      return;
    }
    uploadContext.performance.lastEmissionSignature = signature;
    try {
      emitPerformance(formatContactTileGpuPerformanceLog(
        contactTileGpuPerformanceSnapshot(uploadContext.performance),
        (deltaScene ?? scene)?.generation ?? null,
      ));
    } catch {
      // Diagnostics must never interrupt heatmap presentation.
    }
  };

  const deleteVirtualTextureState = (state: VirtualTextureState | null) => {
    if (!state) {
      return;
    }
    gl.deleteTexture(state.tileArray);
    gl.deleteTexture(state.pageTable);
  };

  const deleteSourceLayoutTextureState = (state: SourceLayoutTextureState | null) => {
    if (!state) {
      return;
    }
    gl.deleteTexture(state.xAddress);
    gl.deleteTexture(state.yAddress);
    gl.deleteTexture(state.xWeight);
    gl.deleteTexture(state.yWeight);
  };

  const ensureSourceLayoutTextureState = (activeScene: ContactTileGpuScene) => {
    const sourceLayout = activeScene.sourceLayout;
    if (!sourceLayout) {
      deleteSourceLayoutTextureState(sourceLayoutTextureState);
      sourceLayoutTextureState = null;
      uploadContext.performance.sourceLayoutBytes = 0;
      return true;
    }
    const sourceTilesSignature = sourceLayout.sourceTiles.join(":");
    if (
      sourceLayoutTextureState?.xMap === sourceLayout.xMap
      && sourceLayoutTextureState.yMap === sourceLayout.yMap
      && sourceLayoutTextureState.sourceTilesSignature === sourceTilesSignature
    ) {
      return true;
    }
    const xAddress = gl.createTexture();
    const yAddress = gl.createTexture();
    const xWeight = gl.createTexture();
    const yWeight = gl.createTexture();
    if (!xAddress || !yAddress || !xWeight || !yWeight) {
      for (const texture of [xAddress, yAddress, xWeight, yWeight]) {
        if (texture) gl.deleteTexture(texture);
      }
      return false;
    }
    const upload = (
      unit: number,
      texture: WebGLTexture,
      internalFormat: number,
      width: number,
      format: number,
      type: number,
      data: ArrayBufferView,
    ) => {
      gl.activeTexture(unit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        internalFormat,
        width,
        1,
        0,
        format,
        type,
        data,
      );
    };
    upload(
      gl.TEXTURE4,
      xAddress,
      gl.RGBA32UI,
      sourceLayout.xMap.entries.length,
      gl.RGBA_INTEGER,
      gl.UNSIGNED_INT,
      contactGpuCompactLayoutAddressData(sourceLayout.xMap, sourceLayout.sourceTiles),
    );
    upload(
      gl.TEXTURE5,
      yAddress,
      gl.RGBA32UI,
      sourceLayout.yMap.entries.length,
      gl.RGBA_INTEGER,
      gl.UNSIGNED_INT,
      contactGpuCompactLayoutAddressData(sourceLayout.yMap, sourceLayout.sourceTiles),
    );
    upload(
      gl.TEXTURE6,
      xWeight,
      gl.R32F,
      sourceLayout.xMap.entries.length,
      gl.RED,
      gl.FLOAT,
      sourceLayout.xMap.weightData,
    );
    upload(
      gl.TEXTURE7,
      yWeight,
      gl.R32F,
      sourceLayout.yMap.entries.length,
      gl.RED,
      gl.FLOAT,
      sourceLayout.yMap.weightData,
    );
    if (gl.getError() !== gl.NO_ERROR) {
      for (const texture of [xAddress, yAddress, xWeight, yWeight]) {
        gl.deleteTexture(texture);
      }
      return false;
    }
    const nextState: SourceLayoutTextureState = {
      xAddress,
      yAddress,
      xWeight,
      yWeight,
      xMap: sourceLayout.xMap,
      yMap: sourceLayout.yMap,
      sourceTilesSignature,
      bytes: sourceLayout.xMap.addressData.byteLength
        + sourceLayout.yMap.addressData.byteLength
        + sourceLayout.xMap.weightData.byteLength
        + sourceLayout.yMap.weightData.byteLength,
    };
    deleteSourceLayoutTextureState(sourceLayoutTextureState);
    sourceLayoutTextureState = nextState;
    uploadContext.performance.sourceLayoutUploads += 1;
    uploadContext.performance.sourceLayoutBytes = nextState.bytes;
    return true;
  };

  const virtualPagePlanForScene = (activeScene: ContactTileGpuScene) => (
    activeScene.sourceLayout
      ? contactTileSourcePagePlan(
          activeScene.sourceLayout.sourceTiles,
          activeScene.sourceLayout.descriptors,
        )
      : contactTileVirtualPagePlan(activeScene.descriptors)
  );

  const maximumVirtualTextureLayers = (
    tileSizeBins: number,
    format: ContactTileGpuTextureFormat,
  ) => {
    const driverMaximum = Number(gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS));
    if (!Number.isFinite(driverMaximum) || driverMaximum < 1) {
      return 0;
    }
    const bytesPerLayer = tileSizeBins * tileSizeBins * contactTileGpuBytesPerTexel(format);
    // Reserve the complete maximum page-table allowance up front. The array
    // can then remain allocated while the camera moves and only page-table
    // contents and LRU atlas slots change.
    const totalBudget = Math.min(safeTextureBudget, contactTileGpuVirtualTextureBudgetBytes);
    const pageTableReserve = Math.min(
      4 * 1024 * 1024,
      totalBudget / 4,
    );
    const budget = Math.max(0, totalBudget - pageTableReserve);
    return Math.max(0, Math.min(
      Math.floor(driverMaximum),
      Math.floor(budget / Math.max(1, bytesPerLayer)),
    ));
  };

  const virtualPagePlanFits = (plan: ContactTileVirtualPagePlan) => {
    const maximumTextureSize = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE));
    const pageBytes = plan.width * plan.height * 2 * Uint32Array.BYTES_PER_ELEMENT;
    return Number.isFinite(maximumTextureSize)
      && plan.width <= maximumTextureSize
      && plan.height <= maximumTextureSize
      && Number.isSafeInteger(pageBytes)
      && pageBytes <= Math.min(4 * 1024 * 1024, contactTileGpuVirtualTextureBudgetBytes / 4);
  };

  const rebuildVirtualTextureState = (
    activeScene: ContactTileGpuScene,
    format = virtualTextureFormatForScene(activeScene),
  ) => {
    if (
      !virtualResources
      || (!activeScene.sourceLayout && activeScene.visibleLayerComplete !== true)
    ) {
      return false;
    }
    const plan = virtualPagePlanForScene(activeScene);
    if (!plan || !virtualPagePlanFits(plan)) {
      return false;
    }
    const capacity = maximumVirtualTextureLayers(activeScene.tileSizeBins, format);
    if (capacity === 0 || plan.populatedTiles.length > capacity) {
      return false;
    }
    const tileArray = gl.createTexture();
    const pageTable = gl.createTexture();
    if (!tileArray || !pageTable) {
      if (tileArray) gl.deleteTexture(tileArray);
      if (pageTable) gl.deleteTexture(pageTable);
      return false;
    }

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tileArray);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.texImage3D(
      gl.TEXTURE_2D_ARRAY,
      0,
      format === "r16f" ? gl.R16F : gl.R32F,
      activeScene.tileSizeBins,
      activeScene.tileSizeBins,
      capacity,
      0,
      gl.RED,
      format === "r16f" ? gl.HALF_FLOAT : gl.FLOAT,
      null,
    );
    if (gl.getError() !== gl.NO_ERROR) {
      gl.deleteTexture(tileArray);
      gl.deleteTexture(pageTable);
      return false;
    }
    const pageTableData = new Uint32Array(2);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, pageTable);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RG32UI,
      1,
      1,
      0,
      gl.RG_INTEGER,
      gl.UNSIGNED_INT,
      pageTableData,
    );
    if (gl.getError() !== gl.NO_ERROR) {
      gl.deleteTexture(tileArray);
      gl.deleteTexture(pageTable);
      return false;
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);

    const nextState: VirtualTextureState = {
      tileArray,
      pageTable,
      capacity,
      resolution: activeScene.resolution,
      tileSizeBins: activeScene.tileSizeBins,
      format,
      layerByTileKey: new Map(),
      tileByTileKey: new Map(),
      generationByTileKey: new Map(),
      lastUsedByTileKey: new Map(),
      plan: {
        originX: 0,
        originY: 0,
        width: 1,
        height: 1,
        pages: [],
        populatedTiles: [],
      },
      pageTableData,
      bytes: (
        capacity
        * activeScene.tileSizeBins
        * activeScene.tileSizeBins
        * contactTileGpuBytesPerTexel(format)
      ) + pageTableData.byteLength,
    };
    deleteVirtualTextureState(virtualTextureState);
    virtualTextureState = nextState;
    uploadContext.performance.virtualTexturePages = 0;
    uploadContext.performance.virtualTextureLayers = 0;
    uploadContext.performance.virtualTextureBytes = nextState.bytes;
    uploadContext.performance.virtualTextureRebuilds += 1;
    if (uploadContext.preference === "r16f" && format === "r32f") {
      uploadContext.performance.rangeFallbacks += 1;
    }
    return true;
  };

  type VirtualTextureAppendResult = "ready" | "pending" | "failed";
  const appendVirtualTextureScenePass = (
    activeScene: ContactTileGpuScene,
    generation = activeScene.sourceLayout?.generation ?? activeScene.generation,
    byteBudget = Number.POSITIVE_INFINITY,
    millisecondBudget = Number.POSITIVE_INFINITY,
    trackQueueFrame = false,
  ): VirtualTextureAppendResult => {
    if (!activeScene.sourceLayout && activeScene.visibleLayerComplete !== true) {
      return "failed";
    }
    const requiredFormat = virtualTextureFormatForScene(activeScene);
    const currentFormatIsCompatible = virtualTextureState?.format === requiredFormat
      || (virtualTextureState?.format === "r32f" && requiredFormat === "r16f");
    if (
      !virtualTextureState
      || virtualTextureState.tileSizeBins !== activeScene.tileSizeBins
      || !currentFormatIsCompatible
    ) {
      if (!rebuildVirtualTextureState(activeScene, requiredFormat)) {
        return "failed";
      }
    }
    const current = virtualTextureState!;
    const plan = virtualPagePlanForScene(activeScene);
    if (
      !plan
      || !virtualPagePlanFits(plan)
      || plan.populatedTiles.length > current.capacity
    ) {
      return "failed";
    }
    const pageBytes = plan.width * plan.height * 2 * Uint32Array.BYTES_PER_ELEMENT;
    const layerBytes = current.capacity
      * activeScene.tileSizeBins
      * activeScene.tileSizeBins
      * contactTileGpuBytesPerTexel(current.format);
    if (
      layerBytes + pageBytes
      > Math.min(safeTextureBudget, contactTileGpuVirtualTextureBudgetBytes)
    ) {
      return "failed";
    }
    const nextLayers = new Map(current.layerByTileKey);
    const nextTiles = new Map(current.tileByTileKey);
    const nextGenerations = new Map(current.generationByTileKey);
    const nextLastUsed = new Map(current.lastUsedByTileKey);
    const protectedKeys = new Set(
      plan.populatedTiles.map(({ key }) => virtualTextureAtlasKey(activeScene, key)),
    );
    const evictionCandidates = [...nextLayers.keys()]
      .filter((key) => !protectedKeys.has(key))
      .sort((left, right) => (
        (nextLastUsed.get(left) ?? 0) - (nextLastUsed.get(right) ?? 0)
      ));
    const candidates = contactTileGpuUploadPlan(activeScene, current.format).filter((candidate) => (
      nextTiles.get(virtualTextureAtlasKey(activeScene, candidate.key)) !== candidate.tile
    ));
    // A cross-resolution resident hit is already exact. Adopt it into this
    // generation and refresh its LRU age even though no upload is required.
    for (const { key, tile } of plan.populatedTiles) {
      const atlasKey = virtualTextureAtlasKey(activeScene, key);
      if (nextTiles.get(atlasKey) === tile) {
        nextGenerations.set(atlasKey, generation);
        nextLastUsed.set(atlasKey, ++useCounter);
      }
    }
    const selected = contactTileGpuUploadBatch(candidates, byteBudget);
    if (trackQueueFrame) {
      uploadContext.performance.uploadQueueFrames += 1;
      uploadContext.performance.uploadQueueMaxDepth = Math.max(
        uploadContext.performance.uploadQueueMaxDepth,
        candidates.length,
      );
    }
    let uploaded = 0;
    let uploadedBytes = 0;
    let evicted = 0;
    const startedAt = uploadContext.clock();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, current.tileArray);
    for (const { key, tile, bytes } of selected) {
      if (
        uploaded > 0
        && uploadContext.clock() - startedAt >= millisecondBudget
      ) {
        break;
      }
      const atlasKey = virtualTextureAtlasKey(activeScene, key);
      let layer = nextLayers.get(atlasKey);
      if (layer === undefined) {
        if (nextLayers.size < current.capacity) {
          const occupiedLayers = new Set(nextLayers.values());
          layer = 0;
          while (occupiedLayers.has(layer) && layer < current.capacity) {
            layer += 1;
          }
        } else {
          const evictedKey = evictionCandidates.shift();
          if (evictedKey === undefined) {
            return "failed";
          }
          layer = nextLayers.get(evictedKey);
          if (layer === undefined) {
            return "failed";
          }
          nextLayers.delete(evictedKey);
          nextTiles.delete(evictedKey);
          nextGenerations.delete(evictedKey);
          nextLastUsed.delete(evictedKey);
          evicted += 1;
        }
        if (layer >= current.capacity) {
          return "failed";
        }
        nextLayers.set(atlasKey, layer);
      }
      nextLastUsed.set(atlasKey, ++useCounter);
      if (nextTiles.get(atlasKey) === tile) {
        nextGenerations.set(atlasKey, generation);
        continue;
      }
      const textureData = contactTileGpuTextureData(tile, activeScene.tileSizeBins);
      if (
        current.format === "r16f"
        && textureData.format === "float32"
        && !contactTileGpuFloatValuesFitR16f(textureData.values)
      ) {
        uploadContext.performance.rangeFallbacks += 1;
        return "failed";
      }
      const uploadValues = current.format === "r32f" && textureData.format === "r16f"
        ? contactTileR16fValuesToFloat32(textureData.values)
        : textureData.values;
      const uploadType = current.format === "r16f" && textureData.format === "r16f"
        ? gl.HALF_FLOAT
        : gl.FLOAT;
      gl.texSubImage3D(
        gl.TEXTURE_2D_ARRAY,
        0,
        0,
        0,
        layer,
        activeScene.tileSizeBins,
        activeScene.tileSizeBins,
        1,
        gl.RED,
        uploadType,
        uploadValues,
      );
      nextTiles.set(atlasKey, tile);
      nextGenerations.set(atlasKey, generation);
      uploaded += 1;
      uploadedBytes += bytes;
    }
    if (uploaded > 0 && gl.getError() !== gl.NO_ERROR) {
      return "failed";
    }
    current.layerByTileKey = nextLayers;
    current.tileByTileKey = nextTiles;
    current.generationByTileKey = nextGenerations;
    current.lastUsedByTileKey = nextLastUsed;
    current.resolution = activeScene.resolution;
    uploadContext.performance.virtualTextureUploads += uploaded;
    uploadContext.performance.virtualTextureLayers = nextLayers.size;
    uploadContext.performance.evictions += evicted;
    uploadContext.performance.evictedBytes += evicted
      * activeScene.tileSizeBins
      * activeScene.tileSizeBins
      * contactTileGpuBytesPerTexel(current.format);
    uploadContext.performance.uploadQueueBytes += uploadedBytes;
    if (trackQueueFrame) {
      const elapsed = Math.max(0, uploadContext.clock() - startedAt);
      uploadContext.performance.uploadQueueMilliseconds += elapsed;
      uploadContext.performance.uploadQueueMaxFrameBytes = Math.max(
        uploadContext.performance.uploadQueueMaxFrameBytes,
        uploadedBytes,
      );
      uploadContext.performance.uploadQueueMaxFrameMilliseconds = Math.max(
        uploadContext.performance.uploadQueueMaxFrameMilliseconds,
        elapsed,
      );
    }
    const remaining = candidates.length - uploaded;
    if (remaining > 0) {
      if (trackQueueFrame) {
        uploadContext.performance.uploadQueueDeferredFrames += 1;
      }
      return "pending";
    }
    const pageTableData = contactTileVirtualPageTableData(
      plan,
      virtualTexturePageLayers(activeScene, plan, nextLayers),
    );
    if (!pageTableData) {
      return "failed";
    }
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, current.pageTable);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RG32UI,
      plan.width,
      plan.height,
      0,
      gl.RG_INTEGER,
      gl.UNSIGNED_INT,
      pageTableData,
    );
    if (gl.getError() !== gl.NO_ERROR) {
      return "failed";
    }
    current.plan = plan;
    current.pageTableData = pageTableData;
    current.bytes = (
      current.capacity
      * activeScene.tileSizeBins
      * activeScene.tileSizeBins
      * contactTileGpuBytesPerTexel(current.format)
    ) + pageTableData.byteLength;
    uploadContext.performance.virtualTexturePages = plan.pages.length;
    uploadContext.performance.virtualTextureBytes = current.bytes;
    return ensureSourceLayoutTextureState(activeScene) ? "ready" : "failed";
  };

  const appendVirtualTextureScene = (
    activeScene: ContactTileGpuScene,
    generation = activeScene.sourceLayout?.generation ?? activeScene.generation,
  ) => appendVirtualTextureScenePass(
    activeScene,
    generation,
  ) === "ready";

  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);
  gl.disable(gl.BLEND);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

  const virtualTextureCoversViewport = (
    state: VirtualTextureState,
    viewport: ContactViewport,
    overview: ContactTileGpuOverview | null,
    sourceLayout?: ContactTileGpuSourceLayout,
  ) => {
    if (sourceLayout) {
      const compactSourceTile = new Map(
        sourceLayout.sourceTiles.map((sourceTile, index) => [sourceTile, index] as const),
      );
      const requiredPages = (
        map: ContactGpuLayoutMap,
        start: number,
        end: number,
      ) => {
        const first = Math.floor(start / state.resolution);
        const last = Math.ceil(end / state.resolution) - 1;
        const localFirst = first - map.firstVisualBin;
        const localLast = last - map.firstVisualBin;
        // Aspect-preserving whole-genome views may extend beyond the finite
        // AGP address map on one axis. The shader already paints those
        // out-of-map fragments white, so only require exact pages for the
        // portion that actually intersects the map.
        const clampedFirst = Math.max(0, localFirst);
        const clampedLast = Math.min(map.entries.length - 1, localLast);
        const pages = new Set<number>();
        if (clampedFirst > clampedLast) {
          return pages;
        }
        for (const entry of map.entries.slice(clampedFirst, clampedLast + 1)) {
          if (!entry.valid) {
            continue;
          }
          if (!entry.exact) {
            return null;
          }
          const page = compactSourceTile.get(entry.sourceTile);
          if (page === undefined) {
            return null;
          }
          pages.add(page);
        }
        return pages;
      };
      const xPages = requiredPages(sourceLayout.xMap, viewport.xStart, viewport.xEnd);
      const yPages = requiredPages(sourceLayout.yMap, viewport.yStart, viewport.yEnd);
      if (!xPages || !yPages) {
        return false;
      }
      for (const pageY of yPages) {
        for (const pageX of xPages) {
          const localX = pageX - state.plan.originX;
          const localY = pageY - state.plan.originY;
          if (
            localX < 0
            || localX >= state.plan.width
            || localY < 0
            || localY >= state.plan.height
          ) {
            return false;
          }
          const flags = state.pageTableData[
            (localY * state.plan.width + localX) * 2 + 1
          ];
          if ((flags & contactTileVirtualPageExactFlag) === 0) {
            return false;
          }
        }
      }
      return true;
    }
    const tileSpan = state.resolution * state.tileSizeBins;
    const firstX = Math.floor(viewport.xStart / tileSpan);
    const lastX = Math.ceil(viewport.xEnd / tileSpan) - 1;
    const firstY = Math.floor(viewport.yStart / tileSpan);
    const lastY = Math.ceil(viewport.yEnd / tileSpan) - 1;
    // The overview establishes the finite genome rectangle, but it is not a
    // presentable substitute for a missing exact page inside that rectangle.
    // Magnifying one coarse overview texel across a fine viewport is what
    // produces the large solid colour blocks during loading. Pages whose
    // *visible portion* lies wholly beyond the overview remain legal white
    // aspect-ratio margins.
    const overviewViewport = overview?.viewport ?? null;
    for (let pageY = firstY; pageY <= lastY; pageY += 1) {
      for (let pageX = firstX; pageX <= lastX; pageX += 1) {
        const localX = pageX - state.plan.originX;
        const localY = pageY - state.plan.originY;
        const pageInRange = localX >= 0
          && localX < state.plan.width
          && localY >= 0
          && localY < state.plan.height;
        const flags = pageInRange
          ? state.pageTableData[(localY * state.plan.width + localX) * 2 + 1]
          : 0;
        if ((flags & contactTileVirtualPageExactFlag) !== 0) {
          continue;
        }
        if (!overviewViewport) {
          return false;
        }
        const visiblePageXStart = Math.max(viewport.xStart, pageX * tileSpan);
        const visiblePageXEnd = Math.min(viewport.xEnd, (pageX + 1) * tileSpan);
        const visiblePageYStart = Math.max(viewport.yStart, pageY * tileSpan);
        const visiblePageYEnd = Math.min(viewport.yEnd, (pageY + 1) * tileSpan);
        const visiblePageIntersectsOverview = (
          visiblePageXEnd > overviewViewport.xStart
          && visiblePageXStart < overviewViewport.xEnd
          && visiblePageYEnd > overviewViewport.yStart
          && visiblePageYStart < overviewViewport.yEnd
        );
        if (visiblePageIntersectsOverview) {
          return false;
        }
      }
    }
    return true;
  };

  const drawVirtualTexturePan = (
    activeScene: ContactTileGpuScene,
    presentation = framePresentation,
    present = true,
  ) => {
    const state = virtualTextureState;
    if (
      !virtualResources
      || !state
      || (!activeScene.sourceLayout && activeScene.visibleLayerComplete !== true)
      || state.resolution !== activeScene.resolution
      || state.tileSizeBins !== activeScene.tileSizeBins
      || !presentation
      || !virtualTextureCoversViewport(
        state,
        activeScene.viewport,
        activeScene.overview ?? null,
        activeScene.sourceLayout,
      )
    ) {
      uploadContext.performance.virtualTextureFallbacks += 1;
      return false;
    }
    if (!ensureSourceLayoutTextureState(activeScene)) {
      uploadContext.performance.virtualTextureFallbacks += 1;
      return false;
    }
    const overview = activeScene.overview ?? null;
    if (overview && !overviewTextureEntry) {
      uploadContext.performance.virtualTextureFallbacks += 1;
      return false;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, presentation.framebuffer);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(1, 1, 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(virtualResources.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, resources.quadBuffer);
    gl.enableVertexAttribArray(virtualResources.positionLocation);
    gl.vertexAttribPointer(virtualResources.positionLocation, 2, gl.FLOAT, false, 0, 0);
    const camera = contactTileVirtualCamera(
      activeScene.viewport,
      activeScene.resolution,
      activeScene.tileSizeBins,
    );
    gl.uniform4f(
      virtualResources.cameraTilesLocation,
      camera.localX,
      camera.spanX,
      camera.localY,
      camera.spanY,
    );
    gl.uniform2i(
      virtualResources.cameraPageLocation,
      camera.pageX,
      camera.pageY,
    );
    gl.uniform2i(
      virtualResources.pageOriginLocation,
      state.plan.originX,
      state.plan.originY,
    );
    gl.uniform2i(
      virtualResources.pageSizeLocation,
      state.plan.width,
      state.plan.height,
    );
    const sourceLayout = activeScene.sourceLayout;
    gl.uniform1i(virtualResources.hasSourceLayoutLocation, sourceLayout ? 1 : 0);
    gl.uniform2i(
      virtualResources.layoutSizesLocation,
      sourceLayout?.xMap.entries.length ?? 1,
      sourceLayout?.yMap.entries.length ?? 1,
    );
    gl.uniform4f(
      virtualResources.layoutCameraLocation,
      sourceLayout
        ? activeScene.viewport.xStart / activeScene.resolution
          - sourceLayout.xMap.firstVisualBin
        : 0,
      sourceLayout
        ? (activeScene.viewport.xEnd - activeScene.viewport.xStart) / activeScene.resolution
        : 1,
      sourceLayout
        ? activeScene.viewport.yStart / activeScene.resolution
          - sourceLayout.yMap.firstVisualBin
        : 0,
      sourceLayout
        ? (activeScene.viewport.yEnd - activeScene.viewport.yStart) / activeScene.resolution
        : 1,
    );
    const exactScale = activeScene.renderStyle.colorScale;
    const overviewScale = overview?.colorScale ?? exactScale;
    gl.uniform4f(
      virtualResources.scaleLocation,
      Math.max(0, exactScale.min),
      Math.max(Math.max(0, exactScale.min), exactScale.max),
      exactScale.log ? 1 : 0,
      0,
    );
    gl.uniform4f(
      virtualResources.overviewScaleLocation,
      Math.max(0, overviewScale.min),
      Math.max(Math.max(0, overviewScale.min), overviewScale.max),
      overviewScale.log ? 1 : 0,
      0,
    );
    gl.uniform1f(
      virtualResources.paletteStopCountLocation,
      paletteStopCount(activeScene.renderStyle.colormap),
    );
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, state.tileArray);
    gl.uniform1i(virtualResources.tileArrayLocation, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, resources.lutTexture);
    gl.uniform1i(virtualResources.lutTextureLocation, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, state.pageTable);
    gl.uniform1i(virtualResources.pageTableLocation, 2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, overviewTextureEntry?.texture ?? null);
    gl.uniform1i(virtualResources.overviewTextureLocation, 3);
    gl.uniform1i(virtualResources.hasOverviewLocation, overview ? 1 : 0);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, sourceLayoutTextureState?.xAddress ?? null);
    gl.uniform1i(virtualResources.layoutXAddressLocation, 4);
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, sourceLayoutTextureState?.yAddress ?? null);
    gl.uniform1i(virtualResources.layoutYAddressLocation, 5);
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, sourceLayoutTextureState?.xWeight ?? null);
    gl.uniform1i(virtualResources.layoutXWeightLocation, 6);
    gl.activeTexture(gl.TEXTURE7);
    gl.bindTexture(gl.TEXTURE_2D, sourceLayoutTextureState?.yWeight ?? null);
    gl.uniform1i(virtualResources.layoutYWeightLocation, 7);
    const overviewXSpan = overview
      ? Math.max(1, overview.viewport.xEnd - overview.viewport.xStart)
      : 1;
    const overviewYSpan = overview
      ? Math.max(1, overview.viewport.yEnd - overview.viewport.yStart)
      : 1;
    gl.uniform4f(
      virtualResources.overviewUvRectLocation,
      overview ? (activeScene.viewport.xStart - overview.viewport.xStart) / overviewXSpan : 0,
      overview
        ? (activeScene.viewport.xEnd - activeScene.viewport.xStart) / overviewXSpan
        : 1,
      overview ? (activeScene.viewport.yStart - overview.viewport.yStart) / overviewYSpan : 0,
      overview
        ? (activeScene.viewport.yEnd - activeScene.viewport.yStart) / overviewYSpan
        : 1,
    );
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    const boundaries = activeScene.boundaries ?? [];
    if (!drawBoundaryScene(
      gl,
      boundaryResources,
      boundaries,
      activeScene.viewport,
      canvas.width,
      canvas.height,
      presentedCssWidth,
      presentedCssHeight,
      uploadedBoundaries,
      uploadedBoundaryCount,
    )) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      uploadContext.performance.virtualTextureFallbacks += 1;
      return false;
    }
    if (uploadedBoundaries !== boundaries) {
      uploadedBoundaries = boundaries;
      uploadedBoundaryCount = boundaries.length;
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    if (present) {
      presentFramePresentation(gl, presentation, canvas.width, canvas.height);
      if (presentation === framePresentation) {
        hasPresentedFrontFrame = true;
      }
    }
    uploadContext.performance.virtualTextureDraws += 1;
    if (sourceLayout) {
      uploadContext.performance.sourceLayoutDraws += 1;
    }
    return true;
  };

  const draw = (
    panOnly = false,
    descriptors: readonly ContactTileCanvasDescriptor[] | null = null,
    preserveFramebuffer = false,
    target: "front" | "staging" = "front",
    present = true,
  ): boolean => {
    const activeScene = deltaScene ?? scene;
    if (destroyed || !activeScene || gl.isContextLost()) {
      return false;
    }
    // A retained front frame completely covers this staging canvas. Uploading
    // every streamed chunk here cannot improve what the user sees; defer the
    // first texture allocation until the terminal scene is promoted.
    if (deltaScene?.deferTextureUpdates) {
      return true;
    }
    if (!panOnly) {
      resizeCanvasToDisplaySize(canvas, gl);
      presentedCssWidth = Math.max(1, canvas.clientWidth || canvas.width);
      presentedCssHeight = Math.max(1, canvas.clientHeight || canvas.height);
      updateLutTexture(gl, resources.lutTexture, activeScene.renderStyle, lutColormap);
      lutColormap = activeScene.renderStyle.colormap;
    }

    let presentation = ensureFramePresentationResources(
      gl,
      target === "front" ? framePresentation : stagingFramePresentation,
      canvas.width,
      canvas.height,
    );
    if (!presentation) {
      return false;
    }
    if (target === "front") {
      if (presentation !== framePresentation) {
        hasPresentedFrontFrame = false;
      }
      framePresentation = presentation;
      stagingFramePresentation = ensureFramePresentationResources(
        gl,
        stagingFramePresentation,
        canvas.width,
        canvas.height,
      );
      if (!stagingFramePresentation) {
        return false;
      }
    } else {
      stagingFramePresentation = presentation;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, presentation.framebuffer);
    const abandonFrame = () => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return false;
    };

    gl.viewport(0, 0, canvas.width, canvas.height);
    if (!preserveFramebuffer) {
      gl.clearColor(1, 1, 1, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.useProgram(resources.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, resources.quadBuffer);
    gl.enableVertexAttribArray(resources.positionLocation);
    gl.vertexAttribPointer(resources.positionLocation, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2f(resources.canvasSizeLocation, canvas.width, canvas.height);

    applyColorScaleUniforms(gl, resources, activeScene.renderStyle.colorScale);
    gl.uniform1f(
      resources.paletteStopCountLocation,
      paletteStopCount(activeScene.renderStyle.colormap),
    );
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, resources.lutTexture);
    gl.uniform1i(resources.lutTextureLocation, 1);

    const viewportWidth = Math.max(1, activeScene.viewport.xEnd - activeScene.viewport.xStart);
    const viewportHeight = Math.max(1, activeScene.viewport.yEnd - activeScene.viewport.yStart);
    const tileSpanBp = activeScene.resolution * activeScene.tileSizeBins;
    // Pointer pans reuse the dimensions captured by the last complete scene
    // draw. Reading clientWidth/clientHeight in every animation frame can force
    // synchronous layout in WebView2, while ResizeObserver already schedules a
    // complete redraw whenever those dimensions actually change.
    const cssWidth = presentedCssWidth;
    const cssHeight = presentedCssHeight;
    const scaleX = canvas.width / cssWidth;
    const scaleY = canvas.height / cssHeight;
    const protectedKeys = panOnly ? null : new Set<string>();
    const validatesCompleteCoverage = !panOnly
      && descriptors === null
      && deltaScene === null
      && scene?.visibleLayerComplete === true;
    const drawnDescriptorKeys = validatesCompleteCoverage ? new Set<string>() : null;
    const overview = activeScene.overview ?? null;

    if (!preserveFramebuffer && overview) {
      overviewTextureEntry = ensureOverviewTexture(
        gl,
        overviewTextureEntry,
        overview,
        uploadContext,
      );
      if (!overviewTextureEntry) {
        return abandonFrame();
      }
      if (overview.colorScale) {
        applyColorScaleUniforms(gl, resources, overview.colorScale);
      }
      const left = (
        ((overview.viewport.xStart - activeScene.viewport.xStart) / viewportWidth) * cssWidth
      ) * scaleX;
      const top = (
        ((overview.viewport.yStart - activeScene.viewport.yStart) / viewportHeight) * cssHeight
      ) * scaleY;
      const width = (
        (overview.viewport.xEnd - overview.viewport.xStart) / viewportWidth
      ) * canvas.width;
      const height = (
        (overview.viewport.yEnd - overview.viewport.yStart) / viewportHeight
      ) * canvas.height;
      drawTextureQuad(
        gl,
        resources,
        overviewTextureEntry.texture,
        left,
        top,
        width,
        height,
        false,
      );
      if (overview.colorScale) {
        applyColorScaleUniforms(gl, resources, activeScene.renderStyle.colorScale);
      }
    } else if (!overview && overviewTextureEntry) {
      gl.deleteTexture(overviewTextureEntry.texture);
      overviewTextureEntry = null;
    }

    for (const descriptor of descriptors ?? activeScene.descriptors) {
      const deltaBuffer = deltaScene
        ? deltaBuffers.get(contactTileKey(descriptor.tile))
        : undefined;
      const renderedTileX = descriptor.transpose ? descriptor.tile.tileY : descriptor.tile.tileX;
      const renderedTileY = descriptor.transpose ? descriptor.tile.tileX : descriptor.tile.tileY;
      const left = (
        ((renderedTileX * tileSpanBp - activeScene.viewport.xStart) / viewportWidth) * cssWidth
      ) * scaleX;
      const top = (
        ((renderedTileY * tileSpanBp - activeScene.viewport.yStart) / viewportHeight) * cssHeight
      ) * scaleY;
      const width = (tileSpanBp / viewportWidth) * canvas.width;
      const height = (tileSpanBp / viewportHeight) * canvas.height;

      // A terminal exact tile owns its full rectangle, including sparse zero
      // pixels. Mask the coarse base before drawing it. Streamed partial tiles
      // deliberately skip this mask so the overview remains visible where the
      // current batch has not arrived yet.
      const explicitlyMasksOverview = Boolean(
        overview
        && deltaScene === null
        && !preserveFramebuffer
        && scene?.visibleLayerComplete === true,
      );
      if (explicitlyMasksOverview) {
        clearCanvasRectToWhite(gl, canvas.width, canvas.height, left, top, width, height);
      }
      if (deltaScene ? !deltaBuffer || deltaBuffer.occupiedCount === 0 : contactTileCellCount(descriptor.tile) === 0) {
        if (explicitlyMasksOverview) {
          drawnDescriptorKeys?.add(descriptor.key);
        }
        continue;
      }

      const textureKey = gpuTextureKey(activeScene, descriptor.tile);
      protectedKeys?.add(textureKey);
      const cachedEntry = panOnly ? textureCache.get(textureKey) : undefined;
      const cachedEntryMatches = cachedEntry && (deltaScene && deltaBuffer
        ? cachedEntry.generation === deltaScene.generation
          && cachedEntry.deltaBuffer === deltaBuffer
        : cachedEntry.tile === descriptor.tile);
      if (panOnly && !cachedEntryMatches) {
        // Scene changes normally run a complete draw before pointer input can
        // reach this path. Fall back defensively if that ordering is ever
        // broken instead of presenting a partially translated surface.
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return draw();
      }
      const entry = cachedEntryMatches
        ? cachedEntry
        : deltaScene && deltaBuffer
          ? ensureDeltaTileTexture(
              gl,
              textureCache,
              textureKey,
              deltaBuffer,
              deltaScene.generation,
              deltaScene.tileSizeBins,
              ++useCounter,
              deltaScratch,
              uploadContext,
            )
          : ensureTileTexture(
              gl,
              textureCache,
              textureKey,
              descriptor.tile,
              activeScene.generation,
              activeScene.tileSizeBins,
              ++useCounter,
              uploadContext,
            );
      if (!entry || !textureCache.has(textureKey)) {
        continue;
      }
      drawTextureQuad(
        gl,
        resources,
        entry.texture,
        left,
        top,
        width,
        height,
        descriptor.transpose,
      );
      drawnDescriptorKeys?.add(descriptor.key);
    }

    // Cache size is independent of descriptor count. Recomputing it inside the
    // tile loop made a pan frame O(visible tiles * cached textures), which is
    // particularly costly in Windows WebView2/ANGLE. A pointer-only redraw
    // cannot change the cache at all, so it skips accounting and eviction.
    if (!panOnly) {
      textureBytes = cachedTextureBytes(textureCache);
    }
    if (!panOnly && textureBytes > safeTextureBudget) {
      const eviction = evictLeastRecentlyUsedTextures(
        gl,
        textureCache,
        textureBytes,
        safeTextureBudget,
        protectedKeys!,
      );
      textureBytes = eviction.bytes;
      uploadContext.performance.evictions += eviction.count;
      uploadContext.performance.evictedBytes += eviction.evictedBytes;
    }
    const boundaries = activeScene.boundaries ?? [];
    if (!drawBoundaryScene(
      gl,
      boundaryResources,
      boundaries,
      activeScene.viewport,
      canvas.width,
      canvas.height,
      presentedCssWidth,
      presentedCssHeight,
      uploadedBoundaries,
      uploadedBoundaryCount,
    )) {
      return abandonFrame();
    }
    if (uploadedBoundaries !== boundaries) {
      uploadedBoundaries = boundaries;
      uploadedBoundaryCount = boundaries.length;
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    if (panOnly) {
      if (present) {
        presentFramePresentation(gl, presentation, canvas.width, canvas.height);
        if (presentation === framePresentation) {
          hasPresentedFrontFrame = true;
        }
      }
      return true;
    }
    emitPerformanceIfChanged();
    // Texture uploads and framebuffer creation validate their own failures.
    // Avoid a scene-wide getError() here: ANGLE may flush the command stream,
    // which turns an otherwise cache-only pan commit into a CPU/GPU sync point.
    const complete = !gl.isContextLost() && (
      deltaScene !== null
      || !validatesCompleteCoverage
      || contactTileGpuDrawCoverageIsComplete(
        activeScene.descriptors,
        drawnDescriptorKeys!,
        overview !== null,
      )
    );
    if (!complete) {
      return abandonFrame();
    }
    if (present) {
      presentFramePresentation(gl, presentation, canvas.width, canvas.height);
      if (presentation === framePresentation) {
        hasPresentedFrontFrame = true;
      }
    }
    return true;
  };

  const drawCompleteVirtualScene = (
    activeScene: ContactTileGpuScene,
    target: "front" | "staging" = "front",
    present = true,
  ) => {
    if (
      !virtualResources
      || (!activeScene.sourceLayout && activeScene.visibleLayerComplete !== true)
    ) {
      return false;
    }
    resizeCanvasToDisplaySize(canvas, gl);
    presentedCssWidth = Math.max(1, canvas.clientWidth || canvas.width);
    presentedCssHeight = Math.max(1, canvas.clientHeight || canvas.height);
    updateLutTexture(gl, resources.lutTexture, activeScene.renderStyle, lutColormap);
    lutColormap = activeScene.renderStyle.colormap;
    let presentation = ensureFramePresentationResources(
      gl,
      target === "front" ? framePresentation : stagingFramePresentation,
      canvas.width,
      canvas.height,
    );
    if (!presentation) {
      return false;
    }
    if (target === "front") {
      if (presentation !== framePresentation) {
        hasPresentedFrontFrame = false;
      }
      framePresentation = presentation;
      // Allocate the paired presentation surface during the initial load, not
      // on the first cache-hit pan. Promotion then remains allocation-free and
      // cannot turn the first backtrack into a one-off hitch.
      stagingFramePresentation = ensureFramePresentationResources(
        gl,
        stagingFramePresentation,
        canvas.width,
        canvas.height,
      );
      if (!stagingFramePresentation) {
        return false;
      }
    } else {
      stagingFramePresentation = presentation;
    }
    const overview = activeScene.overview ?? null;
    if (overview) {
      overviewTextureEntry = ensureOverviewTexture(
        gl,
        overviewTextureEntry,
        overview,
        uploadContext,
      );
      if (!overviewTextureEntry) {
        return false;
      }
    }
    if (!appendVirtualTextureScene(activeScene)) {
      return false;
    }
    return drawVirtualTexturePan(activeScene, presentation, present);
  };

  const presentStagingFrame = () => {
    if (!stagingFramePresentation) {
      traceContactPanCamera("gpu_fbo_present_missing", {
        sceneViewport: scene?.viewport,
        generation: scene?.generation,
      });
      return false;
    }
    const previousFrontPresentation = framePresentation;
    framePresentation = stagingFramePresentation;
    stagingFramePresentation = previousFrontPresentation;
    presentFramePresentation(gl, framePresentation, canvas.width, canvas.height);
    hasPresentedFrontFrame = true;
    uploadContext.performance.framebufferSwaps += 1;
    traceContactPanCamera("gpu_fbo_present", {
      sceneViewport: scene?.viewport,
      generation: scene?.generation,
    });
    return true;
  };

  const cancelScheduledUploadFrame = () => {
    if (scheduledUploadFrame === null) {
      return;
    }
    cancelUploadFrame(scheduledUploadFrame);
    scheduledUploadFrame = null;
  };

  const scheduleUploadPump = () => {
    if (destroyed || scheduledUploadFrame !== null) {
      return;
    }
    scheduledUploadFrame = requestUploadFrame(() => {
      scheduledUploadFrame = null;
      processUploadPump();
    });
  };

  const finishPendingFence = (presented: boolean) => {
    const pending = pendingPresentationFence;
    if (!pending) {
      return;
    }
    gl.deleteSync(pending.sync);
    pendingPresentationFence = null;
    if (!presented) {
      uploadContext.performance.uploadFenceFailures += 1;
      pending.onPresented?.(false);
      emitPerformanceIfChanged();
      return;
    }
    if (pending.target === "staging") {
      const previousFrontPresentation = framePresentation;
      framePresentation = pending.presentation;
      stagingFramePresentation = previousFrontPresentation;
      uploadContext.performance.stagedSceneDraws += 1;
      uploadContext.performance.framebufferSwaps += 1;
    } else {
      framePresentation = pending.presentation;
    }
    scene = pending.scene;
    deltaScene = null;
    deltaBuffers = new Map();
    pendingAppendedDescriptors.clear();
    presentFramePresentation(gl, framePresentation, canvas.width, canvas.height);
    hasPresentedFrontFrame = true;
    uploadContext.performance.uploadFenceSignals += 1;
    pending.onPresented?.(true);
    pendingPrefetchScene = contactTileGpuUploadPlan(pending.scene)
      .some((candidate) => candidate.priorityRank === 2)
      ? pending.scene
      : null;
    pendingPrefetchGeneration = pendingPrefetchScene
      ? pending.scene.sourceLayout?.generation ?? pending.scene.generation
      : undefined;
    emitPerformanceIfChanged();
    scheduleUploadPump();
  };

  const pollPendingFence = () => {
    const pending = pendingPresentationFence;
    if (!pending) {
      return false;
    }
    uploadContext.performance.uploadFencePolls += 1;
    const status = gl.clientWaitSync(pending.sync, 0, 0);
    if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) {
      finishPendingFence(true);
      return true;
    }
    if (status === gl.WAIT_FAILED) {
      finishPendingFence(false);
      return true;
    }
    uploadContext.performance.uploadFenceWaitFrames += 1;
    scheduleUploadPump();
    return true;
  };

  const submitPresentationFence = (pending: PendingVirtualPresentation) => {
    const drawn = drawCompleteVirtualScene(
      pending.visibleScene,
      pending.target,
      false,
    );
    const presentation = pending.target === "staging"
      ? stagingFramePresentation
      : framePresentation;
    if (!drawn || !presentation) {
      pending.onPresented?.(false);
      return false;
    }
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!sync) {
      uploadContext.performance.uploadFenceFailures += 1;
      pending.onPresented?.(false);
      return false;
    }
    gl.flush();
    pendingPresentationFence = { ...pending, sync, presentation };
    pollPendingFence();
    return true;
  };

  const invalidateVirtualTextureLayer = (
    current: VirtualTextureState,
    layer: number,
  ) => {
    for (const [key, mappedLayer] of current.layerByTileKey) {
      if (mappedLayer !== layer) {
        continue;
      }
      current.layerByTileKey.delete(key);
      current.tileByTileKey.delete(key);
      current.generationByTileKey.delete(key);
      current.lastUsedByTileKey.delete(key);
    }
    uploadContext.performance.virtualTextureLayers = current.layerByTileKey.size;
  };

  /** Upload one lowest-priority page without mutating the active page table. */
  const uploadResidentPage = (page: PendingResidentPage) => {
    const current = virtualTextureState;
    const activeGeneration = scene?.sourceLayout?.generation ?? scene?.generation;
    if (
      !current
      || !scene
      || activeGeneration !== page.generation
      || current.tileSizeBins !== page.tileSizeBins
    ) {
      return 0;
    }
    if (current.tileByTileKey.get(page.atlasKey) === page.tile) {
      current.generationByTileKey.set(page.atlasKey, page.generation);
      current.lastUsedByTileKey.set(page.atlasKey, ++useCounter);
      return 0;
    }

    const activeDataScope = scene.sourceLayout?.dataScope ?? scene.dataScope ?? "";
    const protectedKeys = new Set(current.plan.populatedTiles.map(({ key }) => (
      virtualTextureResidentKey(
        activeDataScope,
        current.resolution,
        current.tileSizeBins,
        key,
      )
    )));
    if (protectedKeys.has(page.atlasKey)) {
      // Never replace a page sampled by the current page table, even if a
      // speculative batch happens to carry a newer object for the same key.
      return 0;
    }

    const textureData = contactTileGpuTextureData(page.tile, page.tileSizeBins);
    if (
      current.format === "r16f"
      && textureData.format === "float32"
      && !contactTileGpuFloatValuesFitR16f(textureData.values)
    ) {
      // Rebuilding the live atlas would invalidate the retained front. Let a
      // later foreground scene perform the format transition atomically.
      return 0;
    }

    let layer = current.layerByTileKey.get(page.atlasKey);
    let evictedKey: string | undefined;
    if (layer === undefined) {
      const occupiedLayers = new Set(current.layerByTileKey.values());
      layer = 0;
      while (occupiedLayers.has(layer) && layer < current.capacity) {
        layer += 1;
      }
      if (layer >= current.capacity) {
        evictedKey = [...current.layerByTileKey.keys()]
          .filter((key) => !protectedKeys.has(key))
          .sort((left, right) => (
            (current.lastUsedByTileKey.get(left) ?? 0)
            - (current.lastUsedByTileKey.get(right) ?? 0)
          ))[0];
        if (evictedKey === undefined) {
          return 0;
        }
        layer = current.layerByTileKey.get(evictedKey);
        if (layer === undefined) {
          return 0;
        }
      }
    }

    const uploadValues = current.format === "r32f" && textureData.format === "r16f"
      ? contactTileR16fValuesToFloat32(textureData.values)
      : textureData.values;
    const uploadType = current.format === "r16f" && textureData.format === "r16f"
      ? gl.HALF_FLOAT
      : gl.FLOAT;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, current.tileArray);
    gl.texSubImage3D(
      gl.TEXTURE_2D_ARRAY,
      0,
      0,
      0,
      layer,
      page.tileSizeBins,
      page.tileSizeBins,
      1,
      gl.RED,
      uploadType,
      uploadValues,
    );
    const uploadError = gl.getError();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    if (uploadError !== gl.NO_ERROR) {
      // The layer contents are undefined after a rejected sub-upload. Remove
      // any old mapping that pointed at it so no later page table can sample it.
      invalidateVirtualTextureLayer(current, layer);
      return 0;
    }

    if (evictedKey !== undefined) {
      current.layerByTileKey.delete(evictedKey);
      current.tileByTileKey.delete(evictedKey);
      current.generationByTileKey.delete(evictedKey);
      current.lastUsedByTileKey.delete(evictedKey);
      uploadContext.performance.evictions += 1;
      uploadContext.performance.evictedBytes += page.tileSizeBins
        * page.tileSizeBins
        * contactTileGpuBytesPerTexel(current.format);
    }
    current.layerByTileKey.set(page.atlasKey, layer);
    current.tileByTileKey.set(page.atlasKey, page.tile);
    current.generationByTileKey.set(page.atlasKey, page.generation);
    current.lastUsedByTileKey.set(page.atlasKey, ++useCounter);
    uploadContext.performance.virtualTextureUploads += 1;
    uploadContext.performance.virtualTextureLayers = current.layerByTileKey.size;
    traceContactPanCamera("gpu_resident_prefetch_upload", {
      generation: page.generation,
      resolution: page.resolution,
      tileX: page.tile.tileX,
      tileY: page.tile.tileY,
    });
    return page.tileSizeBins
      * page.tileSizeBins
      * contactTileGpuBytesPerTexel(current.format);
  };

  function processUploadPump() {
    if (destroyed || gl!.isContextLost()) {
      return;
    }
    if (pendingPresentationFence) {
      pollPendingFence();
      return;
    }
    const pending = pendingVirtualPresentation;
    if (pending) {
      const result = appendVirtualTextureScenePass(
        pending.visibleScene,
        pending.scene.sourceLayout?.generation ?? pending.scene.generation,
        uploadBudgetBytes,
        uploadBudgetMilliseconds,
        true,
      );
      if (result === "pending") {
        scheduleUploadPump();
        emitPerformanceIfChanged();
        return;
      }
      pendingVirtualPresentation = null;
      if (result === "failed") {
        pending.onPresented?.(false);
      } else {
        submitPresentationFence(pending);
      }
      if (!pendingPresentationFence && pendingResidentPages.size > 0) {
        scheduleUploadPump();
      }
      return;
    }
    if (pendingPrefetchScene) {
      const prefetchScene = pendingPrefetchScene;
      const result = appendVirtualTextureScenePass(
        prefetchScene,
        pendingPrefetchGeneration
          ?? prefetchScene.sourceLayout?.generation
          ?? prefetchScene.generation,
        uploadBudgetBytes,
        uploadBudgetMilliseconds,
        true,
      );
      if (result !== "pending") {
        pendingPrefetchScene = null;
        pendingPrefetchGeneration = undefined;
        if (result === "ready" && pendingPrefetchPresentationRequested && scene) {
          drawVirtualTexturePan(scene);
        }
        pendingPrefetchPresentationRequested = false;
      }
      if (result === "pending") {
        scheduleUploadPump();
      } else if (pendingResidentPages.size > 0) {
        scheduleUploadPump();
      }
      emitPerformanceIfChanged();
      return;
    }
    const residentPage = pendingResidentPages.values().next().value as
      | PendingResidentPage
      | undefined;
    if (residentPage) {
      const pendingDepth = pendingResidentPages.size;
      pendingResidentPages.delete(residentPage.atlasKey);
      const startedAt = uploadContext.clock();
      const uploadedBytes = uploadResidentPage(residentPage);
      const elapsed = Math.max(0, uploadContext.clock() - startedAt);
      uploadContext.performance.uploadQueueFrames += 1;
      uploadContext.performance.uploadQueueMaxDepth = Math.max(
        uploadContext.performance.uploadQueueMaxDepth,
        pendingDepth,
      );
      uploadContext.performance.uploadQueueBytes += uploadedBytes;
      uploadContext.performance.uploadQueueMilliseconds += elapsed;
      uploadContext.performance.uploadQueueMaxFrameBytes = Math.max(
        uploadContext.performance.uploadQueueMaxFrameBytes,
        uploadedBytes,
      );
      uploadContext.performance.uploadQueueMaxFrameMilliseconds = Math.max(
        uploadContext.performance.uploadQueueMaxFrameMilliseconds,
        elapsed,
      );
      if (pendingResidentPages.size > 0) {
        uploadContext.performance.uploadQueueDeferredFrames += 1;
        scheduleUploadPump();
      }
      emitPerformanceIfChanged();
    }
  }

  const enqueueVirtualPresentation = (
    nextScene: ContactTileGpuScene,
    target: "front" | "staging",
    onPresented?: (presented: boolean) => void,
  ) => {
    if (!virtualResources || (!nextScene.sourceLayout && nextScene.visibleLayerComplete !== true)) {
      return false;
    }
    const attachPresentedCallback = (
      pending: PendingVirtualPresentation,
      callback: typeof onPresented,
    ) => {
      if (!callback || pending.onPresented === callback) {
        return;
      }
      const previous = pending.onPresented;
      pending.onPresented = (presented) => {
        previous?.(presented);
        callback(presented);
      };
    };
    if (
      pendingVirtualPresentation
      && pendingVirtualPresentation.target === target
      && sameContactTileGpuScene(pendingVirtualPresentation.scene, nextScene)
    ) {
      attachPresentedCallback(pendingVirtualPresentation, onPresented);
      traceContactPanCamera("gpu_scene_single_flight", {
        phase: "upload",
        target,
        viewport: nextScene.viewport,
        generation: nextScene.generation,
      });
      return true;
    }
    if (
      pendingPresentationFence
      && pendingPresentationFence.target === target
      && sameContactTileGpuScene(pendingPresentationFence.scene, nextScene)
    ) {
      attachPresentedCallback(pendingPresentationFence, onPresented);
      traceContactPanCamera("gpu_scene_single_flight", {
        phase: "fence",
        target,
        viewport: nextScene.viewport,
        generation: nextScene.generation,
      });
      return true;
    }
    pendingVirtualPresentation?.onPresented?.(false);
    if (pendingPresentationFence) {
      gl.deleteSync(pendingPresentationFence.sync);
      pendingPresentationFence.onPresented?.(false);
      pendingPresentationFence = null;
    }
    pendingPrefetchScene = null;
    pendingPrefetchGeneration = undefined;
    pendingPrefetchPresentationRequested = false;
    pendingVirtualPresentation = {
      id: nextUploadRequestId++,
      scene: nextScene,
      visibleScene: contactTileGpuVisibleUploadScene(nextScene),
      target,
      onPresented,
    };
    processUploadPump();
    return true;
  };

  const sceneWithRetainedPanViewport = (nextScene: ContactTileGpuScene) => (
    retainedPanViewport
      ? { ...nextScene, viewport: retainedPanViewport }
      : nextScene
  );

  const setActivePanViewport = (viewport: ContactViewport) => {
    traceContactPanCamera("gpu_camera_request", {
      requestedViewport: viewport,
      activeViewport: deltaScene?.viewport ?? scene?.viewport,
      retainedViewport: retainedPanViewport,
      pendingVirtualPresentation: Boolean(pendingVirtualPresentation),
      pendingPresentationFence: Boolean(pendingPresentationFence),
    });
    if (destroyed || gl.isContextLost()) {
      traceContactPanCamera("gpu_camera_unavailable", { requestedViewport: viewport });
      return;
    }
    if (pendingVirtualPresentation || pendingPresentationFence) {
      // The retained front FBO is authoritative while atlas layers/page-table
      // entries are in flight. Sampling a half-updated atlas would be worse
      // than holding the already-painted surface for this frame.
      const pendingTarget = pendingPresentationFence?.target
        ?? pendingVirtualPresentation?.target;
      if (
        hasPresentedFrontFrame
        && framePresentation
        && pendingTarget !== "front"
      ) {
        // A resize can invalidate the default surface even when its contents
        // are preserved. Re-blit the stable front while hidden staging/fence
        // work is still running.
        presentFramePresentation(gl, framePresentation, canvas.width, canvas.height);
        traceContactPanCamera("gpu_camera_represent", {
          requestedViewport: viewport,
          pendingTarget,
        });
      } else {
        traceContactPanCamera("gpu_camera_blocked", {
          requestedViewport: viewport,
          pendingTarget,
          hasPresentedFrontFrame,
        });
      }
      return;
    }
    const activeViewport = deltaScene?.viewport ?? scene?.viewport;
    if (
      !pendingPrefetchScene
      && pendingAppendedDescriptors.size === 0
      && activeViewport
      && sameContactTileGpuViewport(activeViewport, viewport)
    ) {
      if (hasPresentedFrontFrame && framePresentation) {
        // React publishes the committed viewport once more after the staged
        // front has painted. Re-present the authoritative FBO on that final
        // same-camera publication without redrawing the heatmap or uploading
        // any texture.
        presentFramePresentation(gl, framePresentation, canvas.width, canvas.height);
        traceContactPanCamera("gpu_camera_represent", {
          requestedViewport: viewport,
          reason: "same-viewport",
        });
      } else {
        traceContactPanCamera("gpu_camera_noop", { requestedViewport: viewport });
      }
      return;
    }
    if (deltaScene) {
      deltaScene = { ...deltaScene, viewport };
    } else if (scene) {
      scene = { ...scene, viewport };
    } else {
      traceContactPanCamera("gpu_camera_no_scene", { requestedViewport: viewport });
      return;
    }
    if (pendingPrefetchScene) {
      // A camera move that remains inside the resident page table can still
      // render. Crossing into a queued page simply retains the last front
      // FBO until that page becomes exact; never fall back to bulk uploads.
      if (scene && drawVirtualTexturePan(scene)) {
        pendingAppendedDescriptors.clear();
        traceContactPanCamera("gpu_camera_draw", {
          viewport: scene.viewport,
          mode: "prefetch",
        });
      } else {
        traceContactPanCamera("gpu_camera_hold", {
          viewport: scene?.viewport,
          mode: "prefetch",
        });
      }
      return;
    }
    // Pretext/Juicebox-style camera navigation: the visible textures are
    // sampled through one page-table draw. The established per-tile path is
    // retained only for unsupported drivers or incomplete page coverage.
    const activeScene = scene;
    const drawn = activeScene?.sourceLayout
      ? drawVirtualTexturePan(activeScene)
      : (activeScene && drawVirtualTexturePan(activeScene)) || draw(true);
    if (drawn) {
      pendingAppendedDescriptors.clear();
    }
    traceContactPanCamera(drawn ? "gpu_camera_draw" : "gpu_camera_hold", {
      viewport: activeScene?.viewport,
      mode: activeScene?.sourceLayout ? "source-layout" : "atlas",
    });
  };

  return {
    setScene: (nextScene, onPresented) => {
      const requestedViewport = nextScene.viewport;
      nextScene = sceneWithRetainedPanViewport(nextScene);
      traceContactPanCamera("gpu_set_scene", {
        requestedViewport,
        resolvedViewport: nextScene.viewport,
        retainedViewport: retainedPanViewport,
        generation: nextScene.generation,
      });
      if (
        !deltaScene
        && scene
        && sameContactTileGpuScene(scene, nextScene)
      ) {
        // ContactTileLayer publishes the already-promoted frame through React
        // immediately after promoteScene(). Do not clear, upload, or draw the
        // same pixels a second time in the child layout effect.
        scene = nextScene;
        onPresented?.(true);
        traceContactPanCamera("gpu_set_scene_reuse", {
          viewport: nextScene.viewport,
          generation: nextScene.generation,
        });
        return true;
      }
      if (
        deltaScene
        && nextScene.generation !== undefined
        && deltaScene.generation === nextScene.generation
      ) {
        for (const buffer of deltaBuffers.values()) {
          if (buffer.occupiedCount === 0) {
            continue;
          }
          const textureKey = gpuTextureKey(deltaScene, {
            tileX: buffer.tile.tileX,
            tileY: buffer.tile.tileY,
          });
          const cached = textureCache.get(textureKey);
          const cachedMatchesBuffer = cached?.generation === deltaScene.generation
            && cached.deltaBuffer === buffer;
          const entry = ensureDeltaTileTexture(
            gl,
            textureCache,
            textureKey,
            buffer,
            deltaScene.generation,
            deltaScene.tileSizeBins,
            ++useCounter,
            deltaScratch,
            uploadContext,
          );
          if (
            !entry
            || (cachedMatchesBuffer && !updateDeltaTileTexture(
              gl,
              entry,
              buffer,
              deltaScene.tileSizeBins,
              deltaScratch,
              uploadContext,
            ))
          ) {
            return false;
          }
        }
      }
      deltaScene = null;
      deltaBuffers = new Map();
      pendingAppendedDescriptors.clear();
      if (
        virtualResources
        && (nextScene.sourceLayout || nextScene.visibleLayerComplete === true)
      ) {
        return enqueueVirtualPresentation(
          nextScene,
          framePresentation ? "staging" : "front",
          onPresented,
        );
      }
      scene = nextScene;
      const painted = nextScene.sourceLayout
        ? drawCompleteVirtualScene(nextScene)
        : drawCompleteVirtualScene(nextScene) || draw();
      onPresented?.(painted);
      return painted;
    },
    stageScene: (nextScene, onPresented) => {
      const requestedViewport = nextScene.viewport;
      nextScene = sceneWithRetainedPanViewport(nextScene);
      traceContactPanCamera("gpu_stage_scene", {
        requestedViewport,
        resolvedViewport: nextScene.viewport,
        retainedViewport: retainedPanViewport,
        generation: nextScene.generation,
      });
      if (destroyed || !scene || gl.isContextLost()) {
        return false;
      }
      if (!deltaScene && sameContactTileGpuScene(scene, nextScene)) {
        scene = nextScene;
        onPresented?.(true);
        return true;
      }
      if (
        virtualResources
        && (nextScene.sourceLayout || nextScene.visibleLayerComplete === true)
      ) {
        return enqueueVirtualPresentation(nextScene, "staging", onPresented);
      }
      const previousScene = scene;
      const previousDeltaScene = deltaScene;
      const previousDeltaBuffers = deltaBuffers;
      scene = nextScene;
      deltaScene = null;
      deltaBuffers = new Map();
      const drawn = nextScene.sourceLayout
        ? drawCompleteVirtualScene(nextScene, "staging", false)
        : drawCompleteVirtualScene(nextScene, "staging", false)
          || draw(false, null, false, "staging", false);
      if (!drawn || !stagingFramePresentation) {
        scene = previousScene;
        deltaScene = previousDeltaScene;
        deltaBuffers = previousDeltaBuffers;
        if (previousScene.visibleLayerComplete === true) {
          appendVirtualTextureScene(previousScene);
        }
        return false;
      }

      pendingAppendedDescriptors.clear();
      scene = nextScene;
      deltaScene = null;
      deltaBuffers = new Map();
      if (!presentStagingFrame()) {
        onPresented?.(false);
        return false;
      }
      uploadContext.performance.stagedSceneDraws += 1;
      emitPerformanceIfChanged();
      onPresented?.(true);
      traceContactPanCamera("gpu_stage_presented", {
        viewport: nextScene.viewport,
        generation: nextScene.generation,
      });
      return true;
    },
    promoteScene: (nextScene) => {
      const requestedViewport = nextScene.viewport;
      nextScene = sceneWithRetainedPanViewport(nextScene);
      traceContactPanCamera("gpu_promote_scene", {
        requestedViewport,
        resolvedViewport: nextScene.viewport,
        retainedViewport: retainedPanViewport,
        generation: nextScene.generation,
      });
      const startedAt = uploadContext.clock();
      const fail = () => {
        uploadContext.performance.scenePromotionMisses += 1;
        emitPerformanceIfChanged();
        traceContactPanCamera("gpu_promote_miss", {
          viewport: nextScene.viewport,
          generation: nextScene.generation,
        });
        return false;
      };
      if (
        destroyed
        || !scene
        || deltaScene
        || gl.isContextLost()
        || scene.resolution !== nextScene.resolution
        || scene.tileSizeBins !== nextScene.tileSizeBins
        || nextScene.visibleLayerComplete !== true
        || !sameContactTileGpuOverview(scene.overview ?? null, nextScene.overview ?? null)
      ) {
        return fail();
      }

      const atlas = virtualTextureState;
      const atlasPromotable = Boolean(
        virtualResources
        && atlas
        && atlas.resolution === nextScene.resolution
        && atlas.tileSizeBins === nextScene.tileSizeBins
        && nextScene.descriptors.every((descriptor) => {
          if (contactTileCellCount(descriptor.tile) === 0) {
            return true;
          }
          const key = virtualTextureAtlasKey(nextScene, contactTileKey(descriptor.tile));
          const resident = atlas.tileByTileKey.get(key);
          return resident === descriptor.tile || Boolean(
            resident
            && nextScene.generation !== undefined
            && atlas.generationByTileKey.get(key) === nextScene.generation
            && contactTileCellCount(resident) === contactTileCellCount(descriptor.tile)
          );
        }),
      );
      if (atlasPromotable && atlas) {
        const previousScene = scene;
        const previousPendingDescriptors = new Map(pendingAppendedDescriptors);
        const previousAtlasTiles = nextScene.descriptors.map(({ tile }) => {
          const key = virtualTextureAtlasKey(nextScene, contactTileKey(tile));
          return {
            key,
            tile: atlas.tileByTileKey.get(key),
            generation: atlas.generationByTileKey.get(key),
          };
        });
        for (const descriptor of nextScene.descriptors) {
          if (contactTileCellCount(descriptor.tile) === 0) {
            continue;
          }
          const key = virtualTextureAtlasKey(nextScene, contactTileKey(descriptor.tile));
          atlas.tileByTileKey.set(key, descriptor.tile);
          atlas.generationByTileKey.set(key, nextScene.generation);
          atlas.lastUsedByTileKey.set(key, ++useCounter);
        }
        pendingAppendedDescriptors.clear();
        scene = nextScene;
        const uploadsBeforePromotion = uploadContext.performance.virtualTextureUploads;
        // A resident cache hit must still be a presentation transaction. Draw
        // the target into the hidden FBO and expose it only with the final
        // blit; mutating the retained front FBO made fast backtracking appear
        // as a short camera wobble when React rebased the pan overlays.
        const promoted = drawCompleteVirtualScene(nextScene, "staging", false);
        if (
          !promoted
          || !stagingFramePresentation
          || uploadContext.performance.virtualTextureUploads !== uploadsBeforePromotion
        ) {
          scene = previousScene;
          pendingAppendedDescriptors.clear();
          for (const [key, descriptor] of previousPendingDescriptors) {
            pendingAppendedDescriptors.set(key, descriptor);
          }
          for (const previous of previousAtlasTiles) {
            if (previous.tile) {
              atlas.tileByTileKey.set(previous.key, previous.tile);
            } else {
              atlas.tileByTileKey.delete(previous.key);
            }
            if (previous.generation !== undefined) {
              atlas.generationByTileKey.set(previous.key, previous.generation);
            } else {
              atlas.generationByTileKey.delete(previous.key);
            }
          }
          appendVirtualTextureScene(previousScene);
          return fail();
        }
        if (!presentStagingFrame()) {
          scene = previousScene;
          return fail();
        }
        uploadContext.performance.scenePromotions += 1;
        uploadContext.performance.scenePromotionMilliseconds += Math.max(
          0,
          uploadContext.clock() - startedAt,
        );
        emitPerformanceIfChanged();
        traceContactPanCamera("gpu_promote_presented", {
          viewport: nextScene.viewport,
          generation: nextScene.generation,
          mode: "atlas",
        });
        return true;
      }

      const promotableEntries: Array<{
        entry: GpuTextureEntry;
        tile: ContactMapTile;
      }> = [];
      for (const descriptor of nextScene.descriptors) {
        if (contactTileCellCount(descriptor.tile) === 0) {
          continue;
        }
        const entry = textureCache.get(gpuTextureKey(nextScene, descriptor.tile));
        const exactTile = entry?.tile === descriptor.tile;
        const residentCellCount = entry?.tile
          ? contactTileCellCount(entry.tile)
          : entry?.deltaBuffer?.occupiedCount;
        const matchingPrefetch = Boolean(
          entry
          && nextScene.generation !== undefined
          && entry.generation === nextScene.generation
          && (entry.panPrefetchSnapshot || entry.deltaBuffer)
          && residentCellCount === contactTileCellCount(descriptor.tile)
        );
        if (!entry || (!exactTile && !matchingPrefetch)) {
          return fail();
        }
        promotableEntries.push({ entry, tile: descriptor.tile });
      }

      const previousScene = scene;
      const previousPendingDescriptors = new Map(pendingAppendedDescriptors);
      const previousEntryState = promotableEntries.map(({ entry }) => ({
        entry,
        tile: entry.tile,
        deltaBuffer: entry.deltaBuffer,
        panPrefetchSnapshot: entry.panPrefetchSnapshot,
        generation: entry.generation,
        lastUsed: entry.lastUsed,
      }));
      for (const { entry, tile } of promotableEntries) {
        entry.tile = tile;
        entry.deltaBuffer = undefined;
        entry.panPrefetchSnapshot = false;
        entry.generation = nextScene.generation;
        entry.lastUsed = ++useCounter;
      }
      pendingAppendedDescriptors.clear();
      scene = nextScene;
      const uploadsBeforePromotion = uploadContext.performance.uploads;
      const promoted = draw(false, null, false, "staging", false);
      if (
        !promoted
        || !stagingFramePresentation
        || uploadContext.performance.uploads !== uploadsBeforePromotion
      ) {
        scene = previousScene;
        pendingAppendedDescriptors.clear();
        for (const [key, descriptor] of previousPendingDescriptors) {
          pendingAppendedDescriptors.set(key, descriptor);
        }
        for (const previous of previousEntryState) {
          previous.entry.tile = previous.tile;
          previous.entry.deltaBuffer = previous.deltaBuffer;
          previous.entry.panPrefetchSnapshot = previous.panPrefetchSnapshot;
          previous.entry.generation = previous.generation;
          previous.entry.lastUsed = previous.lastUsed;
        }
        return fail();
      }
      if (!presentStagingFrame()) {
        scene = previousScene;
        return fail();
      }

      uploadContext.performance.scenePromotions += 1;
      uploadContext.performance.scenePromotionMilliseconds += Math.max(
        0,
        uploadContext.clock() - startedAt,
      );
      emitPerformanceIfChanged();
      traceContactPanCamera("gpu_promote_presented", {
        viewport: nextScene.viewport,
        generation: nextScene.generation,
        mode: "texture-cache",
      });
      return true;
    },
    ingestPrefetchedPages: (input) => {
      const current = virtualTextureState;
      const activeGeneration = scene?.sourceLayout?.generation ?? scene?.generation;
      if (
        destroyed
        || !virtualResources
        || !current
        || !scene
        || deltaScene
        || gl.isContextLost()
        || activeGeneration !== input.generation
        || current.tileSizeBins !== input.tileSizeBins
      ) {
        return false;
      }

      let accepted = false;
      let queued = false;
      for (const tile of input.tiles) {
        if (contactTileCellCount(tile) === 0) {
          continue;
        }
        const atlasKey = virtualTextureResidentKey(
          input.dataScope,
          input.resolution,
          input.tileSizeBins,
          contactTileKey(tile),
        );
        if (current.tileByTileKey.get(atlasKey) === tile) {
          current.generationByTileKey.set(atlasKey, input.generation);
          current.lastUsedByTileKey.set(atlasKey, ++useCounter);
          accepted = true;
          continue;
        }
        if (
          !pendingResidentPages.has(atlasKey)
          && pendingResidentPages.size >= current.capacity
        ) {
          continue;
        }
        pendingResidentPages.set(atlasKey, {
          atlasKey,
          generation: input.generation,
          resolution: input.resolution,
          tileSizeBins: input.tileSizeBins,
          tile,
        });
        accepted = true;
        queued = true;
      }
      if (queued) {
        scheduleUploadPump();
      }
      return accepted;
    },
    appendSceneDescriptors: (input) => {
      if (
        destroyed
        || !scene
        || deltaScene
        || gl.isContextLost()
        || scene.resolution !== input.resolution
        || scene.tileSizeBins !== input.tileSizeBins
      ) {
        return false;
      }
      const currentScene = scene;
      const refreshesPendingPrefetch = pendingPrefetchScene !== null
        && pendingPrefetchGeneration === input.generation;
      const usesPersistentAtlas = Boolean(
        virtualResources
        && virtualTextureState
        && virtualTextureState.resolution === currentScene.resolution
        && virtualTextureState.tileSizeBins === currentScene.tileSizeBins,
      );

      const bytesPerTile = Math.max(
        1,
        currentScene.tileSizeBins
          * currentScene.tileSizeBins
          * contactTileGpuBytesPerTexel(texturePreference),
      );
      const maximumUniqueTiles = usesPersistentAtlas
        ? virtualTextureState!.capacity
        : Math.max(1, Math.floor(safeTextureBudget / bytesPerTile));
      const retainedDescriptors = [...currentScene.descriptors];
      const retainedDescriptorKeys = new Set(
        retainedDescriptors.map((descriptor) => descriptor.key),
      );
      const retainedTiles = new Map<string, ContactMapTile>();
      for (const descriptor of retainedDescriptors) {
        retainedTiles.set(contactTileKey(descriptor.tile), descriptor.tile);
      }
      const incomingTiles = new Map<string, ContactMapTile>();
      for (const descriptor of input.descriptors) {
        incomingTiles.set(contactTileKey(descriptor.tile), descriptor.tile);
      }
      const refreshedTiles = new Map<string, ContactMapTile>();
      for (const [tileKey, tile] of incomingTiles) {
        if (usesPersistentAtlas) {
          const atlasKey = virtualTextureAtlasKey(currentScene, tileKey);
          const atlasTile = virtualTextureState!.tileByTileKey.get(atlasKey);
          const atlasGeneration = virtualTextureState!.generationByTileKey.get(atlasKey);
          if (atlasGeneration === input.generation) {
            if (atlasTile !== tile) {
              retainedTiles.set(tileKey, tile);
              refreshedTiles.set(tileKey, tile);
            }
            continue;
          }
          if (refreshesPendingPrefetch) {
            const retainedTile = retainedTiles.get(tileKey);
            if (
              retainedTile
              && contactTileCellCount(tile) >= contactTileCellCount(retainedTile)
            ) {
              retainedTiles.set(tileKey, tile);
              refreshedTiles.set(tileKey, tile);
              continue;
            }
          }
          // Keep a complete tile from the currently presented generation over
          // a partial snapshot for the same page.
          if (retainedTiles.has(tileKey)) {
            continue;
          }
          if (retainedTiles.size >= maximumUniqueTiles) {
            continue;
          }
          retainedTiles.set(tileKey, tile);
          refreshedTiles.set(tileKey, tile);
          continue;
        }
        const textureKey = gpuTextureKey(currentScene, tile);
        const cached = textureCache.get(textureKey);
        if (cached?.generation === input.generation) {
          if (
            cached.tile !== tile
            && !updateTileTexture(
              gl,
              cached,
              tile,
              input.generation,
              currentScene.tileSizeBins,
              ++useCounter,
              uploadContext,
            )
          ) {
            return false;
          }
          retainedTiles.set(tileKey, tile);
          refreshedTiles.set(tileKey, tile);
          continue;
        }
        // A complete tile already owned by the presented generation is more
        // authoritative than a partial snapshot from the next pan generation.
        if (retainedTiles.has(tileKey)) {
          continue;
        }
        if (retainedTiles.size >= maximumUniqueTiles) {
          continue;
        }
        if (contactTileCellCount(tile) > 0) {
          const entry = ensureTileTexture(
            gl,
            textureCache,
            textureKey,
            tile,
            input.generation,
            currentScene.tileSizeBins,
            ++useCounter,
            uploadContext,
          );
          if (!entry) {
            return false;
          }
          entry.panPrefetchSnapshot = true;
        }
        retainedTiles.set(tileKey, tile);
        refreshedTiles.set(tileKey, tile);
      }

      // Replace every source/mirror descriptor for a refreshed tile. Pointer
      // pans require descriptor identity to match the cache entry; otherwise a
      // later pan frame would fall back to the stale full-scene texture.
      for (let index = 0; index < retainedDescriptors.length; index += 1) {
        const descriptor = retainedDescriptors[index]!;
        const tile = refreshedTiles.get(contactTileKey(descriptor.tile));
        if (!tile) {
          continue;
        }
        const refreshed = { ...descriptor, tile };
        retainedDescriptors[index] = refreshed;
        if (contactTileCellCount(tile) > 0) {
          pendingAppendedDescriptors.set(refreshed.key, refreshed);
        }
      }

      for (const descriptor of input.descriptors) {
        if (retainedDescriptorKeys.has(descriptor.key)) {
          continue;
        }
        const tile = retainedTiles.get(contactTileKey(descriptor.tile));
        if (!tile) {
          continue;
        }
        const retainedDescriptor = { ...descriptor, tile };
        retainedDescriptors.push(retainedDescriptor);
        retainedDescriptorKeys.add(retainedDescriptor.key);
        if (contactTileCellCount(tile) > 0) {
          pendingAppendedDescriptors.set(retainedDescriptor.key, retainedDescriptor);
        }
      }

      // Extend the active pointer camera in place. Do not clear or redraw the
      // framebuffer here; the next requestAnimationFrame pan uses the expanded
      // descriptor set, while a stationary pointer keeps the current frame.
      scene = { ...currentScene, descriptors: retainedDescriptors };
      if (usesPersistentAtlas) {
        pendingPrefetchScene = scene;
        pendingPrefetchGeneration = input.generation;
        scheduleUploadPump();
      } else if (!appendVirtualTextureScene(scene, input.generation)) {
        uploadContext.performance.virtualTextureFallbacks += 1;
      }
      textureBytes = cachedTextureBytes(textureCache);
      if (textureBytes > safeTextureBudget) {
        const protectedKeys = new Set(
          retainedDescriptors.map((descriptor) => gpuTextureKey(currentScene, descriptor.tile)),
        );
        const eviction = evictLeastRecentlyUsedTextures(
          gl,
          textureCache,
          textureBytes,
          safeTextureBudget,
          protectedKeys,
        );
        textureBytes = eviction.bytes;
        uploadContext.performance.evictions += eviction.count;
        uploadContext.performance.evictedBytes += eviction.evictedBytes;
      }
      gl.bindTexture(gl.TEXTURE_2D, null);
      emitPerformanceIfChanged();
      return true;
    },
    presentAppendedSceneDescriptors: () => {
      if (
        destroyed
        || !scene
        || deltaScene
        || gl.isContextLost()
      ) {
        return false;
      }
      if (pendingPrefetchScene) {
        pendingPrefetchPresentationRequested = true;
        scheduleUploadPump();
        return true;
      }
      const descriptors = [...pendingAppendedDescriptors.values()];
      pendingAppendedDescriptors.clear();
      // The page table was already extended by appendSceneDescriptors(). If
      // it now covers the live camera, present one complete virtual-texture
      // frame immediately. Otherwise preserve the current framebuffer and
      // overlay only the newly resident legacy quads below.
      if (drawVirtualTexturePan(scene)) {
        return true;
      }
      if (descriptors.length === 0) {
        return true;
      }
      // The framebuffer already contains the pointer-translated front scene.
      // Draw only appended or refreshed quads into the existing framebuffer:
      // no resize, clear, React state change, or full-scene replacement.
      return draw(true, descriptors, true);
    },
    setDeltaScene: (nextScene) => {
      scene = null;
      pendingAppendedDescriptors.clear();
      deltaScene = nextScene;
      deltaBuffers = new Map(
        nextScene.buffers.map((buffer) => [contactTileKey(buffer.tile), buffer]),
      );
      const requiredScratchLength = nextScene.tileSizeBins * nextScene.tileSizeBins;
      if (deltaScratch.length !== requiredScratchLength) {
        deltaScratch = new Float32Array(requiredScratchLength);
      }
      return draw();
    },
    updateDeltaTiles: (changedTileKeys) => {
      if (!deltaScene || destroyed || gl.isContextLost()) {
        return false;
      }
      if (deltaScene.deferTextureUpdates) {
        return true;
      }
      const changed = new Set(changedTileKeys);
      for (const [key, buffer] of deltaBuffers) {
        if (!changed.has(key)) {
          continue;
        }
        const textureKey = gpuTextureKey(deltaScene, {
          tileX: buffer.tile.tileX,
          tileY: buffer.tile.tileY,
        });
        const entry = ensureDeltaTileTexture(
          gl,
          textureCache,
          textureKey,
          buffer,
          deltaScene.generation,
          deltaScene.tileSizeBins,
          ++useCounter,
          deltaScratch,
          uploadContext,
        );
        if (!entry || !updateDeltaTileTexture(
          gl,
          entry,
          buffer,
          deltaScene.tileSizeBins,
          deltaScratch,
          uploadContext,
        )) {
          return false;
        }
      }
      return draw();
    },
    setPanViewport: setActivePanViewport,
    retainPanViewport: (viewport) => {
      traceContactPanCamera("gpu_retain_camera", { viewport });
      retainedPanViewport = viewport;
      setActivePanViewport(viewport);
    },
    releasePanViewport: (viewport) => {
      traceContactPanCamera("gpu_release_camera", {
        viewport,
        retainedViewport: retainedPanViewport,
      });
      retainedPanViewport = null;
      setActivePanViewport(viewport);
    },
    redraw: () => {
      if (pendingVirtualPresentation || pendingPresentationFence) {
        if (hasPresentedFrontFrame && framePresentation) {
          // A ResizeObserver callback can arrive while a target scene is still
          // uploading or waiting on its GPU fence. WebKit may discard the
          // opaque default framebuffer as the canvas layer changes size, even
          // though the authoritative front FBO is still valid. Re-present that
          // stable surface now; the pending scene will replace it atomically
          // once its fence signals.
          presentFramePresentation(gl, framePresentation, canvas.width, canvas.height);
          traceContactPanCamera("gpu_redraw_represent", {
            pendingTarget: pendingPresentationFence?.target
              ?? pendingVirtualPresentation?.target,
            viewport: scene?.viewport,
          });
        }
        return true;
      }
      if (scene && pendingPrefetchScene) {
        // Resize/style invalidation must not bypass the frame-budgeted queue.
        // Repaint only when the resident page table already covers the camera;
        // otherwise retain the last front surface until the queue catches up.
        drawVirtualTexturePan(scene);
        return true;
      }
      return scene?.sourceLayout
        ? drawCompleteVirtualScene(scene)
        : scene
          ? drawCompleteVirtualScene(scene) || draw()
          : draw();
    },
    performanceSnapshot: () => {
      updatePerformanceCacheState();
      return contactTileGpuPerformanceSnapshot(uploadContext.performance);
    },
    destroy: () => {
      if (destroyed) {
        return;
      }
      destroyed = true;
      cancelScheduledUploadFrame();
      pendingVirtualPresentation?.onPresented?.(false);
      pendingVirtualPresentation = null;
      pendingPrefetchScene = null;
      pendingResidentPages.clear();
      if (pendingPresentationFence) {
        gl.deleteSync(pendingPresentationFence.sync);
        pendingPresentationFence.onPresented?.(false);
        pendingPresentationFence = null;
      }
      for (const entry of textureCache.values()) {
        gl.deleteTexture(entry.texture);
      }
      textureCache.clear();
      if (overviewTextureEntry) {
        gl.deleteTexture(overviewTextureEntry.texture);
        overviewTextureEntry = null;
      }
      pendingAppendedDescriptors.clear();
      if (framePresentation) {
        gl.deleteFramebuffer(framePresentation.framebuffer);
        gl.deleteTexture(framePresentation.texture);
        framePresentation = null;
      }
      if (stagingFramePresentation) {
        gl.deleteFramebuffer(stagingFramePresentation.framebuffer);
        gl.deleteTexture(stagingFramePresentation.texture);
        stagingFramePresentation = null;
      }
      deleteVirtualTextureState(virtualTextureState);
      virtualTextureState = null;
      if (virtualResources) {
        gl.deleteProgram(virtualResources.program);
      }
      gl.deleteTexture(resources.lutTexture);
      gl.deleteBuffer(resources.quadBuffer);
      gl.deleteProgram(resources.program);
      gl.deleteBuffer(boundaryResources.geometryBuffer);
      gl.deleteBuffer(boundaryResources.instanceBuffer);
      gl.deleteProgram(boundaryResources.program);
    },
  };
}

function recordContactTileGpuUpload(
  context: ContactTileGpuUploadContext,
  format: ContactTileGpuTextureFormat,
  fullUpload: boolean,
  startedAt: number,
) {
  const performance = context.performance;
  performance.uploads += 1;
  if (fullUpload) {
    performance.fullUploads += 1;
  } else {
    performance.subUploads += 1;
  }
  if (format === "r16f") {
    performance.r16fUploads += 1;
  } else {
    performance.r32fUploads += 1;
  }
  performance.uploadMilliseconds += Math.max(0, context.clock() - startedAt);
}

function uploadContactTileGpuTextureImage(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  input: ContactTileGpuTextureData | Float32Array,
  context: ContactTileGpuUploadContext,
  startedAt = context.clock(),
): ContactTileGpuUploadResult | null {
  const data: ContactTileGpuTextureData = input instanceof Float32Array
    ? { format: "float32", values: input }
    : input;
  const wantsR16f = context.preference === "r16f";
  const fitsR16f = data.format === "r16f"
    || !wantsR16f
    || contactTileGpuFloatValuesFitR16f(data.values);
  if (wantsR16f && !fitsR16f) {
    context.performance.rangeFallbacks += 1;
  }

  if (wantsR16f && fitsR16f) {
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R16F,
      width,
      height,
      0,
      gl.RED,
      data.format === "r16f" ? gl.HALF_FLOAT : gl.FLOAT,
      data.values,
    );
    if (gl.getError() === gl.NO_ERROR) {
      recordContactTileGpuUpload(context, "r16f", true, startedAt);
      return {
        format: "r16f",
        bytes: data.values.length * contactTileGpuBytesPerTexel("r16f"),
      };
    }
    context.performance.uploadErrorFallbacks += 1;
  }

  const float32Values = data.format === "r16f"
    ? contactTileR16fValuesToFloat32(data.values)
    : data.values;
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.R32F,
    width,
    height,
    0,
    gl.RED,
    gl.FLOAT,
    float32Values,
  );
  if (gl.getError() !== gl.NO_ERROR) {
    return null;
  }
  recordContactTileGpuUpload(context, "r32f", true, startedAt);
  return {
    format: "r32f",
    bytes: float32Values.length * contactTileGpuBytesPerTexel("r32f"),
  };
}

function updateContactTileGpuTextureImage(
  gl: WebGL2RenderingContext,
  entry: GpuTextureEntry,
  width: number,
  height: number,
  input: ContactTileGpuTextureData | Float32Array,
  context: ContactTileGpuUploadContext,
) {
  const startedAt = context.clock();
  const data: ContactTileGpuTextureData = input instanceof Float32Array
    ? { format: "float32", values: input }
    : input;
  if (
    entry.format === "r16f"
    && data.format === "float32"
    && !contactTileGpuFloatValuesFitR16f(data.values)
  ) {
    context.performance.rangeFallbacks += 1;
    const uploaded = uploadContactTileGpuTextureImage(
      gl,
      width,
      height,
      data,
      { ...context, preference: "r32f" },
      startedAt,
    );
    if (!uploaded) {
      return false;
    }
    entry.format = uploaded.format;
    entry.bytes = uploaded.bytes;
    return true;
  }

  const uploadValues = entry.format === "r32f" && data.format === "r16f"
    ? contactTileR16fValuesToFloat32(data.values)
    : data.values;
  const uploadType = entry.format === "r16f" && data.format === "r16f"
    ? gl.HALF_FLOAT
    : gl.FLOAT;
  gl.texSubImage2D(
    gl.TEXTURE_2D,
    0,
    0,
    0,
    width,
    height,
    gl.RED,
    uploadType,
    uploadValues,
  );
  if (gl.getError() === gl.NO_ERROR) {
    recordContactTileGpuUpload(context, entry.format, false, startedAt);
    return true;
  }
  if (entry.format !== "r16f") {
    return false;
  }

  context.performance.uploadErrorFallbacks += 1;
  const uploaded = uploadContactTileGpuTextureImage(
    gl,
    width,
    height,
    data,
    { ...context, preference: "r32f" },
    startedAt,
  );
  if (!uploaded) {
    return false;
  }
  entry.format = uploaded.format;
  entry.bytes = uploaded.bytes;
  return true;
}

function ensureOverviewTexture(
  gl: WebGL2RenderingContext,
  current: GpuOverviewTextureEntry | null,
  overview: ContactTileGpuOverview,
  uploadContext: ContactTileGpuUploadContext,
): GpuOverviewTextureEntry | null {
  if (
    current
    && current.values === overview.values
    && current.width === overview.width
    && current.height === overview.height
  ) {
    return current;
  }
  if (
    overview.values.length !== overview.width * overview.height
    || overview.width <= 0
    || overview.height <= 0
  ) {
    return null;
  }
  if (current) {
    gl.deleteTexture(current.texture);
  }
  const texture = gl.createTexture();
  if (!texture) {
    return null;
  }
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const uploaded = uploadContactTileGpuTextureImage(
    gl,
    overview.width,
    overview.height,
    overview.values,
    uploadContext,
  );
  if (!uploaded) {
    gl.deleteTexture(texture);
    return null;
  }
  return {
    texture,
    format: uploaded.format,
    values: overview.values,
    width: overview.width,
    height: overview.height,
  };
}

function drawBoundaryScene(
  gl: WebGL2RenderingContext,
  resources: BoundaryRendererResources,
  boundaries: readonly ContactTileGpuBoundary[],
  viewport: ContactViewport,
  canvasWidth: number,
  canvasHeight: number,
  cssWidth: number,
  cssHeight: number,
  uploadedBoundaries: readonly ContactTileGpuBoundary[] | null,
  uploadedBoundaryCount: number,
) {
  if (boundaries.length === 0) {
    return true;
  }
  const uploadsNewBuffer = uploadedBoundaries !== boundaries;
  if (uploadsNewBuffer) {
    gl.bindBuffer(gl.ARRAY_BUFFER, resources.instanceBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      contactTileGpuBoundaryInstanceData(boundaries),
      gl.STATIC_DRAW,
    );
  }

  gl.useProgram(resources.program);
  gl.uniform4f(
    resources.viewportLocation,
    viewport.xStart,
    Math.max(1, viewport.xEnd - viewport.xStart),
    viewport.yStart,
    Math.max(1, viewport.yEnd - viewport.yStart),
  );
  gl.uniform2f(resources.canvasSizeLocation, canvasWidth, canvasHeight);
  gl.uniform2f(resources.cssSizeLocation, cssWidth, cssHeight);
  gl.uniform2f(
    resources.cssScaleLocation,
    canvasWidth / Math.max(1, cssWidth),
    canvasHeight / Math.max(1, cssHeight),
  );

  gl.bindBuffer(gl.ARRAY_BUFFER, resources.geometryBuffer);
  gl.enableVertexAttribArray(resources.edgeLocation);
  gl.vertexAttribPointer(resources.edgeLocation, 4, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(resources.edgeLocation, 0);

  const stride = boundaryInstanceStrideFloats * Float32Array.BYTES_PER_ELEMENT;
  gl.bindBuffer(gl.ARRAY_BUFFER, resources.instanceBuffer);
  gl.enableVertexAttribArray(resources.intervalLocation);
  gl.vertexAttribPointer(resources.intervalLocation, 2, gl.FLOAT, false, stride, 0);
  gl.vertexAttribDivisor(resources.intervalLocation, 1);
  gl.enableVertexAttribArray(resources.colorLocation);
  gl.vertexAttribPointer(
    resources.colorLocation,
    3,
    gl.FLOAT,
    false,
    stride,
    2 * Float32Array.BYTES_PER_ELEMENT,
  );
  gl.vertexAttribDivisor(resources.colorLocation, 1);
  gl.enableVertexAttribArray(resources.styleLocation);
  gl.vertexAttribPointer(
    resources.styleLocation,
    2,
    gl.FLOAT,
    false,
    stride,
    5 * Float32Array.BYTES_PER_ELEMENT,
  );
  gl.vertexAttribDivisor(resources.styleLocation, 1);

  gl.drawArraysInstanced(
    gl.TRIANGLES,
    0,
    24,
    uploadsNewBuffer ? boundaries.length : uploadedBoundaryCount,
  );

  gl.vertexAttribDivisor(resources.intervalLocation, 0);
  gl.vertexAttribDivisor(resources.colorLocation, 0);
  gl.vertexAttribDivisor(resources.styleLocation, 0);
  gl.disableVertexAttribArray(resources.edgeLocation);
  gl.disableVertexAttribArray(resources.intervalLocation);
  gl.disableVertexAttribArray(resources.colorLocation);
  gl.disableVertexAttribArray(resources.styleLocation);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  return true;
}

function createBoundaryRendererResources(
  gl: WebGL2RenderingContext,
): BoundaryRendererResources | null {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, boundaryVertexShaderSource);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, boundaryFragmentShaderSource);
  if (!vertexShader || !fragmentShader) {
    if (vertexShader) gl.deleteShader(vertexShader);
    if (fragmentShader) gl.deleteShader(fragmentShader);
    return null;
  }
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    return null;
  }
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }

  const geometryBuffer = gl.createBuffer();
  const instanceBuffer = gl.createBuffer();
  if (!geometryBuffer || !instanceBuffer) {
    if (geometryBuffer) gl.deleteBuffer(geometryBuffer);
    if (instanceBuffer) gl.deleteBuffer(instanceBuffer);
    gl.deleteProgram(program);
    return null;
  }
  const edgeVertices: number[] = [];
  const quad = [
    [0, -0.5], [1, -0.5], [0, 0.5],
    [0, 0.5], [1, -0.5], [1, 0.5],
  ] as const;
  for (const axis of [0, 1]) {
    for (const side of [0, 1]) {
      for (const [along, across] of quad) {
        edgeVertices.push(axis, side, along, across);
      }
    }
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, geometryBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(edgeVertices), gl.STATIC_DRAW);

  const edgeLocation = gl.getAttribLocation(program, "a_edge");
  const intervalLocation = gl.getAttribLocation(program, "a_interval");
  const colorLocation = gl.getAttribLocation(program, "a_color");
  const styleLocation = gl.getAttribLocation(program, "a_style");
  const viewportLocation = gl.getUniformLocation(program, "u_viewport");
  const canvasSizeLocation = gl.getUniformLocation(program, "u_canvas_size");
  const cssSizeLocation = gl.getUniformLocation(program, "u_css_size");
  const cssScaleLocation = gl.getUniformLocation(program, "u_css_scale");
  if (
    edgeLocation < 0
    || intervalLocation < 0
    || colorLocation < 0
    || styleLocation < 0
    || !viewportLocation
    || !canvasSizeLocation
    || !cssSizeLocation
    || !cssScaleLocation
  ) {
    gl.deleteBuffer(geometryBuffer);
    gl.deleteBuffer(instanceBuffer);
    gl.deleteProgram(program);
    return null;
  }
  return {
    program,
    geometryBuffer,
    instanceBuffer,
    edgeLocation,
    intervalLocation,
    colorLocation,
    styleLocation,
    viewportLocation,
    canvasSizeLocation,
    cssSizeLocation,
    cssScaleLocation,
  };
}

function drawTextureQuad(
  gl: WebGL2RenderingContext,
  resources: RendererResources,
  texture: WebGLTexture,
  left: number,
  top: number,
  width: number,
  height: number,
  transpose: boolean,
) {
  gl.uniform4f(resources.rectLocation, left, top, width, height);
  gl.uniform1i(resources.transposeLocation, transpose ? 1 : 0);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.uniform1i(resources.tileTextureLocation, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

function clearCanvasRectToWhite(
  gl: WebGL2RenderingContext,
  canvasWidth: number,
  canvasHeight: number,
  left: number,
  top: number,
  width: number,
  height: number,
) {
  const xStart = Math.max(0, Math.floor(left));
  const xEnd = Math.min(canvasWidth, Math.ceil(left + width));
  const yStartFromTop = Math.max(0, Math.floor(top));
  const yEndFromTop = Math.min(canvasHeight, Math.ceil(top + height));
  if (xEnd <= xStart || yEndFromTop <= yStartFromTop) {
    return;
  }
  gl.enable(gl.SCISSOR_TEST);
  gl.scissor(
    xStart,
    canvasHeight - yEndFromTop,
    xEnd - xStart,
    yEndFromTop - yStartFromTop,
  );
  gl.clearColor(1, 1, 1, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.disable(gl.SCISSOR_TEST);
}

function applyColorScaleUniforms(
  gl: WebGL2RenderingContext,
  resources: RendererResources,
  colorScale: ContactTileRenderStyle["colorScale"],
) {
  const minimum = Math.max(0, colorScale.min);
  const maximum = Math.max(minimum, colorScale.max);
  gl.uniform4f(
    resources.scaleLocation,
    minimum,
    maximum,
    colorScale.log ? 1 : 0,
    0,
  );
}

function createRendererResources(gl: WebGL2RenderingContext): RendererResources | null {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
  if (!vertexShader || !fragmentShader) {
    if (vertexShader) gl.deleteShader(vertexShader);
    if (fragmentShader) gl.deleteShader(fragmentShader);
    return null;
  }
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    return null;
  }
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }

  const quadBuffer = gl.createBuffer();
  const lutTexture = gl.createTexture();
  if (!quadBuffer || !lutTexture) {
    if (quadBuffer) gl.deleteBuffer(quadBuffer);
    if (lutTexture) gl.deleteTexture(lutTexture);
    gl.deleteProgram(program);
    return null;
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    0, 0, 1, 0, 0, 1,
    0, 1, 1, 0, 1, 1,
  ]), gl.STATIC_DRAW);

  const positionLocation = gl.getAttribLocation(program, "a_position");
  const rectLocation = gl.getUniformLocation(program, "u_rect");
  const canvasSizeLocation = gl.getUniformLocation(program, "u_canvas_size");
  const transposeLocation = gl.getUniformLocation(program, "u_transpose");
  const tileTextureLocation = gl.getUniformLocation(program, "u_tile");
  const lutTextureLocation = gl.getUniformLocation(program, "u_lut");
  const scaleLocation = gl.getUniformLocation(program, "u_scale");
  const paletteStopCountLocation = gl.getUniformLocation(program, "u_palette_stop_count");
  if (
    positionLocation < 0
    || !rectLocation
    || !canvasSizeLocation
    || !transposeLocation
    || !tileTextureLocation
    || !lutTextureLocation
    || !scaleLocation
    || !paletteStopCountLocation
  ) {
    gl.deleteTexture(lutTexture);
    gl.deleteBuffer(quadBuffer);
    gl.deleteProgram(program);
    return null;
  }

  return {
    program,
    quadBuffer,
    lutTexture,
    positionLocation,
    rectLocation,
    canvasSizeLocation,
    transposeLocation,
    tileTextureLocation,
    lutTextureLocation,
    scaleLocation,
    paletteStopCountLocation,
  };
}

function createVirtualTextureRendererResources(
  gl: WebGL2RenderingContext,
): VirtualTextureRendererResources | null {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, virtualTextureVertexShaderSource);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, virtualTextureFragmentShaderSource);
  if (!vertexShader || !fragmentShader) {
    if (vertexShader) gl.deleteShader(vertexShader);
    if (fragmentShader) gl.deleteShader(fragmentShader);
    return null;
  }
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    return null;
  }
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }

  const positionLocation = gl.getAttribLocation(program, "a_position");
  const tileArrayLocation = gl.getUniformLocation(program, "u_tile_array");
  const pageTableLocation = gl.getUniformLocation(program, "u_page_table");
  const lutTextureLocation = gl.getUniformLocation(program, "u_lut");
  const overviewTextureLocation = gl.getUniformLocation(program, "u_overview");
  const cameraTilesLocation = gl.getUniformLocation(program, "u_camera_tiles");
  const cameraPageLocation = gl.getUniformLocation(program, "u_camera_page");
  const pageOriginLocation = gl.getUniformLocation(program, "u_page_origin");
  const pageSizeLocation = gl.getUniformLocation(program, "u_page_size");
  const overviewUvRectLocation = gl.getUniformLocation(program, "u_overview_uv_rect");
  const hasOverviewLocation = gl.getUniformLocation(program, "u_has_overview");
  const scaleLocation = gl.getUniformLocation(program, "u_scale");
  const overviewScaleLocation = gl.getUniformLocation(program, "u_overview_scale");
  const paletteStopCountLocation = gl.getUniformLocation(program, "u_palette_stop_count");
  const hasSourceLayoutLocation = gl.getUniformLocation(program, "u_has_source_layout");
  const layoutXAddressLocation = gl.getUniformLocation(program, "u_layout_x_address");
  const layoutYAddressLocation = gl.getUniformLocation(program, "u_layout_y_address");
  const layoutXWeightLocation = gl.getUniformLocation(program, "u_layout_x_weight");
  const layoutYWeightLocation = gl.getUniformLocation(program, "u_layout_y_weight");
  const layoutSizesLocation = gl.getUniformLocation(program, "u_layout_sizes");
  const layoutCameraLocation = gl.getUniformLocation(program, "u_layout_camera");
  if (
    positionLocation < 0
    || !tileArrayLocation
    || !pageTableLocation
    || !lutTextureLocation
    || !overviewTextureLocation
    || !cameraTilesLocation
    || !cameraPageLocation
    || !pageOriginLocation
    || !pageSizeLocation
    || !overviewUvRectLocation
    || !hasOverviewLocation
    || !scaleLocation
    || !overviewScaleLocation
    || !paletteStopCountLocation
    || !hasSourceLayoutLocation
    || !layoutXAddressLocation
    || !layoutYAddressLocation
    || !layoutXWeightLocation
    || !layoutYWeightLocation
    || !layoutSizesLocation
    || !layoutCameraLocation
  ) {
    gl.deleteProgram(program);
    return null;
  }
  return {
    program,
    positionLocation,
    tileArrayLocation,
    pageTableLocation,
    lutTextureLocation,
    overviewTextureLocation,
    cameraTilesLocation,
    cameraPageLocation,
    pageOriginLocation,
    pageSizeLocation,
    overviewUvRectLocation,
    hasOverviewLocation,
    scaleLocation,
    overviewScaleLocation,
    paletteStopCountLocation,
    hasSourceLayoutLocation,
    layoutXAddressLocation,
    layoutYAddressLocation,
    layoutXWeightLocation,
    layoutYWeightLocation,
    layoutSizesLocation,
    layoutCameraLocation,
  };
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) {
    return null;
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn("C-Studio WebGL shader compilation failed", gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function ensureTileTexture(
  gl: WebGL2RenderingContext,
  cache: Map<string, GpuTextureEntry>,
  key: string,
  tile: ContactMapTile,
  generation: number | undefined,
  tileSizeBins: number,
  lastUsed: number,
  uploadContext: ContactTileGpuUploadContext,
): GpuTextureEntry | null {
  // Tile textures exclusively occupy unit 0. Without this reset the first
  // upload can replace the LUT bound to unit 1, producing black texelFetch
  // results when the shader addresses the 4x4/256x256 tile as a 256x1 LUT.
  gl.activeTexture(gl.TEXTURE0);
  const cached = cache.get(key);
  if (cached?.tile === tile) {
    cached.panPrefetchSnapshot = false;
    cached.lastUsed = lastUsed;
    return cached;
  }
  if (
    cached
    && generation !== undefined
    && cached.generation === generation
    && (cached.deltaBuffer || cached.panPrefetchSnapshot)
  ) {
    cached.tile = tile;
    cached.deltaBuffer = undefined;
    cached.panPrefetchSnapshot = false;
    cached.lastUsed = lastUsed;
    return cached;
  }
  if (cached) {
    gl.deleteTexture(cached.texture);
    cache.delete(key);
  }

  const texture = gl.createTexture();
  if (!texture) {
    return null;
  }
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const values = contactTileGpuTextureData(tile, tileSizeBins);
  const uploaded = uploadContactTileGpuTextureImage(
    gl,
    tileSizeBins,
    tileSizeBins,
    values,
    uploadContext,
  );
  if (!uploaded) {
    gl.deleteTexture(texture);
    return null;
  }
  const entry = {
    texture,
    format: uploaded.format,
    tile,
    generation,
    bytes: uploaded.bytes,
    lastUsed,
  };
  cache.set(key, entry);
  return entry;
}

function updateTileTexture(
  gl: WebGL2RenderingContext,
  entry: GpuTextureEntry,
  tile: ContactMapTile,
  generation: number,
  tileSizeBins: number,
  lastUsed: number,
  uploadContext: ContactTileGpuUploadContext,
) {
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, entry.texture);
  const values = contactTileGpuTextureData(tile, tileSizeBins);
  if (!updateContactTileGpuTextureImage(
    gl,
    entry,
    tileSizeBins,
    tileSizeBins,
    values,
    uploadContext,
  )) {
    return false;
  }
  entry.tile = tile;
  entry.deltaBuffer = undefined;
  entry.panPrefetchSnapshot = true;
  entry.generation = generation;
  entry.lastUsed = lastUsed;
  return true;
}

function ensureDeltaTileTexture(
  gl: WebGL2RenderingContext,
  cache: Map<string, GpuTextureEntry>,
  key: string,
  buffer: ContactTileDenseDeltaBuffer,
  generation: number,
  tileSizeBins: number,
  lastUsed: number,
  scratch: Float32Array,
  uploadContext: ContactTileGpuUploadContext,
): GpuTextureEntry | null {
  gl.activeTexture(gl.TEXTURE0);
  const cached = cache.get(key);
  if (
    cached?.generation === generation
    && cached.deltaBuffer === buffer
  ) {
    cached.lastUsed = lastUsed;
    return cached;
  }
  if (cached) {
    gl.deleteTexture(cached.texture);
    cache.delete(key);
  }
  const texture = gl.createTexture();
  if (!texture) {
    return null;
  }
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const values = contactTileDenseGpuTextureData(buffer, tileSizeBins, scratch);
  const uploaded = uploadContactTileGpuTextureImage(
    gl,
    tileSizeBins,
    tileSizeBins,
    values,
    uploadContext,
  );
  if (!uploaded) {
    gl.deleteTexture(texture);
    return null;
  }
  const entry: GpuTextureEntry = {
    texture,
    format: uploaded.format,
    tile: null,
    deltaBuffer: buffer,
    generation,
    bytes: uploaded.bytes,
    lastUsed,
  };
  cache.set(key, entry);
  return entry;
}

function updateDeltaTileTexture(
  gl: WebGL2RenderingContext,
  entry: GpuTextureEntry,
  buffer: ContactTileDenseDeltaBuffer,
  tileSizeBins: number,
  scratch: Float32Array,
  uploadContext: ContactTileGpuUploadContext,
) {
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, entry.texture);
  const values = contactTileDenseGpuTextureData(buffer, tileSizeBins, scratch);
  return updateContactTileGpuTextureImage(
    gl,
    entry,
    tileSizeBins,
    tileSizeBins,
    values,
    uploadContext,
  );
}

function updateLutTexture(
  gl: WebGL2RenderingContext,
  texture: WebGLTexture,
  renderStyle: ContactTileRenderStyle,
  previousColormap: ContactTileRenderStyle["colormap"] | null,
) {
  if (previousColormap === renderStyle.colormap) {
    return;
  }
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA8,
    256,
    1,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    contactColorLut(renderStyle.colormap, 0.88),
  );
}

function resizeCanvasToDisplaySize(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) {
  const pixelRatio = typeof window === "undefined"
    ? 1
    : Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const width = Math.max(1, Math.round((canvas.clientWidth || 1) * pixelRatio));
  const height = Math.max(1, Math.round((canvas.clientHeight || 1) * pixelRatio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    gl.viewport(0, 0, width, height);
  }
}

function ensureFramePresentationResources(
  gl: WebGL2RenderingContext,
  current: FramePresentationResources | null,
  width: number,
  height: number,
): FramePresentationResources | null {
  if (current?.width === width && current.height === height) {
    return current;
  }
  if (current) {
    gl.deleteFramebuffer(current.framebuffer);
    gl.deleteTexture(current.texture);
  }

  const texture = gl.createTexture();
  const framebuffer = gl.createFramebuffer();
  if (!texture || !framebuffer) {
    if (texture) gl.deleteTexture(texture);
    if (framebuffer) gl.deleteFramebuffer(framebuffer);
    return null;
  }
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA8,
    width,
    height,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    null,
  );
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    texture,
    0,
  );
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
    return null;
  }
  return { framebuffer, texture, width, height };
}

function presentFramePresentation(
  gl: WebGL2RenderingContext,
  frame: FramePresentationResources,
  width: number,
  height: number,
) {
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, frame.framebuffer);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  gl.blitFramebuffer(
    0,
    0,
    frame.width,
    frame.height,
    0,
    0,
    width,
    height,
    gl.COLOR_BUFFER_BIT,
    gl.NEAREST,
  );
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

function sameContactTileGpuOverview(
  left: ContactTileGpuOverview | null,
  right: ContactTileGpuOverview | null,
) {
  return left === right || Boolean(
    left
    && right
    && left.values === right.values
    && left.width === right.width
    && left.height === right.height,
  );
}

function sameContactTileGpuViewport(left: ContactViewport, right: ContactViewport) {
  return left.xStart === right.xStart
    && left.xEnd === right.xEnd
    && left.yStart === right.yStart
    && left.yEnd === right.yEnd;
}

function sameContactTileGpuScene(left: ContactTileGpuScene, right: ContactTileGpuScene) {
  const sameSourceLayout = left.sourceLayout === right.sourceLayout || Boolean(
    left.sourceLayout
    && right.sourceLayout
    && left.sourceLayout.dataScope === right.sourceLayout.dataScope
    && left.sourceLayout.generation === right.sourceLayout.generation
    && left.sourceLayout.xMap === right.sourceLayout.xMap
    && left.sourceLayout.yMap === right.sourceLayout.yMap
    && left.sourceLayout.descriptors.length === right.sourceLayout.descriptors.length
    && left.sourceLayout.descriptors.every((descriptor, index) => {
      const candidate = right.sourceLayout!.descriptors[index];
      return candidate?.key === descriptor.key
        && candidate.transpose === descriptor.transpose
        && candidate.tile === descriptor.tile;
    })
  );
  if (
    left.generation !== right.generation
    || left.dataScope !== right.dataScope
    || left.resolution !== right.resolution
    || left.tileSizeBins !== right.tileSizeBins
    || left.visibleLayerComplete !== right.visibleLayerComplete
    || !sameContactTileGpuOverview(left.overview ?? null, right.overview ?? null)
    || left.viewport.xStart !== right.viewport.xStart
    || left.viewport.xEnd !== right.viewport.xEnd
    || left.viewport.yStart !== right.viewport.yStart
    || left.viewport.yEnd !== right.viewport.yEnd
    || left.renderStyle.colormap !== right.renderStyle.colormap
    || left.renderStyle.colorScale.log !== right.renderStyle.colorScale.log
    || left.renderStyle.colorScale.min !== right.renderStyle.colorScale.min
    || left.renderStyle.colorScale.max !== right.renderStyle.colorScale.max
    || left.boundaries !== right.boundaries
    || !sameSourceLayout
    || left.descriptors.length !== right.descriptors.length
  ) {
    return false;
  }
  return left.descriptors.every((descriptor, index) => {
    const candidate = right.descriptors[index];
    return candidate?.key === descriptor.key
      && candidate.transpose === descriptor.transpose
      && candidate.tile === descriptor.tile;
  });
}

function gpuTextureKey(
  scene: Pick<ContactTileGpuScene, "dataScope" | "resolution" | "tileSizeBins">,
  tile: Pick<ContactMapTile, "tileX" | "tileY">,
) {
  return `${scene.dataScope ?? ""}:${scene.resolution}:${scene.tileSizeBins}:${tile.tileX}:${tile.tileY}`;
}

function cachedTextureBytes(cache: Map<string, GpuTextureEntry>) {
  let bytes = 0;
  for (const entry of cache.values()) {
    bytes += entry.bytes;
  }
  return bytes;
}

function evictLeastRecentlyUsedTextures(
  gl: WebGL2RenderingContext,
  cache: Map<string, GpuTextureEntry>,
  currentBytes: number,
  budgetBytes: number,
  protectedKeys: ReadonlySet<string>,
) {
  const candidates = [...cache.entries()]
    .filter(([key]) => !protectedKeys.has(key))
    .sort(([, left], [, right]) => left.lastUsed - right.lastUsed);
  let bytes = currentBytes;
  let count = 0;
  let evictedBytes = 0;
  for (const [key, entry] of candidates) {
    if (bytes <= budgetBytes) {
      break;
    }
    gl.deleteTexture(entry.texture);
    cache.delete(key);
    bytes -= entry.bytes;
    count += 1;
    evictedBytes += entry.bytes;
  }
  return { bytes, count, evictedBytes };
}

function paletteStopCount(colormap: ContactTileRenderStyle["colormap"]) {
  if (colormap === "Reds") return 0;
  if (colormap === "Turbo") return 5;
  return 4;
}
