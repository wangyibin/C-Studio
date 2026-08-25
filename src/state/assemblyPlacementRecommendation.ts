import {
  assemblyCopyIntervalGroups,
  buildAssemblyEditModel,
  moveSelectionBefore,
  reverseSelection,
  selectedBlockIds,
  type AssemblySelection,
} from "./assemblyEditing";
import {
  physicalSideForDisplayedEndpoint,
  type GfaEndpointHiCLoadRequest,
  type GfaEndpointHiCLoadResult,
} from "./gfaEndpointHiC";
import type { GfaGraphEdge, GfaSegmentSide } from "./gfa";
import type { GfaHiCLink } from "./gfaHiCLinks";
import type { ContactMapLayoutBlock } from "./importers";
import {
  syntenyAllelePairKey,
  type ReferenceSyntenyAlleleEdge,
  type ReferenceSyntenyAlleleGroup,
  type ReferenceSyntenyAnchor,
  type SyntenyAllelePruneReason,
  type SyntenyAlleleSignalMask,
} from "./syntenyAllelePruning";

export type PlacementRecommendationConfidence = "high" | "medium" | "review" | "ambiguous";

export interface PlacementRecommendationBoundary {
  id: string;
  targetObjectId: string;
  targetBlockId: string | null;
  visualPosition: number;
  chromosomeEnd: "start" | "end" | null;
  leftBlockId: string | null;
  rightBlockId: string | null;
  isCurrentBoundary: boolean;
}

export interface PlacementRecommendationCandidate extends PlacementRecommendationBoundary {
  orientation: "+" | "-";
  isCurrent: boolean;
}

export interface PlacementJunctionEvidence {
  side: "left" | "right";
  partnerBlockId: string;
  normalizedCountPerMb2: number;
  rawNormalizedCountPerMb2: number;
  rawCount: number;
  endpointEnrichment: number;
  complete: boolean;
  bestEndpointMatch: boolean;
  contrastToNext: number | null;
  gfaMatch: boolean;
  syntenyPruneReason: SyntenyAllelePruneReason | null;
}

export interface PlacementRecommendation extends PlacementRecommendationCandidate {
  selectedBlockIds: string[];
  rank: number;
  confidence: PlacementRecommendationConfidence;
  junctions: PlacementJunctionEvidence[];
  supportedJunctionCount: number;
  bestEndpointMatchCount: number;
  gfaMatchCount: number;
  contactScore: number;
  coarseScore: number;
  backgroundScore: number;
  pafAdjacencyMatchCount: number;
  copyAmbiguous: boolean;
  syntenyPrunedJunctionCount: number;
  occupancyConflicts: PlacementGroupOccupancyConflict[];
}

export type PlacementGroupOccupancyConflictKind =
  | "exact-source"
  | "paf-allele-locus";

export interface PlacementGroupOccupancyConflict {
  targetObjectId: string;
  kind: PlacementGroupOccupancyConflictKind;
  locusId: string;
  selectedBlockIds: string[];
  occupiedBlockIds: string[];
}

export type PlacementSyntenyAdjacencyDirection = "upstream" | "downstream";

export interface PlacementSyntenyAdjacency {
  partnerBlockId: string;
  partnerNodeId: string;
  targetName: string;
  direction: PlacementSyntenyAdjacencyDirection;
  targetGap: number;
}

export type PlacementRecommendationRankingMode =
  | "legacy"
  | "paf-adjacency"
  | "synteny-assisted";

export interface PlacementRecommendationPlan {
  status: "ready";
  selectedBlocks: ContactMapLayoutBlock[];
  currentOrientation: "+" | "-";
  copyAmbiguous: boolean;
  candidates: PlacementRecommendationCandidate[];
  requests: GfaEndpointHiCLoadRequest[];
  coarseLinks: GfaHiCLink[];
  gfaEdges: GfaGraphEdge[];
  syntenyMaskByPair: ReadonlyMap<string, SyntenyAlleleSignalMask>;
  syntenyAnchors: ReferenceSyntenyAnchor[];
  syntenyAdjacencies: PlacementSyntenyAdjacency[];
  occupancyConflicts: PlacementGroupOccupancyConflict[];
}

export interface PlacementRecommendationUnavailable {
  status: "unavailable";
  reason: string;
}

export type PlacementRecommendationPlanningResult =
  | PlacementRecommendationPlan
  | PlacementRecommendationUnavailable;

interface SelectedPlacementBlock {
  blocks: ContactMapLayoutBlock[];
  unitIds: string[];
  objectId: string;
  currentOrientation: "+" | "-";
}

const defaultOverviewPartnerLimit = 12;
const defaultGfaPartnerLimit = 12;
const defaultSyntenyPartnerLimitPerSide = 4;

