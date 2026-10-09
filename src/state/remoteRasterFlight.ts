import { remoteRasterCovers } from "./remoteContactRaster";
import type { ContactViewport } from "./contactViewport";

/** One retained result or in-flight image. Pan previews never build a queue. */
export class RemoteRasterFlight<T> {
  private entry: {
    key: string; layout: object; viewport: ContactViewport;
    controller: AbortController; pending: boolean; promise: Promise<T>;
  } | null = null;

  request(input: {
    key: string; layout: object; viewport: ContactViewport; imageViewport: ContactViewport;
    preview: boolean; load: (signal: AbortSignal) => Promise<T>;
  }): Promise<T> | null {
    const previous = this.entry;
    const compatible = previous?.key === input.key && previous.layout === input.layout;
    if (previous && compatible && remoteRasterCovers(previous.viewport, input.viewport)) {
      return previous.promise;
    }
    // Let one useful image finish while the pointer moves. A settled camera
    // takes priority immediately if that image cannot cover its final position.
    if (previous?.pending && compatible && input.preview) return null;
    this.clear();
    const controller = new AbortController();
    const entry = {
      key: input.key, layout: input.layout, viewport: input.imageViewport,
      controller, pending: true, promise: null! as Promise<T>,
    };
    this.entry = entry;
    entry.promise = input.load(controller.signal).then((value) => {
      entry.pending = false;
      return value;
    }, (error) => {
      if (this.entry === entry) this.entry = null;
      throw error;
    });
    return entry.promise;
  }

  clear() {
    this.entry?.controller.abort();
    this.entry = null;
  }
}
