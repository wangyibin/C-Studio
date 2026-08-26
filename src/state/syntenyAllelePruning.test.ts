import { describe, expect, it } from "vitest";
import type { GfaHiCLink } from "./gfaHiCLinks";
import type { ContactMapLayoutBlock } from "./importers";
import type { PafPreviewRecord } from "./pafPreview";
import {
  buildReferenceSyntenyAllelePruning,
  syntenyAllelePairKey,
} from "./syntenyAllelePruning";

function block(id: string, sourceId = id): ContactMapLayoutBlock {
  return {
    id,
    objectId: id,
    sourceId,
    sourceStart: 0,
    sourceEnd: 1_000_000,
    visualStart: 0,
    visualEnd: 1_000_000,
    orientation: "+",
  };
}

function paf(
  queryName: string,
  targetName: string,
  targetStart: number,
  targetEnd: number,
  overrides: Partial<PafPreviewRecord> = {},
): PafPreviewRecord {
  return {
    queryName,
    queryStart: 0,
    queryEnd: 1_000_000,
    queryLength: 1_000_000,
    strand: "+",
    targetName,
    targetStart,
    targetEnd,
    targetLength: 10_000_000,
    residueMatches: 950_000,
    alignmentBlockLen: 1_000_000,
    mapq: 60,
    ...overrides,
  };
}

function contact(source: string, target: string, score: number): GfaHiCLink {
  return {
    id: `hic:${source}:${target}`,
    source,
    target,
    rawCount: score,
    normalizedCountPerMb2: score,
    lineWidth: 1,
  };
}