export function selectedPlacementBlock(
  blocks: ReadonlyArray<ContactMapLayoutBlock>,
  selection: AssemblySelection | null,
): SelectedPlacementBlock | PlacementRecommendationUnavailable {
  if (!selection || selection.kind !== "contigs") {
    return {
      status: "unavailable",
      reason: "Select one or more consecutive placed contigs to calculate a placement recommendation.",
    };
  }
  const mutableBlocks = [...blocks];
  const selectedIds = selectedBlockIds(mutableBlocks, selection);
  if (selectedIds.length === 0) {
    return {
      status: "unavailable",
      reason: "The selected contigs are no longer present in the current AGP.",
    };
  }
  const model = buildAssemblyEditModel(mutableBlocks);
  const selectedIdSet = new Set(selectedIds);
  const selectedUnits = model.assemblyBlocks.filter((unit) => (
    unit.contigIds.some((id) => selectedIdSet.has(id))
  ));
  if (selectedUnits.length === 0) {
    return {
      status: "unavailable",
      reason: "The selected contigs are no longer present in the current AGP.",
    };
  }
  if (selectedUnits.some((unit) => unit.contigIds.some((id) => !selectedIdSet.has(id)))) {
    return {
      status: "unavailable",
      reason: "The selection includes only part of a composite block. Select the complete block or dissolve it first.",
    };
  }
  const objectIds = new Set(selectedUnits.map((unit) => unit.objectId));
  if (objectIds.size !== 1) {
    return {
      status: "unavailable",
      reason: "A placement block must contain consecutive contigs from one chromosome.",
    };
  }
  const objectId = selectedUnits[0].objectId;
  const objectUnits = model.assemblyBlocks.filter((unit) => unit.objectId === objectId);
  const firstUnitIndex = objectUnits.findIndex((unit) => unit.id === selectedUnits[0].id);
  const consecutive = firstUnitIndex >= 0 && selectedUnits.every((unit, index) => (
    objectUnits[firstUnitIndex + index]?.id === unit.id
  ));
  if (!consecutive) {
    return {
      status: "unavailable",
      reason: "A placement block must be consecutive in the current AGP; non-adjacent selections are not merged implicitly.",
    };
  }
  const blocksById = new Map(model.blocks.map((block) => [block.id, block]));
  const selectedBlocks = selectedUnits.flatMap((unit) => (
    unit.contigIds.flatMap((id) => {
      const block = blocksById.get(id);
      return block ? [block] : [];
    })
  ));
  if (selectedBlocks.length !== selectedIdSet.size) {
    return {
      status: "unavailable",
      reason: "The selected placement block changed while the recommendation was being prepared.",
    };
  }
  if (selectedBlocks.some((block) => block.orientation !== "+" && block.orientation !== "-")) {
    return {
      status: "unavailable",
      reason: "Every contig in the placement block needs a known + or - orientation before endpoint placement can be scored.",
    };
  }
  return {
    blocks: selectedBlocks,
    unitIds: selectedUnits.map((unit) => unit.id),
    objectId,
    currentOrientation: selectedBlocks.length === 1
      ? selectedBlocks[0].orientation as "+" | "-"
      : "+",
  };
}

export function buildPlacementRecommendationPlan({
  blocks,
  selection,
  coarseLinks,
  gfaEdges = [],
  syntenyMaskByPair = new Map(),
  syntenyAlleleGroups = [],
  syntenyAnchors = [],
  syntenyAlleleEdges = [],
  overviewPartnerLimit = defaultOverviewPartnerLimit,
  gfaPartnerLimit = defaultGfaPartnerLimit,
  syntenyPartnerLimitPerSide = defaultSyntenyPartnerLimitPerSide,
}: {
  blocks: ReadonlyArray<ContactMapLayoutBlock>;
  selection: AssemblySelection | null;
  coarseLinks: ReadonlyArray<GfaHiCLink>;
  gfaEdges?: ReadonlyArray<GfaGraphEdge>;
  syntenyMaskByPair?: ReadonlyMap<string, SyntenyAlleleSignalMask>;
  syntenyAlleleGroups?: ReadonlyArray<ReferenceSyntenyAlleleGroup>;
  syntenyAnchors?: ReadonlyArray<ReferenceSyntenyAnchor>;
  syntenyAlleleEdges?: ReadonlyArray<ReferenceSyntenyAlleleEdge>;
  overviewPartnerLimit?: number;
  gfaPartnerLimit?: number;
  syntenyPartnerLimitPerSide?: number;
}): PlacementRecommendationPlanningResult {
  const selected = selectedPlacementBlock(blocks, selection);
  if ("status" in selected) {
    return selected;
  }
  const selectedIdSet = new Set(selected.blocks.map((block) => block.id));
  const boundaries = enumeratePlacementBoundaries(blocks, selection);
  const occupancyConflicts = placementGroupOccupancyConflicts(
    blocks,
    selected.blocks,
    syntenyAlleleGroups,
  );
  const occupiedObjectIds = new Set(
    occupancyConflicts.map((conflict) => conflict.targetObjectId),
  );
  const blocksById = new Map(blocks.map((block) => [block.id, block]));
  const syntenyAdjacencies = buildPlacementSyntenyAdjacencies({
    blocks,
    selectedBlocks: selected.blocks,
    anchors: syntenyAnchors,
    alleleEdges: syntenyAlleleEdges,
    limitPerSide: sanitizeLimit(
      syntenyPartnerLimitPerSide,
      defaultSyntenyPartnerLimitPerSide,
    ),
  });
  const incidentCoarseLinks = coarseLinks
    .filter((link) => (
      selectedIdSet.has(link.source) !== selectedIdSet.has(link.target)
    ))
    .map((link) => applySyntenyMaskToCoarseLink(link, syntenyMaskByPair))
    .filter((link): link is GfaHiCLink => link !== null)
    .sort(compareCoarseLinks);
  const coarsePartnerIds = occupancyTierPartnerIds(
    incidentCoarseLinks,
    selectedIdSet,
    blocksById,
    occupiedObjectIds,
    sanitizeLimit(overviewPartnerLimit, defaultOverviewPartnerLimit),
  );
  const allIncidentGfaEdges = gfaEdges
    .filter((edge) => edge.kind === "gfa-link"
      && (selectedIdSet.has(edge.source) !== selectedIdSet.has(edge.target)));
  const gfaPartnerIds = occupancyTierPartnerIds(
    allIncidentGfaEdges,
    selectedIdSet,
    blocksById,
    occupiedObjectIds,
    sanitizeLimit(gfaPartnerLimit, defaultGfaPartnerLimit),
  );
  const gfaPartnerIdSet = new Set(gfaPartnerIds);
  const incidentGfaEdges = allIncidentGfaEdges.filter((edge) => {
    const partnerId = selectedIdSet.has(edge.source) ? edge.target : edge.source;
    return gfaPartnerIdSet.has(partnerId);
  });
  const partnerIds = new Set([
    ...coarsePartnerIds,
    ...gfaPartnerIds,
    ...syntenyAdjacencies.map((adjacency) => adjacency.partnerBlockId),
  ]);
  const shortlistedBoundaries = boundaries.filter((boundary) => (
    boundary.isCurrentBoundary
    || (boundary.leftBlockId !== null && partnerIds.has(boundary.leftBlockId))
    || (boundary.rightBlockId !== null && partnerIds.has(boundary.rightBlockId))
  ));
  const orientations: Array<"+" | "-"> = selected.currentOrientation === "+"
    ? ["+", "-"]
    : ["-", "+"];
  const candidates = shortlistedBoundaries.flatMap((boundary) => (
    orientations.map((orientation) => ({
      ...boundary,
      id: `${boundary.id}\u0000${orientation}`,
      orientation,
      isCurrent: boundary.isCurrentBoundary && orientation === selected.currentOrientation,
    }))
  ));
  const requestsByKey = new Map<string, GfaEndpointHiCLoadRequest>();
  for (const candidate of candidates) {
    for (const endpoint of candidateEndpointJunctions(selected, candidate, blocks)) {
      const request = {
        sourceBlockId: endpoint.selectedBlock.id,
        targetBlockId: endpoint.partnerBlockId,
      };
      requestsByKey.set(placementEndpointRequestKey(request), request);
    }
  }
  const copyAmbiguous = selected.blocks.some((block) => (
    assemblyCopyIntervalGroups([...blocks], block)
      .filter((group) => group.coversInterval).length > 1
  ));

  return {
    status: "ready",
    selectedBlocks: selected.blocks,
    currentOrientation: selected.currentOrientation,
    copyAmbiguous,
    candidates,
    requests: [...requestsByKey.values()],
    coarseLinks: incidentCoarseLinks,
    gfaEdges: incidentGfaEdges,
    syntenyMaskByPair,
    syntenyAnchors: [...syntenyAnchors],
    syntenyAdjacencies,
    occupancyConflicts,
  };
}

