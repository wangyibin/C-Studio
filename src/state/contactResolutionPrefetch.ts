import type { ContactResolution } from "./uiState";

export interface ContactIdleTaskHost {
  requestIdleCallback?: (
    callback: IdleRequestCallback,
    options?: IdleRequestOptions,
  ) => number;
  cancelIdleCallback?: (handle: number) => void;
  setTimeout: (callback: () => void, delayMs: number) => number;
  clearTimeout: (handle: number) => void;
}

/** Return the immediately coarser and finer levels, in that order. */
export function adjacentContactResolutions(
  current: ContactResolution,
  availableLevels: readonly ContactResolution[],
): ContactResolution[] {
  const currentIndex = availableLevels.indexOf(current);
  if (currentIndex < 0) {
    return [];
  }

  return [
    availableLevels[currentIndex - 1],
    availableLevels[currentIndex + 1],
  ].filter((resolution): resolution is ContactResolution => resolution !== undefined);
}

/**
 * Round-robin a small set of resolution queues so one dense neighbor cannot
 * monopolize every idle slice before the other neighbor receives any tiles.
 */
export function interleaveContactPrefetchBatches<T>(
  queues: readonly (readonly T[])[],
): T[] {
  const interleaved: T[] = [];
  const maximumLength = queues.reduce(
    (maximum, queue) => Math.max(maximum, queue.length),
    0,
  );
  for (let index = 0; index < maximumLength; index += 1) {
    for (const queue of queues) {
      const value = queue[index];
      if (value !== undefined) {
        interleaved.push(value);
      }
    }
  }
  return interleaved;
}

/**
 * Schedule one small background step. Native idle callbacks are preferred;
 * older WebViews receive a conservative timer fallback.
 */
export function scheduleContactIdleTask(
  callback: () => void,
  host: ContactIdleTaskHost = window,
  fallbackDelayMs = 250,
): () => void {
  let active = true;
  if (host.requestIdleCallback && host.cancelIdleCallback) {
    const handle = host.requestIdleCallback(() => {
      if (!active) {
        return;
      }
      active = false;
      callback();
    });
    return () => {
      if (!active) {
        return;
      }
      active = false;
      host.cancelIdleCallback?.(handle);
    };
  }

  const handle = host.setTimeout(() => {
    if (!active) {
      return;
    }
    active = false;
    callback();
  }, Math.max(0, fallbackDelayMs));
  return () => {
    if (!active) {
      return;
    }
    active = false;
    host.clearTimeout(handle);
  };
}
