import type { GfaHiCLink } from "./gfaHiCLinks";
import type { ContactMapLayoutBlock } from "./importers";
import type { PafPreviewRecord } from "./pafPreview";

type Interval = readonly [number, number];

export type SyntenyAllelePruneReason =
  | "duplicate-occurrence"
  | "direct-allele"
  | "cross-allele-nonmatch";

export interface ReferenceSyntenyAnchor {
  nodeId: string;
  blockId: string;
  occurrenceBlockIds: string[];
  sourceId: string;
  targetName: string;
  targetStart: number;
  targetEnd: number;
  targetIntervals: Interval[];
  targetStrand: "+" | "-";
  strandDominance: number;
  queryCoverage: number;
  identity: number;
  meanMapq: number;
  targetDominance: number;
}

export interface ReferenceSyntenyAlleleGroup {
  id: string;
  targetName: string;
  targetStart: number;
  targetEnd: number;
  members: ReferenceSyntenyAnchor[];
}

export type ReferenceSyntenyAlleleConfidence = "high" | "review";

export type ReferenceSyntenyAlleleRelationship =
  | "allele"
  | "boundary-overlap"
  | "partial-overlap";

export type ReferenceSyntenyAnchorExclusionReason =
  | "no-paf-alignment"
  | "partial-source-overlap"
  | "low-query-coverage"
  | "low-identity"
  | "low-mapq"
  | "multi-locus-split"
  | "multi-locus-repetitive"
  | "multi-locus-mixed";

export interface ReferenceSyntenyAmbiguousLocus {
  targetName: string;
  targetStart: number;
  targetEnd: number;
  queryStart: number;
  queryEnd: number;
  queryCoverage: number;
  identity: number;
  meanMapq: number;
  score: number;
}

export interface ReferenceSyntenyAnchorExclusion {
  nodeId: string;
  sourceId: string;
  occurrenceBlockIds: string[];
  reason: ReferenceSyntenyAnchorExclusionReason;
  candidateLoci: ReferenceSyntenyAmbiguousLocus[];
}

/**
 * One directly observed, non-transitive co-synteny relationship. Unlike the
 * legacy display groups, an anchor may participate in more than one edge.
 */
export interface ReferenceSyntenyAlleleEdge {
  id: string;
  targetName: string;
  left: ReferenceSyntenyAnchor;
  right: ReferenceSyntenyAnchor;
  overlapBp: number;
  targetOverlap: number;
  reciprocalTargetOverlap: number;
  leftTargetCoverage: number;
  rightTargetCoverage: number;
  relationship: ReferenceSyntenyAlleleRelationship;
  minQueryCoverage: number;
  minIdentity: number;
  minMeanMapq: number;
  minTargetDominance: number;
  confidence: ReferenceSyntenyAlleleConfidence;
  confidenceScore: number;
}

export interface SyntenyAlleleSignalMask {
  sourceBlockId: string;
  targetBlockId: string;
  factor: number;
  reason: SyntenyAllelePruneReason;
  sourceGroupId: string;
  targetGroupId: string;
}

export interface ReferenceSyntenyAllelePruning {
  anchors: ReferenceSyntenyAnchor[];
  alleleEdges: ReferenceSyntenyAlleleEdge[];
  groups: ReferenceSyntenyAlleleGroup[];
  exclusions: ReferenceSyntenyAnchorExclusion[];
  maskByPair: Map<string, SyntenyAlleleSignalMask>;
  directAllelePairCount: number;
  pairwiseAlleleOccurrencePairCount: number;
  compactGroupAlleleOccurrencePairCount: number;
  shadowOnlyAlleleOccurrencePairCount: number;
  legacyOnlyAlleleOccurrencePairCount: number;
  crossAllelePairCount: number;
  duplicateOccurrencePairCount: number;
  matchedPairCount: number;
  excludedBlockCount: number;
  multiMappingBlockCount: number;
  splitMappingBlockCount: number;
  repetitiveMappingBlockCount: number;
  mixedMappingBlockCount: number;
  fingerprint: string;
}

interface ReferenceSyntenyAlleleOptions {
  minQueryCoverage?: number;
  minIdentity?: number;
  minMeanMapq?: number;
  minTargetDominance?: number;
  minTargetOverlap?: number;
  minReciprocalTargetOverlap?: number;
  maxBoundaryReciprocalTargetOverlap?: number;
  maxTargetLocusGap?: number;
}

interface TargetAnchorCandidate {
  targetName: string;
  queryIntervals: Interval[];
  targetIntervals: Interval[];
  targetStrand: "+" | "-";
  strandDominance: number;
  queryCoverage: number;
  identity: number;
  meanMapq: number;
  score: number;
  primaryScore: number;
}

interface SourceOccurrenceNode {
  id: string;
  sourceId: string;
  sourceStart: number;
  sourceEnd: number;
  blocks: ContactMapLayoutBlock[];
}

interface AlignmentObservation {
  queryInterval: Interval;
  targetInterval: Interval;
  strand: "+" | "-";
  identity: number;
  mapq: number;
  observedBp: number;
  alignmentType: PafPreviewRecord["alignmentType"];
}

interface AnchorBuildResult {
  anchor: ReferenceSyntenyAnchor | null;
  multiMapping: boolean;
  exclusion: Omit<ReferenceSyntenyAnchorExclusion, "nodeId" | "sourceId" | "occurrenceBlockIds"> | null;
}

