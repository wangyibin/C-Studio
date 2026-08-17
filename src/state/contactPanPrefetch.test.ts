import { describe, expect, it, vi } from "vitest";
import {
  ContactPanPrefetchBridge,
  contactPanTileLoadPriority,
} from "./contactPanPrefetch";

describe("ContactPanPrefetchBridge", () => {
  it("publishes without retaining batches and detaches cleanly", () => {
    const bridge = new ContactPanPrefetchBridge();
    const consumer = vi.fn();
    const unsubscribe = bridge.subscribe(consumer);
    const batch = {
      tiles: [{ tileX: 1, tileY: 2, cells: [] }],
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