/**
 * Convert high-confidence PAF anchors into positive placement evidence. Only
 * the nearest non-overlapping reference neighbors are returned; directly
 * overlapping allele anchors are explicitly excluded and remain negative
 * evidence. The current AGP is not changed by this operation.
 */
export function buildPlacementSyntenyAdjacencies({
  blocks,
  selectedBlocks,
  anchors,
  alleleEdges,
  limitPerSide = defaultSyntenyPartnerLimitPerSide,
}: {
  blocks: ReadonlyArray<ContactMapLayoutBlock>;
  selectedBlocks: ReadonlyArray<ContactMapLayoutBlock>;
  anchors: ReadonlyArray<ReferenceSyntenyAnchor>;
  alleleEdges: ReadonlyArray<ReferenceSyntenyAlleleEdge>;
  limitPerSide?: number;
}): PlacementSyntenyAdjacency[] {
  if (selectedBlocks.length === 0 || anchors.length === 0) {
    return [];
  }
  const blockIdSet = new Set(blocks.map((block) => block.id));
  const selectedBlockIdSet = new Set(selectedBlocks.map((block) => block.id));
  const selectedAnchors = uniqueAnchors(anchors.filter((anchor) => (
    anchor.occurrenceBlockIds.some((id) => selectedBlockIdSet.has(id))
  )));
  if (selectedAnchors.length === 0) {
    return [];
  }
  const targetCounts = new Map<string, { count: number; quality: number }>();
  for (const anchor of selectedAnchors) {
    const current = targetCounts.get(anchor.targetName) ?? { count: 0, quality: 0 };
    current.count += 1;
    current.quality += anchor.queryCoverage * anchor.identity * anchor.targetDominance;
    targetCounts.set(anchor.targetName, current);
  }
  const targetName = [...targetCounts].sort(([leftName, left], [rightName, right]) => (
    right.count - left.count
    || right.quality - left.quality
    || leftName.localeCompare(rightName)
  ))[0]?.[0];
  if (!targetName) {
    return [];
  }
  const selectedTargetAnchors = selectedAnchors.filter(
    (anchor) => anchor.targetName === targetName,
  );
  const selectedNodeIds = new Set(selectedTargetAnchors.map((anchor) => anchor.nodeId));
  const excludedAlleleNodeIds = new Set<string>();
  for (const edge of alleleEdges) {
    if (selectedNodeIds.has(edge.left.nodeId)) {
      excludedAlleleNodeIds.add(edge.right.nodeId);
    }
    if (selectedNodeIds.has(edge.right.nodeId)) {
      excludedAlleleNodeIds.add(edge.left.nodeId);
    }
  }
  const selectedTargetStart = Math.min(
    ...selectedTargetAnchors.map((anchor) => anchor.targetStart),
  );
  const selectedTargetEnd = Math.max(
    ...selectedTargetAnchors.map((anchor) => anchor.targetEnd),
  );
  const available = uniqueAnchors(anchors).filter((anchor) => (
    anchor.targetName === targetName
    && !selectedNodeIds.has(anchor.nodeId)
    && !excludedAlleleNodeIds.has(anchor.nodeId)
    && anchor.occurrenceBlockIds.some((id) => (
      blockIdSet.has(id) && !selectedBlockIdSet.has(id)
    ))
  ));
  const boundedLimit = sanitizeLimit(limitPerSide, defaultSyntenyPartnerLimitPerSide);
  const nearest = (
    direction: PlacementSyntenyAdjacencyDirection,
  ): PlacementSyntenyAdjacency[] => available
    .flatMap((anchor) => {
      const targetGap = direction === "upstream"
        ? selectedTargetStart - anchor.targetEnd
        : anchor.targetStart - selectedTargetEnd;
      if (targetGap < 0) {
        return [];
      }
      return [{ anchor, targetGap }];
    })
    .sort((left, right) => (
      left.targetGap - right.targetGap
      || (direction === "upstream"
        ? right.anchor.targetEnd - left.anchor.targetEnd
        : left.anchor.targetStart - right.anchor.targetStart)
      || left.anchor.nodeId.localeCompare(right.anchor.nodeId)
    ))
    .slice(0, boundedLimit)
    .flatMap(({ anchor, targetGap }) => anchor.occurrenceBlockIds
      .filter((id) => blockIdSet.has(id) && !selectedBlockIdSet.has(id))
      .map((partnerBlockId) => ({
        partnerBlockId,
        partnerNodeId: anchor.nodeId,
        targetName,
        direction,
        targetGap,
      })));
  const adjacencies = [...nearest("upstream"), ...nearest("downstream")];
  const byKey = new Map(adjacencies.map((adjacency) => [
    `${adjacency.partnerBlockId}\u0000${adjacency.direction}`,
    adjacency,
  ]));
  return [...byKey.values()].sort((left, right) => (
    left.direction.localeCompare(right.direction)
    || left.targetGap - right.targetGap
    || left.partnerBlockId.localeCompare(right.partnerBlockId)
  ));
}

