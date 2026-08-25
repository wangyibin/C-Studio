import type { ContactViewport } from "./contactViewport";

export interface ContactPanPreview {
  viewport: ContactViewport;
  prefetchViewport?: ContactViewport;
  /**
   * Pan previews only warm tiles for the compositor transform. Replacement
   * previews load and present a complete temporary contact-map frame.
   */
  presentationMode?: "pan" | "replacement";
  /** Leading tiles promoted from background warming while a fast pan is active. */
  urgentPrefetchTileCount?: number;
  sequence: number;
  pointerTimestamp: number;
}

export function contactViewportPreviewIsReplacement(
  preview: ContactPanPreview | null,
): boolean {
  return preview?.presentationMode === "replacement";
}

export function contactViewportPreviewIsPan(
  preview: ContactPanPreview | null,
): boolean {
  return preview !== null && !contactViewportPreviewIsReplacement(preview);
}

export interface ContactPanPerformanceStart {
  generation: number;
  sequence: number;
  pointerTimestamp: number;
  visibleTiles: number;
  cacheHit: boolean;
}

export type ContactPanPerformanceStatus = "ok" | "superseded";

export interface ContactPanPerformanceRecord {
  event: "contact_pan_pipeline";
  status: ContactPanPerformanceStatus;
  generation: number;
  panSequence: number;
  visibleTiles: number;
  cacheHit: boolean;
  pointerToGenerationMs: number;
  pointerToIpcStartMs: number | null;
  ipcMs: number | null;
  pointerToCacheMergeMs: number | null;
  pointerToGpuPaintMs: number | null;
  totalMs: number | null;
}

export interface ContactPanPerformanceOutput {
  record: ContactPanPerformanceRecord;
  logfmt: string;
}

interface ContactPanPerformanceRun {
  pointerTimestamp: number;
  ipcStartedAt: number | null;
  record: ContactPanPerformanceRecord;
}

interface ContactPanPerformanceTimeline {
  mark(name: string, options?: { startTime?: number }): unknown;
  measure(name: string, options?: { start: string; end: string }): unknown;
}

export interface ContactPanPerformanceTrackerOptions {
  enabled?: boolean;
  clock?: () => number;
  emit?: (output: ContactPanPerformanceOutput) => void;
  timeline?: ContactPanPerformanceTimeline | null;
}

/**
 * Correlates the tile-boundary pointer sample with the generation it starts.
 * Superseded samples are emitted too, so fast drags do not hide cancelled work.
 */
export class ContactPanPerformanceTracker {
  readonly enabled: boolean;

  private readonly clock: () => number;
  private readonly emit: (output: ContactPanPerformanceOutput) => void;
  private readonly timeline: ContactPanPerformanceTimeline | null;
  private activeRun: ContactPanPerformanceRun | null = null;

  constructor(options: ContactPanPerformanceTrackerOptions = {}) {
    this.enabled = options.enabled ?? false;
    this.clock = options.clock ?? defaultClock;
    this.emit = options.emit ?? ((output) => console.info(output.logfmt));
    this.timeline = options.timeline === undefined ? defaultTimeline() : options.timeline;
  }

  startGeneration(input: ContactPanPerformanceStart): boolean {
    if (
      !this.enabled
      || !Number.isSafeInteger(input.generation)
      || !Number.isSafeInteger(input.sequence)
      || !Number.isFinite(input.pointerTimestamp)
    ) {
      return false;
    }
    if (
      this.activeRun?.record.panSequence === input.sequence
      && input.generation > this.activeRun.record.generation
    ) {
      this.activeRun.record.generation = input.generation;
      this.activeRun.record.visibleTiles = nonNegativeInteger(input.visibleTiles);
      this.activeRun.record.cacheHit = input.cacheHit;
      return true;
    }
    this.supersedeBefore(input.generation);
    const now = this.clock();
    const pointerTimestamp = Math.min(now, input.pointerTimestamp);
    this.activeRun = {
      pointerTimestamp,
      ipcStartedAt: null,
      record: {
        event: "contact_pan_pipeline",
        status: "ok",
        generation: input.generation,
        panSequence: input.sequence,
        visibleTiles: nonNegativeInteger(input.visibleTiles),
        cacheHit: input.cacheHit,
        pointerToGenerationMs: elapsed(pointerTimestamp, now),
        pointerToIpcStartMs: null,
        ipcMs: null,
        pointerToCacheMergeMs: null,
        pointerToGpuPaintMs: null,
        totalMs: null,
      },
    };
    this.mark(input.sequence, "pointermove", pointerTimestamp);
    this.mark(input.sequence, "generation", now);
    return true;
  }

  continueGeneration(generation: number): boolean {
    const run = this.activeRun;
    if (
      !this.enabled
      || !run
      || !Number.isSafeInteger(generation)
      || generation <= run.record.generation
    ) {
      return false;
    }
    run.record.generation = generation;
    return true;
  }

  markIpcStart(generation: number): boolean {
    const run = this.runFor(generation);
    if (!run || run.ipcStartedAt !== null) {
      return false;
    }
    const now = this.clock();
    run.ipcStartedAt = now;
    run.record.pointerToIpcStartMs = elapsed(run.pointerTimestamp, now);
    this.mark(run.record.panSequence, "ipc_start", now);
    return true;
  }

