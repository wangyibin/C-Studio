import type { ContactMapLayoutBlock } from "./importers";
import {
  physicalSideForDisplayedEndpoint,
  type GfaDisplayedEndpoint,
  type GfaEndpointHiCLoadResult,
} from "./gfaEndpointHiC";
import type { GfaHiCLink } from "./gfaHiCLinks";
import type { GfaSegmentSide } from "./gfa";

export const defaultGfaEndpointHiCLinkLimit = 1;
export const maximumGfaEndpointHiCLinkLimit = 50;
const minimumOverviewPartnersPerContig = 4;
const overviewPartnerMultiplier = 4;

export interface GfaEndpointHiCCandidate {
  link: GfaHiCLink;
  overviewRank: number;
  preferred?: boolean;
}

export interface GfaEndpointHiCResultEntry {
  candidate: GfaEndpointHiCCandidate;
  result: GfaEndpointHiCLoadResult;
}

export interface GfaEndpointHiCLink {
  id: string;
  source: string;
  target: string;
  sourceEndpoint: GfaDisplayedEndpoint;
  targetEndpoint: GfaDisplayedEndpoint;
  sourceSide: GfaSegmentSide;
  targetSide: GfaSegmentSide;
  rawCount: number;
  normalizedCountPerMb2: number;
  overviewNormalizedCountPerMb2: number;
  contrastToNext: number | null;
  resolution: number;
  overviewRank: number;
  sourceEndpointRank: number;
  targetEndpointRank: number;
  lineWidth: number;
  preferred?: boolean;
}

export function normalizeGfaEndpointHiCLinkLimit(value: number) {
  if (!Number.isFinite(value)) {
    return defaultGfaEndpointHiCLinkLimit;
  }
  return Math.min(
    maximumGfaEndpointHiCLinkLimit,
    Math.max(1, Math.round(value)),
  );
}

/** Number of coarse partners retained for every unitig before endpoint scoring. */
export function gfaEndpointHiCOverviewPartnerLimit(requestedLinkLimit: number) {
  return Math.max(
    minimumOverviewPartnersPerContig,
    normalizeGfaEndpointHiCLinkLimit(requestedLinkLimit) * overviewPartnerMultiplier,
  );
}

/**
 * Screen candidates fairly per contig using the whole-unitig,
 * length-normalized overview. Every drawable contig contributes its strongest
 * partner pairs before local endpoint evidence performs the final L/R ranking.
 * There is deliberately no global edge cap here: one weak contig must not be
 * dropped merely because unrelated strong pairs exhausted a shared budget.
 */
export function selectGfaEndpointHiCCandidates(
  visibleOverviewLinks: ReadonlyArray<GfaHiCLink>,
  requestedLinkLimit: number,
  preferredLinkIds: ReadonlySet<string> = new Set<string>(),
): GfaEndpointHiCCandidate[] {
  const linkLimit = normalizeGfaEndpointHiCLinkLimit(requestedLinkLimit);
  const partnersPerContig = gfaEndpointHiCOverviewPartnerLimit(linkLimit);
  const globalRankById = new Map<string, number>();
  const uniqueLinks: GfaHiCLink[] = [];
  for (const link of visibleOverviewLinks) {
    if (link.source === link.target || globalRankById.has(link.id)) {
      continue;
    }
    globalRankById.set(link.id, uniqueLinks.length + 1);
    uniqueLinks.push(link);
  }
  const incidentByContig = new Map<string, GfaHiCLink[]>();
  for (const link of uniqueLinks) {
    for (const contigId of [link.source, link.target]) {
      const incident = incidentByContig.get(contigId) ?? [];
      incident.push(link);
      incidentByContig.set(contigId, incident);
    }
  }

  const selectedById = new Map<string, GfaHiCLink>();
  for (const link of uniqueLinks) {
    if (preferredLinkIds.has(link.id)) {
      selectedById.set(link.id, link);
    }
  }
  for (
    let localRank = 0;
    localRank < partnersPerContig;
    localRank += 1
  ) {
    const roundById = new Map<string, GfaHiCLink>();
    for (const incident of incidentByContig.values()) {
      const link = incident[localRank];
      if (link) {
        roundById.set(link.id, link);
      }
    }
    const round = [...roundById.values()].sort((left, right) => (
      (globalRankById.get(left.id) ?? Number.MAX_SAFE_INTEGER)
      - (globalRankById.get(right.id) ?? Number.MAX_SAFE_INTEGER)
    ));
    for (const link of round) {
      selectedById.set(link.id, link);
    }
  }
  return [...selectedById.values()]
    .sort((left, right) => (
      (globalRankById.get(left.id) ?? Number.MAX_SAFE_INTEGER)
      - (globalRankById.get(right.id) ?? Number.MAX_SAFE_INTEGER)
    ))
    .map((link) => ({
      link,
      overviewRank: globalRankById.get(link.id) ?? Number.MAX_SAFE_INTEGER,
      preferred: preferredLinkIds.has(link.id),
    }));
}

/** A placement-aware cache key; edits and normalization changes cannot reuse stale evidence. */
export function gfaEndpointHiCPairCacheKey(
  source: ContactMapLayoutBlock,
  target: ContactMapLayoutBlock,
  layoutScope: string | null | undefined,
  normalization: string | null | undefined,
) {
  return [
    source.id,
    source.visualStart,
    source.visualEnd,
    source.orientation,
    target.id,
    target.visualStart,
    target.visualEnd,
    target.orientation,
    layoutScope ?? "no-layout-scope",
    normalization ?? "raw",
  ].join("\u0000");
}

