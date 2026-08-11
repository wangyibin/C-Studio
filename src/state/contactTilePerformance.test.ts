import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createContactTilePerformanceTracker,
  formatContactTilePerformanceLog,
  isContactTilePerformanceEnabled,
  nextContactResolutionForPerformance,
  type ContactTilePerformanceOutput,
  type ContactTilePerformanceRecord,
} from "./contactTilePerformance";
import { createInitialUiState } from "./uiState";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function timedTracker() {
  let now = 100;
  const emitted: ContactTilePerformanceOutput[] = [];
  const tracker = createContactTilePerformanceTracker({
    enabled: true,
    clock: () => now,
    emit: (output) => emitted.push(output),
  });
  return {
    emitted,
    setNow(value: number) {
      now = value;
    },
    tracker,
  };
}

describe("ContactTilePerformanceTracker", () => {
  it("correlates every frontend stage within one generation", () => {
    const { emitted, setNow, tracker } = timedTracker();

    expect(tracker.startGeneration({
      generation: 42,
      resolution: 10_000,
      visibleTiles: 6,
      startedAt: 99,
    })).toBe(true);
    setNow(112.125);
    expect(tracker.markIpcResponse(42)).toBe(true);
    setNow(114.5);
    expect(tracker.markCacheMerge(42)).toBe(true);
    setNow(118.75);
    expect(tracker.markReactCommit(42, 9, 117.5)).toBe(true);
    setNow(120.1254);
    const output = tracker.markLastTilePaint(42, 9);

    expect(output?.record).toEqual({
      event: "contact_tiles_frontend",
      generation: 42,
      resolution: 10_000,
      visible_tiles: 6,
      canvas_count: 9,
      cache_hit: false,
      ipc_count: 1,
      resolution_commit_ms: 0,
      ipc_response_ms: 13.125,
      cache_merge_ms: 15.5,
      react_commit_ms: 18.5,
      last_tile_paint_ms: 21.125,
      total_ms: 21.125,
    });
    expect(emitted).toEqual([output]);
    expect(output?.logfmt).toContain("CSTUDIO_PERF event=contact_tiles_frontend generation=42");
    expect(output?.logfmt).not.toContain("\n");
  });

  it("keeps IPC timing null and count zero for a cache hit", () => {
    const { setNow, tracker } = timedTracker();
    tracker.startGeneration({ generation: 5, cacheHit: true });
    setNow(101);
    tracker.markReactCommit(5);
    setNow(102);

    const record = tracker.markLastTilePaint(5)?.record;
    expect(record).toMatchObject({
      cache_hit: true,
      ipc_count: 0,
      ipc_response_ms: null,
      cache_merge_ms: null,
      last_tile_paint_ms: 2,
    });
  });

  it("ignores callbacks from superseded and completed generations", () => {
    const { emitted, setNow, tracker } = timedTracker();
    tracker.startGeneration({ generation: 10 });
    setNow(101);
    tracker.startGeneration({ generation: 11 });

    expect(tracker.markIpcResponse(10)).toBe(false);
    expect(tracker.markCacheMerge(10)).toBe(false);
    expect(tracker.markLastTilePaint(10)).toBeNull();
    expect(tracker.snapshot(10)).toBeNull();

    setNow(102);
    expect(tracker.markLastTilePaint(11)?.record.total_ms).toBe(1);
    expect(tracker.markReactCommit(11)).toBe(false);
    expect(tracker.startGeneration({ generation: 10 })).toBe(false);
    expect(emitted).toHaveLength(1);
  });

  it("lets an unmeasured newer app generation supersede the active run", () => {
    const { emitted, tracker } = timedTracker();
    tracker.startGeneration({ generation: 20 });

    expect(tracker.supersedeBefore(20)).toBe(false);
    expect(tracker.supersedeBefore(21)).toBe(true);
    expect(tracker.snapshot(20)).toBeNull();
    expect(tracker.markLastTilePaint(20)).toBeNull();
    expect(emitted).toEqual([]);

    expect(tracker.startGeneration({ generation: 22 })).toBe(true);
  });

  it("uses the latest IPC response and reports the batch count", () => {
    const { setNow, tracker } = timedTracker();
    tracker.startGeneration({ generation: 8 });
    setNow(101);
    tracker.markIpcResponse(8);
    setNow(103.25);
    tracker.markIpcResponse(8);

    expect(tracker.snapshot(8)).toMatchObject({
      ipc_count: 2,
      ipc_response_ms: 3.25,
    });
  });

  it("does no tracking or logging while disabled", () => {
    const emit = vi.fn();
    const tracker = createContactTilePerformanceTracker({ enabled: false, emit });

    expect(tracker.startGeneration({ generation: 1 })).toBe(false);
    expect(tracker.markIpcResponse(1)).toBe(false);
    expect(tracker.markLastTilePaint(1)).toBeNull();
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("resolution performance action prediction", () => {
  it("ignores no-op viewport metrics instead of leaving a stale action start", () => {
    const state = createInitialUiState("ready");

    expect(nextContactResolutionForPerformance({
      type: "setContactViewportMetrics",
      viewportSizePx: state.contact.viewportSizePx,
      viewportWidthPx: state.contact.viewportWidthPx,
      viewportHeightPx: state.contact.viewportHeightPx,
      totalSpanMb: state.contact.totalSpanMb,
    }, state)).toBeNull();
  });

  it("returns the reducer's actual committed resolution", () => {
    const state = createInitialUiState("ready");

    expect(nextContactResolutionForPerformance({
      type: "setContactResolution",
      resolution: "50 kb",
    }, state)).toBe("50 kb");
    expect(nextContactResolutionForPerformance({ type: "toggleSnapping" }, state)).toBeNull();
  });
});

describe("contact tile performance output", () => {
  it("formats nullable timings as one logfmt line", () => {
    const record: ContactTilePerformanceRecord = {
      event: "contact_tiles_frontend",
      generation: 9,
      resolution: null,
      visible_tiles: 0,
      canvas_count: 0,
      cache_hit: true,
      ipc_count: 0,
      resolution_commit_ms: 0,
      ipc_response_ms: null,
      cache_merge_ms: 0,
      react_commit_ms: 1,
      last_tile_paint_ms: 2,
      total_ms: 2,
    };

    expect(formatContactTilePerformanceLog(record)).toBe(
      "CSTUDIO_PERF event=contact_tiles_frontend generation=9 resolution=null visible_tiles=0 canvas_count=0 cache_hit=true ipc_count=0 resolution_commit_ms=0 ipc_response_ms=null cache_merge_ms=0 react_commit_ms=1 last_tile_paint_ms=2 total_ms=2",
    );
  });

  it("supports the Vite, localStorage, and URL opt-in flags", () => {
    const emptyStorage = { getItem: () => null };

    expect(isContactTilePerformanceEnabled({
      viteFlag: "1",
      storage: emptyStorage,
      search: "",
    })).toBe(true);
    expect(isContactTilePerformanceEnabled({
      viteFlag: "0",
      storage: { getItem: (key) => key === "CSTUDIO_PERF_LOG" ? "1" : null },
      search: "",
    })).toBe(true);
    expect(isContactTilePerformanceEnabled({
      viteFlag: "0",
      storage: emptyStorage,
      search: "?cstudioPerf=1",
    })).toBe(true);
    expect(isContactTilePerformanceEnabled({
      viteFlag: "0",
      storage: emptyStorage,
      search: "?cstudioPerf=0",
    })).toBe(false);
  });

  it("reads Vite and browser flags by default", () => {
    vi.stubEnv("CSTUDIO_PERF_LOG", "1");
    expect(isContactTilePerformanceEnabled()).toBe(true);

    vi.unstubAllEnvs();
    vi.stubEnv("VITE_CSTUDIO_PERF_LOG", "1");
    expect(isContactTilePerformanceEnabled()).toBe(true);

    vi.unstubAllEnvs();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => key === "CSTUDIO_PERF_LOG" ? "1" : null,
    });
    vi.stubGlobal("location", { search: "" });
    expect(isContactTilePerformanceEnabled({ viteFlag: "0" })).toBe(true);

    vi.stubGlobal("localStorage", { getItem: () => null });
    vi.stubGlobal("location", { search: "?cstudioPerf=1" });
    expect(isContactTilePerformanceEnabled({ viteFlag: "0" })).toBe(true);
  });

  it("tolerates denied localStorage access", () => {
    expect(isContactTilePerformanceEnabled({
      viteFlag: "0",
      storage: {
        getItem() {
          throw new DOMException("denied", "SecurityError");
        },
      },
      search: "?cstudioPerf=1",
    })).toBe(true);
  });
});