const defaultOptions = {
  minQueryCoverage: 0.5,
  minIdentity: 0.7,
  minMeanMapq: 1,
  minTargetDominance: 0.75,
  minTargetOverlap: 0.5,
  minReciprocalTargetOverlap: 0.5,
  maxBoundaryReciprocalTargetOverlap: 0.1,
  maxTargetLocusGap: 100_000,
};

/**
 * Identify direct pairwise co-synteny relationships and use those observed
 * edges as the authoritative direct-allele masks. Disjoint groups remain a
 * compact locus summary for display and cross-locus matching, but they must
 * not discard valid non-transitive edges. The returned factors affect
 * recommendation evidence only; source PAF/Hi-C data and the current AGP
 * remain untouched.
 */
export function buildReferenceSyntenyAllelePruning(
  records: ReadonlyArray<PafPreviewRecord>,
  blocks: ReadonlyArray<ContactMapLayoutBlock>,
  contacts: ReadonlyArray<GfaHiCLink>,
  options: ReferenceSyntenyAlleleOptions = {},
): ReferenceSyntenyAllelePruning {
  const resolvedOptions = { ...defaultOptions, ...options };
  const recordsByQuery = groupRecordsByQuery(records);
  const sourceNodes = buildSourceOccurrenceNodes(blocks);
  const partiallyOverlappingNodeIds = partialSourceOverlapNodeIds(sourceNodes);
  const anchors: ReferenceSyntenyAnchor[] = [];
  const exclusions: ReferenceSyntenyAnchorExclusion[] = [];
  let excludedBlockCount = 0;
  let multiMappingBlockCount = 0;
  let splitMappingBlockCount = 0;
  let repetitiveMappingBlockCount = 0;
  let mixedMappingBlockCount = 0;

  for (const node of sourceNodes) {
    const representative = node.blocks[0];
    const sourceRecords = recordsByQuery.get(node.sourceId)
      ?? (!representative || representative.id === node.sourceId
        ? undefined
        : recordsByQuery.get(representative.id));
    if (!sourceRecords || sourceRecords.length === 0) {
      excludedBlockCount += node.blocks.length;
      exclusions.push(anchorExclusion(node, "no-paf-alignment", []));
      continue;
    }
    if (partiallyOverlappingNodeIds.has(node.id)) {
      excludedBlockCount += node.blocks.length;
      exclusions.push(anchorExclusion(node, "partial-source-overlap", []));
      continue;
    }
    const built = buildPrimaryAnchor(node, sourceRecords, resolvedOptions);
    if (built.anchor) {
      anchors.push(built.anchor);
    } else {
      excludedBlockCount += node.blocks.length;
      if (built.exclusion) {
        const exclusion = {
          ...built.exclusion,
          nodeId: node.id,
          sourceId: node.sourceId,
          occurrenceBlockIds: node.blocks.map((block) => block.id),
        };
        exclusions.push(exclusion);
        if (exclusion.reason === "multi-locus-split") {
          splitMappingBlockCount += node.blocks.length;
        } else if (exclusion.reason === "multi-locus-repetitive") {
          repetitiveMappingBlockCount += node.blocks.length;
        } else if (exclusion.reason === "multi-locus-mixed") {
          mixedMappingBlockCount += node.blocks.length;
        }
      }
      if (built.multiMapping) {
        multiMappingBlockCount += node.blocks.length;
      }
    }
  }

  const alleleEdges = buildReferenceSyntenyAlleleEdges(
    anchors,
    resolvedOptions.minTargetOverlap,
    resolvedOptions.minReciprocalTargetOverlap,
    resolvedOptions.maxBoundaryReciprocalTargetOverlap,
  );
  const groups = clusterReferenceAnchors(
    anchors,
    resolvedOptions.minReciprocalTargetOverlap,
  );
  const maskByPair = new Map<string, SyntenyAlleleSignalMask>();
  const legacyDirectAllelePairs = expandedAlleleGroupPairKeys(groups);

  for (const node of sourceNodes.filter((candidate) => candidate.blocks.length > 1)) {
    const occurrenceIds = node.blocks.map((block) => block.id);
    for (let left = 0; left < occurrenceIds.length; left += 1) {
      for (let right = left + 1; right < occurrenceIds.length; right += 1) {
        setExpandedMask(maskByPair, [occurrenceIds[left]], [occurrenceIds[right]], {
          factor: 0,
          reason: "duplicate-occurrence",
          sourceGroupId: `duplicate:${node.id}`,
          targetGroupId: `duplicate:${node.id}`,
        });
      }
    }
  }

  const groupByNodeId = new Map<string, ReferenceSyntenyAlleleGroup>();
  const anchorByBlockId = new Map<string, ReferenceSyntenyAnchor>();
  for (const group of groups) {
    for (const member of group.members) {
      groupByNodeId.set(member.nodeId, group);
      for (const blockId of member.occurrenceBlockIds) {
        anchorByBlockId.set(blockId, member);
      }
    }
  }
  const contactsByGroupPair = new Map<string, {
    leftGroup: ReferenceSyntenyAlleleGroup;
    rightGroup: ReferenceSyntenyAlleleGroup;
    scoreByNodePair: Map<string, number>;
    anchorsByNodePair: Map<string, [ReferenceSyntenyAnchor, ReferenceSyntenyAnchor]>;
  }>();
  for (const contact of contacts) {
    const sourceAnchor = anchorByBlockId.get(contact.source);
    const targetAnchor = anchorByBlockId.get(contact.target);
    if (!sourceAnchor || !targetAnchor || sourceAnchor.nodeId === targetAnchor.nodeId) {
      continue;
    }
    const sourceGroup = groupByNodeId.get(sourceAnchor.nodeId);
    const targetGroup = groupByNodeId.get(targetAnchor.nodeId);
    if (!sourceGroup || !targetGroup || sourceGroup.id === targetGroup.id) {
      continue;
    }
    const [leftGroup, rightGroup] = sourceGroup.id.localeCompare(targetGroup.id) <= 0
      ? [sourceGroup, targetGroup]
      : [targetGroup, sourceGroup];
    const key = orderedPairKey(leftGroup.id, rightGroup.id);
    const value = contactsByGroupPair.get(key) ?? {
      leftGroup,
      rightGroup,
      scoreByNodePair: new Map(),
      anchorsByNodePair: new Map(),
    };
    const nodePairKey = syntenyAllelePairKey(sourceAnchor.nodeId, targetAnchor.nodeId);
    const score = Number.isFinite(contact.normalizedCountPerMb2)
      ? Math.max(0, contact.normalizedCountPerMb2)
      : 0;
    value.scoreByNodePair.set(
      nodePairKey,
      (value.scoreByNodePair.get(nodePairKey) ?? 0) + score,
    );
    value.anchorsByNodePair.set(nodePairKey, [sourceAnchor, targetAnchor]);
    contactsByGroupPair.set(key, value);
  }

  let matchedPairCount = 0;
  for (const groupContacts of contactsByGroupPair.values()) {
    const { leftGroup, rightGroup, scoreByNodePair, anchorsByNodePair } = groupContacts;
    const matched = maximumWeightPairs(
      leftGroup.members.map((member) => member.nodeId),
      rightGroup.members.map((member) => member.nodeId),
      scoreByNodePair,
    );
    matchedPairCount += matched.size;

    for (const [nodePairKey, score] of scoreByNodePair) {
      if (score <= 0 || matched.has(nodePairKey)) {
        continue;
      }
      const pair = anchorsByNodePair.get(nodePairKey);
      if (pair) {
        setExpandedMask(maskByPair, pair[0].occurrenceBlockIds, pair[1].occurrenceBlockIds, {
          factor: 0,
          reason: "cross-allele-nonmatch",
          sourceGroupId: groupByNodeId.get(pair[0].nodeId)?.id ?? leftGroup.id,
          targetGroupId: groupByNodeId.get(pair[1].nodeId)?.id ?? rightGroup.id,
        });
      }
    }
  }

  // Direct PAF overlap is stronger evidence than a cross-locus Hi-C matching
  // decision. Apply it last so a valid non-transitive edge cannot be
  // overwritten merely because its two anchors landed in different compact
  // display groups.
  for (const edge of alleleEdges) {
    if (edge.confidence !== "high" || edge.relationship !== "allele") {
      continue;
    }
    setExpandedMask(
      maskByPair,
      edge.left.occurrenceBlockIds,
      edge.right.occurrenceBlockIds,
      {
        factor: 0,
        reason: "direct-allele",
        sourceGroupId: edge.id,
        targetGroupId: edge.id,
      },
    );
  }

  const masks = [...maskByPair.entries()].sort(([left], [right]) => left.localeCompare(right));
  const directAllelePairCount = masks.filter(([, mask]) => mask.reason === "direct-allele").length;
  const pairwiseAlleleOccurrencePairs = expandedAlleleEdgePairKeys(
    alleleEdges.filter((edge) => edge.relationship === "allele"),
  );
  const shadowOnlyAlleleOccurrencePairCount = [...pairwiseAlleleOccurrencePairs]
    .filter((key) => !maskByPair.has(key)).length;
  const legacyOnlyAlleleOccurrencePairCount = [...legacyDirectAllelePairs]
    .filter((key) => !pairwiseAlleleOccurrencePairs.has(key)).length;
  const crossAllelePairCount = masks.filter(([, mask]) => mask.reason === "cross-allele-nonmatch").length;
  const duplicateOccurrencePairCount = masks.filter(([, mask]) => mask.reason === "duplicate-occurrence").length;
  const fingerprint = [
    ...anchors.map((anchor) => (
      `${anchor.nodeId}:${anchor.targetName}:${anchor.targetStart}-${anchor.targetEnd}:`
      + `${anchor.targetStrand}:${anchor.strandDominance}`
    )),
    ...alleleEdges.map((edge) => (
      `${edge.id}:${edge.relationship}:${edge.targetOverlap}:`
      + `${edge.reciprocalTargetOverlap}:${edge.confidence}:${edge.confidenceScore}`
    )),
    ...exclusions.map((exclusion) => (
      `${exclusion.nodeId}:${exclusion.reason}:${exclusion.candidateLoci.map((locus) => (
        `${locus.targetName}:${locus.targetStart}-${locus.targetEnd}:`
        + `${locus.queryStart}-${locus.queryEnd}`
      )).join(",")}`
    )),
    ...groups.map((group) => `${group.id}:${group.members.map(
      (member) => `${member.nodeId}[${member.occurrenceBlockIds.join(",")}]`,
    ).join(",")}`),
    ...masks.map(([key, mask]) => `${key}:${mask.reason}:${mask.factor}`),
  ].join("|");

  return {
    anchors,
    alleleEdges,
    groups,
    exclusions,
    maskByPair,
    directAllelePairCount,
    pairwiseAlleleOccurrencePairCount: pairwiseAlleleOccurrencePairs.size,
    compactGroupAlleleOccurrencePairCount: legacyDirectAllelePairs.size,
    shadowOnlyAlleleOccurrencePairCount,
    legacyOnlyAlleleOccurrencePairCount,
    crossAllelePairCount,
    duplicateOccurrencePairCount,
    matchedPairCount,
    excludedBlockCount,
    multiMappingBlockCount,
    splitMappingBlockCount,
    repetitiveMappingBlockCount,
    mixedMappingBlockCount,
    fingerprint,
  };
}

