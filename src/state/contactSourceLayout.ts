import type { ContactMapLayoutBlock } from "./importers";
import type { ContactSourceMetadata } from "./contactSourceResolution";
import type { ContactViewport } from "./contactViewport";
import {
  canonicalContactTile,
  contactTileKey,
  type ContactMapTileKey,
} from "./contactTiles";

export const contactGpuLayoutMapValidFlag = 1;
export const contactGpuLayoutMapReverseFlag = 2;
export const contactGpuLayoutMapExactFlag = 4;

export interface ContactSourceAddress {
  sourceId: string;
  ordinal: number;
  sourceLength: number;
  globalStart: number;
  globalEnd: number;
}

export interface ContactSourceAddressSpace {
  sources: readonly ContactSourceAddress[];
  bySourceId: ReadonlyMap<string, ContactSourceAddress>;
  totalSpan: number;
}

export interface ContactGpuLayoutMapEntry {
  visualBin: number;
  valid: boolean;
  exact: boolean;
  reverse: boolean;
  sourceId: string | null;
  sourceOrdinal: number;
  sourcePosition: number;
  sourceGlobalPosition: number;
  sourceGlobalBin: number;
  sourceTile: number;
  sourceLocalBin: number;
  copyCount: number;
  copyWeight: number;
}

export interface ContactGpuLayoutMap {
  firstVisualBin: number;
  resolution: number;
  tileSizeBins: number;
  entries: readonly ContactGpuLayoutMapEntry[];
  /** RGBA32UI: source tile, local bin, flags, source ordinal. */
  addressData: Uint32Array;
  /** R32F reciprocal local placement count. */
  weightData: Float32Array;
}

export interface ContactGpuSourceTilePlan {
  tiles: readonly ContactMapTileKey[];
  sourceTiles: readonly number[];
}

interface SourceShareInterval {
  start: number;
  end: number;
  count: number;
}

/** Build the immutable COOL/source axis used by the GPU atlas. */
export function buildContactSourceAddressSpace(
  sources: ReadonlyArray<ContactSourceMetadata>,
): ContactSourceAddressSpace {
  const addresses: ContactSourceAddress[] = [];
  const bySourceId = new Map<string, ContactSourceAddress>();
  let globalStart = 0;
  for (const source of sources) {
    const sourceId = source.name.trim();
    if (
      sourceId.length === 0
      || !Number.isSafeInteger(source.length)
      || source.length <= 0
    ) {
      throw new RangeError("contact source names and lengths must be valid");
    }
    if (bySourceId.has(sourceId)) {
      throw new RangeError(`duplicate contact source: ${sourceId}`);
    }
    const globalEnd = globalStart + source.length;
    if (!Number.isSafeInteger(globalEnd)) {
      throw new RangeError("contact source address space exceeds safe integer coordinates");
    }
    const address: ContactSourceAddress = {
      sourceId,
      ordinal: addresses.length,
      sourceLength: source.length,
      globalStart,
      globalEnd,
    };
    addresses.push(address);
    bySourceId.set(sourceId, address);
    globalStart = globalEnd;
  }
  return { sources: addresses, bySourceId, totalSpan: globalStart };
}

/** Identity layout for requesting immutable source-space tiles from the backend. */
export function contactSourceIdentityLayout(
  addressSpace: ContactSourceAddressSpace,
  resolution: number,
): ContactMapLayoutBlock[] {
  requirePositiveSafeInteger(resolution, "resolution");
  let visualStart = 0;
  return addressSpace.sources.map((source) => {
    const block = {
      id: `source:${source.ordinal}:${source.sourceId}`,
      objectId: source.sourceId,
      sourceId: source.sourceId,
      sourceStart: 0,
      sourceEnd: source.sourceLength,
      visualStart,
      visualEnd: visualStart + source.sourceLength,
      orientation: "+" as const,
      componentType: "W",
    };
    visualStart += Math.ceil(source.sourceLength / resolution) * resolution;
    return block;
  });
}

/**
 * Build the viewport-sized visual-bin -> immutable source-bin lookup.
 *
 * The reciprocal copy weight exactly matches ContactMapViewBuilder's local
 * source-placement rule. `exact=false` preserves a useful display preview for
 * an unaligned edit while preventing it from replacing authoritative tiles.
 */
