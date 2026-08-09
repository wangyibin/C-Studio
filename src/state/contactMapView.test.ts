import { describe, expect, it } from "vitest";
import type { ContactMapView } from "../App";
import {
  contactCellsForViewport,
  displayContactMapForPendingLayer,
  maxDrawableContactCells,
  reprojectContactMapLayout,
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

  it("keeps drawing the previous layer while a new resolution layer has no visible tiles yet", () => {
    const previousView: ContactMapView = {
      resolution: 1_000_000,
      viewport: { xStart: 0, xEnd: 100_000_000, yStart: 0, yEnd: 100_000_000 },
      cells: [],
      tileSizeBins: 256,
      layoutScope: "previous-layout",
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
      layoutScope: "pending-layout",
    };

    const displayed = displayContactMapForPendingLayer(pendingView, previousView);
    expect(displayed).toEqual({
      ...previousView,
      viewport: pendingView.viewport,
    });
    expect(displayed.layoutScope).toBe("previous-layout");
    expect(displayed.layoutBlocks).toBe(previousView.layoutBlocks);
  });

  it("does not replace the previous frame with sparse prefetch-only tiles", () => {
    const previousView: ContactMapView = {
      resolution: 100_000,
      viewport: { xStart: 0, xEnd: 25_000_000, yStart: 0, yEnd: 25_000_000 },
      cells: [],
      tiles: [{ tileX: 0, tileY: 0, cells: [{ xBin: 2, yBin: 2, count: 8 }] }],
    };
    const pendingView: ContactMapView = {
      resolution: 100_000,
      viewport: { xStart: 25_000_000, xEnd: 50_000_000, yStart: 25_000_000, yEnd: 50_000_000 },
      cells: [],
      tiles: [],
      cachedTiles: [{ tileX: 0, tileY: 1, cells: [{ xBin: 2, yBin: 258, count: 3 }] }],
    };

    expect(displayContactMapForPendingLayer(pendingView, previousView)).toEqual({
      ...previousView,
      viewport: pendingView.viewport,
    });
  });

  it("keeps the complete preview while only some visible tiles have arrived", () => {
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

    expect(displayContactMapForPendingLayer(partialView, previousView, false)).toEqual(previousView);
    expect(displayContactMapForPendingLayer(partialView, previousView, true)).toEqual(partialView);
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
    };
    const reversed = [
      { ...blocks[1], visualStart: 0, visualEnd: 100, orientation: "-" as const },
      { ...blocks[0], visualStart: 100, visualEnd: 200, orientation: "-" as const },
    ];

    expect(reprojectContactMapLayout(view, blocks, reversed)?.cells).toEqual([
      { xBin: 7, yBin: 18, count: 7 },
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

  it("keeps the previous exact frame when contig boundaries cut through resolution bins", () => {
    const view: ContactMapView = {
      resolution: 30,
      viewport: { xStart: 0, xEnd: 200, yStart: 0, yEnd: 200 },
      cells: [{ xBin: 1, yBin: 4, count: 7 }],
    };
    const reversed = [
      { ...blocks[1], visualStart: 0, visualEnd: 100, orientation: "-" as const },
      { ...blocks[0], visualStart: 100, visualEnd: 200, orientation: "-" as const },
    ];

    expect(reprojectContactMapLayout(view, blocks, reversed)).toBeNull();
  });
});
