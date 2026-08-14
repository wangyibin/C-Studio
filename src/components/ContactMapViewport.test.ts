import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ExampleDatasetSummary } from "../App";
import { createInitialUiState } from "../state/uiState";
import {
  assemblyCutTargetAtScreenPoint,
  assemblySelectionProjectionBands,
  assemblyShiftClickIntent,
  ContactMapViewport,
  contactCanvasBackingSizeFromBounds,
  contactResolutionWheelIntent,
  lockedContactResolutionWheelZoomIntent,
  contactViewportForAxisNavigator,
  contactViewportSizePxFromBounds,
  contactTileOverscanDirectionForViewports,
  contactWheelNavigationMode,
  contactWheelPanIntent,
  historyPreviewBoxes,
} from "./ContactMapViewport";
import { buildAssemblyEditModel } from "../state/assemblyEditing";

const bounds = {
  width: 400,
  height: 200,
};
const viewport = {
  xStart: 50_000_000,
  xEnd: 250_000_000,
  yStart: 75_000_000,
  yEnd: 175_000_000,
};

describe("assemblySelectionProjectionBands", () => {
  it("projects one selected interval into full-height and full-width alignment bands", () => {
    expect(assemblySelectionProjectionBands(100, 200, {
      xStart: 0,
      xEnd: 400,
      yStart: 50,
      yEnd: 250,
    })).toEqual({
      vertical: { left: "25%", width: "25%" },
      horizontal: { top: "25%", height: "50%" },
    });
  });

  it("keeps the visible axis band when independent x/y viewports only overlap one axis", () => {
    expect(assemblySelectionProjectionBands(100, 200, {
      xStart: 0,
      xEnd: 400,
      yStart: 300,
      yEnd: 500,
    })).toEqual({
      vertical: { left: "25%", width: "25%" },
      horizontal: null,
    });
  });
});

describe("contactResolutionWheelIntent", () => {
  const resolutionOptions = ["1 Mb", "500 kb", "100 kb", "10 kb"] as const;

  it("uses modified wheel-up for a finer level and wheel-down for a coarser level", () => {
    expect(contactResolutionWheelIntent({
      deltaX: 0,
      deltaY: -24,
      ctrlKey: false,
      metaKey: true,
      currentResolution: "500 kb",
      resolutionOptions,
    })).toBe("100 kb");
    expect(contactResolutionWheelIntent({
      deltaX: 0,
      deltaY: 24,
      ctrlKey: true,
      metaKey: false,
      currentResolution: "500 kb",
      resolutionOptions,
    })).toBe("1 Mb");
  });

  it("ignores unmodified, empty, unavailable, and boundary wheel input", () => {
    expect(contactResolutionWheelIntent({
      deltaX: 0,
      deltaY: -24,
      ctrlKey: false,
      metaKey: false,
      currentResolution: "500 kb",
      resolutionOptions,
    })).toBeNull();
    expect(contactResolutionWheelIntent({
      deltaX: 0,
      deltaY: 0,
      ctrlKey: true,
      metaKey: false,
      currentResolution: "500 kb",
      resolutionOptions,
    })).toBeNull();
    expect(contactResolutionWheelIntent({
      deltaX: 0,
      deltaY: -24,
      ctrlKey: true,
      metaKey: false,
      currentResolution: "250 kb",
      resolutionOptions,
    })).toBeNull();
    expect(contactResolutionWheelIntent({
      deltaX: 0,
      deltaY: -24,
      ctrlKey: true,
      metaKey: false,
      currentResolution: "10 kb",
      resolutionOptions,
    })).toBeNull();
  });
});