function placementGroupOccupancyConflicts(
  blocks: ReadonlyArray<ContactMapLayoutBlock>,
  selectedBlocks: ReadonlyArray<ContactMapLayoutBlock>,
  syntenyAlleleGroups: ReadonlyArray<ReferenceSyntenyAlleleGroup>,
): PlacementGroupOccupancyConflict[] {
  const selectedIdSet = new Set(selectedBlocks.map((block) => block.id));
  const blocksById = new Map(blocks.map((block) => [block.id, block]));
  const conflictsByKey = new Map<string, PlacementGroupOccupancyConflict>();

  const addConflict = ({
    targetObjectId,
    kind,
    locusId,
    selectedBlockIds,
    occupiedBlockIds,
  }: PlacementGroupOccupancyConflict) => {
    const key = `${targetObjectId}\u0000${kind}\u0000${locusId}`;
    const existing = conflictsByKey.get(key);
    conflictsByKey.set(key, {
      targetObjectId,
      kind,
      locusId,
      selectedBlockIds: sortedUnique([
        ...(existing?.selectedBlockIds ?? []),
        ...selectedBlockIds,
      ]),
      occupiedBlockIds: sortedUnique([
        ...(existing?.occupiedBlockIds ?? []),
        ...occupiedBlockIds,
      ]),
    });
  };

  const selectedByExactSource = new Map<string, ContactMapLayoutBlock[]>();
  for (const selectedBlock of selectedBlocks) {
    const key = exactSourceIntervalKey(selectedBlock);
    const values = selectedByExactSource.get(key) ?? [];
    values.push(selectedBlock);
    selectedByExactSource.set(key, values);
  }
  for (const block of blocks) {
    if (selectedIdSet.has(block.id)) {
      continue;
    }
    const locusId = exactSourceIntervalKey(block);
    const matchingSelection = selectedByExactSource.get(locusId);
    if (!matchingSelection) {
      continue;
    }
    addConflict({
      targetObjectId: block.objectId,
      kind: "exact-source",
      locusId,
      selectedBlockIds: matchingSelection.map((selectedBlock) => selectedBlock.id),
      occupiedBlockIds: [block.id],
    });
  }

  for (const group of syntenyAlleleGroups) {
    const selectedMembers = group.members.filter((member) => (
      member.occurrenceBlockIds.some((id) => selectedIdSet.has(id))
    ));
    if (selectedMembers.length === 0) {
      continue;
    }
    const selectedMemberIds = new Set(selectedMembers.map((member) => member.nodeId));
    const selectedGroupBlockIds = selectedMembers.flatMap((member) => (
      member.occurrenceBlockIds.filter((id) => selectedIdSet.has(id))
    ));
    for (const occupiedMember of group.members) {
      if (selectedMemberIds.has(occupiedMember.nodeId)) {
        continue;
      }
      for (const occupiedBlockId of occupiedMember.occurrenceBlockIds) {
        if (selectedIdSet.has(occupiedBlockId)) {
          continue;
        }
        const occupiedBlock = blocksById.get(occupiedBlockId);
        if (!occupiedBlock) {
          continue;
        }
        addConflict({
          targetObjectId: occupiedBlock.objectId,
          kind: "paf-allele-locus",
          locusId: group.id,
          selectedBlockIds: selectedGroupBlockIds,
          occupiedBlockIds: [occupiedBlockId],
        });
      }
    }
  }

  return [...conflictsByKey.values()].sort((left, right) => (
    left.targetObjectId.localeCompare(right.targetObjectId)
    || left.kind.localeCompare(right.kind)
    || left.locusId.localeCompare(right.locusId)
  ));
}

export function enumeratePlacementBoundaries(
  blocks: ReadonlyArray<ContactMapLayoutBlock>,
  selection: AssemblySelection | null,
): PlacementRecommendationBoundary[] {
  const selected = selectedPlacementBlock(blocks, selection);
  if ("status" in selected) {
    return [];
  }
  const model = buildAssemblyEditModel([...blocks]);
  const objectOrder = [...new Set(model.assemblyBlocks.map((unit) => unit.objectId))];
  const selectedObjectUnits = model.assemblyBlocks.filter(
    (unit) => unit.objectId === selected.objectId,
  );
  const selectedUnitIdSet = new Set(selected.unitIds);
  const lastSelectedIndex = selectedObjectUnits.findIndex((unit) => (
    unit.id === selected.unitIds[selected.unitIds.length - 1]
  ));
  const currentTargetBlockId = selectedObjectUnits[lastSelectedIndex + 1]?.id ?? null;
  const boundaries: PlacementRecommendationBoundary[] = [];

  for (const objectId of objectOrder) {
    const units = model.assemblyBlocks.filter((unit) => (
      unit.objectId === objectId && !selectedUnitIdSet.has(unit.id)
    ));
    if (units.length === 0) {
      if (objectId === selected.objectId) {
        boundaries.push(makeBoundary({
          objectId,
          targetBlockId: null,
          visualPosition: selected.blocks[0].visualStart,
          chromosomeEnd: "end",
          leftBlockId: null,
          rightBlockId: null,
          isCurrentBoundary: currentTargetBlockId === null,
        }));
      }
      continue;
    }
    for (let index = 0; index < units.length; index += 1) {
      const left = units[index - 1] ?? null;
      const right = units[index];
      boundaries.push(makeBoundary({
        objectId,
        targetBlockId: right.id,
        visualPosition: right.visualStart,
        chromosomeEnd: index === 0 ? "start" : null,
        leftBlockId: lastContigId(left),
        rightBlockId: firstContigId(right),
        isCurrentBoundary: objectId === selected.objectId
          && right.id === currentTargetBlockId,
      }));
    }
    const left = units[units.length - 1];
    boundaries.push(makeBoundary({
      objectId,
      targetBlockId: null,
      visualPosition: left.visualEnd,
      chromosomeEnd: "end",
      leftBlockId: lastContigId(left),
      rightBlockId: null,
      isCurrentBoundary: objectId === selected.objectId
        && currentTargetBlockId === null,
    }));
  }
  return boundaries;
}

