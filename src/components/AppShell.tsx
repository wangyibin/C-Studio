import {
  Check,
  ChevronDown,
  Ellipsis,
  ListFilter,
  Maximize2,
  PanelRight,
  Plus,
  RefreshCcw,
  Redo2,
  Save,
  SaveAll,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from "react";
import type { AppStatus, ContactMapView, ExampleDatasetSummary } from "../App";
import {
  assemblyContigSelectionIntent,
  selectedBlockIds,
} from "../state/assemblyEditing";
import type { CoverageView } from "../state/coverageView";
import type { PafPreviewRecord } from "../state/pafPreview";
import type { GfaEvidenceDocument } from "../state/gfa";
import type { GfaBandageLayoutLoader } from "../state/gfaBandageLayout";
import {
  buildPlacementRecommendationPreviewLayout,
  type PlacementRecommendation,
} from "../state/assemblyPlacementRecommendation";
import type {
  GfaEndpointHiCBatchLoader,
  GfaEndpointHiCLoader,
} from "../state/gfaEndpointHiC";
import type { HiCAlleleConcordanceBatchLoader } from "../state/hicAlleleConcordance";
import { classifyGfaScaffolds } from "../state/gfaHomologLayout";
import {
  buildCenteredContactViewport,
  type ContactViewport,
} from "../state/contactViewport";
import {
  gfaContigsForHeatmapViewport,
  gfaPrimaryHomologScaffoldsForHeatmapViewport,
  gfaScaffoldsForHeatmapViewport,
} from "../state/gfaViewportSync";
import type { ContactTileRenderMilestone } from "../state/contactTilePerformance";
import type { ContactPanPreview } from "../state/contactPanPerformance";
import type { ContactPanPrefetchBridge } from "../state/contactPanPrefetch";
import type { ContactTileDeltaRenderStream } from "../state/contactTileDelta";
import type { SyntenyView } from "../state/syntenyView";
import {
  contactNormalizationForBackend,
  contactNormalizationLabel,
  type ContactResolution,
  type UiAction,
  type UiState,
} from "../state/uiState";
import {
  isEditableShortcutTarget,
  juiceboxShortcutIntent,
} from "../state/juiceboxShortcuts";
import { keyboardShortcutLabels } from "../state/keyboardShortcutLabels";
import {
  chromosomeDisplayScope,
  type ChromosomeVisibility,
  updateHiddenChromosomeSelection,
} from "../state/chromosomeVisibility";
import type { ContactMapLayoutBlock } from "../state/importers";
import { ContactMapViewport } from "./ContactMapViewport";
import { GfaGraphPanel } from "./GfaGraphPanel";
import { HeatmapToolbar } from "./HeatmapToolbar";
import { InspectorPanel } from "./InspectorPanel";
import {
  SyntenyDotplot,
  type SyntenySelectionModifiers,
} from "./SyntenyDotplot";

interface AppShellProps {
  dataset: ExampleDatasetSummary | null;
  contactMap: ContactMapView | null;
  contactTileDeltaStream?: ContactTileDeltaRenderStream | null;
  contactIsMcool?: boolean;
  contactAvailableResolutions?: number[];
  overviewContactMap: ContactMapView | null;
  syntenyView: SyntenyView | null;
  coverageView: CoverageView | null;
  pafRecords: ReadonlyArray<PafPreviewRecord>;
  pafImported: boolean;
  gfaDocument: GfaEvidenceDocument | null;
  onLayoutGfaBandage?: GfaBandageLayoutLoader;
  onLoadGfaEndpointHiC?: GfaEndpointHiCLoader;
  onLoadGfaEndpointHiCBatch?: GfaEndpointHiCBatchLoader;
  onLoadHiCAlleleConcordanceBatch?: HiCAlleleConcordanceBatchLoader;
  gfaHomologPattern: string;
  onGfaHomologPatternChange: (pattern: string) => void;
  chromosomeVisibility: ChromosomeVisibility;
  hiddenChromosomeIds: ReadonlySet<string>;
  chromosomeFilterPattern: string;
  includeUnanchoredInChromosomeFilter: boolean;
  viewAssemblyBlocks: ContactMapLayoutBlock[];
  onPlacementPreviewChange?: (candidate: PlacementRecommendation | null) => void;
  onHiddenChromosomeIdsChange: (ids: Set<string>) => void;
  onChromosomeFilterPatternChange: (pattern: string) => void;
  onIncludeUnanchoredInChromosomeFilterChange: (include: boolean) => void;
  agpInputRef: RefObject<HTMLInputElement>;
  gfaInputRef: RefObject<HTMLInputElement>;
  pafInputRef: RefObject<HTMLInputElement>;
  coverageInputRef: RefObject<HTMLInputElement>;
  onAgpFileRequested: () => void;
  onAgpFileSelected: (file: File) => void;
  onGfaFileSelected: (file: File) => void;
  onContactFileSelected: () => void;
  onPafFileRequested: () => void;
  onPafFileSelected: (file: File) => void;
  onCoverageFileRequested: () => void;
  onCoverageFileSelected: (file: File) => void;
  onExportAgp: () => void;
  onExportAgpAs: () => void;
  autoSaveEnabled: boolean;
  autoSaveAvailable: boolean;
  isAgpDirty: boolean;
  onAutoSaveEnabledChange: (enabled: boolean) => void;
  onLoadExample: () => void;
  onLoadProject?: () => void;
  onReloadAssembly: () => void;
  onUnloadGfa: () => void;
  onUnloadContact: () => void;
  onUnloadPaf: () => void;
  onUnloadCoverage: () => void;
  onClearAllData: () => void;
  status: AppStatus;
  statusMessage: string;
  contactTilePerformanceLog?: string | null;
  contactPanPerformanceLog?: string | null;
  uiState: UiState;
  onUiAction: (action: UiAction) => void;
  onContactPanGestureStart?: () => void;
  onContactPanTilePrefetch?: (preview: ContactPanPreview) => void;
  contactViewportPreview?: ContactPanPreview | null;
  onContactViewportPreview?: (preview: ContactPanPreview | null) => void;
  onContactResolutionPreview?: (resolution: ContactResolution | null) => void;
  contactPanPrefetchBridge?: ContactPanPrefetchBridge;
  onContactTileLayerCommit?: (event: ContactTileRenderMilestone) => void;
  onContactTileLayerPaintComplete?: (event: ContactTileRenderMilestone) => void;
}

export const inspectorPanelMinWidth = 260;
export const inspectorPanelMaxWidth = 520;
const inspectorPanelDefaultWidth = 280;
const inspectorPanelCompactWidth = 276;
const inspectorPanelKeyboardStep = 16;
const brandMarkUrl = new URL("../../src-tauri/icons/icon.png", import.meta.url).href;
export const gfaPanelMinHeight = 180;
export const gfaPanelMaxWorkspaceShare = 0.65;

export function clampGfaPanelHeight(height: number, workspaceHeight: number) {
  const responsiveMaximum = Math.max(
    gfaPanelMinHeight,
    workspaceHeight * gfaPanelMaxWorkspaceShare,
  );
  return Math.round(Math.min(responsiveMaximum, Math.max(gfaPanelMinHeight, height)));
}

export function clampInspectorPanelWidth(width: number, workspaceWidth: number) {
  const responsiveMaximum = Math.max(
    inspectorPanelMinWidth,
    Math.min(inspectorPanelMaxWidth, workspaceWidth * 0.45),
  );
  return Math.round(Math.min(responsiveMaximum, Math.max(inspectorPanelMinWidth, width)));
}

function defaultInspectorPanelWidth() {
  return typeof window !== "undefined" && window.innerWidth <= 1180
    ? inspectorPanelCompactWidth
    : inspectorPanelDefaultWidth;
}

function fileName(path: string | undefined, fallback: string) {
  if (!path) {
    return fallback;
  }
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? fallback;
}

export function AppShell({
  dataset,
  contactMap,
  contactTileDeltaStream,
  contactIsMcool = false,
  contactAvailableResolutions = [],
  overviewContactMap,
  syntenyView,
  coverageView,
  pafRecords,
  pafImported,
  gfaDocument,
  onLayoutGfaBandage,
  onLoadGfaEndpointHiC,
  onLoadGfaEndpointHiCBatch,
  onLoadHiCAlleleConcordanceBatch,
  gfaHomologPattern,
  onGfaHomologPatternChange,
  chromosomeVisibility,
  hiddenChromosomeIds,
  chromosomeFilterPattern,
  includeUnanchoredInChromosomeFilter,
  viewAssemblyBlocks,
  onPlacementPreviewChange,
  onHiddenChromosomeIdsChange,
  onChromosomeFilterPatternChange,
  onIncludeUnanchoredInChromosomeFilterChange,
  agpInputRef,
  gfaInputRef,
  pafInputRef,
  coverageInputRef,
  onAgpFileRequested,
  onAgpFileSelected,
  onGfaFileSelected,
  onContactFileSelected,
  onPafFileRequested,
  onPafFileSelected,
  onCoverageFileRequested,
  onCoverageFileSelected,
  onExportAgp,
  onExportAgpAs,
  autoSaveEnabled,
  autoSaveAvailable,
  isAgpDirty,
  onAutoSaveEnabledChange,
  onLoadExample,
  onLoadProject = () => undefined,
  onReloadAssembly,
  onUnloadGfa,
  onUnloadContact,
  onUnloadPaf,
  onUnloadCoverage,
  onClearAllData,
  onContactTileLayerCommit,
  onContactTileLayerPaintComplete,
  onContactPanGestureStart,
  onContactPanTilePrefetch,
  contactViewportPreview = null,
  onContactViewportPreview,
  onContactResolutionPreview,
  contactPanPrefetchBridge,
  onUiAction,
  status,
  statusMessage,
  contactTilePerformanceLog,
  contactPanPerformanceLog,
  uiState,
}: AppShellProps) {
  const shortcuts = keyboardShortcutLabels();
  const workspaceRef = useRef<HTMLElement>(null);
  const centerWorkspaceRef = useRef<HTMLElement>(null);
  const gfaResizeRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
  } | null>(null);
  const inspectorResizeRef = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
  } | null>(null);
  const [inspectorWidth, setInspectorWidth] = useState<number | null>(null);
  const [gfaPanelOpen, setGfaPanelOpen] = useState(false);
  const [heatmapPanelOpen, setHeatmapPanelOpen] = useState(true);
  const [presentedContactViewport, setPresentedContactViewport] = useState<ContactViewport | null>(
    null,
  );
  const [gfaPanelHeight, setGfaPanelHeight] = useState<number | null>(null);
  const [confirmingClearData, setConfirmingClearData] = useState(false);
  const [confirmingReloadAssembly, setConfirmingReloadAssembly] = useState(false);
  const [placementPreview, setPlacementPreview] = useState<
    PlacementRecommendation | null
  >(null);
  const placementPreviewSequenceRef = useRef(0);
  const [chromosomeFilterPatternDraft, setChromosomeFilterPatternDraft] = useState(
    chromosomeFilterPattern,
  );
  const chromosomeFilterPatternDraftRef = useRef(chromosomeFilterPattern);
  const committedChromosomeFilterPatternRef = useRef(chromosomeFilterPattern);
  const onChromosomeFilterPatternChangeRef = useRef(onChromosomeFilterPatternChange);
  const commitChromosomeFilterPatternRef = useRef<() => void>(() => undefined);
  const chromosomeCheckboxAnchorRef = useRef<string | null>(null);
  const projectMenuRef = useRef<HTMLDetailsElement>(null);
  const addDataMenuRef = useRef<HTMLDetailsElement>(null);
  const appMenuRef = useRef<HTMLDetailsElement>(null);
  const chromosomeFilterMenuRef = useRef<HTMLDetailsElement>(null);
  const syntenySelectionAnchorRef = useRef<string | null>(null);
  const agpImported = Boolean(dataset?.agp_path || uiState.assembly.blocks.length > 0);
  const sourceAssemblyAvailable = Boolean(dataset?.agp_layout.blocks.length);
  const contactImported = Boolean(dataset?.mcool_path || dataset?.cool_path || contactMap);
  const coverageImported = Boolean(dataset?.coverage_path || coverageView);
  const syntenyImported = Boolean(pafImported || pafRecords.length || syntenyView);
  const gfaImported = gfaDocument !== null;
  const gfaHomologPatternError = classifyGfaScaffolds([], gfaHomologPattern).error;
  const loadedDataLabels = [
    agpImported ? "assembly" : null,
    contactImported ? "contact map" : null,
    syntenyImported ? "PAF alignments" : null,
    coverageImported ? "coverage" : null,
    gfaImported ? "assembly graph" : null,
  ].filter((label): label is string => label !== null);
  const hasLoadedData = loadedDataLabels.length > 0;

  useEffect(() => {
    if (!gfaDocument && gfaPanelOpen) {
      setGfaPanelOpen(false);
      if (!heatmapPanelOpen && !uiState.layout.syntenySplitOpen) {
        setHeatmapPanelOpen(true);
      }
    }
  }, [gfaDocument, gfaPanelOpen, heatmapPanelOpen, uiState.layout.syntenySplitOpen]);

  useEffect(() => {
    if (!syntenyImported && uiState.layout.syntenySplitOpen) {
      onUiAction({ type: "setSyntenySplitOpen", open: false });
      if (!heatmapPanelOpen && !gfaPanelOpen) {
        setHeatmapPanelOpen(true);
      }
    }
  }, [
    gfaPanelOpen,
    heatmapPanelOpen,
    onUiAction,
    syntenyImported,
    uiState.layout.syntenySplitOpen,
  ]);

  onChromosomeFilterPatternChangeRef.current = onChromosomeFilterPatternChange;

  function updateChromosomeFilterPatternDraft(value: string) {
    chromosomeFilterPatternDraftRef.current = value;
    setChromosomeFilterPatternDraft(value);
  }

  function commitChromosomeFilterPattern() {
    const nextPattern = chromosomeFilterPatternDraftRef.current;
    if (nextPattern === committedChromosomeFilterPatternRef.current) {
      return;
    }
    committedChromosomeFilterPatternRef.current = nextPattern;
    onChromosomeFilterPatternChangeRef.current(nextPattern);
  }

  commitChromosomeFilterPatternRef.current = commitChromosomeFilterPattern;

  function closeHeatmapPanel() {
    setHeatmapPanelOpen(false);
    if (!uiState.layout.syntenySplitOpen && !gfaPanelOpen) {
      if (syntenyImported) {
        onUiAction({ type: "setSyntenySplitOpen", open: true });
      } else if (gfaImported) {
        setGfaPanelOpen(true);
      }
    }
  }

  function expandHeatmapPanel() {
    setHeatmapPanelOpen(true);
    if (uiState.layout.syntenySplitOpen) {
      onUiAction({ type: "setSyntenySplitOpen", open: false });
    }
    setGfaPanelOpen(false);
  }
  const activeAssemblyBlocks = uiState.assembly.blocks.length > 0
    ? uiState.assembly.blocks
    : dataset?.agp_layout.blocks ?? [];
  const activeAssemblyTotalBp = viewAssemblyBlocks.reduce(
    (largestEnd, block) => Math.max(largestEnd, block.visualEnd),
    0,
  );
  const totalSpanMb = Math.max(
    0.000001,
    (
      (chromosomeVisibility.active
        ? activeAssemblyTotalBp
        : activeAssemblyTotalBp
          || dataset?.agp_layout.totalSpan
          || uiState.contact.totalSpanMb * 1_000_000)
    ) / 1_000_000,
  );
  const selectedAssemblyBlockIds = selectedBlockIds(
    activeAssemblyBlocks,
    uiState.assembly.selection,
  );
  const placementSelectionKey = uiState.assembly.selection?.kind === "contigs"
    ? `contigs:${selectedAssemblyBlockIds.join("\u0000")}`
    : uiState.assembly.selection?.kind === "chromosome"
      ? `chromosome:${uiState.assembly.selection.id}`
      : "none";
  const heatmapViewport = buildCenteredContactViewport({
    centerMb: uiState.contact.viewportCenterMb,
    centerXMb: uiState.contact.viewportCenterXMb,
    centerYMb: uiState.contact.viewportCenterYMb,
    totalSpanBp: Math.max(1, activeAssemblyTotalBp),
    windowSizeBp: uiState.contact.viewportSpanMb * 1_000_000,
    viewportWidthPx: uiState.contact.viewportWidthPx,
    viewportHeightPx: uiState.contact.viewportHeightPx,
  });
  const placementPreviewContextRef = useRef({
    blocks: activeAssemblyBlocks,
    totalSpanBp: activeAssemblyTotalBp,
    selection: uiState.assembly.selection,
    heatmapViewport,
    viewportWidthPx: uiState.contact.viewportWidthPx,
    viewportHeightPx: uiState.contact.viewportHeightPx,
  });
  placementPreviewContextRef.current = {
    blocks: activeAssemblyBlocks,
    totalSpanBp: activeAssemblyTotalBp,
    selection: uiState.assembly.selection,
    heatmapViewport,
    viewportWidthPx: uiState.contact.viewportWidthPx,
    viewportHeightPx: uiState.contact.viewportHeightPx,
  };
  const changePlacementPreview = useCallback((candidate: PlacementRecommendation | null) => {
    if (!candidate) {
      setPlacementPreview(null);
      onPlacementPreviewChange?.(null);
      onContactViewportPreview?.(null);
      return;
    }
    const context = placementPreviewContextRef.current;
    const preview = buildPlacementRecommendationPreviewLayout(
      context.blocks,
      context.selection,
      candidate,
    );
    if (!preview) {
      setPlacementPreview(null);
      onPlacementPreviewChange?.(null);
      onContactViewportPreview?.(null);
      return;
    }
    const currentWindowSizeBp = Math.max(
      context.heatmapViewport.xEnd - context.heatmapViewport.xStart,
      context.heatmapViewport.yEnd - context.heatmapViewport.yStart,
    );
    const previewWindowSizeBp = Math.min(
      Math.max(1, context.totalSpanBp),
      Math.max(currentWindowSizeBp, (preview.selectedEnd - preview.selectedStart) * 1.5),
    );
    const viewport = buildCenteredContactViewport({
      centerMb: preview.centerBp / 1_000_000,
      totalSpanBp: Math.max(1, context.totalSpanBp),
      windowSizeBp: previewWindowSizeBp,
      viewportWidthPx: context.viewportWidthPx,
      viewportHeightPx: context.viewportHeightPx,
    });
    const displayedCandidate = {
      ...candidate,
      visualPosition: preview.selectedStart,
    };
    placementPreviewSequenceRef.current += 1;
    setPlacementPreview(displayedCandidate);
    onPlacementPreviewChange?.(displayedCandidate);
    onContactViewportPreview?.({
      viewport,
      prefetchViewport: viewport,
      presentationMode: "replacement",
      sequence: placementPreviewSequenceRef.current,
      pointerTimestamp: performance.now(),
    });
  }, [
    onContactViewportPreview,
    onPlacementPreviewChange,
  ]);
  useEffect(() => {
    changePlacementPreview(null);
  }, [activeAssemblyBlocks, changePlacementPreview, placementSelectionKey, uiState.normalization]);
  const gfaHomologs = classifyGfaScaffolds(
    [...new Set(activeAssemblyBlocks.map((block) => block.objectId))],
    gfaHomologPattern,
  );
  const chromosomeIds = chromosomeVisibility.chromosomeIds;
  const unanchoredObjectIds = chromosomeVisibility.unanchoredIds;
  const visibleChromosomeCount = chromosomeIds.filter(
    (id) => chromosomeVisibility.visibleIds.has(id),
  ).length;
  const knownAssemblyObjectIds = new Set([...chromosomeIds, ...unanchoredObjectIds]);
  const chromosomeByBlockId = new Map(
    activeAssemblyBlocks.map((block) => [block.id, block.objectId]),
  );
  // Without an explicit filter, Curation/Bandage follow the heatmap viewport
  // and expand each hit to its whole homolog group. An explicit checkbox or
  // regex selection becomes authoritative so filtered chromosomes stay shown.
  const automaticGfaVisibleHomologScaffoldIds = gfaScaffoldsForHeatmapViewport(
    viewAssemblyBlocks,
    heatmapViewport,
    gfaHomologs,
  );
  const gfaVisibleHomologScaffoldIds = chromosomeDisplayScope(
    automaticGfaVisibleHomologScaffoldIds,
    chromosomeVisibility,
  );
  // The compact preview follows one primary group until the user explicitly
  // chooses a chromosome display set.
  const automaticGfaPreviewScaffoldIds = gfaPrimaryHomologScaffoldsForHeatmapViewport(
    viewAssemblyBlocks,
    heatmapViewport,
    gfaHomologs,
  );
  const gfaPreviewScaffoldIds = chromosomeDisplayScope(
    automaticGfaPreviewScaffoldIds,
    chromosomeVisibility,
  );
  // Guided normally narrows to the AGP contig plus five neighbors per side;
  // explicit chromosome selection lifts that focus to all matching AGP blocks.
  const automaticGfaGuidedContigIds = gfaContigsForHeatmapViewport(
    viewAssemblyBlocks,
    heatmapViewport,
    5,
    new Set(selectedAssemblyBlockIds),
  );
  const explicitlyVisibleChromosomeContigIds = chromosomeVisibility.active
    ? activeAssemblyBlocks
      .filter((block) => chromosomeVisibility.visibleIds.has(block.objectId))
      .map((block) => block.id)
    : [];
  const gfaGuidedContigIds = new Set([
    ...explicitlyVisibleChromosomeContigIds,
    ...[...automaticGfaGuidedContigIds].filter((id) => {
      const chromosomeId = chromosomeByBlockId.get(id);
      return chromosomeId === undefined
        || !knownAssemblyObjectIds.has(chromosomeId)
        || chromosomeVisibility.visibleIds.has(chromosomeId);
    }),
  ]);
  const selectedContactNormalization = contactNormalizationForBackend(uiState.normalization);
  const displayedContactNormalization = contactMap?.normalization;
  const displayedNormalizationLabel =
    displayedContactNormalization !== undefined
    && displayedContactNormalization !== selectedContactNormalization
      ? ` (showing ${contactNormalizationLabel(displayedContactNormalization)})`
      : "";
  const assemblyFileName = fileName(dataset?.agp_path, "Untitled assembly");
  const displayedAssemblyFileName = `${assemblyFileName}${isAgpDirty ? "*" : ""}`;

  function workspaceWidth() {
    return workspaceRef.current?.clientWidth
      ?? (typeof window === "undefined" ? 1_200 : window.innerWidth);
  }

  function currentInspectorWidth() {
    return workspaceRef.current
      ?.querySelector<HTMLElement>(".inspector")
      ?.getBoundingClientRect().width
      ?? inspectorWidth
      ?? defaultInspectorPanelWidth();
  }

  function setClampedInspectorWidth(width: number) {
    setInspectorWidth(clampInspectorPanelWidth(width, workspaceWidth()));
  }

  function beginInspectorResize(event: ReactPointerEvent<HTMLButtonElement>) {
    inspectorResizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: currentInspectorWidth(),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.documentElement.classList.add("inspector-resizing");
  }

  function resizeInspector(event: ReactPointerEvent<HTMLButtonElement>) {
    const resize = inspectorResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) {
      return;
    }
    setClampedInspectorWidth(resize.startWidth + resize.startX - event.clientX);
  }

  function endInspectorResize(event: ReactPointerEvent<HTMLButtonElement>) {
    if (inspectorResizeRef.current?.pointerId !== event.pointerId) {
      return;
    }
    inspectorResizeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    document.documentElement.classList.remove("inspector-resizing");
  }

  function handleInspectorResizeKey(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setClampedInspectorWidth(currentInspectorWidth() + inspectorPanelKeyboardStep);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setClampedInspectorWidth(currentInspectorWidth() - inspectorPanelKeyboardStep);
    } else if (event.key === "Home") {
      event.preventDefault();
      setInspectorWidth(null);
    }
  }

  function centerWorkspaceHeight() {
    return centerWorkspaceRef.current?.clientHeight
      ?? (typeof window === "undefined" ? 720 : window.innerHeight - 120);
  }

  function currentGfaPanelHeight() {
    return centerWorkspaceRef.current
      ?.querySelector<HTMLElement>(".gfa-graph-panel")
      ?.getBoundingClientRect().height
      ?? gfaPanelHeight
      ?? centerWorkspaceHeight() / 3;
  }

  function beginGfaResize(event: ReactPointerEvent<HTMLButtonElement>) {
    gfaResizeRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: currentGfaPanelHeight(),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.documentElement.classList.add("gfa-panel-resizing");
  }

  function resizeGfaPanel(event: ReactPointerEvent<HTMLButtonElement>) {
    const resize = gfaResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) {
      return;
    }
    setGfaPanelHeight(clampGfaPanelHeight(
      resize.startHeight + resize.startY - event.clientY,
      centerWorkspaceHeight(),
    ));
  }

  function endGfaResize(event: ReactPointerEvent<HTMLButtonElement>) {
    if (gfaResizeRef.current?.pointerId !== event.pointerId) {
      return;
    }
    gfaResizeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    document.documentElement.classList.remove("gfa-panel-resizing");
  }

  function selectSyntenyBlock(id: string, modifiers: SyntenySelectionModifiers) {
    const intent = assemblyContigSelectionIntent(
      activeAssemblyBlocks,
      uiState.assembly.selection,
      syntenySelectionAnchorRef.current,
      id,
      modifiers,
    );
    syntenySelectionAnchorRef.current = intent.anchorId;
    if (intent.type === "clear") {
      onUiAction({ type: "clearAssemblySelection" });
    } else if (intent.type === "select-range") {
      onUiAction({ type: "selectAssemblyContigs", ids: intent.ids });
    } else {
      onUiAction({ type: "selectAssemblyContig", id: intent.id, additive: intent.additive });
    }
  }

  function selectSyntenyBlocks(ids: string[]) {
    syntenySelectionAnchorRef.current = null;
    onUiAction({ type: "selectAssemblyContigs", ids });
  }

  useEffect(() => {
    function handleJuiceboxShortcut(event: KeyboardEvent) {
      const intent = juiceboxShortcutIntent({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        repeat: event.repeat,
        editable: isEditableShortcutTarget(event.target),
      });
      if (!intent) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      if (intent === "save") {
        if (uiState.assembly.blocks.length > 0) {
          onExportAgp();
        }
        return;
      }
      if (intent === "undo") {
        if (uiState.operationHistory.length > 0) {
          onUiAction({ type: "undo" });
        }
        return;
      }
      if (intent === "redo") {
        if (uiState.redoStack.length > 0) {
          onUiAction({ type: "redo" });
        }
        return;
      }
      if (intent === "toggle-resolution-lock") {
        onUiAction({ type: "toggleContactResolutionLock" });
      }
    }

    window.addEventListener("keydown", handleJuiceboxShortcut, true);
    return () => window.removeEventListener("keydown", handleJuiceboxShortcut, true);
  }, [
    onExportAgp,
    onUiAction,
    uiState.assembly.blocks.length,
    uiState.operationHistory.length,
    uiState.redoStack.length,
  ]);

  useEffect(() => () => {
    document.documentElement.classList.remove("inspector-resizing");
    document.documentElement.classList.remove("gfa-panel-resizing");
  }, []);

  useEffect(() => {
    if (!gfaDocument) {
      setGfaPanelOpen(false);
      setGfaPanelHeight(null);
    }
  }, [gfaDocument]);

  useEffect(() => {
    committedChromosomeFilterPatternRef.current = chromosomeFilterPattern;
    updateChromosomeFilterPatternDraft(chromosomeFilterPattern);
  }, [chromosomeFilterPattern]);

  useEffect(() => {
    function closeToolbarMenusOutside(event: PointerEvent) {
      for (const menu of [
        projectMenuRef.current,
        addDataMenuRef.current,
        chromosomeFilterMenuRef.current,
      ]) {
        if (menu?.open && !menu.contains(event.target as Node)) {
          if (menu === chromosomeFilterMenuRef.current) {
            commitChromosomeFilterPatternRef.current();
          }
          menu.open = false;
          if (menu === addDataMenuRef.current) {
            setConfirmingClearData(false);
            setConfirmingReloadAssembly(false);
          }
        }
      }
    }

    function closeToolbarMenusWithEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }
      for (const menu of [
        projectMenuRef.current,
        addDataMenuRef.current,
        chromosomeFilterMenuRef.current,
      ]) {
        if (menu?.open) {
          if (menu === chromosomeFilterMenuRef.current) {
            updateChromosomeFilterPatternDraft(
              committedChromosomeFilterPatternRef.current,
            );
          }
          menu.open = false;
          menu.querySelector<HTMLElement>("summary")?.focus();
          if (menu === addDataMenuRef.current) {
            setConfirmingClearData(false);
            setConfirmingReloadAssembly(false);
          }
        }
      }
    }

    document.addEventListener("pointerdown", closeToolbarMenusOutside);
    window.addEventListener("keydown", closeToolbarMenusWithEscape);
    return () => {
      document.removeEventListener("pointerdown", closeToolbarMenusOutside);
      window.removeEventListener("keydown", closeToolbarMenusWithEscape);
    };
  }, []);

  function runAddDataAction(action: () => void) {
    addDataMenuRef.current?.removeAttribute("open");
    setConfirmingClearData(false);
    setConfirmingReloadAssembly(false);
    action();
  }

  return (
    <main className="app-shell">
      <header className="app-toolbar-stack">
        <div className="global-toolbar">
          <div className="global-toolbar-leading">
            <div className="brand" aria-label="C-Studio">
              <img className="brand-mark" src={brandMarkUrl} alt="" />
              <strong>C-Studio</strong>
            </div>

            <details ref={projectMenuRef} className="toolbar-disclosure project-menu-disclosure">
              <summary className="project-picker" aria-label="Current assembly project menu">
                <span>{displayedAssemblyFileName}</span>
                <ChevronDown size={14} aria-hidden="true" />
              </summary>
              <div className="toolbar-popover project-menu-popover">
                <label
                  className={`project-menu-toggle${autoSaveAvailable ? "" : " disabled"}`}
                  title={autoSaveAvailable
                    ? "Save automatically 5 seconds after changes"
                    : "Save As once to enable auto-save"}
                >
                  <span>Auto-save</span>
                  <input
                    type="checkbox"
                    aria-label="Auto-save"
                    checked={autoSaveAvailable && autoSaveEnabled}
                    disabled={!autoSaveAvailable}
                    onChange={(event) => onAutoSaveEnabledChange(event.currentTarget.checked)}
                  />
                </label>
              </div>
            </details>

            <span className={`project-health ${agpImported ? "ready" : "idle"}`} aria-label={agpImported ? "Assembly loaded" : "Assembly not loaded"} />

            <details
              ref={addDataMenuRef}
              className="toolbar-disclosure add-data-disclosure"
              onToggle={(event) => {
                if (!event.currentTarget.open) {
                  setConfirmingClearData(false);
                  setConfirmingReloadAssembly(false);
                }
              }}
            >
              <summary
                className="global-action-button"
                title="Open data menu"
              >
                <Plus size={15} aria-hidden="true" />
                <span>Add Data</span>
                <ChevronDown size={13} aria-hidden="true" />
              </summary>
              <div className="toolbar-popover add-data-popover" aria-label="Add data">
                <button type="button" onClick={() => runAddDataAction(onLoadProject)}>
                  <span>Load project folder…</span>
                </button>
                <span className="popover-divider" aria-hidden="true" />
                <button
                  type="button"
                  title="Import an AGP and its same-prefix .history.json sidecar when present"
                  onClick={() => runAddDataAction(onAgpFileRequested)}
                >
                  <span>Assembly (.agp)</span>
                  {agpImported ? <Check size={14} aria-label="Loaded" /> : null}
                </button>
                {confirmingReloadAssembly ? (
                  <section
                    className="add-data-clear-confirmation"
                    role="alertdialog"
                    aria-labelledby="reload-assembly-title"
                    aria-describedby="reload-assembly-description"
                  >
                    <strong id="reload-assembly-title">Reload source assembly?</strong>
                    <p id="reload-assembly-description">
                      This restores the initially loaded source AGP and clears all assembly edits
                      and edit history. Other loaded data stays in the workspace.
                    </p>
                    <div className="add-data-clear-actions">
                      <button type="button" onClick={() => setConfirmingReloadAssembly(false)}>
                        Cancel
                      </button>
                      <button
                        className="add-data-clear-confirm"
                        type="button"
                        onClick={() => runAddDataAction(onReloadAssembly)}
                      >
                        Reload
                      </button>
                    </div>
                  </section>
                ) : (
                  <button
                    type="button"
                    disabled={!sourceAssemblyAvailable}
                    title={sourceAssemblyAvailable
                      ? "Discard all assembly edits and reload the source AGP"
                      : "No source AGP loaded"}
                    onClick={() => {
                      setConfirmingClearData(false);
                      setConfirmingReloadAssembly(true);
                    }}
                  >
                    <span>Reload assembly…</span>
                    <RefreshCcw size={14} aria-hidden="true" />
                  </button>
                )}
                <div className="add-data-source-row">
                  <button type="button" onClick={() => runAddDataAction(() => gfaInputRef.current?.click())}>
                    <span>Assembly graph (.gfa)</span>
                    {gfaImported ? <Check size={14} aria-label="Loaded" /> : null}
                  </button>
                  {gfaImported ? (
                    <button
                      className="add-data-unload-button"
                      type="button"
                      aria-label="Unload GFA assembly graph"
                      title="Unload only the GFA assembly graph"
                      onClick={() => runAddDataAction(onUnloadGfa)}
                    >
                      <X size={13} aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
                <div className="add-data-source-row">
                  <button type="button" onClick={() => runAddDataAction(onContactFileSelected)}>
                    <span>Contact map (.cool/.mcool)</span>
                    {contactImported ? <Check size={14} aria-label="Loaded" /> : null}
                  </button>
                  {contactImported ? (
                    <button
                      className="add-data-unload-button"
                      type="button"
                      aria-label="Unload contact map"
                      title="Unload only the contact map"
                      onClick={() => runAddDataAction(onUnloadContact)}
                    >
                      <X size={13} aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
                <div className="add-data-source-row">
                  <button type="button" onClick={() => runAddDataAction(onPafFileRequested)}>
                    <span>Synteny alignments (.paf)</span>
                    {syntenyImported ? <Check size={14} aria-label="Loaded" /> : null}
                  </button>
                  {syntenyImported ? (
                    <button
                      className="add-data-unload-button"
                      type="button"
                      aria-label="Unload PAF alignments"
                      title="Unload only the PAF alignments"
                      onClick={() => runAddDataAction(onUnloadPaf)}
                    >
                      <X size={13} aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
                <div className="add-data-source-row">
                  <button type="button" onClick={() => runAddDataAction(onCoverageFileRequested)}>
                    <span>Coverage track</span>
                    {coverageImported ? <Check size={14} aria-label="Loaded" /> : null}
                  </button>
                  {coverageImported ? (
                    <button
                      className="add-data-unload-button"
                      type="button"
                      aria-label="Unload coverage track"
                      title="Unload only the coverage track"
                      onClick={() => runAddDataAction(onUnloadCoverage)}
                    >
                      <X size={13} aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
                <span className="popover-divider" aria-hidden="true" />
                <button type="button" onClick={() => runAddDataAction(onLoadExample)}>
                  <span>Load example project</span>
                </button>
                <span className="popover-divider" aria-hidden="true" />
                {confirmingClearData ? (
                  <section
                    className="add-data-clear-confirmation"
                    role="alertdialog"
                    aria-labelledby="clear-loaded-data-title"
                    aria-describedby="clear-loaded-data-description"
                  >
                    <strong id="clear-loaded-data-title">Clear all loaded data?</strong>
                    <p id="clear-loaded-data-description">
                      This removes {loadedDataLabels.join(", ")} from the workspace.
                      {isAgpDirty ? " Unsaved assembly edits will be lost." : ""}
                    </p>
                    <div className="add-data-clear-actions">
                      <button type="button" onClick={() => setConfirmingClearData(false)}>
                        Cancel
                      </button>
                      <button
                        className="add-data-clear-confirm"
                        type="button"
                        onClick={() => runAddDataAction(onClearAllData)}
                      >
                        Clear all
                      </button>
                    </div>
                  </section>
                ) : (
                  <button
                    className="add-data-clear-button"
                    type="button"
                    disabled={!hasLoadedData}
                    title={hasLoadedData ? "Remove every loaded data source" : "No loaded data"}
                    onClick={() => {
                      setConfirmingReloadAssembly(false);
                      setConfirmingClearData(true);
                    }}
                  >
                    <span>Clear all loaded data…</span>
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                )}
              </div>
            </details>

            <label
              className={`global-homolog-pattern${gfaHomologPatternError ? " invalid" : ""}`}
            >
              <span>Homolog regex</span>
              <input
                type="text"
                aria-label="Homologous chromosome regular expression"
                value={gfaHomologPattern}
                spellCheck={false}
                onChange={(event) => onGfaHomologPatternChange(event.currentTarget.value)}
                title={gfaHomologPatternError
                  ?? "Global setting: capture group 1 defines a homolog column; group 2 orders chromosomes within it"}
              />
            </label>
            <details ref={chromosomeFilterMenuRef} className="chromosome-filter-menu">
              <summary
                aria-label="Filter chromosomes shown in assembly views"
                title="Filter chromosomes shown in the heatmap, dotplot, coverage, and GFA views"
              >
                <ListFilter size={13} aria-hidden="true" />
                <span>Chromosomes</span>
                <strong>
                  {visibleChromosomeCount}/{chromosomeIds.length}
                  {chromosomeVisibility.active
                    && includeUnanchoredInChromosomeFilter
                    && unanchoredObjectIds.length > 0
                    ? "+U"
                    : ""}
                </strong>
                <ChevronDown size={12} aria-hidden="true" />
              </summary>
              <section className="chromosome-filter-popover" aria-label="Chromosome display filter">
                <header>
                  <span>
                    <strong>Displayed chromosomes</strong>
                    <small>Heatmap · dotplot · coverage · GFA · AGP unchanged</small>
                  </span>
                  <span className="chromosome-filter-actions">
                    <button
                      type="button"
                      onClick={() => {
                        chromosomeCheckboxAnchorRef.current = null;
                        onHiddenChromosomeIdsChange(new Set());
                        onChromosomeFilterPatternChange("");
                        onIncludeUnanchoredInChromosomeFilterChange(false);
                      }}
                    >
                      All
                    </button>
                    <button
                      type="button"
                      disabled={chromosomeIds.length === 0}
                      onClick={() => {
                        chromosomeCheckboxAnchorRef.current = null;
                        onHiddenChromosomeIdsChange(new Set(chromosomeIds));
                        onChromosomeFilterPatternChange("");
                        onIncludeUnanchoredInChromosomeFilterChange(false);
                      }}
                    >
                      None
                    </button>
                  </span>
                </header>
                <label className={`chromosome-filter-regex${chromosomeVisibility.error ? " invalid" : ""}`}>
                  <span>Name regex</span>
                  <input
                    type="text"
                    aria-label="Chromosome display regular expression"
                    value={chromosomeFilterPatternDraft}
                    placeholder="e.g. ^Chr01"
                    spellCheck={false}
                    onChange={(event) => updateChromosomeFilterPatternDraft(
                      event.currentTarget.value,
                    )}
                    onBlur={() => commitChromosomeFilterPattern()}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        commitChromosomeFilterPattern();
                        event.currentTarget.blur();
                      }
                    }}
                    title={chromosomeVisibility.error
                      ?? "Press Enter or leave the field to apply this filter after the chromosome checkboxes"}
                  />
                </label>
                {chromosomeVisibility.error ? (
                  <p className="chromosome-filter-error" role="alert">
                    {chromosomeVisibility.error}
                  </p>
                ) : null}
                <label
                  className="chromosome-filter-unanchored"
                  title={unanchoredObjectIds.length > 0
                    ? "Include unmatched or unanchored AGP objects with the active chromosome filter. Use None plus this option to show only unanchored objects."
                    : "No unmatched or unanchored AGP objects are available"}
                >
                  <input
                    type="checkbox"
                    aria-label="Include unanchored objects in chromosome filter"
                    checked={includeUnanchoredInChromosomeFilter}
                    disabled={unanchoredObjectIds.length === 0}
                    onChange={(event) => onIncludeUnanchoredInChromosomeFilterChange(
                      event.currentTarget.checked,
                    )}
                  />
                  <span>
                    <strong>Unanchored / unmatched</strong>
                    <small>
                      {unanchoredObjectIds.length.toLocaleString()} AGP {unanchoredObjectIds.length === 1
                        ? "object"
                        : "objects"}
                    </small>
                  </span>
                </label>
                <div className="chromosome-filter-list" role="group" aria-label="Chromosome checkboxes">
                  {chromosomeIds.length === 0 ? (
                    <p>No chromosomes match the Homolog regex.</p>
                  ) : chromosomeIds.map((chromosomeId) => {
                    const checked = !hiddenChromosomeIds.has(chromosomeId);
                    const regexVisible = chromosomeVisibility.error !== null
                      || chromosomeFilterPattern.trim() === ""
                      || chromosomeVisibility.visibleIds.has(chromosomeId);
                    return (
                      <label
                        key={chromosomeId}
                        className={regexVisible ? undefined : "regex-excluded"}
                        title={regexVisible ? chromosomeId : `${chromosomeId} is excluded by the regex`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(event) => {
                            const visible = event.currentTarget.checked;
                            const shiftKey = "shiftKey" in event.nativeEvent
                              && event.nativeEvent.shiftKey === true;
                            const anchorId = shiftKey
                              ? chromosomeCheckboxAnchorRef.current
                              : null;
                            const next = updateHiddenChromosomeSelection(
                              chromosomeIds,
                              hiddenChromosomeIds,
                              chromosomeId,
                              visible,
                              anchorId,
                            );
                            if (!shiftKey || anchorId === null || !chromosomeIds.includes(anchorId)) {
                              chromosomeCheckboxAnchorRef.current = chromosomeId;
                            }
                            onHiddenChromosomeIdsChange(next);
                          }}
                        />
                        <span>{chromosomeId}</span>
                      </label>
                    );
                  })}
                </div>
                <footer>
                  Showing {visibleChromosomeCount.toLocaleString()} of {chromosomeIds.length.toLocaleString()} chromosomes
                  {chromosomeVisibility.active
                    ? ` · Unanchored ${includeUnanchoredInChromosomeFilter ? "included" : "excluded"}`
                    : unanchoredObjectIds.length > 0
                      ? " · All data shown by default"
                      : ""}
                  {chromosomeIds.length > 1 ? " · Shift-click for a range" : ""}
                </footer>
              </section>
            </details>
          </div>

          <div className="global-toolbar-trailing" aria-label="Project actions">
            <input
              ref={agpInputRef}
              className="file-input"
              type="file"
              accept=".agp,.agp.gz,.txt,.txt.gz"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) {
                  onAgpFileSelected(file);
                }
                event.currentTarget.value = "";
              }}
            />
            <input
              ref={pafInputRef}
              className="file-input"
              type="file"
              accept=".paf,.paf.gz,.txt,.txt.gz"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) {
                  onPafFileSelected(file);
                }
                event.currentTarget.value = "";
              }}
            />
            <input
              ref={gfaInputRef}
              className="file-input"
              type="file"
              accept=".gfa,.gfa.gz,.gfa1,.gfa1.gz,.txt,.txt.gz"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) {
                  onGfaFileSelected(file);
                }
                event.currentTarget.value = "";
              }}
            />
            <input
              ref={coverageInputRef}
              className="file-input"
              type="file"
              accept=".depth,.depth.gz,.bedgraph,.bedgraph.gz,.bedGraph,.bg,.bg.gz,.txt,.txt.gz"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) {
                  onCoverageFileSelected(file);
                }
                event.currentTarget.value = "";
              }}
            />

            <button
              className="global-icon-button"
              type="button"
              aria-label="Undo"
              aria-keyshortcuts="Control+Z Meta+Z Control+U Meta+U"
              title={`Undo (${shortcuts.undo}; Alternate shortcut: ${shortcuts.legacyUndo})`}
              disabled={uiState.operationHistory.length === 0}
              onClick={() => onUiAction({ type: "undo" })}
            >
              <Undo2 size={16} aria-hidden="true" />
            </button>
            <button
              className="global-icon-button"
              type="button"
              aria-label="Redo"
              aria-keyshortcuts="Meta+Shift+Z Control+Y Control+R Meta+R"
              title={`Redo (${shortcuts.redo}; Alternate shortcut: ${shortcuts.legacyRedo})`}
              disabled={uiState.redoStack.length === 0}
              onClick={() => onUiAction({ type: "redo" })}
            >
              <Redo2 size={16} aria-hidden="true" />
            </button>
            <span className="toolbar-hairline" aria-hidden="true" />
            <button
              className="global-icon-button export-project-button"
              type="button"
              aria-label="Save edited AGP"
              aria-keyshortcuts="Control+S Meta+S"
              title={`Save edited AGP and operation history (${shortcuts.save})`}
              disabled={!uiState.assembly.blocks.length}
              onClick={() => onExportAgp()}
            >
              <Save size={16} aria-hidden="true" />
            </button>
            <button
              className="global-icon-button export-project-button"
              type="button"
              aria-label="Save edited AGP as"
              title="Save edited AGP and operation history as a new pair"
              disabled={!uiState.assembly.blocks.length}
              onClick={() => onExportAgpAs()}
            >
              <SaveAll size={16} aria-hidden="true" />
            </button>
            <button
              className={`global-icon-button${uiState.layout.rightCollapsed ? "" : " active"}`}
              type="button"
              aria-label={uiState.layout.rightCollapsed ? "Show inspector" : "Hide inspector"}
              title="Show or hide inspector"
              aria-pressed={!uiState.layout.rightCollapsed}
              onClick={() => onUiAction({ type: "toggleLayoutPanel", panel: "right" })}
            >
              <PanelRight size={16} aria-hidden="true" />
            </button>
            <details ref={appMenuRef} className="toolbar-disclosure app-menu-disclosure">
              <summary className="global-icon-button" aria-label="More project information">
                <Ellipsis size={17} aria-hidden="true" />
              </summary>
              <div className="toolbar-popover app-menu-popover">
                <p><span>Version</span><strong>{status.version}</strong></p>
                <p><span>Core</span><strong>{status.engine}</strong></p>
                <p><span>Coordinates</span><strong>{status.coordinate_convention}</strong></p>
                <p><span>Status</span><strong>{statusMessage}</strong></p>
                <span className="popover-divider" aria-hidden="true" />
                <section className="app-shortcuts" aria-label="Keyboard shortcuts">
                  <h3>Keyboard shortcuts</h3>
                  <dl>
                    <div><dt>Save AGP</dt><dd>{shortcuts.save}</dd></div>
                    <div><dt>Undo</dt><dd>{shortcuts.undo}</dd></div>
                    <div><dt>Redo</dt><dd>{shortcuts.redo}</dd></div>
                    <div><dt>Rename</dt><dd>{shortcuts.rename}</dd></div>
                    <div><dt>Reverse / rotate</dt><dd>{shortcuts.reverse}</dd></div>
                    <div><dt>Copy</dt><dd>{shortcuts.copy}</dd></div>
                    <div><dt>Move to debris</dt><dd>{shortcuts.moveToDebris}</dd></div>
                    <div><dt>Delete gap / join</dt><dd>{shortcuts.deleteGap}</dd></div>
                    <div><dt>Delete contig</dt><dd>{shortcuts.deleteContig}</dd></div>
                    <div><dt>Switch resolution</dt><dd>{shortcuts.resolutionWheel}</dd></div>
                    <div><dt>Lock resolution</dt><dd>{shortcuts.resolutionLock}</dd></div>
                    <div><dt>Pan diagonally</dt><dd>{shortcuts.diagonalWheel}</dd></div>
                    <div><dt>Pan vertically</dt><dd>{shortcuts.verticalWheel}</dd></div>
                    <div><dt>Deselect / cancel</dt><dd>Esc</dd></div>
                  </dl>
                </section>
              </div>
            </details>
          </div>
        </div>

        <HeatmapToolbar
          uiState={uiState}
          onUiAction={onUiAction}
          totalSpanMb={totalSpanMb}
          useStoredResolutionOptions={contactIsMcool}
          availableResolutionBasePairs={contactAvailableResolutions}
          onContactResolutionPreview={onContactResolutionPreview}
        />
      </header>

      <section
        ref={workspaceRef}
        className={`workspace${uiState.layout.rightCollapsed ? " right-collapsed" : ""}`}
        style={inspectorWidth === null
          ? undefined
          : ({ "--inspector-width": `${inspectorWidth}px` } as CSSProperties)}
      >
        <section
          ref={centerWorkspaceRef}
          className={`center-workspace${gfaPanelOpen && gfaDocument ? " gfa-open" : ""}${
            heatmapPanelOpen ? "" : " heatmap-closed"
          }${uiState.layout.syntenySplitOpen ? " synteny-open" : ""}`}
          aria-label="Assembly contact map workspace"
          style={gfaPanelHeight === null
            ? undefined
            : ({ "--gfa-panel-height": `${gfaPanelHeight}px` } as CSSProperties)}
        >
          <section className="map-stack">
            <section className={`main-view${
              heatmapPanelOpen && uiState.layout.syntenySplitOpen ? " split-open" : ""
            }${heatmapPanelOpen ? "" : " heatmap-closed"}`}>
              {heatmapPanelOpen ? (
                <ContactMapViewport
                  dataset={dataset}
                  contactMap={contactMap}
                  contactTileDeltaStream={contactTileDeltaStream}
                  overviewContactMap={overviewContactMap}
                  coverageView={coverageView}
                  assemblyBlocks={viewAssemblyBlocks}
                  uiState={uiState}
                  homologPattern={gfaHomologPattern}
                  useStoredResolutionOptions={contactIsMcool}
                  availableResolutionBasePairs={contactAvailableResolutions}
                  placementPreview={placementPreview}
                  contactViewportPreview={contactViewportPreview}
                  onClosePanel={closeHeatmapPanel}
                  onExpandPanel={expandHeatmapPanel}
                  onUiAction={onUiAction}
                  onContactPanGestureStart={onContactPanGestureStart}
                  onContactPanTilePrefetch={onContactPanTilePrefetch}
                  onContactViewportPreview={onContactViewportPreview}
                  onPresentedViewportChange={setPresentedContactViewport}
                  contactPanPrefetchBridge={contactPanPrefetchBridge}
                  onContactTileLayerCommit={onContactTileLayerCommit}
                  onContactTileLayerPaintComplete={onContactTileLayerPaintComplete}
                />
              ) : null}
              {uiState.layout.syntenySplitOpen ? (
                <aside className="synteny-split-pane" aria-label="Synteny split view">
                  <div className="split-pane-header">
                    <strong>Synteny</strong>
                    <span className="split-pane-actions">
                      {!heatmapPanelOpen ? (
                        <button
                          className="global-icon-button"
                          type="button"
                          aria-label="Restore heatmap window"
                          title="Restore heatmap window"
                          onClick={() => setHeatmapPanelOpen(true)}
                        >
                          <Maximize2 size={11} aria-hidden="true" />
                        </button>
                      ) : null}
                      <button
                        className="global-icon-button"
                        type="button"
                        aria-label="Close synteny split view"
                        onClick={() => {
                          onUiAction({ type: "setSyntenySplitOpen", open: false });
                          if (!heatmapPanelOpen && !gfaPanelOpen) {
                            setHeatmapPanelOpen(true);
                          }
                        }}
                      >
                        ×
                      </button>
                    </span>
                  </div>
                  <SyntenyDotplot
                    syntenyView={syntenyView}
                    totalSpanMb={totalSpanMb}
                    assemblyBlocks={viewAssemblyBlocks}
                    selectedAssemblyBlockIds={selectedAssemblyBlockIds}
                    onSelectBlock={selectSyntenyBlock}
                    onSelectBlocks={selectSyntenyBlocks}
                    uiState={uiState}
                    onUiAction={onUiAction}
                  />
                </aside>
              ) : null}
            </section>
          </section>
          {gfaPanelOpen && gfaDocument ? (
            <>
              {heatmapPanelOpen || uiState.layout.syntenySplitOpen ? <button
                type="button"
                className="gfa-panel-resize-handle"
                role="separator"
                aria-label="Resize GFA graph panel"
                aria-orientation="horizontal"
                aria-valuemin={gfaPanelMinHeight}
                aria-valuenow={Math.round(gfaPanelHeight ?? centerWorkspaceHeight() / 3)}
                title="Drag to resize the GFA graph panel; double-click to reset"
                onPointerDown={beginGfaResize}
                onPointerMove={resizeGfaPanel}
                onPointerUp={endGfaResize}
                onPointerCancel={endGfaResize}
                onDoubleClick={() => setGfaPanelHeight(null)}
              /> : null}
              <GfaGraphPanel
                document={gfaDocument}
                assemblyBlocks={activeAssemblyBlocks}
                contactMap={overviewContactMap}
                onLayoutBandage={onLayoutGfaBandage}
                onLoadEndpointHiC={onLoadGfaEndpointHiC}
                onLoadEndpointHiCBatch={onLoadGfaEndpointHiCBatch}
                selectedAssemblyBlockIds={selectedAssemblyBlockIds}
                homologPattern={gfaHomologPattern}
                visibleScaffoldIds={gfaVisibleHomologScaffoldIds}
                visibleContigIds={gfaGuidedContigIds}
                chromosomeFilterActive={chromosomeVisibility.active}
                onRestoreHeatmap={!heatmapPanelOpen && !uiState.layout.syntenySplitOpen
                  ? () => setHeatmapPanelOpen(true)
                  : undefined}
                onClose={() => {
                  setGfaPanelOpen(false);
                  if (!heatmapPanelOpen && !uiState.layout.syntenySplitOpen) {
                    setHeatmapPanelOpen(true);
                  }
                }}
                onSelectOccurrences={(ids) => onUiAction({
                  type: "selectAssemblyContigs",
                  ids,
                })}
                uiState={uiState}
                onUiAction={onUiAction}
              />
            </>
          ) : null}
        </section>

        {uiState.layout.rightCollapsed ? null : (
          <>
            <button
              type="button"
              className="inspector-resize-handle"
              role="separator"
              aria-label="Resize inspector"
              aria-orientation="vertical"
              aria-valuemin={inspectorPanelMinWidth}
              aria-valuemax={inspectorPanelMaxWidth}
              aria-valuenow={Math.round(inspectorWidth ?? defaultInspectorPanelWidth())}
              title="Drag to resize inspector; double-click to reset"
              onPointerDown={beginInspectorResize}
              onPointerMove={resizeInspector}
              onPointerUp={endInspectorResize}
              onPointerCancel={endInspectorResize}
              onDoubleClick={() => setInspectorWidth(null)}
              onKeyDown={handleInspectorResizeKey}
            />
            <InspectorPanel
              dataset={dataset}
              contactMap={contactMap}
              overviewContactMap={overviewContactMap}
              presentedContactViewport={presentedContactViewport}
              status={status}
              statusMessage={statusMessage}
              isAgpDirty={isAgpDirty}
              uiState={uiState}
              onUiAction={onUiAction}
              syntenyView={syntenyView}
              assemblyBlocks={activeAssemblyBlocks}
              viewAssemblyBlocks={viewAssemblyBlocks}
              selectedAssemblyBlockIds={selectedAssemblyBlockIds}
              pafRecords={pafRecords}
              gfaDocument={gfaDocument}
              gfaHomologPattern={gfaHomologPattern}
              gfaPreviewScaffoldIds={gfaPreviewScaffoldIds}
              gfaChromosomeFilterActive={chromosomeVisibility.active}
              onLoadGfaEndpointHiCBatch={onLoadGfaEndpointHiCBatch}
              onLoadHiCAlleleConcordanceBatch={onLoadHiCAlleleConcordanceBatch}
              placementPreview={placementPreview}
              onPlacementPreviewChange={changePlacementPreview}
              onExpandHeatmap={expandHeatmapPanel}
              onOpenGfaPanel={() => setGfaPanelOpen(true)}
            />
          </>
        )}
      </section>

      <footer className="status-bar" role="status" aria-live="polite">
        <span>Resolution: {uiState.contact.resolution}</span>
        <span>
          Normalization: {uiState.normalization}{displayedNormalizationLabel}
        </span>
        <span>Matrix: {fileName(dataset?.mcool_path ?? dataset?.cool_path, "None")}</span>
        <span>Assembly: {dataset?.agp_path ? displayedAssemblyFileName : "None"}</span>
        <span>Tool: {uiState.selectedTool}</span>
        <span>X: {uiState.contact.viewportCenterXMb.toFixed(2)} Mb</span>
        <span>Y: {uiState.contact.viewportCenterYMb.toFixed(2)} Mb</span>
        <strong>{statusMessage}</strong>
        {contactTilePerformanceLog ? (
          <output aria-label="Contact resolution performance">{contactTilePerformanceLog}</output>
        ) : null}
        {contactPanPerformanceLog ? (
          <output aria-label="Contact pan performance">{contactPanPerformanceLog}</output>
        ) : null}
      </footer>
    </main>
  );
}