describe("lockedContactResolutionWheelZoomIntent", () => {
  it("turns a modified wheel into pointer-anchored viewport zoom without a resolution action", () => {
    expect(lockedContactResolutionWheelZoomIntent(
      0,
      -100,
      300,
      75,
      { left: 100, top: 25, width: 400, height: 200 },
      500,
    )).toEqual({
      type: "zoomContactViewport",
      direction: "in",
      focusRatioX: 0.5,
      focusRatioY: 0.25,
      scaleFactor: Math.exp(0.2),
      totalSpanMb: 500,
    });
  });

  it("ignores a zero wheel gesture", () => {
    expect(lockedContactResolutionWheelZoomIntent(
      0, 0, 0, 0, { left: 0, top: 0, width: 100, height: 100 }, 500,
    )).toBeNull();
  });
});

describe("contactWheelPanIntent", () => {
  it("gives Command/Ctrl-Shift wheel priority over modified resolution changes", () => {
    expect(contactWheelNavigationMode({
      ctrlKey: false,
      metaKey: true,
      shiftKey: false,
    })).toBe("resolution");
    expect(contactWheelNavigationMode({
      ctrlKey: false,
      metaKey: true,
      shiftKey: true,
    })).toBe("pan");
    expect(contactWheelNavigationMode({
      ctrlKey: true,
      metaKey: false,
      shiftKey: true,
    })).toBe("pan");
  });

  it("maps trackpad movement independently across both genomic axes", () => {
    expect(contactWheelPanIntent({
      deltaX: 40,
      deltaY: 20,
      deltaMode: 0,
      shiftKey: false,
      bounds,
      viewport,
    })).toEqual({
      deltaXPx: 40,
      deltaYPx: 20,
      deltaXMb: 20,
      deltaYMb: 10,
    });

    expect(contactWheelPanIntent({
      deltaX: -80,
      deltaY: 0,
      deltaMode: 0,
      shiftKey: false,
      bounds,
      viewport,
    })).toMatchObject({ deltaXMb: -40, deltaYMb: 0 });
  });

  it("uses Shift-wheel for horizontal movement and normalizes line/page delta modes", () => {
    expect(contactWheelPanIntent({
      deltaX: 0,
      deltaY: 25,
      deltaMode: 0,
      shiftKey: true,
      bounds,
      viewport,
    })).toEqual({ deltaXPx: 25, deltaYPx: 0, deltaXMb: 12.5, deltaYMb: 0 });

    expect(contactWheelPanIntent({
      deltaX: 1,
      deltaY: -2,
      deltaMode: 1,
      shiftKey: false,
      bounds,
      viewport,
    })).toEqual({ deltaXPx: 16, deltaYPx: -32, deltaXMb: 8, deltaYMb: -16 });

    expect(contactWheelPanIntent({
      deltaX: 1,
      deltaY: -0.5,
      deltaMode: 2,
      shiftKey: false,
      bounds,
      viewport,
    })).toEqual({ deltaXPx: 400, deltaYPx: -100, deltaXMb: 200, deltaYMb: -50 });
  });

  it("uses Command/Ctrl-Shift-wheel for 45-degree diagonal movement", () => {
    expect(contactWheelPanIntent({
      deltaX: 0,
      deltaY: 25,
      deltaMode: 0,
      shiftKey: true,
      diagonalKey: true,
      bounds,
      viewport,
    })).toEqual({
      deltaXPx: 25,
      deltaYPx: 25,
      deltaXMb: 12.5,
      deltaYMb: 12.5,
    });

    expect(contactWheelPanIntent({
      deltaX: -30,
      deltaY: 8,
      deltaMode: 0,
      shiftKey: true,
      diagonalKey: true,
      bounds,
      viewport,
    })).toMatchObject({ deltaXPx: -30, deltaYPx: -30 });
  });

  it("ignores empty, invalid, or dimensionless wheel input", () => {
    expect(contactWheelPanIntent({
      deltaX: 0,
      deltaY: 0,
      deltaMode: 0,
      shiftKey: false,
      bounds,
      viewport,
    })).toBeNull();
    expect(contactWheelPanIntent({
      deltaX: Number.NaN,
      deltaY: Number.NaN,
      deltaMode: 0,
      shiftKey: false,
      bounds,
      viewport,
    })).toBeNull();
    expect(contactWheelPanIntent({
      deltaX: 10,
      deltaY: 10,
      deltaMode: 0,
      shiftKey: false,
      bounds: { width: 0, height: 200 },
      viewport,
    })).toBeNull();
  });
});

