import { describe, expect, it } from "vitest";
import type { ContactMapTile, ContactMapView } from "../App";
import {
  contactCellsForViewport,
  contactPreviewTilesForMissing,
  contactTilesWithPreviewFallback,
  displayContactMapForPendingLayer,
  maxDrawableContactCells,
  maxInteractivePreviewContactCells,
  reprojectContactMapLayout,
  shouldHoldPreviousContactMapFrame,
  shouldPublishContactMapLayer,
} from "./contactMapView";
import type { ContactMapLayoutBlock } from "./importers";

describe("contactCellsForViewport", () => {
  it("draws from cached prefetch tiles for panned viewports", () => {
    const view: ContactMapView = {
      resolution: 1_000,
      viewport: { xStart: 512_000, xEnd: 768_000, yStart: 0, yEnd: 256_000 },
      cells: [],
      tileSizeBins: 256,
      tiles: [
        {
          tileX: 0,
          tileY: 0,
          cells: [{ xBin: 4, yBin: 4, count: 2 }],
        },
      ],
      cachedTiles: [
        {
          tileX: 0,
          tileY: 0,
          cells: [{ xBin: 4, yBin: 4, count: 2 }],
        },
        {
          tileX: 2,
          tileY: 0,
          cells: [{ xBin: 520, yBin: 4, count: 9 }],
        },
      ],
    };

    expect(contactCellsForViewport(view)).toEqual([{ xBin: 520, yBin: 4, count: 9 }]);
  });

  it("thins very dense cell sets before drawing", () => {
    const cells = Array.from({ length: maxDrawableContactCells + 10_000 }, (_, index) => ({
      xBin: index,
      yBin: index,
      count: 1,
    }));
    const view: ContactMapView = {
      resolution: 50_000,
      viewport: { xStart: 0, xEnd: 10_000_000, yStart: 0, yEnd: 10_000_000 },
      cells,
    };

    expect(contactCellsForViewport(view).length).toBeLessThanOrEqual(maxDrawableContactCells);
  });

  it("uses stable coordinate sampling instead of periodic array strides", () => {
    const cells = Array.from({ length: maxDrawableContactCells + 20_000 }, (_, index) => ({
      xBin: Math.floor(index / 500),
      yBin: index % 500,
      count: 1,
    }));
    const view: ContactMapView = {
      resolution: 1,
      viewport: { xStart: 0, xEnd: 1_000, yStart: 0, yEnd: 1_000 },
      cells,
    };
    const first = contactCellsForViewport(view);
    const second = contactCellsForViewport(view);

    expect(first).toEqual(second);
    expect(new Set(first.map((cell) => cell.yBin % 2)).size).toBe(2);
  });

  it("does not reuse the previous layer across resolutions", () => {
    const previousView: ContactMapView = {
      resolution: 1_000_000,
      viewport: { xStart: 0, xEnd: 100_000_000, yStart: 0, yEnd: 100_000_000 },
      cells: [],
      tileSizeBins: 256,
      layoutScope: "shared-layout",
      layoutBlocks: [],
      tiles: [
        {
          tileX: 0,
          tileY: 0,
          cells: [{ xBin: 10, yBin: 10, count: 5 }],
        },
      ],
    };
    const pendingView: ContactMapView = {
      resolution: 500_000,
      viewport: { xStart: 25_000_000, xEnd: 75_000_000, yStart: 25_000_000, yEnd: 75_000_000 },
      cells: [],
      tileSizeBins: 256,
      tiles: [],
      cachedTiles: [],
      layoutScope: "shared-layout",
    };

    const displayed = displayContactMapForPendingLayer(pendingView, previousView, false);
    expect(displayed).toBe(pendingView);
  });

  it("does not replace the previous frame with sparse prefetch-only tiles", () => {
    const previousView: ContactMapView = {
      resolution: 100_000,
      viewport: { xStart: 0, xEnd: 25_000_000, yStart: 0, yEnd: 25_000_000 },
      cells: [],
      layoutScope: "shared-layout",
      tiles: [{ tileX: 0, tileY: 0, cells: [{ xBin: 2, yBin: 2, count: 8 }] }],
    };
    const pendingView: ContactMapView = {
      resolution: 100_000,
      viewport: { xStart: 25_000_000, xEnd: 50_000_000, yStart: 25_000_000, yEnd: 50_000_000 },
      cells: [],
      layoutScope: "shared-layout",
      tiles: [],
      cachedTiles: [{ tileX: 0, tileY: 1, cells: [{ xBin: 2, yBin: 258, count: 3 }] }],
    };

    expect(displayContactMapForPendingLayer(pendingView, previousView, false)).toEqual({
      ...previousView,
      viewport: pendingView.viewport,
    });
  });

  it("does not reuse the previous layer after the assembly layout scope changes", () => {
    const previousView: ContactMapView = {
      resolution: 100_000,
      viewport: { xStart: 0, xEnd: 25_000_000, yStart: 0, yEnd: 25_000_000 },
      cells: [],
      layoutScope: "old-layout",
      tiles: [{ tileX: 0, tileY: 0, cells: [{ xBin: 2, yBin: 2, count: 8 }] }],
    };
    const pendingView: ContactMapView = {
      resolution: 100_000,
      viewport: previousView.viewport,
      cells: [],
      layoutScope: "new-layout",
      tiles: [],
      cachedTiles: [],
    };

    expect(displayContactMapForPendingLayer(pendingView, previousView, false)).toBe(pendingView);
  });

  it("switches to the pending layer as soon as its first visible tile arrives", () => {
    const previousView: ContactMapView = {
      resolution: 100_000,
      viewport: { xStart: 0, xEnd: 50_000_000, yStart: 0, yEnd: 50_000_000 },
      cells: [{ xBin: 10, yBin: 10, count: 8 }],
    };
    const partialView: ContactMapView = {
      resolution: 100_000,
      viewport: previousView.viewport,
      cells: [],
      tiles: [{ tileX: 0, tileY: 0, cells: [{ xBin: 2, yBin: 2, count: 3 }] }],
    };

    expect(displayContactMapForPendingLayer(partialView, previousView, false)).toEqual(partialView);
    expect(displayContactMapForPendingLayer(partialView, previousView, true)).toEqual(partialView);
  });

  it("treats an empty visible tile as an arrived authoritative tile", () => {
    const previousView: ContactMapView = {
      resolution: 100_000,
      viewport: { xStart: 0, xEnd: 50_000_000, yStart: 0, yEnd: 50_000_000 },
      cells: [{ xBin: 10, yBin: 10, count: 8 }],
    };
    const partialView: ContactMapView = {
      resolution: 50_000,
      viewport: previousView.viewport,
      cells: [],
      tiles: [{ tileX: 0, tileY: 0, cells: [] }],
    };

    expect(displayContactMapForPendingLayer(partialView, previousView, false)).toBe(partialView);
    expect(displayContactMapForPendingLayer(partialView, previousView, true)).toBe(partialView);
  });

  it("keeps a new-layout preview visible before its first exact tile arrives", () => {
    const previousView: ContactMapView = {
      resolution: 100,
      viewport: { xStart: 0, xEnd: 1_000, yStart: 0, yEnd: 1_000 },
      cells: [],
      layoutScope: "old-layout",
      tiles: [{ tileX: 0, tileY: 0, cells: [] }],
    };
    const previewView: ContactMapView = {
      resolution: 100,
      viewport: previousView.viewport,
      cells: [],
      layoutScope: "new-layout",
      tiles: [],
      cachedTiles: [],
      previewTiles: [{ tileX: 0, tileY: 0, cells: [{ xBin: 2, yBin: 3, count: 5 }] }],
    };

    expect(displayContactMapForPendingLayer(previewView, previousView, false)).toBe(previewView);
  });
});

