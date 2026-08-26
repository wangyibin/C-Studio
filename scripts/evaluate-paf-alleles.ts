import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseAgpLayout } from "../src/state/importers";
import { buildPafSyntenyPreview } from "../src/state/pafPreview";
import { buildReferenceSyntenyAllelePruning } from "../src/state/syntenyAllelePruning";

interface TruthContig {
  id: string;
  objectId: string;
  chromosome: string;
  haplotype: string;
}

interface PairMetrics {
  overlapThreshold: number;
  expectedPairs: number;
  predictedPairs: number;
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  precision: number;
  recall: number;
  f1: number;
}

const datasetPath = resolve(process.argv[2] ?? "../benchmark/ploidy-4/n500k");
const agpText = readFileSync(resolve(datasetPath, "groups.agp"), "utf8");
const truthAgpText = readFileSync(resolve(datasetPath, "groups.edited.agp"), "utf8");
const pafText = readFileSync(resolve(datasetPath, "ref_vs_contig.paf"), "utf8");

const layout = parseAgpLayout(agpText);
const paf = buildPafSyntenyPreview(pafText);
const pruning = buildReferenceSyntenyAllelePruning(paf.records, layout.blocks, []);
const truthContigs = parseTruthContigs(truthAgpText);
const truthById = new Map(truthContigs.map((contig) => [contig.id, contig]));
const sourceIdByBlockId = new Map(layout.blocks.map((block) => [block.id, block.sourceId]));
const predictedPairs = predictedAllelePairs(pruning.groups);
const pairwisePredictedPairs = pairwiseAllelePairs(pruning.alleleEdges);
const activeDirectMaskPairs = new Set([...pruning.maskByPair]
  .filter(([, mask]) => mask.reason === "direct-allele")
  .flatMap(([key]) => {
    const [leftBlockId, rightBlockId] = splitPairKey(key);
    const left = sourceIdByBlockId.get(leftBlockId);
    const right = sourceIdByBlockId.get(rightBlockId);
    return left && right && left !== right ? [pairKey(left, right)] : [];
  }));
const pafSupportedPairs = buildPafSupportedPairs(pruning.anchors, 0.5);
const pafConsistencyMetrics = comparePairSets(pafSupportedPairs, predictedPairs, 0.5);
const pairwisePafConsistencyMetrics = comparePairSets(
  pafSupportedPairs,
  pairwisePredictedPairs,
  0.5,
);
const pafContigConsistencyMetrics = contigMetrics(pafSupportedPairs, predictedPairs);
const pairwisePafContigConsistencyMetrics = contigMetrics(
  pafSupportedPairs,
  pairwisePredictedPairs,
);
const activeMaskConsistencyMetrics = comparePairSets(
  pafSupportedPairs,
  activeDirectMaskPairs,
  0.5,
);
const activeMaskContigConsistencyMetrics = contigMetrics(
  pafSupportedPairs,
  activeDirectMaskPairs,
);
const acceptedSourceIds = new Set(pruning.anchors.map((anchor) => anchor.sourceId));
const groupedSourceIds = new Set(pruning.groups.flatMap((group) => (
  group.members.map((member) => member.sourceId)
)));

const falsePositivePairs = [...predictedPairs]
  .filter((key) => !pafSupportedPairs.has(key))
  .map((key) => describePair(key, truthById))
  .sort(comparePairDescriptions);
const falseNegativePairs = [...pafSupportedPairs]
  .filter((key) => !predictedPairs.has(key))
  .map((key) => describePair(key, truthById))
  .sort(comparePairDescriptions);