export function buildContactGpuLayoutMap({
  addressSpace,
  layoutBlocks,
  resolution,
  tileSizeBins,
  viewport,
  overscanBins = 0,
}: {
  addressSpace: ContactSourceAddressSpace;
  layoutBlocks: readonly ContactMapLayoutBlock[];
  resolution: number;
  tileSizeBins: number;
  viewport: Pick<ContactViewport, "xStart" | "xEnd">;
  overscanBins?: number;
}): ContactGpuLayoutMap {
  requirePositiveSafeInteger(resolution, "resolution");
  requirePositiveSafeInteger(tileSizeBins, "tile size");
  if (
    !Number.isSafeInteger(viewport.xStart)
    || !Number.isSafeInteger(viewport.xEnd)
    || viewport.xStart < 0
    || viewport.xEnd <= viewport.xStart
    || !Number.isSafeInteger(overscanBins)
    || overscanBins < 0
  ) {
    throw new RangeError("contact layout viewport and overscan must be valid");
  }
  const firstVisualBin = Math.max(0, Math.floor(viewport.xStart / resolution) - overscanBins);
  const lastVisualBin = Math.ceil(viewport.xEnd / resolution) - 1 + overscanBins;
  const sortedBlocks = layoutBlocks
    .filter(isValidLayoutBlock)
    .slice()
    .sort((left, right) => left.visualStart - right.visualStart || left.visualEnd - right.visualEnd);
  assertNonOverlappingVisualBlocks(sortedBlocks);
  const sourceShares = buildSourceShareIntervals(sortedBlocks);
  const entries: ContactGpuLayoutMapEntry[] = Array.from(
    { length: lastVisualBin - firstVisualBin + 1 },
    (_, index) => invalidLayoutMapEntry(firstVisualBin + index),
  );
  const addressData = new Uint32Array((lastVisualBin - firstVisualBin + 1) * 4);
  const weightData = new Float32Array(lastVisualBin - firstVisualBin + 1);
  const sourceBinStarts = contactSourceBinStarts(addressSpace, resolution);

  for (const block of sortedBlocks) {
    const address = addressSpace.bySourceId.get(block.sourceId);
    if (!address) {
      continue;
    }
    const reverse = block.orientation === "-";
    const shares = sourceShares.get(block.sourceId) ?? [];
    const blockExact = layoutMapBlockIsExact(
      block,
      address,
      shares,
      resolution,
    );
    const firstSourceBin = Math.floor(block.sourceStart / resolution);
    const lastSourceBin = Math.floor((block.sourceEnd - 1) / resolution);
    for (let sourceBin = firstSourceBin; sourceBin <= lastSourceBin; sourceBin += 1) {
      const sourcePosition = Math.max(block.sourceStart, sourceBin * resolution);
      const visualOffset = reverse
        ? block.sourceEnd - block.sourceStart - (sourcePosition - block.sourceStart) - 1
        : sourcePosition - block.sourceStart;
      const visualPosition = block.visualStart + visualOffset;
      const visualBin = Math.floor(visualPosition / resolution);
      if (visualBin < firstVisualBin || visualBin > lastVisualBin) {
        continue;
      }
      const copyCount = sourceShareCountAt(shares, sourcePosition);
      if (copyCount <= 0) {
        continue;
      }
      const sourceGlobalBin = sourceBinStarts[address.ordinal]! + sourceBin;
      const sourceTile = Math.floor(sourceGlobalBin / tileSizeBins);
      if (sourceTile > 0xffff_ffff) {
        throw new RangeError("contact source tile address exceeds RGBA32UI capacity");
      }
      const entryIndex = visualBin - firstVisualBin;
      const existing = entries[entryIndex]!;
      const exact = blockExact && !existing.valid;
      if (existing.valid) {
        entries[entryIndex] = { ...existing, exact: false };
        continue;
      }
      entries[entryIndex] = {
        visualBin,
        valid: true,
        exact,
        reverse,
        sourceId: block.sourceId,
        sourceOrdinal: address.ordinal,
        sourcePosition,
        sourceGlobalPosition: sourceBinStarts[address.ordinal]! * resolution + sourcePosition,
        sourceGlobalBin,
        sourceTile,
        sourceLocalBin: sourceGlobalBin % tileSizeBins,
        copyCount,
        copyWeight: 1 / copyCount,
      };
    }
  }

  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    const entry = entries[entryIndex]!;
    if (!entry.valid) {
      continue;
    }
    const flags = contactGpuLayoutMapValidFlag
      | (entry.reverse ? contactGpuLayoutMapReverseFlag : 0)
      | (entry.exact ? contactGpuLayoutMapExactFlag : 0);
    const dataOffset = entryIndex * 4;
    addressData[dataOffset] = entry.sourceTile;
    addressData[dataOffset + 1] = entry.sourceLocalBin;
    addressData[dataOffset + 2] = flags;
    addressData[dataOffset + 3] = entry.sourceOrdinal;
    weightData[entryIndex] = entry.copyWeight;
  }

  return {
    firstVisualBin,
    resolution,
    tileSizeBins,
    entries,
    addressData,
    weightData,
  };
}

