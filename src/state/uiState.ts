import {
  addChromosomeBoundariesToSelection,
  createAssemblyBlockFromGfa,
  assemblyUnitIdForContig,
  copySelection,
  copySelectionBefore,
  deleteContigSelection,
  deleteGapsBetweenSelection,
  dissolveAssemblyBlockSelection,
  moveSelectionBefore,
  moveSelectionToDebris,
  placeUnplacedGfaSegment,
  removeChromosomeBoundariesFromSelection,
  assemblyRenameTarget,
  renameAssemblySelection,
  reverseSelection,
  selectChromosome,
  selectContig,
  selectContigs,
  selectedBlockIds,
  splitContigAtVisualPosition,
  type AssemblySelection,
} from "./assemblyEditing";
import type { ContactColorScale } from "./contactColorScale";
import {
  chooseContactResolutionForBpPerPixel,
  clampContactResolutionToViewport,
  contactResolutionToBasePairs,
  contactResolutionLevelsForBasePairs,
  contactResolutionLevelsForViewport,
  contactResolutionLevels,
  contactWholeGenomeViewportSpanMb,
  contactViewportSpanForResolution,
  minimumContactViewportSpanMb,
  wholeGenomeContactResolutionForViewport,
} from "./contactResolution";
import { contactViewportAxisSpans, type ContactViewport } from "./contactViewport";
import type { ContactMapLayoutBlock } from "./importers";
import type { GfaLinkEvidence } from "./gfa";
import { applyPlacementRecommendation } from "./assemblyPlacementRecommendation";

export type Tool = "select" | "split" | "move" | "flip" | "copy";
export type EditMode = "normal" | "advanced";
export type Resolution = "10 kb" | "25 kb" | "50 kb" | "100 kb";
export type ContactResolution =
  | "2.5 Mb"
  | "2 Mb"
  | "1 Mb"
  | "500 kb"
  | "250 kb"
  | "100 kb"
  | "50 kb"
  | "25 kb"
  | "10 kb"
  | "5 kb"
  | "2 kb"
  | "1 kb";

// Automatic dataset reconciliation may preserve the genomic viewport. Bound
// that compatibility path so resolving to a fine stored level cannot fan out
// into thousands of visible tile requests. Manual controls instead use the
// target level's default pixels-per-bin geometry.
const maxManualContactBinsPerAxis = 6_144;
export type ContactColormap =
  | "Graphite"
  | "Plum"
  | "redp1_r_half"
  | "redp1_r"
  | "Rose"
  | "Cividis"
  | "Mako"
  | "Amber"
  | "Reds"
  | "Viridis"
  | "Magma"
  | "Inferno"
  | "Turbo";
export type Normalization =
  | "None (Raw)"
  | "ICE (Balanced)"
  | "KR (Balanced)"
  | "VC (Coverage)"
  | "VC_SQRT";
export type ContactNormalization = "raw" | "ice" | "kr" | "vc" | "vc_sqrt";
export type ContextOperationType =
  | "delete_contig"
  | "move_to_debris"
  | "remove_chr_boundaries"
  | "add_chr_boundaries"
  | "copy_new"
  | "copy_to_group"
  | "reverse"
  | "move"
  | "split_contig"
  | "delete_gap"
  | "rename"
  | "create_block"
  | "place_unplaced"
  | "dissolve_block"
  | "place_recommendation";

export interface LogEntry {
  time: string;
  message: string;
}

export interface AssemblyHistorySnapshot {
  blocks: ContactMapLayoutBlock[];
  selection: AssemblySelection | null;
}

export interface OperationImpact {
  blockIds: string[];
  sourceIds: string[];
  chromosomeIds: string[];
  selection: AssemblySelection | null;
}

export interface OperationRecord {
  id: number;
  type: ContextOperationType;
  label: string;
  position: {
    x: number;
    y: number;
  };
  beforeAssembly?: AssemblyHistorySnapshot;
  afterAssembly?: AssemblyHistorySnapshot;
  impact?: OperationImpact;
}

export type TrackId = "coverage" | "agp";
export type LayoutPanel = "left" | "right" | "bottom";
export type ColorScaleField = "min" | "max";
export type OverviewMode = "overview" | "synteny" | "gfa";

export interface UiState {
  selectedTool: Tool;
  editMode: EditMode;
  snappingEnabled: boolean;
  resolution: Resolution;
  normalization: Normalization;
  activeBottomPanel: "command" | "messages";
  activeOverviewMode: OverviewMode;
  logEntries: LogEntry[];
  operationHistory: OperationRecord[];
  redoStack: OperationRecord[];
  nextOperationId: number;
  historyPreviewOperationId: number | null;
  tracks: {
    coverageVisible: boolean;
    agpVisible: boolean;
  };
  agpBlockWidths: number[];
  layout: {
    leftCollapsed: boolean;
    rightCollapsed: boolean;
    bottomCollapsed: boolean;
    syntenySplitOpen: boolean;
  };
  contact: {
    resolution: ContactResolution;
    resolutionLocked: boolean;
    viewportSizePx: number;
    viewportWidthPx: number;
    viewportHeightPx: number;
    totalSpanMb: number;
    viewportCenterMb: number;
    viewportCenterXMb: number;
    viewportCenterYMb: number;
    viewportSpanMb: number;
    jumpTargetMb: number;
    colormap: ContactColormap;
    colorScale: ContactColorScale;
    colorScaleByResolution: Partial<Record<ContactResolution, ContactColorScale>>;
  };
  assembly: {
    blocks: ContactMapLayoutBlock[];
    selection: AssemblySelection | null;
    showChromosomeBoxes: boolean;
    showBlockBoxes: boolean;
    showContigBoxes: boolean;
  };
}

export type UiAction =
  | { type: "selectTool"; tool: Tool }
  | { type: "setEditMode"; mode: EditMode }
  | { type: "toggleSnapping" }
  | { type: "setResolution"; resolution: Resolution }
  | { type: "setNormalization"; normalization: Normalization }
  | { type: "setBottomPanel"; panel: UiState["activeBottomPanel"] }
  | { type: "setOverviewMode"; mode: OverviewMode }
  | {
      type: "applyContextOperation";
      operation: ContextOperationType;
      label: string;
      position: OperationRecord["position"];
    }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "undoToHistoryOperation"; id: number }
  | { type: "focusHistoryOperation"; id: number }
  | { type: "previewHistoryOperation"; id: number | null }
  | { type: "toggleTrackVisibility"; track: TrackId }
  | { type: "setAgpBlockWidth"; index: number; width: number }
  | { type: "toggleLayoutPanel"; panel: LayoutPanel }
  | { type: "setSyntenySplitOpen"; open: boolean }
  | { type: "adjustContactResolution"; direction: "decrease" | "increase" }
  | {
      type: "setContactResolution";
      resolution: ContactResolution;
      /** Automatic dataset reconciliation may retain the current local window. */
      preserveViewport?: boolean;
      /** Keep the genomic coordinates under a wheel/pinch focus point stable. */
      focusRatioX?: number;
      focusRatioY?: number;
      /** Absolute anchors captured from the camera that is actually visible. */
      focusXMb?: number;
      focusYMb?: number;
    }
  | { type: "toggleContactResolutionLock" }
  | {
      type: "setContactViewportMetrics";
      viewportSizePx: number;
      viewportWidthPx?: number;
      viewportHeightPx?: number;
      totalSpanMb: number;
    }
  | { type: "setContactJumpTarget"; valueMb: number }
  | { type: "jumpContactViewport" }
  | {
      type: "jumpContactViewportToRegions";
      xCenterBp: number;
      yCenterBp: number;
      selectedBlockIds: string[];
      totalSpanMb: number;
      label: string;
      transient?: boolean;
    }
  | { type: "panContactViewport"; deltaMb?: number; deltaXMb?: number; deltaYMb?: number }
  | {
      type: "commitContactViewportPan";
      viewport: ContactViewport;
      totalSpanMb: number;
    }
  | {
      type: "zoomContactViewport";
      direction: "in" | "out";
      /** Legacy X-axis focus. New contact-map interactions should pass both axes. */
      focusRatio?: number;
      focusRatioX?: number;
      focusRatioY?: number;
      /** Absolute anchors captured from the camera that is actually visible. */
      focusXMb?: number;
      focusYMb?: number;
      /** Juicebox-style scale: greater than 1 zooms in; less than 1 zooms out. */
      scaleFactor?: number;
      /** Step to the adjacent data resolution and reset it to its default pixels-per-bin. */
      snapToResolution?: boolean;
      totalSpanMb: number;
    }
  | { type: "fitContactViewport"; totalSpanMb: number }
  | { type: "setContactViewportFromOverview"; ratio: number; totalSpanMb: number }
  | {
      type: "setContactViewportCenterFromOverview";
      xRatio: number;
      yRatio: number;
      totalSpanMb: number;
      transient?: boolean;
    }
  | {
      type: "setContactViewportAxisFromNavigator";
      axis: "x" | "y";
      ratio: number;
      totalSpanMb: number;
    }
  | { type: "setContactColormap"; colormap: ContactColormap }
  | { type: "setColorScale"; field: ColorScaleField; value: number }
  | { type: "setAutoColorScale"; scale: ContactColorScale }
  | { type: "resetColorScaleAuto" }
  | { type: "toggleColorScaleLog" }
  | { type: "setAssemblyBlocks"; blocks: ContactMapLayoutBlock[] }
  | {
      type: "restoreAssemblyHistory";
      blocks: ContactMapLayoutBlock[];
      operationHistory: OperationRecord[];
      redoStack: OperationRecord[];
      nextOperationId: number;
    }
  | { type: "toggleAssemblyOverlay"; overlay: "chromosome" | "block" | "contig" }
  | { type: "selectAssemblyContig"; id: string; additive: boolean }
  | { type: "focusAssemblyContig"; id: string }
  | { type: "selectAssemblyContigs"; ids: string[] }
  | { type: "selectAssemblyOccurrences"; ids: string[] }
  | { type: "selectAssemblyChromosome"; id: string }
  | { type: "focusAssemblyChromosome"; id: string }
  | { type: "clearAssemblySelection" }
  | { type: "reverseAssemblySelection" }
  | {
      type: "moveAssemblySelectionBefore";
      targetBlockId: string | null;
      targetObjectId?: string;
    }
  | {
      type: "applyAssemblyPlacementRecommendation";
      selectedBlockIds: string[];
      targetBlockId: string | null;
      targetObjectId: string;
      orientation: "+" | "-";
    }
  | { type: "moveAssemblySelectionToDebris" }
  | { type: "deleteAssemblySelection" }
  | {
      type: "placeUnplacedGfaSegment";
      segmentName: string;
      length: number;
      targetObjectId: string;
      targetBlockId: string | null;
      orientation: "+" | "-";
    }
  | { type: "createAssemblyBlockFromGfa"; links: GfaLinkEvidence[] }
  | { type: "dissolveAssemblyBlockSelection" }
  | { type: "addAssemblyChromosomeBoundaries" }
  | { type: "removeAssemblyChromosomeBoundaries" }
  | { type: "copyAssemblySelection" }
  | { type: "copyAssemblySelectionBefore"; targetBlockId: string }
  | { type: "copyAssemblyContig"; id: string }
  | { type: "splitAssemblyContig"; blockId: string; visualPosition: number }
  | { type: "deleteAssemblyGaps" }
  | { type: "renameAssemblySelection"; name: string }
  | { type: "clearLoadedData" }
  | { type: "appendLog"; message: string };

