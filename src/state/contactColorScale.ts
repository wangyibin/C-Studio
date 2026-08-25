/*
 * Portions of this file are adapted from Juicebox's ColorScaleHandler.java at
 * upstream revision 9697464526f6474ea3cc4f10b4269929e4fd72fe:
 * https://github.com/aidenlab/Juicebox/blob/9697464526f6474ea3cc4f10b4269929e4fd72fe/src/juicebox/mapcolorui/ColorScaleHandler.java
 *
 * The TypeScript implementation has been rewritten and modified for C-Studio.
 *
 * The MIT License (MIT)
 *
 * Copyright (c) 2011-2021 Broad Institute, Aiden Lab, Rice University,
 * Baylor College of Medicine
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NON-INFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

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
