import { describe, expect, it, vi } from "vitest";
import {
  createContactResolutionResponsivenessTracker,
  type ContactResolutionResponsivenessOutput,
} from "./contactResolutionResponsiveness";

function fakeAnimationFrames() {
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  const cancel = vi.fn((id: number) => callbacks.delete(id));
  return {
    cancel,
    request(callback: FrameRequestCallback) {
      const id = nextId;
      nextId += 1;
      callbacks.set(id, callback);
      return id;
    },
    runNext(timestamp: number) {
      const entry = callbacks.entries().next().value as
        | [number, FrameRequestCallback]
        | undefined;
      if (!entry) {
        throw new Error("no scheduled animation frame");
      }
      callbacks.delete(entry[0]);
      entry[1](timestamp);
    },
  };
}

describe("ContactResolutionResponsivenessTracker", () => {
  it("measures terminal paint and records frame gaps over 50 ms", () => {
    let now = 100;
    const emitted: ContactResolutionResponsivenessOutput[] = [];
    const frames = fakeAnimationFrames();
    const tracker = createContactResolutionResponsivenessTracker({
      enabled: true,
      clock: () => now,
      requestAnimationFrame: frames.request,
      cancelAnimationFrame: frames.cancel,
      createLongTaskObserver: null,
      emit: (output) => emitted.push(output),
    });

    expect(tracker.startGeneration(7)).toBe(true);
    frames.runNext(160);
    frames.runNext(180);
    frames.runNext(250);
    now = 280;
    const output = tracker.finishGeneration(7);

    expect(output?.record).toEqual({
      event: "contact_resolution_responsiveness",
      generation: 7,
      terminal_gpu_paint_ms: 180,
      observer: "unavailable",
      long_task_count: 0,
      long_task_total_ms: 0,
      long_task_max_ms: 0,
      frame_gap_over_50_count: 2,
      frame_gap_over_50_total_ms: 130,
      frame_gap_over_50_max_ms: 70,
    });
    expect(emitted).toEqual([output]);
    expect(output?.logfmt).toContain(
      "event=contact_resolution_responsiveness generation=7 terminal_gpu_paint_ms=180",
    );
    expect(frames.cancel).toHaveBeenCalledTimes(1);
  });

  it("retargets an active interaction without resetting its start time", () => {
    let now = 10;
    const tracker = createContactResolutionResponsivenessTracker({
      enabled: true,
      clock: () => now,
      requestAnimationFrame: null,
      cancelAnimationFrame: null,
      createLongTaskObserver: null,
      emit: vi.fn(),
    });

    tracker.startGeneration(3);
    now = 25;
    expect(tracker.retargetGeneration(4)).toBe(true);
    expect(tracker.activeGeneration()).toBe(4);
    now = 40;

    expect(tracker.finishGeneration(3)).toBeNull();
    expect(tracker.finishGeneration(4)?.record.terminal_gpu_paint_ms).toBe(30);
  });

  it("uses supported Long Tasks entries and drains buffered records", () => {
    let now = 100;
    let observerCallback: PerformanceObserverCallback = () => undefined;
    const disconnect = vi.fn();
    const observer = {
      observe: vi.fn(),
      disconnect,
      takeRecords: () => [
        { startTime: 150, duration: 80 } as PerformanceEntry,
      ],
    };
    const tracker = createContactResolutionResponsivenessTracker({
      enabled: true,
      clock: () => now,
      requestAnimationFrame: null,
      cancelAnimationFrame: null,
      createLongTaskObserver: (callback) => {
        observerCallback = callback;
        return observer;
      },
      emit: vi.fn(),
    });

    tracker.startGeneration(9);
    const liveEntries = [
      { startTime: 110, duration: 60 },
      { startTime: 90, duration: 90 },
      { startTime: 120, duration: 40 },
    ] as PerformanceEntry[];
    observerCallback(
      { getEntries: () => liveEntries } as PerformanceObserverEntryList,
      observer as unknown as PerformanceObserver,
    );
    now = 300;

    expect(tracker.finishGeneration(9)?.record).toMatchObject({
      observer: "longtask",
      long_task_count: 2,
      long_task_total_ms: 140,
      long_task_max_ms: 80,
    });
    expect(observer.observe).toHaveBeenCalledWith({ type: "longtask", buffered: false });
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