describe("contact tile preview composition", () => {
  it("lets an exact empty tile replace a non-empty preview tile", () => {
    const exactEmpty = { tileX: 0, tileY: 1, cells: [] };
    const previewAtSameCoordinate = {
      tileX: 0,
      tileY: 1,
      cells: [{ xBin: 2, yBin: 258, count: 9 }],
    };
    const otherPreview = {
      tileX: 1,
      tileY: 1,
      cells: [{ xBin: 258, yBin: 259, count: 4 }],
    };

    const composed = contactTilesWithPreviewFallback(
      [exactEmpty],
      [previewAtSameCoordinate, otherPreview],
    );
    expect(composed[0]).toBe(exactEmpty);
    expect(composed[1]).toBe(otherPreview);
  });

  it("retains preview objects only for tiles that are still missing", () => {
    const first = { tileX: 0, tileY: 1, cells: [] };
    const second = { tileX: 1, tileY: 1, cells: [] };

    expect(contactPreviewTilesForMissing(
      [first, second],
      [{ tileX: 1, tileY: 1 }],
    )).toEqual([second]);
  });

  it("replaces only the exact tile delivered by each progressive batch", () => {
    const preview00 = { tileX: 0, tileY: 0, cells: [{ xBin: 1, yBin: 1, count: 3 }] };
    const preview01 = { tileX: 0, tileY: 1, cells: [{ xBin: 1, yBin: 258, count: 4 }] };
    const preview11 = { tileX: 1, tileY: 1, cells: [{ xBin: 258, yBin: 259, count: 5 }] };
    const exact00 = { tileX: 0, tileY: 0, cells: [] };
    const exact01 = { tileX: 0, tileY: 1, cells: [{ xBin: 1, yBin: 258, count: 40 }] };
    const tileAt = (tiles: ContactMapTile[], key: string) => (
      tiles.find((tile) => `${tile.tileX}:${tile.tileY}` === key)
    );

    const afterFirstBatch = contactTilesWithPreviewFallback(
      [exact00],
      [preview00, preview01, preview11],
    );
    const afterSecondBatch = contactTilesWithPreviewFallback(
      [exact00, exact01],
      [preview00, preview01, preview11],
    );

    expect(tileAt(afterFirstBatch, "0:0")).toBe(exact00);
    expect(tileAt(afterFirstBatch, "0:1")).toBe(preview01);
    expect(tileAt(afterFirstBatch, "1:1")).toBe(preview11);
    expect(tileAt(afterSecondBatch, "0:0")).toBe(exact00);
    expect(tileAt(afterSecondBatch, "0:1")).toBe(exact01);
    expect(tileAt(afterSecondBatch, "1:1")).toBe(preview11);
  });
});