export function rankPlacementRecommendations(
  plan: PlacementRecommendationPlan,
  resultsByRequest: ReadonlyMap<string, GfaEndpointHiCLoadResult>,
  blocks: ReadonlyArray<ContactMapLayoutBlock>,
  limit = 3,
  rankingMode: PlacementRecommendationRankingMode = "legacy",
): PlacementRecommendation[] {
  const blocksById = new Map(blocks.map((block) => [block.id, block]));
  const coarseByPair = new Map(plan.coarseLinks.map((link) => [
    unorderedPairKey(link.source, link.target),
    link.normalizedCountPerMb2,
  ]));
  const selected: SelectedPlacementBlock = {
    blocks: plan.selectedBlocks,
    unitIds: [],
    objectId: plan.selectedBlocks[0]?.objectId ?? "",
    currentOrientation: plan.currentOrientation,
  };
  const ranked = plan.candidates.flatMap((candidate) => {
    const junctions = candidateEndpointJunctions(selected, candidate, blocks);
    const pafAdjacencyMatchCount = candidatePafAdjacencyMatchCount(
      selected,
      candidate,
      blocks,
      plan.syntenyAnchors,
      plan.syntenyAdjacencies,
    );
    const evidence = junctions.map((junction) => scoreJunction(
      junction.selectedBlock,
      blocksById.get(junction.partnerBlockId),
      junction.side,
      junction.selectedSide,
      junction.partnerSide,
      resultsByRequest.get(placementEndpointRequestKey({
        sourceBlockId: junction.selectedBlock.id,
        targetBlockId: junction.partnerBlockId,
      })),
      plan.gfaEdges,
      plan.syntenyMaskByPair.get(syntenyAllelePairKey(
        junction.selectedBlock.id,
        junction.partnerBlockId,
      )),
    ));
    const supported = evidence.filter((junction) => junction.normalizedCountPerMb2 > 0);
    const gfaMatchCount = evidence.filter((junction) => junction.gfaMatch).length;
    if (supported.length === 0 && gfaMatchCount === 0 && pafAdjacencyMatchCount === 0) {
      return [];
    }
    const contactScore = supported.length >= 2
      ? Math.sqrt(supported[0].normalizedCountPerMb2 * supported[1].normalizedCountPerMb2)
      : supported[0]?.normalizedCountPerMb2 ?? 0;
    const coarseValues = junctions
      .map((junction) => coarseByPair.get(unorderedPairKey(
        junction.selectedBlock.id,
        junction.partnerBlockId,
      )) ?? 0)
      .filter((value) => value > 0);
    const coarseScore = coarseValues.length >= 2
      ? Math.sqrt(coarseValues[0] * coarseValues[1])
      : coarseValues[0] ?? 0;
    const backgroundScore = aggregateBackgroundScore(evidence);
    const bestEndpointMatchCount = supported.filter((junction) => junction.bestEndpointMatch).length;
    const syntenyPrunedJunctionCount = evidence.filter(
      (junction) => junction.syntenyPruneReason !== null,
    ).length;
    const occupancyConflicts = plan.occupancyConflicts.filter(
      (conflict) => conflict.targetObjectId === candidate.targetObjectId,
    );
    const confidence = recommendationConfidence({
      copyAmbiguous: plan.copyAmbiguous,
      occupancyConflictCount: occupancyConflicts.length,
      supportedJunctionCount: supported.length,
      bestEndpointMatchCount,
      gfaMatchCount,
      complete: evidence.every((junction) => junction.complete),
    });
    return [{
      ...candidate,
      selectedBlockIds: plan.selectedBlocks.map((block) => block.id),
      rank: 0,
      confidence,
      junctions: evidence,
      supportedJunctionCount: supported.length,
      bestEndpointMatchCount,
      gfaMatchCount,
      contactScore,
      coarseScore,
      backgroundScore,
      pafAdjacencyMatchCount,
      copyAmbiguous: plan.copyAmbiguous,
      syntenyPrunedJunctionCount,
      occupancyConflicts,
    }];
  }).sort((left, right) => compareRecommendations(left, right, rankingMode));

  return ranked
    .slice(0, sanitizeLimit(limit, 3))
    .map((recommendation, index) => ({ ...recommendation, rank: index + 1 }));
}

export function applyPlacementRecommendation(
  blocks: ContactMapLayoutBlock[],
  selection: AssemblySelection | null,
  recommendation: Pick<
    PlacementRecommendationCandidate,
    "targetObjectId" | "targetBlockId" | "orientation"
  > & { selectedBlockIds: string[] },
): ContactMapLayoutBlock[] {
  const selected = selectedPlacementBlock(blocks, selection);
  if (
    "status" in selected
    || !sameIds(
      selected.blocks.map((block) => block.id),
      recommendation.selectedBlockIds,
    )
  ) {
    return blocks;
  }
  const boundary = enumeratePlacementBoundaries(blocks, selection).find((candidate) => (
    candidate.targetObjectId === recommendation.targetObjectId
    && candidate.targetBlockId === recommendation.targetBlockId
  ));
  if (!boundary) {
    return blocks;
  }
  const oriented = selected.currentOrientation === recommendation.orientation
    ? blocks
    : reverseSelection(blocks, selection);
  if (boundary.isCurrentBoundary) {
    return oriented;
  }
  const moved = moveSelectionBefore(
    oriented,
    selection,
    recommendation.targetBlockId,
    recommendation.targetObjectId,
  );
  return moved === oriented ? blocks : moved;
}