/**
 * Convert all four quadrants of complete endpoint evidence into physical GFA
 * ports. Rank incident links independently for every contig start/end and
 * retain a pair only when it is within Top X at both physical ports. This
 * strict intersection guarantees that no port is drawn with more than X links.
 */
export function buildRankedGfaEndpointHiCLinks(
  entries: ReadonlyArray<GfaEndpointHiCResultEntry>,
  assemblyBlocks: ReadonlyArray<ContactMapLayoutBlock>,
  requestedLinkLimit: number,
): GfaEndpointHiCLink[] {
  const blocksById = new Map(assemblyBlocks.map((block) => [block.id, block]));
  const endpointPairs = entries.flatMap(({ candidate, result }) => {
    if (
      result.status !== "ready"
      || !result.evidence.complete
    ) {
      return [];
    }
    const sourceBlock = blocksById.get(candidate.link.source);
    const targetBlock = blocksById.get(candidate.link.target);
    if (!sourceBlock || !targetBlock) {
      return [];
    }
    return result.evidence.quadrants.flatMap((quadrant) => {
      const sourceSide = physicalSideForDisplayedEndpoint(
        sourceBlock.orientation,
        quadrant.sourceEndpoint,
      );
      const targetSide = physicalSideForDisplayedEndpoint(
        targetBlock.orientation,
        quadrant.targetEndpoint,
      );
      if (!sourceSide || !targetSide) {
        return [];
      }
      const isPairBest = result.evidence.bestQuadrant?.sourceEndpoint === quadrant.sourceEndpoint
        && result.evidence.bestQuadrant.targetEndpoint === quadrant.targetEndpoint;
      return [{
        id: `endpoint-hic:${candidate.link.source}:${sourceSide}:${candidate.link.target}:${targetSide}`,
        source: candidate.link.source,
        target: candidate.link.target,
        sourceEndpoint: quadrant.sourceEndpoint,
        targetEndpoint: quadrant.targetEndpoint,
        sourceSide,
        targetSide,
        rawCount: quadrant.rawCount,
        normalizedCountPerMb2: quadrant.normalizedCountPerMb2,
        overviewNormalizedCountPerMb2: candidate.link.normalizedCountPerMb2,
        contrastToNext: isPairBest ? result.evidence.contrastToNext : null,
        resolution: result.evidence.resolution,
        overviewRank: candidate.overviewRank,
        sourceEndpointRank: 0,
        targetEndpointRank: 0,
        lineWidth: 0,
        preferred: candidate.preferred === true,
      }];
    });
  }).filter((link) => (
    Number.isFinite(link.normalizedCountPerMb2)
    && link.normalizedCountPerMb2 > 0
  ));
  const uniqueById = new Map<string, GfaEndpointHiCLink>();
  for (const link of endpointPairs) {
    const existing = uniqueById.get(link.id);
    if (!existing || compareEndpointHiCLinks(link, existing) < 0) {
      uniqueById.set(link.id, link);
    }
  }
  const ranked = [...uniqueById.values()].sort(compareEndpointHiCLinks);
  const rankByEndpoint = new Map<string, number>();
  const perEndpointLimit = normalizeGfaEndpointHiCLinkLimit(requestedLinkLimit);
  const selected = ranked.flatMap((link) => {
    const sourceKey = physicalEndpointKey(link.source, link.sourceSide);
    const targetKey = physicalEndpointKey(link.target, link.targetSide);
    const sourceEndpointRank = (rankByEndpoint.get(sourceKey) ?? 0) + 1;
    const targetEndpointRank = (rankByEndpoint.get(targetKey) ?? 0) + 1;
    rankByEndpoint.set(sourceKey, sourceEndpointRank);
    rankByEndpoint.set(targetKey, targetEndpointRank);
    return sourceEndpointRank <= perEndpointLimit && targetEndpointRank <= perEndpointLimit
      ? [{ ...link, sourceEndpointRank, targetEndpointRank }]
      : [];
  });
  const maximumScore = selected[0]?.normalizedCountPerMb2 ?? 0;

  return selected.map((link) => ({
    ...link,
    lineWidth: endpointHiCLineWidth(link.normalizedCountPerMb2, maximumScore),
  }));
}

function compareEndpointHiCLinks(left: GfaEndpointHiCLink, right: GfaEndpointHiCLink) {
  return (
    Number(right.preferred) - Number(left.preferred)
    || right.normalizedCountPerMb2 - left.normalizedCountPerMb2
    || right.rawCount - left.rawCount
    || right.overviewNormalizedCountPerMb2 - left.overviewNormalizedCountPerMb2
    || left.source.localeCompare(right.source)
    || left.sourceSide.localeCompare(right.sourceSide)
    || left.target.localeCompare(right.target)
    || left.targetSide.localeCompare(right.targetSide)
  );
}

function physicalEndpointKey(contigId: string, side: GfaSegmentSide) {
  return `${contigId}\u0000${side}`;
}

function endpointHiCLineWidth(score: number, maximumScore: number) {
  if (score <= 0 || maximumScore <= 0) {
    return 1.1;
  }
  return 1.1 + 4.7 * Math.sqrt(Math.min(1, Math.max(0, score / maximumScore)));
}
