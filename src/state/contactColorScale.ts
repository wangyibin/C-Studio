import type { ContactMapView } from "../App";

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

export function contactCountSampleForColorScale(contactMap: ContactMapView): number[] {
  if (contactMap.tiles && contactMap.tiles.length > 0) {
    const counts: number[] = [];

    for (const tile of contactMap.tiles) {
      for (const cell of tile.cells) {
        counts.push(cell.count);
      }
    }

    return counts;
  }

  return contactMap.cells.map((cell) => cell.count);
}

export function estimateContactColorScale(counts: number[], log: boolean): ContactColorScale {
  const values = counts.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);

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
  const max = values[thresholdIndex] ?? defaultColorScale.max;

  return {
    log,
    min: 0,
    max,
    auto: true,
  };
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