export interface PlacementRecommendationPreviewLayout {
  blocks: ContactMapLayoutBlock[];
  selectedStart: number;
  selectedEnd: number;
  centerBp: number;
}

/**
 * Build the proposed layout without committing it to assembly history.
 * Resolve the selected interval again after the move because removing it from
 * its current chromosome can shift the recommended boundary.
 */
export function buildPlacementRecommendationPreviewLayout(
  blocks: ContactMapLayoutBlock[],
  selection: AssemblySelection | null,
  recommendation: Pick<
    PlacementRecommendationCandidate,
    "targetObjectId" | "targetBlockId" | "orientation"
  > & { selectedBlockIds: string[] },
): PlacementRecommendationPreviewLayout | null {
  const previewBlocks = applyPlacementRecommendation(blocks, selection, recommendation);
  if (previewBlocks === blocks) {
    return null;
  }
  const selectedIds = new Set(recommendation.selectedBlockIds);
  const previewSelection = previewBlocks.filter((block) => selectedIds.has(block.id));
  if (previewSelection.length !== selectedIds.size || previewSelection.length === 0) {
    return null;
  }
  const selectedStart = Math.min(...previewSelection.map((block) => block.visualStart));
  const selectedEnd = Math.max(...previewSelection.map((block) => block.visualEnd));
  if (!Number.isFinite(selectedStart) || !Number.isFinite(selectedEnd) || selectedEnd <= selectedStart) {
    return null;
  }
  return {
    blocks: previewBlocks,
    selectedStart,
    selectedEnd,
    centerBp: (selectedStart + selectedEnd) / 2,
  };
}

function makeBoundary({
  objectId,
  targetBlockId,
  visualPosition,
  chromosomeEnd,
  leftBlockId,
  rightBlockId,
  isCurrentBoundary,
}: {
  objectId: string;
  targetBlockId: string | null;
  visualPosition: number;
  chromosomeEnd: "start" | "end" | null;
  leftBlockId: string | null;
  rightBlockId: string | null;
  isCurrentBoundary: boolean;
}): PlacementRecommendationBoundary {
  return {
    id: [objectId, targetBlockId ?? "end"].join("\u0000"),
    targetObjectId: objectId,
    targetBlockId,
    visualPosition,
    chromosomeEnd,
    leftBlockId,
    rightBlockId,
    isCurrentBoundary,
  };
}

interface CandidateEndpointJunction {
  side: "left" | "right";
  partnerBlockId: string;
  selectedBlock: ContactMapLayoutBlock;
  selectedSide: GfaSegmentSide;
  partnerSide: GfaSegmentSide;
}

function candidatePafAdjacencyMatchCount(
  selected: SelectedPlacementBlock,
  candidate: PlacementRecommendationCandidate,
  blocks: ReadonlyArray<ContactMapLayoutBlock>,
  anchors: ReadonlyArray<ReferenceSyntenyAnchor>,
  adjacencies: ReadonlyArray<PlacementSyntenyAdjacency>,
) {
  const directions = candidateSelectedReferenceDirections(selected, candidate, anchors);
  if (!directions) {
    return 0;
  }
  const adjacencyKeys = new Set(adjacencies.map((adjacency) => (
    `${adjacency.partnerBlockId}\u0000${adjacency.direction}`
  )));
  return candidateEndpointJunctions(selected, candidate, blocks).filter((junction) => (
    adjacencyKeys.has(`${junction.partnerBlockId}\u0000${directions[junction.side]}`)
  )).length;
}

function candidateSelectedReferenceDirections(
  selected: SelectedPlacementBlock,
  candidate: PlacementRecommendationCandidate,
  anchors: ReadonlyArray<ReferenceSyntenyAnchor>,
): Record<"left" | "right", PlacementSyntenyAdjacencyDirection> | null {
  const firstSelected = selected.blocks[0];
  const lastSelected = selected.blocks[selected.blocks.length - 1];
  if (!firstSelected || !lastSelected) {
    return null;
  }
  const anchorByBlockId = new Map<string, ReferenceSyntenyAnchor>();
  for (const anchor of anchors) {
    for (const blockId of anchor.occurrenceBlockIds) {
      anchorByBlockId.set(blockId, anchor);
    }
  }
  const reversed = candidate.orientation !== selected.currentOrientation;
  const leftSelected = reversed ? lastSelected : firstSelected;
  const rightSelected = reversed ? firstSelected : lastSelected;
  const leftSelectedSide = reversed
    ? rightPhysicalSide(lastSelected.orientation)
    : leftPhysicalSide(firstSelected.orientation);
  const rightSelectedSide = reversed
    ? leftPhysicalSide(firstSelected.orientation)
    : rightPhysicalSide(lastSelected.orientation);
  const leftAnchor = anchorByBlockId.get(leftSelected.id);
  const rightAnchor = anchorByBlockId.get(rightSelected.id);
  if (
    !leftSelectedSide
    || !rightSelectedSide
    || !leftAnchor
    || !rightAnchor
    || leftAnchor.targetName !== rightAnchor.targetName
    || leftAnchor.strandDominance < 0.75
    || rightAnchor.strandDominance < 0.75
  ) {
    return null;
  }
  const leftCoordinate = anchorCoordinateForPhysicalSide(leftAnchor, leftSelectedSide);
  const rightCoordinate = anchorCoordinateForPhysicalSide(rightAnchor, rightSelectedSide);
  if (leftCoordinate === rightCoordinate) {
    return null;
  }
  return leftCoordinate < rightCoordinate
    ? { left: "upstream", right: "downstream" }
    : { left: "downstream", right: "upstream" };
}

function anchorCoordinateForPhysicalSide(
  anchor: ReferenceSyntenyAnchor,
  side: GfaSegmentSide,
) {
  if (side === "start") {
    return anchor.targetStrand === "+" ? anchor.targetStart : anchor.targetEnd;
  }
  return anchor.targetStrand === "+" ? anchor.targetEnd : anchor.targetStart;
}

