import type { ContactViewport } from "./contactViewport";

type ViewportListener = (viewport: ContactViewport | null) => void;

export interface ContactViewportPresentation {
  getViewport: () => ContactViewport | null;
  publish: ViewportListener;
  subscribe: (listener: ViewportListener) => () => void;
}

/** Share the displayed camera without rendering AppShell on every pan frame. */
export function createContactViewportPresentation(): ContactViewportPresentation {
  let current: ContactViewport | null = null;
  const listeners = new Set<ViewportListener>();
  return {
    getViewport: () => current,
    publish(viewport) {
      if (
        current === viewport
        || (current && viewport
          && current.xStart === viewport.xStart && current.xEnd === viewport.xEnd
          && current.yStart === viewport.yStart && current.yEnd === viewport.yEnd)
      ) {
        return;
      }
      current = viewport;
      for (const listener of listeners) {
        listener(current);
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      // The Overview can mount after the heatmap has already published, or
      // reappear after another inspector tab was open during navigation.
      listener(current);
      return () => { listeners.delete(listener); };
    },
  };
}