describe("contactTileOverscanDirectionForViewports", () => {
  it("tracks the genomic direction independently on both pan axes", () => {
    expect(contactTileOverscanDirectionForViewports(viewport, {
      xStart: 60_000_000,
      xEnd: 260_000_000,
      yStart: 65_000_000,
      yEnd: 165_000_000,
    })).toEqual({ x: 1, y: -1 });

    expect(contactTileOverscanDirectionForViewports(viewport, viewport)).toEqual({ x: 0, y: 0 });
  });
});

describe("historyPreviewBoxes", () => {
  it("projects affected before and after contigs into the visible heatmap", () => {
    const beforeBlock = {
      id: "Chr01:1:ctg1",
      objectId: "Chr01",
      sourceId: "ctg1",
      sourceStart: 0,
      sourceEnd: 100,
      visualStart: 100,
      visualEnd: 200,
      orientation: "+" as const,
    };
    const afterBlock = {
      ...beforeBlock,
      visualStart: 500,
      visualEnd: 600,
      orientation: "-" as const,
    };
    const boxes = historyPreviewBoxes({
      id: 1,
      type: "move",
      label: "Selection moved",
      position: { x: 0, y: 0 },
      beforeAssembly: { blocks: [beforeBlock], selection: null },
      afterAssembly: { blocks: [afterBlock], selection: null },
      impact: {
        blockIds: [beforeBlock.id],
        sourceIds: ["ctg1"],
        chromosomeIds: ["Chr01"],
        selection: null,
      },
    }, {
      xStart: 0,
      xEnd: 1_000,
      yStart: 0,
      yEnd: 1_000,
    });

    expect(boxes).toEqual([
      expect.objectContaining({ phase: "before", leftPercent: 10, topPercent: 10, orientation: "+" }),
      expect.objectContaining({ phase: "after", leftPercent: 50, topPercent: 50, orientation: "-" }),
    ]);
  });
});

describe("contactViewportSizePxFromBounds", () => {
  it("reports the shortest visible side for square viewport resolution decisions", () => {
    expect(contactViewportSizePxFromBounds({ width: 536, height: 640 })).toBe(536);
    expect(contactViewportSizePxFromBounds({ width: 1200, height: 700 })).toBe(700);
    expect(contactViewportSizePxFromBounds({ width: 700, height: 1200 })).toBe(700);
    expect(contactViewportSizePxFromBounds({ width: 0, height: 640 })).toBeNull();
    expect(contactViewportSizePxFromBounds({ width: Number.NaN, height: 640 })).toBeNull();
  });
});

describe("contactViewportForAxisNavigator", () => {
  it("moves only the X viewport during a live navigator preview and clamps at the genome edge", () => {
    expect(contactViewportForAxisNavigator({
      axis: "x",
      centerRatio: 0.95,
      totalSpanMb: 400,
      viewportSpanMb: 100,
      viewportWidthPx: 500,
      viewportHeightPx: 500,
      centerXMb: 125,
      centerYMb: 275,
    })).toEqual({
      xStart: 300_000_000,
      xEnd: 400_000_000,
      yStart: 225_000_000,
      yEnd: 325_000_000,
    });
  });

  it("moves only the Y viewport during a live navigator preview and clamps invalid input", () => {
    expect(contactViewportForAxisNavigator({
      axis: "y",
      centerRatio: -0.25,
      totalSpanMb: 400,
      viewportSpanMb: 100,
      viewportWidthPx: 500,
      viewportHeightPx: 500,
      centerXMb: 125,
      centerYMb: 275,
    })).toEqual({
      xStart: 75_000_000,
      xEnd: 175_000_000,
      yStart: 0,
      yEnd: 100_000_000,
    });

    expect(contactViewportForAxisNavigator({
      axis: "x",
      centerRatio: Number.NaN,
      totalSpanMb: 200,
      viewportSpanMb: Number.NaN,
      viewportWidthPx: 500,
      viewportHeightPx: 500,
      centerXMb: Number.NaN,
      centerYMb: Number.NaN,
    })).toEqual({
      xStart: 0,
      xEnd: 200_000_000,
      yStart: 0,
      yEnd: 200_000_000,
    });
  });
});

