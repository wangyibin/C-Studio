import { describe, expect, it, vi } from "vitest";
import {
  ContactPanPrefetchBridge,
  contactPanPrefetchBatches,
  contactPanSettledGeneration,
  contactPanTileLoadPriority,
} from "./contactPanPrefetch";

describe("contactPanPrefetchBatches", () => {
  it("preserves center-first order while bounding the first publish", () => {
    expect(contactPanPrefetchBatches(["center-a", "center-b", "edge-a", "edge-b", "edge-c"], 2))
      .toEqual([
        ["center-a", "center-b"],
        ["edge-a", "edge-b"],
        ["edge-c"],
      ]);
  });

  it("normalizes invalid batch sizes to one item", () => {
    expect(contactPanPrefetchBatches([1, 2], 0)).toEqual([[1], [2]]);
    expect(contactPanPrefetchBatches([1, 2], Number.NaN)).toEqual([[1], [2]]);
  });
});

describe("ContactPanPrefetchBridge", () => {
  it("publishes without retaining batches and detaches cleanly", () => {
    const bridge = new ContactPanPrefetchBridge();
    const consumer = vi.fn();
    const unsubscribe = bridge.subscribe(consumer);
    const batch = {
      tiles: [{ tileX: 1, tileY: 2, cells: [] }],
      generation: 7,
      resolution: 100_000,
      tileSizeBins: 256,
      viewport: { xStart: 0, xEnd: 1, yStart: 0, yEnd: 1 },
    };

    bridge.publish(batch);
    expect(consumer).toHaveBeenCalledOnce();
    expect(consumer).toHaveBeenCalledWith(batch);

    unsubscribe();
    bridge.publish(batch);
    expect(consumer).toHaveBeenCalledOnce();
  });

  it("does not wake consumers for an empty batch", () => {
    const bridge = new ContactPanPrefetchBridge();
    const consumer = vi.fn();
    bridge.subscribe(consumer);
    bridge.publish({
      tiles: [],
      generation: 7,
      resolution: 100_000,
      tileSizeBins: 256,
      viewport: { xStart: 0, xEnd: 1, yStart: 0, yEnd: 1 },
    });
    expect(consumer).not.toHaveBeenCalled();
  });
});

describe("contactPanTileLoadPriority", () => {
  it("keeps the directional lead only while the wheel is actively moving", () => {
    expect(contactPanTileLoadPriority({
      previewActive: true,
      hasPendingPan: true,
      missingVisibleTileCount: 18,
      normalVisibleBatchSize: 8,
      activePanVisibleBatchSize: 2,
      urgentPrefetchTileCount: 8,
    })).toEqual({
      visibleBatchSize: 2,
      urgentPrefetchTileCount: 8,
    });
  });

  it("repairs every visible hole before directional prefetch once the wheel settles", () => {
    expect(contactPanTileLoadPriority({
      previewActive: false,
      hasPendingPan: true,
      missingVisibleTileCount: 18,
      normalVisibleBatchSize: 8,
      activePanVisibleBatchSize: 2,
      urgentPrefetchTileCount: 8,
    })).toEqual({
      visibleBatchSize: 18,
      urgentPrefetchTileCount: 0,
    });
  });

  it("returns to the normal foreground budget after the committed pan is complete", () => {
    expect(contactPanTileLoadPriority({
      previewActive: false,
      hasPendingPan: false,
      missingVisibleTileCount: 18,
      normalVisibleBatchSize: 8,
      activePanVisibleBatchSize: 2,
      urgentPrefetchTileCount: 8,
    })).toEqual({
      visibleBatchSize: 8,
      urgentPrefetchTileCount: 0,
    });
  });
});

describe("contactPanSettledGeneration", () => {
  const settledViewport = {
    xStart: 100,
    xEnd: 500,
    yStart: 200,
    yEnd: 600,
  };

  it("reuses the pan generation when pointer release commits its prefetched viewport", () => {
    expect(contactPanSettledGeneration(
      12,
      settledViewport,
      { ...settledViewport, xStart: settledViewport.xStart + 0.5 },
      12,
    )).toEqual({ generation: 12, reusePanGeneration: true });
  });

  it("advances for an unrelated viewport instead of adopting stale pan work", () => {
    expect(contactPanSettledGeneration(
      12,
      settledViewport,
      { ...settledViewport, xStart: settledViewport.xStart + 10 },
      12,
    )).toEqual({ generation: 13, reusePanGeneration: false });
  });

  it("advances when another render already superseded the matching pan generation", () => {
    expect(contactPanSettledGeneration(
      13,
      settledViewport,
      settledViewport,
      12,
    )).toEqual({ generation: 14, reusePanGeneration: false });
  });
});
