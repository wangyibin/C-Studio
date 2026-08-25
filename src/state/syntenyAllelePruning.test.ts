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
    expect(result.maskByPair.get(syntenyAllelePairKey("copy-1", "copy-2"))?.reason)
      .toBe("duplicate-occurrence");
    expect(result.duplicateOccurrencePairCount).toBe(1);
    expect(result.multiMappingBlockCount).toBe(2);
    expect(result.excludedBlockCount).toBe(2);
  });
});