describe("contact map layer publishing", () => {
  const previousComplete: ContactMapView = {
    resolution: 100_000,
    viewport: { xStart: 0, xEnd: 10_000_000, yStart: 0, yEnd: 10_000_000 },
    cells: [],
    tileSizeBins: 256,
    layoutScope: "dataset|100000|256|layout-a",
    visibleLayerComplete: true,
  };

  it("keeps the prior complete layer until a resolution transition is complete", () => {
    expect(shouldHoldPreviousContactMapFrame(
      previousComplete,
      50_000,
      256,
      "dataset|50000|256|layout-a",
    )).toBe(true);
    expect(shouldPublishContactMapLayer(true, false)).toBe(false);
    expect(shouldPublishContactMapLayer(true, true)).toBe(true);
  });

  it("also holds the complete layer for a layout transition at one resolution", () => {
    expect(shouldHoldPreviousContactMapFrame(
      previousComplete,
      100_000,
      256,
      "dataset|100000|256|layout-b",
    )).toBe(true);
  });

  it("preserves progressive publishing outside layout edits", () => {
    expect(shouldHoldPreviousContactMapFrame(
      previousComplete,
      100_000,
      256,
      previousComplete.layoutScope!,
    )).toBe(false);
    expect(shouldHoldPreviousContactMapFrame(null, 100_000, 256, "layout-a")).toBe(false);
    expect(shouldPublishContactMapLayer(false, false)).toBe(true);
    expect(shouldPublishContactMapLayer(false, true)).toBe(true);
  });
});

