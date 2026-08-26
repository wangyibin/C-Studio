import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildPafSyntenyPreview } from "../src/state/pafPreview";
import { parseAgpLayout, type ContactMapLayoutBlock } from "../src/state/importers";
import {
  buildReferenceSyntenyAllelePruning,
  syntenyAllelePairKey,
  type ReferenceSyntenyAlleleEdge,
  type ReferenceSyntenyAnchor,
  type SyntenyAlleleSignalMask,
} from "../src/state/syntenyAllelePruning";
import {
  buildPlacementRecommendationPlan,
  placementEndpointRequestKey,
  rankPlacementRecommendations,
  type PlacementRecommendation,
  type PlacementRecommendationPlan,
  type PlacementRecommendationRankingMode,
} from "../src/state/assemblyPlacementRecommendation";
import type { GfaEndpointHiCLoadResult } from "../src/state/gfaEndpointHiC";
import type { GfaHiCLink } from "../src/state/gfaHiCLinks";

interface ContactProxy {
  method: Record<string, string>;
  changedIds: string[];
  chromLengths: Record<string, number>;
  coarse: Array<[string, string, number, number]>;
  endpointPhysical: Array<[string, string, number, number, number, number]>;
}

interface PlacementTruth {
  objectId: string;
  targetBlockId: string | null;
  orientation: "+" | "-";
  previousBlockId: string | null;
}

interface EvaluationCase {
  id: string;
  selectedBlocks: ContactMapLayoutBlock[];
  truth: PlacementTruth;
}

interface Variant {
  id: string;
  rankingMode: PlacementRecommendationRankingMode;
  maskByPair: ReadonlyMap<string, SyntenyAlleleSignalMask>;
  anchors: ReadonlyArray<ReferenceSyntenyAnchor>;
  alleleEdges: ReadonlyArray<ReferenceSyntenyAlleleEdge>;
}

interface EvaluationResult {
  recommendationCount: number;
  exactRank: number | null;
  boundaryRank: number | null;
  exactCorrectShortlisted: boolean;
  top1: string | null;
  top3: string[];
}

interface EvaluationRow {
  id: string;
  byVariant: Record<string, EvaluationResult>;
}

const defaultDataset = resolve(process.cwd(), "../benchmark/ploidy-4/n500k");
const dataset = resolve(process.argv[2] ?? defaultDataset);
const proxyPath = process.argv[3];
if (!proxyPath) {
  throw new Error(
    "usage: vite-node scripts/benchmark-placement-recommendation.ts "
    + "[dataset-dir] contact-proxy.json",
  );
}

const benchmarkStarted = performance.now();
const contactProxy = JSON.parse(readFileSync(resolve(proxyPath), "utf8")) as ContactProxy;
const inputLayout = parseAgpLayout(readFileSync(resolve(dataset, "groups.agp"), "utf8"));
const editedLayout = parseAgpLayout(
  readFileSync(resolve(dataset, "groups.edited.agp"), "utf8"),
);
const paf = buildPafSyntenyPreview(
  readFileSync(resolve(dataset, "ref_vs_contig.paf"), "utf8"),
);
const blocks = inputLayout.blocks;
const blocksById = new Map(blocks.map((block) => [block.id, block]));
const blocksBySourceId = new Map(blocks.map((block) => [block.sourceId, block]));
const coarseLinks: GfaHiCLink[] = contactProxy.coarse.flatMap(
  ([source, target, rawCount, normalizedCountPerMb2]) => {
    const sourceBlock = blocksBySourceId.get(source);
    const targetBlock = blocksBySourceId.get(target);
    if (!sourceBlock || !targetBlock) return [];
    return [{
      id: `proxy:${source}:${target}`,
      source: sourceBlock.id,
      target: targetBlock.id,
      rawCount,
      normalizedCountPerMb2,
      lineWidth: 1,
    }];
  },
);
const pruning = buildReferenceSyntenyAllelePruning(paf.records, blocks, coarseLinks);
const pairwiseMask = buildPairwiseMask(pruning.maskByPair, pruning.alleleEdges);
const endpointByPair = new Map(contactProxy.endpointPhysical.map((row) => [
  syntenyAllelePairKey(row[0], row[1]),
  row,
]));