/**
 * Build the direct PAF relationship graph without transitive closure.
 * A target-coordinate sweep avoids comparing anchors whose bounding intervals
 * cannot overlap; the final decision always uses the exact merged intervals.
 */
export function buildReferenceSyntenyAlleleEdges(
  anchors: ReadonlyArray<ReferenceSyntenyAnchor>,
  minTargetOverlap: number,
  minReciprocalTargetOverlap = minTargetOverlap,
  maxBoundaryReciprocalTargetOverlap = 0.1,
): ReferenceSyntenyAlleleEdge[] {
  const anchorsByTarget = new Map<string, ReferenceSyntenyAnchor[]>();
  for (const anchor of anchors) {
    const values = anchorsByTarget.get(anchor.targetName) ?? [];
    values.push(anchor);
    anchorsByTarget.set(anchor.targetName, values);
  }

  const edges: ReferenceSyntenyAlleleEdge[] = [];
  for (const [targetName, targetAnchors] of [...anchorsByTarget]
    .sort(([left], [right]) => left.localeCompare(right))) {
    const sorted = [...targetAnchors].sort(compareAnchorsByTarget);
    let active: ReferenceSyntenyAnchor[] = [];
    for (const anchor of sorted) {
      active = active.filter((candidate) => candidate.targetEnd > anchor.targetStart);
      for (const candidate of active) {
        const overlap = targetOverlapMetrics(candidate, anchor);
        if (overlap.shorterCoverage < minTargetOverlap) {
          continue;
        }
        const [left, right] = candidate.nodeId.localeCompare(anchor.nodeId) <= 0
          ? [candidate, anchor]
          : [anchor, candidate];
        const relationship: ReferenceSyntenyAlleleRelationship =
          overlap.reciprocalCoverage >= minReciprocalTargetOverlap
            ? "allele"
            : overlap.reciprocalCoverage <= maxBoundaryReciprocalTargetOverlap
              && crossesTargetBoundary(candidate, anchor)
              ? "boundary-overlap"
              : "partial-overlap";
        const confidence: ReferenceSyntenyAlleleConfidence = relationship === "partial-overlap"
          ? "review"
          : "high";
        const leftTargetCoverage = left.nodeId === candidate.nodeId
          ? overlap.leftCoverage
          : overlap.rightCoverage;
        const rightTargetCoverage = right.nodeId === anchor.nodeId
          ? overlap.rightCoverage
          : overlap.leftCoverage;
        const confidenceOverlap = relationship === "boundary-overlap"
          ? overlap.shorterCoverage
          : overlap.reciprocalCoverage;
        edges.push({
          id: `synteny-edge:${targetName}:${left.nodeId}:${right.nodeId}`,
          targetName,
          left,
          right,
          overlapBp: overlap.overlapBp,
          targetOverlap: overlap.shorterCoverage,
          reciprocalTargetOverlap: overlap.reciprocalCoverage,
          leftTargetCoverage,
          rightTargetCoverage,
          relationship,
          minQueryCoverage: Math.min(left.queryCoverage, right.queryCoverage),
          minIdentity: Math.min(left.identity, right.identity),
          minMeanMapq: Math.min(left.meanMapq, right.meanMapq),
          minTargetDominance: Math.min(left.targetDominance, right.targetDominance),
          confidence,
          confidenceScore: alleleEdgeConfidenceScore(left, right, confidenceOverlap),
        });
      }
      active.push(anchor);
    }
  }
  return edges.sort((left, right) => left.id.localeCompare(right.id));
}

