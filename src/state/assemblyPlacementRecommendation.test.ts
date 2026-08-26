import { describe, expect, it } from "vitest";
import type { GfaEndpointHiCLoadResult, GfaEndpointHiCQuadrant } from "./gfaEndpointHiC";
import type { GfaGraphEdge } from "./gfa";
import type { GfaHiCLink } from "./gfaHiCLinks";
import type { HiCAlleleConcordancePair } from "./hicAlleleConcordance";
import {
  applyPlacementRecommendation,
  buildPlacementRecommendationPreviewLayout,
  buildPlacementRecommendationPlan,
  enumeratePlacementBoundaries,
  placementEndpointRequestKey,
  rankPlacementRecommendations,
} from "./assemblyPlacementRecommendation";
import type { ContactMapLayoutBlock } from "./importers";
import {
  syntenyAllelePairKey,
  type ReferenceSyntenyAlleleEdge,
  type ReferenceSyntenyAlleleGroup,
  type ReferenceSyntenyAnchor,
  type SyntenyAlleleSignalMask,
} from "./syntenyAllelePruning";

function block(
  id: string,
  objectId: string,
  visualStart: number,
  orientation: ContactMapLayoutBlock["orientation"] = "+",
): ContactMapLayoutBlock {
  return {
    id,
    objectId,
    sourceId: id,
    sourceStart: 0,
    sourceEnd: 1_000_000,
    visualStart,
    visualEnd: visualStart + 1_000_000,
    orientation,
  };
}

const blocks = [
  block("a", "Chr01", 0),
  block("b", "Chr01", 1_000_000),
  block("c", "Chr01", 2_000_000),
  block("d", "Chr02", 3_000_000),
];
const selection = { kind: "contigs" as const, ids: ["b"], exact: true as const };

function coarse(source: string, target: string, score: number): GfaHiCLink {
  return {
    id: `hic:${source}:${target}`,
    source,
    target,
    rawCount: score,
    normalizedCountPerMb2: score,
    lineWidth: 1,
  };
}

function endpointResult(
  targetBlockId: string,
  values: [number, number, number, number],
  sourceBlockId = "b",
): GfaEndpointHiCLoadResult {
  const endpoints: Array<["left" | "right", "left" | "right"]> = [
    ["left", "left"],
    ["left", "right"],
    ["right", "left"],
    ["right", "right"],
  ];
  const quadrants: GfaEndpointHiCQuadrant[] = endpoints.map(
    ([sourceEndpoint, targetEndpoint], index) => ({
      sourceEndpoint,
      targetEndpoint,
      rawCount: values[index],
      normalizedCountPerMb2: values[index],
    }),
  );
  const bestQuadrant = [...quadrants].sort(
    (left, right) => right.normalizedCountPerMb2 - left.normalizedCountPerMb2,
  )[0];
  return {
    status: "ready",
    evidence: {
      sourceBlockId,
      targetBlockId,
      resolution: 10_000,
      normalization: "raw",
      sourceWindowBp: 250_000,
      targetWindowBp: 250_000,
      quadrants,
      bestQuadrant,
      contrastToNext: 2,
      observedCellCount: 4,
      complete: true,
      missingTileCount: 0,
    },
  };
}

function directAlleleMask(first: string, second: string) {
  const mask: SyntenyAlleleSignalMask = {
    sourceBlockId: first,
    targetBlockId: second,
    factor: 0,
    reason: "direct-allele",
    sourceGroupId: "synteny:Ref01:1-2:1",
    targetGroupId: "synteny:Ref01:1-2:1",
  };
  return new Map([[syntenyAllelePairKey(first, second), mask]]);
}

function hicAllelePair(
  leftBlockId: string,
  rightBlockId: string,
): HiCAlleleConcordancePair {
  return {
    id: `hic-concordance:${leftBlockId}:${rightBlockId}`,
    leftBlockId,
    rightBlockId,
    leftObjectId: blocks.find((value) => value.id === leftBlockId)?.objectId ?? "left",
    rightObjectId: blocks.find((value) => value.id === rightBlockId)?.objectId ?? "right",
    concordanceRatio: 0.65,
    parallelRatio: 0.65,
    antiparallelRatio: 0.1,
    orientation: "parallel",
    support: 80,
    supportUnit: "raw-contact-weight",
    observedCellCount: 20,
    resolvedWindowCount: 50,
    coveredShorterWindowCount: 18,
    lineRatio: 0.7,
    lineExpectedRatio: 0.1,
    lineEnrichment: 7,
    lineZScore: 8,
    lineWeight: 56,
    lineOrientation: "parallel",
    lineCoveredLeftWindowCount: 30,
    lineCoveredRightWindowCount: 30,
    lineCoveredLeftWindowFraction: 0.6,
    lineCoveredRightWindowFraction: 0.6,
    lineReciprocalCoverage: 0.6,
    lineEffectiveWindowCount: 24,
    lineEffectiveWindowFraction: 0.48,
    lineReciprocalSpanFraction: 0.6,
    evidenceModel: "concordance",
    confidence: "high",
  };
}