describe("reprojectContactMapLayout", () => {
  const blocks: ContactMapLayoutBlock[] = [
    {
      id: "a",
      objectId: "chr1",
      sourceId: "a",
      sourceStart: 0,
      sourceEnd: 100,
      visualStart: 0,
      visualEnd: 100,
      orientation: "+",
    },
    {
      id: "b",
      objectId: "chr1",
      sourceId: "b",
      sourceStart: 0,
      sourceEnd: 100,
      visualStart: 100,
      visualEnd: 200,
      orientation: "+",
    },
  ];

  it("immediately mirrors bins for a reversed contig group", () => {
    const view: ContactMapView = {
      resolution: 10,
      viewport: { xStart: 0, xEnd: 200, yStart: 0, yEnd: 200 },
      cells: [{ xBin: 1, yBin: 12, count: 7 }],
      tileSizeBins: 10,
    };
    const reversed = [
      { ...blocks[1], visualStart: 0, visualEnd: 100, orientation: "-" as const },
      { ...blocks[0], visualStart: 100, visualEnd: 200, orientation: "-" as const },
    ];

    const preview = reprojectContactMapLayout(view, blocks, reversed);
    expect(preview?.cells).toEqual([
      { xBin: 7, yBin: 18, count: 7 },
    ]);
    expect(preview?.previewTiles).toEqual([
      { tileX: 0, tileY: 1, cells: [{ xBin: 7, yBin: 18, count: 7 }] },
    ]);
  });

  it("does not reuse pixels after a split changes source intervals", () => {
    const view: ContactMapView = {
      resolution: 10,
      viewport: { xStart: 0, xEnd: 200, yStart: 0, yEnd: 200 },
      cells: [{ xBin: 1, yBin: 12, count: 7 }],
    };
    const split = [{ ...blocks[0], sourceEnd: 50, visualEnd: 50 }, blocks[1]];

    expect(reprojectContactMapLayout(view, blocks, split)).toBeNull();
  });

  it("provides an approximate preview when contig boundaries cut through resolution bins", () => {
    const view: ContactMapView = {
      resolution: 30,
      viewport: { xStart: 0, xEnd: 200, yStart: 0, yEnd: 200 },
      cells: [{ xBin: 1, yBin: 4, count: 7 }],
    };
    const reversed = [
      { ...blocks[1], visualStart: 0, visualEnd: 100, orientation: "-" as const },
      { ...blocks[0], visualStart: 100, visualEnd: 200, orientation: "-" as const },
    ];

    expect(reprojectContactMapLayout(view, blocks, reversed)?.cells).toEqual([
      { xBin: 2, yBin: 5, count: 7 },
    ]);
  });

  it("stably thins a dense map instead of abandoning the edit preview", () => {
    const cells = Array.from(
      { length: maxInteractivePreviewContactCells + 1_000 },
      (_, index) => ({ xBin: index, yBin: index, count: 1 }),
    );
    const denseBlocks: ContactMapLayoutBlock[] = [{
      ...blocks[0],
      sourceEnd: cells.length,
      visualEnd: cells.length,
    }];
    const reversed = [{ ...denseBlocks[0], orientation: "-" as const }];
    const view: ContactMapView = {
      resolution: 1,
      viewport: { xStart: 0, xEnd: cells.length, yStart: 0, yEnd: cells.length },
      cells,
    };

    const first = reprojectContactMapLayout(view, denseBlocks, reversed);
    const second = reprojectContactMapLayout(view, denseBlocks, reversed);
    expect(first).not.toBeNull();
    expect(first?.cells.length).toBeGreaterThan(0);
    expect(first?.cells.length).toBeLessThanOrEqual(maxInteractivePreviewContactCells);
    expect(second?.cells).toEqual(first?.cells);
  });
});
