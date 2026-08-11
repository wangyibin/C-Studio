import {
  reduceUiState,
  type ContactResolution,
  type UiAction,
  type UiState,
} from "./uiState";

export const contactTilePerformanceStages = [
  "resolution_commit",
  "ipc_response",
  "cache_merge",
  "react_commit",
  "last_tile_paint",
] as const;

export type ContactTilePerformanceStage = typeof contactTilePerformanceStages[number];

export interface ContactTilePerformanceStart {
  generation: number;
  resolution?: number;
  visibleTiles?: number;
  cacheHit?: boolean;
  /** Timestamp captured immediately before the resolution action is dispatched. */
  startedAt?: number;
}

export interface ContactTileRenderMilestone {
  generation: number;
  renderEpoch: number;
  canvasCount: number;
  commitTimestamp?: number;
}

/** Stage values are elapsed milliseconds from `resolution_commit`. */
export interface ContactTilePerformanceRecord {
  event: "contact_tiles_frontend";
  generation: number;
  resolution: number | null;
  visible_tiles: number;
  canvas_count: number;
  cache_hit: boolean;
  ipc_count: number;
  resolution_commit_ms: 0;
  ipc_response_ms: number | null;
  cache_merge_ms: number | null;
  react_commit_ms: number | null;
  last_tile_paint_ms: number | null;
  total_ms: number | null;
}

export interface ContactTilePerformanceOutput {
  record: ContactTilePerformanceRecord;
  logfmt: string;
}

interface ContactTilePerformanceRun {
  startedAt: number;
  record: ContactTilePerformanceRecord;
}

interface ContactTilePerformanceStorage {
  getItem(key: string): string | null;
}

export interface ContactTilePerformanceEnablementInput {
  viteFlag?: string;
  storage?: ContactTilePerformanceStorage | null;
  search?: string;
}

export interface ContactTilePerformanceTrackerOptions {
  enabled?: boolean;
  clock?: () => number;
  emit?: (output: ContactTilePerformanceOutput) => void;
}

const storageFlagName = "CSTUDIO_PERF_LOG";

/** Predicts only genuine resolution commits, so no-op UI actions cannot leak a stale start time. */
export function nextContactResolutionForPerformance(
  action: UiAction,
  state: UiState,
): ContactResolution | null {
  switch (action.type) {
    case "setContactResolution":
    case "adjustContactResolution":
    case "fitContactViewport":
    case "setContactViewportMetrics":
    case "zoomContactViewport":
      break;
    default:
      return null;
  }

  const resolution = reduceUiState(state, action).contact.resolution;
  return resolution === state.contact.resolution ? null : resolution;
}

export function isContactTilePerformanceEnabled(
  input: ContactTilePerformanceEnablementInput = {},
): boolean {
  const viteFlag = input.viteFlag
    ?? import.meta.env.CSTUDIO_PERF_LOG
    ?? import.meta.env.VITE_CSTUDIO_PERF_LOG;
  if (viteFlag === "1") {
    return true;
  }

  const storage = input.storage === undefined ? defaultStorage() : input.storage;
  try {
    if (storage?.getItem(storageFlagName) === "1") {
      return true;
    }
  } catch {
    // Storage can be unavailable in private or restricted WebView contexts.
  }

  const search = input.search ?? defaultLocationSearch();
  return new URLSearchParams(search).get("cstudioPerf") === "1";
}

export function formatContactTilePerformanceLog(
  record: ContactTilePerformanceRecord,
): string {
  return [
    "CSTUDIO_PERF",
    `event=${record.event}`,
    `generation=${record.generation}`,
    `resolution=${logValue(record.resolution)}`,
    `visible_tiles=${record.visible_tiles}`,
    `canvas_count=${record.canvas_count}`,
    `cache_hit=${record.cache_hit}`,
    `ipc_count=${record.ipc_count}`,
    `resolution_commit_ms=${record.resolution_commit_ms}`,
    `ipc_response_ms=${logValue(record.ipc_response_ms)}`,
    `cache_merge_ms=${logValue(record.cache_merge_ms)}`,
    `react_commit_ms=${logValue(record.react_commit_ms)}`,
    `last_tile_paint_ms=${logValue(record.last_tile_paint_ms)}`,
    `total_ms=${logValue(record.total_ms)}`,
  ].join(" ");
}

export class ContactTilePerformanceTracker {
  readonly enabled: boolean;

  private readonly clock: () => number;
  private readonly emit: (output: ContactTilePerformanceOutput) => void;
  private latestGeneration = Number.NEGATIVE_INFINITY;
  private activeRun: ContactTilePerformanceRun | null = null;

