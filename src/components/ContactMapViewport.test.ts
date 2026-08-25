import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ExampleDatasetSummary } from "../App";
import type { ContactGpuResidentPrefetchBatch } from "../state/contactPanPrefetch";
import { createInitialUiState } from "../state/uiState";
import {
  advanceContactCoveragePresentationFrame,
  advanceContactBoundaryMountViewport,
  advancePaintedContactPresentationFrame,
  assemblyCutTargetAtScreenPoint,
  assemblyPointerStateAtScreenPoint,
  assemblyBoundaryViewportClipClassName,
  assemblySelectionProjectionBands,
  assemblySelectionControlsVisible,
  assemblyShiftClickIntent,
  ContactMapViewport,
  contactBoundaryMountInterval,
  contactGpuAssemblyBoundaries,
  contactCoverageFramesMatch,
  contactPanCommitAction,
  contactPanPrefetchChannel,
  contactPanPreviewTileSignature,
  contactPanTransformOffsets,
  contactVisibleInteractionViewport,
  contactWheelPanSessionCameras,
  presentContactPanPrefetchBatches,
  contactCanvasBackingSizeFromBounds,
  committedPanTargetIsPainted,
  contactResolutionWheelIntent,
  lockedContactResolutionWheelZoomIntent,
  contactViewportForAxisNavigator,
  contactViewportSizePxFromBounds,
  contactTileOverscanDirectionForViewports,
  contactWheelNavigationMode,
  contactWheelPanCommitDelta,
  contactWheelPanMode,
  contactWheelPanIntent,
  historyPreviewBoxes,
  ingestContactGpuResidentPrefetchBatch,
  limitAssemblyOverlayIntervals,
  maximumAssemblyOverlayIntervals,
  sameAssemblyOverlayPresentation,
  shouldRetainPresentedContactViewport,
} from "./ContactMapViewport";
import {
  buildAssemblyEditModel,
  buildAssemblyInteractionIndex,
} from "../state/assemblyEditing";

const bounds = {
  width: 400,
  height: 200,
};

describe("pan-prefetch GPU presentation", () => {
  it("uploads every completed batch before presenting once", () => {
    const events: string[] = [];
    const renderer = {
      appendSceneDescriptors: (input: { generation: number }) => {
        events.push(`append:${input.generation}`);
        return true;
      },
      presentAppendedSceneDescriptors: () => {
        events.push("present");
        return true;
      },
    };
    const viewport = { xStart: 0, xEnd: 4_000, yStart: 0, yEnd: 4_000 };
    const tile = { tileX: 0, tileY: 0, cells: [] };

    expect(presentContactPanPrefetchBatches(renderer, [
      { tiles: [tile], generation: 7, resolution: 1_000, tileSizeBins: 4, viewport },
      { tiles: [tile], generation: 8, resolution: 1_000, tileSizeBins: 4, viewport },
    ])).toBe(true);
    expect(events).toEqual(["append:7", "append:8", "present"]);
  });

  it("forwards adjacent-resolution pages without creating descriptors or presenting", () => {
    const events: string[] = [];
    const batch: ContactGpuResidentPrefetchBatch = {
      tiles: [{ tileX: 0, tileY: 0, cells: [] }],
      dataScope: "neighbor-layout|raw",
      generation: 7,
      resolution: 2_000,
      tileSizeBins: 4,
    };
    const renderer = {
      ingestPrefetchedPages: (input: ContactGpuResidentPrefetchBatch) => {
        events.push(`${input.dataScope}:${input.resolution}`);
        return true;
      },
    };

    expect(ingestContactGpuResidentPrefetchBatch(renderer, batch)).toBe(true);
    expect(events).toEqual(["neighbor-layout|raw:2000"]);
  });
});

describe("assembly overlay screen-space LOD", () => {
  it("drops subpixel whole-genome intervals while preserving selected context", () => {
    const intervals = Array.from({ length: 17_206 }, (_, index) => ({
      id: `block-${index}`,
      visualStart: index,
      visualEnd: index + 1,
    }));
    const selected = new Set(["block-17", "block-9000"]);

    const visible = limitAssemblyOverlayIntervals(
      intervals,
      0,
      intervals.length,
      1_200,
      selected,
    );

    expect(visible.map((interval) => interval.id)).toEqual(["block-17", "block-9000"]);
  });

  it("enforces the viewport-pixel and global hard limits even for priority intervals", () => {
    const intervals = Array.from({ length: 10_000 }, (_, index) => ({
      id: `block-${index}`,
      visualStart: index,
      visualEnd: index + 1,
    }));
    const allPriority = new Set(intervals.map((interval) => interval.id));

    expect(limitAssemblyOverlayIntervals(
      intervals,
      0,
      intervals.length,
      1_200,
      allPriority,
    )).toHaveLength(1_200);
    expect(limitAssemblyOverlayIntervals(
      intervals,
      0,
      intervals.length,
      100_000,
      allPriority,
    )).toHaveLength(maximumAssemblyOverlayIntervals);
  });
});

