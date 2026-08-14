import type { ContactMapView } from "../App";
import { contactTilesWithPreviewFallback } from "./contactMapView";
import { forEachContactTileCell } from "./contactTileData";
import type { GfaGraphNode } from "./gfa";
import type { ContactMapLayoutBlock } from "./importers";

export interface GfaHiCLink {
  id: string;
  source: string;
  target: string;
  rawCount: number;
  normalizedCountPerMb2: number;
  lineWidth: number;
}

interface BinMembership {
  id: string;
  weight: number;
}

interface AggregatedPair {
  source: string;
  target: string;
  rawCount: number;
  normalizedCountPerMb2: number;
}

export const maximumGfaHiCLinks = 2_500;

/** Reject an overview whose pixels were projected against an older AGP edit. */
export function gfaHiCContactMapUsesLayout(
  contactMap: ContactMapView,
  assemblyBlocks: ReadonlyArray<ContactMapLayoutBlock>,
) {
  const snapshot = contactMap.layoutBlocks;
  if (!snapshot || snapshot.length !== assemblyBlocks.length) {
    return false;
  }
  const currentById = new Map(assemblyBlocks.map((block) => [block.id, block]));
  return snapshot.every((block) => {
    const current = currentById.get(block.id);
    return current
      && current.sourceId === block.sourceId
      && current.sourceStart === block.sourceStart
      && current.sourceEnd === block.sourceEnd
      && current.visualStart === block.visualStart
      && current.visualEnd === block.visualEnd
      && current.orientation === block.orientation;
  });
}

/**
 * Aggregate the screen-scale whole-assembly Hi-C overview into unitig pairs.
 *
 * A coarse overview bin can cross several unitigs. Its count is apportioned by
 * each unitig's overlap with that bin, then divided by the product of the two
 * placement lengths. The reported score is therefore contacts per Mb^2. The
 * overview is already copy-conserving and normalized by the selected Cooler
 * normalization, so this function must not re-expand source occurrences.
 */
export function buildLengthNormalizedGfaHiCLinks(
  contactMap: ContactMapView,
  assemblyBlocks: ReadonlyArray<ContactMapLayoutBlock>,
  graphNodes: ReadonlyArray<Pick<GfaGraphNode, "id" | "occurrenceId">>,
  maxLinks = maximumGfaHiCLinks,
  partnersPerUnitig?: number,
): GfaHiCLink[] {
  if (
    !Number.isFinite(contactMap.resolution)
    || contactMap.resolution <= 0
    || !Number.isSafeInteger(maxLinks)
    || maxLinks <= 0
    || (partnersPerUnitig !== undefined && (
      !Number.isSafeInteger(partnersPerUnitig) || partnersPerUnitig <= 0
    ))
  ) {
    return [];
  }

  const placedNodeIds = new Set(
    graphNodes
      .filter((node) => node.occurrenceId !== null)
      .map((node) => node.id),
  );
  const eligibleBlocks = assemblyBlocks
    .filter((block) => (
      placedNodeIds.has(block.id)
      && Number.isFinite(block.visualStart)
      && Number.isFinite(block.visualEnd)
      && block.visualEnd > block.visualStart
    ));
  if (eligibleBlocks.length < 2) {
    return [];
  }

  const lengthsMb = new Map(eligibleBlocks.map((block) => [
    block.id,
    (block.visualEnd - block.visualStart) / 1_000_000,
  ]));
  const visualOrder = new Map(
    [...eligibleBlocks]
      .sort((left, right) => (
        left.visualStart - right.visualStart
        || left.visualEnd - right.visualEnd
        || left.id.localeCompare(right.id)
      ))
      .map((block, index) => [block.id, index]),
  );
  const membershipsByBin = blockMembershipsByBin(
    eligibleBlocks,
    contactMap.resolution,
  );
  const countsByPair = new Map<string, AggregatedPair>();

  forEachOverviewCell(contactMap, (xBin, yBin, count) => {
    if (!Number.isFinite(count) || count <= 0) {
      return;
    }
    const xMemberships = membershipsByBin.get(xBin);
    const yMemberships = membershipsByBin.get(yBin);
    if (!xMemberships || !yMemberships) {
      return;
    }
    for (const xMembership of xMemberships) {
      for (const yMembership of yMemberships) {
        if (xMembership.id === yMembership.id) {
          continue;
        }
        const [source, target] = orderedUnitigPair(
          xMembership.id,
          yMembership.id,
          visualOrder,
        );
        const contribution = count * xMembership.weight * yMembership.weight;
        if (!Number.isFinite(contribution) || contribution <= 0) {
          continue;
        }
        const key = `${source}\u0000${target}`;
        const existing = countsByPair.get(key);
        if (existing) {
          existing.rawCount += contribution;
        } else {
          countsByPair.set(key, {
            source,
            target,
            rawCount: contribution,
            normalizedCountPerMb2: 0,
          });
        }
      }
    }
  });

  const allRanked = [...countsByPair.values()]
    .map((pair) => {
      const sourceLengthMb = lengthsMb.get(pair.source) ?? 0;
      const targetLengthMb = lengthsMb.get(pair.target) ?? 0;
      return {
        ...pair,
        normalizedCountPerMb2: sourceLengthMb > 0 && targetLengthMb > 0
          ? pair.rawCount / (sourceLengthMb * targetLengthMb)
          : 0,
      };
    })
    .filter((pair) => (
      Number.isFinite(pair.normalizedCountPerMb2)
      && pair.normalizedCountPerMb2 > 0
    ))
    .sort((left, right) => (
      right.normalizedCountPerMb2 - left.normalizedCountPerMb2
      || right.rawCount - left.rawCount
      || left.source.localeCompare(right.source)
      || left.target.localeCompare(right.target)
    ));
  const ranked = partnersPerUnitig === undefined
    ? allRanked.slice(0, maxLinks)
    : selectPartnersForEveryUnitig(allRanked, partnersPerUnitig);
  const maximumScore = ranked[0]?.normalizedCountPerMb2 ?? 0;

  return ranked.map((pair) => ({
    id: `hic:${pair.source}:${pair.target}`,
    source: pair.source,
    target: pair.target,
    rawCount: pair.rawCount,
    normalizedCountPerMb2: pair.normalizedCountPerMb2,
    lineWidth: hiCLinkLineWidth(pair.normalizedCountPerMb2, maximumScore),
  }));
}

