import type { ContactMapView } from "../App";
import { forEachContactTileCell } from "./contactTileData";

export interface ContactColorScale {
  log: boolean;
  min: number;
  max: number;
  auto: boolean;
}

// C-Studio displays the assembly-wide matrix, which corresponds to Juicebox
// Desktop's whole-genome view. Juicebox uses P99 there (P95 for a chromosome
// pair), samples every tenth record in each block, and excludes the diagonal.
const juiceboxAssemblyAutoThresholdPercentile = 99;
const juiceboxRecordSampleStride = 10;

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
  const counts: number[] = [];

  if (contactMap.tiles && contactMap.tiles.length > 0) {
    const tileSizeBins = contactMap.tileSizeBins ?? 256;

    for (const tile of contactMap.tiles) {
      forEachContactTileCell(tile, tileSizeBins, (xBin, yBin, count, index) => {
        if (index % juiceboxRecordSampleStride === 0 && xBin !== yBin) {
          counts.push(count);
        }
      });
    }

    return counts;
  }

  for (let index = 0; index < contactMap.cells.length; index += juiceboxRecordSampleStride) {
    const cell = contactMap.cells[index];
    if (cell.xBin !== cell.yBin) {
      counts.push(cell.count);
    }
  }

  return counts;
}

export function estimateContactColorScale(counts: number[], log: boolean): ContactColorScale {
  const values = counts.filter((value) => Number.isFinite(value) && value > 0);

  if (values.length === 0) {
    return {
      ...defaultColorScale,
      log,
    };
  }

  // DescriptiveStatistics#getPercentile uses Apache Commons Math's legacy
  // (N + 1) percentile interpolation. Juicebox stores the result as a float.
  values.sort((left, right) => left - right);
  const max = Math.fround(legacyPercentile(
    values,
    juiceboxAssemblyAutoThresholdPercentile,
  ));

  return {
    log,
    min: 0,
    max,
    auto: true,
  };
}

function legacyPercentile(sortedValues: number[], percentile: number): number {
  const position = (percentile * (sortedValues.length + 1)) / 100;
  if (position < 1) {
    return sortedValues[0];
  }
  if (position >= sortedValues.length) {
    return sortedValues[sortedValues.length - 1];
  }

  const lowerPosition = Math.floor(position);
  const lower = sortedValues[lowerPosition - 1];
  const upper = sortedValues[lowerPosition];
  return lower + (position - lowerPosition) * (upper - lower);
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