function candidateEndpointJunctions(
  selected: SelectedPlacementBlock,
  candidate: PlacementRecommendationCandidate,
  blocks: ReadonlyArray<ContactMapLayoutBlock>,
): CandidateEndpointJunction[] {
  const firstSelected = selected.blocks[0];
  const lastSelected = selected.blocks[selected.blocks.length - 1];
  if (!firstSelected || !lastSelected) {
    return [];
  }
  const reversed = candidate.orientation !== selected.currentOrientation;
  const leftSelected = reversed ? lastSelected : firstSelected;
  const rightSelected = reversed ? firstSelected : lastSelected;
  const leftSelectedSide = reversed
    ? rightPhysicalSide(lastSelected.orientation)
    : leftPhysicalSide(firstSelected.orientation);
  const rightSelectedSide = reversed
    ? leftPhysicalSide(firstSelected.orientation)
    : rightPhysicalSide(lastSelected.orientation);
  const blocksById = new Map(blocks.map((block) => [block.id, block]));
  const junctions: CandidateEndpointJunction[] = [];
  if (candidate.leftBlockId && leftSelectedSide) {
    const partnerSide = rightPhysicalSide(
      blocksById.get(candidate.leftBlockId)?.orientation,
    );
    if (partnerSide) {
      junctions.push({
        side: "left",
        partnerBlockId: candidate.leftBlockId,
        selectedBlock: leftSelected,
        selectedSide: leftSelectedSide,
        partnerSide,
      });
    }
  }
  if (candidate.rightBlockId && rightSelectedSide) {
    const partnerSide = leftPhysicalSide(
      blocksById.get(candidate.rightBlockId)?.orientation,
    );
    if (partnerSide) {
      junctions.push({
        side: "right",
        partnerBlockId: candidate.rightBlockId,
        selectedBlock: rightSelected,
        selectedSide: rightSelectedSide,
        partnerSide,
      });
    }
  }
  return junctions;
}

export function placementEndpointRequestKey(
  request: Pick<GfaEndpointHiCLoadRequest, "sourceBlockId" | "targetBlockId">,
) {
  return `${request.sourceBlockId}\u0000${request.targetBlockId}`;
}

function scoreJunction(
  selectedBlock: ContactMapLayoutBlock,
  partnerBlock: ContactMapLayoutBlock | undefined,
  side: "left" | "right",
  selectedSide: GfaSegmentSide,
  partnerSide: GfaSegmentSide,
  result: GfaEndpointHiCLoadResult | undefined,
  gfaEdges: ReadonlyArray<GfaGraphEdge>,
  syntenyMask: SyntenyAlleleSignalMask | undefined,
): PlacementJunctionEvidence {
  const empty = {
    side,
    partnerBlockId: partnerBlock?.id ?? "missing",
    normalizedCountPerMb2: 0,
    rawNormalizedCountPerMb2: 0,
    rawCount: 0,
    endpointEnrichment: 0,
    complete: false,
    bestEndpointMatch: false,
    contrastToNext: null,
    gfaMatch: partnerBlock
      ? hasGfaPortMatch(gfaEdges, selectedBlock.id, selectedSide, partnerBlock.id, partnerSide)
      : false,
    syntenyPruneReason: syntenyMask?.reason ?? null,
  };
  if (!partnerBlock || !result || result.status !== "ready") {
    return empty;
  }
  const evidence = result.evidence;
  const selectedIsSource = evidence.sourceBlockId === selectedBlock.id;
  const selectedIsTarget = evidence.targetBlockId === selectedBlock.id;
  if (!selectedIsSource && !selectedIsTarget) {
    return empty;
  }
  const quadrant = evidence.quadrants.find((candidate) => {
    const selectedEndpoint = selectedIsSource
      ? candidate.sourceEndpoint
      : candidate.targetEndpoint;
    const partnerEndpoint = selectedIsSource
      ? candidate.targetEndpoint
      : candidate.sourceEndpoint;
    return physicalSideForDisplayedEndpoint(selectedBlock.orientation, selectedEndpoint) === selectedSide
      && physicalSideForDisplayedEndpoint(partnerBlock.orientation, partnerEndpoint) === partnerSide;
  });
  const best = evidence.bestQuadrant;
  const factor = syntenyMask?.factor ?? 1;
  const bestEndpointMatch = Boolean(factor > 0 && quadrant && best
    && quadrant.sourceEndpoint === best.sourceEndpoint
    && quadrant.targetEndpoint === best.targetEndpoint);
  const rawNormalizedCountPerMb2 = quadrant?.normalizedCountPerMb2 ?? 0;
  const backgroundValues = evidence.quadrants
    .filter((candidate) => candidate !== quadrant)
    .map((candidate) => candidate.normalizedCountPerMb2)
    .filter((value) => Number.isFinite(value) && value >= 0);
  const backgroundMean = backgroundValues.length > 0
    ? backgroundValues.reduce((sum, value) => sum + value, 0) / backgroundValues.length
    : 0;
  const endpointEnrichment = factor > 0 && rawNormalizedCountPerMb2 > 0
    ? Math.log2((rawNormalizedCountPerMb2 + 1) / (backgroundMean + 1))
    : 0;
  return {
    ...empty,
    normalizedCountPerMb2: rawNormalizedCountPerMb2 * factor,
    rawNormalizedCountPerMb2,
    rawCount: quadrant?.rawCount ?? 0,
    endpointEnrichment,
    complete: evidence.complete,
    bestEndpointMatch,
    contrastToNext: bestEndpointMatch ? evidence.contrastToNext : null,
  };
}

function applySyntenyMaskToCoarseLink(
  link: GfaHiCLink,
  maskByPair: ReadonlyMap<string, SyntenyAlleleSignalMask>,
): GfaHiCLink | null {
  const factor = maskByPair.get(syntenyAllelePairKey(link.source, link.target))?.factor ?? 1;
  if (!Number.isFinite(factor) || factor <= 0) {
    return null;
  }
  if (factor === 1) {
    return link;
  }
  return {
    ...link,
    rawCount: link.rawCount * factor,
    normalizedCountPerMb2: link.normalizedCountPerMb2 * factor,
  };
}