/**
 * Union each unitig's strongest coarse partners without a global edge cap.
 * This keeps weak unitigs eligible for endpoint L/R scoring even when many
 * unrelated high-signal pairs exist elsewhere in the assembly.
 */
function selectPartnersForEveryUnitig(
  ranked: ReadonlyArray<AggregatedPair>,
  partnersPerUnitig: number,
) {
  const incidentRanks = new Map<string, number>();
  return ranked.filter((pair) => {
    const sourceRank = (incidentRanks.get(pair.source) ?? 0) + 1;
    const targetRank = (incidentRanks.get(pair.target) ?? 0) + 1;
    incidentRanks.set(pair.source, sourceRank);
    incidentRanks.set(pair.target, targetRank);
    return sourceRank <= partnersPerUnitig || targetRank <= partnersPerUnitig;
  });
}

function blockMembershipsByBin(
  blocks: ReadonlyArray<ContactMapLayoutBlock>,
  resolution: number,
) {
  const overlapsByBin = new Map<number, Array<{ id: string; overlap: number }>>();
  for (const block of blocks) {
    const firstBin = Math.floor(block.visualStart / resolution);
    const lastBin = Math.floor((block.visualEnd - 1) / resolution);
    for (let bin = firstBin; bin <= lastBin; bin += 1) {
      const overlap = Math.min(block.visualEnd, (bin + 1) * resolution)
        - Math.max(block.visualStart, bin * resolution);
      if (overlap <= 0) {
        continue;
      }
      const values = overlapsByBin.get(bin) ?? [];
      values.push({ id: block.id, overlap });
      overlapsByBin.set(bin, values);
    }
  }

  const membershipsByBin = new Map<number, BinMembership[]>();
  for (const [bin, overlaps] of overlapsByBin) {
    const totalOverlap = overlaps.reduce((sum, entry) => sum + entry.overlap, 0);
    if (totalOverlap <= 0) {
      continue;
    }
    membershipsByBin.set(bin, overlaps.map((entry) => ({
      id: entry.id,
      weight: entry.overlap / totalOverlap,
    })));
  }
  return membershipsByBin;
}

function forEachOverviewCell(
  contactMap: ContactMapView,
  visit: (xBin: number, yBin: number, count: number) => void,
) {
  const hasTileLayers = contactMap.cachedTiles !== undefined
    || contactMap.tiles !== undefined
    || contactMap.previewTiles !== undefined;
  if (!hasTileLayers) {
    for (const cell of contactMap.cells) {
      visit(cell.xBin, cell.yBin, cell.count);
    }
    return;
  }

  const tileSizeBins = contactMap.tileSizeBins ?? 256;
  const authoritativeTiles = contactMap.cachedTiles ?? contactMap.tiles ?? [];
  const tiles = contactTilesWithPreviewFallback(
    authoritativeTiles,
    contactMap.previewTiles ?? [],
  );
  for (const tile of tiles) {
    const tileStartX = tile.tileX * tileSizeBins * contactMap.resolution;
    const tileEndX = tileStartX + tileSizeBins * contactMap.resolution;
    const tileStartY = tile.tileY * tileSizeBins * contactMap.resolution;
    const tileEndY = tileStartY + tileSizeBins * contactMap.resolution;
    if (
      tileEndX <= contactMap.viewport.xStart
      || tileStartX >= contactMap.viewport.xEnd
      || tileEndY <= contactMap.viewport.yStart
      || tileStartY >= contactMap.viewport.yEnd
    ) {
      continue;
    }
    forEachContactTileCell(tile, tileSizeBins, visit);
  }
}

function orderedUnitigPair(
  first: string,
  second: string,
  visualOrder: ReadonlyMap<string, number>,
): [string, string] {
  const firstOrder = visualOrder.get(first) ?? Number.MAX_SAFE_INTEGER;
  const secondOrder = visualOrder.get(second) ?? Number.MAX_SAFE_INTEGER;
  return firstOrder < secondOrder || (firstOrder === secondOrder && first.localeCompare(second) <= 0)
    ? [first, second]
    : [second, first];
}

function hiCLinkLineWidth(score: number, maximumScore: number) {
  if (score <= 0 || maximumScore <= 0) {
    return 0.9;
  }
  const strength = Math.log1p(score) / Math.log1p(maximumScore);
  return 0.9 + 4.5 * Math.min(1, Math.max(0, strength));
}