export function syntenyAllelePairKey(first: string, second: string) {
  return orderedPairKey(first, second);
}

function groupRecordsByQuery(records: ReadonlyArray<PafPreviewRecord>) {
  const grouped = new Map<string, PafPreviewRecord[]>();
  for (const record of records) {
    const values = grouped.get(record.queryName) ?? [];
    values.push(record);
    grouped.set(record.queryName, values);
  }
  return grouped;
}

function buildSourceOccurrenceNodes(blocks: ReadonlyArray<ContactMapLayoutBlock>) {
  const nodesByKey = new Map<string, SourceOccurrenceNode>();
  const sorted = [...blocks].sort((left, right) => left.visualStart - right.visualStart
    || left.visualEnd - right.visualEnd
    || left.id.localeCompare(right.id));
  for (const block of sorted) {
    const id = sourceOccurrenceNodeId(block.sourceId, block.sourceStart, block.sourceEnd);
    const node = nodesByKey.get(id) ?? {
      id,
      sourceId: block.sourceId,
      sourceStart: block.sourceStart,
      sourceEnd: block.sourceEnd,
      blocks: [],
    };
    node.blocks.push(block);
    nodesByKey.set(id, node);
  }
  return [...nodesByKey.values()];
}

function partialSourceOverlapNodeIds(nodes: ReadonlyArray<SourceOccurrenceNode>) {
  const ambiguous = new Set<string>();
  const bySource = new Map<string, SourceOccurrenceNode[]>();
  for (const node of nodes) {
    const values = bySource.get(node.sourceId) ?? [];
    values.push(node);
    bySource.set(node.sourceId, values);
  }
  for (const sourceNodes of bySource.values()) {
    for (let left = 0; left < sourceNodes.length; left += 1) {
      for (let right = left + 1; right < sourceNodes.length; right += 1) {
        if (Math.max(sourceNodes[left].sourceStart, sourceNodes[right].sourceStart)
          < Math.min(sourceNodes[left].sourceEnd, sourceNodes[right].sourceEnd)) {
          ambiguous.add(sourceNodes[left].id);
          ambiguous.add(sourceNodes[right].id);
        }
      }
    }
  }
  return ambiguous;
}