function hasGfaPortMatch(
  edges: ReadonlyArray<GfaGraphEdge>,
  selectedId: string,
  selectedSide: GfaSegmentSide,
  partnerId: string,
  partnerSide: GfaSegmentSide,
) {
  return edges.some((edge) => edge.kind === "gfa-link" && (
    (
      edge.source === selectedId
      && edge.sourceSide === selectedSide
      && edge.target === partnerId
      && edge.targetSide === partnerSide
    ) || (
      edge.target === selectedId
      && edge.targetSide === selectedSide
      && edge.source === partnerId
      && edge.sourceSide === partnerSide
    )
  ));
}

function recommendationConfidence({
  copyAmbiguous,
  occupancyConflictCount,
  supportedJunctionCount,
  bestEndpointMatchCount,
  gfaMatchCount,
  complete,
}: {
  copyAmbiguous: boolean;
  occupancyConflictCount: number;
  supportedJunctionCount: number;
  bestEndpointMatchCount: number;
  gfaMatchCount: number;
  complete: boolean;
}): PlacementRecommendationConfidence {
  if (copyAmbiguous || occupancyConflictCount > 0) {
    return "ambiguous";
  }
  if (
    complete
    && supportedJunctionCount === 2
    && bestEndpointMatchCount === 2
    && gfaMatchCount >= 1
  ) {
    return "high";
  }
  if (
    complete
    && (
      (supportedJunctionCount === 2 && bestEndpointMatchCount >= 1)
      || (supportedJunctionCount >= 1 && gfaMatchCount >= 1)
    )
  ) {
    return "medium";
  }
  return "review";
}

function compareRecommendations(
  left: Omit<PlacementRecommendation, "rank">,
  right: Omit<PlacementRecommendation, "rank">,
  rankingMode: PlacementRecommendationRankingMode,
) {
  const occupancyOrder = Number(left.occupancyConflicts.length > 0)
    - Number(right.occupancyConflicts.length > 0);
  if (occupancyOrder !== 0) {
    return occupancyOrder;
  }
  if (rankingMode !== "legacy") {
    const assistedOrder = right.pafAdjacencyMatchCount - left.pafAdjacencyMatchCount
      || (rankingMode === "synteny-assisted"
        ? right.backgroundScore - left.backgroundScore
        : 0);
    if (assistedOrder !== 0) {
      return assistedOrder;
    }
  }
  return right.supportedJunctionCount - left.supportedJunctionCount
    || right.bestEndpointMatchCount - left.bestEndpointMatchCount
    || right.gfaMatchCount - left.gfaMatchCount
    || right.contactScore - left.contactScore
    || right.coarseScore - left.coarseScore
    || Number(right.isCurrent) - Number(left.isCurrent)
    || left.targetObjectId.localeCompare(right.targetObjectId)
    || left.visualPosition - right.visualPosition
    || left.orientation.localeCompare(right.orientation);
}

function aggregateBackgroundScore(evidence: ReadonlyArray<PlacementJunctionEvidence>) {
  const values = evidence.map((junction) => junction.endpointEnrichment);
  if (values.length === 0) {
    return 0;
  }
  if (values.length === 1) {
    return values[0] * 0.5;
  }
  values.sort((left, right) => left - right);
  return values[0] + values[values.length - 1] * 0.35;
}

function compareCoarseLinks(left: GfaHiCLink, right: GfaHiCLink) {
  return right.normalizedCountPerMb2 - left.normalizedCountPerMb2
    || right.rawCount - left.rawCount
    || left.id.localeCompare(right.id);
}

function occupancyTierPartnerIds<T extends { source: string; target: string }>(
  evidence: ReadonlyArray<T>,
  selectedIdSet: ReadonlySet<string>,
  blocksById: ReadonlyMap<string, ContactMapLayoutBlock>,
  occupiedObjectIds: ReadonlySet<string>,
  limitPerTier: number,
) {
  const compatible: string[] = [];
  const conflicting: string[] = [];
  const compatibleSeen = new Set<string>();
  const conflictingSeen = new Set<string>();
  for (const item of evidence) {
    const partnerId = selectedIdSet.has(item.source) ? item.target : item.source;
    const partnerObjectId = blocksById.get(partnerId)?.objectId;
    const isConflict = partnerObjectId !== undefined && occupiedObjectIds.has(partnerObjectId);
    const values = isConflict ? conflicting : compatible;
    const seen = isConflict ? conflictingSeen : compatibleSeen;
    if (seen.has(partnerId) || values.length >= limitPerTier) {
      continue;
    }
    seen.add(partnerId);
    values.push(partnerId);
  }
  return [...compatible, ...conflicting];
}

function leftPhysicalSide(orientation: ContactMapLayoutBlock["orientation"] | undefined) {
  return orientation === "+" ? "start" as const : orientation === "-" ? "end" as const : null;
}

function rightPhysicalSide(orientation: ContactMapLayoutBlock["orientation"] | undefined) {
  return orientation === "+" ? "end" as const : orientation === "-" ? "start" as const : null;
}

function firstContigId(unit: ReturnType<typeof buildAssemblyEditModel>["assemblyBlocks"][number] | null) {
  return unit?.contigIds[0] ?? null;
}

function lastContigId(unit: ReturnType<typeof buildAssemblyEditModel>["assemblyBlocks"][number] | null) {
  return unit?.contigIds[unit.contigIds.length - 1] ?? null;
}

function unorderedPairKey(left: string, right: string) {
  return left < right ? `${left}\u0000${right}` : `${right}\u0000${left}`;
}

function exactSourceIntervalKey(block: ContactMapLayoutBlock) {
  return `${block.sourceId}\u0001${block.sourceStart}\u0001${block.sourceEnd}`;
}

function sortedUnique(values: ReadonlyArray<string>) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function uniqueAnchors(anchors: ReadonlyArray<ReferenceSyntenyAnchor>) {
  return [...new Map(anchors.map((anchor) => [anchor.nodeId, anchor])).values()];
}

function sameIds(left: ReadonlyArray<string>, right: ReadonlyArray<string>) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function sanitizeLimit(value: number, fallback: number) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