export const resolutions: Resolution[] = ["10 kb", "25 kb", "50 kb", "100 kb"];
export const contactResolutions: ContactResolution[] = [...contactResolutionLevels];
export const contactColormaps: ContactColormap[] = [
  "redp1_r_half",
  "Reds",
  "Graphite",
  "Plum",
  "redp1_r",
  "Rose",
  "Cividis",
  "Mako",
  "Amber",
  "Magma",
  "Viridis",
  "Inferno",
  "Turbo",
];
export const normalizations: Normalization[] = [
  "None (Raw)",
  "ICE (Balanced)",
  "KR (Balanced)",
  "VC (Coverage)",
  "VC_SQRT",
];

const contactNormalizationByLabel: Record<Normalization, ContactNormalization> = {
  "None (Raw)": "raw",
  "ICE (Balanced)": "ice",
  "KR (Balanced)": "kr",
  "VC (Coverage)": "vc",
  VC_SQRT: "vc_sqrt",
};

export function contactNormalizationForBackend(
  normalization: Normalization,
): ContactNormalization {
  return contactNormalizationByLabel[normalization];
}

export function contactNormalizationLabel(
  normalization: ContactNormalization,
): Normalization {
  switch (normalization) {
    case "raw":
      return "None (Raw)";
    case "ice":
      return "ICE (Balanced)";
    case "kr":
      return "KR (Balanced)";
    case "vc":
      return "VC (Coverage)";
    case "vc_sqrt":
      return "VC_SQRT";
  }
}

export function availableContactResolutions(
  contact: UiState["contact"],
  totalSpanMb = contact.totalSpanMb,
  preserveViewport = false,
): ContactResolution[] {
  const wholeGenomeViewportSpanMb = maximumContactViewportSpanMb(
    totalSpanMb,
    contact.viewportWidthPx,
    contact.viewportHeightPx,
  );

  const fittedLevels = contactResolutionLevelsForViewport(
    wholeGenomeViewportSpanMb,
    contact.viewportSizePx,
  );
  const fittedIndex = contactResolutionLevels.indexOf(fittedLevels[0] ?? contact.resolution);
  const currentIndex = contactResolutionLevels.indexOf(contact.resolution);

  // A resize preserves the current pixels-per-bin even when a larger window
  // could fit the whole genome at a finer level. Keep that transient coarser
  // level represented by the slider until the user explicitly changes it.
  const firstIndex = currentIndex >= 0 && currentIndex < fittedIndex
    ? currentIndex
    : fittedIndex;
  const firstAvailableIndex = Math.max(0, firstIndex);
  if (!preserveViewport) {
    return [...contactResolutionLevels.slice(firstAvailableIndex)];
  }
  const { xSpanMb, ySpanMb } = contactViewportAxisSpansMb(
    contact.viewportSpanMb,
    totalSpanMb,
    contact.viewportWidthPx,
    contact.viewportHeightPx,
  );
  const longestViewportSpanBp = Math.max(xSpanMb, ySpanMb) * 1_000_000;
  const lastSafeIndex = contactResolutionLevels.reduce(
    (lastIndex, resolution, index) => (
      longestViewportSpanBp / contactResolutionToBasePairs(resolution)
        <= maxManualContactBinsPerAxis
        ? index
        : lastIndex
    ),
    firstAvailableIndex,
  );
  // Preserve the active level after a resize or restored session even if it
  // temporarily exceeds this background-load budget. Imported-dataset
  // controls enumerate stored levels separately; an explicit fine-level
  // choice narrows the viewport instead of silently changing the resolution.
  const lastAvailableIndex = currentIndex >= firstAvailableIndex
    ? Math.max(lastSafeIndex, currentIndex)
    : lastSafeIndex;

  return [...contactResolutionLevels.slice(firstAvailableIndex, lastAvailableIndex + 1)];
}

export function availableContactResolutionsForDataset(
  contact: UiState["contact"],
  availableBasePairs: readonly number[],
  totalSpanMb = contact.totalSpanMb,
  preserveViewport = true,
): ContactResolution[] {
  const viewportResolutions = availableContactResolutions(
    contact,
    totalSpanMb,
    preserveViewport,
  );
  if (availableBasePairs.length === 0) {
    return viewportResolutions;
  }
  const storedResolutions = new Set(
    contactResolutionLevelsForBasePairs(availableBasePairs),
  );

  return viewportResolutions.filter((resolution) => storedResolutions.has(resolution));
}

/** Every supported pyramid level physically stored in an imported dataset. */
export function storedContactResolutionsForDataset(
  availableBasePairs: readonly number[],
): ContactResolution[] {
  return [...contactResolutionLevelsForBasePairs(availableBasePairs)];
}

export function createInitialUiState(initialMessage: string): UiState {
  return {
    selectedTool: "select",
    editMode: "normal",
    snappingEnabled: true,
    resolution: "10 kb",
    normalization: "None (Raw)",
    activeBottomPanel: "command",
    activeOverviewMode: "overview",
    logEntries: [
      { time: "10:21:33", message: "Backend connected" },
      { time: "10:21:33", message: "Core version: 0.1.0" },
      { time: "10:21:33", message: initialMessage },
    ],
    operationHistory: [],
    redoStack: [],
    nextOperationId: 1,
    historyPreviewOperationId: null,
    tracks: {
      coverageVisible: true,
      agpVisible: true,
    },
    agpBlockWidths: [170, 160, 150, 90, 170, 160],
    layout: {
      leftCollapsed: false,
      rightCollapsed: false,
      bottomCollapsed: true,
      syntenySplitOpen: false,
    },
    contact: {
      resolution: wholeGenomeContactResolutionForViewport(200, 640),
      resolutionLocked: false,
      viewportSizePx: 640,
      viewportWidthPx: 640,
      viewportHeightPx: 640,
      totalSpanMb: 200,
      viewportCenterMb: 98.42,
      viewportCenterXMb: 98.42,
      viewportCenterYMb: 98.42,
      viewportSpanMb: 200,
      jumpTargetMb: 98.42,
      colormap: "redp1_r_half",
      colorScale: {
        log: false,
        min: 0,
        max: 1,
        auto: true,
      },
      colorScaleByResolution: {},
    },
    assembly: {
      blocks: [],
      selection: null,
      showChromosomeBoxes: true,
      showBlockBoxes: true,
      showContigBoxes: true,
    },
  };
}