const groupSummaries = pruning.groups.map((group) => {
  const ids = group.members.map((member) => member.sourceId);
  const pairKeys = allPairs(ids);
  const truePairCount = pairKeys.filter((key) => pafSupportedPairs.has(key)).length;
  return {
    id: group.id,
    size: ids.length,
    members: ids,
    haplotypes: [...new Set(ids.map((id) => truthById.get(id)?.haplotype ?? "unknown"))].sort(),
    pairPurity: pairKeys.length > 0 ? truePairCount / pairKeys.length : 1,
  };
});
const groupBySourceId = new Map(pruning.groups.flatMap((group) => (
  group.members.map((member) => [member.sourceId, group.id] as const)
)));
const falseNegativeBreakdown = countByLabels(falseNegativePairs.map((pair) => {
  const leftGroup = groupBySourceId.get(pair.left);
  const rightGroup = groupBySourceId.get(pair.right);
  if (!leftGroup || !rightGroup) return "one-or-both-singleton";
  return leftGroup === rightGroup ? "unexpected" : "split-across-groups";
}));
const falsePositiveBreakdown = countByLabels(falsePositivePairs.map((pair) => {
  const left = truthById.get(pair.left);
  const right = truthById.get(pair.right);
  if (!left || !right) return "missing-truth";
  if (left.chromosome !== right.chromosome) return "wrong-chromosome";
  if (left.haplotype === right.haplotype) return "same-haplotype";
  return "not-supported-by-paf-overlap";
}));
const coarseLabelErrors = [...predictedPairs].filter((key) => {
  const [leftId, rightId] = splitPairKey(key);
  const left = truthById.get(leftId);
  const right = truthById.get(rightId);
  return !left || !right || left.chromosome !== right.chromosome || left.haplotype === right.haplotype;
});
const pairwiseCoarseLabelErrors = [...pairwisePredictedPairs].filter((key) => {
  const [leftId, rightId] = splitPairKey(key);
  const left = truthById.get(leftId);
  const right = truthById.get(rightId);
  return !left || !right || left.chromosome !== right.chromosome || left.haplotype === right.haplotype;
});
const activeMaskCoarseLabelErrors = [...activeDirectMaskPairs].filter((key) => {
  const [leftId, rightId] = splitPairKey(key);
  const left = truthById.get(leftId);
  const right = truthById.get(rightId);
  return !left || !right || left.chromosome !== right.chromosome || left.haplotype === right.haplotype;
});
const wrongTargetAnchors = pruning.anchors.filter((anchor) => {
  const truth = truthById.get(anchor.sourceId);
  return !truth || normalizeChromosome(anchor.targetName) !== truth.chromosome;
});
const excludedSourceIds = truthContigs
  .map((contig) => contig.id)
  .filter((id) => !acceptedSourceIds.has(id))
  .sort((left, right) => left.localeCompare(right));

