import {
  addChromosomeBoundariesToSelection,
  copySelection,
  copySelectionBefore,
  moveSelectionBefore,
  moveSelectionToDebris,
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
  contactResolutionLevelsForViewport,
  contactResolutionLevels,
  contactWholeGenomeViewportSpanMb,
  contactViewportSpanForResolution,
  minimumContactViewportSpanMb,
  wholeGenomeContactResolutionForViewport,
} from "./contactResolution";
import { contactViewportAxisSpans } from "./contactViewport";
import type { ContactMapLayoutBlock } from "./importers";

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
  | "5 kb";
export type ContactColormap = "Reds" | "Viridis" | "Magma" | "Inferno" | "Turbo";
export type Normalization =
  | "None (Raw)"
  | "ICE (Balanced)"
  | "KR (Balanced)"
  | "VC (Coverage)"
  | "VC_SQRT";
export type ContactNormalization = "raw" | "ice" | "kr" | "vc" | "vc_sqrt";
export type ContextOperationType =
  | "move_to_debris"
  | "remove_chr_boundaries"
  | "add_chr_boundaries"
  | "copy_new"
  | "copy_to_group";

export interface LogEntry {
  time: string;
  message: string;
}

export interface AssemblyHistorySnapshot {
  blocks: ContactMapLayoutBlock[];
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
}

export type TrackId = "coverage" | "agp";
export type LayoutPanel = "left" | "right" | "bottom";
export type ColorScaleField = "min" | "max";
export type OverviewMode = "overview" | "synteny";

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
  | { type: "toggleTrackVisibility"; track: TrackId }
  | { type: "setAgpBlockWidth"; index: number; width: number }
  | { type: "toggleLayoutPanel"; panel: LayoutPanel }
  | { type: "setSyntenySplitOpen"; open: boolean }
  | { type: "adjustContactResolution"; direction: "decrease" | "increase" }
  | { type: "setContactResolution"; resolution: ContactResolution }
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
  | { type: "panContactViewport"; deltaMb?: number; deltaXMb?: number; deltaYMb?: number }
  | {
      type: "zoomContactViewport";
      direction: "in" | "out";
      /** Legacy X-axis focus. New contact-map interactions should pass both axes. */
      focusRatio?: number;
      focusRatioX?: number;
      focusRatioY?: number;
      /** Juicebox-style scale: greater than 1 zooms in; less than 1 zooms out. */
      scaleFactor?: number;
      /** Step to the adjacent data resolution and reset it to its default pixels-per-bin. */
      snapToResolution?: boolean;
      totalSpanMb: number;
    }
  | { type: "fitContactViewport"; totalSpanMb: number }
  | { type: "setContactViewportFromOverview"; ratio: number; totalSpanMb: number }
  | { type: "setContactViewportCenterFromOverview"; xRatio: number; yRatio: number; totalSpanMb: number }
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
  | { type: "toggleAssemblyOverlay"; overlay: "chromosome" | "contig" }
  | { type: "setAssemblyOverlayVisibility"; chromosome: boolean; contig: boolean }
  | { type: "selectAssemblyContig"; id: string; additive: boolean }
  | { type: "selectAssemblyContigs"; ids: string[] }
  | { type: "selectAssemblyChromosome"; id: string }
  | { type: "clearAssemblySelection" }
  | { type: "reverseAssemblySelection" }
  | { type: "moveAssemblySelectionBefore"; targetBlockId: string | null }
  | { type: "moveAssemblySelectionToDebris" }
  | { type: "addAssemblyChromosomeBoundaries" }
  | { type: "copyAssemblySelection" }
  | { type: "copyAssemblySelectionBefore"; targetBlockId: string }
  | { type: "copyAssemblyContig"; id: string }
  | { type: "splitAssemblyContig"; blockId: string; visualPosition: number }
  | { type: "appendLog"; message: string };

