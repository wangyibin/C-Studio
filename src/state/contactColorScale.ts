import type { ContactMapView } from "../App";
import { appendContactTileCounts } from "./contactTileData";

export interface ContactColorScale {
  log: boolean;
  min: number;
  max: number;
  auto: boolean;
}

const juiceboxAutoThresholdPercentile = 95;

const defaultColorScale = {
  log: false,
  min: 0,
  max: 1,
  auto: true,
};

/**
 * Keep one visual threshold while comparing normalization modes. Data/tile
 * caches remain mode-specific, but independently auto-fitting every mode can
 * make genuinely different matrices look nearly identical.
 */
export function contactAutoColorScaleKey(
  coolPath: string,
  targetResolution: number,
  tileSizeBins: number,
  log: boolean,
): string {
  return [
    coolPath,
    targetResolution,
    tileSizeBins,
    log ? "log" : "linear",
  ].join("|");
}

export function contactCountSampleForColorScale(contactMap: ContactMapView): number[] {
  if (contactMap.tiles && contactMap.tiles.length > 0) {
    const counts: number[] = [];

    for (const tile of contactMap.tiles) {
      appendContactTileCounts(tile, counts);
    }

    return counts;
  }

  return contactMap.cells.map((cell) => cell.count);
}

export function estimateContactColorScale(counts: number[], log: boolean): ContactColorScale {
  const values = counts.filter((value) => Number.isFinite(value) && value > 0);

  if (values.length === 0) {
    return {
      ...defaultColorScale,
      log,
    };
  }

  // Juicebox uses the raw 95th percentile of the visible, stored contact
  // records as the automatic threshold. Sparse matrices do not contain zero
  // records, so filtering non-positive values mirrors that record set.
  const thresholdIndex = Math.min(
    values.length - 1,
    Math.floor((juiceboxAutoThresholdPercentile / 100) * values.length),
  );
  const max = selectKthInPlace(values, thresholdIndex);

  return {
    log,
    min: 0,
    max,
    auto: true,
  };
}

/**
 * Select the zero-based kth value without sorting the whole sample. The
 * median-of-three pivot keeps monotonic inputs balanced, while the three-way
 * partition collapses repeated values in one pass.
 */
function selectKthInPlace(values: number[], kth: number): number {
  let left = 0;
  let right = values.length - 1;

  while (left < right) {
    const middle = left + Math.floor((right - left) / 2);
    const pivot = medianOfThree(values[left], values[middle], values[right]);
    let lower = left;
    let cursor = left;
    let upper = right;

    while (cursor <= upper) {
      if (values[cursor] < pivot) {
        swap(values, lower, cursor);
        lower += 1;
        cursor += 1;
      } else if (values[cursor] > pivot) {
        swap(values, cursor, upper);
        upper -= 1;
      } else {
        cursor += 1;
      }
    }

    if (kth < lower) {
      right = lower - 1;
    } else if (kth > upper) {
      left = upper + 1;
    } else {
      return values[kth];
    }
  }

  return values[left];
}

function medianOfThree(first: number, middle: number, last: number): number {
  if (first < middle) {
    if (middle < last) {
      return middle;
    }
    return first < last ? last : first;
  }

  if (first < last) {
    return first;
  }

  return middle < last ? last : middle;
}

function swap(values: number[], firstIndex: number, secondIndex: number) {
  if (firstIndex === secondIndex) {
    return;
  }

  const first = values[firstIndex];
  values[firstIndex] = values[secondIndex];
  values[secondIndex] = first;
}

export function normalizeContactValue(value: number, scale: Pick<ContactColorScale, "log" | "min" | "max">) {
  const min = Math.max(0, scale.min);
  const max = Math.max(min, scale.max);

  if (max === min) {
    return value >= max ? 1 : 0;
  }

  if (!scale.log) {
    return clamp01((value - min) / (max - min));
  }

  return clamp01((Math.log10(value + 1) - Math.log10(min + 1)) / (Math.log10(max + 1) - Math.log10(min + 1)));
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number) {
  return clamp(value, 0, 1);
}