const output = {
  datasetPath,
  inputs: {
    agpBlocks: layout.blocks.length,
    pafRecords: paf.records.length,
    ignoredPafLines: paf.ignoredLines,
    truthContigs: truthContigs.length,
    independentLabelScope: "Chromosome and A/B/C/D haplotype parsed from simulated contig names only.",
  },
  currentDefaults: {
    minQueryCoverage: 0.5,
    minIdentity: 0.7,
    minMeanMapq: 1,
    minTargetDominance: 0.75,
    minTargetOverlap: 0.5,
    maxTargetLocusGap: 100_000,
  },
  anchorResults: {
    accepted: pruning.anchors.length,
    acceptanceRate: divide(pruning.anchors.length, truthContigs.length),
    excludedBlocks: pruning.excludedBlockCount,
    excludedSourceIds,
    multiMappingBlocks: pruning.multiMappingBlockCount,
    splitMappingBlocks: pruning.splitMappingBlockCount,
    repetitiveMappingBlocks: pruning.repetitiveMappingBlockCount,
    mixedMappingBlocks: pruning.mixedMappingBlockCount,
    exclusionReasons: countByLabels(pruning.exclusions.map((exclusion) => exclusion.reason)),
    exclusionDetails: pruning.exclusions.map((exclusion) => ({
      sourceId: exclusion.sourceId,
      blockIds: exclusion.occurrenceBlockIds,
      reason: exclusion.reason,
      candidateLoci: exclusion.candidateLoci,
    })),
    targetChromosomeAccuracy: divide(
      pruning.anchors.length - wrongTargetAnchors.length,
      pruning.anchors.length,
    ),
    wrongTargetAnchorIds: wrongTargetAnchors.map((anchor) => anchor.sourceId),
  },
  groupResults: {
    groups: pruning.groups.length,
    compactGroupOccurrencePairs: pruning.compactGroupAlleleOccurrencePairCount,
    sizeCounts: countBy(groupSummaries.map((group) => group.size)),
    groupedContigs: groupedSourceIds.size,
    groupedContigCoverage: divide(groupedSourceIds.size, truthContigs.length),
    groupsWithUniqueHaplotypes: groupSummaries.filter(
      (group) => group.haplotypes.length === group.size,
    ).length,
    pureGroups: groupSummaries.filter((group) => group.pairPurity === 1).length,
    impureGroups: groupSummaries.filter((group) => group.pairPurity < 1).length,
    meanPairPurity: mean(groupSummaries.map((group) => group.pairPurity)),
    role: "Compact display and cross-locus matching summary; not authoritative for direct-allele masking.",
  },
  activeDirectMaskResults: {
    occurrencePairs: activeDirectMaskPairs.size,
    pafInternalLocusConsistency: {
      ...activeMaskConsistencyMetrics,
      perContig: activeMaskContigConsistencyMetrics,
      independentTruth: false,
      interpretation: "Checks the direct PAF relationships currently active in Hi-C pruning and occupancy ranking.",
    },
    independentCoarseLabelValidation: {
      predictedPairs: activeDirectMaskPairs.size,
      correctSameChromosomeCrossHaplotypePairs:
        activeDirectMaskPairs.size - activeMaskCoarseLabelErrors.length,
      precision: divide(
        activeDirectMaskPairs.size - activeMaskCoarseLabelErrors.length,
        activeDirectMaskPairs.size,
      ),
      errorExamples: activeMaskCoarseLabelErrors.slice(0, 30)
        .map((key) => describePair(key, truthById)),
      locusLevelRecallAvailable: false,
    },
  },
  pairwiseEdgeResults: {
    sourceLocusEdges: pruning.alleleEdges.length,
    occurrencePairs: pruning.pairwiseAlleleOccurrencePairCount,
    shadowOnlyOccurrencePairs: pruning.shadowOnlyAlleleOccurrencePairCount,
    legacyOnlyOccurrencePairs: pruning.legacyOnlyAlleleOccurrencePairCount,
    confidenceCounts: countByLabels(pruning.alleleEdges.map((edge) => edge.confidence)),
    confidenceScore: {
      minimum: Math.min(...pruning.alleleEdges.map((edge) => edge.confidenceScore)),
      mean: mean(pruning.alleleEdges.map((edge) => edge.confidenceScore)),
      maximum: Math.max(...pruning.alleleEdges.map((edge) => edge.confidenceScore)),
    },
    pafInternalLocusConsistency: {
      ...pairwisePafConsistencyMetrics,
      perContig: pairwisePafContigConsistencyMetrics,
      independentTruth: false,
      interpretation: "Checks that the non-transitive edge graph preserves direct PAF interval-overlap relationships.",
    },
    independentCoarseLabelValidation: {
      predictedPairs: pairwisePredictedPairs.size,
      correctSameChromosomeCrossHaplotypePairs:
        pairwisePredictedPairs.size - pairwiseCoarseLabelErrors.length,
      precision: divide(
        pairwisePredictedPairs.size - pairwiseCoarseLabelErrors.length,
        pairwisePredictedPairs.size,
      ),
      errorExamples: pairwiseCoarseLabelErrors.slice(0, 30)
        .map((key) => describePair(key, truthById)),
      locusLevelRecallAvailable: false,
      limitation: "The bundle has no independent contig-to-reference locus truth manifest.",
    },
  },
  independentCoarseLabelValidation: {
    predictedPairs: predictedPairs.size,
    correctSameChromosomeCrossHaplotypePairs: predictedPairs.size - coarseLabelErrors.length,
    precision: divide(predictedPairs.size - coarseLabelErrors.length, predictedPairs.size),
    errorExamples: coarseLabelErrors.slice(0, 30).map((key) => describePair(key, truthById)),
    locusLevelRecallAvailable: false,
    limitation: "The bundle has no independent contig-to-reference locus truth manifest.",
  },
  pafInternalLocusConsistency: {
    ...pafConsistencyMetrics,
    perContig: pafContigConsistencyMetrics,
    independentTruth: false,
    interpretation: "Measures loss introduced by converting the PAF overlap graph into disjoint groups.",
  },
  errorBreakdown: {
    falsePositive: falsePositiveBreakdown,
    falseNegative: falseNegativeBreakdown,
  },
  falsePositiveExamples: falsePositivePairs.slice(0, 30),
  falseNegativeExamples: falseNegativePairs.slice(0, 30),
  impureGroupExamples: groupSummaries.filter((group) => group.pairPurity < 1).slice(0, 30),
};

