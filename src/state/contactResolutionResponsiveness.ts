export interface ContactResolutionResponsivenessRecord {
  event: "contact_resolution_responsiveness";
  generation: number;
  terminal_gpu_paint_ms: number;
  observer: "longtask" | "unavailable";
  long_task_count: number;
  long_task_total_ms: number;
  long_task_max_ms: number;
  frame_gap_over_50_count: number;
  frame_gap_over_50_total_ms: number;
  frame_gap_over_50_max_ms: number;
}

export interface ContactResolutionResponsivenessOutput {
  record: ContactResolutionResponsivenessRecord;
  logfmt: string;
}

interface LongTaskObserverLike {
  observe(options: PerformanceObserverInit): void;
  disconnect(): void;
  takeRecords?: () => PerformanceEntry[];
}

interface ResponsivenessRun {
  generation: number;
  startedAt: number;
  lastFrameAt: number;
  observer: LongTaskObserverLike | null;
  rafId: number | null;
  longTaskDurations: number[];
  frameGapDurations: number[];
}

export interface ContactResolutionResponsivenessOptions {
  enabled?: boolean;
  clock?: () => number;
  requestAnimationFrame?: ((callback: FrameRequestCallback) => number) | null;
  cancelAnimationFrame?: ((id: number) => void) | null;
  createLongTaskObserver?: ((callback: PerformanceObserverCallback) => LongTaskObserverLike | null) | null;
  emit?: (output: ContactResolutionResponsivenessOutput) => void;
}

const longTaskThresholdMs = 50;

/**
 * Performance-only monitor for one resolution transition. The Long Tasks API
 * is used when WKWebView exposes it; frame gaps remain available as a portable
 * responsiveness proxy and are deliberately named separately from long tasks.
 */
export class ContactResolutionResponsivenessTracker {
  readonly enabled: boolean;

  private readonly clock: () => number;
  private readonly requestFrame: ((callback: FrameRequestCallback) => number) | null;
  private readonly cancelFrame: ((id: number) => void) | null;
  private readonly createObserver: (
    (callback: PerformanceObserverCallback) => LongTaskObserverLike | null
  ) | null;
  private readonly emit: (output: ContactResolutionResponsivenessOutput) => void;
  private run: ResponsivenessRun | null = null;

  constructor(options: ContactResolutionResponsivenessOptions = {}) {
    this.enabled = options.enabled ?? false;
    this.clock = options.clock ?? defaultClock;
    this.requestFrame = options.requestAnimationFrame === undefined
      ? defaultRequestAnimationFrame()
      : options.requestAnimationFrame;
    this.cancelFrame = options.cancelAnimationFrame === undefined
      ? defaultCancelAnimationFrame()
      : options.cancelAnimationFrame;
    this.createObserver = options.createLongTaskObserver === undefined
      ? defaultLongTaskObserverFactory()
      : options.createLongTaskObserver;
    this.emit = options.emit ?? ((output) => console.info(output.logfmt));
  }

  startGeneration(generation: number, startedAt = this.clock()): boolean {
    if (!this.enabled || !Number.isSafeInteger(generation) || generation < 0) {
      return false;
    }
    this.cancelRun();
    const safeStartedAt = Number.isFinite(startedAt) ? startedAt : this.clock();
    const run: ResponsivenessRun = {
      generation,
      startedAt: safeStartedAt,
      lastFrameAt: safeStartedAt,
      observer: null,
      rafId: null,
      longTaskDurations: [],
      frameGapDurations: [],
    };
    this.run = run;
    run.observer = this.createObserver?.((entries) => {
      this.collectLongTasks(run, entries.getEntries());
    }) ?? null;
    try {
      run.observer?.observe({ type: "longtask", buffered: false });
    } catch {
      run.observer?.disconnect();
      run.observer = null;
    }
    this.scheduleFrame(run);
    return true;
  }

  supersedeBefore(generation: number): boolean {
    if (!this.run || this.run.generation >= generation) {
      return false;
    }
    this.cancelRun();
    return true;
  }

  retargetGeneration(generation: number): boolean {
    if (
      !this.run
      || !Number.isSafeInteger(generation)
      || generation < this.run.generation
    ) {
      return false;
    }
    this.run.generation = generation;
    return true;
  }

  activeGeneration(): number | null {
    return this.run?.generation ?? null;
  }