describe("contactCanvasBackingSizeFromBounds", () => {
  it("resizes rectangular heatmaps on both axes independently", () => {
    expect(contactCanvasBackingSizeFromBounds({ width: 800, height: 520 }, 1)).toEqual({
      width: 2400,
      height: 1560,
    });
    expect(contactCanvasBackingSizeFromBounds({ width: 520, height: 800 }, 1)).toEqual({
      width: 1560,
      height: 2400,
    });
  });

  it("caps density and backing dimensions while rejecting empty bounds", () => {
    expect(contactCanvasBackingSizeFromBounds({ width: 400, height: 200 }, 3)).toEqual({
      width: 1800,
      height: 900,
    });
    expect(contactCanvasBackingSizeFromBounds({ width: 3000, height: 3000 }, 2)).toEqual({
      width: 4095,
      height: 4095,
    });
    expect(contactCanvasBackingSizeFromBounds({ width: 0, height: 200 }, 1)).toBeNull();
  });
});

describe("assemblyShiftClickIntent", () => {
  it("replaces selection on Shift-click and reserves multi-select for dragging", () => {
    expect(assemblyShiftClickIntent(true, { kind: "contig", id: "ctg2" })).toEqual({
      type: "select-contig",
      id: "ctg2",
      additive: false,
    });
    expect(assemblyShiftClickIntent(true, { kind: "chromosome-boundary", id: "Chr02" })).toEqual({
      type: "select-chromosome",
      id: "Chr02",
    });
    expect(assemblyShiftClickIntent(true, { kind: "contig", id: "ctg2" }, true)).toEqual({
      type: "select-contig",
      id: "ctg2",
      additive: false,
    });
  });

  it("selects a hit only when there is no current selection", () => {
    expect(assemblyShiftClickIntent(false, { kind: "contig", id: "ctg2" })).toEqual({
      type: "select-contig",
      id: "ctg2",
      additive: false,
    });
    expect(assemblyShiftClickIntent(false, { kind: "chromosome-boundary", id: "Chr02" })).toEqual({
      type: "select-chromosome",
      id: "Chr02",
    });
    expect(assemblyShiftClickIntent(false, null)).toEqual({ type: "clear-selection" });
  });
});

describe("assemblyCutTargetAtScreenPoint", () => {
  const compactContig = {
    id: "Chr01:1:ctg1",
    objectId: "Chr01",
    sourceId: "ctg1",
    sourceStart: 0,
    sourceEnd: 16,
    visualStart: 10,
    visualEnd: 26,
    orientation: "+" as const,
  };

  it("keeps the cut affordance reachable for a selected compact contig", () => {
    expect(assemblyCutTargetAtScreenPoint({
      model: buildAssemblyEditModel([compactContig]),
      selectedIds: new Set([compactContig.id]),
      point: { x: 18, y: 18 },
      widthPx: 100,
      heightPx: 100,
      viewportXStart: 0,
      viewportXEnd: 100,
      viewportYStart: 0,
      viewportYEnd: 100,
    })).toEqual({ blockId: compactContig.id, visualPosition: 18 });
  });

  it("does not expose the cut affordance outside the diagonal or for an unselected contig", () => {
    const model = buildAssemblyEditModel([compactContig]);
    const input = {
      model,
      selectedIds: new Set([compactContig.id]),
      widthPx: 100,
      heightPx: 100,
      viewportXStart: 0,
      viewportXEnd: 100,
      viewportYStart: 0,
      viewportYEnd: 100,
    };

    expect(assemblyCutTargetAtScreenPoint({ ...input, point: { x: 12, y: 23 } })).toBeNull();
    expect(assemblyCutTargetAtScreenPoint({
      ...input,
      selectedIds: new Set(),
      point: { x: 18, y: 18 },
    })).toBeNull();
  });
});

