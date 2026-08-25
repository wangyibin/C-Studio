import { describe, expect, it } from "vitest";
import {
  availableContactResolutions,
  availableContactResolutionsForDataset,
  contactNormalizationForBackend,
  contactNormalizationLabel,
  contactResolutions,
  createInitialUiState,
  normalizations,
  overviewRatioToViewportCenterMb,
  reduceUiState,
  storedContactResolutionsForDataset,
} from "./uiState";
import type { ContactMapLayoutBlock } from "./importers";
import { selectedBlockIds } from "./assemblyEditing";

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

  const structuredAssemblyBlocks: ContactMapLayoutBlock[] = [
    {
      id: "Chr01:1:ctgA",
      objectId: "Chr01",
      sourceId: "ctgA",
      sourceStart: 0,
      sourceEnd: 100,
      visualStart: 0,
      visualEnd: 100,
      orientation: "+",
      componentType: "W",
      assemblyBlockId: "Chr01_block_1",
    },
    {
      id: "Chr01:2:ctgB",
      objectId: "Chr01",
      sourceId: "ctgB",
      sourceStart: 0,
      sourceEnd: 50,
      visualStart: 100,
      visualEnd: 150,
      orientation: "-",
      componentType: "W",
      assemblyBlockId: "Chr01_block_1",
    },
    {
      id: "Chr01:4:ctgC",
      objectId: "Chr01",
      sourceId: "ctgC",
      sourceStart: 0,
      sourceEnd: 60,
      visualStart: 190,
      visualEnd: 250,
      orientation: "+",
      componentType: "W",
      assemblyBlockId: null,
      gapBefore: {
        componentType: "U",
        length: 40,
        gapType: "contig",
        linkage: "yes",
        linkageEvidence: "map",
      },
    },
    {
      id: "Chr02:1:ctgD",
      objectId: "Chr02",
      sourceId: "ctgD",
      sourceStart: 0,
      sourceEnd: 80,
      visualStart: 250,
      visualEnd: 330,
      orientation: "+",
      componentType: "W",
      assemblyBlockId: null,
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

  it("deletes selected contigs through undoable assembly history", () => {
    let state = createInitialUiState("Browser preview mode");
    state = reduceUiState(state, { type: "setAssemblyBlocks", blocks: assemblyBlocks });
    state = reduceUiState(state, {
      type: "selectAssemblyContig",
      id: "Chr01:2:ctg2",
      additive: false,
    });
    state = reduceUiState(state, { type: "deleteAssemblySelection" });

    expect(state.assembly.blocks.map((block) => block.id)).toEqual([
      "Chr01:1:ctg1",
      "Chr02:1:ctg3",
    ]);
    expect(state.assembly.selection).toBeNull();
    expect(state.operationHistory[state.operationHistory.length - 1]).toMatchObject({
      type: "delete_contig",
      label: "1 contig deleted",
    });

    state = reduceUiState(state, { type: "undo" });
    expect(state.assembly.blocks).toHaveLength(3);
    expect(state.assembly.selection).toEqual({
      kind: "contigs",
      ids: ["Chr01:2:ctg2"],
    });

    state = reduceUiState(state, { type: "redo" });
    expect(state.assembly.blocks.map((block) => block.id)).toEqual([
      "Chr01:1:ctg1",
      "Chr02:1:ctg3",
    ]);
  });

  it("renames contigs and chromosomes through undoable assembly history", () => {
    let state = createInitialUiState("Browser preview mode");
    state = reduceUiState(state, { type: "setAssemblyBlocks", blocks: assemblyBlocks });
    state = reduceUiState(state, {
      type: "selectAssemblyContig",
      id: "Chr01:1:ctg1",
      additive: false,
    });
    state = reduceUiState(state, {
      type: "renameAssemblySelection",
      name: "contig_alpha",
    });

    expect(state.assembly.blocks[0]).toMatchObject({
      sourceId: "ctg1",
      displayName: "contig_alpha",
    });
    expect(state.operationHistory[state.operationHistory.length - 1]).toMatchObject({
      type: "rename",
      label: "Contig renamed to contig_alpha",
    });

    state = reduceUiState(state, { type: "undo" });
    expect(state.assembly.blocks[0]?.displayName).toBeUndefined();
    state = reduceUiState(state, { type: "redo" });
    expect(state.assembly.blocks[0]?.displayName).toBe("contig_alpha");

    state = reduceUiState(state, { type: "selectAssemblyChromosome", id: "Chr01" });
    state = reduceUiState(state, {
      type: "renameAssemblySelection",
      name: "ChrA",
    });
    expect(state.assembly.blocks.slice(0, 2).map((block) => block.objectId)).toEqual([
      "ChrA",
      "ChrA",
    ]);
    expect(state.assembly.selection).toEqual({ kind: "chromosome", id: "ChrA" });
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
      "2 kb",
      "1 kb",
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

  it("pans to X and Y contigs without changing zoom and selects both contigs", () => {
    let state = createInitialUiState("Browser preview mode");
    state = reduceUiState(state, { type: "setAssemblyBlocks", blocks: assemblyBlocks });
    state = {
      ...state,
      contact: {
        ...state.contact,
        viewportSpanMb: 80,
        resolution: "250 kb",
        colorScale: { log: true, min: 0.1, max: 40, auto: false },
      },
    };

    state = reduceUiState(state, {
      type: "jumpContactViewportToRegions",
      xCenterBp: 50_000_000,
      yCenterBp: 150_000_000,
      selectedBlockIds: ["Chr01:1:ctg1", "Chr02:1:ctg3"],
      totalSpanMb: 200,
      label: "X ctgA; Y ctgB:0-20000000",
    });

    expect(state.contact.viewportCenterXMb).toBe(50);
    expect(state.contact.viewportCenterYMb).toBe(150);
    expect(state.contact.viewportCenterMb).toBe(100);
    expect(state.contact.viewportSpanMb).toBe(80);
    expect(state.contact.resolution).toBe("250 kb");
    expect(state.contact.colorScale).toEqual({ log: true, min: 0.1, max: 40, auto: false });
    expect(state.assembly.selection).toEqual({
      kind: "contigs",
      ids: ["Chr01:1:ctg1", "Chr02:1:ctg3"],
    });
    expect(state.logEntries[state.logEntries.length - 1]?.message).toBe(
      "Contact viewport jumped to X ctgA; Y ctgB:0-20000000",
    );
  });

  it("previews a placement boundary without adding a log entry", () => {
    let state = createInitialUiState("Browser preview mode");
    state = reduceUiState(state, { type: "setAssemblyBlocks", blocks: assemblyBlocks });
    state = reduceUiState(state, {
      type: "selectAssemblyContig",
      id: "Chr01:1:ctg1",
      additive: false,
    });
    const logCount = state.logEntries.length;

    state = reduceUiState(state, {
      type: "jumpContactViewportToRegions",
      xCenterBp: 250,
      yCenterBp: 250,
      selectedBlockIds: ["Chr01:1:ctg1"],
      totalSpanMb: 0.00033,
      label: "placement candidate 1",
      transient: true,
    });

    expect(state.assembly.selection).toEqual({
      kind: "contigs",
      ids: ["Chr01:1:ctg1"],
    });
    expect(state.logEntries).toHaveLength(logCount);
  });

  it("centers and exactly selects a clicked contig segment from the inspector", () => {
    let state = createInitialUiState("Browser preview mode");
    state = reduceUiState(state, { type: "setAssemblyBlocks", blocks: assemblyBlocks });
    state = {
      ...state,
      contact: {
        ...state.contact,
        viewportWidthPx: 800,
        viewportHeightPx: 600,
        viewportSpanMb: 200,
      },
    };

    state = reduceUiState(state, {
      type: "focusAssemblyContig",
      id: "Chr01:2:ctg2",
    });

    expect(state.assembly.selection).toEqual({
      kind: "contigs",
      ids: ["Chr01:2:ctg2"],
      exact: true,
    });
    expect(state.contact.viewportCenterXMb).toBe(0.000175);
    expect(state.contact.viewportCenterYMb).toBe(0.000175);
    expect(state.contact.viewportCenterMb).toBe(0.000175);
    expect(state.contact.viewportSpanMb).toBeLessThan(200);
    expect(state.contact.resolution).toBe("1 kb");
    expect(state.contact.colorScale.auto).toBe(true);
    expect(state.logEntries[state.logEntries.length - 1]?.message).toBe(
      "Focused contig ctg2 at Chr01",
    );
  });

  it("centers and keeps a composite block selected from the inspector", () => {
    let state = createInitialUiState("Browser preview mode");
    state = reduceUiState(state, {
      type: "setAssemblyBlocks",
      blocks: structuredAssemblyBlocks,
    });
    state = {
      ...state,
      contact: {
        ...state.contact,
        viewportWidthPx: 800,
        viewportHeightPx: 600,
        viewportSpanMb: 200,
      },
    };

    state = reduceUiState(state, {
      type: "focusAssemblyContig",
      id: "Chr01_block_1",
    });

    expect(state.assembly.selection).toEqual({
      kind: "contigs",
      ids: ["Chr01_block_1"],
    });
    expect(state.contact.viewportCenterXMb).toBe(0.000075);
    expect(state.contact.viewportCenterYMb).toBe(0.000075);
    expect(state.logEntries[state.logEntries.length - 1]?.message).toBe(
      "Focused block Chr01_block_1 at Chr01",
    );
  });

  it("keeps a locked contact resolution when focusing a contig from the inspector", () => {
    let state = createInitialUiState("Browser preview mode");
    state = reduceUiState(state, { type: "setAssemblyBlocks", blocks: assemblyBlocks });
    state = reduceUiState(state, { type: "setContactResolution", resolution: "100 kb" });
    state = reduceUiState(state, { type: "toggleContactResolutionLock" });

    state = reduceUiState(state, {
      type: "focusAssemblyContig",
      id: "Chr01:2:ctg2",
    });

    expect(state.contact.resolution).toBe("100 kb");
    expect(state.contact.resolutionLocked).toBe(true);
  });

  it("fits and selects a chromosome from its inspector locate button", () => {
    const chromosomeBlocks: ContactMapLayoutBlock[] = [
      {
        ...assemblyBlocks[0],
        visualStart: 20_000_000,
        visualEnd: 30_000_000,
      },
      {
        ...assemblyBlocks[1],
        visualStart: 30_000_000,
        visualEnd: 50_000_000,
      },
      {
        ...assemblyBlocks[2],
        visualStart: 50_000_000,
        visualEnd: 100_000_000,
      },
    ];
    let state = createInitialUiState("Browser preview mode");
    state = reduceUiState(state, { type: "setAssemblyBlocks", blocks: chromosomeBlocks });

    state = reduceUiState(state, { type: "focusAssemblyChromosome", id: "Chr01" });

    expect(state.assembly.selection).toEqual({ kind: "chromosome", id: "Chr01" });
    expect(state.contact.viewportCenterXMb).toBe(35);
    expect(state.contact.viewportCenterYMb).toBe(35);
    expect(state.contact.viewportSpanMb).toBe(30);
    expect(state.contact.resolution).toBe("50 kb");
    expect(state.logEntries[state.logEntries.length - 1]?.message).toBe(
      "Focused chromosome Chr01",
    );
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

  it("switches mcool pyramid levels without changing the genomic viewport", () => {
    let state = createInitialUiState("Browser preview mode");
    state = reduceUiState(state, {
      type: "setContactViewportMetrics",
      viewportSizePx: 536,
      totalSpanMb: 200,
    });
    const viewportSpanMb = state.contact.viewportSpanMb;

    state = reduceUiState(state, {
      type: "setContactResolution",
      resolution: "250 kb",
      preserveViewport: true,
    });

    expect(state.contact.resolution).toBe("250 kb");
    expect(state.contact.viewportSpanMb).toBe(viewportSpanMb);
    expect(state.contact.viewportCenterXMb).toBe(98.42);
    expect(state.contact.viewportCenterYMb).toBe(98.42);
  });

  it("makes a manual stored-resolution change follow the target level geometry", () => {
    let state = createInitialUiState("Browser preview mode");
    state = reduceUiState(state, {
      type: "setContactViewportMetrics",
      viewportSizePx: 536,
      totalSpanMb: 200,
    });

    state = reduceUiState(state, {
      type: "setContactResolution",
      resolution: "250 kb",
    });

    expect(state.contact.resolution).toBe("250 kb");
    expect(state.contact.viewportSpanMb).toBe(134);
    expect(state.contact.viewportCenterXMb).toBe(98.42);
    expect(state.contact.viewportCenterYMb).toBe(98.42);
  });

  it("separates stored mcool levels from levels safe for the current viewport", () => {
    let state = createInitialUiState("Browser preview mode");
    state = reduceUiState(state, {
      type: "setContactViewportMetrics",
      viewportSizePx: 536,
      totalSpanMb: 10_327,
    });

    expect(availableContactResolutions(state.contact, 10_327, true)).toEqual([
      "2.5 Mb",
      "2 Mb",
    ]);
    expect(availableContactResolutionsForDataset(
      state.contact,
      [
        1_000,
        2_000,
        5_000,
        10_000,
        25_000,
        50_000,
        100_000,
        250_000,
        500_000,
        1_000_000,
        2_500_000,
      ],
      10_327,
      true,
    )).toEqual(["2.5 Mb"]);
    expect(storedContactResolutionsForDataset([
      1_000,
      2_000,
      5_000,
      10_000,
      25_000,
      50_000,
      100_000,
      250_000,
      500_000,
      1_000_000,
      2_500_000,
    ])).toEqual([
      "2.5 Mb",
      "1 Mb",
      "500 kb",
      "250 kb",
      "100 kb",
      "50 kb",
      "25 kb",
      "10 kb",
      "5 kb",
      "2 kb",
      "1 kb",
    ]);

    state = reduceUiState(state, {
      type: "setContactResolution",
      resolution: "250 kb",
      preserveViewport: true,
    });

    expect(state.contact.resolution).toBe("250 kb");
    expect(state.contact.viewportSpanMb).toBe(1_536);
    expect(state.contact.viewportCenterXMb).toBe(5_163.5);
    expect(state.contact.viewportCenterYMb).toBe(5_163.5);
    expect(state.logEntries[state.logEntries.length - 1]?.message).toBe(
      "Contact resolution set to 250 kb; viewport narrowed to 1536 Mb",
    );
  });

  it("bounds the longer contact-map axis after selecting a stored fine level", () => {
    let state = createInitialUiState("Browser preview mode");
    state = reduceUiState(state, {
      type: "setContactViewportMetrics",
      viewportSizePx: 600,
      viewportWidthPx: 1_200,
      viewportHeightPx: 600,
      totalSpanMb: 10_327,
    });

    state = reduceUiState(state, {
      type: "setContactResolution",
      resolution: "1 kb",
      preserveViewport: true,
    });

    expect(state.contact.resolution).toBe("1 kb");
    expect(state.contact.viewportSpanMb).toBe(3.072);
    expect(state.contact.viewportCenterXMb).toBe(5_163.5);
    expect(state.contact.viewportCenterYMb).toBe(5_163.5);
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
      "2 kb",
      "1 kb",
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

  it("updates the main viewport during overview dragging without appending transient logs", () => {
    const initial = createInitialUiState("Browser preview mode");
    const state = reduceUiState(initial, {
      type: "setContactViewportCenterFromOverview",
      xRatio: 0.3,
      yRatio: 0.6,
      totalSpanMb: 200,
      transient: true,
    });

    expect(state.contact.viewportCenterXMb).toBe(60);
    expect(state.contact.viewportCenterYMb).toBe(120);
    expect(state.logEntries).toHaveLength(initial.logEntries.length);
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

  it("commits an absolute dragged viewport without applying the movement twice", () => {
    const initialState = createInitialUiState("Browser preview mode");
    const state = reduceUiState(
      {
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
      },
      {
        type: "commitContactViewportPan",
        viewport: {
          xStart: 123_456_789,
          xEnd: 323_456_789,
          yStart: 80_123_456,
          yEnd: 180_123_456,
        },
        totalSpanMb: 400,
      },
    );

    expect(state.contact.viewportCenterXMb).toBe(223.456789);
    expect(state.contact.viewportCenterYMb).toBe(130.123456);
    expect(state.contact.viewportCenterMb).toBe(176.790122);
    expect(state.contact.jumpTargetMb).toBe(223.456789);
    expect(state.contact.viewportSpanMb).toBe(100);
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

  it("lets a locked resolution expand through subpixel bins while staying within its tile budget", () => {
    let state = createInitialUiState("Browser preview mode");
    state = reduceUiState(state, { type: "setContactResolution", resolution: "250 kb" });
    state = reduceUiState(state, { type: "toggleContactResolutionLock" });

    state = reduceUiState(state, {
      type: "zoomContactViewport",
      direction: "out",
      scaleFactor: 0.01,
      totalSpanMb: 200,
    });

    expect(state.contact.viewportSpanMb).toBe(200);
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

  it("keeps both genome coordinates under a trackpad focus stable when resolution changes", () => {
    let state = createInitialUiState("Browser preview mode");
    state = {
      ...state,
      contact: {
        ...state.contact,
        totalSpanMb: 1_000,
        viewportSizePx: 400,
        viewportWidthPx: 800,
        viewportHeightPx: 400,
        viewportSpanMb: 200,
        viewportCenterMb: 400,
        viewportCenterXMb: 300,
        viewportCenterYMb: 500,
        resolution: "1 Mb",
      },
    };

    state = reduceUiState(state, {
      type: "setContactResolution",
      resolution: "250 kb",
      focusRatioX: 0.25,
      focusRatioY: 0.75,
    });

    expect(state.contact.resolution).toBe("250 kb");
    expect(state.contact.viewportSpanMb).toBe(100);
    expect(state.contact.viewportCenterXMb).toBe(250);
    expect(state.contact.viewportCenterYMb).toBe(525);
    expect(state.contact.viewportCenterMb).toBe(387.5);
    expect(150 + 200 * 0.25).toBe(100 + 400 * 0.25);
    expect(475 + 100 * 0.75).toBe(400 + 200 * 0.75);
  });

  it("uses the retained visible-camera anchor during a later pinch step", () => {
    let state = createInitialUiState("Browser preview mode");
    state = {
      ...state,
      contact: {
        ...state.contact,
        totalSpanMb: 1_000,
        viewportSizePx: 400,
        viewportWidthPx: 800,
        viewportHeightPx: 400,
        viewportSpanMb: 100,
        viewportCenterMb: 387.5,
        viewportCenterXMb: 260,
        viewportCenterYMb: 515,
        resolution: "250 kb",
      },
    };

    state = reduceUiState(state, {
      type: "setContactResolution",
      resolution: "50 kb",
      focusRatioX: 0.25,
      focusRatioY: 0.75,
      focusXMb: 200,
      focusYMb: 550,
    });

    expect(state.contact.viewportSpanMb).toBe(20);
    expect(state.contact.viewportCenterXMb).toBe(210);
    expect(state.contact.viewportCenterYMb).toBe(545);
  });

  it("uses the retained visible-camera anchor for locked continuous zoom", () => {
    let state = createInitialUiState("Browser preview mode");
    state = {
      ...state,
      contact: {
        ...state.contact,
        totalSpanMb: 1_000,
        viewportSizePx: 400,
        viewportWidthPx: 800,
        viewportHeightPx: 400,
        viewportSpanMb: 100,
        viewportCenterMb: 387.5,
        viewportCenterXMb: 260,
        viewportCenterYMb: 515,
        resolution: "250 kb",
        resolutionLocked: true,
      },
    };

    state = reduceUiState(state, {
      type: "zoomContactViewport",
      direction: "in",
      focusRatioX: 0.25,
      focusRatioY: 0.75,
      focusXMb: 200,
      focusYMb: 550,
      scaleFactor: 2,
      totalSpanMb: 1_000,
    });

    expect(state.contact.viewportSpanMb).toBe(50);
    expect(state.contact.viewportCenterXMb).toBe(225);
    expect(state.contact.viewportCenterYMb).toBe(537.5);
    expect(state.contact.resolution).toBe("250 kb");
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

  it("expands a locked 1 kb genomic viewport without changing its data resolution", () => {
    let state = createInitialUiState("Browser preview mode");
    state = reduceUiState(state, {
      type: "setContactViewportMetrics",
      viewportSizePx: 536,
      totalSpanMb: 200,
    });
    state = reduceUiState(state, { type: "setContactResolution", resolution: "1 kb" });
    state = reduceUiState(state, { type: "toggleContactResolutionLock" });
    state = reduceUiState(state, {
      type: "zoomContactViewport",
      direction: "out",
      focusRatioX: 0.5,
      focusRatioY: 0.5,
      scaleFactor: 0.000001,
      totalSpanMb: 200,
    });

    expect(state.contact.resolution).toBe("1 kb");
    expect(state.contact.viewportSpanMb).toBe(6.144);
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
    expect(state.assembly.showBlockBoxes).toBe(true);
    expect(state.assembly.showContigBoxes).toBe(true);
  });

  it("maps child-contig selection onto its parent assembly block", () => {
    let state = createInitialUiState("Browser preview mode");
    state = reduceUiState(state, { type: "setAssemblyBlocks", blocks: structuredAssemblyBlocks });

    state = reduceUiState(state, {
      type: "selectAssemblyContig",
      id: "Chr01:2:ctgB",
      additive: false,
    });
    expect(state.assembly.selection).toEqual({
      kind: "contigs",
      ids: ["Chr01_block_1"],
    });

    state = reduceUiState(state, {
      type: "selectAssemblyContig",
      id: "Chr01:1:ctgA",
      additive: true,
    });
    expect(state.assembly.selection).toBeNull();

    state = reduceUiState(state, {
      type: "selectAssemblyContigs",
      ids: ["Chr01:1:ctgA", "Chr01:2:ctgB", "Chr01:4:ctgC"],
    });
    expect(state.assembly.selection).toEqual({
      kind: "contigs",
      ids: ["Chr01_block_1", "Chr01:4:ctgC"],
    });
  });

  it("keeps an explicit GFA block selection whole even when its utgs are source segments", () => {
    const sourceSegmentBlocks = structuredAssemblyBlocks.map((block) => (
      block.assemblyBlockId === "Chr01_block_1"
        ? { ...block, isSourceSegment: true }
        : block
    ));
    let state = createInitialUiState("Browser preview mode");
    state = reduceUiState(state, { type: "setAssemblyBlocks", blocks: sourceSegmentBlocks });
    state = reduceUiState(state, {
      type: "selectAssemblyContigs",
      ids: ["Chr01_block_1"],
    });

    expect(state.assembly.selection).toEqual({
      kind: "contigs",
      ids: ["Chr01_block_1"],
    });
    expect(selectedBlockIds(state.assembly.blocks, state.assembly.selection)).toEqual([
      "Chr01:1:ctgA",
      "Chr01:2:ctgB",
    ]);
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

  it("toggles chromosome, block, and contig heatmap boxes independently", () => {
    let state = createInitialUiState("Browser preview mode");

    state = reduceUiState(state, { type: "toggleAssemblyOverlay", overlay: "chromosome" });
    expect(state.assembly.showChromosomeBoxes).toBe(false);
    expect(state.assembly.showBlockBoxes).toBe(true);
    expect(state.assembly.showContigBoxes).toBe(true);

    state = reduceUiState(state, { type: "toggleAssemblyOverlay", overlay: "block" });
    expect(state.assembly.showChromosomeBoxes).toBe(false);
    expect(state.assembly.showBlockBoxes).toBe(false);
    expect(state.assembly.showContigBoxes).toBe(true);

    state = reduceUiState(state, { type: "toggleAssemblyOverlay", overlay: "contig" });
    expect(state.assembly.showChromosomeBoxes).toBe(false);
    expect(state.assembly.showBlockBoxes).toBe(false);
    expect(state.assembly.showContigBoxes).toBe(false);

    state = reduceUiState(state, { type: "toggleAssemblyOverlay", overlay: "chromosome" });
    expect(state.assembly.showChromosomeBoxes).toBe(true);
    expect(state.assembly.showBlockBoxes).toBe(false);
    expect(state.assembly.showContigBoxes).toBe(false);
  });

  it("sets all heatmap annotation layers together for the F2 shortcut", () => {
    let state = createInitialUiState("Browser preview mode");
    state = reduceUiState(state, { type: "toggleAssemblyOverlay", overlay: "contig" });
    expect(state.assembly.showChromosomeBoxes).toBe(true);
    expect(state.assembly.showBlockBoxes).toBe(true);
    expect(state.assembly.showContigBoxes).toBe(false);

    state = reduceUiState(state, {
      type: "setAssemblyOverlayVisibility",
      chromosome: false,
      block: false,
      contig: false,
    });
    expect(state.assembly.showChromosomeBoxes).toBe(false);
    expect(state.assembly.showBlockBoxes).toBe(false);
    expect(state.assembly.showContigBoxes).toBe(false);

    state = reduceUiState(state, {
      type: "setAssemblyOverlayVisibility",
      chromosome: true,
      block: true,
      contig: false,
    });
    expect(state.assembly.showChromosomeBoxes).toBe(true);
    expect(state.assembly.showBlockBoxes).toBe(true);
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

  it("creates and dissolves a GFA-overlap-aware block through reversible history", () => {
    let state = createInitialUiState("Browser preview mode");
    state = reduceUiState(state, { type: "setAssemblyBlocks", blocks: assemblyBlocks });
    state = reduceUiState(state, {
      type: "selectAssemblyContigs",
      ids: ["Chr01:1:ctg1", "Chr01:2:ctg2"],
    });
    state = reduceUiState(state, {
      type: "createAssemblyBlockFromGfa",
      links: [{
        id: "link-ctg1-ctg2",
        from: { segmentName: "ctg1", orientation: "+", side: "end" },
        to: { segmentName: "ctg2", orientation: "-", side: "end" },
        overlap: "12M",
      }],
    });

    expect(state.assembly.blocks.slice(0, 2).map((block) => block.assemblyBlockId)).toEqual([
      "Chr01_block_1",
      "Chr01_block_1",
    ]);
    expect(state.assembly.blocks[1]).toMatchObject({ sourceStart: 0, sourceEnd: 138 });
    expect(state.operationHistory[state.operationHistory.length - 1]?.type).toBe("create_block");

    state = reduceUiState(state, {
      type: "selectAssemblyContigs",
      ids: ["Chr01_block_1"],
    });
    state = reduceUiState(state, { type: "dissolveAssemblyBlockSelection" });

    expect(state.assembly.blocks.slice(0, 2).map((block) => block.assemblyBlockId)).toEqual([null, null]);
    expect(state.assembly.blocks[1]).toMatchObject({ sourceStart: 0, sourceEnd: 150 });
    expect(state.assembly.blocks[1]?.gapBefore?.length).toBe(100);
    expect(state.operationHistory[state.operationHistory.length - 1]?.type).toBe("dissolve_block");

    state = reduceUiState(state, { type: "undo" });
    expect(state.assembly.blocks[1]).toMatchObject({ sourceStart: 0, sourceEnd: 138 });
  });

  it("places an unplaced GFA segment through history and restores it with redo", () => {
    let state = createInitialUiState("Browser preview mode");
    state = reduceUiState(state, {
      type: "setAssemblyBlocks",
      blocks: structuredAssemblyBlocks,
    });
    state = reduceUiState(state, {
      type: "placeUnplacedGfaSegment",
      segmentName: "utg-missing",
      length: 90,
      targetObjectId: "Chr01",
      targetBlockId: "Chr01:4:ctgC",
      orientation: "-",
    });

    const inserted = state.assembly.blocks.find((block) => block.sourceId === "utg-missing");
    expect(inserted).toMatchObject({
      objectId: "Chr01",
      sourceStart: 0,
      sourceEnd: 90,
      orientation: "-",
      componentType: "W",
      gapBefore: { componentType: "U", length: 100 },
    });
    expect(state.assembly.selection).toEqual({
      kind: "contigs",
      ids: [inserted?.id],
      exact: true,
    });
    expect(state.operationHistory[state.operationHistory.length - 1]).toMatchObject({
      type: "place_unplaced",
      label: "utg-missing added to Chr01",
    });

    state = reduceUiState(state, { type: "undo" });
    expect(state.assembly.blocks.some((block) => block.sourceId === "utg-missing")).toBe(false);

    state = reduceUiState(state, { type: "redo" });
    expect(state.assembly.blocks.find((block) => block.sourceId === "utg-missing"))
      .toMatchObject({ sourceEnd: 90, orientation: "-" });
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

  it("applies a recommended orientation and move as one undoable operation", () => {
    let state = createInitialUiState("Browser preview mode");
    state = reduceUiState(state, { type: "setAssemblyBlocks", blocks: assemblyBlocks });
    state = reduceUiState(state, {
      type: "selectAssemblyContig",
      id: "Chr01:1:ctg1",
      additive: false,
    });
    state = reduceUiState(state, {
      type: "applyAssemblyPlacementRecommendation",
      selectedBlockIds: ["Chr01:1:ctg1"],
      targetObjectId: "Chr02",
      targetBlockId: "Chr02:1:ctg3",
      orientation: "-",
    });

    expect(state.assembly.blocks.map((block) => [block.id, block.objectId, block.orientation]))
      .toEqual([
        ["Chr01:2:ctg2", "Chr01", "-"],
        ["Chr01:1:ctg1", "Chr02", "-"],
        ["Chr02:1:ctg3", "Chr02", "+"],
      ]);
    expect(state.operationHistory).toHaveLength(1);
    expect(state.operationHistory[0]).toMatchObject({
      type: "place_recommendation",
      label: "Placed Chr01:1:ctg1 on Chr02 (-)",
    });
    expect(state.assembly.selection).toBeNull();

    state = reduceUiState(state, { type: "undo" });
    expect(state.assembly.blocks).toEqual(assemblyBlocks);
  });

  it("applies a recommended multi-contig block reversal and move as one undoable operation", () => {
    let state = createInitialUiState("Browser preview mode");
    const blocks = [
      ...assemblyBlocks.slice(0, 2),
      {
        ...assemblyBlocks[1],
        id: "Chr01:3:ctg4",
        sourceId: "ctg4",
        visualStart: 250,
        visualEnd: 400,
      },
      {
        ...assemblyBlocks[2],
        visualStart: 400,
        visualEnd: 480,
      },
    ];
    state = reduceUiState(state, { type: "setAssemblyBlocks", blocks });
    state = reduceUiState(state, {
      type: "selectAssemblyOccurrences",
      ids: ["Chr01:2:ctg2", "Chr01:3:ctg4"],
    });
    state = reduceUiState(state, {
      type: "applyAssemblyPlacementRecommendation",
      selectedBlockIds: ["Chr01:2:ctg2", "Chr01:3:ctg4"],
      targetObjectId: "Chr02",
      targetBlockId: "Chr02:1:ctg3",
      orientation: "-",
    });

    expect(state.assembly.blocks.map((block) => [block.id, block.objectId, block.orientation]))
      .toEqual([
        ["Chr01:1:ctg1", "Chr01", "+"],
        ["Chr01:3:ctg4", "Chr02", "+"],
        ["Chr01:2:ctg2", "Chr02", "+"],
        ["Chr02:1:ctg3", "Chr02", "+"],
      ]);
    expect(state.operationHistory).toHaveLength(1);
    expect(state.operationHistory[0]).toMatchObject({
      type: "place_recommendation",
      label: "Placed 2-contig block on Chr02 (-)",
    });

    state = reduceUiState(state, { type: "undo" });
    expect(state.assembly.blocks).toEqual(blocks);
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

  it("merges a selected chromosome into an internal contig gap when explicitly targeted", () => {
    let state = createInitialUiState("Browser preview mode");

    state = reduceUiState(state, { type: "setAssemblyBlocks", blocks: assemblyBlocks });
    state = reduceUiState(state, { type: "selectAssemblyChromosome", id: "Chr02" });
    state = reduceUiState(state, {
      type: "moveAssemblySelectionBefore",
      targetBlockId: "Chr01:2:ctg2",
      targetObjectId: "Chr01",
    });

    expect(state.assembly.blocks.map((block) => [block.id, block.objectId])).toEqual([
      ["Chr01:1:ctg1", "Chr01"],
      ["Chr02:1:ctg3", "Chr01"],
      ["Chr01:2:ctg2", "Chr01"],
    ]);
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

  it("keeps a split segment selected precisely and copies only that interval", () => {
    let state = createInitialUiState("Browser preview mode");
    state = reduceUiState(state, {
      type: "setAssemblyBlocks",
      blocks: structuredAssemblyBlocks,
    });
    state = reduceUiState(state, {
      type: "splitAssemblyContig",
      blockId: "Chr01:2:ctgB",
      visualPosition: 125,
    });
    state = reduceUiState(state, {
      type: "selectAssemblyContig",
      id: "Chr01:2:ctgB:left",
      additive: false,
    });

    expect(state.assembly.selection).toEqual({
      kind: "contigs",
      ids: ["Chr01:2:ctgB:left"],
    });

    state = reduceUiState(state, { type: "copyAssemblySelection" });

    expect(state.assembly.blocks.filter((block) => block.sourceId === "ctgA")).toHaveLength(1);
    expect(state.assembly.blocks.filter((block) => (
      block.sourceId === "ctgB" && block.sourceStart === 25 && block.sourceEnd === 50
    ))).toHaveLength(2);
    expect(state.assembly.blocks.filter((block) => (
      block.sourceId === "ctgB" && block.sourceStart === 0 && block.sourceEnd === 25
    ))).toHaveLength(1);
    expect(state.assembly.blocks.filter((block) => (
      block.sourceStart === 25
      && block.sourceEnd === 50
      && block.displayName === undefined
      && block.sourceId === "ctgB"
    ))).toHaveLength(2);
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

  it("removes a chromosome boundary enclosed by the selected blocks", () => {
    let state = createInitialUiState("Browser preview mode");

    state = reduceUiState(state, { type: "setAssemblyBlocks", blocks: assemblyBlocks });
    state = reduceUiState(state, { type: "selectAssemblyContig", id: "Chr01:2:ctg2", additive: false });
    state = reduceUiState(state, { type: "selectAssemblyContig", id: "Chr02:1:ctg3", additive: true });
    state = reduceUiState(state, { type: "removeAssemblyChromosomeBoundaries" });

    expect(state.assembly.blocks.map((block) => block.objectId)).toEqual([
      "Chr01",
      "Chr01",
      "Chr01",
    ]);
    expect(state.assembly.selection).toBeNull();
    expect(state.operationHistory[state.operationHistory.length - 1]).toMatchObject({
      type: "remove_chr_boundaries",
      label: "Chromosome boundaries removed",
    });
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
      ["Chr01:2:ctg2:left", 75, 150],
      ["Chr01:2:ctg2:right", 0, 75],
      ["Chr02:1:ctg3", 0, 80],
    ]);
    expect(state.assembly.blocks[2]?.gapBefore).toEqual({
      componentType: "U",
      length: 100,
      gapType: "contig",
      linkage: "no",
      linkageEvidence: "na",
    });
    expect(state.assembly.selection).toBeNull();

    const liveGap = state.assembly.blocks[2]?.gapBefore;
    expect(liveGap).toBeDefined();
    if (liveGap) {
      liveGap.length = 999;
    }

    state = reduceUiState(state, { type: "undo" });
    expect(state.assembly.blocks).toEqual(assemblyBlocks);

    state = reduceUiState(state, { type: "redo" });
    expect(state.assembly.blocks[2]?.gapBefore?.length).toBe(100);
  });

  it("deletes a selected gap, merges blocks, and restores cloned gap metadata on undo", () => {
    const imported = structuredAssemblyBlocks.map((block) => ({
      ...block,
      gapBefore: block.gapBefore ? { ...block.gapBefore } : undefined,
    }));
    let state = createInitialUiState("Browser preview mode");
    state = reduceUiState(state, { type: "setAssemblyBlocks", blocks: imported });
    state = reduceUiState(state, {
      type: "selectAssemblyContig",
      id: "Chr01:2:ctgB",
      additive: false,
    });
    state = reduceUiState(state, {
      type: "selectAssemblyContig",
      id: "Chr01:4:ctgC",
      additive: true,
    });

    expect(state.assembly.selection).toEqual({
      kind: "contigs",
      ids: ["Chr01_block_1", "Chr01:4:ctgC"],
    });
    state = reduceUiState(state, { type: "deleteAssemblyGaps" });

    expect(state.assembly.blocks[2]?.gapBefore).toBeUndefined();
    expect(state.assembly.blocks.slice(0, 3).map((block) => block.assemblyBlockId)).toEqual([
      "Chr01_block_1",
      "Chr01_block_1",
      "Chr01_block_1",
    ]);
    expect(state.assembly.selection).toBeNull();
    expect(state.operationHistory[state.operationHistory.length - 1]).toMatchObject({
      label: "Gap deleted; blocks joined",
    });

    const importedGap = imported[2]?.gapBefore;
    expect(importedGap).toBeDefined();
    if (importedGap) {
      importedGap.length = 999;
    }

    state = reduceUiState(state, { type: "undo" });
    expect(state.assembly.blocks[2]?.gapBefore?.length).toBe(40);
    expect(state.assembly.selection).toEqual({
      kind: "contigs",
      ids: ["Chr01_block_1", "Chr01:4:ctgC"],
    });

    state = reduceUiState(state, { type: "redo" });
    expect(state.assembly.blocks[2]?.gapBefore).toBeUndefined();
    expect(state.assembly.blocks.slice(0, 3).map((block) => block.assemblyBlockId)).toEqual([
      "Chr01_block_1",
      "Chr01_block_1",
      "Chr01_block_1",
    ]);
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
    expect(state.assembly.selection).toEqual({
      kind: "contigs",
      ids: ["Chr01:2:ctg2"],
    });
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

  it("records affected chromosomes and contigs for history entries", () => {
    let state = createInitialUiState("Browser preview mode");
    state = reduceUiState(state, { type: "setAssemblyBlocks", blocks: assemblyBlocks });
    state = reduceUiState(state, {
      type: "selectAssemblyContigs",
      ids: ["Chr01:1:ctg1", "Chr01:2:ctg2"],
    });
    state = reduceUiState(state, { type: "reverseAssemblySelection" });

    expect(state.operationHistory[0]?.impact).toEqual({
      blockIds: ["Chr01:1:ctg1", "Chr01:2:ctg2"],
      sourceIds: ["ctg1", "ctg2"],
      chromosomeIds: ["Chr01"],
      selection: { kind: "contigs", ids: ["Chr01:1:ctg1", "Chr01:2:ctg2"] },
    });
  });

  it("focuses a history object without changing the current resolution or span", () => {
    let state = createInitialUiState("Browser preview mode");
    state = reduceUiState(state, { type: "setAssemblyBlocks", blocks: assemblyBlocks });
    state = reduceUiState(state, {
      type: "selectAssemblyContig",
      id: "Chr01:2:ctg2",
      additive: false,
    });
    state = reduceUiState(state, { type: "reverseAssemblySelection" });
    const historyId = state.operationHistory[0]?.id ?? -1;
    const resolution = state.contact.resolution;
    const viewportSpanMb = state.contact.viewportSpanMb;

    state = reduceUiState(state, { type: "focusHistoryOperation", id: historyId });

    expect(state.assembly.selection).toEqual({
      kind: "contigs",
      ids: ["Chr01:2:ctg2"],
      exact: true,
    });
    expect(state.contact.viewportCenterXMb).toBeCloseTo(0.000175);
    expect(state.contact.viewportCenterYMb).toBeCloseTo(0.000175);
    expect(state.contact.resolution).toBe(resolution);
    expect(state.contact.viewportSpanMb).toBe(viewportSpanMb);
  });

  it("undoes directly to a chosen history entry and keeps later entries as a gray redo branch", () => {
    let state = createInitialUiState("Browser preview mode");
    state = reduceUiState(state, { type: "setAssemblyBlocks", blocks: assemblyBlocks });
    state = reduceUiState(state, { type: "selectAssemblyContig", id: "Chr01:1:ctg1", additive: false });
    state = reduceUiState(state, { type: "reverseAssemblySelection" });
    const targetId = state.operationHistory[0]?.id ?? -1;
    const targetBlocks = state.assembly.blocks;
    state = reduceUiState(state, { type: "selectAssemblyContig", id: "Chr01:2:ctg2", additive: false });
    state = reduceUiState(state, { type: "copyAssemblySelection" });
    state = reduceUiState(state, { type: "selectAssemblyContig", id: "Chr02:1:ctg3", additive: false });
    state = reduceUiState(state, { type: "reverseAssemblySelection" });

    state = reduceUiState(state, { type: "undoToHistoryOperation", id: targetId });

    expect(state.assembly.blocks).toEqual(targetBlocks);
    expect(state.operationHistory.map((operation) => operation.id)).toEqual([targetId]);
    expect(state.redoStack.map((operation) => operation.label)).toEqual([
      "Selection reversed",
      "Selection copied",
    ]);

    state = reduceUiState(state, { type: "redo" });
    expect(state.operationHistory.map((operation) => operation.label)).toEqual([
      "Selection reversed",
      "Selection copied",
    ]);
  });

  it("sets and clears the hovered history preview", () => {
    let state = createInitialUiState("Browser preview mode");
    state = reduceUiState(state, { type: "previewHistoryOperation", id: 7 });
    expect(state.historyPreviewOperationId).toBe(7);
    state = reduceUiState(state, { type: "previewHistoryOperation", id: null });
    expect(state.historyPreviewOperationId).toBeNull();
  });

  it("starts a fresh undo history when a new assembly is loaded", () => {
    let state = createInitialUiState("Browser preview mode");
    const nextAssembly = [{
      ...assemblyBlocks[0],
      id: "ChrNew:1:new-contig",
      objectId: "ChrNew",
      sourceId: "new-contig",
    }];

    state = reduceUiState(state, { type: "setAssemblyBlocks", blocks: assemblyBlocks });
    state = reduceUiState(state, {
      type: "selectAssemblyContig",
      id: "Chr01:1:ctg1",
      additive: false,
    });
    state = reduceUiState(state, { type: "copyAssemblySelection" });
    state = reduceUiState(state, {
      type: "selectAssemblyContig",
      id: "Chr01:2:ctg2",
      additive: false,
    });
    state = reduceUiState(state, { type: "reverseAssemblySelection" });
    state = reduceUiState(state, { type: "undo" });

    expect(state.operationHistory).toHaveLength(1);
    expect(state.redoStack).toHaveLength(1);
    expect(state.assembly.selection).not.toBeNull();

    state = reduceUiState(state, { type: "setAssemblyBlocks", blocks: nextAssembly });

    expect(state.assembly.blocks).toEqual(nextAssembly);
    expect(state.assembly.selection).toBeNull();
    expect(state.operationHistory).toEqual([]);
    expect(state.redoStack).toEqual([]);
    expect(state.nextOperationId).toBe(1);

    state = reduceUiState(state, { type: "undo" });
    expect(state.assembly.blocks).toEqual(nextAssembly);
  });

  it("restores an imported applied and redo history onto its AGP layout", () => {
    let state = createInitialUiState("Browser preview mode");
    state = reduceUiState(state, { type: "setAssemblyBlocks", blocks: assemblyBlocks });
    state = reduceUiState(state, {
      type: "selectAssemblyContig",
      id: "Chr01:1:ctg1",
      additive: false,
    });
    state = reduceUiState(state, { type: "reverseAssemblySelection" });
    const operation = state.operationHistory[0];
    expect(operation).toBeDefined();

    const restored = reduceUiState(createInitialUiState("Reloaded"), {
      type: "restoreAssemblyHistory",
      blocks: state.assembly.blocks,
      operationHistory: operation ? [operation] : [],
      redoStack: [],
      nextOperationId: 2,
    });

    expect(restored.assembly.blocks).toEqual(state.assembly.blocks);
    expect(restored.assembly.selection).toBeNull();
    expect(restored.operationHistory).toEqual([operation]);
    expect(restored.redoStack).toEqual([]);
    expect(restored.nextOperationId).toBe(2);
  });

  it("clears loaded-data state and edit history while preserving workspace preferences", () => {
    let state = createInitialUiState("Browser preview mode");
    state.layout.rightCollapsed = true;
    state.layout.syntenySplitOpen = true;
    state.activeOverviewMode = "gfa";
    state.contact.colormap = "Viridis";
    state = reduceUiState(state, { type: "setAssemblyBlocks", blocks: assemblyBlocks });
    state = reduceUiState(state, {
      type: "selectAssemblyContig",
      id: "Chr01:1:ctg1",
      additive: false,
    });
    state = reduceUiState(state, { type: "copyAssemblySelection" });

    state = reduceUiState(state, { type: "clearLoadedData" });

    expect(state.assembly.blocks).toEqual([]);
    expect(state.assembly.selection).toBeNull();
    expect(state.operationHistory).toEqual([]);
    expect(state.redoStack).toEqual([]);
    expect(state.activeOverviewMode).toBe("overview");
    expect(state.layout.syntenySplitOpen).toBe(false);
    expect(state.layout.rightCollapsed).toBe(true);
    expect(state.contact.colormap).toBe("Viridis");
    expect(state.logEntries[state.logEntries.length - 1]?.message).toBe("All loaded data cleared");
  });
});