export const resolutions: Resolution[] = ["10 kb", "25 kb", "50 kb", "100 kb"];
export const contactResolutions: ContactResolution[] = [...contactResolutionLevels];
export const contactColormaps: ContactColormap[] = ["Reds", "Viridis", "Magma", "Inferno", "Turbo"];
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

export function availableContactResolutions(
  contact: UiState["contact"],
  totalSpanMb = contact.totalSpanMb,
): ContactResolution[] {
  const wholeGenomeViewportSpanMb = maximumContactViewportSpanMb(
    totalSpanMb,
    contact.viewportWidthPx,
    contact.viewportHeightPx,
  );

  return [...contactResolutionLevelsForViewport(
    wholeGenomeViewportSpanMb,
    contact.viewportSizePx,
  )];
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
      colormap: "Reds",
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
      showContigBoxes: true,
    },
  };
}

export function reduceUiState(state: UiState, action: UiAction): UiState {
  switch (action.type) {
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
      const nextState = setContactResolution(state, action.resolution);
      return withLog(
        nextState,
        `Contact resolution set to ${nextState.contact.resolution}`,
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
      const wasFittedToWholeGenome = sameContactViewportSpan(
        state.contact.viewportSpanMb,
        previousMaximumViewportSpanMb,
      );
      const viewportSpanMb = roundContactViewportMb(
        wasFittedToWholeGenome
          ? maximumViewportSpanMb
          : Math.min(state.contact.viewportSpanMb, maximumViewportSpanMb),
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
      const resolution = sameContactViewportSpan(viewportSpanMb, maximumViewportSpanMb)
        ? wholeGenomeResolution
        : state.contact.resolutionLocked
          ? state.contact.resolution
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
    case "zoomContactViewport": {
      const totalSpanMb = sanitizeContactTotalSpanMb(action.totalSpanMb);
      const viewportSizePx = sanitizeContactViewportSizePx(state.contact.viewportSizePx);
      const maximumViewportSpanMb = maximumContactViewportSpanMb(
        totalSpanMb,
        state.contact.viewportWidthPx,
        state.contact.viewportHeightPx,
      );
      const zoomMaximumViewportSpanMb = state.contact.resolutionLocked
        ? contactViewportSpanForResolution(
            state.contact.resolution,
            viewportSizePx,
            maximumViewportSpanMb,
          )
        : maximumViewportSpanMb;
      const finestResolution = contactResolutionLevels[contactResolutionLevels.length - 1] ?? "5 kb";
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
        const levels = contactResolutionLevelsForViewport(
          maximumViewportSpanMb,
          viewportSizePx,
        );
        const currentResolution = clampContactResolutionToViewport(
          state.contact.resolution,
          maximumViewportSpanMb,
          viewportSizePx,
        );
        const currentIndex = Math.max(0, levels.indexOf(currentResolution));
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

        if (action.direction === "out" && snappedResolution === null) {
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
      const centerAtFocus = (
        currentCenterMb: number,
        currentAxisSpanMb: number,
        nextAxisSpanMb: number,
        focusRatio: number,
      ) => {
        const currentStartMb = clamp(
          currentCenterMb - currentAxisSpanMb / 2,
          0,
          Math.max(0, totalSpanMb - currentAxisSpanMb),
        );
        const focusMb = currentStartMb + currentAxisSpanMb * focusRatio;
        const nextStartMb = clamp(
          focusMb - nextAxisSpanMb * focusRatio,
          0,
          Math.max(0, totalSpanMb - nextAxisSpanMb),
        );
        return roundContactViewportMb(nextStartMb + nextAxisSpanMb / 2);
      };
      const viewportCenterXMb = centerAtFocus(
        state.contact.viewportCenterXMb,
        currentAxisSpans.xSpanMb,
        nextAxisSpans.xSpanMb,
        focusRatioX,
      );
      // Legacy actions supplied one X focus ratio and intentionally left the
      // off-diagonal Y viewport alone. Pointer interactions now provide Y too.
      const viewportCenterYMb = focusRatioY === null
        ? clampContactViewportCenter(
            state.contact.viewportCenterYMb,
            nextAxisSpans.ySpanMb,
            totalSpanMb,
          )
        : centerAtFocus(
            state.contact.viewportCenterYMb,
            currentAxisSpans.ySpanMb,
            nextAxisSpans.ySpanMb,
            focusRatioY,
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

      return withLog(
        {
          ...state,
          contact: {
            ...state.contact,
            viewportCenterMb,
            viewportCenterXMb,
            viewportCenterYMb,
            jumpTargetMb: viewportCenterXMb,
          },
        },
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
        assembly: {
          ...state.assembly,
          blocks: action.blocks,
        },
      };
    case "toggleAssemblyOverlay": {
      const key = action.overlay === "chromosome" ? "showChromosomeBoxes" : "showContigBoxes";
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
    case "setAssemblyOverlayVisibility": {
      if (
        state.assembly.showChromosomeBoxes === action.chromosome
        && state.assembly.showContigBoxes === action.contig
      ) {
        return state;
      }
      return withLog(
        {
          ...state,
          assembly: {
            ...state.assembly,
            showChromosomeBoxes: action.chromosome,
            showContigBoxes: action.contig,
          },
        },
        `Heatmap annotations ${action.chromosome || action.contig ? "shown" : "hidden"}`,
      );
    }
    case "selectAssemblyContig": {
      const priorSelection = action.additive && state.assembly.selection?.kind === "chromosome"
        ? { kind: "contigs" as const, ids: selectedBlockIds(state.assembly.blocks, state.assembly.selection) }
        : state.assembly.selection;
      return {
        ...state,
        assembly: {
          ...state.assembly,
          selection: selectContig(priorSelection, action.id, action.additive),
        },
      };
    }
    case "selectAssemblyContigs":
      return {
        ...state,
        assembly: {
          ...state.assembly,
          selection: selectContigs(action.ids),
        },
      };
    case "selectAssemblyChromosome":
      return {
        ...state,
        assembly: {
          ...state.assembly,
          selection: selectChromosome(state.assembly.selection, action.id, false),
        },
      };
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
        "move_to_debris",
      );
    case "moveAssemblySelectionBefore":
      return withAssemblyHistory(
        state,
        {
          blocks: moveSelectionBefore(
            state.assembly.blocks,
            state.assembly.selection,
            action.targetBlockId,
          ),
          selection: null,
        },
        "Selection moved",
        "move_to_debris",
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
        "Contig split",
        "remove_chr_boundaries",
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

  const operation: OperationRecord = {
    id: state.nextOperationId,
    type,
    label,
    position: { x: 0, y: 0 },
    beforeAssembly: snapshotAssembly(state.assembly),
    afterAssembly: snapshotAssembly({ ...state.assembly, ...assembly }),
  };

  return withLog(
    {
      ...state,
      operationHistory: [...state.operationHistory, operation],
      redoStack: [],
      nextOperationId: state.nextOperationId + 1,
      assembly: {
        ...state.assembly,
        ...assembly,
      },
    },
    label,
  );
}

function snapshotAssembly(assembly: Pick<UiState["assembly"], "blocks" | "selection">): AssemblyHistorySnapshot {
  return {
    blocks: assembly.blocks.map((block) => ({ ...block })),
    selection: assembly.selection ? { ...assembly.selection } : null,
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
  // cursor-anchor drift at the finest (5 kb) contact resolution.
  return Number(value.toFixed(6));
}

function sameContactViewportSpan(left: number, right: number) {
  return Math.abs(left - right) <= 0.000001;
}

function setContactResolution(state: UiState, requestedResolution: ContactResolution): UiState {
  const totalSpanMb = sanitizeContactTotalSpanMb(state.contact.totalSpanMb);
  const wholeGenomeViewportSpanMb = maximumContactViewportSpanMb(
    totalSpanMb,
    state.contact.viewportWidthPx,
    state.contact.viewportHeightPx,
  );
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