console.log(JSON.stringify(output, null, 2));

function parseTruthContigs(text: string): TruthContig[] {
  const contigs: TruthContig[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const columns = line.split("\t");
    if (columns.length !== 9 || columns[4] === "N" || columns[4] === "U") continue;
    const parsedComponent = parseTruthComponent(columns[5]);
    if (!parsedComponent) {
      throw new Error(`Cannot derive simulated chromosome/haplotype from contig ${columns[5]}`);
    }
    contigs.push({
      id: columns[5],
      objectId: columns[0],
      chromosome: parsedComponent.chromosome,
      haplotype: parsedComponent.haplotype,
    });
  }
  return contigs;
}

function parseTruthComponent(componentId: string) {
  const match = /^(Chr0?\d+)([A-Za-z])\.ctg\d+$/.exec(componentId);
  if (!match) return null;
  return {
    chromosome: normalizeChromosome(match[1]),
    haplotype: match[2].toUpperCase(),
  };
}

function normalizeChromosome(value: string) {
  return value.replace(/^(Chr)0+(?=\d)/i, "$1");
}

function predictedAllelePairs(groups: typeof pruning.groups) {
  const pairs = new Set<string>();
  for (const group of groups) {
    for (const key of allPairs(group.members.map((member) => member.sourceId))) {
      pairs.add(key);
    }
  }
  return pairs;
}

function pairwiseAllelePairs(edges: typeof pruning.alleleEdges) {
  return new Set(edges.map((edge) => pairKey(edge.left.sourceId, edge.right.sourceId)));
}

function buildPafSupportedPairs(
  anchors: typeof pruning.anchors,
  overlapThreshold: number,
) {
  const pairs = new Set<string>();
  const byTarget = new Map<string, typeof pruning.anchors>();
  for (const anchor of anchors) {
    const values = byTarget.get(anchor.targetName) ?? [];
    values.push(anchor);
    byTarget.set(anchor.targetName, values);
  }
  for (const values of byTarget.values()) {
    for (let left = 0; left < values.length; left += 1) {
      for (let right = left + 1; right < values.length; right += 1) {
        if (anchorTargetOverlap(values[left], values[right]) >= overlapThreshold) {
          pairs.add(pairKey(values[left].sourceId, values[right].sourceId));
        }
      }
    }
  }
  return pairs;
}

function anchorTargetOverlap(
  left: (typeof pruning.anchors)[number],
  right: (typeof pruning.anchors)[number],
) {
  const denominator = Math.min(
    intervalSpan(left.targetIntervals),
    intervalSpan(right.targetIntervals),
  );
  return denominator > 0
    ? intervalIntersectionSpan(left.targetIntervals, right.targetIntervals) / denominator
    : 0;
}

function intervalSpan(intervals: ReadonlyArray<readonly [number, number]>) {
  return intervals.reduce((sum, [start, end]) => sum + Math.max(0, end - start), 0);
}

function intervalIntersectionSpan(
  left: ReadonlyArray<readonly [number, number]>,
  right: ReadonlyArray<readonly [number, number]>,
) {
  let leftIndex = 0;
  let rightIndex = 0;
  let total = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    total += Math.max(
      0,
      Math.min(left[leftIndex][1], right[rightIndex][1])
        - Math.max(left[leftIndex][0], right[rightIndex][0]),
    );
    if (left[leftIndex][1] < right[rightIndex][1]) leftIndex += 1;
    else rightIndex += 1;
  }
  return total;
}

function allPairs(ids: ReadonlyArray<string>) {
  const pairs: string[] = [];
  for (let left = 0; left < ids.length; left += 1) {
    for (let right = left + 1; right < ids.length; right += 1) {
      pairs.push(pairKey(ids[left], ids[right]));
    }
  }
  return pairs;
}

function pairKey(left: string, right: string) {
  return left.localeCompare(right) <= 0 ? `${left}\u0000${right}` : `${right}\u0000${left}`;
}

function splitPairKey(key: string) {
  const [left, right] = key.split("\u0000");
  return [left, right] as const;
}