describe("reference synteny allele pruning", () => {
  it("groups contigs mapping to the same reference loci and prunes non-maximum cross-allele links", () => {
    const blocks = [block("a1"), block("a2"), block("b1"), block("b2")];
    const records = [
      paf("a1", "Ref01", 1_000_000, 2_000_000),
      paf("a2", "Ref01", 1_050_000, 2_050_000),
      paf("b1", "Ref01", 4_000_000, 5_000_000),
      paf("b2", "Ref01", 4_050_000, 5_050_000),
    ];
    const result = buildReferenceSyntenyAllelePruning(records, blocks, [
      contact("a1", "b1", 100),
      contact("a1", "b2", 10),
      contact("a2", "b1", 5),
      contact("a2", "b2", 90),
    ]);

    expect(result.groups.map((group) => group.members.map((member) => member.blockId)))
      .toEqual([["a1", "a2"], ["b1", "b2"]]);
    expect(result.alleleEdges.map((edge) => [edge.left.blockId, edge.right.blockId]))
      .toEqual([["a1", "a2"], ["b1", "b2"]]);
    expect(result.maskByPair.get(syntenyAllelePairKey("a1", "a2"))?.reason)
      .toBe("direct-allele");
    expect(result.maskByPair.get(syntenyAllelePairKey("b1", "b2"))?.reason)
      .toBe("direct-allele");
    expect(result.maskByPair.get(syntenyAllelePairKey("a1", "b2"))?.reason)
      .toBe("cross-allele-nonmatch");
    expect(result.maskByPair.get(syntenyAllelePairKey("a2", "b1"))?.reason)
      .toBe("cross-allele-nonmatch");
    expect(result.maskByPair.has(syntenyAllelePairKey("a1", "b1"))).toBe(false);
    expect(result.maskByPair.has(syntenyAllelePairKey("a2", "b2"))).toBe(false);
    expect(result.matchedPairCount).toBe(2);
  });

  it("keeps every direct edge when one long anchor overlaps two non-overlapping anchors", () => {
    const blocks = [block("long"), block("short-left"), block("short-right")];
    const records = [
      paf("long", "Ref01", 1_000_000, 3_000_000),
      paf("short-left", "Ref01", 1_000_000, 2_000_000),
      paf("short-right", "Ref01", 2_000_000, 3_000_000),
    ];
    const result = buildReferenceSyntenyAllelePruning(records, blocks, []);

    expect(result.alleleEdges.map((edge) => [edge.left.blockId, edge.right.blockId]))
      .toEqual([
        ["long", "short-left"],
        ["long", "short-right"],
      ]);
    expect(result.groups.map((group) => group.members.map((member) => member.blockId)))
      .toEqual([["short-left", "long"]]);
    expect(result.pairwiseAlleleOccurrencePairCount).toBe(2);
    expect(result.directAllelePairCount).toBe(2);
    expect(result.shadowOnlyAlleleOccurrencePairCount).toBe(0);
    expect(result.legacyOnlyAlleleOccurrencePairCount).toBe(0);
    expect(result.maskByPair.get(syntenyAllelePairKey("long", "short-right"))?.reason)
      .toBe("direct-allele");
  });

  it("keeps an asymmetric terminal overlap as boundary support instead of an allele mask", () => {
    const longBlock = {
      ...block("long"),
      sourceEnd: 4_193_175,
      visualEnd: 4_193_175,
    };
    const boundaryBlock = {
      ...block("boundary"),
      sourceEnd: 83_959,
      visualEnd: 83_959,
    };
    const result = buildReferenceSyntenyAllelePruning([
      paf("long", "3", 9_393_740, 13_586_800, {
        queryStart: 83,
        queryEnd: 4_193_168,
        queryLength: 4_193_175,
        alignmentBlockLen: 4_193_120,
        residueMatches: 4_156_469,
        strand: "-",
      }),
      paf("boundary", "3", 13_529_769, 13_613_672, {
        queryStart: 96,
        queryEnd: 83_958,
        queryLength: 83_959,
        alignmentBlockLen: 83_904,
        residueMatches: 76_743,
        strand: "-",
      }),
    ], [longBlock, boundaryBlock], []);

    expect(result.alleleEdges).toHaveLength(1);
    expect(result.alleleEdges[0]).toMatchObject({
      relationship: "boundary-overlap",
      overlapBp: 57_031,
      confidence: "high",
    });
    expect(result.alleleEdges[0].targetOverlap).toBeCloseTo(0.679725, 5);
    expect(result.alleleEdges[0].reciprocalTargetOverlap).toBeCloseTo(0.013602, 5);
    expect(result.maskByPair.has(syntenyAllelePairKey("long", "boundary"))).toBe(false);
    expect(result.groups).toEqual([]);
    expect(result.directAllelePairCount).toBe(0);
    expect(result.pairwiseAlleleOccurrencePairCount).toBe(0);
  });

  it("does not add transitive edges across a chain of pairwise overlaps", () => {
    const blocks = [block("a"), block("b"), block("c")];
    const records = [
      paf("a", "Ref01", 1_000_000, 2_000_000),
      paf("b", "Ref01", 1_400_000, 2_400_000),
      paf("c", "Ref01", 1_800_000, 2_800_000),
    ];
    const result = buildReferenceSyntenyAllelePruning(records, blocks, []);
    const edgePairs = new Set(result.alleleEdges.map((edge) => (
      syntenyAllelePairKey(edge.left.blockId, edge.right.blockId)
    )));

    expect(edgePairs).toEqual(new Set([
      syntenyAllelePairKey("a", "b"),
      syntenyAllelePairKey("b", "c"),
    ]));
    expect(edgePairs.has(syntenyAllelePairKey("a", "c"))).toBe(false);
  });

  it("uses exact target intervals instead of bounding-box overlap", () => {
    const blocks = [block("split-target"), block("gap-target")];
    const records = [
      paf("split-target", "Ref01", 1_000_000, 1_400_000, {
        queryEnd: 500_000,
        alignmentBlockLen: 500_000,
        residueMatches: 475_000,
      }),
      paf("split-target", "Ref01", 1_600_000, 2_000_000, {
        queryStart: 500_000,
        alignmentBlockLen: 500_000,
        residueMatches: 475_000,
      }),
      paf("gap-target", "Ref01", 1_400_000, 1_600_000),
    ];
    const result = buildReferenceSyntenyAllelePruning(records, blocks, [], {
      maxTargetLocusGap: 300_000,
    });

    expect(result.anchors).toHaveLength(2);
    expect(result.anchors.find((anchor) => anchor.sourceId === "split-target")?.targetIntervals)
      .toEqual([[1_000_000, 1_400_000], [1_600_000, 2_000_000]]);
    expect(result.alleleEdges).toEqual([]);
  });

  it("retains the dominant PAF strand for orientation-aware adjacency", () => {
    const result = buildReferenceSyntenyAllelePruning([
      paf("reverse", "Ref01", 1_000_000, 2_000_000, { strand: "-" }),
    ], [block("reverse")], []);

    expect(result.anchors[0]).toMatchObject({
      targetStrand: "-",
      strandDominance: 1,
      targetStart: 1_000_000,
      targetEnd: 2_000_000,
    });
  });

  it("produces the same edge graph regardless of input order", () => {
    const blocks = [block("a"), block("b"), block("c")];
    const records = [
      paf("a", "Ref01", 1_000_000, 2_000_000),
      paf("b", "Ref01", 1_400_000, 2_400_000),
      paf("c", "Ref01", 1_800_000, 2_800_000),
    ];
    const forward = buildReferenceSyntenyAllelePruning(records, blocks, []);
    const reversed = buildReferenceSyntenyAllelePruning(
      [...records].reverse(),
      [...blocks].reverse(),
      [],
    );

    expect(reversed.alleleEdges.map((edge) => edge.id))
      .toEqual(forward.alleleEdges.map((edge) => edge.id));
    expect(reversed.fingerprint).toBe(forward.fingerprint);
  });

  it("projects split source intervals onto the reference before grouping", () => {
    const left = { ...block("split-left", "source-a"), sourceEnd: 500_000 };
    const right = {
      ...block("split-right", "source-a"),
      sourceStart: 500_000,
      visualStart: 500_000,
    };
    const allele = block("allele-b");
    const records = [
      paf("source-a", "Ref01", 1_000_000, 2_000_000),
      paf("allele-b", "Ref01", 1_500_000, 2_000_000, {
        queryEnd: 500_000,
        alignmentBlockLen: 500_000,
        residueMatches: 475_000,
      }),
    ];
    const result = buildReferenceSyntenyAllelePruning(records, [left, right, allele], []);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].members.map((member) => member.blockId)).toEqual([
      "allele-b",
      "split-right",
    ]);
    expect(result.maskByPair.get(syntenyAllelePairKey("split-right", "allele-b"))?.reason)
      .toBe("direct-allele");
  });

  it("uses an exact rectangular maximum-weight matching when allele groups differ in size", () => {
    const blocks = [block("a1"), block("a2"), block("a3"), block("b1"), block("b2")];
    const records = [
      paf("a1", "Ref01", 1_000_000, 2_000_000),
      paf("a2", "Ref01", 1_020_000, 2_020_000),
      paf("a3", "Ref01", 1_040_000, 2_040_000),
      paf("b1", "Ref01", 4_000_000, 5_000_000),
      paf("b2", "Ref01", 4_020_000, 5_020_000),
    ];
    const result = buildReferenceSyntenyAllelePruning(records, blocks, [
      contact("a1", "b1", 100),
      contact("a1", "b2", 1),
      contact("a2", "b1", 2),
      contact("a2", "b2", 90),
      contact("a3", "b1", 80),
      contact("a3", "b2", 3),
    ]);

    expect(result.matchedPairCount).toBe(2);
    expect(result.maskByPair.has(syntenyAllelePairKey("a1", "b1"))).toBe(false);
    expect(result.maskByPair.has(syntenyAllelePairKey("a2", "b2"))).toBe(false);
    expect(result.maskByPair.get(syntenyAllelePairKey("a3", "b1"))?.reason)
      .toBe("cross-allele-nonmatch");
  });

  it("collapses duplicated source occurrences before matching and expands the decisions afterward", () => {
    const copy1 = block("copy-1", "source-a");
    const copy2 = { ...block("copy-2", "source-a"), visualStart: 1_000_000 };
    const blocks = [copy1, copy2, block("a2"), block("b1"), block("b2")];
    const records = [
      paf("source-a", "Ref01", 1_000_000, 2_000_000),
      paf("a2", "Ref01", 1_020_000, 2_020_000),
      paf("b1", "Ref01", 4_000_000, 5_000_000),
      paf("b2", "Ref01", 4_020_000, 5_020_000),
    ];
    const result = buildReferenceSyntenyAllelePruning(records, blocks, [
      contact("copy-1", "b1", 40),
      contact("copy-2", "b1", 40),
      contact("copy-1", "b2", 60),
      contact("a2", "b1", 70),
      contact("a2", "b2", 75),
    ]);

    expect(result.groups[0].members[0].occurrenceBlockIds).toEqual(["copy-1", "copy-2"]);
    expect(result.matchedPairCount).toBe(2);
    expect(result.duplicateOccurrencePairCount).toBe(1);
    expect(result.alleleEdges).toHaveLength(2);
    expect(result.pairwiseAlleleOccurrencePairCount).toBe(3);
    expect(result.maskByPair.get(syntenyAllelePairKey("copy-1", "copy-2"))?.reason)
      .toBe("duplicate-occurrence");
    expect(result.maskByPair.has(syntenyAllelePairKey("copy-1", "b1"))).toBe(false);
    expect(result.maskByPair.has(syntenyAllelePairKey("copy-2", "b1"))).toBe(false);
    expect(result.maskByPair.get(syntenyAllelePairKey("copy-1", "b2"))?.reason)
      .toBe("cross-allele-nonmatch");
    expect(result.maskByPair.get(syntenyAllelePairKey("copy-2", "b2"))?.reason)
      .toBe("cross-allele-nonmatch");
    expect(result.maskByPair.get(syntenyAllelePairKey("copy-1", "a2"))?.reason)
      .toBe("direct-allele");
    expect(result.maskByPair.get(syntenyAllelePairKey("copy-2", "a2"))?.reason)
      .toBe("direct-allele");
  });

  it("masks exact duplicate occurrences but excludes non-dominant multi-locus PAF mappings", () => {
    const original = block("copy-1", "source-a");
    const copy = { ...block("copy-2", "source-a"), visualStart: 1_000_000 };
    const ambiguous = block("ambiguous");
    const sameTargetDuplicate = block("same-target-duplicate");
    const result = buildReferenceSyntenyAllelePruning([
      paf("source-a", "Ref01", 1_000_000, 2_000_000),
      paf("ambiguous", "Ref01", 1_000_000, 2_000_000),
      paf("ambiguous", "Ref02", 1_000_000, 2_000_000),
      paf("same-target-duplicate", "Ref01", 1_000_000, 2_000_000),
      paf("same-target-duplicate", "Ref01", 5_000_000, 6_000_000),
    ], [original, copy, ambiguous, sameTargetDuplicate], []);

    expect(result.anchors).toHaveLength(1);
    expect(result.anchors[0].occurrenceBlockIds).toEqual(["copy-1", "copy-2"]);
    expect(result.groups).toEqual([]);
    expect(result.alleleEdges).toEqual([]);
    expect(result.maskByPair.get(syntenyAllelePairKey("copy-1", "copy-2"))?.reason)
      .toBe("duplicate-occurrence");
    expect(result.duplicateOccurrencePairCount).toBe(1);
    expect(result.multiMappingBlockCount).toBe(2);
    expect(result.repetitiveMappingBlockCount).toBe(2);
    expect(result.splitMappingBlockCount).toBe(0);
    expect(result.excludedBlockCount).toBe(2);
  });

  it("distinguishes disjoint split mappings from overlapping repetitive mappings", () => {
    const result = buildReferenceSyntenyAllelePruning([
      paf("split", "Ref01", 1_000_000, 1_600_000, {
        queryStart: 0,
        queryEnd: 600_000,
        alignmentBlockLen: 600_000,
        residueMatches: 570_000,
      }),
      paf("split", "Ref01", 5_000_000, 5_400_000, {
        queryStart: 600_000,
        queryEnd: 1_000_000,
        alignmentBlockLen: 400_000,
        residueMatches: 380_000,
      }),
    ], [block("split")], []);

    expect(result.anchors).toEqual([]);
    expect(result.multiMappingBlockCount).toBe(1);
    expect(result.splitMappingBlockCount).toBe(1);
    expect(result.repetitiveMappingBlockCount).toBe(0);
    expect(result.exclusions).toEqual([expect.objectContaining({
      sourceId: "split",
      reason: "multi-locus-split",
      candidateLoci: [
        expect.objectContaining({ queryStart: 0, queryEnd: 600_000 }),
        expect.objectContaining({ queryStart: 600_000, queryEnd: 1_000_000 }),
      ],
    })]);
  });
});