function buildPrimaryAnchor(
  node: SourceOccurrenceNode,
  records: ReadonlyArray<PafPreviewRecord>,
  options: typeof defaultOptions,
): AnchorBuildResult {
  const byTarget = new Map<string, AlignmentObservation[]>();

  for (const record of records) {
    if (record.alignmentBlockLen <= 0) {
      continue;
    }
    const queryStart = Math.max(node.sourceStart, record.queryStart);
    const queryEnd = Math.min(node.sourceEnd, record.queryEnd);
    if (queryStart >= queryEnd) {
      continue;
    }
    const targetInterval = projectQueryIntervalToTarget(record, queryStart, queryEnd);
    if (!targetInterval) {
      continue;
    }
    const observedBp = queryEnd - queryStart;
    const identity = Math.min(1, Math.max(0, record.residueMatches / record.alignmentBlockLen));
    const values = byTarget.get(record.targetName) ?? [];
    values.push({
      queryInterval: [queryStart, queryEnd],
      targetInterval,
      strand: record.strand,
      identity,
      mapq: Math.max(0, record.mapq),
      observedBp,
      alignmentType: record.alignmentType,
    });
    byTarget.set(record.targetName, values);
  }

  const blockLength = node.sourceEnd - node.sourceStart;
  if (blockLength <= 0) {
    return {
      anchor: null,
      multiMapping: false,
      exclusion: { reason: "no-paf-alignment", candidateLoci: [] },
    };
  }
  const candidates: TargetAnchorCandidate[] = [];
  for (const [targetName, observations] of byTarget) {
    for (const locus of clusterTargetObservations(observations, options.maxTargetLocusGap)) {
      const queryIntervals = mergeIntervals(locus.map((observation) => observation.queryInterval));
      const queryAlignedBp = intervalSpan(queryIntervals);
      const targetIntervals = mergeIntervals(locus.map((observation) => observation.targetInterval));
      const observedBp = locus.reduce((sum, observation) => sum + observation.observedBp, 0);
      const identity = observedBp > 0
        ? locus.reduce(
          (sum, observation) => sum + observation.identity * observation.observedBp,
          0,
        ) / observedBp
        : 0;
      const meanMapq = observedBp > 0
        ? locus.reduce(
          (sum, observation) => sum + observation.mapq * observation.observedBp,
          0,
        ) / observedBp
        : 0;
      const strandBp = locus.reduce((totals, observation) => {
        totals[observation.strand] += observation.observedBp;
        return totals;
      }, { "+": 0, "-": 0 } as Record<"+" | "-", number>);
      const targetStrand = strandBp["-"] > strandBp["+"] ? "-" : "+";
      const strandDominance = observedBp > 0
        ? strandBp[targetStrand] / observedBp
        : 0;
      candidates.push({
        targetName,
        queryIntervals,
        targetIntervals,
        targetStrand,
        strandDominance,
        queryCoverage: queryAlignedBp / blockLength,
        identity,
        meanMapq,
        score: queryAlignedBp * identity,
        primaryScore: locus.some((observation) => observation.alignmentType === "primary")
          ? queryAlignedBp * identity
          : 0,
      });
    }
  }
  const hasTaggedPrimary = candidates.some((candidate) => candidate.primaryScore > 0);
  candidates.sort((left, right) => (hasTaggedPrimary
    ? right.primaryScore - left.primaryScore
    : 0)
    || right.score - left.score
    || right.queryCoverage - left.queryCoverage
    || left.targetName.localeCompare(right.targetName));
  const primary = candidates[0];
  if (!primary) {
    return {
      anchor: null,
      multiMapping: false,
      exclusion: { reason: "no-paf-alignment", candidateLoci: [] },
    };
  }
  const totalScore = candidates.reduce((sum, candidate) => sum + candidate.score, 0);
  const targetDominance = totalScore > 0 ? primary.score / totalScore : 0;
  const multiMapping = targetDominance < options.minTargetDominance;
  const candidateLoci = candidates.map(candidateLocusSummary);
  const exclusionReason: ReferenceSyntenyAnchorExclusionReason | null = multiMapping
    ? `multi-locus-${multiLocusKind(primary, candidates.slice(1))}`
    : primary.queryCoverage < options.minQueryCoverage
      ? "low-query-coverage"
      : primary.identity < options.minIdentity
        ? "low-identity"
        : primary.meanMapq < options.minMeanMapq
          ? "low-mapq"
          : null;
  if (
    primary.queryCoverage < options.minQueryCoverage
    || primary.identity < options.minIdentity
    || primary.meanMapq < options.minMeanMapq
    || multiMapping
  ) {
    return {
      anchor: null,
      multiMapping,
      exclusion: {
        reason: exclusionReason ?? "no-paf-alignment",
        candidateLoci,
      },
    };
  }
  const occurrenceBlockIds = node.blocks.map((block) => block.id);
  return {
    anchor: {
      nodeId: node.id,
      blockId: occurrenceBlockIds[0],
      occurrenceBlockIds,
      sourceId: node.sourceId,
      targetName: primary.targetName,
      targetStart: primary.targetIntervals[0]?.[0] ?? 0,
      targetEnd: primary.targetIntervals[primary.targetIntervals.length - 1]?.[1] ?? 0,
      targetIntervals: primary.targetIntervals,
      targetStrand: primary.targetStrand,
      strandDominance: primary.strandDominance,
      queryCoverage: primary.queryCoverage,
      identity: primary.identity,
      meanMapq: primary.meanMapq,
      targetDominance,
    },
    multiMapping: false,
    exclusion: null,
  };
}

