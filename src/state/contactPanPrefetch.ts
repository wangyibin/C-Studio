import type { ContactMapTile } from "../App";
import type { ContactViewport } from "./contactViewport";

export interface ContactPanPrefetchBatch {
  tiles: readonly ContactMapTile[];
  resolution: number;
  tileSizeBins: number;
  viewport: ContactViewport;
}

export type ContactPanPrefetchConsumer = (batch: ContactPanPrefetchBatch) => void;

/**
 * Imperative cache-to-GPU bridge used only while a pan is active. Publishing a
 * batch must not enter React state: the currently presented scene stays frozen
 * while its renderer accepts additional leading-edge textures.
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
