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
