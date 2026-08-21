import type { ContactMapTile } from "../App";
import type { ContactViewport } from "./contactViewport";

export interface ContactPanPrefetchBatch {
  tiles: readonly ContactMapTile[];
  generation: number;
  resolution: number;
  tileSizeBins: number;
  viewport: ContactViewport;
}

export type ContactPanPrefetchConsumer = (batch: ContactPanPrefetchBatch) => void;

export interface ContactPanTileLoadPriorityInput {
  /** True only while pointer or wheel input is still advancing the camera. */
  previewActive: boolean;
  /** Preserve pan timing across the final committed generation. */
  hasPendingPan: boolean;
  missingVisibleTileCount: number;
  normalVisibleBatchSize: number;
  activePanVisibleBatchSize: number;
  urgentPrefetchTileCount: number;
}

export interface ContactPanTileLoadPriority {
  visibleBatchSize: number;
  urgentPrefetchTileCount: number;
}

export interface ContactPanSettledGeneration {
  generation: number;
  reusePanGeneration: boolean;
}

export type ContactPanPrefetchTaskPriority = "visible" | "lead" | "prefetch";

export interface ContactPanPrefetchQueueTask {
  key: string;
  priority: ContactPanPrefetchTaskPriority;
  sequence: number;
  run: () => Promise<void>;
  onError?: (error: unknown) => void;
}

interface QueuedContactPanPrefetchTask extends ContactPanPrefetchQueueTask {
  order: number;
}

export interface ContactPanPrefetchQueueSnapshot {
  pendingKeys: string[];
  runningKeys: string[];
  runningPrefetchCount: number;
}

/**
 * Bounded pan scheduler with three spatial priorities. Already-started work is
 * never cancelled; replacing the pending frontier only discards work that has
 * not begun. Current visible tiles start first, velocity-predicted leading
 * tiles fill otherwise idle lanes, and speculative side warming remains capped
 * to half of the default four lanes.
 */
export class ContactPanPrefetchPriorityQueue {
  private readonly pending = new Map<string, QueuedContactPanPrefetchTask>();
  private readonly running = new Map<string, QueuedContactPanPrefetchTask>();
  private nextOrder = 0;
  private runningPrefetchCount = 0;
  private readonly concurrency: number;
  private readonly prefetchConcurrency: number;

  constructor({
    concurrency = 4,
    prefetchConcurrency = 2,
  }: {
    concurrency?: number;
    prefetchConcurrency?: number;
  } = {}) {
    const safeConcurrency = Number.isFinite(concurrency) ? Math.floor(concurrency) : 4;
    const safePrefetchConcurrency = Number.isFinite(prefetchConcurrency)
      ? Math.floor(prefetchConcurrency)
      : 2;
    this.concurrency = Math.min(4, Math.max(2, safeConcurrency));
    this.prefetchConcurrency = Math.min(
      this.concurrency - 1,
      Math.max(1, safePrefetchConcurrency),
    );
  }

  /** Replace only work that has not started; matching in-flight work survives. */
  replacePending(tasks: readonly ContactPanPrefetchQueueTask[]) {
    this.pending.clear();
    for (const task of tasks) {
      if (this.running.has(task.key)) {
        continue;
      }
      const candidate: QueuedContactPanPrefetchTask = {
        ...task,
        order: this.nextOrder,
      };
      this.nextOrder += 1;
      const current = this.pending.get(task.key);
      if (!current || this.compare(candidate, current) < 0) {
        this.pending.set(task.key, candidate);
      }
    }
    this.pump();
  }

  clearPending() {
    this.pending.clear();
  }

  snapshot(): ContactPanPrefetchQueueSnapshot {
    return {
      pendingKeys: this.sortedPending().map(({ key }) => key),
      runningKeys: [...this.running.keys()],
      runningPrefetchCount: this.runningPrefetchCount,
    };
  }

  private compare(
    left: QueuedContactPanPrefetchTask,
    right: QueuedContactPanPrefetchTask,
  ) {
    const priorityRank = (priority: ContactPanPrefetchTaskPriority) => {
      if (priority === "visible") return 0;
      if (priority === "lead") return 1;
      return 2;
    };
    const leftPriority = priorityRank(left.priority);
    const rightPriority = priorityRank(right.priority);
    return leftPriority - rightPriority
      || right.sequence - left.sequence
      || left.order - right.order;
  }

  private sortedPending() {
    return [...this.pending.values()].sort((left, right) => this.compare(left, right));
  }

  private nextEligibleTask() {
    return this.sortedPending().find((task) => (
      task.priority !== "prefetch"
      || this.runningPrefetchCount < this.prefetchConcurrency
    ));
  }