function anchorExclusion(
  node: SourceOccurrenceNode,
  reason: ReferenceSyntenyAnchorExclusionReason,
  candidateLoci: ReferenceSyntenyAmbiguousLocus[],
): ReferenceSyntenyAnchorExclusion {
  return {
    nodeId: node.id,
    sourceId: node.sourceId,
    occurrenceBlockIds: node.blocks.map((block) => block.id),
    reason,
    candidateLoci,
  };
}

function candidateLocusSummary(
  candidate: TargetAnchorCandidate,
): ReferenceSyntenyAmbiguousLocus {
  return {
    targetName: candidate.targetName,
    targetStart: candidate.targetIntervals[0]?.[0] ?? 0,
    targetEnd: candidate.targetIntervals[candidate.targetIntervals.length - 1]?.[1] ?? 0,
    queryStart: candidate.queryIntervals[0]?.[0] ?? 0,
    queryEnd: candidate.queryIntervals[candidate.queryIntervals.length - 1]?.[1] ?? 0,
    queryCoverage: candidate.queryCoverage,
    identity: candidate.identity,
    meanMapq: candidate.meanMapq,
    score: candidate.score,
  };
}

function multiLocusKind(
  primary: TargetAnchorCandidate,
  alternatives: ReadonlyArray<TargetAnchorCandidate>,
): "split" | "repetitive" | "mixed" {
  if (alternatives.length === 0) {
    return "mixed";
  }
  const overlaps = alternatives.map((candidate) => intervalOverlapFraction(
    primary.queryIntervals,
    candidate.queryIntervals,
  ));
  if (overlaps.every((overlap) => overlap <= 0.1)) {
    return "split";
  }
  if (overlaps.some((overlap) => overlap >= 0.5)) {
    return "repetitive";
  }
  return "mixed";
}

function intervalOverlapFraction(left: ReadonlyArray<Interval>, right: ReadonlyArray<Interval>) {
  const denominator = Math.min(intervalSpan(left), intervalSpan(right));
  return denominator > 0 ? intervalIntersectionSpan(left, right) / denominator : 0;
}

