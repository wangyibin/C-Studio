import { describe, expect, it } from "vitest";
import type { GfaEndpointHiCLoadResult, GfaEndpointHiCQuadrant } from "./gfaEndpointHiC";
import type { GfaGraphEdge } from "./gfa";
import type { GfaHiCLink } from "./gfaHiCLinks";
import {
  applyPlacementRecommendation,
  buildPlacementRecommendationPlan,
  enumeratePlacementBoundaries,
  placementEndpointRequestKey,
  rankPlacementRecommendations,
} from "./assemblyPlacementRecommendation";
import type { ContactMapLayoutBlock } from "./importers";
import {
  syntenyAllelePairKey,
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
