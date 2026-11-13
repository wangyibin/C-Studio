import type { ContactViewport } from "./contactViewport";
import type { CoverageView, CoverageViewportLoader } from "./coverageView";

export function coveragePanTransform(source: ContactViewport, target: ContactViewport) {
  const sourceSpan = Math.max(1, source.xEnd - source.xStart);
  const targetSpan = Math.max(1, target.xEnd - target.xStart);
  return {
    width: `${sourceSpan / targetSpan * 100}%`,
    transform: `translateX(${(source.xStart - target.xStart) / sourceSpan * 100}%)`,
  };
}

function covers(source: ContactViewport, target: ContactViewport) {
  return source.xStart <= target.xStart && source.xEnd >= target.xEnd;
}

function coveragePanRequest(viewport: ContactViewport, displayResolution: number) {
  // Keep a half-screen margin, capped at 2,048 extra bins on each side.
  const padding = Math.min((viewport.xEnd - viewport.xStart) / 2, displayResolution * 2_048);
  return {
    displayResolution,
    viewport: {
      xStart: Math.max(0, Math.floor((viewport.xStart - padding) / displayResolution) * displayResolution),
      xEnd: Math.ceil((viewport.xEnd + padding) / displayResolution) * displayResolution,
      yStart: 0,
      yEnd: 1,
    },
  };
}

/** One active read and one latest target; pointer events never build coverage. */
export function createCoveragePanLoader(
  load: CoverageViewportLoader,
  onData: (view: CoverageView) => void,
) {
  type Request = Parameters<CoverageViewportLoader>[0];
  let disposed = false;
  let flight: Request | null = null;
  let pending: Request | null = null;
  let latest: Request | null = null;
  let cached: CoverageView | null = null;

  async function pump() {
    if (disposed || flight || !pending) return;
    const request = pending;
    pending = null;
    flight = request;
    try {
      const view = await load(request);
      if (!disposed && latest && view.resolution === latest.displayResolution
        && view.viewport.xEnd > latest.viewport.xStart && view.viewport.xStart < latest.viewport.xEnd) {
        cached = view;
        onData(view);
        if (covers(view.viewport, latest.viewport)) pending = null;
      }
    } catch {
      // Keep the retained track on a failed speculative read. The committed
      // coverage loader remains responsible for reporting persistent failures.
    } finally {
      flight = null;
      if (!disposed) void pump();
    }
  }

  return {
    request(viewport: ContactViewport, base: CoverageView) {
      if (disposed) return;
      latest = { viewport, displayResolution: base.resolution };
      if (covers(base.viewport, viewport)) {
        pending = null;
        return;
      }
      if (cached?.resolution === base.resolution && covers(cached.viewport, viewport)) {
        pending = null;
        onData(cached);
        return;
      }
      if (flight?.displayResolution === base.resolution && covers(flight.viewport, viewport)) {
        pending = null;
        return;
      }
      pending = coveragePanRequest(viewport, base.resolution);
      void pump();
    },
    cancel() { latest = null; pending = null; },
    dispose() { disposed = true; latest = null; pending = null; cached = null; },
  };
}

export type CoveragePanLoader = ReturnType<typeof createCoveragePanLoader>;