const variants: Variant[] = [
  {
    id: "legacy",
    rankingMode: "legacy",
    maskByPair: pruning.maskByPair,
    anchors: [],
    alleleEdges: [],
  },
  {
    id: "paf-shortlist",
    rankingMode: "legacy",
    maskByPair: pruning.maskByPair,
    anchors: pruning.anchors,
    alleleEdges: pruning.alleleEdges,
  },
  {
    id: "paf-adjacency",
    rankingMode: "paf-adjacency",
    maskByPair: pruning.maskByPair,
    anchors: pruning.anchors,
    alleleEdges: pruning.alleleEdges,
  },
  {
    id: "paf-plus-background",
    rankingMode: "synteny-assisted",
    maskByPair: pruning.maskByPair,
    anchors: pruning.anchors,
    alleleEdges: pruning.alleleEdges,
  },
  {
    id: "background-only",
    rankingMode: "synteny-assisted",
    maskByPair: pruning.maskByPair,
    anchors: [],
    alleleEdges: [],
  },
  {
    id: "pairwise-hard-mask-plus-paf",
    rankingMode: "paf-adjacency",
    maskByPair: pairwiseMask,
    anchors: pruning.anchors,
    alleleEdges: pruning.alleleEdges,
  },
];
const variantRuntimeMs = Object.fromEntries(variants.map((variant) => [variant.id, 0]));
const editedTruth = buildEditedTruth(editedLayout.blocks, blocksBySourceId);
const singletonCases: EvaluationCase[] = contactProxy.changedIds.flatMap((sourceId) => {
  const selectedBlock = blocksBySourceId.get(sourceId);
  const truth = editedTruth.get(sourceId);
  return selectedBlock && truth && (truth.orientation === "+" || truth.orientation === "-")
    ? [{ id: sourceId, selectedBlocks: [selectedBlock], truth }]
    : [];
});
const reverseEditCases = buildReverseEditCases(blocks, editedLayout.blocks, blocksBySourceId);
const singletonRows = singletonCases.map(evaluateCase);
const reverseEditRows = reverseEditCases.map(evaluateCase);

const output = {
  scope: {
    dataset,
    proxyPath: resolve(proxyPath),
    proxyTruth: "groups.edited.agp local boundary and orientation",
    proxyEvidence: contactProxy.method,
    independentAssemblyTruth: false,
    gfaEvidenceUsed: false,
    syntenyPartnerLimitPerSide: 4,
  },
  paf: {
    acceptedAnchors: pruning.anchors.length,
    excludedBlocks: pruning.excludedBlockCount,
    multiMappingBlocks: pruning.multiMappingBlockCount,
    splitMappingBlocks: pruning.splitMappingBlockCount,
    repetitiveMappingBlocks: pruning.repetitiveMappingBlockCount,
    compactGroupDirectPairs: pruning.compactGroupAlleleOccurrencePairCount,
    activeDirectMasks: pruning.directAllelePairCount,
    shadowOnlyPairs: pruning.shadowOnlyAlleleOccurrencePairCount,
    pairwiseDirectPairs: pruning.pairwiseAlleleOccurrencePairCount,
    pairwiseEdges: pruning.alleleEdges.length,
  },
  changedSingletons: summarizeVariants(singletonRows),
  reverseEditBlocks: {
    cases: reverseEditCases.map((editCase) => ({
      id: editCase.id,
      selectedContigs: editCase.selectedBlocks.length,
      truth: editCase.truth,
    })),
    variants: summarizeVariants(reverseEditRows),
  },
  runtime: {
    variantEvaluationMs: Object.fromEntries(Object.entries(variantRuntimeMs).map(
      ([id, duration]) => [id, round(duration)],
    )),
    totalMs: round(performance.now() - benchmarkStarted),
  },
};
console.log(JSON.stringify(output, null, 2));