export function reduceUiState(state: UiState, action: UiAction): UiState {
  switch (action.type) {
    case "clearLoadedData": {
      const initial = createInitialUiState("All loaded data cleared");
      return withLog(
        {
          ...state,
          activeOverviewMode: "overview",
          operationHistory: [],
          redoStack: [],
          nextOperationId: 1,
          historyPreviewOperationId: null,
          layout: {
            ...state.layout,
            syntenySplitOpen: false,
          },
          contact: {
            ...initial.contact,
            viewportSizePx: state.contact.viewportSizePx,
            viewportWidthPx: state.contact.viewportWidthPx,
            viewportHeightPx: state.contact.viewportHeightPx,
            colormap: state.contact.colormap,
          },
          assembly: {
            ...state.assembly,
            blocks: [],
            selection: null,
          },
        },
        "All loaded data cleared",
      );
    }
    case "selectTool":
      return withLog({ ...state, selectedTool: action.tool }, `Tool selected: ${capitalize(action.tool)}`);
    case "setEditMode":
      return withLog({ ...state, editMode: action.mode }, `Edit mode set to ${capitalize(action.mode)}`);
    case "toggleSnapping": {
      const snappingEnabled = !state.snappingEnabled;
      return withLog(
        { ...state, snappingEnabled },
        snappingEnabled ? "Snapping enabled" : "Snapping disabled",
      );
    }
    case "setResolution":
      return withLog({ ...state, resolution: action.resolution }, `Resolution set to ${action.resolution}`);
    case "setNormalization":
      return withLog(
        { ...state, normalization: action.normalization },
        `Normalization set to ${action.normalization}`,
      );
    case "setBottomPanel":
      return { ...state, activeBottomPanel: action.panel };
    case "setOverviewMode":
      return { ...state, activeOverviewMode: action.mode };
    case "applyContextOperation": {
      const operation: OperationRecord = {
        id: state.nextOperationId,
        type: action.operation,
        label: action.label,
        position: action.position,
      };

      return withLog(
        {
          ...state,
          operationHistory: [...state.operationHistory, operation],
          redoStack: [],
          nextOperationId: state.nextOperationId + 1,
        },
        `${action.label} at ${Math.round(action.position.x)}, ${Math.round(action.position.y)}`,
      );
    }
    case "undo": {
      const operation = state.operationHistory[state.operationHistory.length - 1];
      if (!operation) {
        return withLog(state, "Nothing to undo");
      }

      return withLog(
        {
          ...state,
          operationHistory: state.operationHistory.slice(0, -1),
          redoStack: [...state.redoStack, operation],
          historyPreviewOperationId: null,
          assembly: operation.beforeAssembly
            ? {
                ...state.assembly,
                blocks: operation.beforeAssembly.blocks,
                selection: operation.beforeAssembly.selection,
              }
            : state.assembly,
        },
        `Undo: ${operation.label}`,
      );
    }
    case "redo": {
      const operation = state.redoStack[state.redoStack.length - 1];
      if (!operation) {
        return withLog(state, "Nothing to redo");
      }

      return withLog(
        {
          ...state,
          operationHistory: [...state.operationHistory, operation],
          redoStack: state.redoStack.slice(0, -1),
          historyPreviewOperationId: null,
          assembly: operation.afterAssembly
            ? {
                ...state.assembly,
                blocks: operation.afterAssembly.blocks,
                selection: operation.afterAssembly.selection,
              }
            : state.assembly,
        },
        `Redo: ${operation.label}`,
      );
    }
    case "undoToHistoryOperation": {
      const operationIndex = state.operationHistory.findIndex((operation) => operation.id === action.id);
      if (operationIndex < 0 || operationIndex === state.operationHistory.length - 1) {
        return state;
      }

      const operation = state.operationHistory[operationIndex];
      const operationsToUndo = state.operationHistory.slice(operationIndex + 1);
      return withLog(
        {
          ...state,
          operationHistory: state.operationHistory.slice(0, operationIndex + 1),
          redoStack: [...state.redoStack, ...operationsToUndo.reverse()],
          historyPreviewOperationId: null,
          assembly: operation.afterAssembly
            ? {
                ...state.assembly,
                blocks: operation.afterAssembly.blocks,
                selection: operation.afterAssembly.selection,
              }
            : state.assembly,
        },
        `Undo to: ${operation.label}`,
      );
    }
    case "focusHistoryOperation": {
      const operation = [...state.operationHistory, ...state.redoStack]
        .find((candidate) => candidate.id === action.id);
      const focus = operation ? historyOperationFocus(state.assembly.blocks, operation) : null;
      if (!focus) {
        return state;
      }

      return {
        ...state,
        contact: {
          ...state.contact,
          viewportCenterMb: focus.centerMb,
          viewportCenterXMb: focus.centerMb,
          viewportCenterYMb: focus.centerMb,
          jumpTargetMb: focus.centerMb,
        },
        assembly: {
          ...state.assembly,
          selection: focus.selection,
        },
      };
    }
    case "previewHistoryOperation":
      return state.historyPreviewOperationId === action.id
        ? state
        : { ...state, historyPreviewOperationId: action.id };
    case "toggleTrackVisibility": {
      const key = action.track === "coverage" ? "coverageVisible" : "agpVisible";
      const visible = !state.tracks[key];
      const label = action.track === "coverage" ? "Coverage Distribution" : "AGP Track";

      return withLog(
        {
          ...state,
          tracks: {
            ...state.tracks,
            [key]: visible,
          },
        },
        `${label} ${visible ? "shown" : "hidden"}`,
      );
    }
    case "setAgpBlockWidth": {
      const agpBlockWidths = state.agpBlockWidths.map((width, index) =>
        index === action.index ? clamp(action.width, 70, 260) : width,
      );

      return {
        ...state,
        agpBlockWidths,
      };
    }
    case "toggleLayoutPanel": {
      const key =
        action.panel === "left"
          ? "leftCollapsed"
          : action.panel === "right"
            ? "rightCollapsed"
            : "bottomCollapsed";

      return withLog(
        {
          ...state,
          layout: {
            ...state.layout,
            [key]: !state.layout[key],
          },
        },
        `${capitalize(action.panel)} panel ${state.layout[key] ? "expanded" : "collapsed"}`,
      );
    }
    case "setSyntenySplitOpen":
      return withLog(
        {
          ...state,
          layout: {
            ...state.layout,
            syntenySplitOpen: action.open,
          },
        },
        action.open ? "Synteny split view opened" : "Synteny split view closed",
      );
    case "adjustContactResolution": {
      const resolution = nextContactResolution(state, action.direction);
      return withLog(setContactResolution(state, resolution), `Contact resolution set to ${resolution}`);
    }
    case "setContactResolution": {
      const nextState = setContactResolution(
        state,
        action.resolution,
        action.preserveViewport ?? false,
        action.focusRatioX,
        action.focusRatioY,
        action.focusXMb,
        action.focusYMb,
      );
      const viewportNarrowed = nextState.contact.viewportSpanMb
        < state.contact.viewportSpanMb - 0.000001;
      return withLog(
        nextState,
        `Contact resolution set to ${nextState.contact.resolution}${
          viewportNarrowed
            ? `; viewport narrowed to ${nextState.contact.viewportSpanMb} Mb`
            : ""
        }`,
      );
    }
    case "toggleContactResolutionLock": {
      const resolutionLocked = !state.contact.resolutionLocked;

      return withLog(
        {
          ...state,
          contact: {
            ...state.contact,
            resolutionLocked,
          },
        },
        `Contact resolution ${resolutionLocked ? "locked" : "unlocked"}`,
      );
    }
    case "setContactViewportMetrics": {
      const viewportSizePx = sanitizeContactViewportSizePx(action.viewportSizePx);
      const viewportWidthPx = sanitizeContactViewportSizePx(
        action.viewportWidthPx ?? viewportSizePx,
      );
      const viewportHeightPx = sanitizeContactViewportSizePx(
        action.viewportHeightPx ?? viewportSizePx,
      );
      const totalSpanMb = sanitizeContactTotalSpanMb(action.totalSpanMb);
      if (
        viewportSizePx === state.contact.viewportSizePx
        && viewportWidthPx === state.contact.viewportWidthPx
        && viewportHeightPx === state.contact.viewportHeightPx
        && totalSpanMb === state.contact.totalSpanMb
      ) {
        return state;
      }

      const maximumViewportSpanMb = maximumContactViewportSpanMb(
        totalSpanMb,
        viewportWidthPx,
        viewportHeightPx,
      );
      const previousMaximumViewportSpanMb = maximumContactViewportSpanMb(
        state.contact.totalSpanMb,
        state.contact.viewportWidthPx,
        state.contact.viewportHeightPx,
      );
      const totalSpanChanged = totalSpanMb !== state.contact.totalSpanMb;
      const wasFittedToWholeGenome = sameContactViewportSpan(
        state.contact.viewportSpanMb,
        previousMaximumViewportSpanMb,
      );
      const previousViewportSizePx = sanitizeContactViewportSizePx(
        state.contact.viewportSizePx,
      );
      const resizedViewportSpanMb = state.contact.viewportSpanMb
        * viewportSizePx
        / previousViewportSizePx;
      const viewportSpanMb = roundContactViewportMb(
        totalSpanChanged && wasFittedToWholeGenome
          ? maximumViewportSpanMb
          : resizedViewportSpanMb,
      );
      const { xSpanMb, ySpanMb } = contactViewportAxisSpansMb(
        viewportSpanMb,
        totalSpanMb,
        viewportWidthPx,
        viewportHeightPx,
      );
      const viewportCenterXMb = clampContactViewportCenter(
        state.contact.viewportCenterXMb,
        xSpanMb,
        totalSpanMb,
      );
      const viewportCenterYMb = clampContactViewportCenter(
        state.contact.viewportCenterYMb,
        ySpanMb,
        totalSpanMb,
      );
      const wholeGenomeResolution = wholeGenomeContactResolutionForViewport(
        maximumViewportSpanMb,
        viewportSizePx,
      );
      const resolution = totalSpanChanged && wasFittedToWholeGenome
        ? wholeGenomeResolution
        : state.contact.resolution;
      const colorScale = resolution === state.contact.resolution
        ? state.contact.colorScale
        : state.contact.colorScaleByResolution[resolution] ?? {
            ...state.contact.colorScale,
            auto: true,
          };

      return {
        ...state,
        contact: {
          ...state.contact,
          viewportSizePx,
          viewportWidthPx,
          viewportHeightPx,
          totalSpanMb,
          viewportSpanMb,
          viewportCenterMb: roundContactViewportMb(
            (viewportCenterXMb + viewportCenterYMb) / 2,
          ),
          viewportCenterXMb,
          viewportCenterYMb,
          resolution,
          colorScale,
          jumpTargetMb: roundContactViewportMb(
            clamp(state.contact.jumpTargetMb, 0, totalSpanMb),
          ),
        },
      };
    }
    case "setContactJumpTarget":
      return {
        ...state,
        contact: {
          ...state.contact,
          jumpTargetMb: clamp(action.valueMb, 0, 1_000_000),
        },
      };
    case "jumpContactViewport":
      return withLog(
        {
          ...state,
          contact: {
            ...state.contact,
            viewportCenterMb: state.contact.jumpTargetMb,
            viewportCenterXMb: state.contact.jumpTargetMb,
            viewportCenterYMb: state.contact.jumpTargetMb,
          },
        },
        `Contact viewport jumped to ${state.contact.jumpTargetMb} Mb`,
      );
    case "jumpContactViewportToRegions": {
      const totalSpanMb = sanitizeContactTotalSpanMb(action.totalSpanMb);
      const viewportWidthPx = sanitizeContactViewportSizePx(state.contact.viewportWidthPx);
      const viewportHeightPx = sanitizeContactViewportSizePx(state.contact.viewportHeightPx);
      const viewportSpanMb = Number.isFinite(state.contact.viewportSpanMb)
        ? Math.max(0.000001, state.contact.viewportSpanMb)
        : totalSpanMb;
      const axisSpans = contactViewportAxisSpansMb(
        viewportSpanMb,
        totalSpanMb,
        viewportWidthPx,
        viewportHeightPx,
      );
      const viewportCenterXMb = clampContactViewportCenter(
        action.xCenterBp / 1_000_000,
        axisSpans.xSpanMb,
        totalSpanMb,
      );
      const viewportCenterYMb = clampContactViewportCenter(
        action.yCenterBp / 1_000_000,
        axisSpans.ySpanMb,
        totalSpanMb,
      );
      const viewportCenterMb = roundContactViewportMb(
        (viewportCenterXMb + viewportCenterYMb) / 2,
      );
      const selectedUnitIds = [...new Set(action.selectedBlockIds.map((id) => (
        assemblyUnitIdForContig(state.assembly.blocks, id)
      )))];

      const nextState = {
        ...state,
        assembly: {
          ...state.assembly,
          selection: action.transient
            ? state.assembly.selection
            : selectContigs(selectedUnitIds),
        },
        contact: {
          ...state.contact,
          totalSpanMb,
          viewportSpanMb,
          viewportCenterMb,
          viewportCenterXMb,
          viewportCenterYMb,
          jumpTargetMb: viewportCenterXMb,
        },
      };
      return action.transient
        ? nextState
        : withLog(nextState, `Contact viewport jumped to ${action.label}`);
    }
    case "panContactViewport": {
      const deltaXMb = action.deltaXMb ?? action.deltaMb ?? 0;
      const deltaYMb = action.deltaYMb ?? action.deltaMb ?? 0;
      const totalSpanMb = sanitizeContactTotalSpanMb(state.contact.totalSpanMb);
      const axisSpans = contactViewportAxisSpansMb(
        state.contact.viewportSpanMb,
        totalSpanMb,
        state.contact.viewportWidthPx,
        state.contact.viewportHeightPx,
      );
      const viewportCenterXMb = clampContactViewportCenter(
        state.contact.viewportCenterXMb + deltaXMb,
        axisSpans.xSpanMb,
        totalSpanMb,
      );
      const viewportCenterYMb = clampContactViewportCenter(
        state.contact.viewportCenterYMb + deltaYMb,
        axisSpans.ySpanMb,
        totalSpanMb,
      );
      const viewportCenterMb = roundContactViewportMb(
        (viewportCenterXMb + viewportCenterYMb) / 2,
      );

      if (
        viewportCenterXMb === state.contact.viewportCenterXMb
        && viewportCenterYMb === state.contact.viewportCenterYMb
      ) {
        return state;
      }

      return {
        ...state,
        contact: {
          ...state.contact,
          viewportCenterMb,
          viewportCenterXMb,
          viewportCenterYMb,
          jumpTargetMb: viewportCenterXMb,
        },
      };
    }
    case "commitContactViewportPan": {
      const totalSpanMb = sanitizeContactTotalSpanMb(action.totalSpanMb);
      const axisSpans = contactViewportAxisSpansMb(
        state.contact.viewportSpanMb,
        totalSpanMb,
        state.contact.viewportWidthPx,
        state.contact.viewportHeightPx,
      );
      const requestedCenterXMb = (action.viewport.xStart + action.viewport.xEnd) / 2_000_000;
      const requestedCenterYMb = (action.viewport.yStart + action.viewport.yEnd) / 2_000_000;
      const viewportCenterXMb = clampContactViewportCenter(
        Number.isFinite(requestedCenterXMb)
          ? requestedCenterXMb
          : state.contact.viewportCenterXMb,
        axisSpans.xSpanMb,
        totalSpanMb,
      );
      const viewportCenterYMb = clampContactViewportCenter(
        Number.isFinite(requestedCenterYMb)
          ? requestedCenterYMb
          : state.contact.viewportCenterYMb,
        axisSpans.ySpanMb,
        totalSpanMb,
      );
      const viewportCenterMb = roundContactViewportMb(
        (viewportCenterXMb + viewportCenterYMb) / 2,
      );

      if (
        totalSpanMb === state.contact.totalSpanMb
        && viewportCenterXMb === state.contact.viewportCenterXMb
        && viewportCenterYMb === state.contact.viewportCenterYMb
      ) {
        return state;
      }

      return {
        ...state,
        contact: {
          ...state.contact,
          totalSpanMb,
          viewportCenterMb,
          viewportCenterXMb,
          viewportCenterYMb,
          jumpTargetMb: viewportCenterXMb,
        },
      };
    }
    case "zoomContactViewport": {
      const totalSpanMb = sanitizeContactTotalSpanMb(action.totalSpanMb);
      const viewportSizePx = sanitizeContactViewportSizePx(state.contact.viewportSizePx);
      const maximumViewportSpanMb = maximumContactViewportSpanMb(
        totalSpanMb,
        state.contact.viewportWidthPx,
        state.contact.viewportHeightPx,
      );
      const viewportAspectExpansion = Math.max(
        state.contact.viewportWidthPx,
        state.contact.viewportHeightPx,
      ) / Math.max(1, Math.min(
        state.contact.viewportWidthPx,
        state.contact.viewportHeightPx,
      ));
      const fittedZoomMaximumViewportSpanMb = state.contact.resolutionLocked
        ? Math.min(
            maximumViewportSpanMb,
            maxManualContactBinsPerAxis
              * (contactResolutionToBasePairs(state.contact.resolution) / 1_000_000)
              / viewportAspectExpansion,
          )
        : maximumViewportSpanMb;
      const currentViewportSpanMb = Number.isFinite(state.contact.viewportSpanMb)
        ? Math.max(0.000001, state.contact.viewportSpanMb)
        : fittedZoomMaximumViewportSpanMb;
      // A window resize can expose empty field beyond the genome. Zooming in
      // must start from that real scale instead of first snapping back to Fit.
      const zoomMaximumViewportSpanMb = Math.max(
        fittedZoomMaximumViewportSpanMb,
        currentViewportSpanMb,
      );
      const finestResolution = contactResolutionLevels[contactResolutionLevels.length - 1] ?? "1 kb";
      const floorResolution = state.contact.resolutionLocked
        ? state.contact.resolution
        : finestResolution;
      const minimumSpanMb = Math.min(
        zoomMaximumViewportSpanMb,
        minimumContactViewportSpanMb(floorResolution, viewportSizePx),
      );
      const currentSpanMb = clamp(
        state.contact.viewportSpanMb,
        minimumSpanMb,
        zoomMaximumViewportSpanMb,
      );
      const defaultScaleFactor = action.direction === "in" ? 2 : 0.5;
      const requestedScaleFactor = action.scaleFactor ?? defaultScaleFactor;
      const scaleFactor = Number.isFinite(requestedScaleFactor) && requestedScaleFactor > 0
        ? requestedScaleFactor
        : defaultScaleFactor;
      let viewportSpanMb = roundContactViewportMb(
        clamp(currentSpanMb / scaleFactor, minimumSpanMb, zoomMaximumViewportSpanMb),
      );
      let snappedResolution: ContactResolution | null = null;

      if (action.snapToResolution && !state.contact.resolutionLocked) {
        const levels = availableContactResolutions(state.contact, totalSpanMb);
        const currentIndex = Math.max(0, levels.indexOf(state.contact.resolution));
        const step = action.direction === "in" ? 1 : -1;

        for (
          let index = currentIndex + step;
          index >= 0 && index < levels.length;
          index += step
        ) {
          const candidateResolution = levels[index];
          if (!candidateResolution) {
            continue;
          }

          const candidateSpanMb = contactViewportSpanForResolution(
            candidateResolution,
            viewportSizePx,
            maximumViewportSpanMb,
          );
          const changesInRequestedDirection = action.direction === "in"
            ? candidateSpanMb < currentSpanMb - 0.000001
            : candidateSpanMb > currentSpanMb + 0.000001;

          if (changesInRequestedDirection) {
            viewportSpanMb = roundContactViewportMb(candidateSpanMb);
            snappedResolution = candidateResolution;
            break;
          }
        }

        if (
          action.direction === "out"
          && snappedResolution === null
          && currentSpanMb < maximumViewportSpanMb - 0.000001
        ) {
          viewportSpanMb = roundContactViewportMb(maximumViewportSpanMb);
          snappedResolution = levels[0] ?? null;
        }
      }
      const currentAxisSpans = contactViewportAxisSpansMb(
        currentSpanMb,
        totalSpanMb,
        state.contact.viewportWidthPx,
        state.contact.viewportHeightPx,
      );
      const nextAxisSpans = contactViewportAxisSpansMb(
        viewportSpanMb,
        totalSpanMb,
        state.contact.viewportWidthPx,
        state.contact.viewportHeightPx,
      );
      const focusRatioX = clamp(action.focusRatioX ?? action.focusRatio ?? 0.5, 0, 1);
      const focusRatioY = action.focusRatioY === undefined
        ? null
        : clamp(action.focusRatioY, 0, 1);
      const viewportCenterXMb = contactViewportCenterAtFocus(
        state.contact.viewportCenterXMb,
        currentAxisSpans.xSpanMb,
        nextAxisSpans.xSpanMb,
        focusRatioX,
        action.focusXMb,
        totalSpanMb,
      );
      // Legacy actions supplied one X focus ratio and intentionally left the
      // off-diagonal Y viewport alone. Pointer interactions now provide Y too.
      const viewportCenterYMb = focusRatioY === null
        ? clampContactViewportCenter(
            state.contact.viewportCenterYMb,
            nextAxisSpans.ySpanMb,
            totalSpanMb,
          )
        : contactViewportCenterAtFocus(
            state.contact.viewportCenterYMb,
            currentAxisSpans.ySpanMb,
            nextAxisSpans.ySpanMb,
            focusRatioY,
            action.focusYMb,
            totalSpanMb,
          );
      const viewportCenterMb = roundContactViewportMb(
        (viewportCenterXMb + viewportCenterYMb) / 2,
      );
      const wholeGenomeResolution = wholeGenomeContactResolutionForViewport(
        maximumViewportSpanMb,
        viewportSizePx,
      );
      const resolution = state.contact.resolutionLocked
        ? state.contact.resolution
        : snappedResolution
          ? snappedResolution
          : sameContactViewportSpan(viewportSpanMb, currentSpanMb)
            ? state.contact.resolution
          : sameContactViewportSpan(viewportSpanMb, maximumViewportSpanMb)
            ? wholeGenomeResolution
            : chooseContactResolutionForBpPerPixel(
                (viewportSpanMb * 1_000_000) / viewportSizePx,
              );
      const colorScale = resolution === state.contact.resolution
        ? state.contact.colorScale
        : state.contact.colorScaleByResolution[resolution] ?? {
            ...state.contact.colorScale,
            auto: true,
          };

      return {
        ...state,
        contact: {
          ...state.contact,
          viewportCenterMb,
          viewportCenterXMb,
          viewportCenterYMb,
          jumpTargetMb: viewportCenterXMb,
          viewportSpanMb,
          totalSpanMb,
          resolution,
          colorScale,
        },
      };
    }
    case "fitContactViewport": {
      const totalSpanMb = sanitizeContactTotalSpanMb(action.totalSpanMb);
      const viewportSpanMb = roundContactViewportMb(maximumContactViewportSpanMb(
        totalSpanMb,
        state.contact.viewportWidthPx,
        state.contact.viewportHeightPx,
      ));
      const viewportCenterMb = roundContactViewportMb(totalSpanMb / 2);
      // Whole-genome navigation chooses the finest bin that still covers the
      // fitted viewport at roughly one CSS pixel per matrix bin.
      const resolution = wholeGenomeContactResolutionForViewport(
        viewportSpanMb,
        sanitizeContactViewportSizePx(state.contact.viewportSizePx),
      );
      const colorScale = resolution === state.contact.resolution
        ? state.contact.colorScale
        : state.contact.colorScaleByResolution[resolution] ?? {
            ...state.contact.colorScale,
            auto: true,
          };

      return withLog(
        {
          ...state,
          contact: {
            ...state.contact,
            viewportCenterMb,
            viewportCenterXMb: viewportCenterMb,
            viewportCenterYMb: viewportCenterMb,
            jumpTargetMb: viewportCenterMb,
            viewportSpanMb,
            totalSpanMb,
            resolution,
            colorScale,
          },
        },
        `Contact viewport fitted to whole genome`,
      );
    }
    case "setContactViewportFromOverview": {
      const viewportCenterMb = overviewRatioToViewportCenterMb(action.ratio, action.totalSpanMb);

      return withLog(
        {
          ...state,
          contact: {
            ...state.contact,
            viewportCenterMb,
            viewportCenterXMb: viewportCenterMb,
            viewportCenterYMb: viewportCenterMb,
            jumpTargetMb: viewportCenterMb,
          },
        },
        `Contact viewport moved to ${viewportCenterMb} Mb`,
      );
    }
    case "setContactViewportCenterFromOverview": {
      const viewportCenterXMb = overviewRatioToViewportCenterMb(action.xRatio, action.totalSpanMb);
      const viewportCenterYMb = overviewRatioToViewportCenterMb(action.yRatio, action.totalSpanMb);
      const viewportCenterMb = Number(((viewportCenterXMb + viewportCenterYMb) / 2).toFixed(2));

      const nextState = {
        ...state,
        contact: {
          ...state.contact,
          viewportCenterMb,
          viewportCenterXMb,
          viewportCenterYMb,
          jumpTargetMb: viewportCenterXMb,
        },
      };
      return action.transient
        ? nextState
        : withLog(
          nextState,
        `Contact viewport moved to ${viewportCenterXMb}, ${viewportCenterYMb} Mb`,
        );
    }
    case "setContactViewportAxisFromNavigator": {
      const totalSpanMb = sanitizeContactTotalSpanMb(action.totalSpanMb);
      const axisSpans = contactViewportAxisSpansMb(
        state.contact.viewportSpanMb,
        totalSpanMb,
        state.contact.viewportWidthPx,
        state.contact.viewportHeightPx,
      );
      const requestedCenterMb = (
        Number.isFinite(action.ratio) ? clamp(action.ratio, 0, 1) : 0.5
      ) * totalSpanMb;
      const axisCenterMb = clampContactViewportCenter(
        requestedCenterMb,
        action.axis === "x" ? axisSpans.xSpanMb : axisSpans.ySpanMb,
        totalSpanMb,
      );
      const viewportCenterXMb = action.axis === "x"
        ? axisCenterMb
        : state.contact.viewportCenterXMb;
      const viewportCenterYMb = action.axis === "y"
        ? axisCenterMb
        : state.contact.viewportCenterYMb;

      return {
        ...state,
        contact: {
          ...state.contact,
          viewportCenterMb: roundContactViewportMb(
            (viewportCenterXMb + viewportCenterYMb) / 2,
          ),
          viewportCenterXMb,
          viewportCenterYMb,
          jumpTargetMb: viewportCenterXMb,
        },
      };
    }
    case "setContactColormap":
      return withLog(
        {
          ...state,
          contact: {
            ...state.contact,
            colormap: action.colormap,
          },
        },
        `Colormap set to ${action.colormap}`,
      );
    case "setColorScale": {
      const value = Math.max(0, action.value);
      const min = action.field === "min" ? Math.min(value, state.contact.colorScale.max) : state.contact.colorScale.min;
      const max = action.field === "max" ? Math.max(value, state.contact.colorScale.min) : state.contact.colorScale.max;
      const nextScale = {
        ...state.contact.colorScale,
        min,
        max,
        auto: false,
      };

      return {
        ...state,
        contact: {
          ...state.contact,
          colorScale: nextScale,
          colorScaleByResolution: {
            ...state.contact.colorScaleByResolution,
            [state.contact.resolution]: nextScale,
          },
        },
      };
    }
    case "setAutoColorScale":
      if (!state.contact.colorScale.auto) {
        return state;
      }
      if (sameColorScale(state.contact.colorScale, action.scale)) {
        return state;
      }

      return {
        ...state,
        contact: {
          ...state.contact,
          colorScale: action.scale,
          colorScaleByResolution: {
            ...state.contact.colorScaleByResolution,
            [state.contact.resolution]: action.scale,
          },
        },
      };
    case "resetColorScaleAuto":
      return {
        ...state,
        contact: {
          ...state.contact,
          colorScale: {
            ...state.contact.colorScale,
            auto: true,
          },
        },
      };
    case "toggleColorScaleLog":
      return withLog(
        {
          ...state,
          contact: {
            ...state.contact,
            colorScale: {
              ...state.contact.colorScale,
              log: !state.contact.colorScale.log,
              auto: true,
            },
          },
        },
        `Color scale log ${state.contact.colorScale.log ? "disabled" : "enabled"}`,
      );
    case "setAssemblyBlocks":
      return {
        ...state,
        operationHistory: [],
        redoStack: [],
        nextOperationId: 1,
        historyPreviewOperationId: null,
        assembly: {
          ...state.assembly,
          blocks: action.blocks,
          selection: null,
        },
      };
    case "restoreAssemblyHistory":
      return {
        ...state,
        operationHistory: action.operationHistory,
        redoStack: action.redoStack,
        nextOperationId: action.nextOperationId,
        historyPreviewOperationId: null,
        assembly: {
          ...state.assembly,
          blocks: action.blocks,
          selection: null,
        },
      };
    case "toggleAssemblyOverlay": {
      const key = action.overlay === "chromosome"
        ? "showChromosomeBoxes"
        : action.overlay === "block"
          ? "showBlockBoxes"
          : "showContigBoxes";
      const visible = !state.assembly[key];
      return withLog(
        {
          ...state,
          assembly: {
            ...state.assembly,
            [key]: visible,
          },
        },
        `${capitalize(action.overlay)} boxes ${visible ? "shown" : "hidden"}`,
      );
    }
    case "selectAssemblyContig": {
      const unitId = assemblyUnitIdForContig(state.assembly.blocks, action.id);
      const priorSelection = action.additive && state.assembly.selection?.kind === "chromosome"
        ? {
            kind: "contigs" as const,
            ids: [...new Set(
              selectedBlockIds(state.assembly.blocks, state.assembly.selection)
                .map((id) => assemblyUnitIdForContig(state.assembly.blocks, id)),
            )],
          }
        : state.assembly.selection;
      return {
        ...state,
        assembly: {
          ...state.assembly,
          selection: selectContig(priorSelection, unitId, action.additive),
        },
      };
    }
    case "focusAssemblyContig": {
      const contig = state.assembly.blocks.find((block) => block.id === action.id);
      const firstBlockMember = contig
        ? null
        : state.assembly.blocks.find((block) => block.assemblyBlockId === action.id);
      const focusedBlocks = contig
        ? [contig]
        : firstBlockMember
          ? state.assembly.blocks.filter((block) => (
              block.assemblyBlockId === action.id
              && block.objectId === firstBlockMember.objectId
            ))
          : [];
      if (focusedBlocks.length === 0) {
        return state;
      }
      const visualStart = Math.min(...focusedBlocks.map((block) => block.visualStart));
      const visualEnd = Math.max(...focusedBlocks.map((block) => block.visualEnd));
      const objectId = focusedBlocks[0].objectId;
      const centerMb = roundContactViewportMb(
        (visualStart + visualEnd) / 2_000_000,
      );
      const totalSpanMb = Math.max(
        0.000001,
        ...state.assembly.blocks.map((block) => block.visualEnd / 1_000_000),
      );
      const focusedSpanMb = Math.max(
        0.000001,
        (visualEnd - visualStart) / 1_000_000,
      );
      const viewportWidthPx = sanitizeContactViewportSizePx(state.contact.viewportWidthPx);
      const viewportHeightPx = sanitizeContactViewportSizePx(state.contact.viewportHeightPx);
      const longestAxisScale = Math.max(viewportWidthPx, viewportHeightPx)
        / Math.min(viewportWidthPx, viewportHeightPx);
      const centeredSpanLimitMb = Math.max(
        0.000001,
        (2 * Math.min(centerMb, totalSpanMb - centerMb)) / longestAxisScale,
      );
      const contextSpanMb = Math.max(focusedSpanMb * 4, totalSpanMb * 0.02);
      const viewportSpanMb = roundContactViewportMb(Math.max(
        0.000001,
        Math.min(state.contact.viewportSpanMb, contextSpanMb, centeredSpanLimitMb),
      ));
      const resolution = state.contact.resolutionLocked
        ? state.contact.resolution
        : chooseContactResolutionForBpPerPixel(
            (viewportSpanMb * 1_000_000)
            / sanitizeContactViewportSizePx(state.contact.viewportSizePx),
          );
      const colorScale = resolution === state.contact.resolution
        ? state.contact.colorScale
        : state.contact.colorScaleByResolution[resolution] ?? {
            ...state.contact.colorScale,
            auto: true,
          };

      return withLog(
        {
          ...state,
          contact: {
            ...state.contact,
            totalSpanMb,
            viewportSpanMb,
            viewportCenterMb: centerMb,
            viewportCenterXMb: centerMb,
            viewportCenterYMb: centerMb,
            jumpTargetMb: centerMb,
            resolution,
            colorScale,
          },
          assembly: {
            ...state.assembly,
            selection: contig
              ? { kind: "contigs", ids: [contig.id], exact: true }
              : { kind: "contigs", ids: [action.id] },
          },
        },
        contig
          ? `Focused contig ${contig.sourceId} at ${objectId}`
          : `Focused block ${action.id} at ${objectId}`,
      );
    }
    case "selectAssemblyContigs":
      return {
        ...state,
        assembly: {
          ...state.assembly,
          selection: selectContigs(action.ids.map((id) => (
            assemblyUnitIdForContig(state.assembly.blocks, id)
          ))),
        },
      };
    case "selectAssemblyOccurrences": {
      const occurrenceIds = new Set(action.ids);
      const ids = state.assembly.blocks
        .filter((block) => occurrenceIds.has(block.id))
        .map((block) => block.id);
      return {
        ...state,
        assembly: {
          ...state.assembly,
          selection: ids.length > 0
            ? { kind: "contigs", ids, exact: true }
            : null,
        },
      };
    }
    case "selectAssemblyChromosome":
      return {
        ...state,
        assembly: {
          ...state.assembly,
          selection: selectChromosome(state.assembly.selection, action.id, false),
        },
      };
    case "focusAssemblyChromosome": {
      const chromosomeBlocks = state.assembly.blocks.filter(
        (block) => block.objectId === action.id,
      );
      if (chromosomeBlocks.length === 0) {
        return state;
      }
      const visualStart = Math.min(...chromosomeBlocks.map((block) => block.visualStart));
      const visualEnd = Math.max(...chromosomeBlocks.map((block) => block.visualEnd));
      const totalSpanMb = Math.max(
        0.000001,
        ...state.assembly.blocks.map((block) => block.visualEnd / 1_000_000),
      );
      const centerMb = roundContactViewportMb((visualStart + visualEnd) / 2_000_000);
      const viewportSpanMb = roundContactViewportMb(Math.max(
        0.000001,
        Math.min(totalSpanMb, (visualEnd - visualStart) / 1_000_000),
      ));
      const resolution = state.contact.resolutionLocked
        ? state.contact.resolution
        : chooseContactResolutionForBpPerPixel(
            (viewportSpanMb * 1_000_000)
            / sanitizeContactViewportSizePx(state.contact.viewportSizePx),
          );
      const colorScale = resolution === state.contact.resolution
        ? state.contact.colorScale
        : state.contact.colorScaleByResolution[resolution] ?? {
            ...state.contact.colorScale,
            auto: true,
          };

      return withLog(
        {
          ...state,
          contact: {
            ...state.contact,
            totalSpanMb,
            viewportSpanMb,
            viewportCenterMb: centerMb,
            viewportCenterXMb: centerMb,
            viewportCenterYMb: centerMb,
            jumpTargetMb: centerMb,
            resolution,
            colorScale,
          },
          assembly: {
            ...state.assembly,
            selection: { kind: "chromosome", id: action.id },
          },
        },
        `Focused chromosome ${action.id}`,
      );
    }
    case "clearAssemblySelection":
      return {
        ...state,
        assembly: {
          ...state.assembly,
          selection: null,
        },
      };
    case "reverseAssemblySelection":
      return withAssemblyHistory(
        state,
        {
          blocks: reverseSelection(state.assembly.blocks, state.assembly.selection),
          selection: null,
        },
        "Selection reversed",
        "reverse",
      );
    case "moveAssemblySelectionBefore":
      return withAssemblyHistory(
        state,
        {
          blocks: moveSelectionBefore(
            state.assembly.blocks,
            state.assembly.selection,
            action.targetBlockId,
            action.targetObjectId,
          ),
          selection: null,
        },
        "Selection moved",
        "move",
      );
    case "applyAssemblyPlacementRecommendation":
      return withAssemblyHistory(
        state,
        {
          blocks: applyPlacementRecommendation(
            state.assembly.blocks,
            state.assembly.selection,
            action,
          ),
          selection: null,
        },
        `Placed ${action.selectedBlockIds.length === 1
          ? action.selectedBlockIds[0]
          : `${action.selectedBlockIds.length}-contig block`} on ${action.targetObjectId} (${action.orientation})`,
        "place_recommendation",
      );
    case "moveAssemblySelectionToDebris":
      return withAssemblyHistory(
        state,
        {
          blocks: moveSelectionToDebris(state.assembly.blocks, state.assembly.selection),
          selection: null,
        },
        "Selection moved to debris",
        "move_to_debris",
      );
    case "deleteAssemblySelection": {
      const deletedCount = selectedBlockIds(
        state.assembly.blocks,
        state.assembly.selection,
      ).length;
      return withAssemblyHistory(
        state,
        {
          blocks: deleteContigSelection(state.assembly.blocks, state.assembly.selection),
          selection: null,
        },
        `${deletedCount} ${deletedCount === 1 ? "contig" : "contigs"} deleted`,
        "delete_contig",
      );
    }
    case "placeUnplacedGfaSegment": {
      const blocks = placeUnplacedGfaSegment(state.assembly.blocks, {
        segmentName: action.segmentName,
        length: action.length,
        targetObjectId: action.targetObjectId,
        targetBlockId: action.targetBlockId,
        orientation: action.orientation,
      });
      const inserted = blocks === state.assembly.blocks
        ? null
        : blocks.find((block) => block.sourceId === action.segmentName) ?? null;
      return withAssemblyHistory(
        state,
        {
          blocks,
          selection: inserted
            ? { kind: "contigs", ids: [inserted.id], exact: true }
            : state.assembly.selection,
        },
        `${action.segmentName} added to ${action.targetObjectId}`,
        "place_unplaced",
      );
    }
    case "createAssemblyBlockFromGfa":
      return withAssemblyHistory(
        state,
        {
          blocks: createAssemblyBlockFromGfa(
            state.assembly.blocks,
            state.assembly.selection,
            action.links,
          ),
          selection: null,
        },
        "GFA-aware block created",
        "create_block",
      );
    case "dissolveAssemblyBlockSelection":
      return withAssemblyHistory(
        state,
        {
          blocks: dissolveAssemblyBlockSelection(
            state.assembly.blocks,
            state.assembly.selection,
          ),
          selection: null,
        },
        "Assembly block dissolved",
        "dissolve_block",
      );
    case "addAssemblyChromosomeBoundaries":
      return withAssemblyHistory(
        state,
        {
          blocks: addChromosomeBoundariesToSelection(state.assembly.blocks, state.assembly.selection),
          selection: null,
        },
        "Chromosome boundaries added",
        "add_chr_boundaries",
      );
    case "removeAssemblyChromosomeBoundaries":
      return withAssemblyHistory(
        state,
        {
          blocks: removeChromosomeBoundariesFromSelection(
            state.assembly.blocks,
            state.assembly.selection,
          ),
          selection: null,
        },
        "Chromosome boundaries removed",
        "remove_chr_boundaries",
      );
    case "copyAssemblySelection":
      return withAssemblyHistory(
        state,
        {
          blocks: copySelection(state.assembly.blocks, state.assembly.selection),
          selection: null,
        },
        "Selection copied",
        "copy_new",
      );
    case "copyAssemblySelectionBefore": {
      const blocks = copySelectionBefore(
        state.assembly.blocks,
        state.assembly.selection,
        action.targetBlockId,
      );
      if (blocks === state.assembly.blocks) {
        return state;
      }
      return withAssemblyHistory(
        state,
        {
          blocks,
          selection: null,
        },
        "Selection copied to target",
        "copy_to_group",
      );
    }
    case "copyAssemblyContig":
      return withAssemblyHistory(
        state,
        {
          blocks: copySelection(state.assembly.blocks, { kind: "contigs", ids: [action.id] }),
          selection: null,
        },
        "Contig copied",
        "copy_new",
      );
    case "splitAssemblyContig": {
      const blocks = splitContigAtVisualPosition(
        state.assembly.blocks,
        action.blockId,
        action.visualPosition,
      );

      return withAssemblyHistory(
        state,
        {
          blocks,
          selection: null,
        },
        "Contig split with 100 bp gap",
        "split_contig",
      );
    }
    case "deleteAssemblyGaps":
      return withAssemblyHistory(
        state,
        {
          blocks: deleteGapsBetweenSelection(
            state.assembly.blocks,
            state.assembly.selection,
          ),
          selection: null,
        },
        "Gap deleted; blocks joined",
        "delete_gap",
      );
    case "renameAssemblySelection": {
      const target = assemblyRenameTarget(state.assembly.blocks, state.assembly.selection);
      const name = action.name.trim();
      const blocks = renameAssemblySelection(
        state.assembly.blocks,
        state.assembly.selection,
        name,
      );
      const selection = blocks !== state.assembly.blocks
        && target?.kind === "chromosome"
        ? { kind: "chromosome" as const, id: name }
        : state.assembly.selection;
      return withAssemblyHistory(
        state,
        { blocks, selection },
        target ? `${capitalize(target.kind)} renamed to ${name}` : "Selection renamed",
        "rename",
      );
    }
    case "appendLog":
      return withLog(state, action.message);
  }
}