function syntenyAnchor(
  nodeId: string,
  blockId: string,
  sourceId: string,
  targetStart = 10_000_000,
  targetStrand: "+" | "-" = "+",
): ReferenceSyntenyAnchor {
  return {
    nodeId,
    blockId,
    occurrenceBlockIds: [blockId],
    sourceId,
    targetName: "Ref01",
    targetStart,
    targetEnd: targetStart + 1_000_000,
    targetIntervals: [[targetStart, targetStart + 1_000_000]],
    targetStrand,
    strandDominance: 1,
    queryCoverage: 0.95,
    identity: 0.99,
    meanMapq: 60,
    targetDominance: 1,
  };
}

function alleleEdge(
  left: ReferenceSyntenyAnchor,
  right: ReferenceSyntenyAnchor,
): ReferenceSyntenyAlleleEdge {
  return {
    id: `edge:${left.nodeId}:${right.nodeId}`,
    targetName: left.targetName,
    left,
    right,
    overlapBp: 1_000_000,
    targetOverlap: 1,
    reciprocalTargetOverlap: 1,
    leftTargetCoverage: 1,
    rightTargetCoverage: 1,
    relationship: "allele",
    minQueryCoverage: 0.95,
    minIdentity: 0.99,
    minMeanMapq: 60,
    minTargetDominance: 1,
    confidence: "high",
    confidenceScore: 0.94,
  };
}

function alleleGroup(firstBlockId: string, secondBlockId: string): ReferenceSyntenyAlleleGroup {
  return {
    id: "synteny:Ref01:10000000-11000000:1",
    targetName: "Ref01",
    targetStart: 10_000_000,
    targetEnd: 11_000_000,
    members: [
      syntenyAnchor("selected-node", firstBlockId, firstBlockId),
      syntenyAnchor("occupied-node", secondBlockId, secondBlockId),
    ],
  };
}

