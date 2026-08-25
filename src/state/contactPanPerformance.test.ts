import { describe, expect, it } from "vitest";
import {
  ContactPanPerformanceTracker,
  contactViewportPreviewIsPan,
  contactViewportPreviewIsReplacement,
  formatContactPanPerformanceLog,
  type ContactPanPerformanceOutput,
} from "./contactPanPerformance";

describe("contact viewport preview presentation", () => {
  const basePreview = {
    viewport: { xStart: 0, xEnd: 10, yStart: 0, yEnd: 10 },
    sequence: 1,
    pointerTimestamp: 100,
  };

  it("keeps legacy and explicit pan previews on the prefetch-only path", () => {
    expect(contactViewportPreviewIsPan(basePreview)).toBe(true);
    expect(contactViewportPreviewIsPan({
      ...basePreview,
      presentationMode: "pan",
    })).toBe(true);
    expect(contactViewportPreviewIsReplacement(basePreview)).toBe(false);
  });

  it("routes replacement previews to complete-frame presentation", () => {
    const preview = {
      ...basePreview,
      presentationMode: "replacement" as const,
    };
    expect(contactViewportPreviewIsReplacement(preview)).toBe(true);
    expect(contactViewportPreviewIsPan(preview)).toBe(false);
    expect(contactViewportPreviewIsPan(null)).toBe(false);
  });
});

describe("ContactPanPerformanceTracker", () => {
  it("correlates pointer, IPC, cache merge, and GPU paint", () => {
    let now = 105;
    const outputs: ContactPanPerformanceOutput[] = [];
    const marks: string[] = [];
    const tracker = new ContactPanPerformanceTracker({
      enabled: true,
      clock: () => now,
      emit: (output) => outputs.push(output),
      timeline: {
        mark: (name) => marks.push(name),
        measure: (name) => marks.push(name),
      },
    });

    expect(tracker.startGeneration({
      generation: 7,
      sequence: 3,
      pointerTimestamp: 100,
      visibleTiles: 6,
      cacheHit: false,
    })).toBe(true);
    now = 108;
    tracker.markIpcStart(7);
    now = 120;
    expect(tracker.markIpcResponse(7)).toBe(true);
    now = 121.5;
    expect(tracker.markCacheMerge(7)).toBe(true);
    now = 127;
    expect(tracker.markIpcResponse(7)).toBe(false);
    expect(tracker.markCacheMerge(7)).toBe(false);
    now = 132;
    const output = tracker.markGpuPaint(7);

    expect(output?.record).toMatchObject({
      status: "ok",
      panSequence: 3,
      generation: 7,
      pointerToGenerationMs: 5,
      pointerToIpcStartMs: 8,
      ipcMs: 12,
      pointerToCacheMergeMs: 21.5,
      pointerToGpuPaintMs: 32,
      totalMs: 32,
    });
    expect(outputs).toHaveLength(1);
    expect(marks).toContain("cstudio:contact-pan:3:pointermove_to_gpu_paint");
  });

  it("emits superseded samples instead of silently dropping fast pointer frames", () => {
    let now = 10;
    const outputs: ContactPanPerformanceOutput[] = [];
    const tracker = new ContactPanPerformanceTracker({
      enabled: true,
      clock: () => now,
      emit: (output) => outputs.push(output),
      timeline: null,
    });
    tracker.startGeneration({
      generation: 1,
      sequence: 1,
      pointerTimestamp: 8,
      visibleTiles: 4,
      cacheHit: false,
    });
    now = 12;
    tracker.startGeneration({
      generation: 2,
      sequence: 2,
      pointerTimestamp: 11,
      visibleTiles: 4,
      cacheHit: true,
    });

    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.record).toMatchObject({
      generation: 1,
      panSequence: 1,
      status: "superseded",
      pointerToGpuPaintMs: null,
    });
    expect(tracker.snapshot(2)?.cacheHit).toBe(true);
  });

  it("continues an unfinished pointer pipeline in the committed generation", () => {
    let now = 10;
    const tracker = new ContactPanPerformanceTracker({
      enabled: true,
      clock: () => now,
      emit: () => undefined,
      timeline: null,
    });
    tracker.startGeneration({
      generation: 7,
      sequence: 2,
      pointerTimestamp: 8,
      visibleTiles: 4,
      cacheHit: false,
    });

    now = 12;
    expect(tracker.continueGeneration(8)).toBe(true);
    tracker.markIpcStart(8);
    now = 15;
    tracker.markIpcResponse(8);
    tracker.markCacheMerge(8);
    now = 20;

    expect(tracker.markGpuPaint(8)?.record).toMatchObject({
      generation: 8,
      panSequence: 2,
      pointerToIpcStartMs: 4,
      ipcMs: 3,
      totalMs: 12,
    });
  });

  it("moves the same pointer sequence to a newer generation without superseding it", () => {
    const outputs: ContactPanPerformanceOutput[] = [];
    const tracker = new ContactPanPerformanceTracker({
      enabled: true,
      clock: () => 10,
      emit: (output) => outputs.push(output),
      timeline: null,
    });
    tracker.startGeneration({
      generation: 7,
      sequence: 2,
      pointerTimestamp: 8,
      visibleTiles: 4,
      cacheHit: false,
    });

    expect(tracker.startGeneration({
      generation: 8,
      sequence: 2,
      pointerTimestamp: 9,
      visibleTiles: 5,
      cacheHit: true,
    })).toBe(true);
    expect(outputs).toHaveLength(0);
    expect(tracker.snapshot(8)).toMatchObject({
      generation: 8,
      panSequence: 2,
      visibleTiles: 5,
      cacheHit: true,
    });
  });

  it("finishes a migrated generation by stable pointer sequence", () => {
    const outputs: ContactPanPerformanceOutput[] = [];
    const tracker = new ContactPanPerformanceTracker({
      enabled: true,
      clock: () => 20,
      emit: (output) => outputs.push(output),
      timeline: null,
    });
    tracker.startGeneration({
      generation: 7,
      sequence: 2,
      pointerTimestamp: 8,
      visibleTiles: 4,
      cacheHit: false,
    });
    tracker.continueGeneration(8);

    expect(tracker.markGpuPaintForSequence(2)?.record).toMatchObject({
      status: "ok",
      generation: 8,
      panSequence: 2,
      totalMs: 12,
    });
    expect(tracker.markGpuPaintForSequence(2)).toBeNull();
    expect(outputs).toHaveLength(1);
  });

  it("formats nullable pipeline stages for terminal parsing", () => {
    expect(formatContactPanPerformanceLog({
      event: "contact_pan_pipeline",
      status: "ok",
      generation: 9,
      panSequence: 4,
      visibleTiles: 3,
      cacheHit: true,
      pointerToGenerationMs: 1.25,
      pointerToIpcStartMs: null,
      ipcMs: null,
      pointerToCacheMergeMs: null,
      pointerToGpuPaintMs: 7.5,
      totalMs: 7.5,
    })).toBe(
      "CSTUDIO_PERF event=contact_pan_pipeline status=ok pan_sequence=4 generation=9 "
      + "visible_tiles=3 cache_hit=true pointer_to_generation_ms=1.25 "
      + "pointer_to_ipc_start_ms=null ipc_ms=null pointer_to_cache_merge_ms=null "
      + "pointer_to_gpu_paint_ms=7.5 total_ms=7.5",
    );
  });
});