describe("GPU assembly boundary scene", () => {
  const model = buildAssemblyEditModel([{
    id: "Chr01:1:singleton",
    objectId: "Chr01",
    sourceId: "singleton",
    sourceStart: 0,
    sourceEnd: 100,
    visualStart: 0,
    visualEnd: 100,
    orientation: "+" as const,
  }, {
    id: "Chr01:2:left",
    objectId: "Chr01",
    sourceId: "left",
    sourceStart: 0,
    sourceEnd: 100,
    visualStart: 100,
    visualEnd: 200,
    orientation: "+" as const,
    assemblyBlockId: "Chr01_block_1",
  }, {
    id: "Chr01:3:right",
    objectId: "Chr01",
    sourceId: "right",
    sourceStart: 0,
    sourceEnd: 100,
    visualStart: 200,
    visualEnd: 300,
    orientation: "+" as const,
    assemblyBlockId: "Chr01_block_1",
  }]);

  it("builds chromosome, block, and nested-contig outlines in immutable world coordinates", () => {
    const boundaries = contactGpuAssemblyBoundaries({
      model,
      selection: { kind: "contigs", ids: ["Chr01:2:left"] },
      showChromosomeBoxes: true,
      showBlockBoxes: true,
      showContigBoxes: true,
    });

    expect(boundaries).toHaveLength(5);
    expect(boundaries[0]).toMatchObject({ visualStart: 0, visualEnd: 300 });
    expect(boundaries[2]).toMatchObject({ color: [0, 0, 0], lineWidthCssPx: 2 });
    expect(boundaries.slice(3).map(({ visualStart, visualEnd }) => [visualStart, visualEnd]))
      .toEqual([[100, 200], [200, 300]]);
  });

  it("preserves the existing singleton and composite visibility semantics", () => {
    const boundaries = contactGpuAssemblyBoundaries({
      model,
      selection: null,
      showChromosomeBoxes: false,
      showBlockBoxes: false,
      showContigBoxes: true,
    });

    expect(boundaries.map(({ visualStart, visualEnd }) => [visualStart, visualEnd]))
      .toEqual([[0, 100], [100, 200], [200, 300]]);
  });
});
const viewport = {
  xStart: 50_000_000,
  xEnd: 250_000_000,
  yStart: 75_000_000,
  yEnd: 175_000_000,
};

describe("advanceContactBoundaryMountViewport", () => {
  it("keeps the mounted window stable for small pointer samples", () => {
    const current = { xStart: 100, xEnd: 300, yStart: 200, yEnd: 400 };

    expect(advanceContactBoundaryMountViewport(current, {
      xStart: 180,
      xEnd: 380,
      yStart: 120,
      yEnd: 320,
    })).toBe(current);
  });

  it("recenters before a directional preview consumes the full overscan", () => {
    const current = { xStart: 100, xEnd: 300, yStart: 200, yEnd: 400 };
    const candidate = { xStart: 240, xEnd: 440, yStart: 200, yEnd: 400 };

    expect(advanceContactBoundaryMountViewport(current, candidate)).toBe(candidate);
    expect(advanceContactBoundaryMountViewport(null, candidate)).toBe(candidate);
  });

  it("keeps one shared overscan interval mounted on both map axes", () => {
    expect(contactBoundaryMountInterval({
      xStart: 100,
      xEnd: 300,
      yStart: 200,
      yEnd: 400,
    })).toEqual({ start: 0, end: 500 });
  });
});

describe("sameAssemblyOverlayPresentation", () => {
  it("keeps boundaries mounted across unrelated parent and contact-tile refreshes", () => {
    const model = {};
    const visibleBlocks: unknown[] = [];
    const visibleContigs: unknown[] = [];
    const visibleChromosomes: unknown[] = [];
    const pointerState = { kind: "select" };
    const base = {
      model,
      boundaryMountViewport: { xStart: 0, xEnd: 100, yStart: 0, yEnd: 100 },
      viewportXStart: 0,
      viewportXEnd: 100,
      viewportYStart: 0,
      viewportYEnd: 100,
      viewportWidthPx: 100,
      viewportHeightPx: 100,
      selection: null,
      showChromosomeBoxes: true,
      showBlockBoxes: true,
      showContigBoxes: true,
      visibleBlocks,
      visibleContigs,
      visibleChromosomes,
      selectionBox: null,
      pointerState,
      placementPreview: null,
      onPointerMove: () => undefined,
    } as unknown as Parameters<typeof sameAssemblyOverlayPresentation>[0];

    expect(sameAssemblyOverlayPresentation(base, {
      ...base,
      onPointerMove: () => undefined,
    })).toBe(true);
    expect(sameAssemblyOverlayPresentation(base, {
      ...base,
      viewportXEnd: 200,
    })).toBe(false);
    expect(sameAssemblyOverlayPresentation(base, {
      ...base,
      visibleContigs: [],
    })).toBe(false);
    expect(sameAssemblyOverlayPresentation(base, {
      ...base,
      viewportWidthPx: 200,
    })).toBe(false);
    expect(sameAssemblyOverlayPresentation(base, {
      ...base,
      placementPreview: {
        id: "placement-preview",
        targetObjectId: "Chr02",
        targetBlockId: "block-2",
        visualPosition: 50,
        chromosomeEnd: null,
        leftBlockId: "block-1",
        rightBlockId: "block-2",
        isCurrentBoundary: false,
        orientation: "+",
        isCurrent: false,
      },
    })).toBe(false);
  });
});

