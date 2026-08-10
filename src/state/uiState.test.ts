import { describe, expect, it } from "vitest";
import {
  availableContactResolutions,
  contactNormalizationForBackend,
  contactNormalizationLabel,
  contactResolutions,
  createInitialUiState,
  normalizations,
  overviewRatioToViewportCenterMb,
  reduceUiState,
} from "./uiState";

describe("reduceUiState", () => {
  const assemblyBlocks = [
    {
      id: "Chr01:1:ctg1",
      objectId: "Chr01",
      sourceId: "ctg1",
      sourceStart: 0,
      sourceEnd: 100,
      visualStart: 0,
      visualEnd: 100,
      orientation: "+" as const,
    },
    {
      id: "Chr01:2:ctg2",
      objectId: "Chr01",
      sourceId: "ctg2",
      sourceStart: 0,
      sourceEnd: 150,
      visualStart: 100,
      visualEnd: 250,
      orientation: "-" as const,
    },
    {
      id: "Chr02:1:ctg3",
      objectId: "Chr02",
      sourceId: "ctg3",
      sourceStart: 0,
      sourceEnd: 80,
      visualStart: 250,
      visualEnd: 330,
      orientation: "+" as const,
    },
  ];

  it("starts with the bottom log collapsed", () => {
    const state = createInitialUiState("Browser preview mode");

    expect(state.layout.bottomCollapsed).toBe(true);
  });

  it("maps normalization labels to stable backend values", () => {
    expect(normalizations.map((normalization) => [
      normalization,
      contactNormalizationForBackend(normalization),
    ])).toEqual([
      ["None (Raw)", "raw"],
      ["ICE (Balanced)", "ice"],
      ["KR (Balanced)", "kr"],
      ["VC (Coverage)", "vc"],
      ["VC_SQRT", "vc_sqrt"],
    ]);
    expect(normalizations.map((normalization) =>
      contactNormalizationLabel(contactNormalizationForBackend(normalization))
    )).toEqual(normalizations);
  });

  it("selects toolbar controls and records readable log entries", () => {
    let state = createInitialUiState("Browser preview mode");

    state = reduceUiState(state, { type: "selectTool", tool: "copy" });
    state = reduceUiState(state, { type: "setEditMode", mode: "advanced" });
    state = reduceUiState(state, { type: "toggleSnapping" });
    state = reduceUiState(state, { type: "setResolution", resolution: "50 kb" });
    state = reduceUiState(state, { type: "setNormalization", normalization: "KR (Balanced)" });

    expect(state.selectedTool).toBe("copy");
    expect(state.editMode).toBe("advanced");
    expect(state.snappingEnabled).toBe(false);
    expect(state.resolution).toBe("50 kb");
    expect(state.normalization).toBe("KR (Balanced)");
    expect(state.logEntries[state.logEntries.length - 1]?.message).toBe(
      "Normalization set to KR (Balanced)",
    );
  });

  it("records context menu operations and supports undo and redo", () => {
    let state = createInitialUiState("Browser preview mode");

    state = reduceUiState(state, {
      type: "applyContextOperation",
      operation: "copy_new",
      label: "Copy (new)",
      position: { x: 420, y: 260 },
    });
    state = reduceUiState(state, {
      type: "applyContextOperation",
      operation: "move_to_debris",
      label: "Move to debris",
      position: { x: 430, y: 280 },
    });

    expect(state.operationHistory.map((operation) => operation.label)).toEqual([
      "Copy (new)",
      "Move to debris",
    ]);
    expect(state.redoStack).toEqual([]);

    state = reduceUiState(state, { type: "undo" });

    expect(state.operationHistory.map((operation) => operation.label)).toEqual(["Copy (new)"]);
    expect(state.redoStack.map((operation) => operation.label)).toEqual(["Move to debris"]);

    state = reduceUiState(state, { type: "redo" });

    expect(state.operationHistory.map((operation) => operation.label)).toEqual([
      "Copy (new)",
      "Move to debris",
    ]);
    expect(state.redoStack).toEqual([]);
  });

  it("toggles tracks, resizes AGP blocks, and collapses panels", () => {
    let state = createInitialUiState("Browser preview mode");

    state = reduceUiState(state, { type: "toggleTrackVisibility", track: "agp" });
    state = reduceUiState(state, { type: "setAgpBlockWidth", index: 2, width: 245 });
    state = reduceUiState(state, { type: "toggleLayoutPanel", panel: "left" });
    state = reduceUiState(state, { type: "toggleLayoutPanel", panel: "bottom" });

    expect(state.tracks.agpVisible).toBe(false);
    expect(state.tracks.coverageVisible).toBe(true);
    expect(state.agpBlockWidths[2]).toBe(245);
    expect(state.layout.leftCollapsed).toBe(true);
    expect(state.layout.bottomCollapsed).toBe(false);
    expect(state.layout.rightCollapsed).toBe(false);
  });

  it("controls contact map resolution, jump target, colormap, and color scale", () => {
    let state = createInitialUiState("Browser preview mode");

    expect(state.contact.colormap).toBe("Reds");
    expect(state.contact.resolution).toBe("500 kb");
    expect(contactResolutions).toEqual([
      "2.5 Mb",
      "2 Mb",
      "1 Mb",
      "500 kb",
      "250 kb",
      "100 kb",
      "50 kb",
      "25 kb",
      "10 kb",
      "5 kb",
    ]);

    state = reduceUiState(state, { type: "adjustContactResolution", direction: "increase" });
    state = reduceUiState(state, { type: "setContactJumpTarget", valueMb: 125 });
    state = reduceUiState(state, { type: "jumpContactViewport" });
    state = reduceUiState(state, { type: "setContactColormap", colormap: "Viridis" });
    state = reduceUiState(state, { type: "setColorScale", field: "min", value: 0.05 });
    state = reduceUiState(state, { type: "setColorScale", field: "max", value: 250 });
    state = reduceUiState(state, { type: "toggleColorScaleLog" });

    expect(state.contact.resolution).toBe("250 kb");
    expect(state.contact.viewportCenterMb).toBe(125);
    expect(state.contact.colormap).toBe("Viridis");
    expect(state.contact.colorScale).toEqual({ log: true, min: 0.05, max: 250, auto: true });
  });

  it("uses the dynamic fitted level for the whole map", () => {
    let state = createInitialUiState("Browser preview mode");

    state = reduceUiState(state, { type: "setContactResolution", resolution: "500 kb" });

    expect(state.contact.resolution).toBe("500 kb");
    expect(state.contact.viewportSpanMb).toBe(200);
    expect(state.contact.viewportCenterXMb).toBe(100);
    expect(state.contact.viewportCenterYMb).toBe(100);
    expect(state.logEntries[state.logEntries.length - 1]?.message).toBe("Contact resolution set to 500 kb");
  });

  it("keeps manual resolution bins at one CSS pixel", () => {
    let state = createInitialUiState("Browser preview mode");
    state = reduceUiState(state, {
      type: "setContactViewportMetrics",
      viewportSizePx: 536,
      totalSpanMb: 200,
    });

    state = reduceUiState(state, { type: "setContactResolution", resolution: "50 kb" });

    expect(state.contact.resolution).toBe("50 kb");
    expect(state.contact.viewportSpanMb).toBe(26.8);
    expect(state.contact.viewportCenterXMb).toBe(98.42);
    expect(state.contact.viewportCenterYMb).toBe(98.42);
  });

  it("clamps resolutions coarser than the fitted whole-map level", () => {
    let state = createInitialUiState("Browser preview mode");
    state = reduceUiState(state, {
      type: "setContactViewportMetrics",
      viewportSizePx: 536,
      totalSpanMb: 196.84,
    });

    state = reduceUiState(state, { type: "setContactResolution", resolution: "50 kb" });
    state = reduceUiState(state, { type: "setContactResolution", resolution: "2 Mb" });

    expect(state.contact.resolution).toBe("500 kb");
    expect(state.contact.viewportSpanMb).toBe(196.84);
    expect(Number.isFinite(state.contact.viewportSpanMb)).toBe(true);
    expect(state.contact.viewportCenterMb).toBe(98.42);
    expect(state.contact.viewportCenterXMb).toBe(98.42);
    expect(state.contact.viewportCenterYMb).toBe(98.42);
  });

  it("stores viewport metrics without changing state for repeated measurements", () => {
    let state = createInitialUiState("Browser preview mode");
    state = reduceUiState(state, {
      type: "setContactViewportMetrics",
      viewportSizePx: 536.2,
      totalSpanMb: 196.84,
    });

    expect(state.contact.viewportSizePx).toBe(536);
    expect(state.contact.totalSpanMb).toBe(196.84);

    const unchanged = reduceUiState(state, {
      type: "setContactViewportMetrics",
      viewportSizePx: 536.4,
      totalSpanMb: 196.84,
    });
    expect(unchanged).toBe(state);
  });

  it("keeps a fitted view fitted when the loaded assembly span grows", () => {
    let state = createInitialUiState("Browser preview mode");

    state = reduceUiState(state, {
      type: "setContactViewportMetrics",
      viewportSizePx: 640,
      viewportWidthPx: 640,
      viewportHeightPx: 640,
      totalSpanMb: 500,
    });

    expect(state.contact.viewportSpanMb).toBe(500);
    expect(state.contact.viewportCenterXMb).toBe(250);
    expect(state.contact.viewportCenterYMb).toBe(250);
    expect(state.contact.resolution).toBe("1 Mb");
  });

  it("does not reset an already zoomed view when viewport metrics change", () => {
    let state = createInitialUiState("Browser preview mode");
    state = reduceUiState(state, { type: "setContactResolution", resolution: "250 kb" });

    state = reduceUiState(state, {
      type: "setContactViewportMetrics",
      viewportSizePx: 640,
      viewportWidthPx: 640,
      viewportHeightPx: 640,
      totalSpanMb: 500,
    });

    expect(state.contact.viewportSpanMb).toBe(160);
    expect(state.contact.viewportCenterXMb).toBe(98.42);
    expect(state.contact.resolution).toBe("250 kb");
  });

  it("preserves pixels per bin when a zoomed square viewport grows", () => {
    let state = createInitialUiState("Browser preview mode");
    state = reduceUiState(state, {
      type: "setContactViewportMetrics",
      viewportSizePx: 640,
      viewportWidthPx: 640,
      viewportHeightPx: 640,
      totalSpanMb: 500,
    });
    state = reduceUiState(state, { type: "setContactResolution", resolution: "250 kb" });

    state = reduceUiState(state, {
      type: "setContactViewportMetrics",
      viewportSizePx: 960,
      viewportWidthPx: 960,
      viewportHeightPx: 960,
      totalSpanMb: 500,
    });

    expect(state.contact.viewportSpanMb).toBe(240);
    expect(state.contact.resolution).toBe("250 kb");
    expect(state.contact.viewportSizePx * 0.25 / state.contact.viewportSpanMb).toBe(1);
  });

  it("keeps a whole-genome view at the same physical scale when the window grows", () => {
    let state = createInitialUiState("Browser preview mode");
    state = reduceUiState(state, {
      type: "setContactViewportMetrics",
      viewportSizePx: 640,
      viewportWidthPx: 640,
      viewportHeightPx: 640,
      totalSpanMb: 500,
    });

    expect(state.contact.viewportSpanMb).toBe(500);
    expect(state.contact.resolution).toBe("1 Mb");

    state = reduceUiState(state, {
      type: "setContactViewportMetrics",
      viewportSizePx: 960,
      viewportWidthPx: 960,
      viewportHeightPx: 960,
      totalSpanMb: 500,
    });

    expect(state.contact.viewportSpanMb).toBe(750);
    expect(state.contact.resolution).toBe("1 Mb");
    expect(state.contact.viewportSizePx / state.contact.viewportSpanMb).toBe(1.28);
    expect(availableContactResolutions(state.contact)[0]).toBe("1 Mb");

    const zoomedOut = reduceUiState(state, {
      type: "zoomContactViewport",
      direction: "out",
      scaleFactor: 0.5,
      totalSpanMb: 500,
    });
    expect(zoomedOut.contact.viewportSpanMb).toBe(750);
    expect(zoomedOut.contact.resolution).toBe("1 Mb");

    const zoomedIn = reduceUiState(state, {
      type: "zoomContactViewport",
      direction: "in",
      focusRatioX: 0.5,
      focusRatioY: 0.5,
      snapToResolution: true,
      totalSpanMb: 500,
    });
    expect(zoomedIn.contact.viewportSpanMb).toBe(480);
    expect(zoomedIn.contact.resolution).toBe("500 kb");
  });

  it("reveals more sequence without deforming bins when the viewport aspect changes", () => {
    let state = createInitialUiState("Browser preview mode");
    state = reduceUiState(state, {
      type: "setContactViewportMetrics",
      viewportSizePx: 640,
      viewportWidthPx: 640,
      viewportHeightPx: 640,
      totalSpanMb: 500,
    });
    state = reduceUiState(state, { type: "setContactResolution", resolution: "250 kb" });

    state = reduceUiState(state, {
      type: "setContactViewportMetrics",
      viewportSizePx: 800,
      viewportWidthPx: 1200,
      viewportHeightPx: 800,
      totalSpanMb: 500,
    });

    expect(state.contact.viewportSpanMb).toBe(200);
    expect(state.contact.resolution).toBe("250 kb");
    expect(state.contact.viewportWidthPx * 0.25 / 300).toBe(1);
    expect(state.contact.viewportHeightPx * 0.25 / state.contact.viewportSpanMb).toBe(1);
  });

  it("keeps the same scale and resolution while resizing a locked viewport", () => {
    let state = createInitialUiState("Browser preview mode");
    state = reduceUiState(state, {
      type: "setContactViewportMetrics",
      viewportSizePx: 640,
      viewportWidthPx: 640,
      viewportHeightPx: 640,
      totalSpanMb: 500,
    });
    state = reduceUiState(state, { type: "setContactResolution", resolution: "250 kb" });
    state = reduceUiState(state, { type: "toggleContactResolutionLock" });

    state = reduceUiState(state, {
      type: "setContactViewportMetrics",
      viewportSizePx: 960,
      viewportWidthPx: 960,
      viewportHeightPx: 960,
      totalSpanMb: 500,
    });

    expect(state.contact.viewportSpanMb).toBe(240);
    expect(state.contact.resolution).toBe("250 kb");
    expect(state.contact.resolutionLocked).toBe(true);
  });

  it("preserves scale on a wide resize and only refits after an explicit fit action", () => {
    const initialState = createInitialUiState("Browser preview mode");
    let state = {
      ...initialState,
      contact: {
        ...initialState.contact,
        totalSpanMb: 300,
        viewportSpanMb: 300,
        viewportCenterMb: 150,
        viewportCenterXMb: 150,
        viewportCenterYMb: 150,
      },
    };

    state = reduceUiState(state, {
      type: "setContactViewportMetrics",
      viewportSizePx: 800,
      viewportWidthPx: 1200,
      viewportHeightPx: 800,
      totalSpanMb: 300,
    });

    expect(state.contact.viewportSpanMb).toBe(375);
    expect(state.contact.viewportWidthPx).toBe(1200);
    expect(state.contact.viewportHeightPx).toBe(800);

    state = reduceUiState(state, { type: "fitContactViewport", totalSpanMb: 300 });
    expect(state.contact.viewportSpanMb).toBe(300);
    expect(state.contact.viewportCenterXMb).toBe(150);
    expect(state.contact.viewportCenterYMb).toBe(150);

    state = reduceUiState(state, {
      type: "zoomContactViewport",
      direction: "in",
      focusRatioX: 0.5,
      focusRatioY: 0.5,
      scaleFactor: 1.008,
      totalSpanMb: 300,
    });
    expect(state.contact.viewportSpanMb).toBeLessThan(300);
  });

  it("chooses a dynamic whole-map level for a rectangular viewport", () => {
    let state = createInitialUiState("Browser preview mode");
    state = reduceUiState(state, {
      type: "setContactViewportMetrics",
      viewportSizePx: 800,
      viewportWidthPx: 1200,
      viewportHeightPx: 800,
      totalSpanMb: 300,
    });

    expect(state.contact.viewportSpanMb).toBe(300);
    expect(state.contact.resolution).toBe("500 kb");
    expect(availableContactResolutions(state.contact)).toEqual([
      "500 kb",
      "250 kb",
      "100 kb",
      "50 kb",
      "25 kb",
      "10 kb",
      "5 kb",
    ]);

    state = reduceUiState(state, { type: "setContactResolution", resolution: "2 Mb" });
    expect(state.contact.resolution).toBe("500 kb");
    expect(state.contact.viewportSpanMb).toBe(300);

    state = reduceUiState(state, { type: "setContactResolution", resolution: "100 kb" });
    expect(state.contact.viewportSpanMb).toBe(80);
  });

  it("keeps manual color ranges until auto range is restored", () => {
    let state = createInitialUiState("Browser preview mode");

    state = reduceUiState(state, { type: "setColorScale", field: "max", value: 250 });
    expect(state.contact.colorScale.auto).toBe(false);
    expect(state.contact.colorScaleByResolution[state.contact.resolution]?.max).toBe(250);

    state = reduceUiState(state, {
      type: "setAutoColorScale",
      scale: { log: true, min: 0.02, max: 12, auto: true },
    });
    expect(state.contact.colorScale.max).toBe(250);

    state = reduceUiState(state, { type: "resetColorScaleAuto" });
    state = reduceUiState(state, {
      type: "setAutoColorScale",
      scale: { log: true, min: 0.02, max: 12, auto: true },
    });

    expect(state.contact.colorScale).toEqual({ log: true, min: 0.02, max: 12, auto: true });
  });

  it("ignores repeated identical auto color ranges", () => {
    let state = createInitialUiState("Browser preview mode");

    state = reduceUiState(state, {
      type: "setAutoColorScale",
      scale: { log: true, min: 0.02, max: 12, auto: true },
    });
    const unchanged = reduceUiState(state, {
      type: "setAutoColorScale",
      scale: { log: true, min: 0.02, max: 12, auto: true },
    });

    expect(unchanged).toBe(state);
  });

  it("prevents color range sliders from crossing min and max", () => {
    let state = createInitialUiState("Browser preview mode");

    state = reduceUiState(state, { type: "setAutoColorScale", scale: { log: true, min: 17.3, max: 590, auto: true } });
    state = reduceUiState(state, { type: "setColorScale", field: "max", value: 7.1 });

    expect(state.contact.colorScale.min).toBe(17.3);
    expect(state.contact.colorScale.max).toBe(17.3);

    state = reduceUiState(state, { type: "setColorScale", field: "min", value: 900 });

    expect(state.contact.colorScale.min).toBe(17.3);
    expect(state.contact.colorScale.max).toBe(17.3);
  });

  it("restores per-resolution color ranges when switching contact resolution", () => {
    let state = createInitialUiState("Browser preview mode");

    state = reduceUiState(state, { type: "setColorScale", field: "min", value: 0.2 });
    state = reduceUiState(state, { type: "setColorScale", field: "max", value: 8 });
    state = reduceUiState(state, { type: "setContactResolution", resolution: "250 kb" });
    state = reduceUiState(state, { type: "setColorScale", field: "min", value: 1.5 });
    state = reduceUiState(state, { type: "setColorScale", field: "max", value: 12 });
    state = reduceUiState(state, { type: "setContactResolution", resolution: "500 kb" });

    expect(state.contact.colorScale.min).toBe(0.2);
    expect(state.contact.colorScale.max).toBe(8);
    expect(state.contact.colorScale.auto).toBe(false);
  });

  it("moves the contact viewport from overview positions", () => {
    let state = createInitialUiState("Browser preview mode");

    state = reduceUiState(state, { type: "setContactViewportFromOverview", ratio: 0.75, totalSpanMb: 200 });

    expect(state.contact.viewportCenterMb).toBe(150);
    expect(state.contact.jumpTargetMb).toBe(150);
  });

  it("moves the contact viewport from overview x and y positions", () => {
    let state = createInitialUiState("Browser preview mode");

    state = reduceUiState(state, {
      type: "setContactViewportCenterFromOverview",
      xRatio: 0.25,
      yRatio: 0.75,
      totalSpanMb: 200,
    });

    expect(state.contact.viewportCenterXMb).toBe(50);
    expect(state.contact.viewportCenterYMb).toBe(150);
    expect(state.contact.viewportCenterMb).toBe(100);
  });

  it("moves only the x viewport axis from the navigator and clamps to the visible window", () => {
    const initialState = createInitialUiState("Browser preview mode");
    const state = reduceUiState(
      {
        ...initialState,
        contact: {
          ...initialState.contact,
          totalSpanMb: 400,
          viewportSpanMb: 100,
          viewportCenterMb: 200,
          viewportCenterXMb: 125,
          viewportCenterYMb: 275,
          jumpTargetMb: 125,
        },
      },
      {
        type: "setContactViewportAxisFromNavigator",
        axis: "x",
        ratio: 0.95,
        totalSpanMb: 400,
      },
    );

    expect(state.contact.viewportCenterXMb).toBe(350);
    expect(state.contact.viewportCenterYMb).toBe(275);
    expect(state.contact.viewportCenterMb).toBe(312.5);
    expect(state.contact.jumpTargetMb).toBe(350);
    expect(state.logEntries).toHaveLength(initialState.logEntries.length);
  });

  it("moves only the y viewport axis from the navigator and clamps to the visible window", () => {
    const initialState = createInitialUiState("Browser preview mode");
    const state = reduceUiState(
      {
        ...initialState,
        contact: {
          ...initialState.contact,
          totalSpanMb: 400,
          viewportSpanMb: 100,
          viewportCenterMb: 200,
          viewportCenterXMb: 125,
          viewportCenterYMb: 275,
          jumpTargetMb: 125,
        },
      },
      {
        type: "setContactViewportAxisFromNavigator",
        axis: "y",
        ratio: -0.25,
        totalSpanMb: 400,
      },
    );

    expect(state.contact.viewportCenterXMb).toBe(125);
    expect(state.contact.viewportCenterYMb).toBe(50);
    expect(state.contact.viewportCenterMb).toBe(87.5);
    expect(state.contact.jumpTargetMb).toBe(125);
    expect(state.logEntries).toHaveLength(initialState.logEntries.length);
  });

  it("pans the contact viewport without adding log entries for every drag event", () => {
    const initialState = createInitialUiState("Browser preview mode");
    let state = {
      ...initialState,
      contact: {
        ...initialState.contact,
        totalSpanMb: 400,
        viewportSpanMb: 100,
        viewportWidthPx: 400,
        viewportHeightPx: 200,
        viewportCenterMb: 200,
        viewportCenterXMb: 200,
        viewportCenterYMb: 200,
        jumpTargetMb: 200,
      },
    };
    const logCount = state.logEntries.length;
    const resolution = state.contact.resolution;

    state = reduceUiState(state, { type: "panContactViewport", deltaXMb: 12.5, deltaYMb: -8 });

    expect(state.contact.viewportCenterXMb).toBe(212.5);
    expect(state.contact.viewportCenterYMb).toBe(192);
    expect(state.contact.viewportCenterMb).toBe(202.25);
    expect(state.contact.jumpTargetMb).toBe(212.5);
    expect(state.contact.viewportSpanMb).toBe(100);
    expect(state.contact.resolution).toBe(resolution);
    expect(state.logEntries.length).toBe(logCount);
  });

  it("clamps wheel panning at each rectangular viewport edge without a reverse dead zone", () => {
    const initialState = createInitialUiState("Browser preview mode");
    let state = {
      ...initialState,
      contact: {
        ...initialState.contact,
        totalSpanMb: 400,
        viewportSpanMb: 100,
        viewportWidthPx: 400,
        viewportHeightPx: 200,
        viewportCenterMb: 200,
        viewportCenterXMb: 200,
        viewportCenterYMb: 200,
        jumpTargetMb: 200,
      },
    };

    state = reduceUiState(state, {
      type: "panContactViewport",
      deltaXMb: -1_000,
      deltaYMb: -1_000,
    });
    expect(state.contact.viewportCenterXMb).toBe(100);
    expect(state.contact.viewportCenterYMb).toBe(50);

    state = reduceUiState(state, {
      type: "panContactViewport",
      deltaXMb: 1,
      deltaYMb: 1,
    });
    expect(state.contact.viewportCenterXMb).toBe(101);
    expect(state.contact.viewportCenterYMb).toBe(51);

    state = reduceUiState(state, {
      type: "panContactViewport",
      deltaXMb: 1_000,
      deltaYMb: 1_000,
    });
    expect(state.contact.viewportCenterXMb).toBe(300);
    expect(state.contact.viewportCenterYMb).toBe(350);
  });

  it("zooms the contact viewport around the requested focus point and increases display resolution when zooming in", () => {
    let state = createInitialUiState("Browser preview mode");

    state = reduceUiState(state, {
      type: "zoomContactViewport",
      direction: "in",
      focusRatio: 0.25,
      totalSpanMb: 500,
    });

    expect(state.contact.viewportSpanMb).toBe(100);
    expect(state.contact.viewportCenterXMb).toBe(75);
    expect(state.contact.viewportCenterYMb).toBe(98.42);
    expect(state.contact.viewportCenterMb).toBe(86.71);
    expect(state.contact.jumpTargetMb).toBe(75);
    expect(state.contact.resolution).toBe("250 kb");

    state = reduceUiState(state, {
      type: "zoomContactViewport",
      direction: "out",
      focusRatio: 0.5,
      totalSpanMb: 500,
    });

    expect(state.contact.viewportSpanMb).toBe(200);
    expect(state.contact.resolution).toBe("500 kb");
  });

  it("steps an unlocked double-click to the next data level at one CSS pixel per bin", () => {
    let state = createInitialUiState("Browser preview mode");

    state = reduceUiState(state, {
      type: "zoomContactViewport",
      direction: "in",
      focusRatioX: 0.5,
      focusRatioY: 0.5,
      snapToResolution: true,
      totalSpanMb: 200,
    });

    expect(state.contact.resolution).toBe("250 kb");
    expect(state.contact.viewportSpanMb).toBe(160);
    expect(
      state.contact.viewportSizePx
        * 0.25
        / state.contact.viewportSpanMb,
    ).toBe(1);
  });

  it("keeps the data level fixed when a locked double-click changes pixels per bin", () => {
    let state = createInitialUiState("Browser preview mode");
    state = reduceUiState(state, { type: "setContactResolution", resolution: "250 kb" });
    state = reduceUiState(state, { type: "toggleContactResolutionLock" });

    state = reduceUiState(state, {
      type: "zoomContactViewport",
      direction: "in",
      focusRatioX: 0.5,
      focusRatioY: 0.5,
      snapToResolution: true,
      totalSpanMb: 200,
    });

    expect(state.contact.resolution).toBe("250 kb");
    expect(state.contact.viewportSpanMb).toBe(80);
  });

  it("returns to the sole whole-genome resolution when zooming all the way out", () => {
    let state = createInitialUiState("Browser preview mode");
    state = reduceUiState(state, { type: "setContactResolution", resolution: "500 kb" });

    state = reduceUiState(state, {
      type: "zoomContactViewport",
      direction: "out",
      focusRatioX: 0.5,
      focusRatioY: 0.5,
      scaleFactor: 0.01,
      totalSpanMb: 200,
    });

    expect(state.contact.viewportSpanMb).toBe(200);
    expect(state.contact.resolution).toBe("500 kb");
  });

  it("zooms without resetting an off-diagonal y viewport", () => {
    let state = createInitialUiState("Browser preview mode");

    state = reduceUiState(state, {
      type: "setContactViewportCenterFromOverview",
      xRatio: 0.25,
      yRatio: 0.75,
      totalSpanMb: 400,
    });
    state = reduceUiState(state, {
      type: "zoomContactViewport",
      direction: "in",
      focusRatio: 0.5,
      totalSpanMb: 400,
    });

    expect(state.contact.viewportSpanMb).toBe(100);
    expect(state.contact.viewportCenterYMb).toBe(300);
  });

  it("keeps the selected contact resolution and color scale while zooming when locked", () => {
    let state = createInitialUiState("Browser preview mode");
    state = reduceUiState(state, { type: "setContactResolution", resolution: "250 kb" });
    state = reduceUiState(state, { type: "setColorScale", field: "min", value: 0.25 });
    state = reduceUiState(state, { type: "setColorScale", field: "max", value: 7 });
    state = reduceUiState(state, { type: "toggleContactResolutionLock" });

    expect(state.contact.resolutionLocked).toBe(true);

    state = reduceUiState(state, {
      type: "zoomContactViewport",
      direction: "in",
      focusRatio: 0.25,
      totalSpanMb: 500,
    });

    expect(state.contact.viewportSpanMb).toBe(80);
    expect(state.contact.viewportCenterXMb).toBe(78.42);
    expect(state.contact.resolution).toBe("250 kb");
    expect(state.contact.colorScale).toEqual({ log: false, min: 0.25, max: 7, auto: false });

    state = reduceUiState(state, { type: "toggleContactResolutionLock" });
    expect(state.contact.resolutionLocked).toBe(false);
    expect(state.logEntries[state.logEntries.length - 1]?.message).toBe("Contact resolution unlocked");
  });

  it("does not let a locked finer resolution zoom out below one pixel per bin", () => {
    let state = createInitialUiState("Browser preview mode");
    state = reduceUiState(state, { type: "setContactResolution", resolution: "250 kb" });
    state = reduceUiState(state, { type: "toggleContactResolutionLock" });

    state = reduceUiState(state, {
      type: "zoomContactViewport",
      direction: "out",
      scaleFactor: 0.01,
      totalSpanMb: 200,
    });

    expect(state.contact.viewportSpanMb).toBe(160);
    expect(state.contact.resolution).toBe("250 kb");
  });

  it("keeps both genome coordinates under the pointer stable during incremental wheel zoom", () => {
    let state = createInitialUiState("Browser preview mode");
    state = reduceUiState(state, {
      type: "setContactViewportCenterFromOverview",
      xRatio: 0.25,
      yRatio: 0.75,
      totalSpanMb: 400,
    });

    const focusRatioX = 0.25;
    const focusRatioY = 0.75;
    const beforeSpanMb = state.contact.viewportSpanMb;
    const beforeXStartMb = state.contact.viewportCenterXMb - beforeSpanMb / 2;
    const beforeYStartMb = state.contact.viewportCenterYMb - beforeSpanMb / 2;
    const anchoredXMb = beforeXStartMb + beforeSpanMb * focusRatioX;
    const anchoredYMb = beforeYStartMb + beforeSpanMb * focusRatioY;

    state = reduceUiState(state, {
      type: "zoomContactViewport",
      direction: "in",
      focusRatioX,
      focusRatioY,
      scaleFactor: 1.008,
      totalSpanMb: 400,
    });

    const afterXStartMb = state.contact.viewportCenterXMb - state.contact.viewportSpanMb / 2;
    const afterYStartMb = state.contact.viewportCenterYMb - state.contact.viewportSpanMb / 2;
    const afterAnchoredXMb = afterXStartMb + state.contact.viewportSpanMb * focusRatioX;
    const afterAnchoredYMb = afterYStartMb + state.contact.viewportSpanMb * focusRatioY;

    expect(state.contact.viewportSpanMb).toBe(198.412698);
    expect(Math.abs(afterAnchoredXMb - anchoredXMb)).toBeLessThanOrEqual(0.000001);
    expect(Math.abs(afterAnchoredYMb - anchoredYMb)).toBeLessThanOrEqual(0.000001);
  });

  it("selects contact resolution by bp per pixel and restores its color scale", () => {
    let state = createInitialUiState("Browser preview mode");

    state = reduceUiState(state, { type: "setContactResolution", resolution: "100 kb" });
    state = reduceUiState(state, { type: "setColorScale", field: "min", value: 0.5 });
    state = reduceUiState(state, { type: "setColorScale", field: "max", value: 5 });
    state = reduceUiState(state, { type: "setContactResolution", resolution: "2 Mb" });
    state = reduceUiState(state, { type: "setColorScale", field: "min", value: 0.1 });
    state = reduceUiState(state, { type: "setColorScale", field: "max", value: 20 });
    state = {
      ...state,
      contact: {
        ...state.contact,
        viewportSpanMb: 100,
      },
    };

    state = reduceUiState(state, {
      type: "zoomContactViewport",
      direction: "in",
      focusRatio: 0.5,
      totalSpanMb: 500,
    });

    expect(state.contact.viewportSpanMb).toBe(50);
    expect(state.contact.resolution).toBe("100 kb");
    expect(state.contact.colorScale).toEqual({ log: false, min: 0.5, max: 5, auto: false });
  });

  it("fits the contact viewport to the loaded span", () => {
    let state = createInitialUiState("Browser preview mode");

    state = reduceUiState(state, { type: "fitContactViewport", totalSpanMb: 360 });

    expect(state.contact.viewportCenterMb).toBe(180);
    expect(state.contact.jumpTargetMb).toBe(180);
    expect(state.contact.viewportSpanMb).toBe(360);
    expect(state.contact.resolution).toBe("1 Mb");
  });

  it("chooses a representable resolution when fitting a locked viewport", () => {
    let state = createInitialUiState("Browser preview mode");
    state = reduceUiState(state, { type: "setContactResolution", resolution: "50 kb" });
    state = reduceUiState(state, { type: "toggleContactResolutionLock" });

    state = reduceUiState(state, { type: "fitContactViewport", totalSpanMb: 360 });

    expect(state.contact.viewportSpanMb).toBe(360);
    expect(state.contact.resolution).toBe("1 Mb");
    expect(state.contact.resolutionLocked).toBe(true);
  });

  it("allows locked 5 kb superzoom down to Juicebox's 128 px per-bin cap", () => {
    let state = createInitialUiState("Browser preview mode");
    state = reduceUiState(state, {
      type: "setContactViewportMetrics",
      viewportSizePx: 536,
      totalSpanMb: 200,
    });
    state = reduceUiState(state, { type: "setContactResolution", resolution: "5 kb" });
    state = reduceUiState(state, { type: "toggleContactResolutionLock" });

    state = reduceUiState(state, {
      type: "zoomContactViewport",
      direction: "in",
      focusRatioX: 0.5,
      focusRatioY: 0.5,
      scaleFactor: 1_000_000,
      totalSpanMb: 200,
    });

    expect(state.contact.viewportSpanMb).toBe(0.020938);
    expect(state.contact.viewportSpanMb).toBeLessThan(1);
    expect(state.contact.resolution).toBe("5 kb");
  });

  it("clamps overview-driven viewport centers to visible bounds", () => {
    expect(overviewRatioToViewportCenterMb(-0.2, 200)).toBe(0);
    expect(overviewRatioToViewportCenterMb(1.2, 200)).toBe(200);
  });

  it("opens and closes synteny split view", () => {
    let state = createInitialUiState("Browser preview mode");

    state = reduceUiState(state, { type: "setSyntenySplitOpen", open: true });
    expect(state.layout.syntenySplitOpen).toBe(true);

    state = reduceUiState(state, { type: "setSyntenySplitOpen", open: false });
    expect(state.layout.syntenySplitOpen).toBe(false);
  });

  it("stores assembly layout and selection for contact-map editing", () => {
    let state = createInitialUiState("Browser preview mode");

    state = reduceUiState(state, { type: "setAssemblyBlocks", blocks: assemblyBlocks });
    state = reduceUiState(state, { type: "selectAssemblyContig", id: "Chr01:1:ctg1", additive: false });
    state = reduceUiState(state, { type: "selectAssemblyContig", id: "Chr01:2:ctg2", additive: true });

    expect(state.assembly.blocks).toEqual(assemblyBlocks);
    expect(state.assembly.selection).toEqual({ kind: "contigs", ids: ["Chr01:1:ctg1", "Chr01:2:ctg2"] });
    expect(state.assembly.showChromosomeBoxes).toBe(true);
    expect(state.assembly.showContigBoxes).toBe(true);
  });

  it("expands a selected chromosome before additively toggling contigs", () => {
    let state = createInitialUiState("Browser preview mode");
    state = reduceUiState(state, { type: "setAssemblyBlocks", blocks: assemblyBlocks });
    state = reduceUiState(state, { type: "selectAssemblyChromosome", id: "Chr01" });
    state = reduceUiState(state, {
      type: "selectAssemblyContig",
      id: "Chr02:1:ctg3",
      additive: true,
    });

    expect(state.assembly.selection).toEqual({
      kind: "contigs",
      ids: ["Chr01:1:ctg1", "Chr01:2:ctg2", "Chr02:1:ctg3"],
    });
  });

  it("replaces assembly selection with all contigs from a Shift drag box", () => {
    let state = createInitialUiState("Browser preview mode");
    state = reduceUiState(state, { type: "setAssemblyBlocks", blocks: assemblyBlocks });
    state = reduceUiState(state, {
      type: "selectAssemblyContigs",
      ids: ["Chr01:1:ctg1", "Chr01:2:ctg2"],
    });

    expect(state.assembly.selection).toEqual({
      kind: "contigs",
      ids: ["Chr01:1:ctg1", "Chr01:2:ctg2"],
    });
  });

  it("clears and toggles assembly selection", () => {
    let state = createInitialUiState("Browser preview mode");

    state = reduceUiState(state, { type: "setAssemblyBlocks", blocks: assemblyBlocks });
    state = reduceUiState(state, { type: "selectAssemblyContig", id: "Chr01:1:ctg1", additive: false });
    state = reduceUiState(state, { type: "selectAssemblyContig", id: "Chr01:1:ctg1", additive: true });

    expect(state.assembly.selection).toBeNull();

    state = reduceUiState(state, { type: "selectAssemblyChromosome", id: "Chr01" });
    state = reduceUiState(state, { type: "clearAssemblySelection" });

    expect(state.assembly.selection).toBeNull();
  });

  it("toggles chromosome and contig heatmap boxes independently", () => {
    let state = createInitialUiState("Browser preview mode");

    state = reduceUiState(state, { type: "toggleAssemblyOverlay", overlay: "chromosome" });
    expect(state.assembly.showChromosomeBoxes).toBe(false);
    expect(state.assembly.showContigBoxes).toBe(true);

    state = reduceUiState(state, { type: "toggleAssemblyOverlay", overlay: "contig" });
    expect(state.assembly.showChromosomeBoxes).toBe(false);
    expect(state.assembly.showContigBoxes).toBe(false);

    state = reduceUiState(state, { type: "toggleAssemblyOverlay", overlay: "chromosome" });
    expect(state.assembly.showChromosomeBoxes).toBe(true);
    expect(state.assembly.showContigBoxes).toBe(false);
  });

  it("sets both heatmap annotation layers together for the F2 shortcut", () => {
    let state = createInitialUiState("Browser preview mode");
    state = reduceUiState(state, { type: "toggleAssemblyOverlay", overlay: "contig" });
    expect(state.assembly.showChromosomeBoxes).toBe(true);
    expect(state.assembly.showContigBoxes).toBe(false);

    state = reduceUiState(state, {
      type: "setAssemblyOverlayVisibility",
      chromosome: false,
      contig: false,
    });
    expect(state.assembly.showChromosomeBoxes).toBe(false);
    expect(state.assembly.showContigBoxes).toBe(false);

    state = reduceUiState(state, {
      type: "setAssemblyOverlayVisibility",
      chromosome: true,
      contig: false,
    });
    expect(state.assembly.showChromosomeBoxes).toBe(true);
    expect(state.assembly.showContigBoxes).toBe(false);
  });

  it("reverses selected contigs as one segment from the reducer", () => {
    let state = createInitialUiState("Browser preview mode");

    state = reduceUiState(state, { type: "setAssemblyBlocks", blocks: assemblyBlocks });
    state = reduceUiState(state, { type: "selectAssemblyContig", id: "Chr01:1:ctg1", additive: false });
    state = reduceUiState(state, { type: "selectAssemblyContig", id: "Chr01:2:ctg2", additive: true });
    state = reduceUiState(state, { type: "reverseAssemblySelection" });

    expect(state.assembly.blocks.map((block) => [block.id, block.orientation])).toEqual([
      ["Chr01:2:ctg2", "+"],
      ["Chr01:1:ctg1", "-"],
      ["Chr02:1:ctg3", "+"],
    ]);
    expect(state.assembly.selection).toBeNull();
    expect(state.logEntries[state.logEntries.length - 1]?.message).toBe("Selection reversed");
  });

  it("moves selected contigs before a target block from the reducer", () => {
    let state = createInitialUiState("Browser preview mode");

    state = reduceUiState(state, { type: "setAssemblyBlocks", blocks: assemblyBlocks });
    state = reduceUiState(state, { type: "selectAssemblyContig", id: "Chr02:1:ctg3", additive: false });
    state = reduceUiState(state, { type: "moveAssemblySelectionBefore", targetBlockId: "Chr01:2:ctg2" });

    expect(state.assembly.blocks.map((block) => [block.id, block.objectId])).toEqual([
      ["Chr01:1:ctg1", "Chr01"],
      ["Chr02:1:ctg3", "Chr01"],
      ["Chr01:2:ctg2", "Chr01"],
    ]);
    expect(state.assembly.selection).toBeNull();
  });

  it("moves a selected chromosome before another chromosome and keeps both chromosome ids", () => {
    let state = createInitialUiState("Browser preview mode");

    state = reduceUiState(state, { type: "setAssemblyBlocks", blocks: assemblyBlocks });
    state = reduceUiState(state, { type: "selectAssemblyChromosome", id: "Chr02" });
    state = reduceUiState(state, { type: "moveAssemblySelectionBefore", targetBlockId: "Chr01:1:ctg1" });

    expect(state.assembly.blocks.map((block) => [block.id, block.objectId])).toEqual([
      ["Chr02:1:ctg3", "Chr02"],
      ["Chr01:1:ctg1", "Chr01"],
      ["Chr01:2:ctg2", "Chr01"],
    ]);
    expect(state.assembly.selection).toBeNull();
  });

  it("moves a selected chromosome to the end of the assembly", () => {
    let state = createInitialUiState("Browser preview mode");

    state = reduceUiState(state, { type: "setAssemblyBlocks", blocks: assemblyBlocks });
    state = reduceUiState(state, { type: "selectAssemblyChromosome", id: "Chr01" });
    state = reduceUiState(state, { type: "moveAssemblySelectionBefore", targetBlockId: null });

    expect(state.assembly.blocks.map((block) => [block.id, block.objectId])).toEqual([
      ["Chr02:1:ctg3", "Chr02"],
      ["Chr01:1:ctg1", "Chr01"],
      ["Chr01:2:ctg2", "Chr01"],
    ]);
    expect(state.assembly.selection).toBeNull();
  });

  it("selects a whole chromosome for reversal", () => {
    let state = createInitialUiState("Browser preview mode");

    state = reduceUiState(state, { type: "setAssemblyBlocks", blocks: assemblyBlocks });
    state = reduceUiState(state, { type: "selectAssemblyChromosome", id: "Chr01" });
    state = reduceUiState(state, { type: "reverseAssemblySelection" });

    expect(state.assembly.selection).toBeNull();
    expect(state.assembly.blocks.map((block) => block.id)).toEqual([
      "Chr01:2:ctg2",
      "Chr01:1:ctg1",
      "Chr02:1:ctg3",
    ]);
  });

  it("copies the selected contig from the reducer", () => {
    let state = createInitialUiState("Browser preview mode");

    state = reduceUiState(state, { type: "setAssemblyBlocks", blocks: assemblyBlocks });
    state = reduceUiState(state, { type: "selectAssemblyContig", id: "Chr01:1:ctg1", additive: false });
    state = reduceUiState(state, { type: "copyAssemblySelection" });

    expect(state.assembly.blocks.map((block) => block.id)).toEqual([
      "Chr01:1:ctg1",
      "Chr01:1:ctg1_d2",
      "Chr01:2:ctg2",
      "Chr02:1:ctg3",
    ]);
    expect(state.assembly.selection).toBeNull();
    expect(state.logEntries[state.logEntries.length - 1]?.message).toBe("Selection copied");
  });

  it("copies the selected chromosome into a new chromosome from the reducer", () => {
    let state = createInitialUiState("Browser preview mode");

    state = reduceUiState(state, { type: "setAssemblyBlocks", blocks: assemblyBlocks });
    state = reduceUiState(state, { type: "selectAssemblyChromosome", id: "Chr01" });
    state = reduceUiState(state, { type: "copyAssemblySelection" });

    expect(state.assembly.blocks.map((block) => [block.id, block.objectId, block.sourceId])).toEqual([
      ["Chr01:1:ctg1", "Chr01", "ctg1"],
      ["Chr01:2:ctg2", "Chr01", "ctg2"],
      ["Chr01:1:ctg1_d2", "Chr01_d2", "ctg1"],
      ["Chr01:2:ctg2_d2", "Chr01_d2", "ctg2"],
      ["Chr02:1:ctg3", "Chr02", "ctg3"],
    ]);
    expect(state.assembly.selection).toBeNull();
  });

  it("copies a clicked contig directly from the reducer", () => {
    let state = createInitialUiState("Browser preview mode");

    state = reduceUiState(state, { type: "setAssemblyBlocks", blocks: assemblyBlocks });
    state = reduceUiState(state, { type: "copyAssemblyContig", id: "Chr01:2:ctg2" });

    expect(state.assembly.blocks.map((block) => block.id)).toEqual([
      "Chr01:1:ctg1",
      "Chr01:2:ctg2",
      "Chr01:2:ctg2_d2",
      "Chr02:1:ctg3",
    ]);
    expect(state.assembly.selection).toBeNull();
  });

  it("copies the selected contig before a coverage target and exits selection", () => {
    let state = createInitialUiState("Browser preview mode");

    state = reduceUiState(state, { type: "setAssemblyBlocks", blocks: assemblyBlocks });
    state = reduceUiState(state, { type: "selectAssemblyContig", id: "Chr01:1:ctg1", additive: false });
    state = reduceUiState(state, {
      type: "copyAssemblySelectionBefore",
      targetBlockId: "Chr02:1:ctg3",
    });

    expect(state.assembly.blocks.map((block) => [block.id, block.objectId])).toEqual([
      ["Chr01:1:ctg1", "Chr01"],
      ["Chr01:2:ctg2", "Chr01"],
      ["Chr01:1:ctg1_d2", "Chr02"],
      ["Chr02:1:ctg3", "Chr02"],
    ]);
    expect(state.assembly.selection).toBeNull();
    expect(state.logEntries[state.logEntries.length - 1]?.message).toBe("Selection copied to target");
  });

  it("moves the selected contig to debris from the reducer", () => {
    let state = createInitialUiState("Browser preview mode");

    state = reduceUiState(state, { type: "setAssemblyBlocks", blocks: assemblyBlocks });
    state = reduceUiState(state, { type: "selectAssemblyContig", id: "Chr01:2:ctg2", additive: false });
    state = reduceUiState(state, { type: "moveAssemblySelectionToDebris" });

    expect(state.assembly.blocks.map((block) => [block.id, block.objectId])).toEqual([
      ["Chr01:1:ctg1", "Chr01"],
      ["Chr02:1:ctg3", "Chr02"],
      ["Chr01:2:ctg2", "debris"],
    ]);
    expect(state.assembly.selection).toBeNull();
    expect(state.logEntries[state.logEntries.length - 1]?.message).toBe("Selection moved to debris");
  });

  it("adds chromosome boundaries around the selected contig from the reducer", () => {
    let state = createInitialUiState("Browser preview mode");

    state = reduceUiState(state, { type: "setAssemblyBlocks", blocks: assemblyBlocks });
    state = reduceUiState(state, { type: "selectAssemblyContig", id: "Chr01:2:ctg2", additive: false });
    state = reduceUiState(state, { type: "addAssemblyChromosomeBoundaries" });

    expect(state.assembly.blocks.map((block) => [block.id, block.objectId])).toEqual([
      ["Chr01:1:ctg1", "Chr01"],
      ["Chr01:2:ctg2", "Chr01_d2"],
      ["Chr02:1:ctg3", "Chr02"],
    ]);
    expect(state.assembly.selection).toBeNull();
    expect(state.logEntries[state.logEntries.length - 1]?.message).toBe("Chromosome boundaries added");
  });

  it("records and restores a three-way chromosome boundary split", () => {
    const internalBlocks = [1, 2, 3, 4].map((index) => ({
      id: `Chr01:${index}:ctg${index}`,
      objectId: "Chr01",
      sourceId: `ctg${index}`,
      sourceStart: 0,
      sourceEnd: 100,
      visualStart: (index - 1) * 100,
      visualEnd: index * 100,
      orientation: "+" as const,
    }));
    let state = createInitialUiState("Browser preview mode");

    state = reduceUiState(state, { type: "setAssemblyBlocks", blocks: internalBlocks });
    state = reduceUiState(state, { type: "selectAssemblyContig", id: "Chr01:2:ctg2", additive: false });
    state = reduceUiState(state, { type: "selectAssemblyContig", id: "Chr01:3:ctg3", additive: true });
    state = reduceUiState(state, { type: "addAssemblyChromosomeBoundaries" });

    expect(state.assembly.blocks.map((block) => block.objectId)).toEqual([
      "Chr01",
      "Chr01_d2",
      "Chr01_d2",
      "Chr01_d3",
    ]);
    expect(state.assembly.selection).toBeNull();
    expect(state.operationHistory[state.operationHistory.length - 1]).toMatchObject({
      type: "add_chr_boundaries",
      label: "Chromosome boundaries added",
    });

    state = reduceUiState(state, { type: "undo" });
    expect(state.assembly.blocks.map((block) => block.objectId)).toEqual([
      "Chr01",
      "Chr01",
      "Chr01",
      "Chr01",
    ]);
    expect(state.assembly.selection).toEqual({
      kind: "contigs",
      ids: ["Chr01:2:ctg2", "Chr01:3:ctg3"],
    });

    state = reduceUiState(state, { type: "redo" });
    expect(state.assembly.blocks.map((block) => block.objectId)).toEqual([
      "Chr01",
      "Chr01_d2",
      "Chr01_d2",
      "Chr01_d3",
    ]);
    expect(state.assembly.selection).toBeNull();
  });

  it("keeps a complete chromosome selection when no new boundary is needed", () => {
    let state = createInitialUiState("Browser preview mode");

    state = reduceUiState(state, { type: "setAssemblyBlocks", blocks: assemblyBlocks });
    state = reduceUiState(state, { type: "selectAssemblyContig", id: "Chr01:1:ctg1", additive: false });
    state = reduceUiState(state, { type: "selectAssemblyContig", id: "Chr01:2:ctg2", additive: true });
    const before = state;

    state = reduceUiState(state, { type: "addAssemblyChromosomeBoundaries" });

    expect(state).toBe(before);
    expect(state.assembly.selection).toEqual({
      kind: "contigs",
      ids: ["Chr01:1:ctg1", "Chr01:2:ctg2"],
    });
    expect(state.operationHistory).toHaveLength(0);
  });


  it("splits a selected contig from the reducer", () => {
    let state = createInitialUiState("Browser preview mode");

    state = reduceUiState(state, { type: "setAssemblyBlocks", blocks: assemblyBlocks });
    state = reduceUiState(state, {
      type: "splitAssemblyContig",
      blockId: "Chr01:2:ctg2",
      visualPosition: 175,
    });

    expect(state.assembly.blocks.map((block) => [block.id, block.sourceStart, block.sourceEnd])).toEqual([
      ["Chr01:1:ctg1", 0, 100],
      ["Chr01:2:ctg2:left", 0, 75],
      ["Chr01:2:ctg2:right", 75, 150],
      ["Chr02:1:ctg3", 0, 80],
    ]);
    expect(state.assembly.selection).toBeNull();
  });

  it("keeps the selection when an edit cannot be applied", () => {
    let state = createInitialUiState("Browser preview mode");

    state = reduceUiState(state, { type: "setAssemblyBlocks", blocks: assemblyBlocks });
    state = reduceUiState(state, { type: "selectAssemblyContig", id: "Chr01:2:ctg2", additive: false });
    const beforeInvalidSplit = state;
    state = reduceUiState(state, {
      type: "splitAssemblyContig",
      blockId: "Chr01:2:ctg2",
      visualPosition: 100,
    });

    expect(state).toBe(beforeInvalidSplit);
    expect(state.assembly.selection).toEqual({ kind: "contigs", ids: ["Chr01:2:ctg2"] });
    expect(state.operationHistory).toHaveLength(0);
  });

  it("undoes and redoes assembly edits with block snapshots", () => {
    let state = createInitialUiState("Browser preview mode");

    state = reduceUiState(state, { type: "setAssemblyBlocks", blocks: assemblyBlocks });
    state = reduceUiState(state, { type: "selectAssemblyContig", id: "Chr01:1:ctg1", additive: false });
    state = reduceUiState(state, { type: "copyAssemblySelection" });

    expect(state.assembly.blocks.map((block) => block.id)).toEqual([
      "Chr01:1:ctg1",
      "Chr01:1:ctg1_d2",
      "Chr01:2:ctg2",
      "Chr02:1:ctg3",
    ]);
    expect(state.assembly.selection).toBeNull();

    state = reduceUiState(state, { type: "undo" });
    expect(state.assembly.blocks.map((block) => block.id)).toEqual([
      "Chr01:1:ctg1",
      "Chr01:2:ctg2",
      "Chr02:1:ctg3",
    ]);
    expect(state.assembly.selection).toEqual({ kind: "contigs", ids: ["Chr01:1:ctg1"] });
    expect(state.redoStack).toHaveLength(1);

    state = reduceUiState(state, { type: "redo" });
    expect(state.assembly.blocks.map((block) => block.id)).toEqual([
      "Chr01:1:ctg1",
      "Chr01:1:ctg1_d2",
      "Chr01:2:ctg2",
      "Chr02:1:ctg3",
    ]);
    expect(state.assembly.selection).toBeNull();
  });
});
