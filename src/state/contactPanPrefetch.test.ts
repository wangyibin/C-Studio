import { describe, expect, it, vi } from "vitest";
import { ContactPanPrefetchBridge } from "./contactPanPrefetch";

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
