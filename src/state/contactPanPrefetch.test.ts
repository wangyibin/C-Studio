import { describe, expect, it, vi } from "vitest";
import {
  ContactPanPrefetchBridge,
  ContactPanPrefetchPriorityQueue,
  contactPanPrefetchBatches,
  contactSpatialPrefetchBatchSize,
  formatContactPanPrefetchPerformanceLog,
  formatContactPanPrefetchPlanPerformanceLog,
  contactPanSettledGeneration,
  contactPanTileLoadPriority,
} from "./contactPanPrefetch";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function flushScheduler() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ContactPanPrefetchPriorityQueue", () => {
  it("reserves foreground lanes and never cancels already-started prefetch", async () => {
    const queue = new ContactPanPrefetchPriorityQueue({
      concurrency: 4,
      prefetchConcurrency: 2,
    });
    const started: string[] = [];
    const completions = new Map<string, ReturnType<typeof deferred>>();
    const task = (
      key: string,
      priority: "visible" | "lead" | "prefetch",
      sequence: number,
    ) => {
      const completion = deferred();
      completions.set(key, completion);
      return {
        key,
        priority,
        sequence,
        run: () => {
          started.push(key);
          return completion.promise;
        },
      };
    };

    queue.replacePending([
      task("old-prefetch-1", "prefetch", 1),
      task("old-prefetch-2", "prefetch", 1),
      task("old-prefetch-3", "prefetch", 1),
      task("old-prefetch-4", "prefetch", 1),
    ]);
    await flushScheduler();
    expect(started).toEqual(["old-prefetch-1", "old-prefetch-2"]);

    queue.replacePending([
      task("visible-1", "visible", 2),
      task("visible-2", "visible", 2),
      task("visible-3", "visible", 2),
      task("new-prefetch", "prefetch", 2),
    ]);
    await flushScheduler();
    expect(started).toEqual([
      "old-prefetch-1",
      "old-prefetch-2",
      "visible-1",
      "visible-2",
    ]);
    expect(queue.snapshot().pendingKeys).toEqual(["visible-3", "new-prefetch"]);
    expect(queue.snapshot().runningKeys).toContain("old-prefetch-2");
    expect(started).not.toContain("old-prefetch-3");
    expect(started).not.toContain("old-prefetch-4");

    completions.get("old-prefetch-1")?.resolve();
    await flushScheduler();
    expect(started[started.length - 1]).toBe("visible-3");

    for (const completion of completions.values()) {
      completion.resolve();
    }
    await flushScheduler();
  });

  it("orders current tiles before predicted lead and caps only side warming", async () => {
    const queue = new ContactPanPrefetchPriorityQueue({
      concurrency: 4,
      prefetchConcurrency: 2,
    });
    const started: string[] = [];
    const task = (
      key: string,
      priority: "visible" | "lead" | "prefetch",
    ) => ({
      key,
      priority,
      sequence: 3,
      run: () => {
        started.push(key);
        return new Promise<void>(() => undefined);
      },
    });

    queue.replacePending([
      task("side-1", "prefetch"),
      task("lead-1", "lead"),
      task("visible-1", "visible"),
      task("lead-2", "lead"),
      task("side-2", "prefetch"),
      task("lead-3", "lead"),
    ]);
    await flushScheduler();

    expect(started).toEqual(["visible-1", "lead-1", "lead-2", "lead-3"]);
    expect(queue.snapshot().pendingKeys).toEqual(["side-1", "side-2"]);
    expect(queue.snapshot().runningPrefetchCount).toBe(0);
  });

  it("normalizes concurrency to the supported two-to-four lane range", () => {
    const low = new ContactPanPrefetchPriorityQueue({ concurrency: 0 });
    const high = new ContactPanPrefetchPriorityQueue({ concurrency: 99 });
    const never = () => new Promise<void>(() => undefined);
    low.replacePending(Array.from({ length: 4 }, (_, index) => ({
      key: `low-${index}`,
      priority: "visible" as const,
      sequence: 1,
      run: never,
    })));
    high.replacePending(Array.from({ length: 6 }, (_, index) => ({
      key: `high-${index}`,
      priority: "visible" as const,
      sequence: 1,
      run: never,
    })));
    expect(low.snapshot().runningKeys).toHaveLength(2);
    expect(high.snapshot().runningKeys).toHaveLength(4);
  });
});

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

  it("uses the measured latency-first background batch size", () => {
    expect(contactSpatialPrefetchBatchSize).toBe(4);
  });
});

describe("formatContactPanPrefetchPerformanceLog", () => {
  it("records queue, generation, backend, merge, and publish costs", () => {
    expect(formatContactPanPrefetchPerformanceLog({
      status: "ok",
      generation: 8,
      sequence: 3,
      requestId: 12,
      priority: "lead",
      tileX: 4,
      tileY: 7,
      sharedFlight: false,
      queueWaitMs: 1.25,
      generationWaitMs: 2.5,
      backendIpcMs: 30.75,
      flightWaitMs: 34.5,
      cacheMergeMs: 0.5,
      publishMs: 0.25,
      totalMs: 36.5,
    })).toBe(
      "CSTUDIO_PERF event=contact_pan_prefetch status=ok generation=8 pan_sequence=3 request_id=12 priority=lead tile_x=4 tile_y=7 shared_flight=0 queue_wait_ms=1.250 generation_wait_ms=2.500 backend_ipc_ms=30.750 flight_wait_ms=34.500 cache_merge_ms=0.500 publish_ms=0.250 total_ms=36.500",
    );
  });

  it("marks a shared or pre-backend flight without inventing IPC time", () => {
    const line = formatContactPanPrefetchPerformanceLog({
      status: "cancelled",
      generation: 9,
      sequence: 4,
      requestId: null,
      priority: "visible",
      tileX: 2,
      tileY: 2,
      sharedFlight: true,
      queueWaitMs: 0,
      generationWaitMs: 0,
      backendIpcMs: null,
      flightWaitMs: 4,
      cacheMergeMs: 0,
      publishMs: 0,
      totalMs: 4,
    });
    expect(line).toContain("request_id=-1");
    expect(line).toContain("shared_flight=1");
    expect(line).toContain("backend_ipc_ms=-1");
  });

  it("reports the cache coverage of the changed pan frontier", () => {
    expect(formatContactPanPrefetchPlanPerformanceLog({
      generation: 10,
      sequence: 5,
      totalTiles: 12,
      visibleTiles: 6,
      leadTiles: 3,
      cachedTiles: 8,
      missingTiles: 4,
    })).toBe(
      "CSTUDIO_PERF event=contact_pan_prefetch status=plan generation=10 pan_sequence=5 total_tiles=12 visible_tiles=6 lead_tiles=3 cached_tiles=8 missing_tiles=4",
    );
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