  markIpcResponse(generation: number): boolean {
    const run = this.runFor(generation);
    if (!run || run.record.ipcMs !== null) {
      return false;
    }
    const now = this.clock();
    if (run.ipcStartedAt !== null) {
      run.record.ipcMs = elapsed(run.ipcStartedAt, now);
    }
    this.mark(run.record.panSequence, "ipc_response", now);
    return true;
  }

  markCacheMerge(generation: number): boolean {
    const run = this.runFor(generation);
    if (!run || run.record.pointerToCacheMergeMs !== null) {
      return false;
    }
    const now = this.clock();
    run.record.pointerToCacheMergeMs = elapsed(run.pointerTimestamp, now);
    this.mark(run.record.panSequence, "cache_merge", now);
    return true;
  }

  markGpuPaint(generation: number): ContactPanPerformanceOutput | null {
    const run = this.runFor(generation);
    if (!run) {
      return null;
    }
    return this.finishGpuPaint(run);
  }

  markGpuPaintForSequence(sequence: number): ContactPanPerformanceOutput | null {
    const run = this.enabled && this.activeRun?.record.panSequence === sequence
      ? this.activeRun
      : null;
    if (!run) {
      return null;
    }
    return this.finishGpuPaint(run);
  }

  private finishGpuPaint(run: ContactPanPerformanceRun): ContactPanPerformanceOutput {
    const now = this.clock();
    const total = elapsed(run.pointerTimestamp, now);
    run.record.pointerToGpuPaintMs = total;
    run.record.totalMs = total;
    this.mark(run.record.panSequence, "gpu_paint", now);
    this.measure(run.record.panSequence, "pointermove_to_gpu_paint", "pointermove", "gpu_paint");
    this.activeRun = null;
    return this.output(run.record);
  }

  supersedeBefore(generation: number): ContactPanPerformanceOutput | null {
    const run = this.activeRun;
    if (!run || run.record.generation >= generation) {
      return null;
    }
    run.record.status = "superseded";
    this.activeRun = null;
    return this.output(run.record);
  }

  snapshot(generation: number): ContactPanPerformanceRecord | null {
    const run = this.runFor(generation);
    return run ? { ...run.record } : null;
  }

  activeSnapshot(): ContactPanPerformanceRecord | null {
    return this.enabled && this.activeRun ? { ...this.activeRun.record } : null;
  }

  private runFor(generation: number): ContactPanPerformanceRun | null {
    return this.enabled && this.activeRun?.record.generation === generation
      ? this.activeRun
      : null;
  }

  private output(record: ContactPanPerformanceRecord): ContactPanPerformanceOutput {
    const output = { record: { ...record }, logfmt: formatContactPanPerformanceLog(record) };
    try {
      this.emit(output);
    } catch {
      // Diagnostics must never interrupt interaction.
    }
    return output;
  }

  private mark(sequence: number, stage: string, startTime: number) {
    try {
      this.timeline?.mark(markName(sequence, stage), { startTime });
    } catch {
      // Performance Timeline support differs between WebKit versions.
    }
  }

  private measure(sequence: number, label: string, start: string, end: string) {
    try {
      this.timeline?.measure(markName(sequence, label), {
        start: markName(sequence, start),
        end: markName(sequence, end),
      });
    } catch {
      // Marks and terminal logs remain available if measure options are absent.
    }
  }
}

export function createContactPanPerformanceTracker(
  options: ContactPanPerformanceTrackerOptions = {},
) {
  return new ContactPanPerformanceTracker(options);
}

export function formatContactPanPerformanceLog(record: ContactPanPerformanceRecord): string {
  return [
    "CSTUDIO_PERF",
    `event=${record.event}`,
    `status=${record.status}`,
    `pan_sequence=${record.panSequence}`,
    `generation=${record.generation}`,
    `visible_tiles=${record.visibleTiles}`,
    `cache_hit=${record.cacheHit}`,
    `pointer_to_generation_ms=${record.pointerToGenerationMs}`,
    `pointer_to_ipc_start_ms=${logValue(record.pointerToIpcStartMs)}`,
    `ipc_ms=${logValue(record.ipcMs)}`,
    `pointer_to_cache_merge_ms=${logValue(record.pointerToCacheMergeMs)}`,
    `pointer_to_gpu_paint_ms=${logValue(record.pointerToGpuPaintMs)}`,
    `total_ms=${logValue(record.totalMs)}`,
  ].join(" ");
}

function markName(sequence: number, stage: string) {
  return `cstudio:contact-pan:${sequence}:${stage}`;
}

function defaultClock() {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function defaultTimeline(): ContactPanPerformanceTimeline | null {
  return typeof performance === "undefined" ? null : performance;
}

function elapsed(start: number, end: number) {
  return Math.round(Math.max(0, end - start) * 1_000) / 1_000;
}

function nonNegativeInteger(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function logValue(value: number | null) {
  return value === null ? "null" : String(value);
}