function withAssemblyHistory(
  state: UiState,
  assembly: Pick<UiState["assembly"], "blocks" | "selection">,
  label: string,
  type: ContextOperationType,
): UiState {
  // Editing helpers return the original block array when an operation cannot
  // be applied. Keep the selection in that case; only a completed edit is a
  // one-shot selection action.
  if (assembly.blocks === state.assembly.blocks) {
    return state;
  }

  const beforeAssembly = snapshotAssembly(state.assembly);
  const afterAssembly = snapshotAssembly({ ...state.assembly, ...assembly });
  const operation: OperationRecord = {
    id: state.nextOperationId,
    type,
    label,
    position: { x: 0, y: 0 },
    beforeAssembly,
    afterAssembly,
    impact: operationImpact(beforeAssembly, afterAssembly),
  };

  return withLog(
    {
      ...state,
      operationHistory: [...state.operationHistory, operation],
      redoStack: [],
      historyPreviewOperationId: null,
      nextOperationId: state.nextOperationId + 1,
      assembly: {
        ...state.assembly,
        ...assembly,
      },
    },
    label,
  );
}

function operationImpact(
  before: AssemblyHistorySnapshot,
  after: AssemblyHistorySnapshot,
): OperationImpact {
  const selectedIds = new Set(selectedBlockIds(before.blocks, before.selection));
  const sourceIds = new Set(
    before.blocks
      .filter((block) => selectedIds.has(block.id))
      .map((block) => block.sourceId),
  );

  if (sourceIds.size === 0) {
    const allSourceIds = new Set([
      ...before.blocks.map((block) => block.sourceId),
      ...after.blocks.map((block) => block.sourceId),
    ]);
    for (const sourceId of allSourceIds) {
      if (sourceLayoutSignature(before.blocks, sourceId) !== sourceLayoutSignature(after.blocks, sourceId)) {
        sourceIds.add(sourceId);
      }
    }
  }

  const impactedBeforeBlocks = before.blocks.filter((block) => (
    selectedIds.has(block.id) || sourceIds.has(block.sourceId)
  ));
  const impactedAfterBlocks = after.blocks.filter((block) => sourceIds.has(block.sourceId));
  return {
    blockIds: [...new Set([...impactedBeforeBlocks, ...impactedAfterBlocks].map((block) => block.id))],
    sourceIds: [...sourceIds],
    chromosomeIds: [...new Set(
      [...impactedBeforeBlocks, ...impactedAfterBlocks].map((block) => block.objectId),
    )],
    selection: cloneAssemblySelection(before.selection),
  };
}