function comparePairSets(
  expected: ReadonlySet<string>,
  predicted: ReadonlySet<string>,
  overlapThreshold: number,
): PairMetrics {
  let truePositive = 0;
  for (const key of predicted) {
    if (expected.has(key)) truePositive += 1;
  }
  const falsePositive = predicted.size - truePositive;
  const falseNegative = expected.size - truePositive;
  const precision = divide(truePositive, truePositive + falsePositive);
  const recall = divide(truePositive, truePositive + falseNegative);
  return {
    overlapThreshold,
    expectedPairs: expected.size,
    predictedPairs: predicted.size,
    truePositive,
    falsePositive,
    falseNegative,
    precision,
    recall,
    f1: divide(2 * precision * recall, precision + recall),
  };
}

function contigMetrics(truthPairs: ReadonlySet<string>, predictedPairs: ReadonlySet<string>) {
  const truthNeighbors = neighborMap(truthPairs);
  const predictedNeighbors = neighborMap(predictedPairs);
  const eligibleIds = [...truthNeighbors.keys()];
  const predictedIds = [...predictedNeighbors.keys()];
  const correctPartnerCounts = new Map<string, number>();
  for (const id of predictedIds) {
    const truth = truthNeighbors.get(id) ?? new Set<string>();
    const predicted = predictedNeighbors.get(id) ?? new Set<string>();
    correctPartnerCounts.set(id, [...predicted].filter((partner) => truth.has(partner)).length);
  }
  const correctIds = predictedIds.filter((id) => (correctPartnerCounts.get(id) ?? 0) > 0);
  const partnerRecalls = eligibleIds.map((id) => {
    const truth = truthNeighbors.get(id) ?? new Set<string>();
    const predicted = predictedNeighbors.get(id) ?? new Set<string>();
    return divide([...predicted].filter((partner) => truth.has(partner)).length, truth.size);
  });
  const precision = divide(correctIds.length, predictedIds.length);
  const recall = divide(correctIds.length, eligibleIds.length);
  return {
    expectedEligibleContigs: eligibleIds.length,
    predictedContigs: predictedIds.length,
    contigsWithAtLeastOneCorrectPartner: correctIds.length,
    detectionPrecision: precision,
    detectionRecall: recall,
    detectionF1: divide(2 * precision * recall, precision + recall),
    meanPerContigPartnerRecall: mean(partnerRecalls),
    medianPerContigPartnerRecall: quantile(partnerRecalls, 0.5),
  };
}

function neighborMap(pairs: ReadonlySet<string>) {
  const neighbors = new Map<string, Set<string>>();
  for (const key of pairs) {
    const [left, right] = splitPairKey(key);
    const leftValues = neighbors.get(left) ?? new Set<string>();
    const rightValues = neighbors.get(right) ?? new Set<string>();
    leftValues.add(right);
    rightValues.add(left);
    neighbors.set(left, leftValues);
    neighbors.set(right, rightValues);
  }
  return neighbors;
}

function describePair(key: string, truthById: ReadonlyMap<string, TruthContig>) {
  const [leftId, rightId] = splitPairKey(key);
  const left = truthById.get(leftId);
  const right = truthById.get(rightId);
  return {
    left: leftId,
    right: rightId,
    leftObject: left?.objectId ?? null,
    rightObject: right?.objectId ?? null,
    leftLabel: left ? `${left.chromosome}${left.haplotype}` : null,
    rightLabel: right ? `${right.chromosome}${right.haplotype}` : null,
  };
}

function comparePairDescriptions(
  left: ReturnType<typeof describePair>,
  right: ReturnType<typeof describePair>,
) {
  return left.left.localeCompare(right.left) || left.right.localeCompare(right.right);
}

function countBy(values: ReadonlyArray<number>) {
  const counts: Record<string, number> = {};
  for (const value of values) counts[String(value)] = (counts[String(value)] ?? 0) + 1;
  return counts;
}

function countByLabels(values: ReadonlyArray<string>) {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function divide(numerator: number, denominator: number) {
  return denominator > 0 ? numerator / denominator : 0;
}

function mean(values: ReadonlyArray<number>) {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function quantile(values: ReadonlyArray<number>, probability: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}