  finishActiveGeneration(): ContactResolutionResponsivenessOutput | null {
    const generation = this.run?.generation;
    return generation === undefined ? null : this.finishGeneration(generation);
  }

  finishGeneration(generation: number): ContactResolutionResponsivenessOutput | null {
    const run = this.run?.generation === generation ? this.run : null;
    if (!run) {
      return null;
    }
    this.collectLongTasks(run, run.observer?.takeRecords?.() ?? []);
    const record: ContactResolutionResponsivenessRecord = {
      event: "contact_resolution_responsiveness",
      generation,
      terminal_gpu_paint_ms: roundMilliseconds(Math.max(0, this.clock() - run.startedAt)),
      observer: run.observer ? "longtask" : "unavailable",
      long_task_count: run.longTaskDurations.length,
      long_task_total_ms: roundedSum(run.longTaskDurations),
      long_task_max_ms: roundedMax(run.longTaskDurations),
      frame_gap_over_50_count: run.frameGapDurations.length,
      frame_gap_over_50_total_ms: roundedSum(run.frameGapDurations),
      frame_gap_over_50_max_ms: roundedMax(run.frameGapDurations),
    };
    const output = { record, logfmt: formatContactResolutionResponsivenessLog(record) };
    this.cancelRun();
    try {
      this.emit(output);
    } catch {
      // Performance diagnostics must never interrupt rendering.
    }
    return output;
  }

  private scheduleFrame(run: ResponsivenessRun) {
    if (!this.requestFrame) {
      return;
    }
    run.rafId = this.requestFrame((timestamp) => {
      if (this.run !== run) {
        return;
      }
      const gap = timestamp - run.lastFrameAt;
      if (Number.isFinite(gap) && gap > longTaskThresholdMs) {
        run.frameGapDurations.push(gap);
      }
      run.lastFrameAt = timestamp;
      this.scheduleFrame(run);
    });
  }

  private collectLongTasks(run: ResponsivenessRun, entries: readonly PerformanceEntry[]) {
    if (this.run !== run) {
      return;
    }
    for (const entry of entries) {
      if (
        entry.startTime >= run.startedAt
        && Number.isFinite(entry.duration)
        && entry.duration >= longTaskThresholdMs
      ) {
        run.longTaskDurations.push(entry.duration);
      }
    }
  }

  private cancelRun() {
    const run = this.run;
    this.run = null;
    if (!run) {
      return;
    }
    if (run.rafId !== null) {
      this.cancelFrame?.(run.rafId);
    }
    run.observer?.disconnect();
  }
}

export function formatContactResolutionResponsivenessLog(
  record: ContactResolutionResponsivenessRecord,
): string {
  return [
    "CSTUDIO_PERF",
    `event=${record.event}`,
    `generation=${record.generation}`,
    `terminal_gpu_paint_ms=${record.terminal_gpu_paint_ms}`,
    `observer=${record.observer}`,
    `long_task_count=${record.long_task_count}`,
    `long_task_total_ms=${record.long_task_total_ms}`,
    `long_task_max_ms=${record.long_task_max_ms}`,
    `frame_gap_over_50_count=${record.frame_gap_over_50_count}`,
    `frame_gap_over_50_total_ms=${record.frame_gap_over_50_total_ms}`,
    `frame_gap_over_50_max_ms=${record.frame_gap_over_50_max_ms}`,
  ].join(" ");
}

export function createContactResolutionResponsivenessTracker(
  options: ContactResolutionResponsivenessOptions = {},
) {
  return new ContactResolutionResponsivenessTracker(options);
}

function defaultClock(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function defaultRequestAnimationFrame() {
  return typeof window === "undefined"
    ? null
    : window.requestAnimationFrame.bind(window);
}

function defaultCancelAnimationFrame() {
  return typeof window === "undefined"
    ? null
    : window.cancelAnimationFrame.bind(window);
}

function defaultLongTaskObserverFactory() {
  if (
    typeof PerformanceObserver === "undefined"
    || !PerformanceObserver.supportedEntryTypes?.includes("longtask")
  ) {
    return null;
  }
  return (callback: PerformanceObserverCallback) => new PerformanceObserver(callback);
}

function roundedSum(values: readonly number[]): number {
  return roundMilliseconds(values.reduce((sum, value) => sum + value, 0));
}

function roundedMax(values: readonly number[]): number {
  return roundMilliseconds(values.length > 0 ? Math.max(...values) : 0);
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