function sourceLayoutSignature(blocks: ContactMapLayoutBlock[], sourceId: string) {
  return JSON.stringify(
    blocks
      .filter((block) => block.sourceId === sourceId)
      .map((block) => [
        block.objectId,
        block.sourceStart,
        block.sourceEnd,
        block.orientation,
        block.assemblyBlockId,
        block.copyInstanceId,
      ])
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  );
}

function cloneAssemblySelection(selection: AssemblySelection | null): AssemblySelection | null {
  return selection
    ? selection.kind === "contigs"
      ? { ...selection, ids: [...selection.ids] }
      : { ...selection }
    : null;
}

function historyOperationFocus(
  blocks: ContactMapLayoutBlock[],
  operation: OperationRecord,
): { centerMb: number; selection: AssemblySelection | null } | null {
  const sourceIds = new Set(operation.impact?.sourceIds ?? []);
  const blockIds = new Set(operation.impact?.blockIds ?? []);
  const chromosomeIds = new Set(operation.impact?.chromosomeIds ?? []);
  const hasSpecificTargets = sourceIds.size > 0 || blockIds.size > 0;
  const affectedBlocks = blocks.filter((block) => (
    sourceIds.has(block.sourceId)
    || blockIds.has(block.id)
    || (!hasSpecificTargets && chromosomeIds.has(block.objectId))
  ));
  const snapshotBlocks = [
    ...(operation.afterAssembly?.blocks ?? []),
    ...(operation.beforeAssembly?.blocks ?? []),
  ].filter((block) => (
    sourceIds.has(block.sourceId)
    || blockIds.has(block.id)
    || (!hasSpecificTargets && chromosomeIds.has(block.objectId))
  ));
  const focusBlocks = affectedBlocks.length > 0 ? affectedBlocks : snapshotBlocks;
  if (focusBlocks.length === 0) {
    return null;
  }

  const visualStart = Math.min(...focusBlocks.map((block) => block.visualStart));
  const visualEnd = Math.max(...focusBlocks.map((block) => block.visualEnd));
  const currentChromosomes = [...new Set(affectedBlocks.map((block) => block.objectId))];
  const selection = affectedBlocks.length === 0
    ? null
    : operation.impact?.selection?.kind === "chromosome" && currentChromosomes.length === 1
      ? selectChromosome(null, currentChromosomes[0], false)
      : { kind: "contigs" as const, ids: affectedBlocks.map((block) => block.id), exact: true };
  return {
    centerMb: (visualStart + visualEnd) / 2 / 1_000_000,
    selection,
  };
}

