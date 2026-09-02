import { Channel, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { message, open, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AppShell } from "./components/AppShell";
import { exportAgpText } from "./state/agpExport";
import {
  agpAutoSaveDelayMs,
  agpSavePlan,
  shouldScheduleAgpAutoSave,
} from "./state/agpAutoSave";
import {
  shouldContinueClosing,
  shouldPromptForUnsavedClose,
  unsavedCloseButtons,
  unsavedCloseDecision,
  windowCloseRequestAction,
} from "./state/windowCloseGuard";
import {
  contactAutoColorScaleKey,
  contactCountSampleForColorScale,
  estimateContactColorScale,
  type ContactColorScale,
} from "./state/contactColorScale";
import {
  decodeContactTileBinaryV1,
  type PackedContactTileCells,
} from "./state/contactTileBinary";
import {
  contactTileCellCount,
  contactTileRetainedValueBytes,
} from "./state/contactTileData";
import {
  ContactTileDeltaAccumulator,
  mergeCompleteContactTilesIntoDeltaAccumulator,
  type ContactTileDeltaPreviewBatch,
  type ContactTileDeltaRenderStream,
} from "./state/contactTileDelta";
import {
  buildContactLayoutReplacementPreview,
  displayContactMapForPendingLayer,
  contactTileDeltaStreamMode,
  shouldHoldPreviousContactMapFrame,
  shouldPublishContactMapLayer,
  shouldRetainPreviousContactMapFrame,
} from "./state/contactMapView";
import {
  contactViewportPreviewIsPan,
  contactViewportPreviewIsReplacement,
  createContactPanPerformanceTracker,
  type ContactPanPreview,
} from "./state/contactPanPerformance";
import {
  ContactPanPrefetchBridge,
  ContactPanPrefetchPriorityQueue,
  contactSpatialPrefetchBatchSize,
  formatContactPanPrefetchPerformanceLog,
  formatContactPanPrefetchPlanPerformanceLog,
  contactPanSettledGeneration,
  contactPanTileLoadPriority,
  type ContactPanPrefetchPerformanceRecord,
} from "./state/contactPanPrefetch";
import {
  closestContactResolution,
  contactResolutionToBasePairs,
} from "./state/contactResolution";
import { buildCenteredContactViewport } from "./state/contactViewport";
import {
  buildBrowserCoverageView,
  buildCoverageViewRequest,
  parseBedGraphText,
  type BedGraphRecord,
  type CoverageView,
} from "./state/coverageView";
import {
  createContactTileCacheKeyResolver,
  contactTileDataScope,
  contactTileScope,
  contactTileKey,
  contactTileSizeBins,
  contactTilesForViewport,
  contactTilesWithPanPrefetch,
  contactTileViewportRequestKey,
} from "./state/contactTiles";
import {
  contactTileViewportHistoryKeys,
  contactTileRenderCache,
  ContactTileResolutionLru,
  retainContactTileViewportFootprint,
  type ContactTileViewportResidencyHistory,
} from "./state/contactTileLru";
import {
  contactLayoutRegistrationBlocks,
  ContactLayoutHandleRegistry,
} from "./state/contactLayoutHandle";
import { ContactTileFlightRegistry } from "./state/contactTileRequests";
import {
  createContactTilePerformanceTracker,
  isContactTilePerformanceEnabled,
  nextContactResolutionForPerformance,
  type ContactTileRenderMilestone,
} from "./state/contactTilePerformance";
import { logContactMemoryCheckpoint } from "./state/contactMemoryCheckpoints";
import { createContactResolutionResponsivenessTracker } from "./state/contactResolutionResponsiveness";
import {
  adjacentContactResolutions,
  interleaveContactPrefetchBatches,
  scheduleContactIdleTask,
} from "./state/contactResolutionPrefetch";
import { contactNormalizationPrewarmResolutions } from "./state/contactNormalizationPrewarm";
import {
  buildContactOverviewTilePlan,
  contactNavigationOverviewFromCoveringMap,
  contactNavigationOverviewNormalization,
  retainContactOverviewRequestId,
  shouldResumeContactBackgroundSchedulingAfterFailure,
} from "./state/contactOverviewTiles";
import {
  buildContactMainLodPlan,
  buildContactMainLodWholeResidencyPlan,
  combineContactMainLodVisibleBatches,
  contactMainLodPlanChangesSampling,
  contactMainLodPrefetchBatchSize,
  contactMainLodTileCacheLimits,
  contactMainLodTileSizeBins,
  contactMainLodVisibleBatchSize,
  maxAdaptiveMcoolExactTiles,
  maxContactMainLodPrefetchTiles,
  maxExactMainContactTiles,
} from "./state/contactMainLod";
import {
  buildContactTileLoadPlan,
  buildContactTileWorld,
  projectContactTileWorldView,
} from "./state/contactTileWorld";
import {
  normalizeImportedAgpLayout,
  parseAgpLayout,
  type AgpLayout,
  type ContactMapLayoutBlock,
  summarizeAgpText,
} from "./state/importers";
import {
  applyPlacementRecommendation,
  type PlacementRecommendation,
} from "./state/assemblyPlacementRecommendation";
import {
  resolveContactLayoutSources,
  type ContactSourceMetadata,
} from "./state/contactSourceResolution";
import {
  buildContactGpuLayoutMap,
  buildContactSourceAddressSpace,
  contactGpuLayoutMapIsExact,
  contactGpuSourceTilePlan,
  contactSourceIdentityLayout,
  type ContactGpuLayoutMap,
} from "./state/contactSourceLayout";
import {
  operationHistoryFilename,
  parseOperationHistory,
  serializeOperationHistory,
  type OperationHistoryArchive,
} from "./state/operationHistoryPersistence";
import { parseGfaText, type GfaEvidenceDocument } from "./state/gfa";
import type {
  GfaBandageLayoutLoader,
  GfaBandageLayoutResponse,
} from "./state/gfaBandageLayout";
import {
  planGfaEndpointHiCQuery,
  scoreGfaEndpointHiC,
  type GfaEndpointHiCBatchLoader,
  type GfaEndpointHiCLoadResult,
  type GfaEndpointHiCLoader,
  type GfaEndpointHiCQueryPlan,
} from "./state/gfaEndpointHiC";
import {
  planHiCAlleleConcordanceQuery,
  scoreHiCAlleleConcordanceQuery,
  type HiCAlleleConcordanceBatchLoader,
  type HiCAlleleConcordanceLoadResult,
  type HiCAlleleConcordanceQueryPlan,
} from "./state/hicAlleleConcordance";
import { classifyGfaScaffolds, defaultGfaHomologPattern } from "./state/gfaHomologLayout";
import {
  buildChromosomeViewLayout,
  placeHiddenChromosomeBlocksAfter,
  resolveChromosomeVisibility,
} from "./state/chromosomeVisibility";
import {
  buildPafSyntenyPreview,
  summarizePafPreview,
  type PafPreviewRecord,
  type PreparedPafFile,
} from "./state/pafPreview";
import {
  buildBrowserSyntenyView,
  buildSyntenyViewRequest,
  buildSyntenyViewport,
  type SyntenyView,
} from "./state/syntenyView";
import {
  contactNormalizationForBackend,
  availableContactResolutions,
  availableContactResolutionsForDataset,
  createInitialUiState,
  reduceUiState,
  storedContactResolutionsForDataset,
  type ContactNormalization,
  type ContactResolution,
  type UiAction,
} from "./state/uiState";

export interface AppStatus {
  version: string;
  engine: string;
  coordinate_convention: string;
  supported_operations: string[];
}

export interface ExampleDatasetSummary {
  agp_path: string;
  mcool_path: string;
  paf_path: string | null;
  agp_lines: number;
  agp_objects: number;
  agp_components: number;
  agp_gaps: number;
  max_object_span: number;
  mcool_size_bytes: number;
  coverage_path: string | null;
  agp_layout: AgpLayout;
  cool_path: string;
  available_resolutions?: number[];
  contact_sources?: ContactSourceMetadata[];
}

export interface ContactMapCell {
  xBin: number;
  yBin: number;
  count: number;
}

export interface ContactMapView {
  resolution: number;
  /** User-selected mcool level fulfilled by this frame; LOD may be coarser. */
  requestedResolution?: number;
  /** Normalization of the pixels currently displayed, not merely selected. */
  normalization?: ContactNormalization;
  viewport: {
    xStart: number;
    xEnd: number;
    yStart: number;
    yEnd: number;
  };
  cells: ContactMapCell[];
  tileSizeBins?: number;
  tiles?: ContactMapTile[];
  cachedTiles?: ContactMapTile[];
  /** Display-only reprojected tiles; authoritative tiles override by coordinate. */
  previewTiles?: ContactMapTile[];
  /** True only for a display layer that must still be replaced before completion. */
  isTransientResolutionPreview?: boolean;
  /** Layout snapshot used to produce this visual layer. */
  layoutBlocks?: ContactMapLayoutBlock[];
  layoutScope?: string;
  /** True only when every tile intersecting the visible viewport is present. */
  visibleLayerComplete?: boolean;
  /** Frontend-only identifier used to reject stale render timing callbacks. */
  renderGeneration?: number;
  /** Immutable source-space tiles and exact visual-to-source shader maps. */
  sourceLayout?: ContactGpuSourceLayoutView;
}

export interface ContactGpuSourceLayoutView {
  resolution: number;
  tileSizeBins: number;
  viewport: ContactMapView["viewport"];
  xMap: ContactGpuLayoutMap;
  yMap: ContactGpuLayoutMap;
  sourceTiles: readonly number[];
  tiles: readonly ContactMapTile[];
  dataScope: string;
  generation: number;
}

export interface ContactMapTile {
  tileX: number;
  tileY: number;
  cells: ContactMapCell[];
  /** Compact backend payload. Coordinates are local to this tile. */
  packedCells?: PackedContactTileCells;
  /** Completed display-cache tile. `-1` marks an empty pixel. */
  denseValues?: Float32Array;
  /** GPU-ready completed display-cache tile. IEEE binary16 `0xbc00` is empty. */
  denseR16fValues?: Uint16Array;
  denseOccupiedCount?: number;
}

export interface ContactMapTileKey {
  tileX: number;
  tileY: number;
}

interface ImportedContactFile {
  path: string;
  name: string;
  size_bytes: number;
  available_resolutions?: number[];
  sources?: ContactSourceMetadata[];
}

interface ImportedProjectTextFile {
  path: string;
  name: string;
  text: string;
}

interface ImportedProjectFile {
  path: string;
  name: string;
  size_bytes: number;
}

interface ImportedProjectDirectory {
  directory: string;
  agp: ImportedProjectFile | null;
  history: ImportedProjectFile | null;
  gfa: ImportedProjectFile | null;
  paf: ImportedProjectFile | null;
  coverage: ImportedProjectFile | null;
  contact: ImportedProjectFile | null;
  ignoredCandidates: string[];
}

interface ImportedAgpBundle {
  agp: ImportedProjectTextFile;
  history: ImportedProjectTextFile | null;
}

interface SourceAgpSnapshot {
  path: string;
  layout: AgpLayout;
  canonicalText: string;
}

interface PendingResolutionPerformance {
  startedAt: number;
  fromResolution: ContactResolution;
  toResolution: ContactResolution;
}

interface ContactTilePresentationSchedule extends ContactTileRenderMilestone {
  firstFrame: number | null;
  secondFrame: number | null;
}

type ContactTileRequestPurpose =
  | "visible"
  | "spatial_prefetch"
  | "adjacent_prefetch"
  | "overview"
  | "endpoint_evidence";

interface ContactTileHandleRequest {
  requestId: number;
  generation: number;
  purpose: ContactTileRequestPurpose;
  coolPath: string;
  baseResolution: number;
  /** Stored Cooler level to read before aggregating into targetResolution. */
  sourceResolution?: number;
  targetResolution: number;
  tileSizeBins: number;
  normalization: ContactNormalization;
  tiles: ContactMapTileKey[];
  adaptiveRefinement?: boolean;
}

interface ContactTileFrontendIpcPerformanceRequest {
  requestId: number;
  generation: number;
  purpose: ContactTileRequestPurpose;
  attempt: number;
  targetResolution: number;
  requestedTiles: number;
  returnedTiles: number;
  responseCells: number;
  responseBytes: number;
  invokeUs: number;
  decodeUs: number;
  transport: "array_buffer" | "json" | "unknown";
  status: "ok" | "error";
}

interface ContactMapOverviewResponse {
  sourceResolution: number;
  resolution: number;
  viewport: ContactMapView["viewport"];
  cells: ContactMapCell[];
}

interface PrewarmContactNormalizationsResponse {
  pixelsPrepared: boolean;
  prepared: number;
  failed: number;
  cancelled: boolean;
}

interface PrewarmContactResolutionReaderResponse {
  compactFixed: boolean;
  binCount: number;
  indexBytes: number;
  cancelled: boolean;
}

interface ContactPanPrefetchPlan {
  adaptiveRefinement: boolean;
  baseResolution: number;
  prefetchViewport: ContactMapView["viewport"];
  sourceResolution?: number;
  targetResolution: number;
  tileSizeBins: number;
  tiles: ContactMapTileKey[];
  leadTiles: ContactMapTileKey[];
  visibleTiles: ContactMapTileKey[];
  usesMainLod: boolean;
}

const browserFallbackStatus: AppStatus = {
  version: "browser-preview",
  engine: "cstudio-core",
  coordinate_convention: "0-based half-open internal; 1-based closed AGP",
  supported_operations: ["split", "move", "flip", "copy", "insert_gap", "delete_gap"],
};
const emptyLayout: AgpLayout = { blocks: [], totalSpan: 0 };
const maxBackgroundPrefetchTiles = 16;
const visibleContactTileRequestBatchSize = 8;
const panVisibleContactTileRequestBatchSize = 2;
// Drag prefetch still requests one tile per backend flight, but the priority
// scheduler may run four visible flights or two background flights at once.
const contactPanPrefetchConcurrency = 4;
const contactPanBackgroundPrefetchConcurrency = 2;
const contactViewportRequestDelayMs = 24;
const secondaryTrackRequestDelayMs = 180;
const idleAdjacentContactTileBatchSize = 2;
const contactPanSidePrefetchLayers = 1;
// Neighbor warming is latency insurance, not a second full render. At two
// tiles per batch this permits at most eight background tiles after a stable
// foreground frame, split round-robin across the coarser and finer levels.
const maxAdjacentResolutionPrefetchBatches = 4;
const maxContactSourceTileCacheTiles = 192;
const contactTileRequestCancelledMessage = "contact tile request cancelled";
const autoSavePreferenceKey = "c-studio:auto-save-agp";
const contactTileIpcPerformanceEnabled = (
  import.meta.env.CSTUDIO_PERF_LOG === "1"
  || isContactTilePerformanceEnabled()
);
const contactTileBinaryEnabled = import.meta.env.VITE_CSTUDIO_TILE_BINARY !== "0";
const contactTileStreamEnabled = import.meta.env.VITE_CSTUDIO_TILE_STREAM !== "0";
const contactTileSingleScanEnabled = import.meta.env.VITE_CSTUDIO_TILE_SINGLE_SCAN !== "0";
const contactTileDirectDeltaEnabled = import.meta.env.VITE_CSTUDIO_TILE_DIRECT_DELTA !== "0";
const contactMainLodEnabled = import.meta.env.VITE_CSTUDIO_MAIN_LOD !== "0";
// Default to the bounded one-shot dense response for the main visible LOD.
// Set to 0 only for an explicit Channel-versus-direct A/B replay.
const contactMainLodOneShotEnabled = import.meta.env.VITE_CSTUDIO_MAIN_LOD_ONE_SHOT !== "0";
const contactOverviewEnabled = import.meta.env.VITE_CSTUDIO_CONTACT_OVERVIEW !== "0";
const contactOverviewRenderEnabled = (
  import.meta.env.VITE_CSTUDIO_CONTACT_OVERVIEW_RENDER !== "0"
);

function yieldToProjectLoadPaint() {
  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

function emitContactFrontendPerformanceLine(line: string) {
  if (!contactTileIpcPerformanceEnabled) {
    return;
  }
  console.info(line);
  void invoke("log_contact_frontend_performance", { line }).catch(() => undefined);
}

function emitContactPanPrefetchPerformance(
  record: ContactPanPrefetchPerformanceRecord,
) {
  emitContactFrontendPerformanceLine(formatContactPanPrefetchPerformanceLog(record));
}

export function buildContactPanPrefetchPlan({
  availableResolutions,
  coolPath,
  normalization,
  selectedResolution,
  totalSpanBp,
  viewport,
  velocityPrefetchViewport,
  viewportHeightPx,
  viewportWidthPx,
}: {
  availableResolutions: readonly number[];
  coolPath: string;
  normalization: ContactNormalization;
  selectedResolution: number;
  totalSpanBp: number;
  viewport: ContactMapView["viewport"];
  velocityPrefetchViewport?: ContactMapView["viewport"];
  viewportHeightPx: number;
  viewportWidthPx: number;
}): ContactPanPrefetchPlan {
  const exactTiles = contactTilesForViewport(
    viewport,
    selectedResolution,
    contactTileSizeBins,
    totalSpanBp,
  );
  const adaptiveMcoolPolicy = normalization === "raw"
    && selectedResolution === 2_500_000
    && coolPath.toLowerCase().endsWith(".mcool");
  const candidateMainLodPlan = contactMainLodEnabled || adaptiveMcoolPolicy
    ? buildContactMainLodPlan({
        viewport,
        selectedResolution,
        viewportWidthPx,
        viewportHeightPx,
        visibleTileCount: exactTiles.length,
        exactTileLimit: adaptiveMcoolPolicy
          ? maxAdaptiveMcoolExactTiles
          : maxExactMainContactTiles,
      }, availableResolutions)
    : null;
  // A tile-count boundary can move by a few tiles when the camera crosses a
  // 256-bin edge. If the resulting LOD plan samples the exact same stored and
  // displayed resolution, switching pipelines only abandons the warm exact
  // cache and starts a duplicate cold load. Keep the adaptive 2.5 Mb safety
  // policy, but otherwise stay on the ordinary tile pipeline until LOD
  // actually changes the sampling resolution.
  const mainLodPlan = candidateMainLodPlan
    && (
      adaptiveMcoolPolicy
      || contactMainLodPlanChangesSampling(candidateMainLodPlan, selectedResolution)
    )
    ? candidateMainLodPlan
    : null;
  const targetResolution = mainLodPlan?.targetResolution ?? selectedResolution;
  const tileSizeBins = mainLodPlan ? contactMainLodTileSizeBins : contactTileSizeBins;
  const visibleTiles = mainLodPlan
    ? contactTilesForViewport(viewport, targetResolution, tileSizeBins, totalSpanBp)
    : exactTiles;
  const requestedPrefetchViewport = velocityPrefetchViewport ?? viewport;
  const visibleTileKeys = new Set(visibleTiles.map(contactTileKey));
  const leadTiles = contactTilesForViewport(
    requestedPrefetchViewport,
    targetResolution,
    tileSizeBins,
    totalSpanBp,
  ).filter((tile) => !visibleTileKeys.has(contactTileKey(tile)));
  const tiles = contactTilesWithPanPrefetch(
    [...visibleTiles, ...leadTiles],
    contactPanSidePrefetchLayers,
    targetResolution,
    tileSizeBins,
    totalSpanBp,
  );
  const sourceResolution = mainLodPlan?.sourceResolution;
  const adaptiveRefinement = !mainLodPlan
    && adaptiveMcoolPolicy
    && visibleTiles.length <= maxAdaptiveMcoolExactTiles;
  const sidePaddingBp = contactPanSidePrefetchLayers
    * targetResolution
    * tileSizeBins;
  return {
    adaptiveRefinement,
    baseResolution: sourceResolution ?? 1_000,
    prefetchViewport: {
      xStart: Math.max(
        0,
        Math.min(viewport.xStart, requestedPrefetchViewport.xStart) - sidePaddingBp,
      ),
      xEnd: Math.min(
        totalSpanBp,
        Math.max(viewport.xEnd, requestedPrefetchViewport.xEnd) + sidePaddingBp,
      ),
      yStart: Math.max(
        0,
        Math.min(viewport.yStart, requestedPrefetchViewport.yStart) - sidePaddingBp,
      ),
      yEnd: Math.min(
        totalSpanBp,
        Math.max(viewport.yEnd, requestedPrefetchViewport.yEnd) + sidePaddingBp,
      ),
    },
    sourceResolution,
    targetResolution,
    tileSizeBins,
    tiles,
    leadTiles,
    visibleTiles,
    usesMainLod: mainLodPlan !== null,
  };
}

const loadGfaBandageLayout: GfaBandageLayoutLoader = (request) => (
  invoke<GfaBandageLayoutResponse>("layout_gfa_bandage", { request })
);

async function readImportedTextFile(file: File): Promise<string> {
  if (!file.name.toLowerCase().endsWith(".gz")) return file.text();
  if (typeof DecompressionStream === "undefined") {
    throw new Error("gzip decompression is unavailable in this browser runtime");
  }
  return new Response(file.stream().pipeThrough(new DecompressionStream("gzip"))).text();
}

function isContactTileRequestCancelled(error: unknown): boolean {
  return String(error).toLowerCase().includes(contactTileRequestCancelledMessage);
}

function cancelContactTilePresentationSchedule(
  schedule: ContactTilePresentationSchedule | null,
) {
  if (schedule?.firstFrame !== null && schedule?.firstFrame !== undefined) {
    window.cancelAnimationFrame(schedule.firstFrame);
  }
  if (schedule?.secondFrame !== null && schedule?.secondFrame !== undefined) {
    window.cancelAnimationFrame(schedule.secondFrame);
  }
}

function registerContactMapLayout(layoutBlocks: ContactMapLayoutBlock[]) {
  return invoke<string>("register_contact_map_layout", {
    request: {
      layoutBlocks: contactLayoutRegistrationBlocks(layoutBlocks),
    },
  });
}

function loadContactOverviewWithLayoutHandle(
  registry: ContactLayoutHandleRegistry,
  layoutBlocks: ContactMapLayoutBlock[],
  request: {
    requestId: number;
    generation: number;
    coolPath: string;
    sourceResolution: number;
    targetResolution: number;
    normalization: ContactNormalization;
    viewport: ContactMapView["viewport"];
  },
) {
  return registry.run(
    layoutBlocks,
    registerContactMapLayout,
    (layoutHandle) => invoke<ContactMapOverviewResponse>(
      "build_contact_map_overview_from_cool",
      { request: { ...request, layoutHandle } },
    ),
  );
}

function logContactTileFrontendIpcPerformance(
  request: ContactTileFrontendIpcPerformanceRequest,
) {
  if (!contactTileIpcPerformanceEnabled) {
    return;
  }
  void invoke("log_contact_tile_frontend_ipc", { request }).catch(() => undefined);
}

function contactMapTilesFromDecodedBinary(
  decoded: ReturnType<typeof decodeContactTileBinaryV1>,
): ContactMapTile[] {
  return [
    ...decoded.tiles,
    ...(decoded.denseTiles ?? []).map((tile) => ({
      tileX: tile.tileX,
      tileY: tile.tileY,
      cells: [] as [],
      ...(tile.format === "r16f"
        ? { denseR16fValues: tile.values }
        : { denseValues: tile.values }),
      denseOccupiedCount: tile.occupiedCount,
    })),
  ];
}

function loadContactTilesWithLayoutHandle(
  registry: ContactLayoutHandleRegistry,
  layoutBlocks: ContactMapLayoutBlock[],
  request: ContactTileHandleRequest,
) {
  let attempt = 0;
  return registry.run(
    layoutBlocks,
    registerContactMapLayout,
    async (layoutHandle) => {
      attempt += 1;
      const invokeRequest = {
        ...request,
        layoutHandle,
      };
      if (!contactTileBinaryEnabled) {
        if (!contactTileIpcPerformanceEnabled) {
          return invoke<ContactMapTile[]>("get_contact_map_tiles_from_cool", {
            request: invokeRequest,
          });
        }
        const startedAt = performance.now();
        try {
          const tiles = await invoke<ContactMapTile[]>("get_contact_map_tiles_from_cool", {
            request: invokeRequest,
          });
          const invokeUs = Math.round(Math.max(0, performance.now() - startedAt) * 1_000);
          logContactTileFrontendIpcPerformance({
            requestId: request.requestId,
            generation: request.generation,
            purpose: request.purpose,
            attempt,
            targetResolution: request.targetResolution,
            requestedTiles: request.tiles.length,
            returnedTiles: tiles.length,
            responseCells: tiles.reduce((total, tile) => total + contactTileCellCount(tile), 0),
            responseBytes: 0,
            invokeUs,
            decodeUs: 0,
            transport: "json",
            status: "ok",
          });
          return tiles;
        } catch (error) {
          const invokeUs = Math.round(Math.max(0, performance.now() - startedAt) * 1_000);
          logContactTileFrontendIpcPerformance({
            requestId: request.requestId,
            generation: request.generation,
            purpose: request.purpose,
            attempt,
            targetResolution: request.targetResolution,
            requestedTiles: request.tiles.length,
            returnedTiles: 0,
            responseCells: 0,
            responseBytes: 0,
            invokeUs,
            decodeUs: 0,
            transport: "json",
            status: "error",
          });
          throw error;
        }
      }
      if (!contactTileIpcPerformanceEnabled) {
        let rawResponse: unknown = null;
        try {
          rawResponse = await invoke<unknown>("get_contact_map_tiles_from_cool_binary_v1", {
            request: invokeRequest,
          });
          if (request.purpose === "visible") {
            logContactMemoryCheckpoint({
              stage: "ipc_received",
              generation: request.generation,
              requestId: request.requestId,
              targetResolution: request.targetResolution,
              payloadBytes: rawResponse instanceof ArrayBuffer ? rawResponse.byteLength : 0,
            });
          }
          const decoded = decodeContactTileBinaryV1(rawResponse);
          if (decoded.tileSizeBins !== request.tileSizeBins) {
            throw new Error(
              `contact tile binary size mismatch: expected ${request.tileSizeBins}, got ${decoded.tileSizeBins}`,
            );
          }
          if (request.purpose === "visible") {
            logContactMemoryCheckpoint({
              stage: "decode_complete",
              generation: request.generation,
              requestId: request.requestId,
              targetResolution: request.targetResolution,
              payloadBytes: decoded.byteLength,
              itemCount: decoded.tiles.length + (decoded.denseTiles?.length ?? 0),
            });
          }
          return contactMapTilesFromDecodedBinary(decoded);
        } finally {
          // Dense tile views own their small copied payloads. Drop the larger
          // transport buffer as soon as decoding completes.
          rawResponse = null;
        }
      }

      const startedAt = performance.now();
      let invokeUs = 0;
      let decodeUs = 0;
      let responseBytes = 0;
      let transport: ContactTileFrontendIpcPerformanceRequest["transport"] = "unknown";
      let rawResponse: unknown = null;
      try {
        rawResponse = await invoke<unknown>("get_contact_map_tiles_from_cool_binary_v1", {
          request: invokeRequest,
        });
        const responseAt = performance.now();
        invokeUs = Math.round(Math.max(0, responseAt - startedAt) * 1_000);
        if (rawResponse instanceof ArrayBuffer) {
          responseBytes = rawResponse.byteLength;
          transport = "array_buffer";
        }
        if (request.purpose === "visible") {
          logContactMemoryCheckpoint({
            stage: "ipc_received",
            generation: request.generation,
            requestId: request.requestId,
            targetResolution: request.targetResolution,
            payloadBytes: responseBytes,
            frontendTimestamp: responseAt,
          });
        }
        const decoded = decodeContactTileBinaryV1(rawResponse);
        decodeUs = Math.round(Math.max(0, performance.now() - responseAt) * 1_000);
        if (decoded.tileSizeBins !== request.tileSizeBins) {
          throw new Error(
            `contact tile binary size mismatch: expected ${request.tileSizeBins}, got ${decoded.tileSizeBins}`,
          );
        }
        if (request.purpose === "visible") {
          logContactMemoryCheckpoint({
            stage: "decode_complete",
            generation: request.generation,
            requestId: request.requestId,
            targetResolution: request.targetResolution,
            payloadBytes: decoded.byteLength,
            itemCount: decoded.tiles.length + (decoded.denseTiles?.length ?? 0),
          });
        }
        const tiles = contactMapTilesFromDecodedBinary(decoded);
        logContactTileFrontendIpcPerformance({
          requestId: request.requestId,
          generation: request.generation,
          purpose: request.purpose,
          attempt,
          targetResolution: request.targetResolution,
          requestedTiles: request.tiles.length,
          returnedTiles: tiles.length,
          responseCells: tiles.reduce((total, tile) => total + contactTileCellCount(tile), 0),
          responseBytes,
          invokeUs,
          decodeUs,
          transport,
          status: "ok",
        });
        return tiles;
      } catch (error) {
        if (invokeUs === 0) {
          invokeUs = Math.round(Math.max(0, performance.now() - startedAt) * 1_000);
        }
        logContactTileFrontendIpcPerformance({
          requestId: request.requestId,
          generation: request.generation,
          purpose: request.purpose,
          attempt,
          targetResolution: request.targetResolution,
          requestedTiles: request.tiles.length,
          returnedTiles: 0,
          responseCells: 0,
          responseBytes,
          invokeUs,
          decodeUs,
          transport,
          status: "error",
        });
        throw error;
      } finally {
        rawResponse = null;
      }
    },
  );
}

function streamContactTilesWithLayoutHandle(
  registry: ContactLayoutHandleRegistry,
  layoutBlocks: ContactMapLayoutBlock[],
  request: ContactTileHandleRequest,
  chunks: ContactMapTileKey[][],
  onChunk: (tiles: ContactMapTile[]) => void,
) {
  let attempt = 0;
  return registry.run(
    layoutBlocks,
    registerContactMapLayout,
    async (layoutHandle) => {
      attempt += 1;
      const invokeRequest = { ...request, layoutHandle };
      const expectedChunks = chunks.filter((chunk) => chunk.length > 0).length;
      if (expectedChunks === 0) {
        return [];
      }

      const streamedTiles: ContactMapTile[] = [];
      let responseBytes = 0;
      let decodeUs = 0;
      let receivedChunks = 0;
      let resolveAllChunks!: () => void;
      let rejectAllChunks!: (error: unknown) => void;
      const allChunks = new Promise<void>((resolve, reject) => {
        resolveAllChunks = resolve;
        rejectAllChunks = reject;
      });
      const channel = new Channel<unknown>();
      channel.onmessage = (rawResponse) => {
        try {
          const responseAt = performance.now();
          if (request.purpose === "visible") {
            logContactMemoryCheckpoint({
              stage: "ipc_received",
              generation: request.generation,
              requestId: request.requestId,
              targetResolution: request.targetResolution,
              payloadBytes: rawResponse instanceof ArrayBuffer ? rawResponse.byteLength : 0,
              frontendTimestamp: responseAt,
            });
          }
          const decoded = decodeContactTileBinaryV1(rawResponse);
          decodeUs += Math.round(Math.max(0, performance.now() - responseAt) * 1_000);
          if (decoded.tileSizeBins !== request.tileSizeBins) {
            throw new Error(
              `contact tile binary size mismatch: expected ${request.tileSizeBins}, got ${decoded.tileSizeBins}`,
            );
          }
          responseBytes += decoded.byteLength;
          streamedTiles.push(...decoded.tiles);
          receivedChunks += 1;
          onChunk(decoded.tiles);
          if (receivedChunks === expectedChunks) {
            resolveAllChunks();
          }
        } catch (error) {
          rejectAllChunks(error);
        }
      };

      const startedAt = performance.now();
      let invokeUs = 0;
      try {
        await Promise.all([
          invoke<void>("stream_contact_map_tiles_from_cool_binary_v1", {
            request: invokeRequest,
            chunks,
            onChunk: channel,
          }),
          allChunks,
        ]);
        invokeUs = Math.round(Math.max(0, performance.now() - startedAt) * 1_000);
        if (request.purpose === "visible") {
          logContactMemoryCheckpoint({
            stage: "decode_complete",
            generation: request.generation,
            requestId: request.requestId,
            targetResolution: request.targetResolution,
            payloadBytes: responseBytes,
            itemCount: streamedTiles.length,
          });
        }
        if (contactTileIpcPerformanceEnabled) {
          logContactTileFrontendIpcPerformance({
            requestId: request.requestId,
            generation: request.generation,
            purpose: request.purpose,
            attempt,
            targetResolution: request.targetResolution,
            requestedTiles: request.tiles.length,
            returnedTiles: streamedTiles.length,
            responseCells: streamedTiles.reduce(
              (total, tile) => total + contactTileCellCount(tile),
              0,
            ),
            responseBytes,
            invokeUs,
            decodeUs,
            transport: "array_buffer",
            status: "ok",
          });
        }
        return streamedTiles;
      } catch (error) {
        invokeUs = Math.round(Math.max(0, performance.now() - startedAt) * 1_000);
        if (contactTileIpcPerformanceEnabled) {
          logContactTileFrontendIpcPerformance({
            requestId: request.requestId,
            generation: request.generation,
            purpose: request.purpose,
            attempt,
            targetResolution: request.targetResolution,
            requestedTiles: request.tiles.length,
            returnedTiles: streamedTiles.length,
            responseCells: streamedTiles.reduce(
              (total, tile) => total + contactTileCellCount(tile),
              0,
            ),
            responseBytes,
            invokeUs,
            decodeUs,
            transport: "array_buffer",
            status: "error",
          });
        }
        throw error;
      } finally {
        // Break the application-level closure immediately. Tauri also removes
        // its internal callback after the terminal Channel marker.
        channel.onmessage = () => undefined;
      }
    },
  );
}

function streamContactTileDeltasWithLayoutHandle(
  registry: ContactLayoutHandleRegistry,
  layoutBlocks: ContactMapLayoutBlock[],
  request: ContactTileHandleRequest,
  callbacks: {
    onStart?: (accumulator: ContactTileDeltaAccumulator) => void;
    onDelta?: () => void;
    /**
     * Non-authoritative cumulative snapshot for the transient pan surface.
     * A snapshot received before the terminal sentinel must never enter the
     * reusable tile cache: cancellation can leave it permanently incomplete.
     */
    onPreviewChunk?: (batch: ContactTileDeltaPreviewBatch) => void;
  },
) {
  return registry.run(
    layoutBlocks,
    registerContactMapLayout,
    async (layoutHandle) => {
      const accumulator = new ContactTileDeltaAccumulator(
        request.tiles,
        request.tileSizeBins,
      );
      callbacks.onStart?.(accumulator);
      let responseBytes = 0;
      let decodeUs = 0;
      let resolveFinished!: () => void;
      let rejectFinished!: (error: unknown) => void;
      const finished = new Promise<void>((resolve, reject) => {
        resolveFinished = resolve;
        rejectFinished = reject;
      });
      const channel = new Channel<unknown>();
      channel.onmessage = (rawResponse) => {
        try {
          const responseAt = performance.now();
          if (request.purpose === "visible") {
            logContactMemoryCheckpoint({
              stage: "ipc_received",
              generation: request.generation,
              requestId: request.requestId,
              targetResolution: request.targetResolution,
              payloadBytes: rawResponse instanceof ArrayBuffer ? rawResponse.byteLength : 0,
              frontendTimestamp: responseAt,
            });
          }
          const decoded = decodeContactTileBinaryV1(rawResponse);
          decodeUs += Math.round(Math.max(0, performance.now() - responseAt) * 1_000);
          responseBytes += decoded.byteLength;
          if (decoded.tileSizeBins !== request.tileSizeBins) {
            throw new Error(
              `contact tile delta size mismatch: expected ${request.tileSizeBins}, got ${decoded.tileSizeBins}`,
            );
          }
          if (decoded.tiles.length === 0 && (decoded.denseTiles?.length ?? 0) === 0) {
            resolveFinished();
            return;
          }
          const changedTileKeys = [
            ...accumulator.merge(decoded.tiles),
            ...accumulator.mergeDenseComplete(decoded.denseTiles ?? []),
          ];
          if (changedTileKeys.length > 0) {
            callbacks.onDelta?.();
            if (callbacks.onPreviewChunk) {
              callbacks.onPreviewChunk(accumulator.previewBatch(changedTileKeys));
            }
          }
        } catch (error) {
          rejectFinished(error);
        }
      };

      const startedAt = performance.now();
      try {
        await Promise.all([
          invoke<void>("stream_contact_map_tile_deltas_from_cool_binary_v1", {
            request: { ...request, layoutHandle },
            onChunk: channel,
          }),
          finished,
        ]);
        const tiles = accumulator.finish();
        if (request.purpose === "visible") {
          logContactMemoryCheckpoint({
            stage: "decode_complete",
            generation: request.generation,
            requestId: request.requestId,
            targetResolution: request.targetResolution,
            payloadBytes: responseBytes,
            itemCount: tiles.length,
          });
        }
        if (contactTileIpcPerformanceEnabled) {
          logContactTileFrontendIpcPerformance({
            requestId: request.requestId,
            generation: request.generation,
            purpose: request.purpose,
            attempt: 1,
            targetResolution: request.targetResolution,
            requestedTiles: request.tiles.length,
            returnedTiles: tiles.length,
            responseCells: tiles.reduce(
              (total, tile) => total + contactTileCellCount(tile),
              0,
            ),
            responseBytes,
            invokeUs: Math.round(Math.max(0, performance.now() - startedAt) * 1_000),
            decodeUs,
            transport: "array_buffer",
            status: "ok",
          });
        }
        return tiles;
      } catch (error) {
        rejectFinished(error);
        throw error;
      } finally {
        channel.onmessage = () => undefined;
      }
    },
  );
}

export function App() {
  const [status, setStatus] = useState<AppStatus>(browserFallbackStatus);
  const [dataset, setDataset] = useState<ExampleDatasetSummary | null>(null);
  const [contactAvailableResolutions, setContactAvailableResolutions] = useState<number[]>([]);
  const [contactSources, setContactSources] = useState<ContactSourceMetadata[]>([]);
  const [contactMap, setContactMap] = useState<ContactMapView | null>(null);
  const [contactGpuSourceLayout, setContactGpuSourceLayout] = useState<
    ContactGpuSourceLayoutView | null
  >(null);
  const [contactTileDeltaStream, setContactTileDeltaStream] = useState<
    ContactTileDeltaRenderStream | null
  >(null);
  const [contactTilePreviewViewport, setContactTilePreviewViewport] = useState<
    ContactPanPreview | null
  >(null);
  const [placementPreview, setPlacementPreview] = useState<
    PlacementRecommendation | null
  >(null);
  const pendingPanPerformancePreviewRef = useRef<ContactPanPreview | null>(null);
  const contactPanPrefetchBridgeRef = useRef<ContactPanPrefetchBridge | null>(null);
  if (contactPanPrefetchBridgeRef.current === null) {
    contactPanPrefetchBridgeRef.current = new ContactPanPrefetchBridge();
  }
  const contactPanPrefetchBridge = contactPanPrefetchBridgeRef.current;
  const contactPanPrefetchQueueRef = useRef<ContactPanPrefetchPriorityQueue | null>(null);
  if (contactPanPrefetchQueueRef.current === null) {
    contactPanPrefetchQueueRef.current = new ContactPanPrefetchPriorityQueue({
      concurrency: contactPanPrefetchConcurrency,
      prefetchConcurrency: contactPanBackgroundPrefetchConcurrency,
    });
  }
  const contactPanPrefetchQueue = contactPanPrefetchQueueRef.current;
  const contactPanPrefetchProtectedKeysRef = useRef<{
    generation: number;
    keys: ReadonlySet<string>;
  } | null>(null);
  const [overviewContactMap, setOverviewContactMap] = useState<ContactMapView | null>(null);
  const overviewContactMapRef = useRef<ContactMapView | null>(overviewContactMap);
  overviewContactMapRef.current = overviewContactMap;
  const [backendStartedContactTileGeneration, setBackendStartedContactTileGeneration] = useState<
    number | null
  >(null);
  const [paintedContactTileGeneration, setPaintedContactTileGeneration] = useState<number | null>(
    null,
  );
  const contactTileCacheLruRef = useRef<ContactTileResolutionLru<ContactMapTile> | null>(null);
  if (contactTileCacheLruRef.current === null) {
    contactTileCacheLruRef.current = new ContactTileResolutionLru<ContactMapTile>();
  }
  const contactTileCacheLru = contactTileCacheLruRef.current;
  const contactTileCacheRef = useRef<Map<string, ContactMapTile>>(contactTileCacheLru.toMap());
  const contactTileViewportResidencyHistoryRef = useRef<ContactTileViewportResidencyHistory>([]);
  const contactTileViewportResidencyScopeRef = useRef<string | null>(null);
  const contactMainLodTileCacheLruRef = useRef<
    ContactTileResolutionLru<ContactMapTile> | null
  >(null);
  if (contactMainLodTileCacheLruRef.current === null) {
    contactMainLodTileCacheLruRef.current = new ContactTileResolutionLru<ContactMapTile>(
      contactMainLodTileCacheLimits,
    );
  }
  const contactMainLodTileCacheLru = contactMainLodTileCacheLruRef.current;
  const contactMainLodTileCacheRef = useRef<Map<string, ContactMapTile>>(
    contactMainLodTileCacheLru.toMap(),
  );
  const autoColorScaleCacheRef = useRef<Map<string, ContactColorScale>>(new Map());
  const lastCompleteContactMapRef = useRef<ContactMapView | null>(null);
  const placementPreviewRestoreFrameRef = useRef<ContactMapView | null>(null);
  const placementReplacementPreviewActiveRef = useRef(false);
  // The Rust process can outlive a WebView reload, so start both monotonic
  // counters from a wall-clock epoch instead of resetting them to zero.
  const contactTileGenerationRef = useRef(Date.now() * 1_000);
  const contactTileBackendRequestIdRef = useRef(Date.now() * 1_000);
  const activeContactOverviewRequestIdRef = useRef<number | null>(null);
  const contactPanPrefetchSequenceRef = useRef(0);
  const contactPanGenerationStartRef = useRef<{
    generation: number;
    promise: Promise<unknown | null>;
  } | null>(null);
  const contactTileGenerationStartRef = useRef<{
    generation: number;
    promise: Promise<unknown | null>;
  } | null>(null);
  const contactTileFlightsRef = useRef(new ContactTileFlightRegistry<ContactMapTile>());
  const contactSourceTileCacheRef = useRef(new Map<string, ContactMapTile>());
  const contactSourceTileFlightsRef = useRef(new ContactTileFlightRegistry<ContactMapTile>());
  const contactMainLodTileFlightsRef = useRef(
    new ContactTileFlightRegistry<ContactMapTile>(),
  );
  const normalizationPrewarmRequestIdRef = useRef<number | null>(null);
  const resolutionReaderPrewarmRequestIdRef = useRef<number | null>(null);
  const resolutionReaderPrewarmTimerRef = useRef<number | null>(null);
  const contactResolutionPreviewRef = useRef<ContactResolution | null>(null);
  const endpointContactTileCacheRef = useRef(new Map<string, ContactMapTile>());
  const endpointContactTileFlightsRef = useRef(new ContactTileFlightRegistry<ContactMapTile>());
  const contactLayoutHandleRegistryRef = useRef<ContactLayoutHandleRegistry | null>(null);
  if (contactLayoutHandleRegistryRef.current === null) {
    contactLayoutHandleRegistryRef.current = new ContactLayoutHandleRegistry();
  }
  const contactLayoutHandleRegistry = contactLayoutHandleRegistryRef.current;
  const [syntenyView, setSyntenyView] = useState<SyntenyView | null>(null);
  const [coverageView, setCoverageView] = useState<CoverageView | null>(null);
  const [coverageRecords, setCoverageRecords] = useState<BedGraphRecord[]>([]);
  const [pafRecords, setPafRecords] = useState<PafPreviewRecord[]>([]);
  const [pafPath, setPafPath] = useState<string | null>(null);
  const [pafImported, setPafImported] = useState(false);
  const [gfaDocument, setGfaDocument] = useState<GfaEvidenceDocument | null>(null);
  const [gfaHomologPattern, setGfaHomologPattern] = useState(defaultGfaHomologPattern);
  const [hiddenChromosomeIds, setHiddenChromosomeIds] = useState<Set<string>>(new Set());
  const [chromosomeFilterPattern, setChromosomeFilterPattern] = useState("");
  const [includeUnanchoredInChromosomeFilter, setIncludeUnanchoredInChromosomeFilter]
    = useState(false);
  const [statusMessage, setStatusMessage] = useState("Workbench ready");
  const [contactTilePerformanceLog, setContactTilePerformanceLog] = useState<string | null>(() => (
    contactTileIpcPerformanceEnabled
      ? "CSTUDIO_PERF event=contact_tiles_frontend status=armed"
      : null
  ));
  const [contactPanPerformanceLog, setContactPanPerformanceLog] = useState<string | null>(() => (
    contactTileIpcPerformanceEnabled
      ? "CSTUDIO_PERF event=contact_pan_pipeline status=armed"
      : null
  ));
  const savedAgpPathRef = useRef<string | null>(null);
  const [savedAgpPath, setSavedAgpPath] = useState<string | null>(null);
  const savingAgpRef = useRef(false);
  const isAgpDirtyRef = useRef(false);
  const allowWindowCloseRef = useRef(false);
  const closePromptOpenRef = useRef(false);
  const exportEditedAgpRef = useRef<(
    options?: { automatic?: boolean; saveAs?: boolean },
  ) => Promise<boolean>>(async () => false);
  const [savedAgpText, setSavedAgpText] = useState("");
  const [savedHistoryIdentity, setSavedHistoryIdentity] = useState("");
  const sourceAgpRef = useRef<SourceAgpSnapshot | null>(null);
  const [autoSaveEnabled, setAutoSaveEnabled] = useState(readAutoSavePreference);
  const agpInputRef = useRef<HTMLInputElement>(null);
  const gfaInputRef = useRef<HTMLInputElement>(null);
  const pafInputRef = useRef<HTMLInputElement>(null);
  const coverageInputRef = useRef<HTMLInputElement>(null);
  const [uiState, dispatchUi] = useReducer(
    reduceUiState,
    createInitialUiState("Workbench ready"),
  );
  const currentContactResolutionRef = useRef(uiState.contact.resolution);
  currentContactResolutionRef.current = uiState.contact.resolution;
  const contactTilePerformanceRef = useRef<ReturnType<
    typeof createContactTilePerformanceTracker
  > | null>(null);
  if (contactTilePerformanceRef.current === null) {
    contactTilePerformanceRef.current = createContactTilePerformanceTracker({
      enabled: contactTileIpcPerformanceEnabled,
      emit: (output) => {
        console.info(output.logfmt);
        setContactTilePerformanceLog(output.logfmt);
        void invoke("log_contact_frontend_performance", {
          line: output.logfmt,
        }).catch(() => undefined);
      },
    });
  }
  const contactTilePerformance = contactTilePerformanceRef.current;
  const contactResolutionResponsivenessRef = useRef<ReturnType<
    typeof createContactResolutionResponsivenessTracker
  > | null>(null);
  if (contactResolutionResponsivenessRef.current === null) {
    contactResolutionResponsivenessRef.current = createContactResolutionResponsivenessTracker({
      enabled: contactTileIpcPerformanceEnabled,
      emit: (output) => {
        console.info(output.logfmt);
        setContactTilePerformanceLog(output.logfmt);
        void invoke("log_contact_frontend_performance", {
          line: output.logfmt,
        }).catch(() => undefined);
      },
    });
  }
  const contactResolutionResponsiveness = contactResolutionResponsivenessRef.current;
  const contactPanPerformanceRef = useRef<ReturnType<
    typeof createContactPanPerformanceTracker
  > | null>(null);
  if (contactPanPerformanceRef.current === null) {
    contactPanPerformanceRef.current = createContactPanPerformanceTracker({
      enabled: contactTileIpcPerformanceEnabled,
      emit: (output) => {
        console.info(output.logfmt);
        setContactPanPerformanceLog(output.logfmt);
        void invoke("log_contact_pan_frontend_performance", {
          request: output.record,
        }).catch(() => undefined);
      },
    });
  }
  const contactPanPerformance = contactPanPerformanceRef.current;
  const beginContactPanGeneration = useCallback(() => {
    const generation = contactTileGenerationRef.current + 1;
    contactTileGenerationRef.current = generation;
    contactTilePerformance.supersedeBefore(generation);
    // Rust cancels every non-retained request from the previous generation.
    // Detach the matching frontend flights before pointer-prefetch can reuse a
    // promise that is already destined to reject without a current retry.
    contactTileFlightsRef.current.clear();
    contactMainLodTileFlightsRef.current.clear();
    contactSourceTileFlightsRef.current.clear();
    const retainedRequestIds = retainContactOverviewRequestId(
      [],
      activeContactOverviewRequestIdRef.current,
    );
    const promise = invoke<number[]>("begin_contact_tile_generation", {
      request: { generation, retainedRequestIds },
    }).then(
      () => null,
      (error: unknown) => error,
    );
    const start = { generation, promise };
    contactPanGenerationStartRef.current = start;
    contactPanPrefetchQueue.clearPending();
    return start;
  }, [contactPanPrefetchQueue, contactTilePerformance]);
  const suspendContactTileLoadingForPan = useCallback(() => {
    // Advance the backend exactly once for the whole gesture. Every diagonal
    // prefetch frontier then shares this generation and its per-tile flights.
    void beginContactPanGeneration().promise;
  }, [beginContactPanGeneration]);
  const handleContactViewportPreview = useCallback((preview: ContactPanPreview | null) => {
    if (contactViewportPreviewIsPan(preview)) {
      pendingPanPerformancePreviewRef.current = preview;
    } else if (contactViewportPreviewIsReplacement(preview)) {
      if (!placementReplacementPreviewActiveRef.current) {
        placementPreviewRestoreFrameRef.current = lastCompleteContactMapRef.current;
      }
      placementReplacementPreviewActiveRef.current = true;
      pendingPanPerformancePreviewRef.current = null;
    } else if (placementReplacementPreviewActiveRef.current) {
      placementReplacementPreviewActiveRef.current = false;
      const restoreFrame = placementPreviewRestoreFrameRef.current;
      placementPreviewRestoreFrameRef.current = null;
      if (restoreFrame) {
        lastCompleteContactMapRef.current = restoreFrame;
        setContactMap(restoreFrame);
      }
      // Never pair a restored canonical frame with source-layout maps from the
      // temporary placement generation. The canonical generation may attach
      // its own exact source-space map after it becomes ready.
      setContactGpuSourceLayout(null);
      setContactTileDeltaStream(null);
    }
    setContactTilePreviewViewport(preview);
  }, []);
  const latestUiStateRef = useRef(uiState);
  latestUiStateRef.current = uiState;
  const pendingResolutionPerformanceRef = useRef<PendingResolutionPerformance | null>(null);
  const lastWebContentMemoryLoadRef = useRef<{
    coolPath: string;
    targetResolution: number;
  } | null>(null);
  const contactTilePresentationScheduleRef = useRef<ContactTilePresentationSchedule | null>(null);
  const dispatchMeasuredUiAction = useCallback((action: UiAction) => {
    const currentUiState = latestUiStateRef.current;
    const nextResolution = contactTilePerformance.enabled
      ? nextContactResolutionForPerformance(action, currentUiState)
      : null;
    if (nextResolution) {
      const startedAt = contactTilePerformance.timestamp();
      pendingResolutionPerformanceRef.current = {
        startedAt,
        fromResolution: currentUiState.contact.resolution,
        toResolution: nextResolution,
      };
      contactResolutionResponsiveness.startGeneration(
        contactTileGenerationRef.current + 1,
        startedAt,
      );
    }
    dispatchUi(action);
  }, [contactResolutionResponsiveness, contactTilePerformance]);
  const handleContactTileLayerCommit = useCallback((event: ContactTileRenderMilestone) => {
    if (event.generation === contactTileGenerationRef.current) {
      const completeLayer = lastCompleteContactMapRef.current;
      if (
        completeLayer?.visibleLayerComplete === true
        && completeLayer.renderGeneration === event.generation
        && completeLayer.isTransientResolutionPreview !== true
      ) {
        logContactMemoryCheckpoint({
          stage: "react_commit",
          generation: event.generation,
          targetResolution: completeLayer.resolution,
          payloadBytes: (completeLayer.tiles ?? []).reduce(
            (total, tile) => total + contactTileRetainedValueBytes(tile),
            0,
          ),
          itemCount: event.canvasCount,
          frontendTimestamp: event.commitTimestamp,
        });
      }
      contactTilePerformance.markReactCommit(
        event.generation,
        event.canvasCount,
        event.commitTimestamp,
      );
    }
  }, [contactTilePerformance]);
  const handleContactTileLayerPaintComplete = useCallback((event: ContactTileRenderMilestone) => {
    if (event.generation !== contactTileGenerationRef.current) {
      return;
    }
    const completeLayer = lastCompleteContactMapRef.current;
    const paintsTerminalLayer = Boolean(
      completeLayer?.visibleLayerComplete === true
      && completeLayer.renderGeneration === event.generation
      && completeLayer.isTransientResolutionPreview !== true
    );
    if (paintsTerminalLayer) {
      logContactMemoryCheckpoint({
        stage: "first_paint",
        generation: event.generation,
        targetResolution: completeLayer?.resolution ?? resolutionToBasePairs(
          latestUiStateRef.current.contact.resolution,
        ),
        payloadBytes: (completeLayer?.tiles ?? []).reduce(
          (total, tile) => total + contactTileRetainedValueBytes(tile),
          0,
        ),
        itemCount: event.canvasCount,
      });
      setContactTileDeltaStream((current) => (
        current?.generation === event.generation ? null : current
      ));
      setPaintedContactTileGeneration((current) => (
        current === event.generation ? current : event.generation
      ));
    }
    // Only genuinely transient layers wait for a replacement. A screen-scale
    // main LOD is terminal whenever the large-view policy selected it.
    if (!paintsTerminalLayer) {
      return;
    }
    const tracksResolutionPerformance = Boolean(
      contactTilePerformance.snapshot(event.generation),
    );
    const tracksPanPerformance = Boolean(
      contactPanPerformance.snapshot(event.generation),
    );
    const tracksResolutionResponsiveness = (
      contactResolutionResponsiveness.activeGeneration() === event.generation
    );
    if (!tracksResolutionPerformance && !tracksPanPerformance && !tracksResolutionResponsiveness) {
      return;
    }
    const previous = contactTilePresentationScheduleRef.current;
    cancelContactTilePresentationSchedule(previous);

    const schedule: ContactTilePresentationSchedule = {
      ...event,
      firstFrame: null,
      secondFrame: null,
    };
    contactTilePresentationScheduleRef.current = schedule;
    schedule.firstFrame = window.requestAnimationFrame(() => {
      if (
        contactTilePresentationScheduleRef.current !== schedule
        || event.generation !== contactTileGenerationRef.current
      ) {
        if (contactTilePresentationScheduleRef.current === schedule) {
          contactTilePresentationScheduleRef.current = null;
        }
        return;
      }
      schedule.firstFrame = null;
      schedule.secondFrame = window.requestAnimationFrame(() => {
        if (
          contactTilePresentationScheduleRef.current !== schedule
          || event.generation !== contactTileGenerationRef.current
        ) {
          if (contactTilePresentationScheduleRef.current === schedule) {
            contactTilePresentationScheduleRef.current = null;
          }
          return;
        }
        contactTilePresentationScheduleRef.current = null;
        if (tracksResolutionPerformance) {
          contactTilePerformance.markLastTilePaint(event.generation, event.canvasCount);
        }
        if (tracksResolutionResponsiveness) {
          contactResolutionResponsiveness.finishGeneration(event.generation);
        }
        if (tracksPanPerformance) {
          contactPanPerformance.markGpuPaint(event.generation);
        }
      });
    });
  }, [contactPanPerformance, contactResolutionResponsiveness, contactTilePerformance]);
  useEffect(() => {
    if (
      contactResolutionResponsiveness.activeGeneration() === null
      || contactMap?.visibleLayerComplete !== true
      || contactMap.isTransientResolutionPreview === true
      || contactMap.requestedResolution !== resolutionToBasePairs(uiState.contact.resolution)
    ) {
      return;
    }
    let secondFrame: number | null = null;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        contactResolutionResponsiveness.finishActiveGeneration();
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame !== null) {
        window.cancelAnimationFrame(secondFrame);
      }
    };
  }, [contactMap, contactResolutionResponsiveness, uiState.contact.resolution]);
  const contactCoolPath = dataset?.cool_path ?? null;
  const contactIsMcool = contactCoolPath?.toLowerCase().endsWith(".mcool") ?? false;
  const handleContactResolutionPreview = useCallback((resolution: ContactResolution | null) => {
    contactResolutionPreviewRef.current = resolution;
    if (resolutionReaderPrewarmTimerRef.current !== null) {
      window.clearTimeout(resolutionReaderPrewarmTimerRef.current);
      resolutionReaderPrewarmTimerRef.current = null;
    }
    const previousRequestId = resolutionReaderPrewarmRequestIdRef.current;
    if (previousRequestId !== null) {
      resolutionReaderPrewarmRequestIdRef.current = null;
      void invoke("cancel_contact_resolution_reader_prewarm", {
        request: { requestId: previousRequestId },
      }).catch(() => undefined);
    }
    if (
      resolution === null
      || !contactCoolPath
      || !contactIsMcool
      || resolution === currentContactResolutionRef.current
    ) {
      return;
    }

    // Slider input events can arrive much faster than HDF5 can open a level.
    // Debounce the intent, then let a committed visible request join the same
    // Rust single-flight if it arrives while this preparation is still active.
    resolutionReaderPrewarmTimerRef.current = window.setTimeout(() => {
      resolutionReaderPrewarmTimerRef.current = null;
      if (contactResolutionPreviewRef.current !== resolution) {
        return;
      }
      const normalizationRequestId = normalizationPrewarmRequestIdRef.current;
      if (normalizationRequestId !== null) {
        normalizationPrewarmRequestIdRef.current = null;
        void invoke("cancel_contact_normalization_prewarm", {
          request: { requestId: normalizationRequestId },
        }).catch(() => undefined);
      }

      const requestId = contactTileBackendRequestIdRef.current + 1;
      contactTileBackendRequestIdRef.current = requestId;
      resolutionReaderPrewarmRequestIdRef.current = requestId;
      const generation = contactTileGenerationRef.current;
      void invoke<PrewarmContactResolutionReaderResponse>(
        "prewarm_contact_resolution_reader",
        {
          request: {
            requestId,
            generation,
            coolPath: contactCoolPath,
            resolution: contactResolutionToBasePairs(resolution),
          },
        },
      ).catch(() => undefined).finally(() => {
        if (resolutionReaderPrewarmRequestIdRef.current === requestId) {
          resolutionReaderPrewarmRequestIdRef.current = null;
        }
      });
    }, 120);
  }, [contactCoolPath, contactIsMcool]);

  useEffect(() => () => {
    handleContactResolutionPreview(null);
  }, [handleContactResolutionPreview]);
  const datasetAgpLayout = dataset?.agp_layout ?? null;
  const assemblyBlocks = uiState.assembly.blocks.length > 0
    ? uiState.assembly.blocks
    : datasetAgpLayout?.blocks ?? emptyLayout.blocks;
  const assemblyLayout = useMemo(
    () =>
      datasetAgpLayout
        ? { blocks: assemblyBlocks, totalSpan: totalVisualSpan(assemblyBlocks, datasetAgpLayout.totalSpan) }
        : emptyLayout,
    [assemblyBlocks, datasetAgpLayout],
  );
  useEffect(() => {
    setHiddenChromosomeIds(new Set());
    setChromosomeFilterPattern("");
    setIncludeUnanchoredInChromosomeFilter(false);
  }, [dataset?.agp_path]);
  const assemblyScaffoldClassification = useMemo(() => classifyGfaScaffolds(
    [...new Set(assemblyLayout.blocks.map((block) => block.objectId))],
    gfaHomologPattern,
  ), [
    assemblyLayout.blocks,
    gfaHomologPattern,
  ]);
  const chromosomeIds = useMemo(
    () => assemblyScaffoldClassification.columns
      .flatMap((column) => column.scaffolds.map((scaffold) => scaffold.id)),
    [assemblyScaffoldClassification.columns],
  );
  const unanchoredObjectIds = useMemo(
    () => assemblyScaffoldClassification.otherScaffolds
      .filter((objectId) => objectId !== "debris"),
    [assemblyScaffoldClassification.otherScaffolds],
  );
  const chromosomeVisibility = useMemo(() => resolveChromosomeVisibility(
    chromosomeIds,
    hiddenChromosomeIds,
    chromosomeFilterPattern,
    {
      unanchoredIds: unanchoredObjectIds,
      includeUnanchored: includeUnanchoredInChromosomeFilter,
    },
  ), [
    chromosomeFilterPattern,
    chromosomeIds,
    hiddenChromosomeIds,
    includeUnanchoredInChromosomeFilter,
    unanchoredObjectIds,
  ]);
  const canonicalViewAssemblyLayout = useMemo(
    () => buildChromosomeViewLayout(assemblyLayout.blocks, chromosomeVisibility),
    [assemblyLayout.blocks, chromosomeVisibility],
  );
  const placementPreviewBlocks = useMemo(() => placementPreview
    ? applyPlacementRecommendation(
      assemblyLayout.blocks,
      uiState.assembly.selection,
      placementPreview,
    )
    : assemblyLayout.blocks,
  [assemblyLayout.blocks, placementPreview, uiState.assembly.selection]);
  const viewAssemblyLayout = useMemo(
    () => placementPreviewBlocks === assemblyLayout.blocks
      ? canonicalViewAssemblyLayout
      : buildChromosomeViewLayout(placementPreviewBlocks, chromosomeVisibility),
    [assemblyLayout.blocks, canonicalViewAssemblyLayout, chromosomeVisibility, placementPreviewBlocks],
  );
  const chromosomeDisplayScopeKey = chromosomeVisibility.active
    ? [
        chromosomeIds.filter((id) => chromosomeVisibility.visibleIds.has(id)).join("\u0000"),
        `unanchored:${includeUnanchoredInChromosomeFilter ? unanchoredObjectIds.length : 0}`,
      ].join("\u0001")
    : "all";
  const previousChromosomeDisplayScopeRef = useRef(chromosomeDisplayScopeKey);
  useEffect(() => {
    if (previousChromosomeDisplayScopeRef.current === chromosomeDisplayScopeKey) {
      return;
    }
    previousChromosomeDisplayScopeRef.current = chromosomeDisplayScopeKey;
    setContactTilePreviewViewport(null);
    dispatchUi({
      type: "fitContactViewport",
      totalSpanMb: Math.max(0.000001, canonicalViewAssemblyLayout.totalSpan / 1_000_000),
    });
  }, [canonicalViewAssemblyLayout.totalSpan, chromosomeDisplayScopeKey]);
  const contactSourceResolution = useMemo(
    () => resolveContactLayoutSources(assemblyLayout.blocks, contactSources),
    [assemblyLayout.blocks, contactSources],
  );
  const contactLayoutBlocks = contactSourceResolution.blocks;
  const viewContactLayoutBlocks = useMemo(
    () => resolveContactLayoutSources(viewAssemblyLayout.projectionBlocks, contactSources).blocks,
    [contactSources, viewAssemblyLayout.projectionBlocks],
  );
  const canonicalViewContactLayoutBlocks = useMemo(
    () => resolveContactLayoutSources(
      canonicalViewAssemblyLayout.projectionBlocks,
      contactSources,
    ).blocks,
    [canonicalViewAssemblyLayout.projectionBlocks, contactSources],
  );
  const contactSourceAddressSpace = useMemo(() => {
    try {
      return contactSources.length > 0
        ? buildContactSourceAddressSpace(contactSources)
        : null;
    } catch {
      return null;
    }
  }, [contactSources]);
  const reportedContactSourceResolutionRef = useRef("");
  useEffect(() => {
    if (!contactCoolPath || contactSources.length === 0) {
      reportedContactSourceResolutionRef.current = "";
      return;
    }
    const reportKey = [
      contactCoolPath,
      contactSourceResolution.remappedSourceIds.join("\u0000"),
      contactSourceResolution.unresolvedSourceIds.join("\u0000"),
    ].join("\u0001");
    if (reportedContactSourceResolutionRef.current === reportKey) {
      return;
    }
    reportedContactSourceResolutionRef.current = reportKey;
    if (contactSourceResolution.remappedSourceIds.length > 0) {
      dispatchUi({
        type: "appendLog",
        message: `Contact map resolved split AGP sources through their unsplit COOL source: ${summarizeSourceIds(contactSourceResolution.remappedSourceIds)}`,
      });
    }
    if (contactSourceResolution.unresolvedSourceIds.length > 0) {
      dispatchUi({
        type: "appendLog",
        message: `Contact map has no verified source mapping for ${contactSourceResolution.unresolvedSourceIds.length.toLocaleString()} AGP source${contactSourceResolution.unresolvedSourceIds.length === 1 ? "" : "s"}: ${summarizeSourceIds(contactSourceResolution.unresolvedSourceIds)}`,
      });
    }
  }, [contactCoolPath, contactSourceResolution, contactSources.length]);
  const currentAgpText = useMemo(
    () => exportAgpText(assemblyLayout.blocks),
    [assemblyLayout.blocks],
  );
  const currentHistoryIdentity = useMemo(() => operationHistoryIdentity({
    nextOperationId: uiState.nextOperationId,
    operationHistory: uiState.operationHistory,
    redoStack: uiState.redoStack,
  }), [uiState.nextOperationId, uiState.operationHistory, uiState.redoStack]);
  const isAgpDirty = assemblyLayout.blocks.length > 0 && (
    currentAgpText !== savedAgpText || currentHistoryIdentity !== savedHistoryIdentity
  );
  isAgpDirtyRef.current = isAgpDirty;
  const backgroundAssemblyLayout = useDebouncedValue(viewAssemblyLayout, secondaryTrackRequestDelayMs);
  const handleContactPanTilePrefetch = useCallback((preview: ContactPanPreview) => {
    if (!contactCoolPath || viewAssemblyLayout.blocks.length === 0) {
      return;
    }
    const viewport = preview.viewport;
    const selectedResolution = resolutionToBasePairs(uiState.contact.resolution);
    const normalization = contactNormalizationForBackend(uiState.normalization);
    const totalSpanBp = Math.max(selectedResolution, viewAssemblyLayout.totalSpan);
    const plan = buildContactPanPrefetchPlan({
      availableResolutions: contactAvailableResolutions,
      coolPath: contactCoolPath,
      normalization,
      selectedResolution,
      totalSpanBp,
      viewport,
      velocityPrefetchViewport: preview.prefetchViewport,
      viewportHeightPx: uiState.contact.viewportHeightPx,
      viewportWidthPx: uiState.contact.viewportWidthPx,
    });
    if (plan.tiles.length === 0) {
      contactPanPrefetchQueue.clearPending();
      return;
    }

    // Keep React out of pointer motion, but retain the expanded viewport for
    // final-pan timing and all-visible batching after pointer release.
    contactPanPrefetchSequenceRef.current += 1;
    const panPrefetchSequence = contactPanPrefetchSequenceRef.current;
    pendingPanPerformancePreviewRef.current = {
      ...preview,
      prefetchViewport: plan.prefetchViewport,
    };

    const generationStart = contactPanGenerationStartRef.current
      ?? beginContactPanGeneration();
    const tileScope = contactTileScope(
      contactCoolPath,
      plan.targetResolution,
      plan.tileSizeBins,
      normalization,
      viewAssemblyLayout.projectionBlocks,
    );
    const layerScope = {
      id: contactTileDataScope(
        contactCoolPath,
        plan.targetResolution,
        plan.tileSizeBins,
        normalization,
      ),
      resolution: plan.targetResolution,
    };
    const cacheKeyForTile = createContactTileCacheKeyResolver(
      contactCoolPath,
      plan.targetResolution,
      plan.tileSizeBins,
      normalization,
      viewAssemblyLayout.projectionBlocks,
    );
    const tileCacheLru = plan.usesMainLod
      ? contactMainLodTileCacheLru
      : contactTileCacheLru;
    const tileCacheRef = plan.usesMainLod
      ? contactMainLodTileCacheRef
      : contactTileCacheRef;
    const tileFlights = plan.usesMainLod
      ? contactMainLodTileFlightsRef.current
      : contactTileFlightsRef.current;
    const cacheSnapshot = tileCacheLru.view();
    const cachedTiles: ContactMapTile[] = [];
    const missingTiles: ContactMapTileKey[] = [];
    for (const tile of plan.tiles) {
      const cached = cacheSnapshot.get(cacheKeyForTile(tile));
      if (cached) {
        cachedTiles.push(cached);
      } else {
        missingTiles.push(tile);
      }
    }
    emitContactFrontendPerformanceLine(formatContactPanPrefetchPlanPerformanceLog({
      generation: generationStart.generation,
      sequence: panPrefetchSequence,
      totalTiles: plan.tiles.length,
      visibleTiles: plan.visibleTiles.length,
      leadTiles: plan.leadTiles.length,
      cachedTiles: cachedTiles.length,
      missingTiles: missingTiles.length,
    }));
    const plannedKeys = plan.tiles.map(cacheKeyForTile);
    const visiblePlanKeys = new Set(plan.visibleTiles.map(cacheKeyForTile));
    const recencyKeys = [
      ...plannedKeys.filter((key) => !visiblePlanKeys.has(key)),
      ...visiblePlanKeys,
    ];
    const protectedKeys = new Set([
      ...plannedKeys,
      ...(plan.usesMainLod || contactTileViewportResidencyScopeRef.current !== tileScope
        ? []
        : contactTileViewportHistoryKeys(contactTileViewportResidencyHistoryRef.current)),
    ]);
    contactPanPrefetchProtectedKeysRef.current = {
      generation: generationStart.generation,
      keys: protectedKeys,
    };
    if (cachedTiles.length > 0) {
      // Backtrack footprints are protected eviction candidates, not active
      // camera samples. Touching them after the current plan made old viewports
      // newer than the center-visible target under byte pressure.
      tileCacheLru.touch(layerScope, recencyKeys, {
        keys: protectedKeys,
        scopes: new Set([layerScope.id]),
      });
      tileCacheRef.current = tileCacheLru.toMap();
      contactPanPrefetchBridge.publish({
        tiles: cachedTiles,
        generation: generationStart.generation,
        resolution: plan.targetResolution,
        tileSizeBins: plan.tileSizeBins,
        viewport: plan.prefetchViewport,
      });
    }
    if (missingTiles.length === 0) {
      contactPanPrefetchQueue.replacePending([]);
      return;
    }

    const visibleTileKeys = new Set(plan.visibleTiles.map(cacheKeyForTile));
    const leadTileKeys = new Set(plan.leadTiles.map(cacheKeyForTile));
    const panGenerationIsCurrent = () => (
      contactPanGenerationStartRef.current === generationStart
    );
    contactPanPrefetchQueue.replacePending(missingTiles.map((missingTile) => {
      const enqueuedAt = performance.now();
      const tileKey = cacheKeyForTile(missingTile);
      const priority = visibleTileKeys.has(tileKey)
        ? "visible" as const
        : leadTileKeys.has(tileKey)
          ? "lead" as const
          : "prefetch" as const;
      return {
        key: `${generationStart.generation}\u0000${tileKey}`,
        priority,
        sequence: panPrefetchSequence,
        run: async () => {
          const runStartedAt = performance.now();
          const flightStartedAt = performance.now();
          let backendRequestId: number | null = null;
          let generationWaitMs = 0;
          let backendIpcMs: number | null = null;
          let flightWaitMs: number | null = null;
          let cacheMergeMs = 0;
          let publishMs = 0;
          const report = (
            status: ContactPanPrefetchPerformanceRecord["status"],
            completedAt = performance.now(),
          ) => emitContactPanPrefetchPerformance({
            status,
            generation: generationStart.generation,
            sequence: panPrefetchSequence,
            requestId: backendRequestId,
            priority,
            tileX: missingTile.tileX,
            tileY: missingTile.tileY,
            sharedFlight: backendRequestId === null,
            queueWaitMs: runStartedAt - enqueuedAt,
            generationWaitMs,
            backendIpcMs,
            flightWaitMs: flightWaitMs ?? completedAt - flightStartedAt,
            cacheMergeMs,
            publishMs,
            totalMs: completedAt - enqueuedAt,
          });
          try {
            const tiles = await tileFlights.loadBatch({
              scope: tileScope,
              tiles: [missingTile],
              cacheKeyForTile,
              nextRequestId: () => {
                const nextRequestId = contactTileBackendRequestIdRef.current + 1;
                contactTileBackendRequestIdRef.current = nextRequestId;
                backendRequestId = nextRequestId;
                return nextRequestId;
              },
              load: async (requestId, requestedTiles) => {
                backendRequestId = requestId;
                const generationWaitStartedAt = performance.now();
                const generationStartError = await generationStart.promise;
                generationWaitMs = performance.now() - generationWaitStartedAt;
                if (generationStartError !== null) {
                  throw generationStartError;
                }
                if (!panGenerationIsCurrent()) {
                  throw new Error(contactTileRequestCancelledMessage);
                }
                const backendStartedAt = performance.now();
                try {
                  return await loadContactTilesWithLayoutHandle(
                    contactLayoutHandleRegistry,
                    viewContactLayoutBlocks,
                    {
                      requestId,
                      generation: generationStart.generation,
                      purpose: "spatial_prefetch",
                      coolPath: contactCoolPath,
                      baseResolution: plan.baseResolution,
                      sourceResolution: plan.sourceResolution,
                      targetResolution: plan.targetResolution,
                      tileSizeBins: plan.tileSizeBins,
                      normalization,
                      tiles: requestedTiles,
                      adaptiveRefinement: plan.adaptiveRefinement,
                    },
                  );
                } finally {
                  backendIpcMs = performance.now() - backendStartedAt;
                }
              },
            });
            flightWaitMs = performance.now() - flightStartedAt;
            if (!panGenerationIsCurrent()) {
              report("cancelled");
              return;
            }
            const latestProtection = contactPanPrefetchProtectedKeysRef.current;
            const activeProtectedKeys = latestProtection?.generation === generationStart.generation
              ? latestProtection.keys
              : protectedKeys;
            const cacheMergeStartedAt = performance.now();
            tileCacheLru.merge(
              layerScope,
              tiles.map((tile) => ({
                key: cacheKeyForTile(tile),
                value: tile,
                cellCount: contactTileCellCount(tile),
                valueBytes: contactTileRetainedValueBytes(tile),
              })),
              {
                recency: priority === "visible" ? "foreground" : "background",
                keys: activeProtectedKeys,
                scopes: new Set([layerScope.id]),
              },
            );
            tileCacheRef.current = tileCacheLru.toMap();
            cacheMergeMs = performance.now() - cacheMergeStartedAt;
            const latestPrefetchViewport = pendingPanPerformancePreviewRef.current
              ?.prefetchViewport ?? plan.prefetchViewport;
            const publishStartedAt = performance.now();
            contactPanPrefetchBridge.publish({
              tiles,
              generation: generationStart.generation,
              resolution: plan.targetResolution,
              tileSizeBins: plan.tileSizeBins,
              viewport: latestPrefetchViewport,
            });
            publishMs = performance.now() - publishStartedAt;
            report("ok");
          } catch (error) {
            report(isContactTileRequestCancelled(error) ? "cancelled" : "error");
            throw error;
          }
        },
        onError: (error: unknown) => {
          if (!isContactTileRequestCancelled(error)) {
            dispatchUi({
              type: "appendLog",
              message: `Contact pan prefetch failed: ${String(error)}`,
            });
          }
        },
      };
    }));
  }, [
    viewAssemblyLayout,
    beginContactPanGeneration,
    contactAvailableResolutions,
    contactCoolPath,
    viewContactLayoutBlocks,
    contactLayoutHandleRegistry,
    contactMainLodTileCacheLru,
    contactPanPrefetchBridge,
    contactPanPrefetchQueue,
    contactTileCacheLru,
    uiState.contact.resolution,
    uiState.contact.viewportHeightPx,
    uiState.contact.viewportWidthPx,
    uiState.normalization,
  ]);

  useEffect(() => {
    persistAutoSavePreference(autoSaveEnabled);
  }, [autoSaveEnabled]);

  useEffect(() => {
    const projectName = pathBasename(dataset?.agp_path ?? "Untitled assembly");
    const title = `${projectName}${isAgpDirty ? "*" : ""} — C-Studio`;
    document.title = title;
    invoke("set_window_title", { title }).catch(() => undefined);
  }, [dataset?.agp_path, isAgpDirty]);

  useEffect(() => () => {
    const schedule = contactTilePresentationScheduleRef.current;
    cancelContactTilePresentationSchedule(schedule);
  }, []);

  useEffect(() => {
    invoke<AppStatus>("get_app_status")
      .then((nextStatus) => {
        setStatus(nextStatus);
        setStatusMessage(`C-Studio ${nextStatus.version} ready`);
      })
      .catch(() => {
        setStatus(browserFallbackStatus);
        setStatusMessage("Browser preview mode");
      });
  }, []);

  useEffect(() => {
    const emptyTileCache = new Map<string, ContactMapTile>();
    contactPanPrefetchQueue.clearPending();
    contactPanPrefetchProtectedKeysRef.current = null;
    contactTileCacheLru.clear();
    contactTileCacheRef.current = emptyTileCache;
    contactTileViewportResidencyHistoryRef.current = [];
    contactTileViewportResidencyScopeRef.current = null;
    contactTileFlightsRef.current.clear();
    contactMainLodTileCacheLru.clear();
    contactMainLodTileCacheRef.current = new Map();
    contactMainLodTileFlightsRef.current.clear();
    endpointContactTileCacheRef.current.clear();
    endpointContactTileFlightsRef.current.clear();
    contactSourceTileCacheRef.current.clear();
    contactSourceTileFlightsRef.current.clear();
    setContactGpuSourceLayout(null);
    autoColorScaleCacheRef.current.clear();
    lastCompleteContactMapRef.current = null;
    placementPreviewRestoreFrameRef.current = null;
    placementReplacementPreviewActiveRef.current = false;
    setPlacementPreview(null);
    setContactTilePreviewViewport(null);
  }, [
    contactCoolPath,
    contactMainLodTileCacheLru,
    contactPanPrefetchQueue,
    contactTileCacheLru,
  ]);

  useEffect(() => {
    if (
      !contactCoolPath
      || !contactSourceAddressSpace
      || contactSourceResolution.unresolvedSourceIds.length > 0
      || viewContactLayoutBlocks.length === 0
      || backendStartedContactTileGeneration === null
    ) {
      setContactGpuSourceLayout(null);
      return;
    }
    const generationStart = contactTileGenerationStartRef.current;
    if (!generationStart) {
      setContactGpuSourceLayout(null);
      return;
    }
    const generation = generationStart.generation;
    if (generation !== backendStartedContactTileGeneration) {
      setContactGpuSourceLayout(null);
      return;
    }
    const selectedResolution = resolutionToBasePairs(uiState.contact.resolution);
    const viewport = contactTilePreviewViewport?.viewport ?? buildCenteredContactViewport({
      centerMb: uiState.contact.viewportCenterMb,
      centerXMb: uiState.contact.viewportCenterXMb,
      centerYMb: uiState.contact.viewportCenterYMb,
      totalSpanBp: Math.max(selectedResolution, viewAssemblyLayout.totalSpan),
      windowSizeBp: uiState.contact.viewportSpanMb * 1_000_000,
      viewportWidthPx: uiState.contact.viewportWidthPx,
      viewportHeightPx: uiState.contact.viewportHeightPx,
    });
    const visibleTileCount = contactTilesForViewport(
      viewport,
      selectedResolution,
      contactTileSizeBins,
      Math.max(selectedResolution, viewAssemblyLayout.totalSpan),
    ).length;
    const usesAdaptiveMcoolExactPolicy = (
      contactNormalizationForBackend(uiState.normalization) === "raw"
      && selectedResolution === 2_500_000
      && contactCoolPath.toLowerCase().endsWith(".mcool")
    );
    const candidateSourceMainLodPlan = (
      contactMainLodEnabled || usesAdaptiveMcoolExactPolicy
    ) ? buildContactMainLodPlan({
        viewport,
        selectedResolution,
        viewportWidthPx: uiState.contact.viewportWidthPx,
        viewportHeightPx: uiState.contact.viewportHeightPx,
        visibleTileCount,
        exactTileLimit: usesAdaptiveMcoolExactPolicy
          ? maxAdaptiveMcoolExactTiles
          : maxExactMainContactTiles,
      }, contactAvailableResolutions)
      : null;
    const sourceMainLodPlan = candidateSourceMainLodPlan
      && (
        usesAdaptiveMcoolExactPolicy
        || contactMainLodPlanChangesSampling(
          candidateSourceMainLodPlan,
          selectedResolution,
        )
      )
      ? candidateSourceMainLodPlan
      : null;
    if (sourceMainLodPlan) {
      // A screen-scale LOD already owns a small, exact projected tile set.
      // Building the source-layout replacement would scan the same stored
      // Cooler level a second time during a resolution switch, then replace
      // the already complete projected frame. Keep source-space remapping for
      // local exact views where it avoids projection reloads.
      setContactGpuSourceLayout(null);
      return;
    }
    const resolution = selectedResolution;
    const tileSizeBins = contactTileSizeBins;
    const sourceLayoutBlocks = contactSourceIdentityLayout(
      contactSourceAddressSpace,
      resolution,
    );
    const normalization = contactNormalizationForBackend(uiState.normalization);
    const xOverscanBins = Math.ceil((viewport.xEnd - viewport.xStart) / resolution);
    const yOverscanBins = Math.ceil((viewport.yEnd - viewport.yStart) / resolution);
    const xMap = buildContactGpuLayoutMap({
      addressSpace: contactSourceAddressSpace,
      layoutBlocks: viewContactLayoutBlocks,
      resolution,
      tileSizeBins,
      viewport: { xStart: viewport.xStart, xEnd: viewport.xEnd },
      overscanBins: xOverscanBins,
    });
    const yMap = buildContactGpuLayoutMap({
      addressSpace: contactSourceAddressSpace,
      layoutBlocks: viewContactLayoutBlocks,
      resolution,
      tileSizeBins,
      viewport: { xStart: viewport.yStart, xEnd: viewport.yEnd },
      overscanBins: yOverscanBins,
    });
    if (!contactGpuLayoutMapIsExact(xMap) || !contactGpuLayoutMapIsExact(yMap)) {
      setContactGpuSourceLayout(null);
      return;
    }
    const tilePlan = contactGpuSourceTilePlan(xMap, yMap);
    const dataScope = `source|${contactTileDataScope(
      contactCoolPath,
      resolution,
      tileSizeBins,
      normalization,
    )}`;
    const flightScope = `${dataScope}|generation:${generation}`;
    const cacheKeyForTile = (tile: ContactMapTileKey) => (
      `${dataScope}|${contactTileKey(tile)}`
    );
    const cachedTiles = tilePlan.tiles.flatMap((tile) => {
      const cached = contactSourceTileCacheRef.current.get(cacheKeyForTile(tile));
      return cached ? [cached] : [];
    });
    const missingTiles = tilePlan.tiles.filter(
      (tile) => !contactSourceTileCacheRef.current.has(cacheKeyForTile(tile)),
    );
    let cancelled = false;
    const publish = (tiles: readonly ContactMapTile[]) => {
      if (cancelled || generation !== contactTileGenerationRef.current) {
        return;
      }
      setContactGpuSourceLayout({
        resolution,
        tileSizeBins,
        viewport,
        xMap,
        yMap,
        sourceTiles: tilePlan.sourceTiles,
        tiles,
        dataScope,
        generation,
      });
    };
    if (missingTiles.length === 0) {
      publish(cachedTiles);
      return () => {
        cancelled = true;
      };
    }
    setContactGpuSourceLayout(null);
    void (async () => {
      const generationStartError = await generationStart.promise;
      if (
        generationStartError !== null
        || cancelled
        || generation !== contactTileGenerationRef.current
      ) {
        return;
      }
      const startedAt = performance.now();
      const loadedTiles = await contactSourceTileFlightsRef.current.loadBatch({
        scope: flightScope,
        tiles: missingTiles,
        cacheKeyForTile,
        nextRequestId: () => {
          const nextRequestId = contactTileBackendRequestIdRef.current + 1;
          contactTileBackendRequestIdRef.current = nextRequestId;
          return nextRequestId;
        },
        load: (requestId, tiles) => loadContactTilesWithLayoutHandle(
          contactLayoutHandleRegistry,
          sourceLayoutBlocks,
          {
            requestId,
            generation,
            purpose: "visible",
            coolPath: contactCoolPath,
            baseResolution: 1_000,
            targetResolution: resolution,
            tileSizeBins,
            normalization,
            tiles,
            adaptiveRefinement: false,
          },
        ),
      });
      if (cancelled || generation !== contactTileGenerationRef.current) {
        return;
      }
      for (const tile of loadedTiles) {
        const key = cacheKeyForTile(tile);
        contactSourceTileCacheRef.current.delete(key);
        contactSourceTileCacheRef.current.set(key, tile);
      }
      const completeTiles = tilePlan.tiles.flatMap((tile) => {
        const cached = contactSourceTileCacheRef.current.get(cacheKeyForTile(tile));
        return cached ? [cached] : [];
      });
      if (completeTiles.length !== tilePlan.tiles.length) {
        return;
      }
      const protectedKeys = new Set(tilePlan.tiles.map(cacheKeyForTile));
      for (const key of contactSourceTileCacheRef.current.keys()) {
        if (contactSourceTileCacheRef.current.size <= maxContactSourceTileCacheTiles) {
          break;
        }
        if (!protectedKeys.has(key)) {
          contactSourceTileCacheRef.current.delete(key);
        }
      }
      if (contactTileIpcPerformanceEnabled) {
        console.info([
          "CSTUDIO_PERF",
          "event=contact_source_layout",
          `generation=${generation}`,
          `resolution=${resolution}`,
          `visual_bins=${xMap.entries.length + yMap.entries.length}`,
          `source_axis_tiles=${tilePlan.sourceTiles.length}`,
          `source_tiles=${completeTiles.length}`,
          `load_ms=${Math.round((performance.now() - startedAt) * 1_000) / 1_000}`,
        ].join(" "));
      }
      publish(completeTiles);
    })().catch((error) => {
      if (
        !cancelled
        && generation === contactTileGenerationRef.current
        && !isContactTileRequestCancelled(error)
      ) {
        dispatchUi({
          type: "appendLog",
          message: `Source-space GPU tile load failed: ${String(error)}`,
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    backendStartedContactTileGeneration,
    contactAvailableResolutions,
    contactCoolPath,
    contactLayoutHandleRegistry,
    contactSourceAddressSpace,
    contactSourceResolution.unresolvedSourceIds.length,
    contactTilePreviewViewport,
    uiState.contact.resolution,
    uiState.contact.viewportCenterMb,
    uiState.contact.viewportCenterXMb,
    uiState.contact.viewportCenterYMb,
    uiState.contact.viewportHeightPx,
    uiState.contact.viewportSpanMb,
    uiState.contact.viewportWidthPx,
    uiState.normalization,
    viewAssemblyLayout.totalSpan,
    viewContactLayoutBlocks,
  ]);

  useEffect(() => {
    // A different matrix must never inherit the old overview. Normalization is
    // intentionally excluded: the navigation overview remains a stable raw map.
    // Layout edits are intentionally excluded: the last complete whole-genome
    // frame remains visible until its replacement is ready.
    overviewContactMapRef.current = null;
    setOverviewContactMap(null);
  }, [contactCoolPath]);

  useEffect(() => {
    if (
      !contactIsMcool
      || contactAvailableResolutions.length === 0
      || viewAssemblyLayout.blocks.length === 0
    ) {
      return;
    }
    const selectableResolutions = storedContactResolutionsForDataset(
      contactAvailableResolutions,
    );
    const resolution = closestContactResolution(
      uiState.contact.resolution,
      selectableResolutions,
    );
    if (!resolution || resolution === uiState.contact.resolution) {
      return;
    }
    const unavailableResolution = uiState.contact.resolution;
    dispatchUi({
      type: "setContactResolution",
      resolution,
      preserveViewport: true,
    });
    setStatusMessage(
      `${unavailableResolution} is not stored in this .mcool; switched to ${resolution}`,
    );
  }, [
    viewAssemblyLayout.blocks.length,
    viewAssemblyLayout.totalSpan,
    contactAvailableResolutions,
    contactIsMcool,
    uiState.contact.resolution,
    uiState.contact.totalSpanMb,
    uiState.contact.viewportHeightPx,
    uiState.contact.viewportSpanMb,
    uiState.contact.viewportWidthPx,
  ]);

  const committedContactTileViewport = buildCenteredContactViewport({
    centerMb: uiState.contact.viewportCenterMb,
    centerXMb: uiState.contact.viewportCenterXMb,
    centerYMb: uiState.contact.viewportCenterYMb,
    totalSpanBp: Math.max(
      resolutionToBasePairs(uiState.contact.resolution),
      viewAssemblyLayout.totalSpan,
    ),
    windowSizeBp: uiState.contact.viewportSpanMb * 1_000_000,
    viewportWidthPx: uiState.contact.viewportWidthPx,
    viewportHeightPx: uiState.contact.viewportHeightPx,
  });
  const effectiveContactTileViewport = contactTilePreviewViewport?.viewport
    ?? committedContactTileViewport;
  const effectiveContactTileResolution = resolutionToBasePairs(
    uiState.contact.resolution,
  );
  const effectiveContactTileTotalSpanBp = Math.max(
    effectiveContactTileResolution,
    viewAssemblyLayout.totalSpan,
  );
  const effectiveExactVisibleTileCount = contactTilesForViewport(
    effectiveContactTileViewport,
    effectiveContactTileResolution,
    contactTileSizeBins,
    effectiveContactTileTotalSpanBp,
  ).length;
  const effectiveUsesAdaptiveMcoolExactPolicy = (
    contactNormalizationForBackend(uiState.normalization) === "raw"
    && effectiveContactTileResolution === 2_500_000
    && contactCoolPath?.toLowerCase().endsWith(".mcool") === true
  );
  const effectiveContactMainLodPlan = (
    contactMainLodEnabled || effectiveUsesAdaptiveMcoolExactPolicy
  ) ? buildContactMainLodPlan({
      viewport: effectiveContactTileViewport,
      selectedResolution: effectiveContactTileResolution,
      viewportWidthPx: uiState.contact.viewportWidthPx,
      viewportHeightPx: uiState.contact.viewportHeightPx,
      visibleTileCount: effectiveExactVisibleTileCount,
      exactTileLimit: effectiveUsesAdaptiveMcoolExactPolicy
        ? maxAdaptiveMcoolExactTiles
        : maxExactMainContactTiles,
    }, contactAvailableResolutions)
    : null;
  // Request identity follows the visible and look-ahead render grids, not
  // pixel-exact camera coordinates. Sub-tile motion therefore reuses one
  // in-flight stream, while the next edge still starts loading before it is
  // exposed by the WebKit/WebView2 pan transform.
  const effectiveContactTileRequestGridResolution = effectiveContactMainLodPlan
    ?.targetResolution ?? effectiveContactTileResolution;
  const effectiveContactTilePrefetchViewport = contactTilePreviewViewport
    ?.prefetchViewport ?? effectiveContactTileViewport;
  const contactTileReplacementPreviewActive = contactViewportPreviewIsReplacement(
    contactTilePreviewViewport,
  );
  const contactTilePanPreviewActive = contactViewportPreviewIsPan(contactTilePreviewViewport);
  const effectiveContactTileViewportRequestKey = contactTileViewportRequestKey(
    effectiveContactTileViewport,
    effectiveContactTilePrefetchViewport,
    effectiveContactTileRequestGridResolution,
    contactTileSizeBins,
    effectiveContactTileTotalSpanBp,
    contactTilePreviewViewport?.urgentPrefetchTileCount ?? 0,
  );

  useEffect(() => {
    const panPreviewActive = contactTilePanPreviewActive;
    const pendingPanPreview = pendingPanPerformancePreviewRef.current;
    const panGenerationStart = contactPanGenerationStartRef.current;
    if (!panPreviewActive && pendingPanPreview && panGenerationStart) {
      // The authoritative settled viewport now owns loading. Stop scheduling
      // queued directional work while preserving every already-started tile.
      contactPanPrefetchSequenceRef.current += 1;
      contactPanPrefetchQueue.clearPending();
    }
    const settledGeneration = contactPanSettledGeneration(
      contactTileGenerationRef.current,
      effectiveContactTileViewport,
      panPreviewActive ? null : pendingPanPreview?.viewport ?? null,
      panGenerationStart?.generation ?? null,
    );
    const reusablePanGenerationStart = settledGeneration.reusePanGeneration
      ? panGenerationStart
      : null;
    // Pointer release consumes the same generation that loaded the diagonal
    // layers. Advancing here would cancel a spatial request that has a frontend
    // flight but has not yet registered in Rust, recreating the release stall.
    const generation = settledGeneration.generation;
    contactTileGenerationRef.current = Math.max(
      contactTileGenerationRef.current,
      generation,
    );
    const beginGeneration = (requestIds: readonly number[]) => {
      const retainedRequestIds = retainContactOverviewRequestId(
        requestIds,
        activeContactOverviewRequestIdRef.current,
      );
      const promise = reusablePanGenerationStart?.promise ?? (async () => {
        if (generation !== contactTileGenerationRef.current) {
          return new Error(contactTileRequestCancelledMessage);
        }
        return invoke<number[]>("begin_contact_tile_generation", {
          request: { generation, retainedRequestIds },
        }).then(
          () => null,
          (error: unknown) => error,
        );
      })();
      contactTileGenerationStartRef.current = { generation, promise };
      return promise;
    };
    if (!panPreviewActive) {
      setContactTileDeltaStream((current) => (
        current?.generation === generation ? current : null
      ));
    }
    contactTilePerformance.supersedeBefore(generation);
    if (contactTileReplacementPreviewActive) {
      contactPanPerformance.supersedeBefore(generation);
    } else if (!contactTilePreviewViewport) {
      contactPanPerformance.continueGeneration(generation);
    }
    const presentationSchedule = contactTilePresentationScheduleRef.current;
    if (presentationSchedule && presentationSchedule.generation !== generation) {
      cancelContactTilePresentationSchedule(presentationSchedule);
      contactTilePresentationScheduleRef.current = null;
    }
    const pendingResolutionCandidate = pendingResolutionPerformanceRef.current;
    pendingResolutionPerformanceRef.current = null;
    const pendingResolutionPerformance = pendingResolutionCandidate
      && pendingResolutionCandidate.fromResolution !== uiState.contact.resolution
      && pendingResolutionCandidate.toResolution === uiState.contact.resolution
        ? pendingResolutionCandidate
        : null;
    if (pendingResolutionPerformance) {
      if (contactResolutionResponsiveness.activeGeneration() === null) {
        contactResolutionResponsiveness.startGeneration(
          generation,
          pendingResolutionPerformance.startedAt,
        );
      } else {
        contactResolutionResponsiveness.retargetGeneration(generation);
      }
    } else if (contactResolutionResponsiveness.activeGeneration() !== null) {
      contactResolutionResponsiveness.retargetGeneration(generation);
    }
    if (!contactCoolPath || viewAssemblyLayout.blocks.length === 0) {
      lastWebContentMemoryLoadRef.current = null;
      setContactMap((current) => (current === null ? current : null));
      contactTileCacheLru.clear();
      contactTileCacheRef.current = new Map();
      lastCompleteContactMapRef.current = null;
      contactTileFlightsRef.current.clear();
      contactMainLodTileCacheLru.clear();
      contactMainLodTileCacheRef.current = new Map();
      contactMainLodTileFlightsRef.current.clear();
      void beginGeneration([]);
      return;
    }

    const targetResolution = resolutionToBasePairs(uiState.contact.resolution);
    if (
      contactIsMcool
      && contactAvailableResolutions.length > 0
      && !contactAvailableResolutions.includes(targetResolution)
    ) {
      setContactMap((current) => (current === null ? current : null));
      setContactTileDeltaStream(null);
      contactTileCacheLru.clear();
      contactTileCacheRef.current = new Map();
      lastCompleteContactMapRef.current = null;
      contactTileFlightsRef.current.clear();
      contactMainLodTileCacheLru.clear();
      contactMainLodTileCacheRef.current = new Map();
      contactMainLodTileFlightsRef.current.clear();
      void beginGeneration([]);
      setStatusMessage(
        `Waiting to switch from unavailable ${uiState.contact.resolution} .mcool resolution`,
      );
      return;
    }

    const previousWebContentMemoryLoad = lastWebContentMemoryLoadRef.current;
    const webContentMemoryReason = previousWebContentMemoryLoad === null
      || previousWebContentMemoryLoad.coolPath !== contactCoolPath
      ? "cold_load"
      : previousWebContentMemoryLoad.targetResolution !== targetResolution
        ? "resolution_switch"
        : null;
    lastWebContentMemoryLoadRef.current = { coolPath: contactCoolPath, targetResolution };
    if (!panPreviewActive && webContentMemoryReason) {
      void invoke("start_contact_webcontent_memory_monitor", {
        request: {
          generation,
          targetResolution,
          reason: webContentMemoryReason,
        },
      }).catch(() => undefined);
    }

    // Registration is asynchronous but independent of generation begin. Start
    // it immediately so the first visible tile request normally sees a warm
    // handle; failures are removed from the registry and surface on actual use.
    void contactLayoutHandleRegistry
      .prepare(viewContactLayoutBlocks, registerContactMapLayout)
      .catch(() => undefined);

    let cancelled = false;
    let adjacentPrefetchFirstFrame: number | null = null;
    let adjacentPrefetchSecondFrame: number | null = null;
    let cancelAdjacentIdleTask: (() => void) | null = null;
    let adjacentPrefetchStarted = false;
    const documentIsHidden = () => document.visibilityState === "hidden";
    const totalSpanBp = Math.max(targetResolution, viewAssemblyLayout.totalSpan);
    const viewport = effectiveContactTileViewport;
    const prefetchViewport = contactTilePreviewViewport?.prefetchViewport ?? viewport;
    const panPerformancePreview = contactTileReplacementPreviewActive
      ? null
      : contactTilePreviewViewport ?? pendingPanPerformancePreviewRef.current;
    const tileSizeBins = contactTileSizeBins;
    const normalization = contactNormalizationForBackend(uiState.normalization);
    const publishPanPrefetchTiles = (
      tiles: readonly ContactMapTile[],
      resolution: number,
      activeTileSizeBins: number,
    ) => {
      if (!panPreviewActive || tiles.length === 0) {
        return;
      }
      contactPanPrefetchBridge.publish({
        tiles,
        generation,
        resolution,
        tileSizeBins: activeTileSizeBins,
        viewport: prefetchViewport,
      });
    };
    const tileScope = contactTileScope(
      contactCoolPath,
      targetResolution,
      tileSizeBins,
      normalization,
      viewAssemblyLayout.projectionBlocks,
    );
    if (contactTileViewportResidencyScopeRef.current !== tileScope) {
      contactTileViewportResidencyScopeRef.current = tileScope;
      contactTileViewportResidencyHistoryRef.current = [];
    }
    const activeLayerScope = {
      id: contactTileDataScope(
        contactCoolPath,
        targetResolution,
        tileSizeBins,
        normalization,
      ),
      resolution: targetResolution,
    };
    const cacheKeyForTile = createContactTileCacheKeyResolver(
      contactCoolPath,
      targetResolution,
      tileSizeBins,
      normalization,
      viewAssemblyLayout.projectionBlocks,
    );
    const retainCompletedViewport = (visibleTiles: readonly ContactMapTileKey[]) => {
      contactTileViewportResidencyHistoryRef.current = retainContactTileViewportFootprint(
        contactTileViewportResidencyHistoryRef.current,
        visibleTiles.map(cacheKeyForTile),
      );
    };
    const untouchTileWorld = buildContactTileWorld({
      viewport,
      prefetchViewport,
      resolution: targetResolution,
      tileSizeBins,
      totalSpanBp,
      scope: tileScope,
      cache: contactTileCacheRef.current,
      cacheKeyForTile,
    });
    const visibleCacheKeys = new Set(
      untouchTileWorld.visibleTiles.map(cacheKeyForTile),
    );
    const warmCacheKeys = untouchTileWorld.prefetchTiles
      .map(cacheKeyForTile)
      .filter((key) => !visibleCacheKeys.has(key));
    const backtrackProtectedKeys = contactTileViewportHistoryKeys(
      contactTileViewportResidencyHistoryRef.current,
    );
    contactTileCacheLru.touch(
      activeLayerScope,
      [...warmCacheKeys, ...visibleCacheKeys],
      {
        keys: new Set([...visibleCacheKeys, ...backtrackProtectedKeys]),
        scopes: new Set([activeLayerScope.id]),
      },
    );
    contactTileCacheRef.current = contactTileCacheLru.toMap();
    const tileWorld = buildContactTileWorld({
      viewport,
      prefetchViewport,
      resolution: targetResolution,
      tileSizeBins,
      totalSpanBp,
      scope: tileScope,
      cache: contactTileCacheRef.current,
      cacheKeyForTile,
    });
    const usesAdaptiveMcoolExactPolicy = normalization === "raw"
      && targetResolution === 2_500_000
      && contactCoolPath.toLowerCase().endsWith(".mcool");
    // The adaptive 2.5 Mb safety boundary is not a diagnostic toggle: even a
    // build with general main-canvas LOD disabled must not fan out recursive
    // 1 kb refinement beyond the local exact limit.
    const candidateMainLodPlan = contactMainLodEnabled || usesAdaptiveMcoolExactPolicy
      ? buildContactMainLodPlan({
          viewport,
          selectedResolution: targetResolution,
          viewportWidthPx: uiState.contact.viewportWidthPx,
          viewportHeightPx: uiState.contact.viewportHeightPx,
          visibleTileCount: tileWorld.visibleTiles.length,
          exactTileLimit: usesAdaptiveMcoolExactPolicy
            ? maxAdaptiveMcoolExactTiles
            : maxExactMainContactTiles,
        }, contactAvailableResolutions)
      : null;
    // Do not cross from the exact cache into the independent LOD cache merely
    // because viewport alignment changed the canonical tile count around the
    // threshold. A no-op LOD (same source and target resolution) has identical
    // data but would force a second cold request and make pan release look
    // stalled. Adaptive 2.5 Mb refinement remains deliberately bounded by the
    // LOD path even when its displayed resolution is unchanged.
    const mainLodPlan = candidateMainLodPlan
      && (
        usesAdaptiveMcoolExactPolicy
        || contactMainLodPlanChangesSampling(candidateMainLodPlan, targetResolution)
      )
      ? candidateMainLodPlan
      : null;
    const mainLodTileState = (() => {
      if (!mainLodPlan) {
        return null;
      }
      const lodTileSizeBins = contactMainLodTileSizeBins;
      const lodScope = contactTileScope(
        contactCoolPath,
        mainLodPlan.targetResolution,
        lodTileSizeBins,
        normalization,
        viewAssemblyLayout.projectionBlocks,
      );
      const lodLayerScope = {
        id: `main-lod|${contactTileDataScope(
          contactCoolPath,
          mainLodPlan.targetResolution,
          lodTileSizeBins,
          normalization,
        )}`,
        resolution: mainLodPlan.targetResolution,
      };
      const lodCacheKeyForTile = createContactTileCacheKeyResolver(
        contactCoolPath,
        mainLodPlan.targetResolution,
        lodTileSizeBins,
        normalization,
        viewAssemblyLayout.projectionBlocks,
      );
      const wholeResidencyPlan = !panPreviewActive
        ? buildContactMainLodWholeResidencyPlan({
            totalSpanBp,
            resolution: mainLodPlan.targetResolution,
            tileSizeBins: lodTileSizeBins,
          })
        : null;
      const untouchedLodWorld = buildContactTileWorld({
        viewport,
        prefetchViewport,
        resolution: mainLodPlan.targetResolution,
        tileSizeBins: lodTileSizeBins,
        totalSpanBp,
        scope: lodScope,
        cache: contactMainLodTileCacheRef.current,
        cacheKeyForTile: lodCacheKeyForTile,
      });
      const visibleKeys = new Set(
        untouchedLodWorld.visibleTiles.map(lodCacheKeyForTile),
      );
      const warmKeys = untouchedLodWorld.prefetchTiles
        .map(lodCacheKeyForTile)
        .filter((key) => !visibleKeys.has(key));
      const wholeResidencyKeys = wholeResidencyPlan?.tiles.map(lodCacheKeyForTile) ?? [];
      contactMainLodTileCacheLru.touch(
        lodLayerScope,
        [...wholeResidencyKeys, ...warmKeys, ...visibleKeys],
        {
          keys: new Set([...wholeResidencyKeys, ...visibleKeys]),
          scopes: new Set([lodLayerScope.id]),
        },
      );
      contactMainLodTileCacheRef.current = contactMainLodTileCacheLru.toMap();
      const lodWorld = buildContactTileWorld({
        viewport,
        prefetchViewport,
        resolution: mainLodPlan.targetResolution,
        tileSizeBins: lodTileSizeBins,
        totalSpanBp,
        scope: lodScope,
        cache: contactMainLodTileCacheRef.current,
        cacheKeyForTile: lodCacheKeyForTile,
      });
      return {
        lodTileSizeBins,
        lodScope,
        lodLayerScope,
        lodCacheKeyForTile,
        lodWorld,
        wholeResidencyPlan,
      };
    })();
    // Advance/cancel exactly once for this generation. Large views deliberately
    // retain overlapping work from the independent coarse or exact tile layer.
    const retainedRequestIds = mainLodTileState
      ? contactMainLodTileFlightsRef.current.requestIdsFor(
          mainLodTileState.lodScope,
          mainLodTileState.wholeResidencyPlan?.tiles
            ?? mainLodTileState.lodWorld.prefetchTiles,
          mainLodTileState.lodCacheKeyForTile,
        )
      : contactTileFlightsRef.current.requestIdsFor(
          tileScope,
          tileWorld.prefetchTiles,
          cacheKeyForTile,
        );
    const generationStart = beginGeneration(retainedRequestIds);
    if (mainLodPlan) {
      const {
        lodTileSizeBins,
        lodScope: mainLodScope,
        lodLayerScope: mainLodLayerScope,
        lodCacheKeyForTile: mainLodCacheKeyForTile,
        lodWorld: mainLodWorld,
        wholeResidencyPlan: mainLodWholeResidencyPlan,
      } = mainLodTileState!;
      if (panPerformancePreview) {
        contactPanPerformance.startGeneration({
          generation,
          sequence: panPerformancePreview.sequence,
          pointerTimestamp: panPerformancePreview.pointerTimestamp,
          visibleTiles: mainLodWorld.visibleTiles.length,
          cacheHit: mainLodWorld.missingVisibleTiles.length === 0,
        });
        if (!contactTilePreviewViewport) {
          pendingPanPerformancePreviewRef.current = null;
        }
      }
      const mainLodProtectedKeys = new Set(
        (mainLodWholeResidencyPlan?.tiles ?? mainLodWorld.prefetchTiles)
          .map(mainLodCacheKeyForTile),
      );
      const assemblingMainLodVisibleTiles = new Map(
        mainLodWorld.cachedVisibleTiles.map((tile) => [
          mainLodCacheKeyForTile(tile),
          tile,
        ]),
      );
      const previousCompleteMap = lastCompleteContactMapRef.current;
      const retainsPreviousCompleteFrame = shouldRetainPreviousContactMapFrame(
        previousCompleteMap,
        mainLodPlan.targetResolution,
        lodTileSizeBins,
        mainLodScope,
        viewport,
      );
      const mainLodDirectDeltaStreamMode = contactTileDeltaStreamMode(
        contactTileDirectDeltaEnabled && !panPreviewActive,
        retainsPreviousCompleteFrame,
      );
      const presentsMainLodDirectDeltaStream = mainLodDirectDeltaStreamMode === "overlay";
      const mainLodLoadPriority = contactPanTileLoadPriority({
        previewActive: panPreviewActive,
        hasPendingPan: panPerformancePreview !== null,
        missingVisibleTileCount: mainLodWorld.missingVisibleTiles.length,
        normalVisibleBatchSize: contactMainLodVisibleBatchSize,
        activePanVisibleBatchSize: contactMainLodVisibleBatchSize,
        urgentPrefetchTileCount: panPerformancePreview?.urgentPrefetchTileCount ?? 0,
      });
      const mainLodLoadPlan = buildContactTileLoadPlan(
        mainLodWorld,
        maxContactMainLodPrefetchTiles,
        mainLodLoadPriority.visibleBatchSize,
        contactMainLodPrefetchBatchSize,
        mainLodLoadPriority.urgentPrefetchTileCount,
      );
      const mainLodMapForWorld = (world: typeof mainLodWorld): ContactMapView => ({
        ...projectContactTileWorldView(world),
        requestedResolution: targetResolution,
        normalization,
        layoutBlocks: viewAssemblyLayout.blocks,
        layoutScope: mainLodScope,
        visibleLayerComplete: world.missingVisibleTiles.length === 0,
        renderGeneration: generation,
        isTransientResolutionPreview: false,
      });
      const mainLodAutoColorScaleKey = contactAutoColorScaleKey(
        contactCoolPath,
        mainLodPlan.targetResolution,
        lodTileSizeBins,
        uiState.contact.colorScale.log,
      );
      const applyMainLodAutoColorScale = (map: ContactMapView) => {
        if (
          contactTileReplacementPreviewActive
          || !uiState.contact.colorScale.auto
          || !hasContactMapData(map)
        ) {
          return;
        }
        const cachedScale = autoColorScaleCacheRef.current.get(mainLodAutoColorScaleKey);
        if (cachedScale) {
          dispatchUi({ type: "setAutoColorScale", scale: cachedScale });
          return;
        }
        const counts = contactCountSampleForColorScale(map);
        if (!counts.some((value) => Number.isFinite(value) && value > 0)) {
          return;
        }
        const scale = estimateContactColorScale(counts, uiState.contact.colorScale.log);
        autoColorScaleCacheRef.current.set(mainLodAutoColorScaleKey, scale);
        dispatchUi({ type: "setAutoColorScale", scale });
      };
      let mainLodPaintScheduled = false;
      const markMainLodPainted = () => {
        if (mainLodPaintScheduled) {
          return;
        }
        mainLodPaintScheduled = true;
        const pendingPanPaint = contactPanPerformance.activeSnapshot();
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => {
            if (!cancelled && generation === contactTileGenerationRef.current) {
              if (pendingPanPaint?.generation === generation) {
                contactPanPerformance.markGpuPaintForSequence(
                  pendingPanPaint.panSequence,
                );
              }
              setPaintedContactTileGeneration((current) => (
                current === generation ? current : generation
              ));
            }
          });
        });
      };
      const reuseMainLodAsOverview = (map: ContactMapView) => {
        if (!contactOverviewEnabled || contactTileReplacementPreviewActive) {
          return;
        }
        const reusableOverview = contactNavigationOverviewFromCoveringMap(
          map,
          viewAssemblyLayout.totalSpan,
        );
        if (reusableOverview) {
          overviewContactMapRef.current = reusableOverview;
          setOverviewContactMap(reusableOverview);
        }
      };
      const initialMainLodMap = mainLodMapForWorld(mainLodWorld);
      let mainLodVisibleReady = mainLodWorld.missingVisibleTiles.length === 0;
      publishPanPrefetchTiles(
        mainLodWorld.cachedPrefetchTiles,
        mainLodPlan.targetResolution,
        lodTileSizeBins,
      );
      if (mainLodVisibleReady) {
        if (!panPreviewActive) {
          applyMainLodAutoColorScale(initialMainLodMap);
          lastCompleteContactMapRef.current = initialMainLodMap;
          setContactMap(initialMainLodMap);
          reuseMainLodAsOverview(initialMainLodMap);
        }
      } else {
        const displayedMainLod = displayContactMapForPendingLayer(
          initialMainLodMap,
          previousCompleteMap,
          false,
        );
        if (
          !panPreviewActive
          && shouldPublishContactMapLayer(retainsPreviousCompleteFrame, false)
        ) {
          setContactMap(displayedMainLod);
        }
        if (!panPreviewActive) {
          setStatusMessage(
            `Loading reusable LOD tiles at ${formatBasePairResolution(mainLodPlan.targetResolution)}…`,
          );
        }
      }

      void (async () => {
        const generationStartError = await generationStart;
        if (generationStartError !== null) {
          throw generationStartError;
        }
        if (cancelled || generation !== contactTileGenerationRef.current) {
          return;
        }
        if (!panPreviewActive) {
          setBackendStartedContactTileGeneration((current) => (
            current === generation ? current : generation
          ));
        }
        if (mainLodVisibleReady) {
          if (!panPreviewActive) {
            setStatusMessage(
              `Contact map tiled LOD at ${formatBasePairResolution(mainLodPlan.targetResolution)}`,
            );
            markMainLodPainted();
          }
        }
        const commitMainLodTiles = (
          kind: "visible" | "prefetch",
          tiles: ContactMapTile[],
        ) => {
          if (
            tiles.length === 0
            || cancelled
            || generation !== contactTileGenerationRef.current
          ) {
            return;
          }
          if (kind === "visible") {
            contactTilePerformance.markIpcResponse(generation);
            contactPanPerformance.markIpcResponse(generation);
            for (const tile of tiles) {
              assemblingMainLodVisibleTiles.set(mainLodCacheKeyForTile(tile), tile);
            }
          }
          contactMainLodTileCacheLru.merge(
            mainLodLayerScope,
            tiles.map((tile) => ({
              key: mainLodCacheKeyForTile(tile),
              value: tile,
              cellCount: contactTileCellCount(tile),
              valueBytes: contactTileRetainedValueBytes(tile),
            })),
            {
              recency: kind === "visible" ? "foreground" : "background",
              keys: mainLodProtectedKeys,
              scopes: new Set([mainLodLayerScope.id]),
            },
          );
          const nextMainLodCache = contactMainLodTileCacheLru.toMap();
          contactMainLodTileCacheRef.current = nextMainLodCache;
          const renderCache = contactTileRenderCache(
            nextMainLodCache,
            assemblingMainLodVisibleTiles,
          );
          if (kind === "visible") {
            contactTilePerformance.markCacheMerge(generation);
            contactPanPerformance.markCacheMerge(generation);
          }
          const updatedMainLodWorld = buildContactTileWorld({
            viewport,
            prefetchViewport,
            resolution: mainLodPlan.targetResolution,
            tileSizeBins: lodTileSizeBins,
            totalSpanBp,
            scope: mainLodScope,
            cache: renderCache,
            cacheKeyForTile: mainLodCacheKeyForTile,
          });
          const updatedMainLodMap = mainLodMapForWorld(updatedMainLodWorld);
          const layerComplete = updatedMainLodWorld.missingVisibleTiles.length === 0;
          const displayedMainLodMap = displayContactMapForPendingLayer(
            updatedMainLodMap,
            lastCompleteContactMapRef.current,
            layerComplete,
          );
          publishPanPrefetchTiles(
            tiles,
            mainLodPlan.targetResolution,
            lodTileSizeBins,
          );
          if (!panPreviewActive && mainLodWholeResidencyPlan) {
            contactPanPrefetchBridge.publishGpuResident({
              tiles,
              dataScope: `${mainLodScope}|${normalization}`,
              generation,
              resolution: mainLodPlan.targetResolution,
              tileSizeBins: lodTileSizeBins,
            });
          }
          if (layerComplete && !panPreviewActive) {
            lastCompleteContactMapRef.current = updatedMainLodMap;
          }
          if (
            !panPreviewActive
            && shouldPublishContactMapLayer(retainsPreviousCompleteFrame, layerComplete)
          ) {
            if (kind === "visible" && layerComplete) {
              applyMainLodAutoColorScale(updatedMainLodMap);
            }
            setContactMap(displayedMainLodMap);
          }
          if (kind === "visible" && layerComplete) {
            mainLodVisibleReady = true;
            if (!panPreviewActive) {
              reuseMainLodAsOverview(updatedMainLodMap);
              setStatusMessage(
                `Contact map tiled LOD at ${formatBasePairResolution(mainLodPlan.targetResolution)}`,
              );
              markMainLodPainted();
            }
          }
        };
        const mainLodVisibleTiles = combineContactMainLodVisibleBatches(
          mainLodLoadPlan.visibleBatches,
        );
        const loadMainLodPrefetchTiles = async (tiles: ContactMapTileKey[]) => {
          const loadBatch = () => contactMainLodTileFlightsRef.current.loadBatch({
            scope: mainLodScope,
            tiles,
            cacheKeyForTile: mainLodCacheKeyForTile,
            nextRequestId: () => {
              const nextRequestId = contactTileBackendRequestIdRef.current + 1;
              contactTileBackendRequestIdRef.current = nextRequestId;
              return nextRequestId;
            },
            load: (backendRequestId, requestedTiles) => loadContactTilesWithLayoutHandle(
              contactLayoutHandleRegistry,
              viewContactLayoutBlocks,
              {
                requestId: backendRequestId,
                generation,
                purpose: "spatial_prefetch",
                coolPath: contactCoolPath,
                baseResolution: mainLodPlan.sourceResolution,
                sourceResolution: mainLodPlan.sourceResolution,
                targetResolution: mainLodPlan.targetResolution,
                tileSizeBins: lodTileSizeBins,
                normalization,
                tiles: requestedTiles,
                adaptiveRefinement: false,
              },
            ),
          });
          try {
            return await loadBatch();
          } catch (error) {
            if (cancelled || generation !== contactTileGenerationRef.current) {
              return [];
            }
            if (!isContactTileRequestCancelled(error)) {
              throw error;
            }
            return loadBatch();
          }
        };
        let urgentPrefetchPromise: Promise<ContactMapTile[]> | null = null;
        const startUrgentPrefetch = () => {
          if (
            urgentPrefetchPromise
            || mainLodLoadPlan.urgentPrefetchTiles.length === 0
            || cancelled
            || generation !== contactTileGenerationRef.current
          ) {
            return;
          }
          urgentPrefetchPromise = loadMainLodPrefetchTiles(
            mainLodLoadPlan.urgentPrefetchTiles,
          ).catch((error) => {
            if (
              !cancelled
              && generation === contactTileGenerationRef.current
              && !isContactTileRequestCancelled(error)
            ) {
              dispatchUi({
                type: "appendLog",
                message: `Directional contact LOD prefetch failed: ${String(error)}`,
              });
            }
            return [];
          });
        };
        if (mainLodVisibleTiles.length > 0) {
          contactPanPerformance.markIpcStart(generation);
          let directDeltaPaintReported = false;
          const loadVisibleTiles = () => contactMainLodTileFlightsRef.current.loadBatch({
            scope: mainLodScope,
            tiles: mainLodVisibleTiles,
            cacheKeyForTile: mainLodCacheKeyForTile,
            nextRequestId: () => {
              const nextRequestId = contactTileBackendRequestIdRef.current + 1;
              contactTileBackendRequestIdRef.current = nextRequestId;
              return nextRequestId;
            },
            load: (backendRequestId, requestedTiles) => {
              const request = {
                requestId: backendRequestId,
                generation,
                purpose: "visible" as const,
                coolPath: contactCoolPath,
                baseResolution: mainLodPlan.sourceResolution,
                sourceResolution: mainLodPlan.sourceResolution,
                targetResolution: mainLodPlan.targetResolution,
                tileSizeBins: lodTileSizeBins,
                normalization,
                tiles: requestedTiles,
                adaptiveRefinement: false,
              };
              if (contactMainLodOneShotEnabled) {
                return loadContactTilesWithLayoutHandle(
                  contactLayoutHandleRegistry,
                  viewContactLayoutBlocks,
                  request,
                );
              }
              return streamContactTileDeltasWithLayoutHandle(
                contactLayoutHandleRegistry,
                viewContactLayoutBlocks,
                request,
                {
                  onStart: mainLodDirectDeltaStreamMode !== "disabled"
                    ? (accumulator) => {
                        if (cancelled || generation !== contactTileGenerationRef.current) {
                          return;
                        }
                        setContactTileDeltaStream({
                          generation,
                          resolution: mainLodPlan.targetResolution,
                          viewport,
                          accumulator,
                          retainPreviousFrame: mainLodDirectDeltaStreamMode === "staging",
                          onFirstPaint: presentsMainLodDirectDeltaStream ? () => {
                            if (
                              directDeltaPaintReported
                              || cancelled
                              || generation !== contactTileGenerationRef.current
                            ) {
                              return;
                            }
                            directDeltaPaintReported = true;
                            const pending = contactPanPerformance.activeSnapshot();
                            if (!pending || pending.generation !== generation) {
                              return;
                            }
                            window.requestAnimationFrame(() => {
                              window.requestAnimationFrame(() => {
                                contactPanPerformance.markGpuPaintForSequence(
                                  pending.panSequence,
                                );
                              });
                            });
                          } : undefined,
                        });
                      }
                    : undefined,
                  onDelta: () => {
                    contactTilePerformance.markIpcResponse(generation);
                    contactPanPerformance.markIpcResponse(generation);
                    contactTilePerformance.markCacheMerge(generation);
                    contactPanPerformance.markCacheMerge(generation);
                  },
                  // Never materialize cumulative sparse bridge snapshots.
                  // A hidden staging renderer reads the dense accumulator and
                  // leaves the retained surface in front until the terminal
                  // atomic swap.
                  onPreviewChunk: undefined,
                },
              );
            },
          });
          const visibleLoadPromise = loadVisibleTiles();
          // The visible invoke is queued first. Start one bounded leading-edge
          // request beside it so continuous wheel generations can retain that
          // work when those tiles become visible instead of starving prefetch
          // until the complete foreground scan finishes.
          startUrgentPrefetch();
          let loadedTiles: ContactMapTile[];
          try {
            loadedTiles = await visibleLoadPromise;
          } catch (error) {
            if (cancelled || generation !== contactTileGenerationRef.current) {
              return;
            }
            if (!isContactTileRequestCancelled(error)) {
              throw error;
            }
            loadedTiles = await loadVisibleTiles();
          }
          if (cancelled || generation !== contactTileGenerationRef.current) {
            return;
          }
          commitMainLodTiles("visible", loadedTiles);
        } else {
          startUrgentPrefetch();
        }
        if (urgentPrefetchPromise) {
          const urgentTiles = await urgentPrefetchPromise;
          if (!cancelled && generation === contactTileGenerationRef.current) {
            commitMainLodTiles("prefetch", urgentTiles);
          }
        }
        for (const tiles of mainLodLoadPlan.prefetchBatches) {
          const loadedTiles = await loadMainLodPrefetchTiles(tiles);
          if (cancelled || generation !== contactTileGenerationRef.current) {
            return;
          }
          commitMainLodTiles("prefetch", loadedTiles);
        }
        if (mainLodWholeResidencyPlan && !documentIsHidden()) {
          // Warm the remaining small interaction level in one backend scan.
          // The strict dense-byte/cell/tile gate above prevents fine levels
          // from turning this optimization into whole-genome materialization.
          const remainingWholeLevelTiles = mainLodWholeResidencyPlan.tiles.filter(
            (tile) => !contactMainLodTileCacheRef.current.has(
              mainLodCacheKeyForTile(tile),
            ),
          );
          if (remainingWholeLevelTiles.length > 0) {
            const loadedTiles = await loadMainLodPrefetchTiles(remainingWholeLevelTiles);
            if (cancelled || generation !== contactTileGenerationRef.current) {
              return;
            }
            commitMainLodTiles("prefetch", loadedTiles);
          }
        }
      })().catch((error) => {
        if (
          cancelled
          || generation !== contactTileGenerationRef.current
          || isContactTileRequestCancelled(error)
        ) {
          return;
        }
        if (!panPreviewActive) {
          setStatusMessage(
            mainLodVisibleReady
              ? `Contact map tiled LOD at ${formatBasePairResolution(mainLodPlan.targetResolution)}`
              : `Contact map tiled LOD failed: ${String(error)}`,
          );
        }
        dispatchUi({
          type: "appendLog",
          message: `${mainLodVisibleReady ? "Contact LOD prefetch" : "Contact map tiled LOD"} failed: ${String(error)}`,
        });
      });
      return () => {
        cancelled = true;
      };
    }
    if (panPerformancePreview) {
      contactPanPerformance.startGeneration({
        generation,
        sequence: panPerformancePreview.sequence,
        pointerTimestamp: panPerformancePreview.pointerTimestamp,
        visibleTiles: tileWorld.visibleTiles.length,
        cacheHit: tileWorld.missingVisibleTiles.length === 0,
      });
      if (!contactTilePreviewViewport) {
        pendingPanPerformancePreviewRef.current = null;
      }
    }
    const foregroundProtectedKeys = new Set(
      [
        ...tileWorld.prefetchTiles.map(cacheKeyForTile),
        ...backtrackProtectedKeys,
      ],
    );
    // The LRU budgets remain strict, but the layer currently being assembled
    // must remain complete even if its visible working set alone exceeds one
    // of those budgets. Keep only this generation's visible tiles in the
    // closure; the published ContactMapView owns them after completion.
    const assemblingVisibleTiles = new Map(
      tileWorld.cachedVisibleTiles.map((tile) => [cacheKeyForTile(tile), tile]),
    );
    const previousCompleteMap = lastCompleteContactMapRef.current;
    if (
      previousCompleteMap?.normalization !== undefined
      && previousCompleteMap.normalization !== normalization
    ) {
      if (!panPreviewActive) {
        setStatusMessage(`Applying ${uiState.normalization} normalization…`);
      }
    }
    const holdsPreviousCompleteFrame = shouldHoldPreviousContactMapFrame(
      previousCompleteMap,
      targetResolution,
      tileSizeBins,
      tileScope,
    );
    const retainsPreviousCompleteFrame = shouldRetainPreviousContactMapFrame(
      previousCompleteMap,
      targetResolution,
      tileSizeBins,
      tileScope,
      viewport,
    );
    const streamsCompatiblePan = retainsPreviousCompleteFrame
      && !holdsPreviousCompleteFrame;
    const normalVisibleBatchSize = holdsPreviousCompleteFrame
      ? Math.max(1, tileWorld.missingVisibleTiles.length)
      : streamsCompatiblePan
        ? panVisibleContactTileRequestBatchSize
        : visibleContactTileRequestBatchSize;
    const tileLoadPriority = contactPanTileLoadPriority({
      previewActive: panPreviewActive,
      hasPendingPan: panPerformancePreview !== null,
      missingVisibleTileCount: tileWorld.missingVisibleTiles.length,
      normalVisibleBatchSize,
      activePanVisibleBatchSize: panVisibleContactTileRequestBatchSize,
      urgentPrefetchTileCount: panPerformancePreview?.urgentPrefetchTileCount ?? 0,
    });
    const loadPlan = buildContactTileLoadPlan(
      tileWorld,
      maxBackgroundPrefetchTiles,
      tileLoadPriority.visibleBatchSize,
      contactSpatialPrefetchBatchSize,
      tileLoadPriority.urgentPrefetchTileCount,
    );
    if (pendingResolutionPerformance) {
      contactTilePerformance.startGeneration({
        generation,
        resolution: targetResolution,
        visibleTiles: tileWorld.visibleTiles.length,
        cacheHit: tileWorld.missingVisibleTiles.length === 0,
        startedAt: pendingResolutionPerformance.startedAt,
      });
    }
    const contactMapForWorld = (world: typeof tileWorld): ContactMapView => ({
      ...projectContactTileWorldView(world),
      requestedResolution: targetResolution,
      normalization,
      layoutBlocks: viewAssemblyLayout.blocks,
      layoutScope: tileScope,
      visibleLayerComplete: world.missingVisibleTiles.length === 0,
      renderGeneration: generation,
    });
    const autoColorScaleKey = contactAutoColorScaleKey(
      contactCoolPath,
      targetResolution,
      tileSizeBins,
      uiState.contact.colorScale.log,
    );
    const applyAutoColorScale = (map: ContactMapView) => {
      if (
        contactTileReplacementPreviewActive
        || !uiState.contact.colorScale.auto
        || !hasContactMapData(map)
      ) {
        return;
      }

      const cachedScale = autoColorScaleCacheRef.current.get(autoColorScaleKey);
      if (cachedScale) {
        dispatchUi({ type: "setAutoColorScale", scale: cachedScale });
        return;
      }

      const counts = contactCountSampleForColorScale(map);
      if (!counts.some((value) => Number.isFinite(value) && value > 0)) {
        return;
      }
      const scale = estimateContactColorScale(counts, uiState.contact.colorScale.log);
      autoColorScaleCacheRef.current.set(autoColorScaleKey, scale);
      dispatchUi({ type: "setAutoColorScale", scale });
    };
    const initialContactMap = contactMapForWorld(tileWorld);
    publishPanPrefetchTiles(
      tileWorld.cachedPrefetchTiles,
      targetResolution,
      tileSizeBins,
    );
    if (
      !panPreviewActive
      && retainsPreviousCompleteFrame
      && previousCompleteMap
      && tileWorld.missingVisibleTiles.length > 0
    ) {
      // A resolution change can begin while a same-resolution pan is still
      // showing a partial layer. Always restore the last fully authoritative
      // frame rather than retaining that sparse intermediate state.
      setContactMap((current) => (
        current === previousCompleteMap ? current : previousCompleteMap
      ));
    }
    const tileBatches = [
      ...loadPlan.visibleBatches.map((tiles) => ({ kind: "visible" as const, tiles })),
      ...loadPlan.prefetchBatches.map((tiles) => ({ kind: "prefetch" as const, tiles })),
    ];
    const renderedStatusMessage =
      `Contact map rendered with ${uiState.normalization} at ${uiState.contact.resolution}, ${formatViewportLabel(viewport)}`;
    const scheduleAdjacentResolutionPrefetch = () => {
      if (
        panPreviewActive
        || adjacentPrefetchStarted
        || cancelled
        || generation !== contactTileGenerationRef.current
      ) {
        return;
      }
      adjacentPrefetchStarted = true;
      adjacentPrefetchFirstFrame = window.requestAnimationFrame(() => {
        adjacentPrefetchFirstFrame = null;
        if (cancelled || generation !== contactTileGenerationRef.current) {
          return;
        }
        adjacentPrefetchSecondFrame = window.requestAnimationFrame(() => {
          adjacentPrefetchSecondFrame = null;
          if (
            cancelled
            || generation !== contactTileGenerationRef.current
          ) {
            return;
          }
          if (document.visibilityState === "hidden") {
            return;
          }

          cancelAdjacentIdleTask = scheduleContactIdleTask(() => {
            cancelAdjacentIdleTask = null;
            if (
              cancelled
              || generation !== contactTileGenerationRef.current
            ) {
              return;
            }
            if (document.visibilityState === "hidden") {
              return;
            }

            const currentUiState = latestUiStateRef.current;
            if (
              currentUiState.contact.resolution !== uiState.contact.resolution
              || contactNormalizationForBackend(currentUiState.normalization) !== normalization
            ) {
              return;
            }
            const availableResolutions = contactIsMcool
              ? availableContactResolutionsForDataset(
                  currentUiState.contact,
                  contactAvailableResolutions,
                  viewAssemblyLayout.totalSpan / 1_000_000,
                  false,
                )
              : availableContactResolutions(
                  currentUiState.contact,
                  viewAssemblyLayout.totalSpan / 1_000_000,
                  false,
                );
            const adjacentLayerScopeIds = new Set([activeLayerScope.id]);
            const jobQueues = adjacentContactResolutions(
              currentUiState.contact.resolution,
              availableResolutions,
            ).map((candidateResolution) => {
              const candidateUiState = reduceUiState(currentUiState, {
                type: "setContactResolution",
                resolution: candidateResolution,
              });
              if (candidateUiState.contact.resolution !== candidateResolution) {
                return [];
              }

              const candidateTargetResolution = resolutionToBasePairs(candidateResolution);
              const candidateTotalSpanBp = Math.max(
                candidateTargetResolution,
                viewAssemblyLayout.totalSpan,
              );
              const candidateViewport = buildCenteredContactViewport({
                centerMb: candidateUiState.contact.viewportCenterMb,
                centerXMb: candidateUiState.contact.viewportCenterXMb,
                centerYMb: candidateUiState.contact.viewportCenterYMb,
                totalSpanBp: candidateTotalSpanBp,
                windowSizeBp: candidateUiState.contact.viewportSpanMb * 1_000_000,
                viewportWidthPx: candidateUiState.contact.viewportWidthPx,
                viewportHeightPx: candidateUiState.contact.viewportHeightPx,
              });
              const candidatePlan = buildContactPanPrefetchPlan({
                availableResolutions: contactAvailableResolutions,
                coolPath: contactCoolPath,
                normalization,
                selectedResolution: candidateTargetResolution,
                totalSpanBp: candidateTotalSpanBp,
                viewport: candidateViewport,
                viewportHeightPx: candidateUiState.contact.viewportHeightPx,
                viewportWidthPx: candidateUiState.contact.viewportWidthPx,
              });
              const candidateDisplayResolution = candidatePlan.targetResolution;
              const candidateTileSizeBins = candidatePlan.tileSizeBins;
              const candidateTileScope = contactTileScope(
                contactCoolPath,
                candidateDisplayResolution,
                candidateTileSizeBins,
                normalization,
                viewAssemblyLayout.projectionBlocks,
              );
              const candidateLayerScope = {
                id: `${candidatePlan.usesMainLod ? "main-lod|" : ""}${contactTileDataScope(
                  contactCoolPath,
                  candidateDisplayResolution,
                  candidateTileSizeBins,
                  normalization,
                )}`,
                resolution: candidateDisplayResolution,
              };
              if (!candidatePlan.usesMainLod) {
                adjacentLayerScopeIds.add(candidateLayerScope.id);
              }
              const candidateCacheKeyForTile = createContactTileCacheKeyResolver(
                contactCoolPath,
                candidateDisplayResolution,
                candidateTileSizeBins,
                normalization,
                viewAssemblyLayout.projectionBlocks,
              );
              const candidateWorld = buildContactTileWorld({
                viewport: candidateViewport,
                resolution: candidateDisplayResolution,
                tileSizeBins: candidateTileSizeBins,
                totalSpanBp: candidateTotalSpanBp,
                scope: candidateTileScope,
                cache: candidatePlan.usesMainLod
                  ? contactMainLodTileCacheLru.toMap()
                  : contactTileCacheLru.toMap(),
                cacheKeyForTile: candidateCacheKeyForTile,
              });
              const candidateGpuDataScope = `${candidateTileScope}|${normalization}`;
              contactPanPrefetchBridge.publishGpuResident({
                tiles: candidateWorld.cachedVisibleTiles,
                dataScope: candidateGpuDataScope,
                generation,
                resolution: candidateDisplayResolution,
                tileSizeBins: candidateTileSizeBins,
              });

              return buildContactTileLoadPlan(
                candidateWorld,
                0,
                idleAdjacentContactTileBatchSize,
                idleAdjacentContactTileBatchSize,
              ).visibleBatches.map((tiles) => ({
                tiles,
                adaptiveRefinement: candidatePlan.adaptiveRefinement,
                baseResolution: candidatePlan.baseResolution,
                sourceResolution: candidatePlan.sourceResolution,
                targetResolution: candidateDisplayResolution,
                tileSizeBins: candidateTileSizeBins,
                usesMainLod: candidatePlan.usesMainLod,
                tileScope: candidateTileScope,
                layerScope: candidateLayerScope,
                gpuDataScope: candidateGpuDataScope,
                cacheKeyForTile: candidateCacheKeyForTile,
              }));
            });
            const jobs = interleaveContactPrefetchBatches(
              jobQueues,
              maxAdjacentResolutionPrefetchBatches,
            );
            const attemptedKeys = new Set<string>();

            const scheduleNextIdleJob = () => {
              if (cancelled || generation !== contactTileGenerationRef.current) {
                return;
              }
              if (jobs.length === 0) {
                return;
              }
              cancelAdjacentIdleTask = scheduleContactIdleTask(() => {
                cancelAdjacentIdleTask = null;
                void runNextIdleJob();
              });
            };
            const runNextIdleJob = async () => {
              if (
                cancelled
                || generation !== contactTileGenerationRef.current
              ) {
                return;
              }
              if (documentIsHidden()) {
                return;
              }
              if (
                contactTileFlightsRef.current.size > 0
                || contactMainLodTileFlightsRef.current.size > 0
                || normalizationPrewarmRequestIdRef.current !== null
              ) {
                scheduleNextIdleJob();
                return;
              }

              const job = jobs.shift();
              if (!job) {
                return;
              }
              const tileCacheLru = job.usesMainLod
                ? contactMainLodTileCacheLru
                : contactTileCacheLru;
              const pendingTiles = job.tiles.filter((tile) => {
                const key = job.cacheKeyForTile(tile);
                return !tileCacheLru.has(key) && !attemptedKeys.has(key);
              });
              for (const tile of pendingTiles) {
                attemptedKeys.add(job.cacheKeyForTile(tile));
              }
              if (pendingTiles.length === 0) {
                scheduleNextIdleJob();
                return;
              }

              try {
                const tileFlights = job.usesMainLod
                  ? contactMainLodTileFlightsRef.current
                  : contactTileFlightsRef.current;
                const tiles = await tileFlights.loadBatch({
                  scope: job.tileScope,
                  tiles: pendingTiles,
                  cacheKeyForTile: job.cacheKeyForTile,
                  nextRequestId: () => {
                    const nextRequestId = contactTileBackendRequestIdRef.current + 1;
                    contactTileBackendRequestIdRef.current = nextRequestId;
                    return nextRequestId;
                  },
                  load: (backendRequestId, requestedTiles) =>
                    loadContactTilesWithLayoutHandle(
                      contactLayoutHandleRegistry,
                      viewContactLayoutBlocks,
                      {
                        requestId: backendRequestId,
                        generation,
                        purpose: "adjacent_prefetch",
                        coolPath: contactCoolPath,
                        baseResolution: job.baseResolution,
                        sourceResolution: job.sourceResolution,
                        targetResolution: job.targetResolution,
                        tileSizeBins: job.tileSizeBins,
                        normalization,
                        tiles: requestedTiles,
                        adaptiveRefinement: job.adaptiveRefinement,
                      },
                    ),
                });
                if (cancelled || generation !== contactTileGenerationRef.current) {
                  return;
                }
                tileCacheLru.merge(
                  job.layerScope,
                  tiles.map((tile) => ({
                    key: job.cacheKeyForTile(tile),
                    value: tile,
                    cellCount: contactTileCellCount(tile),
                    valueBytes: contactTileRetainedValueBytes(tile),
                  })),
                  {
                    recency: "background",
                    keys: job.usesMainLod
                      ? new Set(pendingTiles.map(job.cacheKeyForTile))
                      : foregroundProtectedKeys,
                    // Retain the newly useful neighbor long enough to replace a
                    // stale non-adjacent scope when the three-scope budget is
                    // already full. Tile/cell pressure still evicts its cold
                    // records before the protected foreground keys.
                    scopes: job.usesMainLod
                      ? new Set([job.layerScope.id])
                      : adjacentLayerScopeIds,
                  },
                );
                // Background work deliberately avoids React state, status, and
                // performance markers. A later resolution switch reads this ref.
                if (job.usesMainLod) {
                  contactMainLodTileCacheRef.current = contactMainLodTileCacheLru.toMap();
                } else {
                  contactTileCacheRef.current = contactTileCacheLru.toMap();
                }
                contactPanPrefetchBridge.publishGpuResident({
                  tiles,
                  dataScope: job.gpuDataScope,
                  generation,
                  resolution: job.targetResolution,
                  tileSizeBins: job.tileSizeBins,
                });
              } catch {
                if (cancelled || generation !== contactTileGenerationRef.current) {
                  return;
                }
                // Idle prefetch is opportunistic; foreground loading owns retries
                // and user-visible error reporting if this layer is selected.
                // Drop the failed resolution's remaining batches so a missing
                // mcool level cannot consume every idle slice before the other
                // adjacent candidate is attempted.
                for (let index = jobs.length - 1; index >= 0; index -= 1) {
                  if (jobs[index]?.targetResolution === job.targetResolution) {
                    jobs.splice(index, 1);
                  }
                }
              }
              if (documentIsHidden()) {
                return;
              }
              scheduleNextIdleJob();
            };

            scheduleNextIdleJob();
          });
        });
      });
    };
    if (!panPreviewActive && tileWorld.missingVisibleTiles.length === 0) {
      retainCompletedViewport(tileWorld.visibleTiles);
      // Resolve the final target style before publishing the complete layer.
      // React batches this reducer update with the map update, so the hidden
      // surface is never prepared once with a provisional color scale.
      applyAutoColorScale(initialContactMap);
      lastCompleteContactMapRef.current = initialContactMap;
      setContactMap(initialContactMap);
    }
    const timeout = window.setTimeout(() => {
      if (cancelled || generation !== contactTileGenerationRef.current) {
        return;
      }
      const pendingContactMap = initialContactMap;
      const nextContactMap = displayContactMapForPendingLayer(
        pendingContactMap,
        lastCompleteContactMapRef.current,
        tileWorld.missingVisibleTiles.length === 0,
      );
      if (!panPreviewActive && tileWorld.missingVisibleTiles.length === 0) {
        lastCompleteContactMapRef.current = pendingContactMap;
      }

      if (!panPreviewActive && shouldPublishContactMapLayer(
        retainsPreviousCompleteFrame,
        tileWorld.missingVisibleTiles.length === 0,
      )) {
        if (tileWorld.missingVisibleTiles.length === 0) {
          applyAutoColorScale(pendingContactMap);
        }
        setContactMap(nextContactMap);
      }

      let visibleReady = loadPlan.visibleBatches.length === 0;
      const commitLoadedTiles = (
        kind: "visible" | "prefetch",
        tiles: ContactMapTile[],
      ) => {
        if (
          tiles.length === 0
          || cancelled
          || generation !== contactTileGenerationRef.current
        ) {
          return;
        }
        if (kind === "visible") {
          contactTilePerformance.markIpcResponse(generation);
          contactPanPerformance.markIpcResponse(generation);
          for (const tile of tiles) {
            assemblingVisibleTiles.set(cacheKeyForTile(tile), tile);
          }
        }

        contactTileCacheLru.merge(
          activeLayerScope,
          tiles.map((tile) => ({
            key: cacheKeyForTile(tile),
            value: tile,
            cellCount: contactTileCellCount(tile),
            valueBytes: contactTileRetainedValueBytes(tile),
          })),
          {
            keys: foregroundProtectedKeys,
            scopes: new Set([activeLayerScope.id]),
          },
        );
        const nextCache = contactTileCacheLru.toMap();
        contactTileCacheRef.current = nextCache;
        publishPanPrefetchTiles(tiles, targetResolution, tileSizeBins);
        const renderCache = contactTileRenderCache(nextCache, assemblingVisibleTiles);
        if (kind === "visible") {
          contactTilePerformance.markCacheMerge(generation);
          contactPanPerformance.markCacheMerge(generation);
        }

        const updatedTileWorld = buildContactTileWorld({
          viewport,
          prefetchViewport,
          resolution: targetResolution,
          tileSizeBins,
          totalSpanBp,
          scope: tileScope,
          cache: renderCache,
          cacheKeyForTile,
        });
        const updatedContactMap = contactMapForWorld(updatedTileWorld);
        const displayedContactMap = displayContactMapForPendingLayer(
          updatedContactMap,
          lastCompleteContactMapRef.current,
          updatedTileWorld.missingVisibleTiles.length === 0,
        );
        if (!panPreviewActive && updatedTileWorld.missingVisibleTiles.length === 0) {
          retainCompletedViewport(updatedTileWorld.visibleTiles);
          lastCompleteContactMapRef.current = updatedContactMap;
        }
        if (!panPreviewActive && shouldPublishContactMapLayer(
          retainsPreviousCompleteFrame,
          updatedTileWorld.missingVisibleTiles.length === 0,
        )) {
          if (kind === "visible" && updatedTileWorld.missingVisibleTiles.length === 0) {
            applyAutoColorScale(updatedContactMap);
          }
          setContactMap(displayedContactMap);
          const pendingPanPaint = (
            kind === "visible"
            && updatedTileWorld.missingVisibleTiles.length === 0
          ) ? contactPanPerformance.activeSnapshot() : null;
          if (pendingPanPaint) {
            window.requestAnimationFrame(() => {
              window.requestAnimationFrame(() => {
                contactPanPerformance.markGpuPaintForSequence(
                  pendingPanPaint.panSequence,
                );
              });
            });
          }
        }

        if (kind === "visible" && updatedTileWorld.missingVisibleTiles.length === 0) {
          visibleReady = true;
          if (!panPreviewActive) {
            setStatusMessage(renderedStatusMessage);
          }
        }
      };
      void (async () => {
        // Promotion and generation advance happen under one backend lock. An
        // overlapping old batch therefore remains reusable while unrelated
        // work becomes cancellable immediately afterward.
        const generationStartError = await generationStart;
        if (generationStartError !== null) {
          throw generationStartError;
        }
        if (cancelled || generation !== contactTileGenerationRef.current) {
          return;
        }
        if (!panPreviewActive) {
          setBackendStartedContactTileGeneration((current) => (
            current === generation ? current : generation
          ));
        }

        if (tileBatches.length === 0 && loadPlan.urgentPrefetchTiles.length === 0) {
          if (!panPreviewActive) {
            setStatusMessage(renderedStatusMessage);
          }
          scheduleAdjacentResolutionPrefetch();
          return;
        }
        if (visibleReady && !panPreviewActive) {
          setStatusMessage(renderedStatusMessage);
        }

        const shouldStreamVisibleBatches = contactTileBinaryEnabled
          && contactTileStreamEnabled
          && loadPlan.visibleBatches.length > 1;
        const usesAdaptiveMcoolRefinement = normalization === "raw"
          && targetResolution === 2_500_000
          && contactCoolPath.toLowerCase().endsWith(".mcool")
          && tileWorld.visibleTiles.length <= maxAdaptiveMcoolExactTiles;
        const shouldSingleScanVisibleTiles = contactTileBinaryEnabled
          && contactTileStreamEnabled
          && contactTileSingleScanEnabled
          && !usesAdaptiveMcoolRefinement
          && loadPlan.visibleBatches.length > 0
          // Keep the dense frontend accumulator bounded even in a diagnostic
          // build where main-canvas LOD has been explicitly disabled.
          && tileWorld.visibleTiles.length <= maxExactMainContactTiles;
        const directDeltaStreamMode = contactTileDeltaStreamMode(
          contactTileDirectDeltaEnabled && !panPreviewActive,
          retainsPreviousCompleteFrame,
        );
        const presentsDirectDeltaStream = directDeltaStreamMode === "overlay";
        const visibleTilesForGeneration = loadPlan.visibleBatches.flat();
        const progressiveGpuStagingAccumulator = (
          directDeltaStreamMode === "staging"
          && !shouldSingleScanVisibleTiles
          && visibleTilesForGeneration.length > 0
        )
          // The hidden replacement surface starts with cache hits and then
          // receives the missing batches. Seed the accumulator with the whole
          // visible domain; using only the missing batch keys makes the first
          // cached tile look like an unsolicited stream delta after a wide
          // high-resolution pan crosses the exact-tile batch threshold.
          ? new ContactTileDeltaAccumulator(tileWorld.visibleTiles, tileSizeBins)
          : null;
        const stagedCompleteTileKeys = new Set<string>();
        const stageCompleteTiles = (tiles: readonly ContactMapTile[]) => {
          if (!progressiveGpuStagingAccumulator) {
            return;
          }
          mergeCompleteContactTilesIntoDeltaAccumulator(
            progressiveGpuStagingAccumulator,
            stagedCompleteTileKeys,
            tiles,
          );
        };
        if (progressiveGpuStagingAccumulator) {
          stageCompleteTiles(tileWorld.cachedVisibleTiles);
          setContactTileDeltaStream({
            generation,
            resolution: targetResolution,
            viewport,
            accumulator: progressiveGpuStagingAccumulator,
            retainPreviousFrame: true,
          });
        }
        let urgentPrefetchPromise: Promise<ContactMapTile[]> | null = null;
        const startUrgentPrefetch = () => {
          if (
            urgentPrefetchPromise
            || loadPlan.urgentPrefetchTiles.length === 0
            || usesAdaptiveMcoolRefinement
            || cancelled
            || generation !== contactTileGenerationRef.current
          ) {
            return;
          }
          const tiles = loadPlan.urgentPrefetchTiles;
          urgentPrefetchPromise = contactTileFlightsRef.current.loadBatch({
            scope: tileScope,
            tiles,
            cacheKeyForTile,
            nextRequestId: () => {
              const nextRequestId = contactTileBackendRequestIdRef.current + 1;
              contactTileBackendRequestIdRef.current = nextRequestId;
              return nextRequestId;
            },
            load: (backendRequestId, requestedTiles) => loadContactTilesWithLayoutHandle(
              contactLayoutHandleRegistry,
              viewContactLayoutBlocks,
              {
                requestId: backendRequestId,
                generation,
                purpose: "spatial_prefetch",
                coolPath: contactCoolPath,
                baseResolution: 1000,
                targetResolution,
                tileSizeBins,
                normalization,
                tiles: requestedTiles,
                adaptiveRefinement: false,
              },
            ),
          });
          void urgentPrefetchPromise.then((tiles) => {
            if (!cancelled && generation === contactTileGenerationRef.current) {
              commitLoadedTiles("prefetch", tiles);
            }
          }).catch((error) => {
            if (
              !cancelled
              && generation === contactTileGenerationRef.current
              && !isContactTileRequestCancelled(error)
            ) {
              dispatchUi({
                type: "appendLog",
                message: `Directional contact prefetch failed: ${String(error)}`,
              });
            }
          });
        };
        const loadVisibleWithUrgentPrefetch = <T,>(load: () => Promise<T>) => {
          const visiblePromise = load();
          // ContactTileFlightRegistry queues the visible invoke first. The
          // leading-edge request starts immediately afterward and is retained
          // if the next wheel generation turns those tiles into foreground.
          startUrgentPrefetch();
          return visiblePromise;
        };
        if (loadPlan.visibleBatches.length === 0) {
          startUrgentPrefetch();
        }
        let streamedVisibleBatches = false;
        for (const batch of tileBatches) {
          if (usesAdaptiveMcoolRefinement && batch.kind !== "visible") {
            continue;
          }
          if (batch.kind === "visible" && shouldSingleScanVisibleTiles) {
            if (streamedVisibleBatches) {
              continue;
            }
            streamedVisibleBatches = true;
            contactPanPerformance.markIpcStart(generation);
            const visibleTiles = visibleTilesForGeneration;
            let directDeltaPaintReported = false;
            const loadVisibleDeltas = () => contactTileFlightsRef.current.loadBatch({
              scope: tileScope,
              tiles: visibleTiles,
              cacheKeyForTile,
              nextRequestId: () => {
                const nextRequestId = contactTileBackendRequestIdRef.current + 1;
                contactTileBackendRequestIdRef.current = nextRequestId;
                return nextRequestId;
              },
              load: (backendRequestId, requestedTiles) => (
                streamContactTileDeltasWithLayoutHandle(
                  contactLayoutHandleRegistry,
                  viewContactLayoutBlocks,
                  {
                    requestId: backendRequestId,
                    generation,
                    purpose: "visible",
                    coolPath: contactCoolPath,
                    baseResolution: 1000,
                    targetResolution,
                    tileSizeBins,
                    normalization,
                    tiles: requestedTiles,
                    adaptiveRefinement: usesAdaptiveMcoolRefinement,
                  },
                  {
                    onStart: directDeltaStreamMode !== "disabled"
                      ? (accumulator) => {
                          if (cancelled || generation !== contactTileGenerationRef.current) {
                            return;
                          }
                          setContactTileDeltaStream({
                            generation,
                            resolution: targetResolution,
                            viewport,
                            accumulator,
                            retainPreviousFrame: directDeltaStreamMode === "staging",
                            onFirstPaint: presentsDirectDeltaStream ? () => {
                              if (
                                directDeltaPaintReported
                                || cancelled
                                || generation !== contactTileGenerationRef.current
                              ) {
                                return;
                              }
                              directDeltaPaintReported = true;
                              const pending = contactPanPerformance.activeSnapshot();
                              if (!pending || pending.generation !== generation) {
                                return;
                              }
                              window.requestAnimationFrame(() => {
                                window.requestAnimationFrame(() => {
                                  contactPanPerformance.markGpuPaintForSequence(
                                    pending.panSequence,
                                  );
                                });
                              });
                            } : undefined,
                          });
                        }
                      : undefined,
                    onDelta: () => {
                      contactTilePerformance.markIpcResponse(generation);
                      contactPanPerformance.markIpcResponse(generation);
                      contactTilePerformance.markCacheMerge(generation);
                      contactPanPerformance.markCacheMerge(generation);
                    },
                    // Never rebuild cumulative sparse bridge snapshots. A
                    // first-load overlay can consume dense deltas directly;
                    // replacement layers defer presentation to one terminal
                    // atomic swap.
                    onPreviewChunk: undefined,
                  },
                )
              ),
            });
            let tiles: ContactMapTile[];
            try {
              tiles = await loadVisibleWithUrgentPrefetch(loadVisibleDeltas);
            } catch (error) {
              if (cancelled || generation !== contactTileGenerationRef.current) {
                return;
              }
              if (!isContactTileRequestCancelled(error)) {
                throw error;
              }
              tiles = await loadVisibleWithUrgentPrefetch(loadVisibleDeltas);
            }
            if (cancelled || generation !== contactTileGenerationRef.current) {
              return;
            }
            // Final cumulative snapshots include requested empty tiles and make
            // the visible layer authoritative only after the sentinel arrives.
            commitLoadedTiles("visible", tiles);
            continue;
          }
          if (batch.kind === "visible" && shouldStreamVisibleBatches) {
            if (streamedVisibleBatches) {
              continue;
            }
            streamedVisibleBatches = true;
            contactPanPerformance.markIpcStart(generation);
            const visibleTiles = visibleTilesForGeneration;
            const streamedKeys = new Set<string>();
            const loadVisibleStream = () => contactTileFlightsRef.current.loadBatch({
              scope: tileScope,
              tiles: visibleTiles,
              cacheKeyForTile,
              nextRequestId: () => {
                const nextRequestId = contactTileBackendRequestIdRef.current + 1;
                contactTileBackendRequestIdRef.current = nextRequestId;
                return nextRequestId;
              },
              load: (backendRequestId, requestedTiles) => {
                const requestedKeys = new Set(requestedTiles.map(cacheKeyForTile));
                const streamChunks = loadPlan.visibleBatches
                  .map((chunk) => chunk.filter((tile) => requestedKeys.has(cacheKeyForTile(tile))))
                  .filter((chunk) => chunk.length > 0);
                return streamContactTilesWithLayoutHandle(
                  contactLayoutHandleRegistry,
                  viewContactLayoutBlocks,
                  {
                    requestId: backendRequestId,
                    generation,
                    purpose: "visible",
                    coolPath: contactCoolPath,
                    baseResolution: 1000,
                    targetResolution,
                    tileSizeBins,
                    normalization,
                    tiles: requestedTiles,
                    adaptiveRefinement: usesAdaptiveMcoolRefinement,
                  },
                  streamChunks,
                  (chunkTiles) => {
                    stageCompleteTiles(chunkTiles);
                    for (const tile of chunkTiles) {
                      streamedKeys.add(cacheKeyForTile(tile));
                    }
                    commitLoadedTiles("visible", chunkTiles);
                  },
                );
              },
            });

            let tiles: ContactMapTile[];
            try {
              tiles = await loadVisibleWithUrgentPrefetch(loadVisibleStream);
            } catch (error) {
              if (cancelled || generation !== contactTileGenerationRef.current) {
                return;
              }
              if (!isContactTileRequestCancelled(error)) {
                throw error;
              }
              tiles = await loadVisibleWithUrgentPrefetch(loadVisibleStream);
            }
            if (cancelled || generation !== contactTileGenerationRef.current) {
              return;
            }
            stageCompleteTiles(tiles);
            commitLoadedTiles(
              "visible",
              tiles.filter((tile) => !streamedKeys.has(cacheKeyForTile(tile))),
            );
            continue;
          }
          if (batch.kind === "visible") {
            contactPanPerformance.markIpcStart(generation);
          }
          const loadBatch = () => contactTileFlightsRef.current.loadBatch({
            scope: tileScope,
            tiles: batch.tiles,
            cacheKeyForTile,
            nextRequestId: () => {
              const nextRequestId = contactTileBackendRequestIdRef.current + 1;
              contactTileBackendRequestIdRef.current = nextRequestId;
              return nextRequestId;
            },
            load: (backendRequestId, tiles) => loadContactTilesWithLayoutHandle(
              contactLayoutHandleRegistry,
              viewContactLayoutBlocks,
              {
                requestId: backendRequestId,
                generation,
                purpose: batch.kind === "visible" ? "visible" : "spatial_prefetch",
                coolPath: contactCoolPath,
                baseResolution: 1000,
                targetResolution,
                tileSizeBins,
                normalization,
                tiles,
                adaptiveRefinement: batch.kind === "visible"
                  && usesAdaptiveMcoolRefinement,
              },
            ),
          });

          let tiles: ContactMapTile[];
          try {
            tiles = await (batch.kind === "visible"
              ? loadVisibleWithUrgentPrefetch(loadBatch)
              : loadBatch());
          } catch (error) {
            if (cancelled || generation !== contactTileGenerationRef.current) {
              return;
            }
            if (!isContactTileRequestCancelled(error)) {
              throw error;
            }
            // A retained batch may already have crossed its cancellation
            // checkpoint. Its per-tile entries are now clean, so retry once as
            // work owned by the current generation.
            tiles = await (batch.kind === "visible"
              ? loadVisibleWithUrgentPrefetch(loadBatch)
              : loadBatch());
          }
          if (cancelled || generation !== contactTileGenerationRef.current) {
            return;
          }
          if (batch.kind === "visible") {
            stageCompleteTiles(tiles);
          }
          commitLoadedTiles(batch.kind, tiles);
        }
        if (visibleReady) {
          const pendingPanPaint = contactPanPerformance.activeSnapshot();
          if (pendingPanPaint && !panPreviewActive) {
            window.requestAnimationFrame(() => {
              window.requestAnimationFrame(() => {
                contactPanPerformance.markGpuPaintForSequence(
                  pendingPanPaint.panSequence,
                );
              });
            });
          }
          scheduleAdjacentResolutionPrefetch();
        }
      })().catch((error) => {
        if (
          cancelled
          || generation !== contactTileGenerationRef.current
          || isContactTileRequestCancelled(error)
        ) {
          return;
        }
        if (shouldResumeContactBackgroundSchedulingAfterFailure(visibleReady)) {
          scheduleAdjacentResolutionPrefetch();
        }
        if (!panPreviewActive) {
          setStatusMessage(
            visibleReady
              ? renderedStatusMessage
              : `Contact map render failed: ${String(error)}`,
          );
        }
        dispatchUi({
          type: "appendLog",
          message: `${visibleReady ? "Contact prefetch" : "Contact map render"} failed: ${String(error)}`,
        });
      });
    }, retainsPreviousCompleteFrame || contactTilePreviewViewport
      ? 0
      : contactViewportRequestDelayMs);

    return () => {
      cancelled = true;
      if (!panPreviewActive) {
        setContactTileDeltaStream((current) => (
          current?.generation === generation ? null : current
        ));
      }
      window.clearTimeout(timeout);
      if (adjacentPrefetchFirstFrame !== null) {
        window.cancelAnimationFrame(adjacentPrefetchFirstFrame);
      }
      if (adjacentPrefetchSecondFrame !== null) {
        window.cancelAnimationFrame(adjacentPrefetchSecondFrame);
      }
      cancelAdjacentIdleTask?.();
    };
  }, [
    contactMainLodTileCacheLru,
    contactTileCacheLru,
    contactPanPerformance,
    contactResolutionResponsiveness,
    contactTilePerformance,
    contactCoolPath,
    contactAvailableResolutions,
    viewAssemblyLayout,
    viewContactLayoutBlocks,
    uiState.contact.resolution,
    uiState.contact.viewportSpanMb,
    uiState.contact.viewportWidthPx,
    uiState.contact.viewportHeightPx,
    effectiveContactTileViewportRequestKey,
    contactTilePanPreviewActive,
    contactTileReplacementPreviewActive,
    contactPanPrefetchBridge,
    contactPanPrefetchQueue,
    uiState.contact.colorScale.auto,
    uiState.contact.colorScale.log,
    uiState.normalization,
  ]);

  useEffect(() => {
    const clearStaleOverview = () => {
      if (overviewContactMapRef.current === null) {
        return;
      }
      overviewContactMapRef.current = null;
      setOverviewContactMap(null);
    };
    if (
      !contactOverviewEnabled
      || !contactCoolPath
      || canonicalViewAssemblyLayout.blocks.length === 0
    ) {
      clearStaleOverview();
      return;
    }
    const overviewCoolPath = contactCoolPath;

    const totalSpanBp = Math.max(1, canonicalViewAssemblyLayout.totalSpan);
    const plan = buildContactOverviewTilePlan(
      totalSpanBp,
      contactAvailableResolutions,
    );
    const normalization = contactNavigationOverviewNormalization;
    const overviewScope = contactTileScope(
      overviewCoolPath,
      plan.targetResolution,
      plan.targetBins,
      normalization,
      canonicalViewAssemblyLayout.projectionBlocks,
    );
    const currentOverview = overviewContactMapRef.current;
    const currentOverviewUsesCurrentLayout = currentOverview?.layoutBlocks
      === canonicalViewAssemblyLayout.blocks;
    if (
      currentOverview
      && currentOverview.normalization === normalization
      && currentOverview.viewport.xStart === plan.viewport.xStart
      && currentOverview.viewport.xEnd === plan.viewport.xEnd
      && currentOverview.viewport.yStart === plan.viewport.yStart
      && currentOverview.viewport.yEnd === plan.viewport.yEnd
      && (
        currentOverviewUsesCurrentLayout
        || (
          currentOverview.resolution === plan.targetResolution
          && currentOverview.layoutScope === overviewScope
        )
      )
    ) {
      return;
    }

    let cancelled = false;
    let requestStarted = false;
    let requestCompleted = false;
    let retryTimer: number | null = null;
    let activeRequestId: number | null = null;
    const requestIsCurrent = () => !cancelled;
    const scheduleRetry = () => {
      if (cancelled || requestCompleted || retryTimer !== null) {
        return;
      }
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        void startOverviewRequest();
      }, 32);
    };

    async function startOverviewRequest() {
      if (
        cancelled
        || requestStarted
        || requestCompleted
        || document.visibilityState === "hidden"
      ) {
        return;
      }
      const generationStart = contactTileGenerationStartRef.current;
      if (!generationStart) {
        scheduleRetry();
        return;
      }
      const generationStartError = await generationStart.promise;
      if (cancelled) {
        return;
      }
      if (
        generationStartError !== null
        || generationStart !== contactTileGenerationStartRef.current
      ) {
        scheduleRetry();
        return;
      }

      requestStarted = true;
      const generation = generationStart.generation;
      const nextRequestId = contactTileBackendRequestIdRef.current + 1;
      contactTileBackendRequestIdRef.current = nextRequestId;
      activeRequestId = nextRequestId;
      activeContactOverviewRequestIdRef.current = nextRequestId;
      logContactMemoryCheckpoint({
        stage: "overview_start",
        generation,
        requestId: nextRequestId,
        targetResolution: plan.targetResolution,
        itemCount: plan.targetBins,
      });
      try {
        const response = await loadContactOverviewWithLayoutHandle(
          contactLayoutHandleRegistry,
          canonicalViewContactLayoutBlocks,
          {
            requestId: nextRequestId,
            generation,
            coolPath: overviewCoolPath,
            sourceResolution: plan.sourceResolution,
            targetResolution: plan.targetResolution,
            normalization,
            viewport: plan.viewport,
          },
        );
        if (!requestIsCurrent()) {
          return;
        }
        const overviewMap: ContactMapView = {
          resolution: response.resolution,
          normalization,
          viewport: response.viewport,
          cells: response.cells,
          layoutBlocks: canonicalViewAssemblyLayout.blocks,
          layoutScope: overviewScope,
          visibleLayerComplete: true,
          renderGeneration: generation,
        };
        overviewContactMapRef.current = overviewMap;
        setOverviewContactMap(overviewMap);
        requestCompleted = true;
      } catch (error) {
        if (!requestIsCurrent()) {
          return;
        }
        if (isContactTileRequestCancelled(error)) {
          scheduleRetry();
          return;
        }
        dispatchUi({
          type: "appendLog",
          message: `Overview heatmap load failed: ${String(error)}`,
        });
      } finally {
        if (activeContactOverviewRequestIdRef.current === nextRequestId) {
          activeContactOverviewRequestIdRef.current = null;
        }
        if (activeRequestId === nextRequestId) {
          activeRequestId = null;
        }
        requestStarted = false;
      }
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState !== "hidden") {
        void startOverviewRequest();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    void startOverviewRequest();

    return () => {
      cancelled = true;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
      if (
        activeRequestId !== null
        && activeContactOverviewRequestIdRef.current === activeRequestId
      ) {
        activeContactOverviewRequestIdRef.current = null;
      }
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [
    canonicalViewAssemblyLayout,
    canonicalViewContactLayoutBlocks,
    contactAvailableResolutions,
    contactCoolPath,
  ]);

  useEffect(() => {
    const generation = paintedContactTileGeneration;
    if (
      !contactCoolPath
      || generation === null
      || generation !== contactTileGenerationRef.current
    ) {
      return;
    }

    const resolutions = contactNormalizationPrewarmResolutions(
      resolutionToBasePairs(uiState.contact.resolution),
      contactAvailableResolutions,
      contactIsMcool,
    );
    if (resolutions.length === 0) {
      return;
    }

    let stopped = false;
    let cancelIdleTask: (() => void) | null = null;
    const requestIsCurrent = () => (
      !stopped
      && generation === contactTileGenerationRef.current
      && document.visibilityState !== "hidden"
    );

    const scheduleAttempt = () => {
      if (!requestIsCurrent() || cancelIdleTask !== null) {
        return;
      }
      cancelIdleTask = scheduleContactIdleTask(() => {
        cancelIdleTask = null;
        void runAttempt();
      });
    };

    const runAttempt = async () => {
      if (!requestIsCurrent()) {
        return;
      }
      if (
        contactTileFlightsRef.current.size > 0
        || normalizationPrewarmRequestIdRef.current !== null
        || resolutionReaderPrewarmRequestIdRef.current !== null
      ) {
        scheduleAttempt();
        return;
      }

      const requestId = contactTileBackendRequestIdRef.current + 1;
      contactTileBackendRequestIdRef.current = requestId;
      normalizationPrewarmRequestIdRef.current = requestId;
      let response: PrewarmContactNormalizationsResponse | null = null;
      try {
        response = await invoke<PrewarmContactNormalizationsResponse>(
          "prewarm_contact_normalizations",
          {
            request: {
              requestId,
              generation,
              coolPath: contactCoolPath,
              resolutions,
            },
          },
        );
      } catch (error) {
        if (requestIsCurrent() && isContactTileRequestCancelled(error)) {
          scheduleAttempt();
        }
        return;
      } finally {
        if (normalizationPrewarmRequestIdRef.current === requestId) {
          normalizationPrewarmRequestIdRef.current = null;
        }
      }

      if (!requestIsCurrent() || response === null) {
        return;
      }
      if (response.cancelled) {
        scheduleAttempt();
      } else if (response.failed > 0) {
        dispatchUi({
          type: "appendLog",
          message: `Background normalization prewarm skipped ${response.failed} unavailable calculation${response.failed === 1 ? "" : "s"}`,
        });
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState !== "hidden") {
        scheduleAttempt();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    scheduleAttempt();

    return () => {
      stopped = true;
      cancelIdleTask?.();
      const requestId = normalizationPrewarmRequestIdRef.current;
      if (requestId !== null) {
        normalizationPrewarmRequestIdRef.current = null;
        void invoke("cancel_contact_normalization_prewarm", {
          request: { requestId },
        }).catch(() => undefined);
      }
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [
    contactAvailableResolutions,
    contactCoolPath,
    contactIsMcool,
    paintedContactTileGeneration,
    uiState.contact.resolution,
  ]);

  useEffect(() => {
    if (backgroundAssemblyLayout.blocks.length === 0 || (!dataset?.coverage_path && coverageRecords.length === 0)) {
      setCoverageView(null);
      return;
    }

    let cancelled = false;
    const renderGeneration = contactTileGenerationRef.current;
    const totalSpanBp = Math.max(1, backgroundAssemblyLayout.totalSpan);
    const viewport = buildCenteredContactViewport({
      centerMb: uiState.contact.viewportCenterXMb,
      centerXMb: uiState.contact.viewportCenterXMb,
      totalSpanBp,
      windowSizeBp: uiState.contact.viewportSpanMb * 1_000_000,
      viewportWidthPx: uiState.contact.viewportWidthPx,
      viewportHeightPx: uiState.contact.viewportHeightPx,
    });
    const displayResolution = contactResolutionToBasePairs(uiState.contact.resolution);
    const coverageLayoutBlocks = placeHiddenChromosomeBlocksAfter(
      backgroundAssemblyLayout,
      Math.ceil(viewport.xEnd / displayResolution) * displayResolution,
    );
    const request = buildCoverageViewRequest(
      coverageRecords,
      coverageLayoutBlocks,
      totalSpanBp,
      {
        displayResolution,
        viewport,
      },
    );
    const coveragePromise = coverageRecords.length > 0
      ? invoke<CoverageView>("build_coverage_view", { request })
      : invoke<CoverageView>("build_coverage_view_from_bedgraph", {
          request: {
            bedgraphPath: dataset?.coverage_path,
            displayResolution: request.displayResolution,
            viewport: request.viewport,
            layoutBlocks: request.layoutBlocks,
          },
        });

    coveragePromise
      .then((view) => {
        if (!cancelled && renderGeneration === contactTileGenerationRef.current) {
          setCoverageView({ ...view, renderGeneration });
        }
      })
      .catch((error) => {
        if (cancelled || renderGeneration !== contactTileGenerationRef.current) {
          return;
        }
        if (coverageRecords.length > 0) {
          setCoverageView({
            ...buildBrowserCoverageView(request),
            renderGeneration,
          });
          return;
        }
        setCoverageView(null);
        dispatchUi({ type: "appendLog", message: `Coverage load failed: ${String(error)}` });
      });

    return () => {
      cancelled = true;
    };
  }, [
    backgroundAssemblyLayout,
    contactAvailableResolutions,
    coverageRecords,
    dataset?.coverage_path,
    uiState.contact.colorScale.auto,
    uiState.contact.colorScale.log,
    uiState.contact.resolution,
    uiState.contact.viewportCenterXMb,
    uiState.contact.viewportSpanMb,
    uiState.contact.viewportWidthPx,
    uiState.contact.viewportHeightPx,
    uiState.normalization,
  ]);

  useEffect(() => {
    if (!backgroundAssemblyLayout.blocks.length || (!pafPath && pafRecords.length === 0)) {
      setSyntenyView(null);
      return;
    }

    let cancelled = false;
    const totalSpanBp = Math.max(1, backgroundAssemblyLayout.totalSpan);
    const viewport = buildSyntenyViewport({
      centerXMb: uiState.contact.viewportCenterXMb,
      totalSpanBp,
      windowSizeBp: uiState.contact.viewportSpanMb * 1_000_000,
      viewportWidthPx: uiState.contact.viewportWidthPx,
      viewportHeightPx: uiState.contact.viewportHeightPx,
    });
    const syntenyLayoutBlocks = placeHiddenChromosomeBlocksAfter(
      backgroundAssemblyLayout,
      viewport.xEnd,
    );
    const request = buildSyntenyViewRequest({
      pafRecords: pafPath ? [] : pafRecords,
      viewport,
      layoutBlocks: syntenyLayoutBlocks,
    });

    if (!pafPath && request.pafRecords.length === 0) {
      setSyntenyView(null);
      return;
    }

    const syntenyPromise = pafPath
      ? invoke<SyntenyView>("build_synteny_view_from_paf", {
          request: {
            pafPath,
            viewport: request.viewport,
            layoutBlocks: request.layoutBlocks,
            minMapq: request.minMapq,
            minAlignmentLen: request.minAlignmentLen,
            maxQueryGap: request.maxQueryGap,
            maxTargetGap: request.maxTargetGap,
          },
        })
      : invoke<SyntenyView>("build_synteny_view", { request });

    syntenyPromise
      .then((view) => {
        if (!cancelled) {
          setSyntenyView(view);
        }
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        if (!pafPath) {
          setSyntenyView(buildBrowserSyntenyView(request));
          return;
        }
        setSyntenyView(null);
        dispatchUi({ type: "appendLog", message: `PAF load failed: ${String(error)}` });
      });

    return () => {
      cancelled = true;
    };
  }, [
    backgroundAssemblyLayout,
    pafPath,
    pafRecords,
    uiState.contact.viewportCenterXMb,
    uiState.contact.viewportSpanMb,
    uiState.contact.viewportWidthPx,
    uiState.contact.viewportHeightPx,
  ]);

  async function loadExamples() {
    setCoverageView(null);
    setSyntenyView(null);
    try {
      const [summary, gfaText] = await Promise.all([
        invoke<ExampleDatasetSummary>("load_example_dataset"),
        invoke<string>("load_example_gfa_text"),
      ]);
      const preparedPaf = summary.paf_path
        ? await invoke<PreparedPafFile>("prepare_paf_file", { path: summary.paf_path })
        : null;
      const importedDataset = ensureImportedDataset(summary);
      sourceAgpRef.current = sourceAgpSnapshot(
        importedDataset.agp_layout,
        importedDataset.agp_path,
      );
      savedAgpPathRef.current = null;
      setSavedAgpPath(null);
      const canonicalAgp = exportAgpText(importedDataset.agp_layout.blocks);
      setSavedAgpText(canonicalAgp);
      setSavedHistoryIdentity(emptyOperationHistoryIdentity());
      setDataset(importedDataset);
      setContactAvailableResolutions(importedDataset.available_resolutions ?? []);
      setContactSources(importedDataset.contact_sources ?? []);
      setCoverageRecords([]);
      setPafPath(importedDataset.paf_path);
      setPafRecords(preparedPaf?.records ?? []);
      setPafImported(Boolean(importedDataset.paf_path));
      setGfaDocument(parseGfaText(gfaText, "hifi.asm.bp.p_utg.noseq.gfa"));
      dispatchUi({ type: "setAssemblyBlocks", blocks: importedDataset.agp_layout.blocks });
      dispatchUi({ type: "setOverviewMode", mode: "overview" });
      dispatchUi({
        type: "fitContactViewport",
        totalSpanMb: importedDataset.agp_layout.totalSpan / 1_000_000,
      });
      setStatusMessage("Example dataset loaded with coverage, PAF and GFA");
      dispatchUi({
        type: "appendLog",
        message: "Example dataset loaded: assembly, contact map, coverage, PAF and GFA",
      });
    } catch {
      const example = await loadBrowserExampleBundle();
      const pafPreview = buildPafSyntenyPreview(example.pafText);
      sourceAgpRef.current = sourceAgpSnapshot(
        example.dataset.agp_layout,
        example.dataset.agp_path,
      );
      savedAgpPathRef.current = null;
      setSavedAgpPath(null);
      const canonicalAgp = exportAgpText(example.dataset.agp_layout.blocks);
      setSavedAgpText(canonicalAgp);
      setSavedHistoryIdentity(emptyOperationHistoryIdentity());
      setDataset(example.dataset);
      setContactAvailableResolutions(example.dataset.available_resolutions ?? [1_000]);
      setContactSources(example.dataset.contact_sources ?? []);
      setCoverageRecords(example.coverageRecords);
      setPafPath(null);
      setPafRecords(pafPreview.records);
      setPafImported(true);
      setGfaDocument(example.gfaDocument);
      dispatchUi({ type: "setAssemblyBlocks", blocks: example.dataset.agp_layout.blocks });
      dispatchUi({ type: "setOverviewMode", mode: "overview" });
      dispatchUi({
        type: "fitContactViewport",
        totalSpanMb: example.dataset.agp_layout.totalSpan / 1_000_000,
      });
      setStatusMessage("Example dataset loaded with coverage, PAF and GFA in browser preview");
      dispatchUi({
        type: "appendLog",
        message: `Example dataset loaded in browser preview: ${example.coverageRecords.length.toLocaleString()} coverage records, ${pafPreview.inputAlignmentCount.toLocaleString()} PAF alignments and ${example.gfaDocument.summary.segmentCount.toLocaleString()} GFA segments`,
      });
    }
  }

  function restoreImportedHistory(
    historyText: string | null,
    canonicalAgp: string,
    historyName: string,
  ): OperationHistoryArchive | null {
    if (!historyText) return null;
    try {
      return parseOperationHistory(historyText, canonicalAgp);
    } catch (error) {
      dispatchUi({
        type: "appendLog",
        message: `History sidecar ignored (${historyName}): ${String(error)}`,
      });
      return null;
    }
  }

  function dispatchAssemblyImport(
    blocks: ContactMapLayoutBlock[],
    history: OperationHistoryArchive | null,
  ) {
    if (!history) {
      dispatchUi({ type: "setAssemblyBlocks", blocks });
      return;
    }
    dispatchUi({
      type: "restoreAssemblyHistory",
      blocks,
      operationHistory: history.operationHistory,
      redoStack: history.redoStack,
      nextOperationId: history.nextOperationId,
    });
  }

  async function importAgpFile(file: File) {
    const text = await readImportedTextFile(file);
    const summary = summarizeAgpText(text);
    const agpLayout = parseAgpLayout(text);

    sourceAgpRef.current = sourceAgpSnapshot(agpLayout, file.name);
    savedAgpPathRef.current = null;
    setSavedAgpPath(null);
    const canonicalAgp = exportAgpText(agpLayout.blocks);
    setSavedAgpText(canonicalAgp);
    setSavedHistoryIdentity(emptyOperationHistoryIdentity());
    setDataset((current) => ({
      ...buildDatasetSummary({
        agpPath: file.name,
        mcoolPath: current?.mcool_path ?? "",
        coolPath: current?.cool_path ?? "",
        agpLines: summary.lineCount,
        agpObjects: summary.objectCount,
        agpComponents: summary.componentCount,
        agpGaps: summary.gapCount,
        maxObjectSpan: summary.maxObjectSpan,
        mcoolSizeBytes: current?.mcool_size_bytes ?? 0,
        coveragePath: current?.coverage_path ?? null,
        agpLayout,
        availableResolutions: current?.available_resolutions,
        contactSources: current?.contact_sources,
      }),
    }));
    dispatchUi({ type: "setAssemblyBlocks", blocks: agpLayout.blocks });
    dispatchUi({
      type: "fitContactViewport",
      totalSpanMb: agpLayout.totalSpan / 1_000_000,
    });
    setStatusMessage(`AGP imported: ${file.name}`);
    dispatchUi({ type: "appendLog", message: `AGP imported: ${file.name}` });
  }

  async function requestAgpFile() {
    if (!("__TAURI_INTERNALS__" in window)) {
      agpInputRef.current?.click();
      return;
    }
    try {
      const path = await open({
        title: "Select an AGP assembly",
        multiple: false,
        directory: false,
        filters: [
          { name: "AGP files", extensions: ["agp", "txt", "gz"] },
        ],
      });
      if (!path) {
        setStatusMessage("AGP import canceled");
        return;
      }
      const bundle = await invoke<ImportedAgpBundle>("load_agp_bundle", { path });
      const summary = summarizeAgpText(bundle.agp.text);
      const agpLayout = parseAgpLayout(bundle.agp.text);
      const canonicalAgp = exportAgpText(agpLayout.blocks);
      const restoredHistory = restoreImportedHistory(
        bundle.history?.text ?? null,
        canonicalAgp,
        bundle.history?.name ?? operationHistoryFilename(bundle.agp.name),
      );

      sourceAgpRef.current = sourceAgpSnapshot(agpLayout, bundle.agp.path);
      savedAgpPathRef.current = null;
      setSavedAgpPath(null);
      setSavedAgpText(canonicalAgp);
      setSavedHistoryIdentity(historyIdentityForArchive(restoredHistory));
      setDataset((current) => buildDatasetSummary({
        agpPath: bundle.agp.path,
        mcoolPath: current?.mcool_path ?? "",
        coolPath: current?.cool_path ?? "",
        agpLines: summary.lineCount,
        agpObjects: summary.objectCount,
        agpComponents: summary.componentCount,
        agpGaps: summary.gapCount,
        maxObjectSpan: summary.maxObjectSpan,
        mcoolSizeBytes: current?.mcool_size_bytes ?? 0,
        coveragePath: current?.coverage_path ?? null,
        agpLayout,
        availableResolutions: current?.available_resolutions,
        contactSources: current?.contact_sources,
      }));
      dispatchAssemblyImport(agpLayout.blocks, restoredHistory);
      dispatchUi({ type: "fitContactViewport", totalSpanMb: agpLayout.totalSpan / 1_000_000 });
      const historyCount = restoredHistory
        ? restoredHistory.operationHistory.length + restoredHistory.redoStack.length
        : 0;
      const historySuffix = historyCount > 0 ? ` with ${historyCount} history operation${historyCount === 1 ? "" : "s"}` : "";
      setStatusMessage(`AGP imported: ${bundle.agp.name}${historySuffix}`);
      dispatchUi({
        type: "appendLog",
        message: `AGP imported: ${bundle.agp.name}${historySuffix}`,
      });
    } catch (error) {
      setStatusMessage(`AGP import failed: ${String(error)}`);
      dispatchUi({ type: "appendLog", message: `AGP import failed: ${String(error)}` });
    }
  }

  async function importGfaFile(file: File) {
    try {
      const document = parseGfaText(await readImportedTextFile(file), file.name);
      if (document.summary.segmentCount === 0) {
        throw new Error("no S records found");
      }
      setGfaDocument(document);
      dispatchUi({ type: "setOverviewMode", mode: "overview" });
      setStatusMessage(
        `GFA imported: ${file.name} (${document.summary.segmentCount.toLocaleString()} segments)`,
      );
      dispatchUi({
        type: "appendLog",
        message: `GFA evidence imported: ${file.name}; ${document.summary.segmentCount.toLocaleString()} segments, ${document.summary.linkCount.toLocaleString()} links, ${document.summary.aRecordCount.toLocaleString()} A records`,
      });
    } catch (error) {
      setStatusMessage(`GFA import failed: ${String(error)}`);
      dispatchUi({ type: "appendLog", message: `GFA import failed: ${String(error)}` });
    }
  }

  async function importContactFile() {
    try {
      const path = await open({
        title: "Select a .cool or .mcool contact map",
        multiple: false,
        directory: false,
        filters: [{ name: "Contact maps", extensions: ["cool", "mcool"] }],
      });
      if (!path) {
        setStatusMessage("Contact map import canceled");
        return;
      }
      const selected = await invoke<ImportedContactFile>("load_contact_file", { path });

      setDataset((current) => ({
        ...buildDatasetSummary({
          agpPath: current?.agp_path ?? "",
          mcoolPath: selected.name,
          coolPath: selected.path,
          agpLines: current?.agp_lines ?? 0,
          agpObjects: current?.agp_objects ?? 0,
          agpComponents: current?.agp_components ?? 0,
          agpGaps: current?.agp_gaps ?? 0,
          maxObjectSpan: current?.max_object_span ?? 0,
          mcoolSizeBytes: selected.size_bytes,
          coveragePath: current?.coverage_path ?? null,
          agpLayout: current?.agp_layout ?? emptyAgpLayout(),
          availableResolutions: selected.available_resolutions,
          contactSources: selected.sources,
        }),
      }));
      setContactAvailableResolutions(selected.available_resolutions ?? []);
      setContactSources(selected.sources ?? []);
      setStatusMessage(`Contact map imported: ${selected.name}`);
      dispatchUi({ type: "appendLog", message: `Contact map imported: ${selected.name}` });
    } catch (error) {
      setStatusMessage(`Contact map import failed: ${String(error)}`);
      dispatchUi({
        type: "appendLog",
        message: `Contact map import failed: ${String(error)}`,
      });
    }
  }

  async function loadProjectDirectory() {
    let loadStage = "directory scan";
    try {
      const path = await open({
        title: "Select a C-Studio project folder",
        multiple: false,
        directory: true,
      });
      if (!path) {
        setStatusMessage("Project load canceled");
        return;
      }
      const project = await invoke<ImportedProjectDirectory>("load_project_directory", { path });
      clearAllLoadedData(false);

      const loaded: string[] = [];
      let agpLayout = emptyAgpLayout();
      let agpSummary: ReturnType<typeof summarizeAgpText> | null = null;

      if (project.agp) {
        loadStage = "AGP (1/5)";
        setStatusMessage(`Loading project 1/5: AGP — ${project.agp.name}`);
        await yieldToProjectLoadPaint();
        const bundle = await invoke<ImportedAgpBundle>("load_agp_bundle", {
          path: project.agp.path,
        });
        agpLayout = parseAgpLayout(bundle.agp.text);
        agpSummary = summarizeAgpText(bundle.agp.text);
        const canonicalAgp = exportAgpText(agpLayout.blocks);
        const restoredHistory = restoreImportedHistory(
          bundle.history?.text ?? null,
          canonicalAgp,
          bundle.history?.name ?? operationHistoryFilename(bundle.agp.name),
        );

        // A loaded source file is not a user-confirmed save destination. The
        // first explicit Save must ask where the edited AGP should be written.
        savedAgpPathRef.current = null;
        sourceAgpRef.current = sourceAgpSnapshot(agpLayout, bundle.agp.path);
        setSavedAgpPath(null);
        setSavedAgpText(canonicalAgp);
        setSavedHistoryIdentity(historyIdentityForArchive(restoredHistory));
        dispatchAssemblyImport(agpLayout.blocks, restoredHistory);
        dispatchUi({ type: "setOverviewMode", mode: "overview" });
        dispatchUi({ type: "fitContactViewport", totalSpanMb: agpLayout.totalSpan / 1_000_000 });
        setDataset(buildDatasetSummary({
          agpPath: bundle.agp.path,
          mcoolPath: "",
          coolPath: "",
          pafPath: null,
          agpLines: agpSummary.lineCount,
          agpObjects: agpSummary.objectCount,
          agpComponents: agpSummary.componentCount,
          agpGaps: agpSummary.gapCount,
          maxObjectSpan: agpSummary.maxObjectSpan,
          mcoolSizeBytes: 0,
          coveragePath: null,
          agpLayout,
          availableResolutions: [],
          contactSources: [],
        }));
        loaded.push(bundle.agp.name);
        if (bundle.history) loaded.push(bundle.history.name);
        dispatchUi({ type: "appendLog", message: `Project stage 1/5 complete: AGP ${bundle.agp.name}` });
      }

      if (project.contact) {
        loadStage = "MCOOL (2/5)";
        setStatusMessage(`Loading project 2/5: contact map — ${project.contact.name}`);
        await yieldToProjectLoadPaint();
        const contact = await invoke<ImportedContactFile>("load_contact_file", {
          path: project.contact.path,
        });
        setDataset((current) => buildDatasetSummary({
          agpPath: current?.agp_path ?? project.agp?.path ?? "",
          mcoolPath: contact.name,
          coolPath: contact.path,
          pafPath: current?.paf_path ?? null,
          agpLines: current?.agp_lines ?? agpSummary?.lineCount ?? 0,
          agpObjects: current?.agp_objects ?? agpSummary?.objectCount ?? 0,
          agpComponents: current?.agp_components ?? agpSummary?.componentCount ?? 0,
          agpGaps: current?.agp_gaps ?? agpSummary?.gapCount ?? 0,
          maxObjectSpan: current?.max_object_span ?? agpSummary?.maxObjectSpan ?? 0,
          mcoolSizeBytes: contact.size_bytes,
          coveragePath: current?.coverage_path ?? null,
          agpLayout: current?.agp_layout ?? agpLayout,
          availableResolutions: contact.available_resolutions,
          contactSources: contact.sources,
        }));
        setContactAvailableResolutions(contact.available_resolutions ?? []);
        setContactSources(contact.sources ?? []);
        loaded.push(contact.name);
        dispatchUi({ type: "appendLog", message: `Project stage 2/5 complete: contact map ${contact.name}` });
      }

      if (project.coverage) {
        loadStage = "Coverage (3/5)";
        setStatusMessage(`Loading project 3/5: coverage — ${project.coverage.name}`);
        await yieldToProjectLoadPaint();
        const coverage = await invoke<ImportedContactFile>("load_coverage_file", {
          path: project.coverage.path,
        });
        setCoverageRecords([]);
        setDataset((current) => current
          ? { ...current, coverage_path: coverage.path }
          : buildDatasetSummary({
              agpPath: project.agp?.path ?? "",
              mcoolPath: "",
              coolPath: "",
              pafPath: null,
              agpLines: agpSummary?.lineCount ?? 0,
              agpObjects: agpSummary?.objectCount ?? 0,
              agpComponents: agpSummary?.componentCount ?? 0,
              agpGaps: agpSummary?.gapCount ?? 0,
              maxObjectSpan: agpSummary?.maxObjectSpan ?? 0,
              mcoolSizeBytes: 0,
              coveragePath: coverage.path,
              agpLayout,
              availableResolutions: [],
              contactSources: [],
            }));
        loaded.push(coverage.name);
        dispatchUi({ type: "appendLog", message: `Project stage 3/5 complete: coverage ${coverage.name}` });
      }

      if (project.paf) {
        loadStage = "Synteny (4/5)";
        setStatusMessage(`Loading project 4/5: synteny — ${project.paf.name}`);
        await yieldToProjectLoadPaint();
        const paf = await invoke<PreparedPafFile>("prepare_paf_file", {
          path: project.paf.path,
        });
        setPafPath(paf.path);
        setPafRecords(paf.records);
        setPafImported(true);
        setDataset((current) => current ? { ...current, paf_path: paf.path } : current);
        loaded.push(paf.name);
        dispatchUi({ type: "appendLog", message: `Project stage 4/5 complete: synteny ${paf.name}` });
      }

      if (project.gfa) {
        loadStage = "GFA (5/5)";
        setStatusMessage(`Loading project 5/5: GFA — ${project.gfa.name}`);
        await yieldToProjectLoadPaint();
        const gfa = await invoke<ImportedProjectTextFile>("load_gfa_file", {
          path: project.gfa.path,
        });
        const gfaDocument = parseGfaText(gfa.text, gfa.name);
        gfa.text = "";
        if (gfaDocument.summary.segmentCount === 0) {
          throw new Error(`${gfa.name}: no GFA S records found`);
        }
        setGfaDocument(gfaDocument);
        loaded.push(gfa.name);
        dispatchUi({ type: "appendLog", message: `Project stage 5/5 complete: GFA ${gfa.name}` });
      }

      const skipped = project.ignoredCandidates.length;
      setStatusMessage(`Project loaded: ${loaded.join(", ")}${skipped ? `; ${skipped} duplicate candidate${skipped === 1 ? "" : "s"} skipped` : ""}`);
      dispatchUi({
        type: "appendLog",
        message: `Project folder loaded: ${project.directory}; ${loaded.join(", ")}${skipped ? `; skipped duplicate candidates: ${project.ignoredCandidates.join(", ")}` : ""}`,
      });
    } catch (error) {
      setStatusMessage(`Project load failed during ${loadStage}: ${String(error)}`);
      dispatchUi({ type: "appendLog", message: `Project load failed during ${loadStage}: ${String(error)}` });
    }
  }

  async function requestPafFile() {
    try {
      const path = await open({
        title: "Select a PAF alignment file",
        multiple: false,
        directory: false,
        filters: [{
          name: "PAF alignments",
          extensions: ["paf", "txt", "paf.gz", "txt.gz"],
        }],
      });
      if (!path) {
        setStatusMessage("PAF import canceled");
        return;
      }
      const selected = await invoke<PreparedPafFile>("prepare_paf_file", { path });
      const summary = selected.summary;
      setPafPath(selected.path);
      setPafRecords(selected.records);
      setPafImported(true);
      setStatusMessage(
        `PAF imported: ${selected.name} (${summary.alignmentCount.toLocaleString()} alignments → ${summary.chainCount.toLocaleString()} chains)`,
      );
      dispatchUi({ type: "setOverviewMode", mode: "overview" });
      dispatchUi({
        type: "appendLog",
        message: `PAF imported natively: ${selected.name} (${selected.sizeBytes.toLocaleString()} bytes); ${summary.alignmentCount.toLocaleString()} alignments → ${summary.chainCount.toLocaleString()} chains, ${summary.discardedAlignmentCount.toLocaleString()} fragments filtered`,
      });
    } catch {
      pafInputRef.current?.click();
    }
  }

  async function importPafFile(file: File) {
    const text = await readImportedTextFile(file);
    const preview = buildPafSyntenyPreview(text);
    const summary = summarizePafPreview(preview);

    setPafPath(null);
    setPafRecords(preview.records);
    setPafImported(true);
    setStatusMessage(
      `PAF imported: ${file.name} (${summary.alignmentCount.toLocaleString()} alignments → ${summary.chainCount.toLocaleString()} chains)`,
    );
    dispatchUi({ type: "setOverviewMode", mode: "overview" });
    dispatchUi({
      type: "appendLog",
      message: `PAF imported: ${file.name}; ${summary.alignmentCount.toLocaleString()} alignments → ${summary.chainCount.toLocaleString()} chains, ${summary.discardedAlignmentCount.toLocaleString()} fragments filtered, ${summary.ignoredLines.toLocaleString()} invalid lines ignored`,
    });
  }

  async function requestCoverageFile() {
    try {
      const path = await open({
        title: "Select a bedGraph coverage file",
        multiple: false,
        directory: false,
        filters: [{
          name: "Coverage tracks",
          extensions: [
            "depth",
            "bedgraph",
            "bg",
            "txt",
            "depth.gz",
            "bedgraph.gz",
            "bg.gz",
            "txt.gz",
          ],
        }],
      });
      if (!path) {
        setStatusMessage("Coverage import canceled");
        return;
      }
      const selected = await invoke<ImportedContactFile>("load_coverage_file", { path });

      setCoverageRecords([]);
      setDataset((current) => ({
        ...buildDatasetSummary({
          agpPath: current?.agp_path ?? "",
          mcoolPath: current?.mcool_path ?? "",
          coolPath: current?.cool_path ?? "",
          agpLines: current?.agp_lines ?? 0,
          agpObjects: current?.agp_objects ?? 0,
          agpComponents: current?.agp_components ?? 0,
          agpGaps: current?.agp_gaps ?? 0,
          maxObjectSpan: current?.max_object_span ?? 0,
          mcoolSizeBytes: current?.mcool_size_bytes ?? 0,
          coveragePath: selected.path,
          agpLayout: current?.agp_layout ?? emptyAgpLayout(),
          availableResolutions: current?.available_resolutions,
          contactSources: current?.contact_sources,
        }),
      }));
      setStatusMessage(`Coverage imported: ${selected.name}`);
      dispatchUi({
        type: "appendLog",
        message: `Coverage imported natively: ${selected.name} (${selected.size_bytes.toLocaleString()} bytes)`,
      });
    } catch {
      coverageInputRef.current?.click();
    }
  }

  async function importCoverageFile(file: File) {
    try {
      const records = parseBedGraphText(await readImportedTextFile(file));
      setCoverageRecords(records);
      setDataset((current) => ({
        ...buildDatasetSummary({
          agpPath: current?.agp_path ?? "",
          mcoolPath: current?.mcool_path ?? "",
          coolPath: current?.cool_path ?? "",
          agpLines: current?.agp_lines ?? 0,
          agpObjects: current?.agp_objects ?? 0,
          agpComponents: current?.agp_components ?? 0,
          agpGaps: current?.agp_gaps ?? 0,
          maxObjectSpan: current?.max_object_span ?? 0,
          mcoolSizeBytes: current?.mcool_size_bytes ?? 0,
          coveragePath: file.name,
          agpLayout: current?.agp_layout ?? emptyAgpLayout(),
          availableResolutions: current?.available_resolutions,
          contactSources: current?.contact_sources,
        }),
      }));
      setStatusMessage(`Coverage imported: ${file.name}`);
      dispatchUi({
        type: "appendLog",
        message: `Coverage imported: ${file.name} (${records.length.toLocaleString()} records)`,
      });
    } catch (error) {
      setStatusMessage(`Coverage import failed: ${String(error)}`);
      dispatchUi({ type: "appendLog", message: `Coverage import failed: ${String(error)}` });
    }
  }

  function unloadGfaData() {
    setGfaDocument(null);
    setPlacementPreview(null);
    dispatchUi({ type: "setOverviewMode", mode: "overview" });
    setStatusMessage("GFA assembly graph unloaded");
    dispatchUi({ type: "appendLog", message: "GFA assembly graph unloaded" });
    if (gfaInputRef.current) {
      gfaInputRef.current.value = "";
    }
  }

  function unloadPafData() {
    setPafPath(null);
    setPafRecords([]);
    setPafImported(false);
    setSyntenyView(null);
    setPlacementPreview(null);
    setDataset((current) => current ? { ...current, paf_path: null } : current);
    dispatchUi({ type: "setOverviewMode", mode: "overview" });
    dispatchUi({ type: "setSyntenySplitOpen", open: false });
    setStatusMessage("PAF alignments unloaded");
    dispatchUi({ type: "appendLog", message: "PAF alignments unloaded" });
    if (pafInputRef.current) {
      pafInputRef.current.value = "";
    }
  }

  function unloadCoverageData() {
    setCoverageRecords([]);
    setCoverageView(null);
    setDataset((current) => current ? { ...current, coverage_path: null } : current);
    setStatusMessage("Coverage track unloaded");
    dispatchUi({ type: "appendLog", message: "Coverage track unloaded" });
    if (coverageInputRef.current) {
      coverageInputRef.current.value = "";
    }
  }

  function unloadContactData() {
    setDataset((current) => current ? {
      ...current,
      mcool_path: "",
      cool_path: "",
      mcool_size_bytes: 0,
      available_resolutions: [],
      contact_sources: [],
    } : current);
    setContactAvailableResolutions([]);
    setContactSources([]);
    setContactMap(null);
    setOverviewContactMap(null);
    overviewContactMapRef.current = null;
    setContactGpuSourceLayout(null);
    setContactTileDeltaStream(null);
    setContactTilePreviewViewport(null);
    setPlacementPreview(null);
    setBackendStartedContactTileGeneration(null);
    setPaintedContactTileGeneration(null);
    setStatusMessage("Contact map unloaded");
    dispatchUi({ type: "appendLog", message: "Contact map unloaded" });
  }

  function clearAllLoadedData(announce = true) {
    const generation = contactTileGenerationRef.current + 1;
    contactTileGenerationRef.current = generation;
    contactTilePerformance.supersedeBefore(generation);
    contactResolutionResponsiveness.supersedeBefore(generation);
    pendingPanPerformancePreviewRef.current = null;
    pendingResolutionPerformanceRef.current = null;
    contactPanGenerationStartRef.current = null;
    contactPanPrefetchQueue.clearPending();
    contactPanPrefetchProtectedKeysRef.current = null;

    const presentationSchedule = contactTilePresentationScheduleRef.current;
    cancelContactTilePresentationSchedule(presentationSchedule);
    contactTilePresentationScheduleRef.current = null;

    contactTileCacheLru.clear();
    contactTileCacheRef.current = new Map();
    contactTileViewportResidencyHistoryRef.current = [];
    contactTileViewportResidencyScopeRef.current = null;
    contactTileFlightsRef.current.clear();
    contactMainLodTileCacheLru.clear();
    contactMainLodTileCacheRef.current = new Map();
    contactMainLodTileFlightsRef.current.clear();
    autoColorScaleCacheRef.current.clear();
    lastCompleteContactMapRef.current = null;
    placementPreviewRestoreFrameRef.current = null;
    placementReplacementPreviewActiveRef.current = false;
    overviewContactMapRef.current = null;
    contactLayoutHandleRegistryRef.current = new ContactLayoutHandleRegistry();

    sourceAgpRef.current = null;
    savedAgpPathRef.current = null;
    setSavedAgpPath(null);
    setSavedAgpText("");
    setSavedHistoryIdentity("");
    setDataset(null);
    setContactAvailableResolutions([]);
    setContactSources([]);
    setContactMap(null);
    setOverviewContactMap(null);
    setPlacementPreview(null);
    setContactTilePreviewViewport(null);
    setBackendStartedContactTileGeneration(null);
    setPaintedContactTileGeneration(null);
    setCoverageView(null);
    setCoverageRecords([]);
    setSyntenyView(null);
    setPafPath(null);
    setPafRecords([]);
    setPafImported(false);
    setGfaDocument(null);
    dispatchUi({ type: "clearLoadedData" });
    if (announce) {
      setStatusMessage("All loaded data cleared");
    }

    if (agpInputRef.current) {
      agpInputRef.current.value = "";
    }
    if (gfaInputRef.current) {
      gfaInputRef.current.value = "";
    }
    if (pafInputRef.current) {
      pafInputRef.current.value = "";
    }
    if (coverageInputRef.current) {
      coverageInputRef.current.value = "";
    }

    void invoke("begin_contact_tile_generation", {
      request: { generation, retainedRequestIds: [] },
    }).catch(() => undefined);
  }

  function reloadSourceAssembly() {
    const source = sourceAgpRef.current;
    if (!source || source.layout.blocks.length === 0) {
      setStatusMessage("No source AGP to reload");
      dispatchUi({ type: "appendLog", message: "No source AGP to reload" });
      return;
    }
    if (savingAgpRef.current) {
      setStatusMessage("AGP save is still in progress; reload canceled");
      dispatchUi({
        type: "appendLog",
        message: "Source AGP reload canceled because a save is still in progress",
      });
      return;
    }

    const layout = cloneAgpLayout(source.layout);
    savedAgpPathRef.current = null;
    setSavedAgpPath(null);
    setSavedAgpText(source.canonicalText);
    setSavedHistoryIdentity(emptyOperationHistoryIdentity());
    setDataset((current) => current ? {
      ...current,
      agp_path: source.path,
      agp_layout: layout,
    } : current);
    dispatchUi({ type: "setAssemblyBlocks", blocks: layout.blocks });
    dispatchUi({
      type: "fitContactViewport",
      totalSpanMb: layout.totalSpan / 1_000_000,
    });
    setStatusMessage(`Assembly reloaded from source AGP: ${pathBasename(source.path)}`);
    dispatchUi({
      type: "appendLog",
      message: `Assembly edits discarded; source AGP reloaded: ${source.path}`,
    });
  }

  async function exportEditedAgp(
    options: { automatic?: boolean; saveAs?: boolean } = {},
  ): Promise<boolean> {
    if (assemblyLayout.blocks.length === 0) {
      setStatusMessage("No AGP layout to save");
      dispatchUi({ type: "appendLog", message: "No AGP layout to save" });
      return false;
    }
    if (savingAgpRef.current) {
      setStatusMessage("AGP save is already in progress");
      dispatchUi({ type: "appendLog", message: "AGP save request ignored: save already in progress" });
      return false;
    }

    savingAgpRef.current = true;
    const agpText = currentAgpText;
    const historyText = serializeOperationHistory({
      canonicalAgp: agpText,
      operationHistory: uiState.operationHistory,
      redoStack: uiState.redoStack,
      nextOperationId: uiState.nextOperationId,
    });
    const filename = editedAgpFilename(dataset?.agp_path ?? "assembly.agp");
    const automatic = options.automatic === true;
    const saveAs = options.saveAs === true;
    const savedStatus = automatic ? "AGP auto-saved" : saveAs ? "AGP saved as" : "AGP saved";
    try {
      const existingPath = savedAgpPathRef.current;
      const plan = agpSavePlan({ automatic, saveAs, savePath: existingPath });
      if (plan === "overwrite" && existingPath) {
        const overwritten = await invoke<boolean>("overwrite_agp_bundle", {
          path: existingPath,
          contents: agpText,
          historyContents: historyText,
        });
        if (overwritten) {
          setSavedAgpText(agpText);
          setSavedHistoryIdentity(currentHistoryIdentity);
          const message = agpBundleSavedMessage(savedStatus, existingPath);
          setStatusMessage(message);
          dispatchUi({ type: "appendLog", message });
          return true;
        }
        savedAgpPathRef.current = null;
        setSavedAgpPath(null);
        dispatchUi({
          type: "appendLog",
          message: `AGP save target is unavailable: ${existingPath}`,
        });
        if (automatic) {
          setStatusMessage("AGP auto-save target is unavailable; use Save to choose a new path");
          return false;
        }
      }
      if (plan === "unavailable") {
        setStatusMessage("AGP auto-save target is unavailable; use Save to choose a new path");
        return false;
      }

      setStatusMessage("Opening AGP save dialog…");
      dispatchUi({ type: "appendLog", message: "Opening AGP Save As dialog" });
      const selectedPath = await saveDialog({
        title: saveAs ? "Save edited AGP as" : "Save edited AGP",
        defaultPath: existingPath ?? filename,
        filters: [
          { name: "AGP files", extensions: ["agp"] },
          { name: "Text files", extensions: ["txt"] },
        ],
      });

      if (!selectedPath) {
        setStatusMessage("AGP save canceled");
        return false;
      }

      const savedPath = await invoke<string>("write_agp_bundle", {
        path: selectedPath,
        contents: agpText,
        historyContents: historyText,
      });

      savedAgpPathRef.current = savedPath;
      setSavedAgpPath(savedPath);
      setSavedAgpText(agpText);
      setSavedHistoryIdentity(currentHistoryIdentity);
      setDataset((current) => current ? { ...current, agp_path: savedPath } : current);
      const message = agpBundleSavedMessage(savedStatus, savedPath);
      setStatusMessage(message);
      dispatchUi({ type: "appendLog", message });
      return true;
    } catch (error) {
      if (savedAgpPathRef.current) {
        setStatusMessage(`AGP save failed: ${String(error)}`);
        dispatchUi({ type: "appendLog", message: `AGP save failed: ${String(error)}` });
        return false;
      }
      downloadTextFile(filename, agpText, "text/plain;charset=utf-8");
      downloadTextFile(
        operationHistoryFilename(filename),
        historyText,
        "application/json;charset=utf-8",
      );
      setSavedAgpText(agpText);
      setSavedHistoryIdentity(currentHistoryIdentity);
      setDataset((current) => current ? { ...current, agp_path: filename } : current);
      setStatusMessage(`AGP and history downloaded: ${filename}, ${operationHistoryFilename(filename)}`);
      dispatchUi({
        type: "appendLog",
        message: `AGP and history downloaded in browser preview: ${filename}, ${operationHistoryFilename(filename)}; native save failed: ${String(error)}`,
      });
      return true;
    } finally {
      savingAgpRef.current = false;
    }
  }

  useEffect(() => {
    exportEditedAgpRef.current = exportEditedAgp;
  });

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!shouldPromptForUnsavedClose({
        dirty: isAgpDirtyRef.current,
        allowClose: allowWindowCloseRef.current,
      })) {
        return;
      }
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
      return undefined;
    }

    const appWindow = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | null = null;

    const destroyWindow = async () => {
      allowWindowCloseRef.current = true;
      try {
        await appWindow.destroy();
      } catch (error) {
        allowWindowCloseRef.current = false;
        const closeError = `C-Studio could not close: ${String(error)}`;
        setStatusMessage(closeError);
        dispatchUi({ type: "appendLog", message: closeError });
      }
    };

    void appWindow.onCloseRequested(async (event) => {
      const action = windowCloseRequestAction({
        dirty: isAgpDirtyRef.current,
        allowClose: allowWindowCloseRef.current,
        promptOpen: closePromptOpenRef.current,
      });

      // Own the close lifecycle explicitly. Relying on the listener wrapper to
      // destroy a clean window made the no-changes path platform-dependent,
      // while calling close() after a decision recursively emitted this event.
      event.preventDefault();
      if (action === "destroy") {
        await destroyWindow();
        return;
      }
      if (action === "wait") {
        return;
      }
      closePromptOpenRef.current = true;

      try {
        const result = await message(
          "This assembly has unsaved AGP or operation-history changes. Save before closing C-Studio?",
          {
            title: "Unsaved changes",
            kind: "warning",
            buttons: unsavedCloseButtons,
          },
        );
        const decision = unsavedCloseDecision(result);
        if (!(await shouldContinueClosing(
          decision,
          () => exportEditedAgpRef.current(),
        ))) {
          return;
        }

        await destroyWindow();
      } catch (error) {
        const promptError = `Could not open the unsaved-changes dialog: ${String(error)}`;
        setStatusMessage(promptError);
        dispatchUi({ type: "appendLog", message: promptError });
      } finally {
        closePromptOpenRef.current = false;
      }
    }).then((stopListening) => {
      if (disposed) {
        stopListening();
      } else {
        unlisten = stopListening;
      }
    }).catch((error) => {
      const listenerError = `Could not enable the unsaved-changes close guard: ${String(error)}`;
      setStatusMessage(listenerError);
      dispatchUi({ type: "appendLog", message: listenerError });
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!shouldScheduleAgpAutoSave({
      enabled: autoSaveEnabled,
      savePath: savedAgpPath,
      dirty: isAgpDirty,
      hasBlocks: assemblyLayout.blocks.length > 0,
    })) {
      return undefined;
    }

    const timeout = window.setTimeout(() => {
      void exportEditedAgp({ automatic: true });
    }, agpAutoSaveDelayMs);
    return () => window.clearTimeout(timeout);
  }, [autoSaveEnabled, currentAgpText, currentHistoryIdentity, isAgpDirty, savedAgpPath]);

  const loadGfaEndpointHiCBatch = useCallback<GfaEndpointHiCBatchLoader>(async (requests) => {
    if (requests.length === 0) {
      return [];
    }
    if (!contactCoolPath) {
      return requests.map(() => ({
        status: "unavailable",
        reason: "Load a compatible Hi-C, Pore-C, or CiFi contact map to calculate endpoint-level 3D contact evidence.",
      }));
    }
    const blocksById = new Map(assemblyLayout.blocks.map((block) => [block.id, block]));
    const planned: Array<{
      plan?: GfaEndpointHiCQueryPlan;
      result?: GfaEndpointHiCLoadResult;
    }> = requests.map((request) => {
      const { sourceBlockId, targetBlockId } = request;
      const sourceBlock = blocksById.get(sourceBlockId);
      const targetBlock = blocksById.get(targetBlockId);
      if (!sourceBlock || !targetBlock) {
        return {
          result: {
            status: "unavailable" as const,
            reason: "One of the selected unitig occurrences is no longer present in the current AGP.",
          },
        };
      }
      const plan = planGfaEndpointHiCQuery(
        sourceBlock,
        targetBlock,
        contactAvailableResolutions,
        contactTileSizeBins,
      );
      return plan.status === "ready" ? { plan } : { result: plan };
    });
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
      return planned.map((entry) => entry.result ?? ({
        status: "unavailable",
        reason: "Endpoint 3D contacts are available in the desktop app; browser preview has no local Cooler backend.",
        resolution: entry.plan?.targetResolution,
      }));
    }

    const generation = contactTileGenerationRef.current;
    const normalization = contactNormalizationForBackend(uiState.normalization);
    const grouped = new Map<string, Array<{ index: number; plan: NonNullable<typeof planned[number]["plan"]> }>>();
    planned.forEach((entry, index) => {
      if (!entry.plan) {
        return;
      }
      const key = `${entry.plan.sourceResolution}:${entry.plan.targetResolution}:${entry.plan.tileSizeBins}`;
      const group = grouped.get(key) ?? [];
      group.push({ index, plan: entry.plan });
      grouped.set(key, group);
    });
    const results: Array<GfaEndpointHiCLoadResult | null> = planned.map(
      (entry) => entry.result ?? null,
    );
    const startedAt = performance.now();
    let backendBatchCount = 0;

    await Promise.all([...grouped.values()].map(async (group) => {
      const representative = group[0]!.plan;
      const cacheKeyForTile = createContactTileCacheKeyResolver(
        contactCoolPath,
        representative.targetResolution,
        representative.tileSizeBins,
        normalization,
        assemblyLayout.blocks,
      );
      const tilesByKey = new Map<string, ContactMapTileKey>();
      for (const { plan } of group) {
        for (const tile of plan.tiles) {
          tilesByKey.set(cacheKeyForTile(tile), tile);
        }
      }
      const requestedTiles = [...tilesByKey.values()];
      const cachedTiles = requestedTiles.flatMap((tile) => {
        const cached = endpointContactTileCacheRef.current.get(cacheKeyForTile(tile));
        return cached ? [cached] : [];
      });
      const missingTiles = requestedTiles.filter(
        (tile) => !endpointContactTileCacheRef.current.has(cacheKeyForTile(tile)),
      );
      try {
        const loadedTiles = missingTiles.length === 0
          ? []
          : await endpointContactTileFlightsRef.current.loadBatch({
            scope: contactTileScope(
              contactCoolPath,
              representative.targetResolution,
              representative.tileSizeBins,
              normalization,
              assemblyLayout.blocks,
            ),
            tiles: missingTiles,
            cacheKeyForTile,
            nextRequestId: () => {
              backendBatchCount += 1;
              const nextRequestId = contactTileBackendRequestIdRef.current + 1;
              contactTileBackendRequestIdRef.current = nextRequestId;
              return nextRequestId;
            },
            load: (requestId, tiles) => loadContactTilesWithLayoutHandle(
              contactLayoutHandleRegistry,
              contactLayoutBlocks,
              {
                requestId,
                generation,
                purpose: "endpoint_evidence",
                coolPath: contactCoolPath,
                baseResolution: representative.sourceResolution,
                targetResolution: representative.targetResolution,
                tileSizeBins: representative.tileSizeBins,
                normalization,
                tiles,
              },
            ),
          });
        for (const tile of loadedTiles) {
          endpointContactTileCacheRef.current.set(cacheKeyForTile(tile), tile);
        }
        while (endpointContactTileCacheRef.current.size > 384) {
          const oldestKey = endpointContactTileCacheRef.current.keys().next().value;
          if (typeof oldestKey !== "string") {
            break;
          }
          endpointContactTileCacheRef.current.delete(oldestKey);
        }
        if (generation !== contactTileGenerationRef.current) {
          for (const { index, plan } of group) {
            results[index] = {
              status: "unavailable",
              reason: "The assembly or contact-map view changed while endpoint evidence was loading.",
              resolution: plan.targetResolution,
            };
          }
          return;
        }
        const availableByTileKey = new Map(
          [...cachedTiles, ...loadedTiles].map((tile) => [contactTileKey(tile), tile]),
        );
        for (const { index, plan } of group) {
          const planTiles = plan.tiles.flatMap((tile) => {
            const loaded = availableByTileKey.get(contactTileKey(tile));
            return loaded ? [loaded] : [];
          });
          results[index] = {
            status: "ready",
            evidence: scoreGfaEndpointHiC(plan, planTiles, normalization),
          };
        }
      } catch (error) {
        const cancelled = isContactTileRequestCancelled(error);
        for (const { index, plan } of group) {
          results[index] = {
            status: cancelled ? "unavailable" : "error",
            reason: cancelled
              ? "Endpoint evidence was superseded by a newer assembly or contact-map view."
              : `Endpoint 3D contact query failed: ${String(error)}`,
            resolution: plan.targetResolution,
          };
        }
      }
    }));

    if (contactTileIpcPerformanceEnabled) {
      const line = [
        "CSTUDIO_PERF event=gfa_endpoint_batch",
        `pairs=${requests.length}`,
        `groups=${grouped.size}`,
        `backend_batches=${backendBatchCount}`,
        `elapsed_ms=${Math.round((performance.now() - startedAt) * 10) / 10}`,
      ].join(" ");
      console.info(line);
      void invoke("log_gfa_frontend_performance", { line }).catch(() => undefined);
    }
    return results.map((result) => result ?? ({
      status: "error",
      reason: "Endpoint 3D contact query produced no result.",
    }));
  }, [
    assemblyLayout.blocks,
    contactAvailableResolutions,
    contactCoolPath,
    contactLayoutBlocks,
    contactLayoutHandleRegistry,
    uiState.normalization,
  ]);

  const loadHiCAlleleConcordanceBatch = useCallback<HiCAlleleConcordanceBatchLoader>(async (
    requests,
  ) => {
    if (requests.length === 0) {
      return [];
    }
    if (!contactCoolPath) {
      return requests.map(() => ({
        status: "unavailable",
        reason: "Load a compatible Hi-C, Pore-C, or CiFi contact map to infer allelic contigs.",
      }));
    }
    const blocksById = new Map(assemblyLayout.blocks.map((block) => [block.id, block]));
    const planned: Array<{
      plan?: HiCAlleleConcordanceQueryPlan;
      result?: HiCAlleleConcordanceLoadResult;
    }> = requests.map((request) => {
      const { sourceBlockId, targetBlockId } = request;
      const sourceBlock = blocksById.get(sourceBlockId);
      const targetBlock = blocksById.get(targetBlockId);
      if (!sourceBlock || !targetBlock) {
        return {
          result: {
            status: "unavailable" as const,
            reason: "One of the allelic-evidence contig occurrences is no longer present in the current AGP.",
          },
        };
      }
      const plan = planHiCAlleleConcordanceQuery(
        sourceBlock,
        targetBlock,
        contactAvailableResolutions,
        contactTileSizeBins,
        undefined,
        {
          expectedOrientation: request.expectedOrientation,
          objectLineId: request.objectLineId,
          objectLineEnrichment: request.objectLineEnrichment,
        },
      );
      return plan.status === "ready" ? { plan } : { result: plan };
    });
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
      return planned.map((entry) => entry.result ?? ({
        status: "unavailable",
        reason: "Fine-resolution allelic contacts are available in the desktop app; browser preview has no local Cooler backend.",
        resolution: entry.plan?.targetResolution,
      }));
    }

    const generation = contactTileGenerationRef.current;
    // Concordance and marginal-background line scores are calibrated on link
    // counts. Always query raw contacts even when the heatmap is balanced.
    const normalization: ContactNormalization = "raw";
    const grouped = new Map<string, Array<{
      index: number;
      plan: HiCAlleleConcordanceQueryPlan;
    }>>();
    planned.forEach((entry, index) => {
      if (!entry.plan) {
        return;
      }
      const key = `${entry.plan.sourceResolution}:${entry.plan.targetResolution}:${entry.plan.tileSizeBins}`;
      const group = grouped.get(key) ?? [];
      group.push({ index, plan: entry.plan });
      grouped.set(key, group);
    });
    const results: Array<HiCAlleleConcordanceLoadResult | null> = planned.map(
      (entry) => entry.result ?? null,
    );
    const startedAt = performance.now();
    let backendBatchCount = 0;

    await Promise.all([...grouped.values()].map(async (group) => {
      const representative = group[0]!.plan;
      const cacheKeyForTile = createContactTileCacheKeyResolver(
        contactCoolPath,
        representative.targetResolution,
        representative.tileSizeBins,
        normalization,
        assemblyLayout.blocks,
      );
      const tilesByKey = new Map<string, ContactMapTileKey>();
      for (const { plan } of group) {
        for (const tile of plan.tiles) {
          tilesByKey.set(cacheKeyForTile(tile), tile);
        }
      }
      const requestedTiles = [...tilesByKey.values()];
      const cachedTiles = requestedTiles.flatMap((tile) => {
        const cached = endpointContactTileCacheRef.current.get(cacheKeyForTile(tile));
        return cached ? [cached] : [];
      });
      const missingTiles = requestedTiles.filter(
        (tile) => !endpointContactTileCacheRef.current.has(cacheKeyForTile(tile)),
      );
      try {
        const loadedTiles = missingTiles.length === 0
          ? []
          : await endpointContactTileFlightsRef.current.loadBatch({
            scope: contactTileScope(
              contactCoolPath,
              representative.targetResolution,
              representative.tileSizeBins,
              normalization,
              assemblyLayout.blocks,
            ),
            tiles: missingTiles,
            cacheKeyForTile,
            nextRequestId: () => {
              backendBatchCount += 1;
              const nextRequestId = contactTileBackendRequestIdRef.current + 1;
              contactTileBackendRequestIdRef.current = nextRequestId;
              return nextRequestId;
            },
            load: (requestId, tiles) => loadContactTilesWithLayoutHandle(
              contactLayoutHandleRegistry,
              contactLayoutBlocks,
              {
                requestId,
                generation,
                purpose: "endpoint_evidence",
                coolPath: contactCoolPath,
                baseResolution: representative.sourceResolution,
                targetResolution: representative.targetResolution,
                tileSizeBins: representative.tileSizeBins,
                normalization,
                tiles,
              },
            ),
          });
        for (const tile of loadedTiles) {
          endpointContactTileCacheRef.current.set(cacheKeyForTile(tile), tile);
        }
        while (endpointContactTileCacheRef.current.size > 384) {
          const oldestKey = endpointContactTileCacheRef.current.keys().next().value;
          if (typeof oldestKey !== "string") {
            break;
          }
          endpointContactTileCacheRef.current.delete(oldestKey);
        }
        if (generation !== contactTileGenerationRef.current) {
          for (const { index, plan } of group) {
            results[index] = {
              status: "unavailable",
              reason: "The assembly or contact-map view changed while allelic evidence was loading.",
              resolution: plan.targetResolution,
            };
          }
          return;
        }
        const availableByTileKey = new Map(
          [...cachedTiles, ...loadedTiles].map((tile) => [contactTileKey(tile), tile]),
        );
        for (const { index, plan } of group) {
          const planTiles = plan.tiles.flatMap((tile) => {
            const loaded = availableByTileKey.get(contactTileKey(tile));
            return loaded ? [loaded] : [];
          });
          results[index] = scoreHiCAlleleConcordanceQuery(
            plan,
            planTiles,
            normalization,
          );
        }
      } catch (error) {
        const cancelled = isContactTileRequestCancelled(error);
        for (const { index, plan } of group) {
          results[index] = {
            status: cancelled ? "unavailable" : "error",
            reason: cancelled
              ? "Allelic evidence was superseded by a newer assembly or contact-map view."
              : `Allelic contact query failed: ${String(error)}`,
            resolution: plan.targetResolution,
          };
        }
      }
    }));

    if (contactTileIpcPerformanceEnabled) {
      const line = [
        "CSTUDIO_PERF event=hic_allele_concordance_batch",
        `pairs=${requests.length}`,
        `groups=${grouped.size}`,
        `backend_batches=${backendBatchCount}`,
        `elapsed_ms=${Math.round((performance.now() - startedAt) * 10) / 10}`,
      ].join(" ");
      console.info(line);
      void invoke("log_gfa_frontend_performance", { line }).catch(() => undefined);
    }
    return results.map((result) => result ?? ({
      status: "error",
      reason: "Allelic contact query produced no result.",
    }));
  }, [
    assemblyLayout.blocks,
    contactAvailableResolutions,
    contactCoolPath,
    contactLayoutBlocks,
    contactLayoutHandleRegistry,
  ]);

  const loadGfaEndpointHiC = useCallback<GfaEndpointHiCLoader>(async (
    sourceBlockId,
    targetBlockId,
  ) => (await loadGfaEndpointHiCBatch([{ sourceBlockId, targetBlockId }]))[0] ?? ({
    status: "error",
    reason: "Endpoint 3D contact query produced no result.",
  }), [loadGfaEndpointHiCBatch]);

  const placementPreviewContactMap = useMemo(() => {
    const normalization = contactNormalizationForBackend(uiState.normalization);
    const sourceMaps = [
      overviewContactMap,
      placementPreviewRestoreFrameRef.current,
    ].filter((map): map is ContactMapView => Boolean(
      map?.layoutBlocks
      && (map.normalization ?? "raw") === normalization
    ));
    if (
      !contactTileReplacementPreviewActive
      || !contactTilePreviewViewport
      || !contactCoolPath
      || sourceMaps.length === 0
      || placementPreviewBlocks === assemblyLayout.blocks
    ) {
      return null;
    }
    for (const sourceMap of sourceMaps) {
      const preview = buildContactLayoutReplacementPreview({
        sourceMap,
        nextBlocks: viewAssemblyLayout.blocks,
        viewport: contactTilePreviewViewport.viewport,
        layoutScope: contactTileScope(
          contactCoolPath,
          sourceMap.resolution,
          sourceMap.tileSizeBins ?? contactTileSizeBins,
          normalization,
          viewAssemblyLayout.projectionBlocks,
        ),
        requestedResolution: resolutionToBasePairs(uiState.contact.resolution),
      });
      if (preview) {
        return preview;
      }
    }
    return null;
  }, [
    assemblyLayout.blocks,
    contactCoolPath,
    contactTilePreviewViewport,
    contactTileReplacementPreviewActive,
    overviewContactMap,
    placementPreviewBlocks,
    uiState.contact.resolution,
    uiState.normalization,
    viewAssemblyLayout.blocks,
    viewAssemblyLayout.projectionBlocks,
  ]);

  const contactMapWithSourceLayout = useMemo(() => {
    if (contactTileReplacementPreviewActive) {
      // Hold Preview must never pair the replacement camera/boundaries with a
      // retained canonical matrix. Start with the synchronously permuted
      // overview, then replace it only with a complete authoritative frame.
      const authoritativePreviewReady = Boolean(
        contactMap?.visibleLayerComplete === true
        && contactMap.layoutBlocks === viewAssemblyLayout.blocks
        && contactTilePreviewViewport
        && contactMap.viewport.xStart === contactTilePreviewViewport.viewport.xStart
        && contactMap.viewport.xEnd === contactTilePreviewViewport.viewport.xEnd
        && contactMap.viewport.yStart === contactTilePreviewViewport.viewport.yStart
        && contactMap.viewport.yEnd === contactTilePreviewViewport.viewport.yEnd
      );
      return authoritativePreviewReady
        ? contactMap
        : placementPreviewContactMap
          ?? placementPreviewRestoreFrameRef.current
          ?? contactMap;
    }
    if (
      !contactMap
      || !contactGpuSourceLayout
      || contactGpuSourceLayout.resolution !== contactMap.resolution
      || contactMap.renderGeneration === undefined
      || contactGpuSourceLayout.generation !== contactMap.renderGeneration
      || (contactMap.normalization ?? "raw")
        !== contactNormalizationForBackend(uiState.normalization)
    ) {
      return contactMap;
    }
    return { ...contactMap, sourceLayout: contactGpuSourceLayout };
  }, [
    contactGpuSourceLayout,
    contactMap,
    contactTilePreviewViewport,
    contactTileReplacementPreviewActive,
    placementPreviewContactMap,
    uiState.normalization,
    viewAssemblyLayout.blocks,
  ]);

  return (
    <AppShell
      dataset={dataset}
      contactMap={contactMapWithSourceLayout}
      contactTileDeltaStream={contactTileReplacementPreviewActive
        ? null
        : contactTileDeltaStream}
      contactIsMcool={contactIsMcool}
      contactAvailableResolutions={contactAvailableResolutions}
      overviewContactMap={
        contactOverviewEnabled && contactOverviewRenderEnabled ? overviewContactMap : null
      }
      syntenyView={syntenyView}
      coverageView={coverageView}
      pafRecords={pafRecords}
      pafImported={pafImported}
      gfaDocument={gfaDocument}
      onLayoutGfaBandage={loadGfaBandageLayout}
      onLoadGfaEndpointHiC={loadGfaEndpointHiC}
      onLoadGfaEndpointHiCBatch={loadGfaEndpointHiCBatch}
      onLoadHiCAlleleConcordanceBatch={loadHiCAlleleConcordanceBatch}
      gfaHomologPattern={gfaHomologPattern}
      onGfaHomologPatternChange={setGfaHomologPattern}
      chromosomeVisibility={chromosomeVisibility}
      hiddenChromosomeIds={hiddenChromosomeIds}
      chromosomeFilterPattern={chromosomeFilterPattern}
      includeUnanchoredInChromosomeFilter={includeUnanchoredInChromosomeFilter}
      viewAssemblyBlocks={viewAssemblyLayout.blocks}
      onPlacementPreviewChange={setPlacementPreview}
      contactViewportPreview={contactTilePreviewViewport}
      onHiddenChromosomeIdsChange={setHiddenChromosomeIds}
      onChromosomeFilterPatternChange={setChromosomeFilterPattern}
      onIncludeUnanchoredInChromosomeFilterChange={setIncludeUnanchoredInChromosomeFilter}
      agpInputRef={agpInputRef}
      gfaInputRef={gfaInputRef}
      pafInputRef={pafInputRef}
      coverageInputRef={coverageInputRef}
      onAgpFileRequested={requestAgpFile}
      onAgpFileSelected={importAgpFile}
      onGfaFileSelected={importGfaFile}
      onContactFileSelected={importContactFile}
      onPafFileRequested={requestPafFile}
      onPafFileSelected={importPafFile}
      onCoverageFileRequested={requestCoverageFile}
      onCoverageFileSelected={importCoverageFile}
      onExportAgp={() => { void exportEditedAgp(); }}
      onExportAgpAs={() => { void exportEditedAgp({ saveAs: true }); }}
      autoSaveEnabled={autoSaveEnabled}
      autoSaveAvailable={savedAgpPath !== null}
      isAgpDirty={isAgpDirty}
      onAutoSaveEnabledChange={setAutoSaveEnabled}
      onLoadExample={loadExamples}
      onLoadProject={loadProjectDirectory}
      onReloadAssembly={reloadSourceAssembly}
      onUnloadGfa={unloadGfaData}
      onUnloadContact={unloadContactData}
      onUnloadPaf={unloadPafData}
      onUnloadCoverage={unloadCoverageData}
      onClearAllData={clearAllLoadedData}
      status={status}
      statusMessage={statusMessage}
      contactTilePerformanceLog={contactTilePerformanceLog}
      contactPanPerformanceLog={contactPanPerformanceLog}
      uiState={uiState}
      onUiAction={dispatchMeasuredUiAction}
      onContactPanGestureStart={suspendContactTileLoadingForPan}
      onContactPanTilePrefetch={handleContactPanTilePrefetch}
      onContactViewportPreview={handleContactViewportPreview}
      onContactResolutionPreview={handleContactResolutionPreview}
      contactPanPrefetchBridge={contactPanPrefetchBridge}
      onContactTileLayerCommit={handleContactTileLayerCommit}
      onContactTileLayerPaintComplete={handleContactTileLayerPaintComplete}
    />
  );
}

export interface BrowserExampleBundle {
  dataset: ExampleDatasetSummary;
  coverageRecords: BedGraphRecord[];
  pafText: string;
  gfaDocument: GfaEvidenceDocument;
}

export async function loadBrowserExampleBundle(
  fetchResource: (path: string) => Promise<Response> = (path) => fetch(path),
): Promise<BrowserExampleBundle> {
  const [agpText, coverageText, pafText, gfaText] = await Promise.all([
    fetchExampleText(fetchResource, "/examples/groups.agp", "example AGP"),
    fetchExampleText(
      fetchResource,
      "/examples/hifi.asm.bp.p_utg.noseq.depth",
      "example coverage",
    ),
    fetchExampleText(fetchResource, "/examples/mono.hifi.asm.bp.p_utg.paf", "example PAF"),
    fetchExampleText(fetchResource, "/examples/hifi.asm.bp.p_utg.noseq.gfa", "example GFA"),
  ]);
  const summary = summarizeAgpText(agpText);

  return {
    dataset: buildDatasetSummary({
      agpPath: "examples/groups.agp",
      mcoolPath: "examples/input.1k_allres.mcool",
      coolPath: "",
      pafPath: "examples/mono.hifi.asm.bp.p_utg.paf",
      agpLines: summary.lineCount,
      agpObjects: summary.objectCount,
      agpComponents: summary.componentCount,
      agpGaps: summary.gapCount,
      maxObjectSpan: summary.maxObjectSpan,
      mcoolSizeBytes: 69_849_053,
      coveragePath: "examples/hifi.asm.bp.p_utg.noseq.depth",
      agpLayout: parseAgpLayout(agpText),
      availableResolutions: [
        2_500_000,
        2_000_000,
        1_000_000,
        500_000,
        250_000,
        100_000,
        50_000,
        25_000,
        10_000,
        5_000,
        1_000,
      ],
    }),
    coverageRecords: parseBedGraphText(coverageText),
    pafText,
    gfaDocument: parseGfaText(gfaText, "hifi.asm.bp.p_utg.noseq.gfa"),
  };
}

async function fetchExampleText(
  fetchResource: (path: string) => Promise<Response>,
  path: string,
  label: string,
) {
  const response = await fetchResource(path);
  if (!response.ok) {
    throw new Error(`Failed to load ${label}: ${response.status}`);
  }
  return response.text();
}

interface DatasetSummaryInput {
  agpPath: string;
  mcoolPath: string;
  coolPath: string;
  pafPath?: string | null;
  agpLines: number;
  agpObjects: number;
  agpComponents: number;
  agpGaps: number;
  maxObjectSpan: number;
  mcoolSizeBytes: number;
  coveragePath: string | null;
  agpLayout: AgpLayout;
  availableResolutions?: number[];
  contactSources?: ContactSourceMetadata[];
}

function buildDatasetSummary(input: DatasetSummaryInput): ExampleDatasetSummary {
  return {
    agp_path: input.agpPath,
    mcool_path: input.mcoolPath,
    cool_path: input.coolPath,
    paf_path: input.pafPath ?? null,
    agp_lines: input.agpLines,
    agp_objects: input.agpObjects,
    agp_components: input.agpComponents,
    agp_gaps: input.agpGaps,
    max_object_span: input.maxObjectSpan,
    mcool_size_bytes: input.mcoolSizeBytes,
    coverage_path: input.coveragePath,
    agp_layout: input.agpLayout,
    available_resolutions: input.availableResolutions,
    contact_sources: input.contactSources,
  };
}

function ensureImportedDataset(summary: ExampleDatasetSummary): ExampleDatasetSummary {
  return buildDatasetSummary({
    agpPath: summary.agp_path,
    mcoolPath: summary.mcool_path,
    coolPath: summary.cool_path || summary.mcool_path,
    pafPath: summary.paf_path,
    agpLines: summary.agp_lines,
    agpObjects: summary.agp_objects,
    agpComponents: summary.agp_components,
    agpGaps: summary.agp_gaps,
    maxObjectSpan: summary.max_object_span,
    mcoolSizeBytes: summary.mcool_size_bytes,
    coveragePath: summary.coverage_path,
    agpLayout: normalizeImportedAgpLayout(summary.agp_layout ?? emptyAgpLayout()),
    availableResolutions: summary.available_resolutions,
    contactSources: summary.contact_sources,
  });
}

function summarizeSourceIds(sourceIds: ReadonlyArray<string>, limit = 8) {
  const shown = sourceIds.slice(0, limit).join(", ");
  const remaining = sourceIds.length - Math.min(sourceIds.length, limit);
  return remaining > 0 ? `${shown} (+${remaining.toLocaleString()} more)` : shown;
}

function emptyAgpLayout(): AgpLayout {
  return emptyLayout;
}

function cloneAgpLayout(layout: AgpLayout): AgpLayout {
  return {
    totalSpan: layout.totalSpan,
    blocks: layout.blocks.map((block) => ({
      ...block,
      gapBefore: block.gapBefore ? { ...block.gapBefore } : undefined,
      gfaOverlapBefore: block.gfaOverlapBefore ? { ...block.gfaOverlapBefore } : undefined,
      splitParent: block.splitParent ? { ...block.splitParent } : undefined,
    })),
  };
}

function sourceAgpSnapshot(
  layout: AgpLayout,
  path: string,
): SourceAgpSnapshot {
  const sourceLayout = cloneAgpLayout(layout);
  return {
    path,
    layout: sourceLayout,
    canonicalText: exportAgpText(sourceLayout.blocks),
  };
}

function editedAgpFilename(path: string) {
  const basename = path.split(/[\\/]/).filter(Boolean).pop() ?? "assembly.agp";
  return basename.replace(/(?:\.agp|\.txt)?$/i, ".edited.agp");
}

function agpBundleSavedMessage(status: string, agpPath: string) {
  return `${status}: ${agpPath}; history: ${operationHistoryFilename(agpPath)}`;
}

function operationHistoryIdentity(history: OperationHistoryArchive) {
  return [
    history.nextOperationId,
    history.operationHistory.map((operation) => operation.id).join(","),
    history.redoStack.map((operation) => operation.id).join(","),
  ].join("|");
}

function historyIdentityForArchive(history: OperationHistoryArchive | null) {
  return operationHistoryIdentity(history ?? {
    operationHistory: [],
    redoStack: [],
    nextOperationId: 1,
  });
}

function emptyOperationHistoryIdentity() {
  return historyIdentityForArchive(null);
}

function pathBasename(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? "assembly.edited.agp";
}

function readAutoSavePreference() {
  try {
    return typeof localStorage !== "undefined"
      && localStorage.getItem(autoSavePreferenceKey) === "true";
  } catch {
    return false;
  }
}

function persistAutoSavePreference(enabled: boolean) {
  try {
    localStorage.setItem(autoSavePreferenceKey, String(enabled));
  } catch {
    // Auto-save still works for this session when preference storage is unavailable.
  }
}

function downloadTextFile(filename: string, text: string, type: string) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function totalVisualSpan(blocks: AgpLayout["blocks"], fallback: number) {
  const finiteFallback = Number.isFinite(fallback) ? fallback : 0;
  if (blocks.length === 0) {
    return Math.max(0, finiteFallback);
  }

  const finiteBlockEnds = blocks
    .map((block) => block.visualEnd)
    .filter((visualEnd) => Number.isFinite(visualEnd));

  return Math.max(0, ...finiteBlockEnds);
}

function resolutionToBasePairs(resolution: ContactResolution) {
  return contactResolutionToBasePairs(resolution);
}

function formatBasePairResolution(resolution: number) {
  if (resolution >= 1_000_000) {
    return `${Number((resolution / 1_000_000).toFixed(2))} Mb`;
  }
  if (resolution >= 1_000) {
    return `${Number((resolution / 1_000).toFixed(2))} kb`;
  }
  return `${resolution} bp`;
}

function formatViewportLabel(viewport: { xStart: number; xEnd: number }) {
  return `${Math.round(viewport.xStart / 1_000_000).toLocaleString()}-${Math.round(
    viewport.xEnd / 1_000_000,
  ).toLocaleString()} Mb`;
}

function hasContactMapData(contactMap: ContactMapView) {
  return contactMap.cells.length > 0
    || (contactMap.tiles?.length ?? 0) > 0
    || (contactMap.cachedTiles?.length ?? 0) > 0;
}

function useDebouncedValue<T>(value: T, delayMs: number) {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedValue(value), delayMs);
    return () => window.clearTimeout(timeout);
  }, [delayMs, value]);

  return debouncedValue;
}
