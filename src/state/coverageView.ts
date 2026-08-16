import type { ContactViewport } from "./contactViewport";
import type { ContactMapLayoutBlock } from "./importers";

export interface BedGraphRecord {
  chrom: string;
  start: number;
  end: number;
  value: number;
}

export interface CoverageBinView {
  xBin: number;
  value: number;
}

export interface CoverageView {
  resolution: number;
  viewport: ContactViewport;
  bins: CoverageBinView[];
  /** Contact-tile generation whose camera/resolution this view was built for. */
  renderGeneration?: number;
}

export interface CoverageViewRequest {
  displayResolution: number;
  viewport: ContactViewport;
  layoutBlocks: ContactMapLayoutBlock[];
  bedgraphRecords: BedGraphRecord[];
}

interface CoverageViewRequestOptions {
  displayResolution?: number;
  viewport?: ContactViewport;
}

export function parseBedGraphText(text: string): BedGraphRecord[] {
  return text.split(/\r?\n/).flatMap((rawLine, index) => {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("track") || line.startsWith("browser")) {
      return [];
    }

    const columns = line.split(/\s+/);
    const start = Number(columns[1]);
    const end = Number(columns[2]);
    const value = Number(columns[3]);
    if (columns.length < 4 || !columns[0] || !Number.isFinite(start) || !Number.isFinite(end)
      || !Number.isFinite(value) || start < 0 || end <= start) {
      throw new Error(`Invalid bedGraph record on line ${index + 1}`);
    }

    return [{ chrom: columns[0], start, end, value }];
  });
}

export function coverageResolutionForSpan(totalSpanBp: number, targetBins = 256) {
  return Math.max(1, Math.ceil(Math.max(1, totalSpanBp) / Math.max(1, targetBins)));
}

export function buildCoverageViewRequest(
  records: BedGraphRecord[],
  layoutBlocks: ContactMapLayoutBlock[],
  totalSpanBp: number,
  options: CoverageViewRequestOptions = {},
): CoverageViewRequest {
  const span = Math.max(1, Math.round(totalSpanBp));
  const requestedViewport = options.viewport;
  // Keep the display camera identical to the heatmap. Rectangular whole-map
  // views deliberately extend their longer screen axis beyond the assembly;
  // coverage projection naturally yields no bins in that empty margin.
  const xStart = Math.max(0, Math.floor(requestedViewport?.xStart ?? 0));
  const xEnd = Math.max(xStart + 1, Math.ceil(requestedViewport?.xEnd ?? span));
  const displayResolution = options.displayResolution === undefined
    ? coverageResolutionForSpan(xEnd - xStart)
    : Math.max(1, Math.round(options.displayResolution));

  return {
    displayResolution,
    viewport: { xStart, xEnd, yStart: 0, yEnd: 1 },
    layoutBlocks,
    bedgraphRecords: records,
  };
}

export function buildBrowserCoverageView(request: CoverageViewRequest): CoverageView {
  const aggregate = new Map<number, { weightedSum: number; length: number }>();
  const blocksBySource = new Map<string, ContactMapLayoutBlock[]>();
  for (const block of request.layoutBlocks) {
    const sourceBlocks = blocksBySource.get(block.sourceId) ?? [];
    sourceBlocks.push(block);
    blocksBySource.set(block.sourceId, sourceBlocks);
  }

  for (const record of request.bedgraphRecords) {
    for (const block of blocksBySource.get(record.chrom) ?? []) {
      const overlapStart = Math.max(record.start, block.sourceStart);
      const overlapEnd = Math.min(record.end, block.sourceEnd);
      if (overlapStart >= overlapEnd) {
        continue;
      }

      const visualStart = block.orientation === "-"
        ? block.visualStart + block.sourceEnd - overlapEnd
        : block.visualStart + overlapStart - block.sourceStart;
      const visualEnd = block.orientation === "-"
        ? block.visualStart + block.sourceEnd - overlapStart
        : block.visualStart + overlapEnd - block.sourceStart;
      const firstBin = Math.floor(visualStart / request.displayResolution);
      const lastBin = Math.floor((visualEnd - 1) / request.displayResolution);

      for (let xBin = firstBin; xBin <= lastBin; xBin += 1) {
        const binStart = xBin * request.displayResolution;
        const binEnd = binStart + request.displayResolution;
        const length = Math.max(0, Math.min(visualEnd, binEnd) - Math.max(visualStart, binStart));
        if (length === 0 || binEnd <= request.viewport.xStart || binStart >= request.viewport.xEnd) {
          continue;
        }
        const current = aggregate.get(xBin) ?? { weightedSum: 0, length: 0 };
        current.weightedSum += record.value * length;
        current.length += length;
        aggregate.set(xBin, current);
      }
    }
  }

  return {
    resolution: request.displayResolution,
    viewport: request.viewport,
    bins: [...aggregate.entries()]
      .sort(([left], [right]) => left - right)
      .map(([xBin, coverage]) => ({
        xBin,
        value: coverage.length > 0 ? coverage.weightedSum / coverage.length : 0,
      })),
  };
}