function alleleEdgeConfidenceScore(
  left: ReferenceSyntenyAnchor,
  right: ReferenceSyntenyAnchor,
  targetOverlapValue: number,
) {
  const coverage = Math.min(left.queryCoverage, right.queryCoverage);
  const identity = Math.min(left.identity, right.identity);
  const dominance = Math.min(left.targetDominance, right.targetDominance);
  const mapqWeight = Math.min(1, Math.min(left.meanMapq, right.meanMapq) / 20);
  return clamp01(targetOverlapValue * coverage * identity * dominance * mapqWeight);
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

function clusterTargetObservations(
  observations: ReadonlyArray<AlignmentObservation>,
  maxGap: number,
) {
  const sorted = [...observations].sort((left, right) => (
    left.targetInterval[0] - right.targetInterval[0]
    || left.targetInterval[1] - right.targetInterval[1]
  ));
  const clusters: AlignmentObservation[][] = [];
  for (const observation of sorted) {
    const previous = clusters[clusters.length - 1];
    const previousEnd = previous
      ? Math.max(...previous.map((candidate) => candidate.targetInterval[1]))
      : Number.NEGATIVE_INFINITY;
    if (!previous || observation.targetInterval[0] > previousEnd + maxGap) {
      clusters.push([observation]);
    } else {
      previous.push(observation);
    }
  }
  return clusters;
}

function projectQueryIntervalToTarget(
  record: PafPreviewRecord,
  queryStart: number,
  queryEnd: number,
): Interval | null {
  const querySpan = record.queryEnd - record.queryStart;
  const targetSpan = record.targetEnd - record.targetStart;
  if (querySpan <= 0 || targetSpan <= 0) {
    return null;
  }
  const startOffset = (queryStart - record.queryStart) / querySpan;
  const endOffset = (queryEnd - record.queryStart) / querySpan;
  const first = record.strand === "+"
    ? record.targetStart + targetSpan * startOffset
    : record.targetEnd - targetSpan * startOffset;
  const second = record.strand === "+"
    ? record.targetStart + targetSpan * endOffset
    : record.targetEnd - targetSpan * endOffset;
  return [Math.min(first, second), Math.max(first, second)];
}

function clusterReferenceAnchors(
  anchors: ReadonlyArray<ReferenceSyntenyAnchor>,
  minTargetOverlap: number,
) {
  const anchorsByTarget = new Map<string, ReferenceSyntenyAnchor[]>();
  for (const anchor of anchors) {
    const values = anchorsByTarget.get(anchor.targetName) ?? [];
    values.push(anchor);
    anchorsByTarget.set(anchor.targetName, values);
  }
  const groups: ReferenceSyntenyAlleleGroup[] = [];
  for (const [targetName, targetAnchors] of [...anchorsByTarget].sort(([left], [right]) => left.localeCompare(right))) {
    const clusters: ReferenceSyntenyAnchor[][] = [];
    const sorted = [...targetAnchors].sort(compareAnchorsByTarget);
    for (const anchor of sorted) {
      let bestCluster: ReferenceSyntenyAnchor[] | null = null;
      let bestScore = -1;
      for (const cluster of clusters) {
        const overlaps = cluster.map((member) => reciprocalTargetOverlap(anchor, member));
        const minimum = Math.min(...overlaps);
        if (minimum >= minTargetOverlap && minimum > bestScore) {
          bestCluster = cluster;
          bestScore = minimum;
        }
      }
      if (bestCluster) {
        bestCluster.push(anchor);
      } else {
        clusters.push([anchor]);
      }
    }
    for (const cluster of clusters.filter((members) => members.length >= 2)) {
      const targetStart = Math.min(...cluster.map((member) => member.targetStart));
      const targetEnd = Math.max(...cluster.map((member) => member.targetEnd));
      groups.push({
        id: `synteny:${targetName}:${Math.floor(targetStart)}-${Math.ceil(targetEnd)}:${groups.length + 1}`,
        targetName,
        targetStart,
        targetEnd,
        members: cluster,
      });
    }
  }
  return groups;
}

function compareAnchorsByTarget(
  left: ReferenceSyntenyAnchor,
  right: ReferenceSyntenyAnchor,
) {
  return left.targetStart - right.targetStart
    || left.targetEnd - right.targetEnd
    || left.nodeId.localeCompare(right.nodeId);
}

function reciprocalTargetOverlap(
  left: ReferenceSyntenyAnchor,
  right: ReferenceSyntenyAnchor,
) {
  return targetOverlapMetrics(left, right).reciprocalCoverage;
}

function targetOverlapMetrics(
  left: ReferenceSyntenyAnchor,
  right: ReferenceSyntenyAnchor,
) {
  const leftSpan = intervalSpan(left.targetIntervals);
  const rightSpan = intervalSpan(right.targetIntervals);
  const overlapBp = intervalIntersectionSpan(left.targetIntervals, right.targetIntervals);
  const leftCoverage = leftSpan > 0 ? overlapBp / leftSpan : 0;
  const rightCoverage = rightSpan > 0 ? overlapBp / rightSpan : 0;
  return {
    overlapBp,
    leftCoverage,
    rightCoverage,
    shorterCoverage: Math.max(leftCoverage, rightCoverage),
    reciprocalCoverage: Math.min(leftCoverage, rightCoverage),
  };
}

function crossesTargetBoundary(
  left: ReferenceSyntenyAnchor,
  right: ReferenceSyntenyAnchor,
) {
  return (
    left.targetStart < right.targetStart
    && right.targetStart < left.targetEnd
    && left.targetEnd < right.targetEnd
  ) || (
    right.targetStart < left.targetStart
    && left.targetStart < right.targetEnd
    && right.targetEnd < left.targetEnd
  );
}

function maximumWeightPairs(
  rowIds: ReadonlyArray<string>,
  columnIds: ReadonlyArray<string>,
  scoreByPair: ReadonlyMap<string, number>,
) {
  if (rowIds.length === 0 || columnIds.length === 0) {
    return new Set<string>();
  }
  const transposed = rowIds.length > columnIds.length;
  const rows = transposed ? columnIds : rowIds;
  const columns = transposed ? rowIds : columnIds;
  const weights = rows.map((row) => columns.map((column) => (
    scoreByPair.get(syntenyAllelePairKey(row, column)) ?? 0
  )));
  const maxWeight = Math.max(0, ...weights.flat());
  const rowPotential = new Array(rows.length + 1).fill(0);
  const columnPotential = new Array(columns.length + 1).fill(0);
  const matchedRowByColumn = new Array(columns.length + 1).fill(0);
  const previousColumn = new Array(columns.length + 1).fill(0);

  for (let row = 1; row <= rows.length; row += 1) {
    matchedRowByColumn[0] = row;
    let column0 = 0;
    const minimum = new Array(columns.length + 1).fill(Number.POSITIVE_INFINITY);
    const used = new Array(columns.length + 1).fill(false);
    do {
      used[column0] = true;
      const row0 = matchedRowByColumn[column0];
      let delta = Number.POSITIVE_INFINITY;
      let column1 = 0;
      for (let column = 1; column <= columns.length; column += 1) {
        if (used[column]) {
          continue;
        }
        const cost = maxWeight - weights[row0 - 1][column - 1];
        const current = cost - rowPotential[row0] - columnPotential[column];
        if (current < minimum[column]) {
          minimum[column] = current;
          previousColumn[column] = column0;
        }
        if (minimum[column] < delta) {
          delta = minimum[column];
          column1 = column;
        }
      }
      for (let column = 0; column <= columns.length; column += 1) {
        if (used[column]) {
          rowPotential[matchedRowByColumn[column]] += delta;
          columnPotential[column] -= delta;
        } else {
          minimum[column] -= delta;
        }
      }
      column0 = column1;
    } while (matchedRowByColumn[column0] !== 0);
    do {
      const column1 = previousColumn[column0];
      matchedRowByColumn[column0] = matchedRowByColumn[column1];
      column0 = column1;
    } while (column0 !== 0);
  }

  const matched = new Set<string>();
  for (let column = 1; column <= columns.length; column += 1) {
    const row = matchedRowByColumn[column];
    if (row === 0) {
      continue;
    }
    const rowId = rows[row - 1];
    const columnId = columns[column - 1];
    const key = syntenyAllelePairKey(rowId, columnId);
    if ((scoreByPair.get(key) ?? 0) > 0) {
      matched.add(key);
    }
  }
  return matched;
}

function mergeIntervals(intervals: ReadonlyArray<Interval>) {
  const sorted = [...intervals]
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && start < end)
    .sort(([leftStart, leftEnd], [rightStart, rightEnd]) => leftStart - rightStart || leftEnd - rightEnd);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous || start > previous[1]) {
      merged.push([start, end]);
    } else {
      previous[1] = Math.max(previous[1], end);
    }
  }
  return merged;
}