  private pump() {
    while (this.running.size < this.concurrency) {
      const task = this.nextEligibleTask();
      if (!task) {
        return;
      }
      this.pending.delete(task.key);
      this.running.set(task.key, task);
      if (task.priority === "prefetch") {
        this.runningPrefetchCount += 1;
      }
      void Promise.resolve()
        .then(task.run)
        .catch((error: unknown) => task.onError?.(error))
        .finally(() => {
          if (this.running.get(task.key) !== task) {
            return;
          }
          this.running.delete(task.key);
          if (task.priority === "prefetch") {
            this.runningPrefetchCount = Math.max(0, this.runningPrefetchCount - 1);
          }
          this.pump();
        });
    }
  }
}

/** Keep pointer-prefetch latency bounded by publishing center-first small batches. */
export function contactPanPrefetchBatches<T>(
  values: readonly T[],
  batchSize: number,
): T[][] {
  const size = Number.isFinite(batchSize) ? Math.max(1, Math.floor(batchSize)) : 1;
  const batches: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    batches.push(values.slice(index, index + size));
  }
  return batches;
}

/**
 * A committed pan consumes the generation that already owns its diagonal
 * flights. Unrelated viewport changes advance normally so stale pan work never
 * becomes the owner of a later render.
 */
export function contactPanSettledGeneration(
  currentGeneration: number,
  settledViewport: ContactViewport,
  pendingPanViewport: ContactViewport | null,
  panGeneration: number | null,
): ContactPanSettledGeneration {
  const toleranceBp = 1;
  const matchesPendingPan = pendingPanViewport !== null
    && Math.abs(settledViewport.xStart - pendingPanViewport.xStart) <= toleranceBp
    && Math.abs(settledViewport.xEnd - pendingPanViewport.xEnd) <= toleranceBp
    && Math.abs(settledViewport.yStart - pendingPanViewport.yStart) <= toleranceBp
    && Math.abs(settledViewport.yEnd - pendingPanViewport.yEnd) <= toleranceBp;
  if (matchesPendingPan && panGeneration === currentGeneration) {
    return { generation: panGeneration, reusePanGeneration: true };
  }
  return {
    generation: currentGeneration + 1,
    reusePanGeneration: false,
  };
}

/**
 * While a pan is active, keep its small center-first batches and directional
 * lead. Once the wheel/pointer stops, the active viewport is authoritative:
 * submit every missing visible tile before any directional warming work.
 */
export function contactPanTileLoadPriority({
  previewActive,
  hasPendingPan,
  missingVisibleTileCount,
  normalVisibleBatchSize,
  activePanVisibleBatchSize,
  urgentPrefetchTileCount,
}: ContactPanTileLoadPriorityInput): ContactPanTileLoadPriority {
  const missing = Number.isFinite(missingVisibleTileCount)
    ? Math.max(0, Math.floor(missingVisibleTileCount))
    : 0;
  const normalBatch = Number.isFinite(normalVisibleBatchSize)
    ? Math.max(1, Math.floor(normalVisibleBatchSize))
    : 1;
  const activePanBatch = Number.isFinite(activePanVisibleBatchSize)
    ? Math.max(1, Math.floor(activePanVisibleBatchSize))
    : 1;
  const urgent = Number.isFinite(urgentPrefetchTileCount)
    ? Math.max(0, Math.floor(urgentPrefetchTileCount))
    : 0;

  if (previewActive) {
    return {
      visibleBatchSize: activePanBatch,
      urgentPrefetchTileCount: urgent,
    };
  }
  if (hasPendingPan) {
    return {
      visibleBatchSize: Math.max(1, missing),
      urgentPrefetchTileCount: 0,
    };
  }
  return {
    visibleBatchSize: normalBatch,
    urgentPrefetchTileCount: 0,
  };
}

/**
 * Imperative cache-to-GPU bridge used only while a pan is active. Publishing a
 * batch must not enter React state: the currently presented scene stays frozen
 * while its renderer accepts additional or cumulatively refreshed textures.
 */
export class ContactPanPrefetchBridge {
  private consumers = new Set<ContactPanPrefetchConsumer>();

  subscribe(consumer: ContactPanPrefetchConsumer) {
    this.consumers.add(consumer);
    return () => {
      this.consumers.delete(consumer);
    };
  }

  publish(batch: ContactPanPrefetchBatch) {
    if (batch.tiles.length === 0) {
      return;
    }
    for (const consumer of this.consumers) {
      consumer(batch);
    }
  }
}
