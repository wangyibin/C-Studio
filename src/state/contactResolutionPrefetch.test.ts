import { describe, expect, it, vi } from "vitest";
import {
  adjacentContactResolutions,
  interleaveContactPrefetchBatches,
  scheduleContactIdleTask,
  type ContactIdleTaskHost,
} from "./contactResolutionPrefetch";

describe("adjacent contact resolution prefetch", () => {
  const levels = ["2 Mb", "1 Mb", "500 kb", "250 kb"] as const;

  it("returns the immediate coarser and finer levels", () => {
    expect(adjacentContactResolutions("1 Mb", levels)).toEqual(["2 Mb", "500 kb"]);
  });

  it("keeps boundary levels in range and rejects unavailable selections", () => {
    expect(adjacentContactResolutions("2 Mb", levels)).toEqual(["1 Mb"]);
    expect(adjacentContactResolutions("250 kb", levels)).toEqual(["500 kb"]);
    expect(adjacentContactResolutions("5 kb", levels)).toEqual([]);
  });

  it("round-robins adjacent-layer batches without mutating the queues", () => {
    const coarse = ["coarse-1", "coarse-2", "coarse-3"];
    const fine = ["fine-1", "fine-2"];

    expect(interleaveContactPrefetchBatches([coarse, fine])).toEqual([
      "coarse-1",
      "fine-1",
      "coarse-2",
      "fine-2",
      "coarse-3",
    ]);
    expect(coarse).toEqual(["coarse-1", "coarse-2", "coarse-3"]);
    expect(fine).toEqual(["fine-1", "fine-2"]);
  });
});

describe("contact idle task scheduling", () => {
  it("uses and cancels a native idle callback when available", () => {
    let idleCallback: IdleRequestCallback | null = null;
    const callback = vi.fn();
    const cancelIdleCallback = vi.fn();
    const host: ContactIdleTaskHost = {
      requestIdleCallback: vi.fn((nextCallback) => {
        idleCallback = nextCallback;
        return 17;
      }),
      cancelIdleCallback,
      setTimeout: vi.fn(() => 0),
      clearTimeout: vi.fn(),
    };

    const cancel = scheduleContactIdleTask(callback, host);
    cancel();
    expect(idleCallback).not.toBeNull();
    (idleCallback as unknown as IdleRequestCallback)({
      didTimeout: false,
      timeRemaining: () => 8,
    });

    expect(cancelIdleCallback).toHaveBeenCalledWith(17);
    expect(callback).not.toHaveBeenCalled();
  });

  it("uses a cancellable timer fallback for older WebViews", () => {
    let timeoutCallback: (() => void) | null = null;
    const callback = vi.fn();
    const clearTimeout = vi.fn();
    const host: ContactIdleTaskHost = {
      setTimeout: vi.fn((nextCallback, delayMs) => {
        expect(delayMs).toBe(125);
        timeoutCallback = nextCallback;
        return 23;
      }),
      clearTimeout,
    };

    const cancel = scheduleContactIdleTask(callback, host, 125);
    expect(timeoutCallback).not.toBeNull();
    (timeoutCallback as unknown as () => void)();
    cancel();

    expect(callback).toHaveBeenCalledOnce();
    expect(clearTimeout).not.toHaveBeenCalled();
  });
});