export function contactGpuLayoutMapEntryAt(
  map: ContactGpuLayoutMap,
  visualBin: number,
) {
  return map.entries[visualBin - map.firstVisualBin] ?? null;
}

/** Apply the same endpoint-local copy conservation as the Rust projector. */
export function contactGpuMappedContactValue(
  sourceCount: number,
  x: ContactGpuLayoutMapEntry,
  y: ContactGpuLayoutMapEntry,
) {
  if (!x.valid || !y.valid || !Number.isFinite(sourceCount)) {
    return 0;
  }
  return sourceCount * x.copyWeight * y.copyWeight;
}

/**
 * Return the canonical source-space tile cross product needed by two axis maps.
 * Repeated visual copies collapse onto the same immutable source tile.
 */
export function contactGpuSourceTilePlan(
  xMap: ContactGpuLayoutMap,
  yMap: ContactGpuLayoutMap,
): ContactGpuSourceTilePlan {
  if (
    xMap.resolution !== yMap.resolution
    || xMap.tileSizeBins !== yMap.tileSizeBins
  ) {
    throw new RangeError("contact source layout maps must share one tile grid");
  }
  const xSourceTiles = [...new Set(
    xMap.entries.filter((entry) => entry.valid).map((entry) => entry.sourceTile),
  )].sort((left, right) => left - right);
  const ySourceTiles = [...new Set(
    yMap.entries.filter((entry) => entry.valid).map((entry) => entry.sourceTile),
  )].sort((left, right) => left - right);
  const sourceTiles = [...new Set([...xSourceTiles, ...ySourceTiles])]
    .sort((left, right) => left - right);
  const tilesByKey = new Map<string, ContactMapTileKey>();
  for (const tileY of ySourceTiles) {
    for (const tileX of xSourceTiles) {
      const tile = canonicalContactTile({ tileX, tileY });
      tilesByKey.set(contactTileKey(tile), tile);
    }
  }
  return { tiles: [...tilesByKey.values()], sourceTiles };
}

/** A source-space shader is authoritative only at fully aligned valid bins. */
export function contactGpuLayoutMapIsExact(map: ContactGpuLayoutMap) {
  return map.entries.every((entry) => !entry.valid || entry.exact);
}

/** Replace sparse global source tile ids with a compact shader page index. */
export function contactGpuCompactLayoutAddressData(
  map: ContactGpuLayoutMap,
  sourceTiles: readonly number[],
) {
  const compactBySourceTile = new Map(
    sourceTiles.map((sourceTile, index) => [sourceTile, index] as const),
  );
  const compact = map.addressData.slice();
  map.entries.forEach((entry, index) => {
    if (!entry.valid) {
      return;
    }
    const page = compactBySourceTile.get(entry.sourceTile);
    if (page === undefined) {
      throw new RangeError(`source tile ${entry.sourceTile} is absent from the compact page axis`);
    }
    compact[index * 4] = page;
  });
  return compact;
}