function intervalSpan(intervals: ReadonlyArray<Interval>) {
  return intervals.reduce((sum, [start, end]) => sum + Math.max(0, end - start), 0);
}

function intervalIntersectionSpan(
  left: ReadonlyArray<Interval>,
  right: ReadonlyArray<Interval>,
) {
  let leftIndex = 0;
  let rightIndex = 0;
  let total = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const overlap = Math.min(left[leftIndex][1], right[rightIndex][1])
      - Math.max(left[leftIndex][0], right[rightIndex][0]);
    total += Math.max(0, overlap);
    if (left[leftIndex][1] < right[rightIndex][1]) {
      leftIndex += 1;
    } else {
      rightIndex += 1;
    }
  }
  return total;
}

function setExpandedMask(
  maskByPair: Map<string, SyntenyAlleleSignalMask>,
  sourceBlockIds: ReadonlyArray<string>,
  targetBlockIds: ReadonlyArray<string>,
  decision: Omit<SyntenyAlleleSignalMask, "sourceBlockId" | "targetBlockId">,
) {
  for (const sourceBlockId of sourceBlockIds) {
    for (const targetBlockId of targetBlockIds) {
      if (sourceBlockId === targetBlockId) {
        continue;
      }
      maskByPair.set(syntenyAllelePairKey(sourceBlockId, targetBlockId), {
        sourceBlockId,
        targetBlockId,
        ...decision,
      });
    }
  }
}

function expandedAlleleEdgePairKeys(
  edges: ReadonlyArray<ReferenceSyntenyAlleleEdge>,
) {
  const pairs = new Set<string>();
  for (const edge of edges) {
    for (const leftBlockId of edge.left.occurrenceBlockIds) {
      for (const rightBlockId of edge.right.occurrenceBlockIds) {
        if (leftBlockId !== rightBlockId) {
          pairs.add(syntenyAllelePairKey(leftBlockId, rightBlockId));
        }
      }
    }
  }
  return pairs;
}

function expandedAlleleGroupPairKeys(
  groups: ReadonlyArray<ReferenceSyntenyAlleleGroup>,
) {
  const pairs = new Set<string>();
  for (const group of groups) {
    for (let left = 0; left < group.members.length; left += 1) {
      for (let right = left + 1; right < group.members.length; right += 1) {
        for (const leftBlockId of group.members[left].occurrenceBlockIds) {
          for (const rightBlockId of group.members[right].occurrenceBlockIds) {
            if (leftBlockId !== rightBlockId) {
              pairs.add(syntenyAllelePairKey(leftBlockId, rightBlockId));
            }
          }
        }
      }
    }
  }
  return pairs;
}

function sourceOccurrenceNodeId(sourceId: string, sourceStart: number, sourceEnd: number) {
  return `${sourceId}\u0001${sourceStart}\u0001${sourceEnd}`;
}

function orderedPairKey(first: string, second: string) {
  return first.localeCompare(second) <= 0
    ? `${first}\u0000${second}`
    : `${second}\u0000${first}`;
}
