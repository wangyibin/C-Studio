import { Channel, invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AppShell } from "./components/AppShell";
import { exportAgpText } from "./state/agpExport";
import { agpAutoSaveDelayMs, shouldScheduleAgpAutoSave } from "./state/agpAutoSave";
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
import { contactTileCellCount } from "./state/contactTileData";
import {
  ContactTileDeltaAccumulator,
  type ContactTileDeltaRenderStream,
} from "./state/contactTileDelta";
import {
  displayContactMapForPendingLayer,
  shouldHoldPreviousContactMapFrame,
  shouldPublishContactMapLayer,
} from "./state/contactMapView";
import {
  createContactPanPerformanceTracker,
  type ContactPanPreview,
} from "./state/contactPanPerformance";
import { contactResolutionToBasePairs } from "./state/contactResolution";
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
  contactTileSizeBins,
} from "./state/contactTiles";
import {
  contactTileRenderCache,
  ContactTileResolutionLru,
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
import {
  adjacentContactResolutions,
  interleaveContactPrefetchBatches,
  scheduleContactIdleTask,
} from "./state/contactResolutionPrefetch";
import {
  buildContactOverviewTilePlan,
  contactOverviewGenerationIsReady,
  contactOverviewRequestIsReady,
  shouldResumeContactBackgroundSchedulingAfterFailure,
} from "./state/contactOverviewTiles";
import {
  buildContactMainLodPlan,
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
import { parseGfaText, type GfaEvidenceDocument } from "./state/gfa";
import { defaultGfaHomologPattern } from "./state/gfaHomologLayout";
import { summarizePafText } from "./state/pafPreview";
import {
  buildBrowserSyntenyView,
  buildSyntenyViewRequest,
  buildSyntenyViewport,
  type SyntenyView,
} from "./state/syntenyView";
import {
  contactNormalizationForBackend,
  availableContactResolutions,
  createInitialUiState,
  reduceUiState,
  type ContactNormalization,
  type ContactResolution,
  type UiAction,
} from "./state/uiState";

export interface AppStatus {
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
}

export interface ContactMapCell {
  xBin: number;
  yBin: number;
  count: number;
}

export interface ContactMapView {
  resolution: number;
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
  /** Layout snapshot used to produce this visual layer. */
  layoutBlocks?: ContactMapLayoutBlock[];
  layoutScope?: string;
  /** True only when every tile intersecting the visible viewport is present. */
  visibleLayerComplete?: boolean;
  /** Frontend-only identifier used to reject stale render timing callbacks. */
  renderGeneration?: number;
}

export interface ContactMapTile {
  tileX: number;
  tileY: number;
  cells: ContactMapCell[];
  /** Compact backend payload. Coordinates are local to this tile. */
  packedCells?: PackedContactTileCells;
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
  | "overview";

interface ContactTileHandleRequest {
  requestId: number;
  generation: number;
  purpose: ContactTileRequestPurpose;
  coolPath: string;
  baseResolution: number;
  targetResolution: number;
  tileSizeBins: number;
  normalization: ContactNormalization;
  tiles: ContactMapTileKey[];
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

const samplePaf = [
  "ctg00003\t1400000\t120000\t760000\t+\tchrA\t2200000\t240000\t900000\t600000\t640000\t60",
  "ctg00008\t960000\t180000\t620000\t-\tchrA\t2200000\t1040000\t1500000\t390000\t440000\t48",
  "ctg00012\t780000\t60000\t410000\t+\tchrB\t1600000\t260000\t620000\t300000\t350000\t35",
].join("\n");

const browserFallbackStatus: AppStatus = {
  engine: "cstudio-core",
  coordinate_convention: "0-based half-open internal; 1-based closed AGP",
  supported_operations: ["split", "move", "flip", "copy", "insert_gap", "delete_gap"],
};
const emptyLayout: AgpLayout = { blocks: [], totalSpan: 0 };
const maxBackgroundPrefetchTiles = 16;
const visibleContactTileRequestBatchSize = 8;
const panVisibleContactTileRequestBatchSize = 2;
const prefetchContactTileRequestBatchSize = 16;
const contactViewportRequestDelayMs = 24;
const secondaryTrackRequestDelayMs = 180;
const idleAdjacentContactTileBatchSize = 2;
const contactTileRequestCancelledMessage = "contact tile request cancelled";
const autoSavePreferenceKey = "c-studio:auto-save-agp";
const contactTileIpcPerformanceEnabled = isContactTilePerformanceEnabled();
const contactTileBinaryEnabled = import.meta.env.VITE_CSTUDIO_TILE_BINARY !== "0";
const contactTileStreamEnabled = import.meta.env.VITE_CSTUDIO_TILE_STREAM !== "0";
const contactTileSingleScanEnabled = import.meta.env.VITE_CSTUDIO_TILE_SINGLE_SCAN !== "0";
const contactTileDirectDeltaEnabled = import.meta.env.VITE_CSTUDIO_TILE_DIRECT_DELTA !== "0";
const contactMainLodEnabled = import.meta.env.VITE_CSTUDIO_MAIN_LOD !== "0";

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
        const rawResponse = await invoke<unknown>("get_contact_map_tiles_from_cool_binary_v1", {
          request: invokeRequest,
        });
        const decoded = decodeContactTileBinaryV1(rawResponse);
        if (decoded.tileSizeBins !== request.tileSizeBins) {
          throw new Error(
            `contact tile binary size mismatch: expected ${request.tileSizeBins}, got ${decoded.tileSizeBins}`,
          );
        }
        return decoded.tiles;
      }

      const startedAt = performance.now();
      let invokeUs = 0;
      let decodeUs = 0;
      let responseBytes = 0;
      let transport: ContactTileFrontendIpcPerformanceRequest["transport"] = "unknown";
      try {
        const rawResponse = await invoke<unknown>("get_contact_map_tiles_from_cool_binary_v1", {
          request: invokeRequest,
        });
        const responseAt = performance.now();
        invokeUs = Math.round(Math.max(0, responseAt - startedAt) * 1_000);
        if (rawResponse instanceof ArrayBuffer) {
          responseBytes = rawResponse.byteLength;
          transport = "array_buffer";
        }
        const decoded = decodeContactTileBinaryV1(rawResponse);
        decodeUs = Math.round(Math.max(0, performance.now() - responseAt) * 1_000);
        if (decoded.tileSizeBins !== request.tileSizeBins) {
          throw new Error(
            `contact tile binary size mismatch: expected ${request.tileSizeBins}, got ${decoded.tileSizeBins}`,
          );
        }
        const tiles = decoded.tiles;
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
    /** Compatibility path selected by VITE_CSTUDIO_TILE_DIRECT_DELTA=0. */
    onChunk?: (tiles: ContactMapTile[]) => void;
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
          const decoded = decodeContactTileBinaryV1(rawResponse);
          decodeUs += Math.round(Math.max(0, performance.now() - responseAt) * 1_000);
          responseBytes += decoded.byteLength;
          if (decoded.tileSizeBins !== request.tileSizeBins) {
            throw new Error(
              `contact tile delta size mismatch: expected ${request.tileSizeBins}, got ${decoded.tileSizeBins}`,
            );
          }
          if (decoded.tiles.length === 0) {
            resolveFinished();
            return;
          }
          const changedTileKeys = accumulator.merge(decoded.tiles);
          if (changedTileKeys.length > 0) {
            callbacks.onDelta?.();
            if (callbacks.onChunk) {
              callbacks.onChunk(accumulator.snapshotTiles(changedTileKeys));
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
      }
    },
  );
}

export function App() {
  const [status, setStatus] = useState<AppStatus>(browserFallbackStatus);
  const [dataset, setDataset] = useState<ExampleDatasetSummary | null>(null);
  const [contactAvailableResolutions, setContactAvailableResolutions] = useState<number[]>([]);
  const [contactMap, setContactMap] = useState<ContactMapView | null>(null);
  const [contactTileDeltaStream, setContactTileDeltaStream] = useState<
    ContactTileDeltaRenderStream | null
  >(null);
  const [contactTilePreviewViewport, setContactTilePreviewViewport] = useState<
    ContactPanPreview | null
  >(null);
  const pendingPanPerformancePreviewRef = useRef<ContactPanPreview | null>(null);
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
  const autoColorScaleCacheRef = useRef<Map<string, ContactColorScale>>(new Map());
  const lastCompleteContactMapRef = useRef<ContactMapView | null>(null);
  // The Rust process can outlive a WebView reload, so start both monotonic
  // counters from a wall-clock epoch instead of resetting them to zero.
  const contactTileGenerationRef = useRef(Date.now() * 1_000);
  const contactTileBackendRequestIdRef = useRef(Date.now() * 1_000);
  const contactTileFlightsRef = useRef(new ContactTileFlightRegistry<ContactMapTile>());
  const contactLayoutHandleRegistryRef = useRef<ContactLayoutHandleRegistry | null>(null);
  if (contactLayoutHandleRegistryRef.current === null) {
    contactLayoutHandleRegistryRef.current = new ContactLayoutHandleRegistry();
  }
  const contactLayoutHandleRegistry = contactLayoutHandleRegistryRef.current;
  const [syntenyView, setSyntenyView] = useState<SyntenyView | null>(null);
  const [coverageView, setCoverageView] = useState<CoverageView | null>(null);
  const [coverageRecords, setCoverageRecords] = useState<BedGraphRecord[]>([]);
  const [pafText, setPafText] = useState(samplePaf);
  const [pafPath, setPafPath] = useState<string | null>(null);
  const [pafImported, setPafImported] = useState(false);
  const [gfaDocument, setGfaDocument] = useState<GfaEvidenceDocument | null>(null);
  const [gfaHomologPattern, setGfaHomologPattern] = useState(defaultGfaHomologPattern);
  const [statusMessage, setStatusMessage] = useState("Workbench ready");
  const [contactPanPerformanceLog, setContactPanPerformanceLog] = useState<string | null>(() => (
    contactTileIpcPerformanceEnabled
      ? "CSTUDIO_PERF event=contact_pan_pipeline status=armed"
      : null
  ));
  const savedAgpPathRef = useRef<string | null>(null);
  const [savedAgpPath, setSavedAgpPath] = useState<string | null>(null);
  const savingAgpRef = useRef(false);
  const [savedAgpText, setSavedAgpText] = useState("");
  const [autoSaveEnabled, setAutoSaveEnabled] = useState(readAutoSavePreference);
  const agpInputRef = useRef<HTMLInputElement>(null);
  const gfaInputRef = useRef<HTMLInputElement>(null);
  const pafInputRef = useRef<HTMLInputElement>(null);
  const coverageInputRef = useRef<HTMLInputElement>(null);
  const [uiState, dispatchUi] = useReducer(
    reduceUiState,
    createInitialUiState("Workbench ready"),
  );
  const contactTilePerformanceRef = useRef<ReturnType<
    typeof createContactTilePerformanceTracker
  > | null>(null);
  if (contactTilePerformanceRef.current === null) {
    contactTilePerformanceRef.current = createContactTilePerformanceTracker();
  }
  const contactTilePerformance = contactTilePerformanceRef.current;
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
  const handleContactViewportPreview = useCallback((preview: ContactPanPreview | null) => {
    if (preview) {
      pendingPanPerformancePreviewRef.current = preview;
    }
    setContactTilePreviewViewport(preview);
  }, []);
  const latestUiStateRef = useRef(uiState);
  latestUiStateRef.current = uiState;
  const pendingResolutionPerformanceRef = useRef<PendingResolutionPerformance | null>(null);
  const contactTilePresentationScheduleRef = useRef<ContactTilePresentationSchedule | null>(null);
  const dispatchMeasuredUiAction = useCallback((action: UiAction) => {
    const currentUiState = latestUiStateRef.current;
    const nextResolution = contactTilePerformance.enabled
      ? nextContactResolutionForPerformance(action, currentUiState)
      : null;
    if (nextResolution) {
      pendingResolutionPerformanceRef.current = {
        startedAt: contactTilePerformance.timestamp(),
        fromResolution: currentUiState.contact.resolution,
        toResolution: nextResolution,
      };
    }
    dispatchUi(action);
  }, [contactTilePerformance]);
  const handleContactTileLayerCommit = useCallback((event: ContactTileRenderMilestone) => {
    if (event.generation === contactTileGenerationRef.current) {
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
    if (
      completeLayer?.visibleLayerComplete === true
      && completeLayer.renderGeneration === event.generation
    ) {
      setContactTileDeltaStream((current) => (
        current?.generation === event.generation ? null : current
      ));
      setPaintedContactTileGeneration((current) => (
        current === event.generation ? current : event.generation
      ));
    }
    const tracksResolutionPerformance = Boolean(
      contactTilePerformance.snapshot(event.generation),
    );
    const tracksPanPerformance = Boolean(
      contactPanPerformance.snapshot(event.generation),
    );
    if (!tracksResolutionPerformance && !tracksPanPerformance) {
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
        if (tracksPanPerformance) {
          contactPanPerformance.markGpuPaint(event.generation);
        }
      });
    });
  }, [contactPanPerformance, contactTilePerformance]);
  const contactCoolPath = dataset?.cool_path ?? null;
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
  const currentAgpText = useMemo(
    () => exportAgpText(assemblyLayout.blocks),
    [assemblyLayout.blocks],
  );
  const isAgpDirty = assemblyLayout.blocks.length > 0 && currentAgpText !== savedAgpText;
  const backgroundAssemblyLayout = useDebouncedValue(assemblyLayout, secondaryTrackRequestDelayMs);

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
        setStatusMessage("Backend connected");
      })
      .catch(() => {
        setStatus(browserFallbackStatus);
        setStatusMessage("Browser preview mode");
      });
  }, []);

  useEffect(() => {
    const emptyTileCache = new Map<string, ContactMapTile>();
    contactTileCacheLru.clear();
    contactTileCacheRef.current = emptyTileCache;
    contactTileFlightsRef.current.clear();
    autoColorScaleCacheRef.current.clear();
    lastCompleteContactMapRef.current = null;
  }, [contactCoolPath, contactTileCacheLru]);

  useEffect(() => {
    // A different matrix or normalization must never inherit the old overview.
    // Layout edits are intentionally excluded: the last complete whole-genome
    // frame remains visible until its replacement is ready.
    overviewContactMapRef.current = null;
    setOverviewContactMap(null);
  }, [contactCoolPath, uiState.normalization]);

  useEffect(() => {
    const generation = contactTileGenerationRef.current + 1;
    contactTileGenerationRef.current = generation;
    setContactTileDeltaStream((current) => (
      current?.generation === generation ? current : null
    ));
    contactTilePerformance.supersedeBefore(generation);
    if (!contactTilePreviewViewport) {
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
    if (!contactCoolPath || assemblyLayout.blocks.length === 0) {
      setContactMap((current) => (current === null ? current : null));
      contactTileCacheLru.clear();
      contactTileCacheRef.current = new Map();
      lastCompleteContactMapRef.current = null;
      contactTileFlightsRef.current.clear();
      void invoke("begin_contact_tile_generation", {
        request: { generation, retainedRequestIds: [] },
      }).catch(() => undefined);
      return;
    }

    // Registration is asynchronous but independent of generation begin. Start
    // it immediately so the first visible tile request normally sees a warm
    // handle; failures are removed from the registry and surface on actual use.
    void contactLayoutHandleRegistry
      .prepare(assemblyLayout.blocks, registerContactMapLayout)
      .catch(() => undefined);

    let cancelled = false;
    let adjacentPrefetchFirstFrame: number | null = null;
    let adjacentPrefetchSecondFrame: number | null = null;
    let cancelAdjacentIdleTask: (() => void) | null = null;
    let adjacentPrefetchStarted = false;
    const documentIsHidden = () => document.visibilityState === "hidden";
    const targetResolution = resolutionToBasePairs(uiState.contact.resolution);
    const totalSpanBp = Math.max(targetResolution, assemblyLayout.totalSpan);
    const committedViewport = buildCenteredContactViewport({
      centerMb: uiState.contact.viewportCenterMb,
      centerXMb: uiState.contact.viewportCenterXMb,
      centerYMb: uiState.contact.viewportCenterYMb,
      totalSpanBp,
      windowSizeBp: uiState.contact.viewportSpanMb * 1_000_000,
      viewportWidthPx: uiState.contact.viewportWidthPx,
      viewportHeightPx: uiState.contact.viewportHeightPx,
    });
    const viewport = contactTilePreviewViewport?.viewport ?? committedViewport;
    const prefetchViewport = contactTilePreviewViewport?.prefetchViewport ?? viewport;
    const panPerformancePreview = contactTilePreviewViewport
      ?? pendingPanPerformancePreviewRef.current;
    const tileSizeBins = contactTileSizeBins;
    const normalization = contactNormalizationForBackend(uiState.normalization);
    const tileScope = contactTileScope(
      contactCoolPath,
      targetResolution,
      tileSizeBins,
      normalization,
      assemblyLayout.blocks,
    );
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
      assemblyLayout.blocks,
    );
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
    contactTileCacheLru.touch(
      activeLayerScope,
      [...warmCacheKeys, ...visibleCacheKeys],
      {
        keys: visibleCacheKeys,
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
    const mainLodPlan = contactMainLodEnabled
      ? buildContactMainLodPlan({
          viewport,
          selectedResolution: targetResolution,
          viewportWidthPx: uiState.contact.viewportWidthPx,
          viewportHeightPx: uiState.contact.viewportHeightPx,
          visibleTileCount: tileWorld.visibleTiles.length,
        }, contactAvailableResolutions)
      : null;
    if (mainLodPlan) {
      const mainLodScope = contactTileScope(
        contactCoolPath,
        mainLodPlan.targetResolution,
        Math.max(
          1,
          Math.ceil((viewport.xEnd - viewport.xStart) / mainLodPlan.targetResolution),
          Math.ceil((viewport.yEnd - viewport.yStart) / mainLodPlan.targetResolution),
        ),
        normalization,
        assemblyLayout.blocks,
      );
      const retainedMainLod = lastCompleteContactMapRef.current;
      const hasMatchingMainLod = Boolean(
        retainedMainLod
        && retainedMainLod.layoutScope === mainLodScope
        && retainedMainLod.normalization === normalization
        && retainedMainLod.viewport.xStart === viewport.xStart
        && retainedMainLod.viewport.xEnd === viewport.xEnd
        && retainedMainLod.viewport.yStart === viewport.yStart
        && retainedMainLod.viewport.yEnd === viewport.yEnd
      );
      const mainLodAutoColorScaleKey = contactAutoColorScaleKey(
        contactCoolPath,
        mainLodPlan.targetResolution,
        tileSizeBins,
        uiState.contact.colorScale.log,
      );
      if (hasMatchingMainLod && retainedMainLod) {
        setContactMap((current) => (current === retainedMainLod ? current : retainedMainLod));
      } else {
        setStatusMessage(
          `Loading screen-scale contact map at ${formatBasePairResolution(mainLodPlan.targetResolution)}…`,
        );
      }

      // The dedicated command registers against the current generation, so
      // advance/cancel foreground work before starting this LOD request.
      const generationStart = invoke<number[]>("begin_contact_tile_generation", {
        request: { generation, retainedRequestIds: [] },
      });
      void (async () => {
        await generationStart;
        if (cancelled || generation !== contactTileGenerationRef.current) {
          return;
        }
        setBackendStartedContactTileGeneration((current) => (
          current === generation ? current : generation
        ));
        if (hasMatchingMainLod) {
          setStatusMessage(
            `Contact map preview at ${formatBasePairResolution(mainLodPlan.targetResolution)}`,
          );
          return;
        }

        const nextRequestId = contactTileBackendRequestIdRef.current + 1;
        contactTileBackendRequestIdRef.current = nextRequestId;
        const response = await loadContactOverviewWithLayoutHandle(
          contactLayoutHandleRegistry,
          assemblyLayout.blocks,
          {
            requestId: nextRequestId,
            generation,
            coolPath: contactCoolPath,
            sourceResolution: mainLodPlan.sourceResolution,
            targetResolution: mainLodPlan.targetResolution,
            normalization,
            viewport: mainLodPlan.viewport,
          },
        );
        if (cancelled || generation !== contactTileGenerationRef.current) {
          return;
        }
        const mainLodMap: ContactMapView = {
          resolution: response.resolution,
          normalization,
          viewport: response.viewport,
          cells: response.cells,
          layoutBlocks: assemblyLayout.blocks,
          layoutScope: mainLodScope,
          visibleLayerComplete: true,
          renderGeneration: generation,
        };
        if (uiState.contact.colorScale.auto && hasContactMapData(mainLodMap)) {
          const cachedScale = autoColorScaleCacheRef.current.get(mainLodAutoColorScaleKey);
          if (cachedScale) {
            dispatchUi({ type: "setAutoColorScale", scale: cachedScale });
          } else {
            const counts = contactCountSampleForColorScale(mainLodMap);
            if (counts.some((value) => Number.isFinite(value) && value > 0)) {
              const scale = estimateContactColorScale(
                counts,
                uiState.contact.colorScale.log,
              );
              autoColorScaleCacheRef.current.set(mainLodAutoColorScaleKey, scale);
              dispatchUi({ type: "setAutoColorScale", scale });
            }
          }
        }
        lastCompleteContactMapRef.current = mainLodMap;
        setContactMap(mainLodMap);
        const coversWholeAssembly = response.viewport.xStart === 0
          && response.viewport.yStart === 0
          && response.viewport.xEnd >= assemblyLayout.totalSpan
          && response.viewport.yEnd >= assemblyLayout.totalSpan;
        if (coversWholeAssembly) {
          overviewContactMapRef.current = mainLodMap;
          setOverviewContactMap(mainLodMap);
        }
        setStatusMessage(
          `Contact map preview at ${formatBasePairResolution(mainLodPlan.targetResolution)}`,
        );
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => {
            if (!cancelled && generation === contactTileGenerationRef.current) {
              setPaintedContactTileGeneration((current) => (
                current === generation ? current : generation
              ));
            }
          });
        });
      })().catch((error) => {
        if (
          cancelled
          || generation !== contactTileGenerationRef.current
          || isContactTileRequestCancelled(error)
        ) {
          return;
        }
        setStatusMessage(`Contact map LOD failed: ${String(error)}`);
        dispatchUi({
          type: "appendLog",
          message: `Contact map LOD failed: ${String(error)}`,
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
      tileWorld.prefetchTiles.map(cacheKeyForTile),
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
      setStatusMessage(`Applying ${uiState.normalization} normalization…`);
    }
    const holdsPreviousCompleteFrame = shouldHoldPreviousContactMapFrame(
      previousCompleteMap,
      targetResolution,
      tileSizeBins,
      tileScope,
    );
    const streamsCompatiblePan = Boolean(
      previousCompleteMap
      && !holdsPreviousCompleteFrame
      && (
        previousCompleteMap.viewport.xStart !== viewport.xStart
        || previousCompleteMap.viewport.xEnd !== viewport.xEnd
        || previousCompleteMap.viewport.yStart !== viewport.yStart
        || previousCompleteMap.viewport.yEnd !== viewport.yEnd
      ),
    );
    const visibleBatchSize = holdsPreviousCompleteFrame
      ? Math.max(1, tileWorld.missingVisibleTiles.length)
      : contactTilePreviewViewport || streamsCompatiblePan
        ? panVisibleContactTileRequestBatchSize
        : visibleContactTileRequestBatchSize;
    const loadPlan = buildContactTileLoadPlan(
      tileWorld,
      maxBackgroundPrefetchTiles,
      visibleBatchSize,
      prefetchContactTileRequestBatchSize,
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
      normalization,
      layoutBlocks: assemblyLayout.blocks,
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
      if (!uiState.contact.colorScale.auto || !hasContactMapData(map)) {
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
    if (
      holdsPreviousCompleteFrame
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
    const plannedTiles = tileBatches.flatMap((batch) => batch.tiles);
    const renderedStatusMessage =
      `Contact map rendered with ${uiState.normalization} at ${uiState.contact.resolution}, ${formatViewportLabel(viewport)}`;
    const retainedRequestIds = contactTileFlightsRef.current.requestIdsFor(
      tileScope,
      plannedTiles,
      cacheKeyForTile,
    );
    // Start cancellation immediately on viewport/resolution changes. The UI
    // render remains debounced, but stale HDF5 work no longer waits for it.
    const generationStart = invoke<number[]>("begin_contact_tile_generation", {
      request: { generation, retainedRequestIds },
    }).then(
      () => null,
      (error: unknown) => error,
    );
    const scheduleAdjacentResolutionPrefetch = () => {
      if (
        adjacentPrefetchStarted
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
            const availableResolutions = availableContactResolutions(
              currentUiState.contact,
              assemblyLayout.totalSpan / 1_000_000,
              contactCoolPath.toLowerCase().endsWith(".mcool"),
            );
            const adjacentLayerScopeIds = new Set([activeLayerScope.id]);
            const jobQueues = adjacentContactResolutions(
              currentUiState.contact.resolution,
              availableResolutions,
            ).map((candidateResolution) => {
              const candidateUiState = reduceUiState(currentUiState, {
                type: "setContactResolution",
                resolution: candidateResolution,
                preserveViewport: contactCoolPath.toLowerCase().endsWith(".mcool"),
              });
              if (candidateUiState.contact.resolution !== candidateResolution) {
                return [];
              }

              const candidateTargetResolution = resolutionToBasePairs(candidateResolution);
              const candidateTotalSpanBp = Math.max(
                candidateTargetResolution,
                assemblyLayout.totalSpan,
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
              const candidateTileScope = contactTileScope(
                contactCoolPath,
                candidateTargetResolution,
                tileSizeBins,
                normalization,
                assemblyLayout.blocks,
              );
              const candidateLayerScope = {
                id: contactTileDataScope(
                  contactCoolPath,
                  candidateTargetResolution,
                  tileSizeBins,
                  normalization,
                ),
                resolution: candidateTargetResolution,
              };
              adjacentLayerScopeIds.add(candidateLayerScope.id);
              const candidateCacheKeyForTile = createContactTileCacheKeyResolver(
                contactCoolPath,
                candidateTargetResolution,
                tileSizeBins,
                normalization,
                assemblyLayout.blocks,
              );
              const candidateWorld = buildContactTileWorld({
                viewport: candidateViewport,
                resolution: candidateTargetResolution,
                tileSizeBins,
                totalSpanBp: candidateTotalSpanBp,
                scope: candidateTileScope,
                cache: contactTileCacheLru.toMap(),
                cacheKeyForTile: candidateCacheKeyForTile,
              });

              return buildContactTileLoadPlan(
                candidateWorld,
                0,
                idleAdjacentContactTileBatchSize,
                idleAdjacentContactTileBatchSize,
              ).visibleBatches.map((tiles) => ({
                tiles,
                targetResolution: candidateTargetResolution,
                tileScope: candidateTileScope,
                layerScope: candidateLayerScope,
                cacheKeyForTile: candidateCacheKeyForTile,
              }));
            });
            const jobs = interleaveContactPrefetchBatches(jobQueues);
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
              if (contactTileFlightsRef.current.size > 0) {
                scheduleNextIdleJob();
                return;
              }

              const job = jobs.shift();
              if (!job) {
                return;
              }
              const pendingTiles = job.tiles.filter((tile) => {
                const key = job.cacheKeyForTile(tile);
                return !contactTileCacheLru.has(key) && !attemptedKeys.has(key);
              });
              for (const tile of pendingTiles) {
                attemptedKeys.add(job.cacheKeyForTile(tile));
              }
              if (pendingTiles.length === 0) {
                scheduleNextIdleJob();
                return;
              }

              try {
                const tiles = await contactTileFlightsRef.current.loadBatch({
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
                      assemblyLayout.blocks,
                      {
                        requestId: backendRequestId,
                        generation,
                        purpose: "adjacent_prefetch",
                        coolPath: contactCoolPath,
                        baseResolution: 1000,
                        targetResolution: job.targetResolution,
                        tileSizeBins,
                        normalization,
                        tiles: requestedTiles,
                      },
                    ),
                });
                if (cancelled || generation !== contactTileGenerationRef.current) {
                  return;
                }
                contactTileCacheLru.merge(
                  job.layerScope,
                  tiles.map((tile) => ({
                    key: job.cacheKeyForTile(tile),
                    value: tile,
                    cellCount: contactTileCellCount(tile),
                  })),
                  {
                    recency: "background",
                    keys: foregroundProtectedKeys,
                    // Retain the newly useful neighbor long enough to replace a
                    // stale non-adjacent scope when the three-scope budget is
                    // already full. Tile/cell pressure still evicts its cold
                    // records before the protected foreground keys.
                    scopes: adjacentLayerScopeIds,
                  },
                );
                // Background work deliberately avoids React state, status, and
                // performance markers. A later resolution switch reads this ref.
                contactTileCacheRef.current = contactTileCacheLru.toMap();
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
    if (tileWorld.missingVisibleTiles.length === 0) {
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
      if (tileWorld.missingVisibleTiles.length === 0) {
        lastCompleteContactMapRef.current = pendingContactMap;
      }

      if (shouldPublishContactMapLayer(
        holdsPreviousCompleteFrame,
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
          })),
          {
            keys: foregroundProtectedKeys,
            scopes: new Set([activeLayerScope.id]),
          },
        );
        const nextCache = contactTileCacheLru.toMap();
        contactTileCacheRef.current = nextCache;
        const renderCache = contactTileRenderCache(nextCache, assemblingVisibleTiles);
        if (kind === "visible") {
          contactTilePerformance.markCacheMerge(generation);
          contactPanPerformance.markCacheMerge(generation);
        }

        const updatedTileWorld = buildContactTileWorld({
          viewport,
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
        if (updatedTileWorld.missingVisibleTiles.length === 0) {
          lastCompleteContactMapRef.current = updatedContactMap;
        }
        if (shouldPublishContactMapLayer(
          holdsPreviousCompleteFrame,
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
          setStatusMessage(renderedStatusMessage);
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
        setBackendStartedContactTileGeneration((current) => (
          current === generation ? current : generation
        ));

        if (tileBatches.length === 0) {
          setStatusMessage(renderedStatusMessage);
          scheduleAdjacentResolutionPrefetch();
          return;
        }
        if (visibleReady) {
          setStatusMessage(renderedStatusMessage);
        }

        const shouldStreamVisibleBatches = contactTileBinaryEnabled
          && contactTileStreamEnabled
          && loadPlan.visibleBatches.length > 1;
        const usesAdaptiveMcoolRefinement = normalization === "raw"
          && targetResolution === 2_500_000
          && contactCoolPath.toLowerCase().endsWith(".mcool");
        const shouldSingleScanVisibleTiles = contactTileBinaryEnabled
          && contactTileStreamEnabled
          && contactTileSingleScanEnabled
          && !usesAdaptiveMcoolRefinement
          && loadPlan.visibleBatches.length > 0
          // Keep the dense frontend accumulator bounded even in a diagnostic
          // build where main-canvas LOD has been explicitly disabled.
          && tileWorld.visibleTiles.length <= maxExactMainContactTiles;
        let streamedVisibleBatches = false;
        for (const batch of tileBatches) {
          if (batch.kind === "visible" && shouldSingleScanVisibleTiles) {
            if (streamedVisibleBatches) {
              continue;
            }
            streamedVisibleBatches = true;
            contactPanPerformance.markIpcStart(generation);
            const visibleTiles = loadPlan.visibleBatches.flat();
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
                  assemblyLayout.blocks,
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
                  },
                  {
                    onStart: contactTileDirectDeltaEnabled
                      ? (accumulator) => {
                          if (cancelled || generation !== contactTileGenerationRef.current) {
                            return;
                          }
                          setContactTileDeltaStream({
                            generation,
                            resolution: targetResolution,
                            viewport,
                            accumulator,
                            onFirstPaint: () => {
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
                            },
                          });
                        }
                      : undefined,
                    onDelta: () => {
                      contactTilePerformance.markIpcResponse(generation);
                      contactPanPerformance.markIpcResponse(generation);
                      contactTilePerformance.markCacheMerge(generation);
                      contactPanPerformance.markCacheMerge(generation);
                    },
                    onChunk: contactTileDirectDeltaEnabled
                      ? undefined
                      : (changedTiles) => commitLoadedTiles("visible", changedTiles),
                  },
                )
              ),
            });
            let tiles: ContactMapTile[];
            try {
              tiles = await loadVisibleDeltas();
            } catch (error) {
              if (cancelled || generation !== contactTileGenerationRef.current) {
                return;
              }
              if (!isContactTileRequestCancelled(error)) {
                throw error;
              }
              tiles = await loadVisibleDeltas();
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
            const visibleTiles = loadPlan.visibleBatches.flat();
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
                  assemblyLayout.blocks,
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
                  },
                  streamChunks,
                  (chunkTiles) => {
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
              tiles = await loadVisibleStream();
            } catch (error) {
              if (cancelled || generation !== contactTileGenerationRef.current) {
                return;
              }
              if (!isContactTileRequestCancelled(error)) {
                throw error;
              }
              tiles = await loadVisibleStream();
            }
            if (cancelled || generation !== contactTileGenerationRef.current) {
              return;
            }
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
              assemblyLayout.blocks,
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
              },
            ),
          });

          let tiles: ContactMapTile[];
          try {
            tiles = await loadBatch();
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
            tiles = await loadBatch();
          }
          if (cancelled || generation !== contactTileGenerationRef.current) {
            return;
          }
          commitLoadedTiles(batch.kind, tiles);
        }
        if (visibleReady) {
          const pendingPanPaint = contactPanPerformance.activeSnapshot();
          if (pendingPanPaint) {
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
        setStatusMessage(
          visibleReady
            ? renderedStatusMessage
            : `Contact map render failed: ${String(error)}`,
        );
        dispatchUi({
          type: "appendLog",
          message: `${visibleReady ? "Contact prefetch" : "Contact map render"} failed: ${String(error)}`,
        });
      });
    }, holdsPreviousCompleteFrame || contactTilePreviewViewport
      ? 0
      : contactViewportRequestDelayMs);

    return () => {
      cancelled = true;
      setContactTileDeltaStream((current) => (
        current?.generation === generation ? null : current
      ));
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
    contactTileCacheLru,
    contactPanPerformance,
    contactTilePerformance,
    contactCoolPath,
    contactAvailableResolutions,
    assemblyLayout,
    uiState.contact.resolution,
    uiState.contact.viewportCenterMb,
    uiState.contact.viewportCenterXMb,
    uiState.contact.viewportCenterYMb,
    uiState.contact.viewportSpanMb,
    uiState.contact.viewportWidthPx,
    uiState.contact.viewportHeightPx,
    contactTilePreviewViewport?.sequence,
    contactTilePreviewViewport?.viewport.xStart,
    contactTilePreviewViewport?.viewport.xEnd,
    contactTilePreviewViewport?.viewport.yStart,
    contactTilePreviewViewport?.viewport.yEnd,
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
    if (!contactCoolPath || assemblyLayout.blocks.length === 0) {
      clearStaleOverview();
      return;
    }

    const totalSpanBp = Math.max(1, assemblyLayout.totalSpan);
    const plan = buildContactOverviewTilePlan(
      totalSpanBp,
      contactAvailableResolutions,
    );
    const normalization = contactNormalizationForBackend(uiState.normalization);
    const overviewScope = contactTileScope(
      contactCoolPath,
      plan.targetResolution,
      plan.targetBins,
      normalization,
      assemblyLayout.blocks,
    );
    const currentOverview = overviewContactMapRef.current;
    const currentOverviewUsesCurrentLayout = currentOverview?.layoutBlocks
      === assemblyLayout.blocks;
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

    const generation = contactTileGenerationRef.current;
    const completeLayer = lastCompleteContactMapRef.current;
    if (!contactOverviewGenerationIsReady({
      currentGeneration: generation,
      backendStartedGeneration: backendStartedContactTileGeneration,
      paintedGeneration: paintedContactTileGeneration,
      completeLayerGeneration: completeLayer?.visibleLayerComplete === true
        ? completeLayer.renderGeneration ?? null
        : null,
    })) {
      return;
    }

    let cancelled = false;
    let requestStarted = false;
    const requestIsCurrent = () => (
      !cancelled
      && generation === contactTileGenerationRef.current
    );

    const loadOverview = async () => {
      requestStarted = true;
      try {
        const nextRequestId = contactTileBackendRequestIdRef.current + 1;
        contactTileBackendRequestIdRef.current = nextRequestId;
        const response = await loadContactOverviewWithLayoutHandle(
          contactLayoutHandleRegistry,
          assemblyLayout.blocks,
          {
            requestId: nextRequestId,
            generation,
            coolPath: contactCoolPath,
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
          layoutBlocks: assemblyLayout.blocks,
          layoutScope: overviewScope,
          visibleLayerComplete: true,
        };
        overviewContactMapRef.current = overviewMap;
        setOverviewContactMap(overviewMap);
      } catch (error) {
        if (
          !requestIsCurrent()
          || isContactTileRequestCancelled(error)
        ) {
          return;
        }
        dispatchUi({
          type: "appendLog",
          message: `Overview heatmap load failed: ${String(error)}`,
        });
      }
    };

    const startOverviewRequest = () => {
      if (cancelled || requestStarted || !requestIsCurrent()) {
        return;
      }
      const currentCompleteLayer = lastCompleteContactMapRef.current;
      if (!contactOverviewRequestIsReady({
        currentGeneration: generation,
        backendStartedGeneration: backendStartedContactTileGeneration,
        paintedGeneration: paintedContactTileGeneration,
        completeLayerGeneration: currentCompleteLayer?.visibleLayerComplete === true
          ? currentCompleteLayer.renderGeneration ?? null
          : null,
        documentHidden: document.visibilityState === "hidden",
      })) {
        return;
      }
      void loadOverview();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "hidden") {
        startOverviewRequest();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    startOverviewRequest();

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [
    assemblyLayout,
    backendStartedContactTileGeneration,
    contactAvailableResolutions,
    contactCoolPath,
    paintedContactTileGeneration,
    uiState.normalization,
  ]);

  useEffect(() => {
    if (backgroundAssemblyLayout.blocks.length === 0 || (!dataset?.coverage_path && coverageRecords.length === 0)) {
      setCoverageView(null);
      return;
    }

    let cancelled = false;
    const totalSpanBp = Math.max(1, backgroundAssemblyLayout.totalSpan);
    const viewport = buildCenteredContactViewport({
      centerMb: uiState.contact.viewportCenterXMb,
      centerXMb: uiState.contact.viewportCenterXMb,
      totalSpanBp,
      windowSizeBp: uiState.contact.viewportSpanMb * 1_000_000,
      viewportWidthPx: uiState.contact.viewportWidthPx,
      viewportHeightPx: uiState.contact.viewportHeightPx,
    });
    const request = buildCoverageViewRequest(
      coverageRecords,
      backgroundAssemblyLayout.blocks,
      totalSpanBp,
      {
        displayResolution: contactResolutionToBasePairs(uiState.contact.resolution),
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
        if (!cancelled) {
          setCoverageView(view);
        }
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        if (coverageRecords.length > 0) {
          setCoverageView(buildBrowserCoverageView(request));
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
    coverageRecords,
    dataset?.coverage_path,
    uiState.contact.resolution,
    uiState.contact.viewportCenterXMb,
    uiState.contact.viewportSpanMb,
    uiState.contact.viewportWidthPx,
    uiState.contact.viewportHeightPx,
  ]);

  useEffect(() => {
    if (!backgroundAssemblyLayout.blocks.length || (!pafPath && !pafText.trim())) {
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
    const request = buildSyntenyViewRequest({
      pafText: pafPath ? "" : pafText,
      viewport,
      layoutBlocks: backgroundAssemblyLayout.blocks,
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
    pafText,
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
      const importedDataset = ensureImportedDataset(summary);
      savedAgpPathRef.current = null;
      setSavedAgpPath(null);
      setSavedAgpText(exportAgpText(importedDataset.agp_layout.blocks));
      setDataset(importedDataset);
      setContactAvailableResolutions(importedDataset.available_resolutions ?? []);
      setCoverageRecords([]);
      setPafPath(importedDataset.paf_path);
      setPafText("");
      setPafImported(Boolean(importedDataset.paf_path));
      setGfaDocument(parseGfaText(gfaText, "hifi.asm.bp.p_utg.noseq.gfa"));
      dispatchUi({ type: "setAssemblyBlocks", blocks: importedDataset.agp_layout.blocks });
      dispatchUi({ type: "setOverviewMode", mode: "gfa" });
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
      savedAgpPathRef.current = null;
      setSavedAgpPath(null);
      setSavedAgpText(exportAgpText(example.dataset.agp_layout.blocks));
      setDataset(example.dataset);
      setContactAvailableResolutions(example.dataset.available_resolutions ?? [1_000]);
      setCoverageRecords(example.coverageRecords);
      setPafPath(null);
      setPafText(example.pafText);
      setPafImported(true);
      setGfaDocument(example.gfaDocument);
      dispatchUi({ type: "setAssemblyBlocks", blocks: example.dataset.agp_layout.blocks });
      dispatchUi({ type: "setOverviewMode", mode: "gfa" });
      dispatchUi({
        type: "fitContactViewport",
        totalSpanMb: example.dataset.agp_layout.totalSpan / 1_000_000,
      });
      setStatusMessage("Example dataset loaded with coverage, PAF and GFA in browser preview");
      dispatchUi({
        type: "appendLog",
        message: `Example dataset loaded in browser preview: ${example.coverageRecords.length.toLocaleString()} coverage records, ${summarizePafText(example.pafText).alignmentCount.toLocaleString()} PAF alignments and ${example.gfaDocument.summary.segmentCount.toLocaleString()} GFA segments`,
      });
    }
  }

  async function importAgpFile(file: File) {
    const text = await file.text();
    const summary = summarizeAgpText(text);
    const agpLayout = parseAgpLayout(text);

    savedAgpPathRef.current = null;
    setSavedAgpPath(null);
    setSavedAgpText(exportAgpText(agpLayout.blocks));
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

  async function importGfaFile(file: File) {
    try {
      const document = parseGfaText(await file.text(), file.name);
      if (document.summary.segmentCount === 0) {
        throw new Error("no S records found");
      }
      setGfaDocument(document);
      dispatchUi({ type: "setOverviewMode", mode: "gfa" });
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
    let selected: ImportedContactFile | null = null;
    try {
      selected = await invoke<ImportedContactFile | null>("select_contact_file");
    } catch (error) {
      setStatusMessage(`Contact map import failed: ${String(error)}`);
      dispatchUi({
        type: "appendLog",
        message: `Contact map import failed: ${String(error)}`,
      });
      return;
    }

    if (!selected) {
      setStatusMessage("Contact map import canceled");
      return;
    }

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
      }),
    }));
    setContactAvailableResolutions(selected.available_resolutions ?? []);
    setStatusMessage(`Contact map imported: ${selected.name}`);
    dispatchUi({ type: "appendLog", message: `Contact map imported: ${selected.name}` });
  }

  async function requestPafFile() {
    try {
      const selected = await invoke<ImportedContactFile | null>("select_paf_file");
      if (!selected) {
        setStatusMessage("PAF import canceled");
        return;
      }
      setPafPath(selected.path);
      setPafText("");
      setPafImported(true);
      setStatusMessage(`PAF imported: ${selected.name}`);
      dispatchUi({ type: "setOverviewMode", mode: "synteny" });
      dispatchUi({
        type: "appendLog",
        message: `PAF imported natively: ${selected.name} (${selected.size_bytes.toLocaleString()} bytes)`,
      });
    } catch {
      pafInputRef.current?.click();
    }
  }

  async function importPafFile(file: File) {
    const text = await file.text();
    const summary = summarizePafText(text);

    setPafPath(null);
    setPafText(text);
    setPafImported(true);
    setStatusMessage(
      `PAF imported: ${file.name} (${summary.alignmentCount.toLocaleString()} alignments)`,
    );
    dispatchUi({ type: "setOverviewMode", mode: "synteny" });
    dispatchUi({
      type: "appendLog",
      message: `PAF imported: ${file.name}; ${summary.alignmentCount.toLocaleString()} alignments, ${summary.ignoredLines.toLocaleString()} ignored`,
    });
  }

  async function requestCoverageFile() {
    try {
      const selected = await invoke<ImportedContactFile | null>("select_coverage_file");
      if (!selected) {
        setStatusMessage("Coverage import canceled");
        return;
      }

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
      const records = parseBedGraphText(await file.text());
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

  function clearAllLoadedData() {
    const generation = contactTileGenerationRef.current + 1;
    contactTileGenerationRef.current = generation;
    contactTilePerformance.supersedeBefore(generation);
    pendingPanPerformancePreviewRef.current = null;
    pendingResolutionPerformanceRef.current = null;

    const presentationSchedule = contactTilePresentationScheduleRef.current;
    cancelContactTilePresentationSchedule(presentationSchedule);
    contactTilePresentationScheduleRef.current = null;

    contactTileCacheLru.clear();
    contactTileCacheRef.current = new Map();
    contactTileFlightsRef.current.clear();
    autoColorScaleCacheRef.current.clear();
    lastCompleteContactMapRef.current = null;
    overviewContactMapRef.current = null;
    contactLayoutHandleRegistryRef.current = new ContactLayoutHandleRegistry();

    savedAgpPathRef.current = null;
    setSavedAgpPath(null);
    setSavedAgpText("");
    setDataset(null);
    setContactAvailableResolutions([]);
    setContactMap(null);
    setOverviewContactMap(null);
    setContactTilePreviewViewport(null);
    setBackendStartedContactTileGeneration(null);
    setPaintedContactTileGeneration(null);
    setCoverageView(null);
    setCoverageRecords([]);
    setSyntenyView(null);
    setPafPath(null);
    setPafText("");
    setPafImported(false);
    setGfaDocument(null);
    dispatchUi({ type: "clearLoadedData" });
    setStatusMessage("All loaded data cleared");

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

  async function exportEditedAgp(options: { automatic?: boolean } = {}) {
    if (assemblyLayout.blocks.length === 0) {
      dispatchUi({ type: "appendLog", message: "No AGP layout to save" });
      return;
    }
    if (savingAgpRef.current) {
      return;
    }

    savingAgpRef.current = true;
    const agpText = currentAgpText;
    const filename = editedAgpFilename(dataset?.agp_path ?? "assembly.agp");
    const savedStatus = options.automatic ? "AGP auto-saved" : "AGP saved";
    try {
      const existingPath = savedAgpPathRef.current;
      if (existingPath) {
        const overwritten = await invoke<boolean>("overwrite_agp_file", {
          path: existingPath,
          contents: agpText,
        });
        if (overwritten) {
          setSavedAgpText(agpText);
          setStatusMessage(`${savedStatus}: ${existingPath}`);
          dispatchUi({ type: "appendLog", message: `${savedStatus}: ${existingPath}` });
          return;
        }
        savedAgpPathRef.current = null;
        setSavedAgpPath(null);
      }

      const savedPath = await invoke<string | null>("save_agp_file", {
        defaultFilename: existingPath ? pathBasename(existingPath) : filename,
        contents: agpText,
      });

      if (!savedPath) {
        setStatusMessage("AGP save canceled");
        return;
      }

      savedAgpPathRef.current = savedPath;
      setSavedAgpPath(savedPath);
      setSavedAgpText(agpText);
      setDataset((current) => current ? { ...current, agp_path: savedPath } : current);
      setStatusMessage(`${savedStatus}: ${savedPath}`);
      dispatchUi({ type: "appendLog", message: `${savedStatus}: ${savedPath}` });
    } catch (error) {
      if (savedAgpPathRef.current) {
        setStatusMessage(`AGP save failed: ${String(error)}`);
        dispatchUi({ type: "appendLog", message: `AGP save failed: ${String(error)}` });
        return;
      }
      downloadTextFile(filename, agpText, "text/plain;charset=utf-8");
      setSavedAgpText(agpText);
      setDataset((current) => current ? { ...current, agp_path: filename } : current);
      setStatusMessage(`AGP downloaded: ${filename}`);
      dispatchUi({
        type: "appendLog",
        message: `AGP downloaded in browser preview: ${filename}; native save failed: ${String(error)}`,
      });
    } finally {
      savingAgpRef.current = false;
    }
  }

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
  }, [autoSaveEnabled, currentAgpText, isAgpDirty, savedAgpPath]);

  return (
    <AppShell
      dataset={dataset}
      contactMap={contactMap}
      contactTileDeltaStream={contactTileDeltaStream}
      contactIsMcool={contactCoolPath?.toLowerCase().endsWith(".mcool") ?? false}
      contactAvailableResolutions={contactAvailableResolutions}
      overviewContactMap={overviewContactMap}
      syntenyView={syntenyView}
      coverageView={coverageView}
      pafText={pafText}
      pafImported={pafImported}
      gfaDocument={gfaDocument}
      gfaHomologPattern={gfaHomologPattern}
      onGfaHomologPatternChange={setGfaHomologPattern}
      onPafTextChange={(value) => {
        setPafPath(null);
        setPafText(value);
      }}
      agpInputRef={agpInputRef}
      gfaInputRef={gfaInputRef}
      pafInputRef={pafInputRef}
      coverageInputRef={coverageInputRef}
      onAgpFileSelected={importAgpFile}
      onGfaFileSelected={importGfaFile}
      onContactFileSelected={importContactFile}
      onPafFileRequested={requestPafFile}
      onPafFileSelected={importPafFile}
      onCoverageFileRequested={requestCoverageFile}
      onCoverageFileSelected={importCoverageFile}
      onExportAgp={exportEditedAgp}
      autoSaveEnabled={autoSaveEnabled}
      autoSaveAvailable={savedAgpPath !== null}
      isAgpDirty={isAgpDirty}
      onAutoSaveEnabledChange={setAutoSaveEnabled}
      onLoadExample={loadExamples}
      onClearAllData={clearAllLoadedData}
      status={status}
      statusMessage={statusMessage}
      contactPanPerformanceLog={contactPanPerformanceLog}
      uiState={uiState}
      onUiAction={dispatchMeasuredUiAction}
      onContactViewportPreview={handleContactViewportPreview}
      onContactTileLayerCommit={contactTilePerformance.enabled
        ? handleContactTileLayerCommit
        : undefined}
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
      mcoolPath: "examples/input.1k.cool",
      coolPath: "",
      pafPath: "examples/mono.hifi.asm.bp.p_utg.paf",
      agpLines: summary.lineCount,
      agpObjects: summary.objectCount,
      agpComponents: summary.componentCount,
      agpGaps: summary.gapCount,
      maxObjectSpan: summary.maxObjectSpan,
      mcoolSizeBytes: 18_713_472,
      coveragePath: "examples/hifi.asm.bp.p_utg.noseq.depth",
      agpLayout: parseAgpLayout(agpText),
      availableResolutions: [1_000],
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
  });
}

function emptyAgpLayout(): AgpLayout {
  return emptyLayout;
}

function editedAgpFilename(path: string) {
  const basename = path.split(/[\\/]/).filter(Boolean).pop() ?? "assembly.agp";
  return basename.replace(/(?:\.agp|\.txt)?$/i, ".edited.agp");
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