function invalidLayoutMapEntry(visualBin: number): ContactGpuLayoutMapEntry {
  return {
    visualBin,
    valid: false,
    exact: true,
    reverse: false,
    sourceId: null,
    sourceOrdinal: 0,
    sourcePosition: 0,
    sourceGlobalPosition: 0,
    sourceGlobalBin: 0,
    sourceTile: 0,
    sourceLocalBin: 0,
    copyCount: 0,
    copyWeight: 0,
  };
}

function buildSourceShareIntervals(
  blocks: readonly ContactMapLayoutBlock[],
): Map<string, SourceShareInterval[]> {
  const eventsBySource = new Map<string, Array<{ position: number; delta: number }>>();
  for (const block of blocks) {
    const events = eventsBySource.get(block.sourceId) ?? [];
    events.push({ position: block.sourceStart, delta: 1 });
    events.push({ position: block.sourceEnd, delta: -1 });
    eventsBySource.set(block.sourceId, events);
  }
  const intervalsBySource = new Map<string, SourceShareInterval[]>();
  for (const [sourceId, events] of eventsBySource) {
    events.sort((left, right) => left.position - right.position || left.delta - right.delta);
    const intervals: SourceShareInterval[] = [];
    let count = 0;
    let previous = events[0]?.position ?? 0;
    let index = 0;
    while (index < events.length) {
      const position = events[index]!.position;
      if (position > previous && count > 0) {
        intervals.push({ start: previous, end: position, count });
      }
      while (index < events.length && events[index]!.position === position) {
        count += events[index]!.delta;
        index += 1;
      }
      previous = position;
    }
    intervalsBySource.set(sourceId, intervals);
  }
  return intervalsBySource;
}

function sourceShareCountAt(
  intervals: readonly SourceShareInterval[] | undefined,
  sourcePosition: number,
) {
  if (!intervals || intervals.length === 0) {
    return 0;
  }
  let low = 0;
  let high = intervals.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const interval = intervals[middle]!;
    if (sourcePosition < interval.start) {
      high = middle - 1;
    } else if (sourcePosition >= interval.end) {
      low = middle + 1;
    } else {
      return interval.count;
    }
  }
  return 0;
}

function contactSourceBinStarts(
  addressSpace: ContactSourceAddressSpace,
  resolution: number,
) {
  const starts: number[] = [];
  let nextBin = 0;
  for (const source of addressSpace.sources) {
    starts.push(nextBin);
    nextBin += Math.ceil(source.sourceLength / resolution);
  }
  return starts;
}

function layoutMapBlockIsExact(
  block: ContactMapLayoutBlock,
  address: ContactSourceAddress,
  shares: readonly SourceShareInterval[],
  resolution: number,
) {
  const sourceBoundaryIsExact = (position: number) => (
    position % resolution === 0 || position === address.sourceLength
  );
  const placementIsAligned = block.orientation === "-"
    ? (block.visualStart + block.sourceEnd) % resolution === 0
    : positiveModulo(block.visualStart - block.sourceStart, resolution) === 0;
  return placementIsAligned
    && sourceBoundaryIsExact(block.sourceStart)
    && sourceBoundaryIsExact(block.sourceEnd)
    && shares.every((share) => (
      sourceBoundaryIsExact(share.start)
      && sourceBoundaryIsExact(share.end)
    ));
}

function positiveModulo(value: number, divisor: number) {
  return ((value % divisor) + divisor) % divisor;
}

function isValidLayoutBlock(block: ContactMapLayoutBlock) {
  return Number.isSafeInteger(block.visualStart)
    && Number.isSafeInteger(block.visualEnd)
    && Number.isSafeInteger(block.sourceStart)
    && Number.isSafeInteger(block.sourceEnd)
    && block.visualStart >= 0
    && block.visualEnd > block.visualStart
    && block.sourceStart >= 0
    && block.sourceEnd > block.sourceStart
    && block.visualEnd - block.visualStart === block.sourceEnd - block.sourceStart;
}

function assertNonOverlappingVisualBlocks(blocks: readonly ContactMapLayoutBlock[]) {
  for (let index = 1; index < blocks.length; index += 1) {
    if (blocks[index]!.visualStart < blocks[index - 1]!.visualEnd) {
      throw new RangeError("contact layout blocks must not overlap visually");
    }
  }
}

function requirePositiveSafeInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}