function evaluateCase(evaluationCase: EvaluationCase): EvaluationRow {
  const selection = {
    kind: "contigs" as const,
    ids: evaluationCase.selectedBlocks.map((block) => block.id),
    exact: true,
  };
  const plans = new Map<string, PlacementRecommendationPlan>();
  for (const variant of variants) {
    const started = performance.now();
    const result = buildPlacementRecommendationPlan({
      blocks,
      selection,
      coarseLinks,
      syntenyMaskByPair: variant.maskByPair,
      syntenyAlleleGroups: pruning.groups,
      syntenyAnchors: variant.anchors,
      syntenyAlleleEdges: variant.alleleEdges,
      syntenyPartnerLimitPerSide: 4,
    });
    variantRuntimeMs[variant.id] += performance.now() - started;
    if (result.status === "ready") {
      plans.set(variant.id, result);
    }
  }
  const requests = new Map([...plans.values()].flatMap((plan) => plan.requests).map(
    (request) => [placementEndpointRequestKey(request), request],
  ));
  const resultsByRequest = new Map<string, GfaEndpointHiCLoadResult>();
  for (const [key, request] of requests) {
    resultsByRequest.set(key, endpointResult(
      request.sourceBlockId,
      request.targetBlockId,
      blocksById,
      endpointByPair,
      contactProxy.chromLengths,
    ));
  }
  const byVariant: Record<string, EvaluationResult> = {};
  for (const variant of variants) {
    const plan = plans.get(variant.id);
    if (!plan) {
      byVariant[variant.id] = emptyEvaluationResult();
      continue;
    }
    const started = performance.now();
    const ranked = rankPlacementRecommendations(
      plan,
      resultsByRequest,
      blocks,
      100_000,
      variant.rankingMode,
    );
    variantRuntimeMs[variant.id] += performance.now() - started;
    byVariant[variant.id] = {
      recommendationCount: ranked.length,
      exactRank: matchingRank(ranked, evaluationCase.truth, true),
      boundaryRank: matchingRank(ranked, evaluationCase.truth, false),
      exactCorrectShortlisted: hasMatchingCandidate(plan, evaluationCase.truth),
      top1: recommendationKey(ranked[0]),
      top3: ranked.slice(0, 3).map((recommendation) => (
        recommendationKey(recommendation) ?? "missing"
      )),
    };
  }
  return { id: evaluationCase.id, byVariant };
}

function summarizeVariants(rows: ReadonlyArray<EvaluationRow>) {
  const legacy = rows.map((row) => row.byVariant.legacy);
  return Object.fromEntries(variants.map((variant) => {
    const values = rows.map((row) => row.byVariant[variant.id]);
    return [variant.id, {
      count: rows.length,
      recommendationCoverage: values.filter((value) => value.recommendationCount > 0).length,
      exactTop1: values.filter((value) => within(value.exactRank, 1)).length,
      exactTop3: values.filter((value) => within(value.exactRank, 3)).length,
      boundaryTop1: values.filter((value) => within(value.boundaryRank, 1)).length,
      boundaryTop3: values.filter((value) => within(value.boundaryRank, 3)).length,
      exactCorrectShortlisted: values.filter((value) => value.exactCorrectShortlisted).length,
      correctRankImprovedVsLegacy: values.filter((value, index) => (
        compareRank(value.exactRank, legacy[index].exactRank) < 0
      )).length,
      correctRankWorsenedVsLegacy: values.filter((value, index) => (
        compareRank(value.exactRank, legacy[index].exactRank) > 0
      )).length,
      top1ChangedVsLegacy: values.filter((value, index) => (
        value.top1 !== legacy[index].top1
      )).length,
      top3ChangedVsLegacy: values.filter((value, index) => (
        value.top3.join("\u0000") !== legacy[index].top3.join("\u0000")
      )).length,
    }];
  }));
}

function buildPairwiseMask(
  legacy: ReadonlyMap<string, SyntenyAlleleSignalMask>,
  edges: ReadonlyArray<ReferenceSyntenyAlleleEdge>,
) {
  const result = new Map([...legacy].filter(([, mask]) => mask.reason !== "direct-allele"));
  for (const edge of edges) {
    for (const sourceBlockId of edge.left.occurrenceBlockIds) {
      for (const targetBlockId of edge.right.occurrenceBlockIds) {
        result.set(syntenyAllelePairKey(sourceBlockId, targetBlockId), {
          sourceBlockId,
          targetBlockId,
          factor: 0,
          reason: "direct-allele" as const,
          sourceGroupId: edge.id,
          targetGroupId: edge.id,
        });
      }
    }
  }
  return result;
}

function buildEditedTruth(
  editedBlocks: ReadonlyArray<ContactMapLayoutBlock>,
  currentBySourceId: ReadonlyMap<string, ContactMapLayoutBlock>,
) {
  const truth = new Map<string, PlacementTruth>();
  for (const [objectId, objectBlocks] of blocksGroupedByObject(editedBlocks)) {
    objectBlocks.forEach((block, index) => {
      truth.set(block.sourceId, {
        objectId,
        targetBlockId: objectBlocks[index + 1]
          ? currentBySourceId.get(objectBlocks[index + 1].sourceId)?.id ?? null
          : null,
        previousBlockId: objectBlocks[index - 1]
          ? currentBySourceId.get(objectBlocks[index - 1].sourceId)?.id ?? null
          : null,
        orientation: block.orientation as "+" | "-",
      });
    });
  }
  return truth;
}