function snapshotAssembly(assembly: Pick<UiState["assembly"], "blocks" | "selection">): AssemblyHistorySnapshot {
  return {
    blocks: assembly.blocks.map((block) => ({
      ...block,
      gapBefore: block.gapBefore ? { ...block.gapBefore } : undefined,
    })),
    selection: cloneAssemblySelection(assembly.selection),
  };
}

function withLog(state: UiState, message: string): UiState {
  return {
    ...state,
    logEntries: [...state.logEntries, { time: currentLogTime(), message }].slice(-8),
  };
}

function currentLogTime() {
  return new Date().toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function roundContactViewportMb(value: number) {
  // One millionth of a megabase is one base pair. Keeping this precision avoids
  // cursor-anchor drift at the finest (1 kb) contact resolution.
  return Number(value.toFixed(6));
}

function sameContactViewportSpan(left: number, right: number) {
  return Math.abs(left - right) <= 0.000001;
}

function setContactResolution(
  state: UiState,
  requestedResolution: ContactResolution,
  preserveViewport = false,
  focusRatioX?: number,
  focusRatioY?: number,
  focusXMb?: number,
  focusYMb?: number,
): UiState {
  const totalSpanMb = sanitizeContactTotalSpanMb(state.contact.totalSpanMb);
  const wholeGenomeViewportSpanMb = maximumContactViewportSpanMb(
    totalSpanMb,
    state.contact.viewportWidthPx,
    state.contact.viewportHeightPx,
  );
  if (!preserveViewport) {
    const resolution = clampContactResolutionToViewport(
      requestedResolution,
      wholeGenomeViewportSpanMb,
      state.contact.viewportSizePx,
    );
    const viewportSpanMb = roundContactViewportMb(
      contactViewportSpanForResolution(
        resolution,
        state.contact.viewportSizePx,
        wholeGenomeViewportSpanMb,
      ),
    );
    const { xSpanMb, ySpanMb } = contactViewportAxisSpansMb(
      viewportSpanMb,
      totalSpanMb,
      state.contact.viewportWidthPx,
      state.contact.viewportHeightPx,
    );
    const currentAxisSpans = contactViewportAxisSpansMb(
      state.contact.viewportSpanMb,
      totalSpanMb,
      state.contact.viewportWidthPx,
      state.contact.viewportHeightPx,
    );
    const viewportCenterXMb = contactViewportCenterAtFocus(
      state.contact.viewportCenterXMb,
      currentAxisSpans.xSpanMb,
      xSpanMb,
      focusRatioX,
      focusXMb,
      totalSpanMb,
    );
    const viewportCenterYMb = contactViewportCenterAtFocus(
      state.contact.viewportCenterYMb,
      currentAxisSpans.ySpanMb,
      ySpanMb,
      focusRatioY,
      focusYMb,
      totalSpanMb,
    );
    const colorScale = resolution === state.contact.resolution
      ? state.contact.colorScale
      : state.contact.colorScaleByResolution[resolution] ?? {
          ...state.contact.colorScale,
          auto: true,
        };

    return {
      ...state,
      contact: {
        ...state.contact,
        resolution,
        viewportSpanMb,
        viewportCenterMb: roundContactViewportMb(
          (viewportCenterXMb + viewportCenterYMb) / 2,
        ),
        viewportCenterXMb,
        viewportCenterYMb,
        jumpTargetMb: viewportCenterXMb,
        colorScale,
      },
    };
  }

  const resolution = requestedResolution;
  const maximumBudgetedViewportSpanMb = maximumManualContactViewportSpanMb(
    resolution,
    totalSpanMb,
    state.contact.viewportWidthPx,
    state.contact.viewportHeightPx,
  );
  // Keep the camera unchanged when possible. For a too-fine stored level,
  // shrink the shorter-axis span just enough to keep the longer data axis
  // within the bounded tile budget; center coordinates are retained below.
  const viewportSpanMb = roundContactViewportMb(
    clamp(
      state.contact.viewportSpanMb,
      0.000001,
      maximumBudgetedViewportSpanMb,
    ),
  );
  const { xSpanMb, ySpanMb } = contactViewportAxisSpansMb(
    viewportSpanMb,
    totalSpanMb,
    state.contact.viewportWidthPx,
    state.contact.viewportHeightPx,
  );
  const currentAxisSpans = contactViewportAxisSpansMb(
    state.contact.viewportSpanMb,
    totalSpanMb,
    state.contact.viewportWidthPx,
    state.contact.viewportHeightPx,
  );
  const viewportCenterXMb = contactViewportCenterAtFocus(
    state.contact.viewportCenterXMb,
    currentAxisSpans.xSpanMb,
    xSpanMb,
    focusRatioX,
    focusXMb,
    totalSpanMb,
  );
  const viewportCenterYMb = contactViewportCenterAtFocus(
    state.contact.viewportCenterYMb,
    currentAxisSpans.ySpanMb,
    ySpanMb,
    focusRatioY,
    focusYMb,
    totalSpanMb,
  );
  const colorScale = resolution === state.contact.resolution
    ? state.contact.colorScale
    : state.contact.colorScaleByResolution[resolution] ?? {
        ...state.contact.colorScale,
        auto: true,
      };

  return {
    ...state,
    contact: {
      ...state.contact,
      resolution,
      viewportSpanMb,
      viewportCenterMb: roundContactViewportMb(
        (viewportCenterXMb + viewportCenterYMb) / 2,
      ),
      viewportCenterXMb,
      viewportCenterYMb,
      jumpTargetMb: viewportCenterXMb,
      colorScale,
    },
  };
}

function sanitizeContactViewportSizePx(viewportSizePx: number) {
  return Number.isFinite(viewportSizePx) ? Math.max(1, Math.round(viewportSizePx)) : 1;
}

function sanitizeContactTotalSpanMb(totalSpanMb: number) {
  return roundContactViewportMb(
    Number.isFinite(totalSpanMb) ? Math.max(0.000001, totalSpanMb) : 0.000001,
  );
}

function maximumContactViewportSpanMb(
  totalSpanMb: number,
  viewportWidthPx: number,
  viewportHeightPx: number,
) {
  return contactWholeGenomeViewportSpanMb(
    sanitizeContactTotalSpanMb(totalSpanMb),
    sanitizeContactViewportSizePx(viewportWidthPx),
    sanitizeContactViewportSizePx(viewportHeightPx),
  );
}

function maximumManualContactViewportSpanMb(
  resolution: ContactResolution,
  totalSpanMb: number,
  viewportWidthPx: number,
  viewportHeightPx: number,
) {
  const safeTotalSpanMb = sanitizeContactTotalSpanMb(totalSpanMb);
  const maximumDataAxisSpanMb = (
    contactResolutionToBasePairs(resolution) * maxManualContactBinsPerAxis
  ) / 1_000_000;
  if (safeTotalSpanMb <= maximumDataAxisSpanMb) {
    return safeTotalSpanMb;
  }

  const safeWidthPx = sanitizeContactViewportSizePx(viewportWidthPx);
  const safeHeightPx = sanitizeContactViewportSizePx(viewportHeightPx);
  const aspectScale = Math.max(safeWidthPx, safeHeightPx)
    / Math.min(safeWidthPx, safeHeightPx);

  return Math.max(
    0.000001,
    Math.min(safeTotalSpanMb, maximumDataAxisSpanMb / aspectScale),
  );
}

function contactViewportAxisSpansMb(
  viewportSpanMb: number,
  totalSpanMb: number,
  viewportWidthPx: number,
  viewportHeightPx: number,
) {
  const spans = contactViewportAxisSpans(
    sanitizeContactTotalSpanMb(totalSpanMb) * 1_000_000,
    Math.max(0.000001, viewportSpanMb) * 1_000_000,
    sanitizeContactViewportSizePx(viewportWidthPx),
    sanitizeContactViewportSizePx(viewportHeightPx),
  );
  return {
    xSpanMb: spans.xSpanBp / 1_000_000,
    ySpanMb: spans.ySpanBp / 1_000_000,
  };
}

function clampContactViewportCenter(centerMb: number, viewportSpanMb: number, totalSpanMb: number) {
  const safeTotalSpanMb = sanitizeContactTotalSpanMb(totalSpanMb);
  const safeViewportSpanMb = Math.min(
    safeTotalSpanMb,
    Math.max(0.000001, viewportSpanMb),
  );
  if (safeViewportSpanMb >= safeTotalSpanMb) {
    return roundContactViewportMb(safeTotalSpanMb / 2);
  }

  return roundContactViewportMb(
    clamp(
      Number.isFinite(centerMb) ? centerMb : safeTotalSpanMb / 2,
      safeViewportSpanMb / 2,
      safeTotalSpanMb - safeViewportSpanMb / 2,
    ),
  );
}

function contactViewportCenterAtFocus(
  currentCenterMb: number,
  currentAxisSpanMb: number,
  nextAxisSpanMb: number,
  focusRatio: number | undefined,
  absoluteFocusMb: number | undefined,
  totalSpanMb: number,
) {
  if (!Number.isFinite(focusRatio)) {
    return clampContactViewportCenter(currentCenterMb, nextAxisSpanMb, totalSpanMb);
  }

  const safeTotalSpanMb = sanitizeContactTotalSpanMb(totalSpanMb);
  const safeCurrentSpanMb = Math.max(0.000001, currentAxisSpanMb);
  const safeNextSpanMb = Math.max(0.000001, nextAxisSpanMb);
  const boundedFocusRatio = clamp(focusRatio!, 0, 1);
  const currentStartMb = clamp(
    currentCenterMb - safeCurrentSpanMb / 2,
    0,
    Math.max(0, safeTotalSpanMb - safeCurrentSpanMb),
  );
  const focusMb = Number.isFinite(absoluteFocusMb)
    ? absoluteFocusMb!
    : currentStartMb + safeCurrentSpanMb * boundedFocusRatio;
  const nextStartMb = clamp(
    focusMb - safeNextSpanMb * boundedFocusRatio,
    0,
    Math.max(0, safeTotalSpanMb - safeNextSpanMb),
  );

  return roundContactViewportMb(nextStartMb + safeNextSpanMb / 2);
}

function nextContactResolution(state: UiState, direction: "decrease" | "increase") {
  const levels = availableContactResolutions(state.contact);
  const currentIndex = Math.max(0, levels.indexOf(state.contact.resolution));
  const nextIndex =
    direction === "increase"
      ? Math.min(levels.length - 1, currentIndex + 1)
      : Math.max(0, currentIndex - 1);
  return levels[nextIndex] ?? state.contact.resolution;
}

function sameColorScale(left: ContactColorScale, right: ContactColorScale) {
  return left.log === right.log && left.min === right.min && left.max === right.max && left.auto === right.auto;
}

export function overviewRatioToViewportCenterMb(ratio: number, totalSpanMb: number) {
  return Number(clamp(ratio, 0, 1).toFixed(4)) * Math.max(0, totalSpanMb);
}