  constructor(options: ContactTilePerformanceTrackerOptions = {}) {
    this.enabled = options.enabled ?? isContactTilePerformanceEnabled();
    this.clock = options.clock ?? defaultClock;
    this.emit = options.emit ?? ((output) => console.info(output.logfmt));
  }

  timestamp(): number {
    return this.clock();
  }

  startGeneration(input: ContactTilePerformanceStart): boolean {
    if (
      !this.enabled
      || !Number.isSafeInteger(input.generation)
      || input.generation < 0
      || input.generation <= this.latestGeneration
    ) {
      return false;
    }

    this.latestGeneration = input.generation;
    const requestedStart = input.startedAt;
    this.activeRun = {
      startedAt: requestedStart !== undefined && Number.isFinite(requestedStart)
        ? requestedStart
        : this.clock(),
      record: {
        event: "contact_tiles_frontend",
        generation: input.generation,
        resolution: finiteNumberOrNull(input.resolution),
        visible_tiles: nonNegativeInteger(input.visibleTiles),
        canvas_count: 0,
        cache_hit: input.cacheHit ?? false,
        ipc_count: 0,
        resolution_commit_ms: 0,
        ipc_response_ms: null,
        cache_merge_ms: null,
        react_commit_ms: null,
        last_tile_paint_ms: null,
        total_ms: null,
      },
    };
    return true;
  }

  markIpcResponse(generation: number): boolean {
    const run = this.runFor(generation);
    if (!run) {
      return false;
    }
    run.record.ipc_count += 1;
    // Keep the most recent response when a generation has multiple batches.
    run.record.ipc_response_ms = this.elapsed(run);
    return true;
  }

  supersedeBefore(generation: number): boolean {
    if (
      !this.enabled
      || !Number.isSafeInteger(generation)
      || generation < 0
      || !this.activeRun
      || this.activeRun.record.generation >= generation
    ) {
      return false;
    }
    this.activeRun = null;
    return true;
  }

  markCacheMerge(generation: number): boolean {
    return this.markElapsed(generation, "cache_merge_ms");
  }

  markReactCommit(
    generation: number,
    canvasCount?: number,
    occurredAt?: number,
  ): boolean {
    const run = this.runFor(generation);
    if (!run) {
      return false;
    }
    run.record.canvas_count = nonNegativeInteger(canvasCount);
    run.record.react_commit_ms = this.elapsed(run, occurredAt);
    return true;
  }

  markLastTilePaint(
    generation: number,
    canvasCount?: number,
  ): ContactTilePerformanceOutput | null {
    const run = this.runFor(generation);
    if (!run) {
      return null;
    }

    const elapsed = this.elapsed(run);
    run.record.canvas_count = nonNegativeInteger(canvasCount ?? run.record.canvas_count);
    run.record.last_tile_paint_ms = elapsed;
    run.record.total_ms = elapsed;
    const record = { ...run.record };
    const output = {
      record,
      logfmt: formatContactTilePerformanceLog(record),
    };
    this.activeRun = null;
    try {
      this.emit(output);
    } catch {
      // Diagnostics must never interrupt the contact-map rendering path.
    }
    return output;
  }

  snapshot(generation: number): ContactTilePerformanceRecord | null {
    const run = this.runFor(generation);
    return run ? { ...run.record } : null;
  }

  private runFor(generation: number): ContactTilePerformanceRun | null {
    return this.enabled && this.activeRun?.record.generation === generation
      ? this.activeRun
      : null;
  }

  private elapsed(run: ContactTilePerformanceRun, occurredAt?: number): number {
    const end = occurredAt !== undefined && Number.isFinite(occurredAt)
      ? occurredAt
      : this.clock();
    return roundMilliseconds(Math.max(0, end - run.startedAt));
  }

  private markElapsed(
    generation: number,
    field: "cache_merge_ms" | "react_commit_ms",
  ): boolean {
    const run = this.runFor(generation);
    if (!run) {
      return false;
    }
    run.record[field] = this.elapsed(run);
    return true;
  }
}

export function createContactTilePerformanceTracker(
  options: ContactTilePerformanceTrackerOptions = {},
): ContactTilePerformanceTracker {
  return new ContactTilePerformanceTracker(options);
}

function defaultClock(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function defaultStorage(): ContactTilePerformanceStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function defaultLocationSearch(): string {
  try {
    return typeof location === "undefined" ? "" : location.search;
  } catch {
    return "";
  }
}

function finiteNumberOrNull(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) ? value : null;
}

function nonNegativeInteger(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function logValue(value: number | null): string {
  return value === null ? "null" : String(value);
}