function buildReverseEditCases(
  currentBlocks: ReadonlyArray<ContactMapLayoutBlock>,
  editedBlocks: ReadonlyArray<ContactMapLayoutBlock>,
  currentBySourceId: ReadonlyMap<string, ContactMapLayoutBlock>,
) {
  const currentByObject = blocksGroupedByObject(currentBlocks);
  const editedByObject = blocksGroupedByObject(editedBlocks);
  const cases: EvaluationCase[] = [];
  for (const [objectId, currentObjectBlocks] of currentByObject) {
    const editedObjectBlocks = editedByObject.get(objectId);
    if (!editedObjectBlocks) continue;
    const editedIndex = new Map(editedObjectBlocks.map((block, index) => [block.sourceId, index]));
    let index = 0;
    while (index < currentObjectBlocks.length) {
      const first = currentObjectBlocks[index];
      const firstEditedIndex = editedIndex.get(first.sourceId);
      const firstEdited = firstEditedIndex === undefined
        ? undefined
        : editedObjectBlocks[firstEditedIndex];
      if (!firstEdited || first.orientation === firstEdited.orientation) {
        index += 1;
        continue;
      }
      const selectedBlocks = [first];
      let lastEditedIndex = firstEditedIndex;
      let cursor = index + 1;
      while (cursor < currentObjectBlocks.length) {
        const candidate = currentObjectBlocks[cursor];
        const candidateEditedIndex = editedIndex.get(candidate.sourceId);
        const candidateEdited = candidateEditedIndex === undefined
          ? undefined
          : editedObjectBlocks[candidateEditedIndex];
        if (
          !candidateEdited
          || candidate.orientation === candidateEdited.orientation
          || candidateEditedIndex !== lastEditedIndex - 1
        ) {
          break;
        }
        selectedBlocks.push(candidate);
        lastEditedIndex = candidateEditedIndex;
        cursor += 1;
      }
      const editedStart = Math.min(...selectedBlocks.map(
        (block) => editedIndex.get(block.sourceId) ?? Number.MAX_SAFE_INTEGER,
      ));
      const editedEnd = Math.max(...selectedBlocks.map(
        (block) => editedIndex.get(block.sourceId) ?? Number.MIN_SAFE_INTEGER,
      ));
      const editedNext = editedObjectBlocks[editedEnd + 1];
      const editedPrevious = editedObjectBlocks[editedStart - 1];
      cases.push({
        id: `${selectedBlocks[0].sourceId}..${selectedBlocks[selectedBlocks.length - 1].sourceId}`,
        selectedBlocks,
        truth: {
          objectId,
          targetBlockId: editedNext
            ? currentBySourceId.get(editedNext.sourceId)?.id ?? null
            : null,
          previousBlockId: editedPrevious
            ? currentBySourceId.get(editedPrevious.sourceId)?.id ?? null
            : null,
          orientation: "-",
        },
      });
      index = cursor;
    }
  }
  return cases;
}

function blocksGroupedByObject(blockValues: ReadonlyArray<ContactMapLayoutBlock>) {
  const grouped = new Map<string, ContactMapLayoutBlock[]>();
  for (const block of [...blockValues].sort((left, right) => (
    left.visualStart - right.visualStart || left.id.localeCompare(right.id)
  ))) {
    const values = grouped.get(block.objectId) ?? [];
    values.push(block);
    grouped.set(block.objectId, values);
  }
  return grouped;
}

