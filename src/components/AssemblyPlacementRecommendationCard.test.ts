import { describe, expect, it } from "vitest";
import type { ContactMapView } from "../App";
import type { ContactMapLayoutBlock } from "../state/importers";
import type { HiCAlleleConcordancePair } from "../state/hicAlleleConcordance";
import {
  placementRecommendationBinnedAlleleLinks,
  placementRecommendationCoarseLinks,
} from "./AssemblyPlacementRecommendationCard";

function block(id: string, visualStart: number): ContactMapLayoutBlock {
  return {
    id,
    objectId: "Chr01",
    sourceId: id,
    sourceStart: 0,
    sourceEnd: 1_000_000,
    visualStart,
    visualEnd: visualStart + 1_000_000,
    orientation: "+",
  };
}

function overview(
  blocks: ContactMapLayoutBlock[],
  cells: ContactMapView["cells"],
): ContactMapView {
  return {
    resolution: 1_000_000,
    normalization: "raw",
    viewport: { xStart: 0, xEnd: 3_000_000, yStart: 0, yEnd: 3_000_000 },
    cells,
    layoutBlocks: blocks,
  };
}

describe("placement recommendation coarse links", () => {
  it("does not traverse the overview during cold load without a selection", () => {
    const blocks = [block("a", 0), block("b", 1_000_000)];
    const map = overview(blocks, []);
    Object.defineProperty(map.cells, Symbol.iterator, {
      value: () => {
        throw new Error("cold load must not traverse overview contacts");
      },
    });

    expect(placementRecommendationCoarseLinks(map, blocks, null, "raw")).toEqual([]);
  });

  it("returns only links incident to the selected placement contig", () => {
    const blocks = [block("a", 0), block("b", 1_000_000), block("c", 2_000_000)];
    const links = placementRecommendationCoarseLinks(
      overview(blocks, [
        { xBin: 1, yBin: 2, count: 1_000 },
        { xBin: 0, yBin: 1, count: 8 },
        { xBin: 0, yBin: 2, count: 3 },
      ]),
      blocks,
      { kind: "contigs", ids: ["a"], exact: true },
      "raw",
    );

    expect(links.map((link) => [link.source, link.target])).toEqual([
      ["a", "b"],
      ["a", "c"],
    ]);
  });

  it("projects a supported singleton allele partner's binned neighborhood onto the selection", () => {
    const blocks = [
      block("target-a", 0),
      block("target-b", 1_000_000),
      { ...block("selected", 2_000_000), objectId: "selected" },
      { ...block("allele", 3_000_000), objectId: "allele" },
    ];
    const pair: HiCAlleleConcordancePair = {
      id: "hic-concordance:selected:allele",
      leftBlockId: "selected",
      rightBlockId: "allele",
      leftObjectId: "selected",
      rightObjectId: "allele",
      concordanceRatio: 0.05,
      parallelRatio: 0.01,
      antiparallelRatio: 0.05,
      orientation: "antiparallel",
      support: 142.3,
      supportUnit: "raw-contact-weight",
      observedCellCount: 12,
      resolvedWindowCount: 20,
      coveredShorterWindowCount: 8,
      lineRatio: 0.2,
      lineExpectedRatio: 0.05,
      lineEnrichment: 4,
      lineZScore: 3.3,
      lineWeight: 142.3,
      lineOrientation: "antiparallel",
      lineCoveredLeftWindowCount: 8,
      lineCoveredRightWindowCount: 8,
      lineCoveredLeftWindowFraction: 0.4,
      lineCoveredRightWindowFraction: 0.4,
      lineReciprocalCoverage: 0.4,
      lineEffectiveWindowCount: 8,
      lineEffectiveWindowFraction: 0.4,
      lineReciprocalSpanFraction: 0.4,
      evidenceModel: "trans-line",
      confidence: "supported",
    };

    const links = placementRecommendationBinnedAlleleLinks(
      overview(blocks, [
        { xBin: 0, yBin: 3, count: 80 },
        { xBin: 1, yBin: 3, count: 40 },
        { xBin: 2, yBin: 3, count: 200 },
      ]),
      blocks,
      { kind: "contigs", ids: ["selected"], exact: true },
      "raw",
      [pair],
    );

    expect(links.map((link) => [link.source, link.target, link.normalizedCountPerMb2])).toEqual([
      ["selected", "target-a", 80],
      ["selected", "target-b", 40],
    ]);
  });
});