describe("assemblySelectionControlsVisible", () => {
  const viewport = { xStart: 0, xEnd: 100, yStart: 0, yEnd: 100 };

  it("shows controls only when the visible selection reaches 32 px on both axes", () => {
    expect(assemblySelectionControlsVisible(20, 60, viewport, 100, 100)).toBe(true);
    expect(assemblySelectionControlsVisible(20, 60, viewport, 79, 100)).toBe(false);
    expect(assemblySelectionControlsVisible(20, 60, viewport, 100, 79)).toBe(false);
  });

  it("uses the clipped on-screen interval instead of the full selection span", () => {
    expect(assemblySelectionControlsVisible(-100, 40, viewport, 100, 100)).toBe(true);
    expect(assemblySelectionControlsVisible(-100, 30, viewport, 100, 100)).toBe(false);
  });
});

describe("assemblyBoundaryViewportClipClassName", () => {
  it("suppresses viewport crop edges while preserving real chromosome endpoints", () => {
    expect(assemblyBoundaryViewportClipClassName(100, 300, 150, 250, 120, 280)).toBe(
      "viewport-clipped-left viewport-clipped-right viewport-clipped-top viewport-clipped-bottom",
    );
    expect(assemblyBoundaryViewportClipClassName(100, 300, 100, 300, 100, 300)).toBe("");
    expect(assemblyBoundaryViewportClipClassName(100, 300, 50, 250, 50, 350)).toBe(
      "viewport-clipped-right",
    );
  });
});

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

  it("keeps both axis bands mounted when one projection is currently offscreen", () => {
    expect(assemblySelectionProjectionBands(100, 200, {
      xStart: 0,
      xEnd: 400,
      yStart: 300,
      yEnd: 500,
    })).toEqual({
      vertical: { left: "25%", width: "25%" },
      horizontal: { top: "-100%", height: "50%" },
    });
  });

  it("preserves the full band geometry instead of resizing it at a viewport edge", () => {
    expect(assemblySelectionProjectionBands(-50, 50, {
      xStart: 0,
      xEnd: 200,
      yStart: -100,
      yEnd: 100,
    })).toEqual({
      vertical: { left: "-25%", width: "50%" },
      horizontal: { top: "25%", height: "50%" },
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

describe("shouldRetainPresentedContactViewport", () => {
  it("holds the painted 1 kb camera while a 2.5 Mb whole-genome layer is pending", () => {
    expect(shouldRetainPresentedContactViewport({
      resolution: 1_000,
      normalization: "raw",
    }, 2_500_000, "raw")).toBe(true);
  });

  it("publishes a terminal screen LOD even when it is coarser than the selected level", () => {
    expect(shouldRetainPresentedContactViewport({
      resolution: 17_500_000,
      requestedResolution: 2_500_000,
      normalization: "raw",
      isTransientResolutionPreview: false,
    }, 2_500_000, "raw")).toBe(false);
  });

  it("holds an old whole-genome LOD while its 1 kb replacement is loading", () => {
    expect(shouldRetainPresentedContactViewport({
      resolution: 17_500_000,
      requestedResolution: 2_500_000,
      normalization: "raw",
      isTransientResolutionPreview: false,
    }, 1_000, "raw")).toBe(true);
  });

  it("holds the painted camera while a same-resolution pan target is loading", () => {
    expect(shouldRetainPresentedContactViewport({
      resolution: 100_000,
      normalization: "raw",
      viewport: {
        xStart: 0,
        xEnd: 10_000_000,
        yStart: 0,
        yEnd: 10_000_000,
      },
    }, 100_000, "raw", {
      xStart: 2_000_000,
      xEnd: 12_000_000,
      yStart: 3_000_000,
      yEnd: 13_000_000,
    })).toBe(true);
  });

  it("releases the painted camera after the pan target catches up", () => {
    const viewport = {
      xStart: 2_000_000,
      xEnd: 12_000_000,
      yStart: 3_000_000,
      yEnd: 13_000_000,
    };
    expect(shouldRetainPresentedContactViewport({
      resolution: 100_000,
      normalization: "raw",
      viewport,
    }, 100_000, "raw", viewport)).toBe(false);
  });
});

describe("committed pan front-surface handoff", () => {
  const committedViewport = {
    xStart: 2_000_000,
    xEnd: 12_000_000,
    yStart: 3_000_000,
    yEnd: 13_000_000,
  };

  it("ignores a late paint callback from the old viewport", () => {
    expect(committedPanTargetIsPainted(committedViewport, {
      renderGeneration: 7,
      viewport: {
        xStart: 0,
        xEnd: 10_000_000,
        yStart: 0,
        yEnd: 10_000_000,
      },
    }, 7)).toBe(false);
  });

  it("releases only after the matching committed viewport generation paints", () => {
    expect(committedPanTargetIsPainted(committedViewport, {
      renderGeneration: 8,
      viewport: committedViewport,
    }, 8)).toBe(true);
    expect(committedPanTargetIsPainted(committedViewport, {
      renderGeneration: 8,
      viewport: committedViewport,
    }, 7)).toBe(false);
  });
});

describe("fast consecutive pan camera", () => {
  it("keeps the accumulated transform relative to the still-rendered source camera", () => {
    const renderedViewport = { xStart: 0, xEnd: 100, yStart: 0, yEnd: 100 };
    const previousCommittedViewport = { xStart: 10, xEnd: 110, yStart: 20, yEnd: 120 };
    const nextPreviewViewport = { xStart: 20, xEnd: 120, yStart: 30, yEnd: 130 };

    expect(contactPanTransformOffsets(
      renderedViewport,
      nextPreviewViewport,
      1_000,
      500,
    )).toEqual({ offsetX: -200, offsetY: -150 });
    expect(contactPanTransformOffsets(
      previousCommittedViewport,
      nextPreviewViewport,
      1_000,
      500,
    )).toEqual({ offsetX: -100, offsetY: -50 });
  });

  it("hit-tests against the camera currently visible during frame handoff", () => {
    const displayViewport = { xStart: 0, xEnd: 100, yStart: 0, yEnd: 100 };
    const pendingCommittedViewport = { xStart: 20, xEnd: 120, yStart: 30, yEnd: 130 };
    const activePreviewViewport = { xStart: 40, xEnd: 140, yStart: 50, yEnd: 150 };

    expect(contactVisibleInteractionViewport(
      displayViewport,
      pendingCommittedViewport,
    )).toBe(pendingCommittedViewport);
    expect(contactVisibleInteractionViewport(
      displayViewport,
      pendingCommittedViewport,
      activePreviewViewport,
    )).toBe(activePreviewViewport);
    expect(contactVisibleInteractionViewport(displayViewport, null)).toBe(displayViewport);
  });

  it("accumulates a new wheel burst from the retained presentation camera", () => {
    const retainedDisplayViewport = { xStart: 0, xEnd: 100, yStart: 0, yEnd: 100 };
    const liveViewport = { xStart: 10, xEnd: 110, yStart: 20, yEnd: 120 };
    const pendingCommittedViewport = { xStart: 15, xEnd: 115, yStart: 25, yEnd: 125 };

    expect(contactWheelPanSessionCameras(
      retainedDisplayViewport,
      liveViewport,
      pendingCommittedViewport,
    )).toEqual({
      startViewport: pendingCommittedViewport,
      transformSourceViewport: retainedDisplayViewport,
    });
  });
});

describe("contact and coverage presentation frames", () => {
  it("accepts a coarse rectangular frame whose X camera extends beyond the assembly", () => {
    const contactMap = {
      resolution: 1_000_000,
      requestedResolution: 1_000_000,
      viewport: {
        xStart: 0,
        xEnd: 631_655_199,
        yStart: 0,
        yEnd: 473_741_399,
      },
      cells: [],
      visibleLayerComplete: true,
      renderGeneration: 9,
    };
    const matchingCoverage = {
      resolution: 1_000_000,
      viewport: { xStart: 0, xEnd: 631_655_199, yStart: 0, yEnd: 1 },
      bins: [],
      renderGeneration: 9,
    };
    const assemblyClampedCoverage = {
      ...matchingCoverage,
      viewport: { xStart: 0, xEnd: 473_741_399, yStart: 0, yEnd: 1 },
    };

    expect(contactCoverageFramesMatch(contactMap, matchingCoverage)).toBe(true);
    expect(contactCoverageFramesMatch(contactMap, assemblyClampedCoverage)).toBe(false);
  });

  it("keeps the old 1 Mb pair until the 1 kb heatmap and coverage share one generation", () => {
    const oldViewport = { xStart: 0, xEnd: 473_741_399, yStart: 0, yEnd: 473_741_399 };
    const fineViewport = { xStart: 236_550_000, xEnd: 237_190_000, yStart: 236_550_000, yEnd: 237_190_000 };
    const oldContactMap = {
      resolution: 1_000_000,
      requestedResolution: 1_000_000,
      viewport: oldViewport,
      cells: [],
      visibleLayerComplete: true,
      renderGeneration: 7,
    };
    const oldCoverageView = {
      resolution: 1_000_000,
      viewport: { ...oldViewport, yStart: 0, yEnd: 1 },
      bins: [],
      renderGeneration: 7,
    };
    const fineCoverageView = {
      resolution: 1_000,
      viewport: { ...fineViewport, yStart: 0, yEnd: 1 },
      bins: [],
      renderGeneration: 8,
    };
    const fineContactMap = {
      resolution: 1_000,
      requestedResolution: 1_000,
      viewport: fineViewport,
      cells: [],
      visibleLayerComplete: true,
      renderGeneration: 8,
    };

    let frame = advanceContactCoveragePresentationFrame(
      null,
      "example",
      oldContactMap,
      oldCoverageView,
    );
    expect(frame?.contactMap).toBe(oldContactMap);
    expect(contactCoverageFramesMatch(oldContactMap, fineCoverageView)).toBe(false);

    frame = advanceContactCoveragePresentationFrame(
      frame,
      "example",
      oldContactMap,
      fineCoverageView,
    );
    expect(frame?.contactMap).toBe(oldContactMap);
    expect(frame?.coverageView).toBe(oldCoverageView);

    frame = advanceContactCoveragePresentationFrame(
      frame,
      "example",
      fineContactMap,
      fineCoverageView,
    );
    expect(frame?.contactMap).toBe(fineContactMap);
    expect(frame?.coverageView).toBe(fineCoverageView);
  });

  it("keeps old borders and coverage until the matching heatmap buffer is painted", () => {
    const oldContactMap = {
      resolution: 1_000,
      requestedResolution: 1_000,
      viewport: { xStart: 100, xEnd: 200, yStart: 100, yEnd: 200 },
      cells: [],
      visibleLayerComplete: true,
      renderGeneration: 20,
    };
    const coarseContactMap = {
      resolution: 1_000_000,
      requestedResolution: 1_000_000,
      viewport: { xStart: 0, xEnd: 1_000, yStart: 0, yEnd: 1_000 },
      cells: [],
      visibleLayerComplete: true,
      renderGeneration: 21,
    };
    const oldCoverage = {
      resolution: 1_000,
      viewport: oldContactMap.viewport,
      bins: [],
      renderGeneration: 20,
    };
    const coarseCoverage = {
      resolution: 1_000_000,
      viewport: coarseContactMap.viewport,
      bins: [],
      renderGeneration: 21,
    };
    const oldFrame = {
      datasetKey: "example",
      contactMap: oldContactMap,
      coverageView: oldCoverage,
    };
    const coarseTarget = {
      datasetKey: "example",
      contactMap: coarseContactMap,
      coverageView: coarseCoverage,
    };

    expect(advancePaintedContactPresentationFrame(oldFrame, coarseTarget, 20)).toBe(oldFrame);
    expect(advancePaintedContactPresentationFrame(oldFrame, coarseTarget, undefined)).toBe(oldFrame);
    expect(advancePaintedContactPresentationFrame(oldFrame, coarseTarget, 21)).toBe(coarseTarget);
  });

  it("does not leak an old dataset border while the next dataset heatmap paints", () => {
    const oldFrame = {
      datasetKey: "old",
      contactMap: {
        resolution: 1_000,
        viewport: { xStart: 0, xEnd: 10, yStart: 0, yEnd: 10 },
        cells: [],
        renderGeneration: 1,
      },
      coverageView: null,
    };
    const nextTarget = {
      datasetKey: "next",
      contactMap: {
        resolution: 1_000_000,
        viewport: { xStart: 0, xEnd: 100, yStart: 0, yEnd: 100 },
        cells: [],
        renderGeneration: 2,
      },
      coverageView: null,
    };

    expect(advancePaintedContactPresentationFrame(oldFrame, nextTarget, 1)).toBeNull();
    expect(advancePaintedContactPresentationFrame(oldFrame, nextTarget, 2)).toBe(nextTarget);
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
  it("warms the backend cache instead of superseding React generations during a desktop pan", () => {
    expect(contactPanPrefetchChannel(true, true)).toBe("backend");
    expect(contactPanPrefetchChannel(true, false)).toBe("backend");
    expect(contactPanPrefetchChannel(false, true)).toBe("preview");
    expect(contactPanPrefetchChannel(false, false)).toBeNull();
  });

  it("refreshes a wheel preview when the visible grid crosses after its lead grid", () => {
    const prefetchViewport = {
      xStart: 256_000,
      xEnd: 512_000,
      yStart: 256_000,
      yEnd: 512_000,
    };
    const beforeVisibleBoundary = contactPanPreviewTileSignature(
      { xStart: 10_000, xEnd: 250_000, yStart: 10_000, yEnd: 250_000 },
      prefetchViewport,
      1_000,
      256,
      1_000_000,
    );
    const afterVisibleBoundary = contactPanPreviewTileSignature(
      { xStart: 20_000, xEnd: 270_000, yStart: 20_000, yEnd: 270_000 },
      prefetchViewport,
      1_000,
      256,
      1_000_000,
    );

    expect(afterVisibleBoundary).not.toBe(beforeVisibleBoundary);
  });

  it("starts urgent prefetch immediately without generating on every fast-speed tier", () => {
    const currentViewport = {
      xStart: 10_000,
      xEnd: 250_000,
      yStart: 10_000,
      yEnd: 250_000,
    };
    const prefetchViewport = {
      xStart: 256_000,
      xEnd: 512_000,
      yStart: 256_000,
      yEnd: 512_000,
    };
    const signature = (urgentTiles: number) => contactPanPreviewTileSignature(
      currentViewport,
      prefetchViewport,
      1_000,
      256,
      1_000_000,
      urgentTiles,
    );

    expect(signature(4)).not.toBe(signature(0));
    expect(signature(8)).toBe(signature(4));
  });

  it("commits one cumulative viewport delta after a wheel burst", () => {
    expect(contactWheelPanCommitDelta(
      viewport,
      {
        xStart: viewport.xStart + 25_000_000,
        xEnd: viewport.xEnd + 25_000_000,
        yStart: viewport.yStart + 15_000_000,
        yEnd: viewport.yEnd + 15_000_000,
      },
    )).toEqual({ deltaXMb: 25, deltaYMb: 15 });
    expect(contactWheelPanCommitDelta(viewport, viewport)).toBeNull();
  });

  it("commits the exact already-visible pan viewport instead of reintegrating a delta", () => {
    const previewViewport = {
      xStart: viewport.xStart + 25_000_000,
      xEnd: viewport.xEnd + 25_000_000,
      yStart: viewport.yStart + 15_000_000,
      yEnd: viewport.yEnd + 15_000_000,
    };

    expect(contactPanCommitAction(viewport, previewViewport, 400)).toEqual({
      type: "commitContactViewportPan",
      viewport: previewViewport,
      totalSpanMb: 400,
    });
    expect(contactPanCommitAction(viewport, viewport, 400)).toBeNull();
  });

  it("maps plain wheel to diagonal pan and Command/Ctrl-Shift wheel to vertical pan", () => {
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
    expect(contactWheelPanMode({
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    })).toBe("diagonal");
    expect(contactWheelPanMode({
      ctrlKey: false,
      metaKey: true,
      shiftKey: true,
    })).toBe("vertical");
    expect(contactWheelPanMode({
      ctrlKey: false,
      metaKey: false,
      shiftKey: true,
    })).toBe("horizontal");
  });

  it("can preserve natural trackpad movement for shared non-heatmap consumers", () => {
    expect(contactWheelPanIntent({
      deltaX: 40,
      deltaY: 20,
      deltaMode: 0,
      panMode: "natural",
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
      panMode: "natural",
      bounds,
      viewport,
    })).toMatchObject({ deltaXMb: -40, deltaYMb: 0 });
  });

  it("uses Shift-wheel for horizontal movement and normalizes line/page delta modes", () => {
    expect(contactWheelPanIntent({
      deltaX: 0,
      deltaY: 25,
      deltaMode: 0,
      panMode: "horizontal",
      bounds,
      viewport,
    })).toEqual({ deltaXPx: 25, deltaYPx: 0, deltaXMb: 12.5, deltaYMb: 0 });

    expect(contactWheelPanIntent({
      deltaX: 1,
      deltaY: -2,
      deltaMode: 1,
      panMode: "natural",
      bounds,
      viewport,
    })).toEqual({ deltaXPx: 16, deltaYPx: -32, deltaXMb: 8, deltaYMb: -16 });

    expect(contactWheelPanIntent({
      deltaX: 1,
      deltaY: -0.5,
      deltaMode: 2,
      panMode: "natural",
      bounds,
      viewport,
    })).toEqual({ deltaXPx: 400, deltaYPx: -100, deltaXMb: 200, deltaYMb: -50 });
  });

  it("uses plain wheel for 45-degree diagonal movement", () => {
    expect(contactWheelPanIntent({
      deltaX: 0,
      deltaY: 25,
      deltaMode: 0,
      panMode: "diagonal",
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
      panMode: "diagonal",
      bounds,
      viewport,
    })).toMatchObject({ deltaXPx: -30, deltaYPx: -30 });
  });

  it("uses Command/Ctrl-Shift-wheel for vertical movement only", () => {
    expect(contactWheelPanIntent({
      deltaX: -30,
      deltaY: 8,
      deltaMode: 0,
      panMode: "vertical",
      bounds,
      viewport,
    })).toEqual({
      deltaXPx: 0,
      deltaYPx: -30,
      deltaXMb: 0,
      deltaYMb: -15,
    });
  });

  it("ignores empty, invalid, or dimensionless wheel input", () => {
    expect(contactWheelPanIntent({
      deltaX: 0,
      deltaY: 0,
      deltaMode: 0,
      bounds,
      viewport,
    })).toBeNull();
    expect(contactWheelPanIntent({
      deltaX: Number.NaN,
      deltaY: Number.NaN,
      deltaMode: 0,
      bounds,
      viewport,
    })).toBeNull();
    expect(contactWheelPanIntent({
      deltaX: 10,
      deltaY: 10,
      deltaMode: 0,
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
      binSizeBp: 1,
      point: { x: 23, y: 23 },
      widthPx: 128,
      heightPx: 128,
      viewportXStart: 0,
      viewportXEnd: 100,
      viewportYStart: 0,
      viewportYEnd: 100,
    })).toEqual({ blockId: compactContig.id, visualPosition: 18 });
  });

  it("requires three displayed bins before exposing an interior cut", () => {
    const model = buildAssemblyEditModel([compactContig]);
    const input = {
      model,
      selectedIds: new Set([compactContig.id]),
      point: { x: 90, y: 90 },
      widthPx: 200,
      heightPx: 200,
      viewportXStart: 0,
      viewportXEnd: 40,
      viewportYStart: 0,
      viewportYEnd: 40,
    };

    expect(assemblyCutTargetAtScreenPoint({ ...input, binSizeBp: 10 })).toBeNull();
    expect(assemblyCutTargetAtScreenPoint({ ...input, binSizeBp: 5 })).toEqual({
      blockId: compactContig.id,
      visualPosition: 18,
    });
  });

  it("acquires only a legible interior and uses a smaller release threshold", () => {
    const selectedContig = {
      ...compactContig,
      visualStart: 40,
      visualEnd: 60,
    };
    const model = buildAssemblyEditModel([selectedContig]);
    const input = {
      model,
      selectedIds: new Set([selectedContig.id]),
      binSizeBp: 1,
      heightPx: 72,
      viewportXStart: 0,
      viewportXEnd: 100,
      viewportYStart: 0,
      viewportYEnd: 100,
    };

    expect(assemblyCutTargetAtScreenPoint({
      ...input,
      widthPx: 72,
      point: { x: 36, y: 36 },
    })).toBeNull();
    expect(assemblyCutTargetAtScreenPoint({
      ...input,
      lockedCutBlockId: selectedContig.id,
      widthPx: 72,
      point: { x: 36, y: 36 },
    })).toEqual({ blockId: selectedContig.id, visualPosition: 50 });
    expect(assemblyCutTargetAtScreenPoint({
      ...input,
      lockedCutBlockId: selectedContig.id,
      widthPx: 60,
      heightPx: 60,
      point: { x: 30, y: 30 },
    })).toBeNull();
  });

  it("requires a legible cut interval on both viewport axes", () => {
    const selectedContig = {
      ...compactContig,
      visualStart: 40,
      visualEnd: 60,
    };

    expect(assemblyCutTargetAtScreenPoint({
      model: buildAssemblyEditModel([selectedContig]),
      selectedIds: new Set([selectedContig.id]),
      binSizeBp: 1,
      point: { x: 100, y: 40 },
      widthPx: 200,
      heightPx: 80,
      viewportXStart: 0,
      viewportXEnd: 100,
      viewportYStart: 0,
      viewportYEnd: 100,
    })).toBeNull();
  });

  it("does not expose the cut affordance outside the diagonal or for an unselected contig", () => {
    const model = buildAssemblyEditModel([compactContig]);
    const input = {
      model,
      selectedIds: new Set([compactContig.id]),
      binSizeBp: 1,
      widthPx: 100,
      heightPx: 100,
      viewportXStart: 0,
      viewportXEnd: 100,
      viewportYStart: 0,
      viewportYEnd: 100,
    };

    expect(assemblyCutTargetAtScreenPoint({ ...input, point: { x: 4, y: 32 } })).toBeNull();
    expect(assemblyCutTargetAtScreenPoint({
      ...input,
      selectedIds: new Set(),
      point: { x: 18, y: 18 },
    })).toBeNull();
  });

  it("replays the same screen pointer against a newly narrowed viewport", () => {
    const selectedContig = {
      ...compactContig,
      visualStart: 40,
      visualEnd: 60,
    };
    const model = buildAssemblyEditModel([selectedContig]);
    const input = {
      model,
      selectedIds: new Set([selectedContig.id]),
      binSizeBp: 1,
      point: { x: 50, y: 50 },
      widthPx: 100,
      heightPx: 100,
      viewportXStart: 0,
      viewportYStart: 0,
    };

    expect(assemblyPointerStateAtScreenPoint({
      ...input,
      viewportXEnd: 200,
      viewportYEnd: 200,
    }).kind).toBe("select");
    expect(assemblyPointerStateAtScreenPoint({
      ...input,
      viewportXEnd: 100,
      viewportYEnd: 100,
    })).toEqual({
      kind: "cut",
      blockId: selectedContig.id,
      visualPosition: 50,
    });
  });

  it("projects the marker onto the true genomic diagonal in a rectangular viewport", () => {
    const selectedContig = {
      ...compactContig,
      visualStart: 40,
      visualEnd: 60,
    };

    expect(assemblyCutTargetAtScreenPoint({
      model: buildAssemblyEditModel([selectedContig]),
      selectedIds: new Set([selectedContig.id]),
      binSizeBp: 1,
      point: { x: 100, y: 55 },
      widthPx: 200,
      heightPx: 100,
      viewportXStart: 0,
      viewportXEnd: 100,
      viewportYStart: 0,
      viewportYEnd: 100,
    })).toEqual({ blockId: selectedContig.id, visualPosition: 51 });
  });

  it("keeps an acquired cut target locked in a wider corridor and releases it outside", () => {
    const selectedContig = {
      ...compactContig,
      visualStart: 10,
      visualEnd: 90,
    };
    const input = {
      model: buildAssemblyEditModel([selectedContig]),
      selectedIds: new Set([selectedContig.id]),
      binSizeBp: 1,
      widthPx: 100,
      heightPx: 100,
      viewportXStart: 0,
      viewportXEnd: 100,
      viewportYStart: 0,
      viewportYEnd: 100,
    };

    expect(assemblyCutTargetAtScreenPoint({
      ...input,
      point: { x: 50, y: 72 },
    })).toBeNull();
    expect(assemblyCutTargetAtScreenPoint({
      ...input,
      lockedCutBlockId: selectedContig.id,
      point: { x: 50, y: 72 },
    })).toEqual({ blockId: selectedContig.id, visualPosition: 61 });
    expect(assemblyCutTargetAtScreenPoint({
      ...input,
      lockedCutBlockId: selectedContig.id,
      point: { x: 60, y: 80 },
    })).toEqual({ blockId: selectedContig.id, visualPosition: 70 });
    expect(assemblyCutTargetAtScreenPoint({
      ...input,
      lockedCutBlockId: selectedContig.id,
      point: { x: 20, y: 75 },
    })).toBeNull();
  });

  it("keeps indexed cut candidates identical to the full selected-contig scan", () => {
    const manyContigs = Array.from({ length: 1_024 }, (_, index) => ({
      id: `Chr01:${index}:ctg${index}`,
      objectId: "Chr01",
      sourceId: `ctg${index}`,
      sourceStart: 0,
      sourceEnd: 8,
      visualStart: index * 10,
      visualEnd: index * 10 + 8,
      orientation: index % 2 === 0 ? "+" as const : "-" as const,
    }));
    const model = buildAssemblyEditModel(manyContigs);
    const selectedIds = new Set(manyContigs.map((block) => block.id));
    const interactionIndex = buildAssemblyInteractionIndex(model, selectedIds);
    const baseInput = {
      model,
      selectedIds,
      binSizeBp: 1,
      widthPx: 1_200,
      heightPx: 1_200,
      viewportXStart: 700,
      viewportXEnd: 1_100,
      viewportYStart: 700,
      viewportYEnd: 1_100,
    };

    for (let sample = 0; sample < 500; sample += 1) {
      const point = {
        x: (sample * 313) % baseInput.widthPx,
        y: (sample * 197) % baseInput.heightPx,
      };
      expect(assemblyCutTargetAtScreenPoint({
        ...baseInput,
        interactionIndex,
        point,
      })).toEqual(assemblyCutTargetAtScreenPoint({ ...baseInput, point }));
    }
  });
});

describe("assembly overlay hierarchy", () => {
  it("wires the whole-genome block overlay to the viewport-pixel hard limit", () => {
    const uiState = createInitialUiState("ready");
    uiState.assembly.blocks = Array.from({ length: 3_000 }, (_, index) => ({
      id: `Chr01:${index + 1}:ctg${index}`,
      objectId: "Chr01",
      sourceId: `ctg${index}`,
      sourceStart: 0,
      sourceEnd: 1,
      visualStart: index,
      visualEnd: index + 1,
      orientation: "+" as const,
    }));
    uiState.assembly.selection = {
      kind: "contigs",
      ids: uiState.assembly.blocks.map((block) => block.id),
      exact: true,
    };
    uiState.contact.totalSpanMb = 0.003;
    uiState.contact.viewportSpanMb = 0.003;
    uiState.contact.viewportCenterMb = 0.0015;
    uiState.contact.viewportCenterXMb = 0.0015;
    uiState.contact.viewportCenterYMb = 0.0015;
    const dataset: ExampleDatasetSummary = {
      agp_path: "large.agp",
      mcool_path: "",
      cool_path: "",
      paf_path: null,
      coverage_path: null,
      agp_lines: uiState.assembly.blocks.length,
      agp_objects: 1,
      agp_components: uiState.assembly.blocks.length,
      agp_gaps: 0,
      max_object_span: 3_000,
      mcool_size_bytes: 0,
      agp_layout: { blocks: uiState.assembly.blocks, totalSpan: 3_000 },
    };

    const markup = renderToStaticMarkup(createElement(ContactMapViewport, {
      dataset,
      contactMap: null,
      coverageView: null,
      uiState,
      onUiAction: () => undefined,
    }));

    expect(markup).toContain('data-rendered-block-count="1920"');
    expect(markup.match(/singleton-contig-box/g)).toHaveLength(1_920);
  });

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
    expect(markup.match(/assembly-selection-axis-bands/g)).toHaveLength(1);
    expect(markup.match(/assembly-selection-axis-band vertical/g)).toHaveLength(1);
    expect(markup.match(/assembly-selection-axis-band horizontal/g)).toHaveLength(1);
    expect(markup.match(/assembly-selection-axis-outline vertical/g)).toHaveLength(1);
    expect(markup.match(/assembly-selection-axis-outline horizontal/g)).toHaveLength(1);
    expect(markup.indexOf("assembly-selection-axis-bands"))
      .toBeLessThan(markup.indexOf("assembly-overlay-layer"));

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