function endpointResult(
  sourceId: string,
  targetId: string,
  layoutBlocksById: ReadonlyMap<string, ContactMapLayoutBlock>,
  endpoints: ReadonlyMap<string, ContactProxy["endpointPhysical"][number]>,
  lengths: Readonly<Record<string, number>>,
): GfaEndpointHiCLoadResult {
  const source = layoutBlocksById.get(sourceId);
  const target = layoutBlocksById.get(targetId);
  const sourceKey = source?.sourceId ?? sourceId;
  const targetKey = target?.sourceId ?? targetId;
  const sourceLength = lengths[sourceKey] ?? source?.sourceEnd ?? 0;
  const targetLength = lengths[targetKey] ?? target?.sourceEnd ?? 0;
  if (!source || !target || sourceLength <= 0 || targetLength <= 0) {
    return { status: "unresolved", reason: "missing proxy block" };
  }
  const shortest = Math.min(sourceLength, targetLength);
  const desired = Math.min(25_000, Math.max(5_000, Math.floor(shortest / 40)));
  const resolution = Math.ceil(desired / 1_000) * 1_000;
  const sourceWindow = Math.max(1, Math.min(500_000, Math.floor(sourceLength * 0.25)));
  const targetWindow = Math.max(1, Math.min(500_000, Math.floor(targetLength * 0.25)));
  if (sourceWindow < 2 * resolution || targetWindow < 2 * resolution) {
    return { status: "unresolved", reason: "proxy endpoint resolution insufficient", resolution };
  }
  const stored = endpoints.get(syntenyAllelePairKey(sourceKey, targetKey));
  const physical = physicalMatrix(sourceKey, targetKey, stored);
  const area = (sourceWindow / 1_000_000) * (targetWindow / 1_000_000);
  const quadrants = (["left", "right"] as const).flatMap((sourceEndpoint) => (
    (["left", "right"] as const).map((targetEndpoint) => {
      const sourcePhysical = displayedPhysicalSide(source.orientation, sourceEndpoint);
      const targetPhysical = displayedPhysicalSide(target.orientation, targetEndpoint);
      const rawCount = physical[sourcePhysical][targetPhysical];
      return {
        sourceEndpoint,
        targetEndpoint,
        rawCount,
        normalizedCountPerMb2: area > 0 ? rawCount / area : 0,
      };
    })
  ));
  const ranked = [...quadrants].sort((left, right) => (
    right.normalizedCountPerMb2 - left.normalizedCountPerMb2
    || `${left.sourceEndpoint}:${left.targetEndpoint}`
      .localeCompare(`${right.sourceEndpoint}:${right.targetEndpoint}`)
  ));
  const bestQuadrant = (ranked[0]?.normalizedCountPerMb2 ?? 0) > 0 ? ranked[0] : null;
  const next = ranked[1]?.normalizedCountPerMb2 ?? 0;
  return {
    status: "ready",
    evidence: {
      sourceBlockId: sourceId,
      targetBlockId: targetId,
      resolution,
      normalization: "raw",
      sourceWindowBp: sourceWindow,
      targetWindowBp: targetWindow,
      quadrants,
      bestQuadrant,
      contrastToNext: bestQuadrant && next > 0
        ? bestQuadrant.normalizedCountPerMb2 / next
        : null,
      observedCellCount: 0,
      complete: true,
      missingTileCount: 0,
    },
  };
}

function physicalMatrix(
  sourceId: string,
  targetId: string,
  row: ContactProxy["endpointPhysical"][number] | undefined,
) {
  if (!row) return { start: { start: 0, end: 0 }, end: { start: 0, end: 0 } };
  const [, , ss, se, es, ee] = row;
  if (row[0] === sourceId && row[1] === targetId) {
    return { start: { start: ss, end: se }, end: { start: es, end: ee } };
  }
  return { start: { start: ss, end: es }, end: { start: se, end: ee } };
}

function displayedPhysicalSide(
  orientation: ContactMapLayoutBlock["orientation"],
  endpoint: "left" | "right",
) {
  if (endpoint === "left") return orientation === "+" ? "start" as const : "end" as const;
  return orientation === "+" ? "end" as const : "start" as const;
}

function matchingRank(
  ranked: ReadonlyArray<PlacementRecommendation>,
  truth: PlacementTruth,
  includeOrientation: boolean,
) {
  const index = ranked.findIndex((recommendation) => (
    recommendation.targetObjectId === truth.objectId
    && recommendation.targetBlockId === truth.targetBlockId
    && (!includeOrientation || recommendation.orientation === truth.orientation)
  ));
  return index >= 0 ? index + 1 : null;
}

function hasMatchingCandidate(plan: PlacementRecommendationPlan, truth: PlacementTruth) {
  return plan.candidates.some((candidate) => (
    candidate.targetObjectId === truth.objectId
    && candidate.targetBlockId === truth.targetBlockId
    && candidate.orientation === truth.orientation
  ));
}

function recommendationKey(recommendation: PlacementRecommendation | undefined) {
  return recommendation
    ? `${recommendation.targetObjectId}|${recommendation.targetBlockId ?? "end"}|${recommendation.orientation}`
    : null;
}

function emptyEvaluationResult(): EvaluationResult {
  return {
    recommendationCount: 0,
    exactRank: null,
    boundaryRank: null,
    exactCorrectShortlisted: false,
    top1: null,
    top3: [],
  };
}

function within(rank: number | null, limit: number) {
  return rank !== null && rank <= limit;
}

function compareRank(candidate: number | null, reference: number | null) {
  if (candidate === null && reference === null) return 0;
  return (candidate ?? Number.POSITIVE_INFINITY) - (reference ?? Number.POSITIVE_INFINITY);
}

function round(value: number) {
  return Math.round(value * 10) / 10;
}