describe("assembly placement recommendation", () => {
  it("enumerates every legal boundary after removing the selected singleton", () => {
    const candidates = enumeratePlacementBoundaries(blocks, selection);

    expect(candidates.map((candidate) => [
      candidate.targetObjectId,
      candidate.targetBlockId,
      candidate.leftBlockId,
      candidate.rightBlockId,
      candidate.isCurrentBoundary,
    ])).toEqual([
      ["Chr01", "a", null, "a", false],
      ["Chr01", "c", "a", "c", true],
      ["Chr01", null, "c", null, false],
      ["Chr02", "d", null, "d", false],
      ["Chr02", null, "d", null, false],
    ]);
  });

  it("does not use singleton self objects as recommendation targets", () => {
    const scopedBlocks = [
      block("left", "Chr01", 0),
      block("selected", "Chr01", 1_000_000),
      block("right", "Chr01", 2_000_000),
      block("unanchored", "unanchored", 3_000_000),
      block("renamed-source", "ScaffoldA", 4_000_000),
    ];
    const selectedAnchor = syntenyAnchor(
      "selected-node",
      "selected",
      "selected",
      10_000_000,
    );
    const unanchoredAnchor = syntenyAnchor(
      "unanchored-node",
      "unanchored",
      "unanchored",
      11_000_000,
    );
    const plan = buildPlacementRecommendationPlan({
      blocks: scopedBlocks,
      selection: { kind: "contigs", ids: ["selected"], exact: true },
      coarseLinks: [
        coarse("selected", "unanchored", 1_000),
        coarse("selected", "renamed-source", 10),
      ],
      syntenyAnchors: [selectedAnchor, unanchoredAnchor],
    });
    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;

    expect(plan.excludedUnanchoredTargetObjectCount).toBe(1);
    expect(enumeratePlacementBoundaries(
      scopedBlocks,
      { kind: "contigs", ids: ["selected"], exact: true },
    ).some((boundary) => boundary.targetObjectId === "unanchored")).toBe(true);
    expect(plan.candidates.some(
      (candidate) => candidate.targetObjectId === "unanchored",
    )).toBe(false);
    expect(plan.requests.some(
      (request) => request.targetBlockId === "unanchored",
    )).toBe(false);
    expect(plan.syntenyAdjacencies.some(
      (adjacency) => adjacency.partnerBlockId === "unanchored",
    )).toBe(false);
    expect(plan.candidates.some(
      (candidate) => candidate.targetObjectId === "ScaffoldA",
    )).toBe(true);
  });

  it("ranks a two-sided endpoint- and GFA-supported placement first", () => {
    const gfaEdges: GfaGraphEdge[] = [
      {
        id: "gfa-a-b",
        source: "a",
        target: "b",
        kind: "gfa-link",
        sourceSide: "end",
        targetSide: "start",
      },
      {
        id: "gfa-b-c",
        source: "b",
        target: "c",
        kind: "gfa-link",
        sourceSide: "end",
        targetSide: "start",
      },
    ];
    const plan = buildPlacementRecommendationPlan({
      blocks,
      selection,
      coarseLinks: [coarse("b", "a", 80), coarse("b", "c", 70), coarse("b", "d", 20)],
      gfaEdges,
    });
    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;
    const ranked = rankPlacementRecommendations(plan, new Map([
      // b:start ↔ a:end is displayed left-right.
      [placementEndpointRequestKey({ sourceBlockId: "b", targetBlockId: "a" }), endpointResult("a", [2, 100, 3, 4])],
      // b:end ↔ c:start is displayed right-left.
      [placementEndpointRequestKey({ sourceBlockId: "b", targetBlockId: "c" }), endpointResult("c", [3, 2, 90, 1])],
      [placementEndpointRequestKey({ sourceBlockId: "b", targetBlockId: "d" }), endpointResult("d", [8, 7, 6, 5])],
    ]), blocks);

    expect(ranked[0]).toMatchObject({
      targetObjectId: "Chr01",
      targetBlockId: "c",
      orientation: "+",
      isCurrent: true,
      confidence: "high",
      supportedJunctionCount: 2,
      bestEndpointMatchCount: 2,
      gfaMatchCount: 2,
    });
    expect(ranked).toHaveLength(3);
  });

  it("demotes exact-source conflicts without starving compatible chromosome groups", () => {
    const copyBlocks = [
      block("g1-left", "Chr03g1", 0),
      {
        ...block("collapsed-g1", "Chr03g1", 1_000_000),
        sourceId: "collapsed-source",
      },
      {
        ...block("collapsed-g2", "Chr03g2", 2_000_000),
        sourceId: "collapsed-source",
      },
      {
        ...block("collapsed-g3", "Chr03g3", 3_000_000),
        sourceId: "collapsed-source",
      },
      {
        ...block("partial-g4", "Chr03g4", 4_000_000),
        sourceId: "collapsed-source",
        sourceStart: 1_000_000,
        sourceEnd: 2_000_000,
      },
      block("g4-anchor", "Chr03g4", 5_000_000),
    ];
    const plan = buildPlacementRecommendationPlan({
      blocks: copyBlocks,
      selection: { kind: "contigs", ids: ["collapsed-g2"], exact: true },
      coarseLinks: [
        coarse("collapsed-g2", "g1-left", 1_000),
        coarse("collapsed-g2", "collapsed-g3", 500),
        coarse("collapsed-g2", "partial-g4", 100),
        coarse("collapsed-g2", "g4-anchor", 10),
      ],
      overviewPartnerLimit: 2,
    });
    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;

    expect(plan.occupancyConflicts).toEqual([
      {
        targetObjectId: "Chr03g1",
        kind: "exact-source",
        locusId: "collapsed-source\u00010\u00011000000",
        selectedBlockIds: ["collapsed-g2"],
        occupiedBlockIds: ["collapsed-g1"],
      },
      {
        targetObjectId: "Chr03g3",
        kind: "exact-source",
        locusId: "collapsed-source\u00010\u00011000000",
        selectedBlockIds: ["collapsed-g2"],
        occupiedBlockIds: ["collapsed-g3"],
      },
    ]);
    expect(plan.coarseLinks.map((link) => link.target)).toContain("g1-left");
    expect(plan.coarseLinks.map((link) => link.target)).toContain("collapsed-g3");
    expect(plan.candidates.some((candidate) => candidate.targetObjectId === "Chr03g1"))
      .toBe(true);
    expect(plan.candidates.some((candidate) => candidate.targetObjectId === "Chr03g3"))
      .toBe(true);
    expect(plan.requests.some((request) => request.targetBlockId === "g1-left")).toBe(true);
    expect(plan.candidates.some((candidate) => candidate.targetObjectId === "Chr03g4"))
      .toBe(true);

    const ranked = rankPlacementRecommendations(plan, new Map([
      [placementEndpointRequestKey({
        sourceBlockId: "collapsed-g2",
        targetBlockId: "g1-left",
      }), endpointResult("g1-left", [900, 1_000, 800, 700], "collapsed-g2")],
      [placementEndpointRequestKey({
        sourceBlockId: "collapsed-g2",
        targetBlockId: "collapsed-g3",
      }), endpointResult("collapsed-g3", [600, 700, 500, 400], "collapsed-g2")],
      [placementEndpointRequestKey({
        sourceBlockId: "collapsed-g2",
        targetBlockId: "partial-g4",
      }), endpointResult("partial-g4", [5, 10, 4, 3], "collapsed-g2")],
      [placementEndpointRequestKey({
        sourceBlockId: "collapsed-g2",
        targetBlockId: "g4-anchor",
      }), endpointResult("g4-anchor", [4, 3, 8, 2], "collapsed-g2")],
    ]), copyBlocks, 20);
    const firstConflictIndex = ranked.findIndex(
      (candidate) => candidate.occupancyConflicts.length > 0,
    );
    expect(ranked[0]?.targetObjectId).toBe("Chr03g4");
    expect(firstConflictIndex).toBeGreaterThan(0);
    expect(ranked.slice(0, firstConflictIndex).every(
      (candidate) => candidate.occupancyConflicts.length === 0,
    )).toBe(true);
  });

  it("demotes chromosome groups occupied by a high-confidence PAF allele locus", () => {
    const plan = buildPlacementRecommendationPlan({
      blocks,
      selection,
      coarseLinks: [coarse("b", "d", 1_000), coarse("b", "a", 100)],
      syntenyAlleleGroups: [alleleGroup("b", "d")],
    });
    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;

    expect(plan.occupancyConflicts).toEqual([{
      targetObjectId: "Chr02",
      kind: "paf-allele-locus",
      locusId: "synteny-occupancy:Ref01:10000000-11000000",
      selectedBlockIds: ["b"],
      occupiedBlockIds: ["d"],
      overlapBp: 1_000_000,
      selectedLocusCoverage: 1,
      occupiedLocusCoverage: 1,
    }]);
    expect(plan.coarseLinks.map((link) => [link.source, link.target])).toEqual([
      ["b", "d"],
      ["b", "a"],
    ]);
    expect(plan.candidates.some((candidate) => candidate.targetObjectId === "Chr02")).toBe(true);
    expect(plan.requests.some((request) => request.targetBlockId === "d")).toBe(true);

    const ranked = rankPlacementRecommendations(plan, new Map([
      [placementEndpointRequestKey({ sourceBlockId: "b", targetBlockId: "a" }), endpointResult("a", [1, 5, 2, 3])],
      [placementEndpointRequestKey({ sourceBlockId: "b", targetBlockId: "d" }), endpointResult("d", [800, 1_000, 700, 600])],
    ]), blocks, 10);
    const firstConflictIndex = ranked.findIndex(
      (candidate) => candidate.occupancyConflicts.length > 0,
    );
    expect(ranked[0]?.targetObjectId).not.toBe("Chr02");
    expect(firstConflictIndex).toBeGreaterThan(0);
    expect(ranked[firstConflictIndex]?.targetObjectId).toBe("Chr02");
  });

  it("keeps a Hi-C-concordant conflict reviewable after pruning its allelic link", () => {
    const pair = hicAllelePair("b", "d");
    const mask: SyntenyAlleleSignalMask = {
      sourceBlockId: "b",
      targetBlockId: "d",
      factor: 0,
      reason: "hic-concordance",
      sourceGroupId: pair.id,
      targetGroupId: pair.id,
    };
    const plan = buildPlacementRecommendationPlan({
      blocks,
      selection,
      coarseLinks: [coarse("b", "d", 1_000), coarse("b", "a", 100)],
      syntenyMaskByPair: new Map([[syntenyAllelePairKey("b", "d"), mask]]),
      hicAllelePairs: [pair],
    });
    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;

    expect(plan.occupancyConflicts).toEqual([{
      targetObjectId: "Chr02",
      kind: "hic-concordance",
      locusId: pair.id,
      selectedBlockIds: ["b"],
      occupiedBlockIds: ["d"],
      concordanceRatio: 0.65,
      concordanceOrientation: "parallel",
      concordanceSupport: 80,
      concordanceSupportUnit: "raw-contact-weight",
    }]);
    expect(plan.coarseLinks.map((link) => [link.source, link.target])).toEqual([
      ["b", "a"],
    ]);
    expect(plan.candidates.some((candidate) => candidate.targetObjectId === "Chr02")).toBe(true);
    expect(plan.requests.some((request) => request.targetBlockId === "d")).toBe(true);

    const ranked = rankPlacementRecommendations(plan, new Map([
      [placementEndpointRequestKey({ sourceBlockId: "b", targetBlockId: "a" }), endpointResult("a", [1, 5, 2, 3])],
      [placementEndpointRequestKey({ sourceBlockId: "b", targetBlockId: "d" }), endpointResult("d", [800, 1_000, 700, 600])],
    ]), blocks, 20);
    const conflictCandidate = ranked.find((candidate) => candidate.targetObjectId === "Chr02");
    expect(ranked[0]?.targetObjectId).not.toBe("Chr02");
    expect(conflictCandidate).toBeDefined();
    expect(conflictCandidate?.supportedJunctionCount).toBe(0);
    expect(conflictCandidate?.syntenyPrunedJunctionCount).toBe(1);
  });

  it("demotes a direct pairwise PAF edge that is absent from compact allele groups", () => {
    const selectedAnchor = syntenyAnchor("selected-node", "b", "b");
    const occupiedAnchor = syntenyAnchor("occupied-node", "d", "d");
    const edge = alleleEdge(selectedAnchor, occupiedAnchor);
    const plan = buildPlacementRecommendationPlan({
      blocks,
      selection,
      coarseLinks: [coarse("b", "d", 1_000), coarse("b", "a", 100)],
      syntenyAlleleEdges: [edge],
    });
    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;

    expect(plan.occupancyConflicts).toEqual([{
      targetObjectId: "Chr02",
      kind: "paf-allele-locus",
      locusId: "synteny-occupancy:Ref01:10000000-11000000",
      selectedBlockIds: ["b"],
      occupiedBlockIds: ["d"],
      overlapBp: 1_000_000,
      selectedLocusCoverage: 1,
      occupiedLocusCoverage: 1,
    }]);
  });

  it("ranks an asymmetric terminal overlap as a one-sided boundary anchor", () => {
    const boundaryBlocks = [
      block("selected", "Chr03g2", 0),
      block("g4-anchor", "Chr03g4", 1_000_000),
      block("noise", "Chr05g3", 2_000_000),
    ];
    const selectedAnchor = {
      ...syntenyAnchor("selected-node", "selected", "selected", 9_393_740),
      targetEnd: 13_586_800,
      targetIntervals: [[9_393_740, 13_586_800]] as Array<[number, number]>,
    };
    const boundaryAnchor = {
      ...syntenyAnchor("boundary-node", "g4-anchor", "g4-anchor", 13_529_769),
      targetEnd: 13_613_672,
      targetIntervals: [[13_529_769, 13_613_672]] as Array<[number, number]>,
    };
    const boundaryEdge: ReferenceSyntenyAlleleEdge = {
      ...alleleEdge(selectedAnchor, boundaryAnchor),
      overlapBp: 57_031,
      targetOverlap: 0.6797253971848444,
      reciprocalTargetOverlap: 0.013602480762270392,
      leftTargetCoverage: 0.013602480762270392,
      rightTargetCoverage: 0.6797253971848444,
      relationship: "boundary-overlap",
      confidenceScore: 0.62,
    };
    const plan = buildPlacementRecommendationPlan({
      blocks: boundaryBlocks,
      selection: { kind: "contigs", ids: ["selected"], exact: true },
      coarseLinks: [
        coarse("selected", "g4-anchor", 10),
        coarse("selected", "noise", 1_000),
      ],
      syntenyAnchors: [selectedAnchor, boundaryAnchor],
      syntenyAlleleEdges: [boundaryEdge],
    });
    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;

    expect(plan.occupancyConflicts.some(
      (conflict) => conflict.targetObjectId === "Chr03g4",
    )).toBe(false);
    expect(plan.syntenyAdjacencies).toContainEqual({
      partnerBlockId: "g4-anchor",
      partnerNodeId: "boundary-node",
      targetName: "Ref01",
      direction: "downstream",
      targetGap: 0,
      kind: "boundary-anchor",
    });

    const ranked = rankPlacementRecommendations(plan, new Map([
      [placementEndpointRequestKey({
        sourceBlockId: "selected",
        targetBlockId: "g4-anchor",
      }), endpointResult("g4-anchor", [1, 2, 100, 3], "selected")],
      [placementEndpointRequestKey({
        sourceBlockId: "selected",
        targetBlockId: "noise",
      }), endpointResult("noise", [1, 2, 1_000, 3], "selected")],
    ]), boundaryBlocks, 10, "paf-adjacency");

    expect(ranked[0]).toMatchObject({
      targetObjectId: "Chr03g4",
      targetBlockId: "g4-anchor",
      orientation: "+",
      availableJunctionCount: 1,
      supportedJunctionCount: 1,
      pafAdjacencyMatchCount: 1,
      occupancyConflicts: [],
    });
  });

  it("shortlists nearest PAF neighbors while excluding the selected allele locus", () => {
    const adjacencyBlocks = [
      block("upstream", "Chr01", 0),
      block("selected", "Chr01", 1_000_000),
      block("allele", "Chr01", 2_000_000),
      block("downstream", "Chr01", 3_000_000),
    ];
    const upstream = syntenyAnchor("upstream-node", "upstream", "upstream", 9_000_000);
    const selectedAnchor = syntenyAnchor("selected-node", "selected", "selected");
    const allele = syntenyAnchor("allele-node", "allele", "allele");
    const downstream = syntenyAnchor(
      "downstream-node",
      "downstream",
      "downstream",
      11_000_000,
    );
    const plan = buildPlacementRecommendationPlan({
      blocks: adjacencyBlocks,
      selection: { kind: "contigs", ids: ["selected"], exact: true },
      coarseLinks: [],
      syntenyAnchors: [upstream, selectedAnchor, allele, downstream],
      syntenyAlleleEdges: [alleleEdge(selectedAnchor, allele)],
    });
    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;

    expect(plan.syntenyAdjacencies.map((adjacency) => [
      adjacency.partnerBlockId,
      adjacency.direction,
      adjacency.targetGap,
    ])).toEqual([
      ["downstream", "downstream", 0],
      ["upstream", "upstream", 0],
    ]);
    expect(plan.syntenyAdjacencies.some(
      (adjacency) => adjacency.partnerBlockId === "allele",
    )).toBe(false);
    expect(plan.candidates.some((candidate) => candidate.targetBlockId === "downstream"))
      .toBe(true);
  });

  it("uses two-sided PAF adjacency to overcome a stronger unrelated contact boundary", () => {
    const rankingBlocks = [
      block("a", "Chr01", 0),
      block("b", "Chr01", 1_000_000),
      block("c", "Chr01", 2_000_000),
      block("d", "Chr02", 3_000_000),
      block("e", "Chr02", 4_000_000),
    ];
    const anchors = [
      syntenyAnchor("a-node", "a", "a", 9_000_000),
      syntenyAnchor("b-node", "b", "b"),
      syntenyAnchor("c-node", "c", "c", 11_000_000),
    ];
    const plan = buildPlacementRecommendationPlan({
      blocks: rankingBlocks,
      selection: { kind: "contigs", ids: ["b"], exact: true },
      coarseLinks: [coarse("b", "d", 1_000), coarse("b", "e", 900)],
      syntenyAnchors: anchors,
    });
    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;
    const results = new Map([
      [placementEndpointRequestKey({ sourceBlockId: "b", targetBlockId: "a" }), endpointResult("a", [8, 10, 9, 7])],
      [placementEndpointRequestKey({ sourceBlockId: "b", targetBlockId: "c" }), endpointResult("c", [8, 9, 10, 7])],
      [placementEndpointRequestKey({ sourceBlockId: "b", targetBlockId: "d" }), endpointResult("d", [10, 1_000, 20, 30])],
      [placementEndpointRequestKey({ sourceBlockId: "b", targetBlockId: "e" }), endpointResult("e", [10, 20, 900, 30])],
    ]);
    const legacy = rankPlacementRecommendations(plan, results, rankingBlocks, 10, "legacy");
    const assisted = rankPlacementRecommendations(
      plan,
      results,
      rankingBlocks,
      10,
      "paf-adjacency",
    );

    expect(legacy[0]).toMatchObject({ targetObjectId: "Chr02", targetBlockId: "e" });
    expect(assisted[0]).toMatchObject({
      targetObjectId: "Chr01",
      targetBlockId: "c",
      orientation: "+",
      pafAdjacencyMatchCount: 2,
    });
  });

  it("ranks endpoint enrichment ahead of absolute contact in assisted mode", () => {
    const rankingBlocks = [
      block("a", "Chr01", 0),
      block("b", "Chr01", 1_000_000),
      block("c", "Chr01", 2_000_000),
      block("d", "Chr02", 3_000_000),
      block("e", "Chr02", 4_000_000),
    ];
    const plan = buildPlacementRecommendationPlan({
      blocks: rankingBlocks,
      selection: { kind: "contigs", ids: ["b"], exact: true },
      coarseLinks: [
        coarse("b", "a", 100),
        coarse("b", "c", 100),
        coarse("b", "d", 1_000),
        coarse("b", "e", 1_000),
      ],
    });
    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;
    const results = new Map([
      [placementEndpointRequestKey({ sourceBlockId: "b", targetBlockId: "a" }), endpointResult("a", [1, 100, 1, 1])],
      [placementEndpointRequestKey({ sourceBlockId: "b", targetBlockId: "c" }), endpointResult("c", [1, 1, 100, 1])],
      [placementEndpointRequestKey({ sourceBlockId: "b", targetBlockId: "d" }), endpointResult("d", [900, 1_000, 900, 900])],
      [placementEndpointRequestKey({ sourceBlockId: "b", targetBlockId: "e" }), endpointResult("e", [900, 900, 1_000, 900])],
    ]);
    const legacy = rankPlacementRecommendations(plan, results, rankingBlocks, 10, "legacy");
    const assisted = rankPlacementRecommendations(
      plan,
      results,
      rankingBlocks,
      10,
      "synteny-assisted",
    );

    expect(legacy[0]).toMatchObject({ targetObjectId: "Chr02", targetBlockId: "e" });
    expect(assisted[0]).toMatchObject({ targetObjectId: "Chr01", targetBlockId: "c" });
    expect(assisted[0].backgroundScore).toBeGreaterThan(legacy[0].backgroundScore);
  });

  it("removes synteny-identified allele links before the coarse shortlist", () => {
    const plan = buildPlacementRecommendationPlan({
      blocks,
      selection,
      coarseLinks: [coarse("b", "d", 1_000), coarse("b", "a", 100)],
      syntenyMaskByPair: directAlleleMask("b", "d"),
    });
    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;

    expect(plan.coarseLinks.map((link) => [link.source, link.target])).toEqual([["b", "a"]]);
    expect(plan.candidates.some((candidate) => candidate.targetObjectId === "Chr02")).toBe(false);
    expect(plan.requests.some((request) => request.targetBlockId === "d")).toBe(false);
  });

  it("zeros endpoint evidence for a synteny-pruned current junction", () => {
    const plan = buildPlacementRecommendationPlan({
      blocks,
      selection,
      coarseLinks: [coarse("b", "a", 80), coarse("b", "c", 70)],
      syntenyMaskByPair: directAlleleMask("b", "c"),
    });
    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;
    const ranked = rankPlacementRecommendations(plan, new Map([
      [placementEndpointRequestKey({ sourceBlockId: "b", targetBlockId: "a" }), endpointResult("a", [2, 100, 3, 4])],
      [placementEndpointRequestKey({ sourceBlockId: "b", targetBlockId: "c" }), endpointResult("c", [3, 2, 90, 1])],
    ]), blocks);
    const current = ranked.find((candidate) => candidate.isCurrent);

    expect(current?.syntenyPrunedJunctionCount).toBe(1);
    expect(current?.junctions.find((junction) => junction.partnerBlockId === "c"))
      .toMatchObject({
        normalizedCountPerMb2: 0,
        rawNormalizedCountPerMb2: 90,
        rawCount: 90,
        bestEndpointMatch: false,
        syntenyPruneReason: "direct-allele",
      });
  });

  it("applies orientation and relocation atomically from a still-valid selection", () => {
    const moved = applyPlacementRecommendation(blocks, selection, {
      selectedBlockIds: ["b"],
      targetObjectId: "Chr02",
      targetBlockId: "d",
      orientation: "-",
    });

    expect(moved.map((candidate) => [candidate.id, candidate.objectId, candidate.orientation]))
      .toEqual([
        ["a", "Chr01", "+"],
        ["c", "Chr01", "+"],
        ["b", "Chr02", "-"],
        ["d", "Chr02", "+"],
      ]);
    expect(applyPlacementRecommendation(blocks, null, {
      selectedBlockIds: ["b"],
      targetObjectId: "Chr02",
      targetBlockId: "d",
      orientation: "-",
    })).toBe(blocks);
  });

  it("refuses to move one child out of a composite assembly block", () => {
    const composite = blocks.map((candidate) => (
      candidate.id === "a" || candidate.id === "b"
        ? { ...candidate, assemblyBlockId: "Chr01_block_1" }
        : candidate
    ));
    const plan = buildPlacementRecommendationPlan({
      blocks: composite,
      selection,
      coarseLinks: [coarse("b", "c", 10)],
    });

    expect(plan).toEqual({
      status: "unavailable",
      reason: "The selection includes only part of a composite block. Select the complete block or dissolve it first.",
    });

    const completePlan = buildPlacementRecommendationPlan({
      blocks: composite,
      selection: { kind: "contigs", ids: ["a", "b"], exact: true },
      coarseLinks: [coarse("b", "c", 10)],
    });
    expect(completePlan.status).toBe("ready");
    if (completePlan.status === "ready") {
      expect(completePlan.selectedBlocks.map((candidate) => candidate.id)).toEqual(["a", "b"]);
    }
  });

  it("treats consecutive selected contigs as one two-ended placement block", () => {
    const multiBlocks = [
      block("a", "Chr01", 0),
      block("b", "Chr01", 1_000_000),
      block("c", "Chr01", 2_000_000),
      block("d", "Chr02", 3_000_000),
      block("e", "Chr02", 4_000_000),
    ];
    const multiSelection = {
      kind: "contigs" as const,
      ids: ["b", "c"],
      exact: true as const,
    };
    const gfaEdges: GfaGraphEdge[] = [
      {
        id: "gfa-d-b",
        source: "d",
        target: "b",
        kind: "gfa-link",
        sourceSide: "end",
        targetSide: "start",
      },
      {
        id: "gfa-c-e",
        source: "c",
        target: "e",
        kind: "gfa-link",
        sourceSide: "end",
        targetSide: "start",
      },
    ];
    const plan = buildPlacementRecommendationPlan({
      blocks: multiBlocks,
      selection: multiSelection,
      coarseLinks: [coarse("b", "d", 80), coarse("c", "e", 70)],
      gfaEdges,
    });
    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;

    expect(plan.selectedBlocks.map((candidate) => candidate.id)).toEqual(["b", "c"]);
    expect(enumeratePlacementBoundaries(multiBlocks, multiSelection).map((candidate) => [
      candidate.targetObjectId,
      candidate.targetBlockId,
      candidate.isCurrentBoundary,
    ])).toEqual([
      ["Chr01", "a", false],
      ["Chr01", null, true],
      ["Chr02", "d", false],
      ["Chr02", "e", false],
      ["Chr02", null, false],
    ]);

    const ranked = rankPlacementRecommendations(plan, new Map([
      [placementEndpointRequestKey({ sourceBlockId: "b", targetBlockId: "d" }), endpointResult("d", [2, 100, 3, 4], "b")],
      [placementEndpointRequestKey({ sourceBlockId: "c", targetBlockId: "e" }), endpointResult("e", [3, 2, 90, 1], "c")],
    ]), multiBlocks);
    expect(ranked[0]).toMatchObject({
      selectedBlockIds: ["b", "c"],
      targetObjectId: "Chr02",
      targetBlockId: "e",
      orientation: "+",
      confidence: "high",
      supportedJunctionCount: 2,
      bestEndpointMatchCount: 2,
      gfaMatchCount: 2,
    });
  });

  it("reverses and moves a consecutive multi-contig block atomically", () => {
    const multiBlocks = [
      block("a", "Chr01", 0),
      block("b", "Chr01", 1_000_000),
      block("c", "Chr01", 2_000_000),
      block("d", "Chr02", 3_000_000),
    ];
    const multiSelection = {
      kind: "contigs" as const,
      ids: ["b", "c"],
      exact: true as const,
    };
    const moved = applyPlacementRecommendation(multiBlocks, multiSelection, {
      selectedBlockIds: ["b", "c"],
      targetObjectId: "Chr02",
      targetBlockId: "d",
      orientation: "-",
    });

    expect(moved.map((candidate) => [candidate.id, candidate.objectId, candidate.orientation]))
      .toEqual([
        ["a", "Chr01", "+"],
        ["c", "Chr02", "-"],
        ["b", "Chr02", "-"],
        ["d", "Chr02", "+"],
      ]);

    const original = multiBlocks.map((candidate) => ({ ...candidate }));
    const preview = buildPlacementRecommendationPreviewLayout(
      multiBlocks,
      multiSelection,
      {
        selectedBlockIds: ["b", "c"],
        targetObjectId: "Chr02",
        targetBlockId: "d",
        orientation: "-",
      },
    );
    expect(preview).not.toBeNull();
    expect(preview?.blocks).toEqual(moved);
    expect(preview?.blocks).not.toBe(multiBlocks);
    expect(preview?.selectedEnd).toBeGreaterThan(preview?.selectedStart ?? 0);
    expect(preview?.centerBp).toBe(
      ((preview?.selectedStart ?? 0) + (preview?.selectedEnd ?? 0)) / 2,
    );
    expect(multiBlocks).toEqual(original);
  });

  it("does not advertise a temporary preview for the unchanged current placement", () => {
    const currentBlocks = [
      block("a", "Chr01", 0),
      block("b", "Chr01", 1_000_000),
      block("c", "Chr01", 2_000_000),
    ];
    expect(buildPlacementRecommendationPreviewLayout(
      currentBlocks,
      { kind: "contigs", ids: ["b", "c"], exact: true },
      {
        selectedBlockIds: ["b", "c"],
        targetObjectId: "Chr01",
        targetBlockId: null,
        orientation: "+",
      },
    )).toBeNull();
  });

  it("refuses cross-chromosome and non-consecutive multi-selection", () => {
    const nonConsecutive = buildPlacementRecommendationPlan({
      blocks,
      selection: { kind: "contigs", ids: ["a", "c"], exact: true },
      coarseLinks: [],
    });
    const crossChromosome = buildPlacementRecommendationPlan({
      blocks,
      selection: { kind: "contigs", ids: ["b", "d"], exact: true },
      coarseLinks: [],
    });

    expect(nonConsecutive).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("consecutive"),
    });
    expect(crossChromosome).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("one chromosome"),
    });
  });
});