describe("assembly overlay hierarchy", () => {
  it("renders atomic block boxes, child outlines only for composites, and a direct singleton", () => {
    const uiState = createInitialUiState("ready");
    uiState.assembly.blocks = [
      {
        id: "Chr01:1:ctg1",
        objectId: "Chr01",
        sourceId: "ctg1",
        sourceStart: 0,
        sourceEnd: 100,
        visualStart: 0,
        visualEnd: 100,
        orientation: "+",
        assemblyBlockId: "Chr01_block_1",
      },
      {
        id: "Chr01:2:ctg2",
        objectId: "Chr01",
        sourceId: "ctg2",
        sourceStart: 0,
        sourceEnd: 100,
        visualStart: 100,
        visualEnd: 200,
        orientation: "+",
        assemblyBlockId: "Chr01_block_1",
      },
      {
        id: "Chr01:4:ctg3",
        objectId: "Chr01",
        sourceId: "ctg3",
        sourceStart: 0,
        sourceEnd: 100,
        visualStart: 300,
        visualEnd: 400,
        orientation: "-",
        gapBefore: {
          componentType: "U",
          length: 100,
          gapType: "contig",
          linkage: "yes",
          linkageEvidence: "map",
        },
      },
    ];
    const dataset: ExampleDatasetSummary = {
      agp_path: "assembly.agp",
      mcool_path: "",
      cool_path: "",
      paf_path: null,
      coverage_path: null,
      agp_lines: 4,
      agp_objects: 1,
      agp_components: 3,
      agp_gaps: 1,
      max_object_span: 400,
      mcool_size_bytes: 0,
      agp_layout: { blocks: uiState.assembly.blocks, totalSpan: 400 },
    };
    uiState.assembly.selection = {
      kind: "contigs",
      ids: ["Chr01:1:ctg1", "Chr01:2:ctg2"],
      exact: true,
    };

    const markup = renderToStaticMarkup(
      createElement(ContactMapViewport, {
        dataset,
        contactMap: null,
        coverageView: null,
        uiState,
        onUiAction: () => undefined,
      }),
    );

    expect(markup.match(/composite-block-box/g)).toHaveLength(1);
    expect(markup.match(/singleton-contig-box/g)).toHaveLength(1);
    expect(markup.match(/contig-child-box/g)).toHaveLength(2);
    expect(markup).toContain('data-block-id="Chr01_block_1"');
    expect(markup).toContain('title="Chr01_block_1 · 2 contigs"');
    expect(markup).not.toContain('data-contig-id="Chr01:4:ctg3"');
    expect(markup.match(/assembly-selection-axis-band vertical/g)).toHaveLength(1);
    expect(markup.match(/assembly-selection-axis-band horizontal/g)).toHaveLength(1);
    expect(markup).toMatch(
      /class="assembly-selection-axis-band horizontal"[^>]*><\/span><div class="assembly-overlay-layer"/,
    );

    uiState.assembly.showBlockBoxes = false;
    const contigOnlyMarkup = renderToStaticMarkup(
      createElement(ContactMapViewport, {
        dataset,
        contactMap: null,
        coverageView: null,
        uiState,
        onUiAction: () => undefined,
      }),
    );

    expect(contigOnlyMarkup).not.toContain("composite-block-box");
    expect(contigOnlyMarkup.match(/singleton-contig-box/g)).toHaveLength(1);
    expect(contigOnlyMarkup.match(/contig-child-box/g)).toHaveLength(2);
  });
});
