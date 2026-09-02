import { describe, expect, it } from "vitest";
import type { ContactMapView } from "../App";
import type { ContactMapLayoutBlock } from "../state/importers";
import { placementRecommendationCoarseLinks } from "./AssemblyPlacementRecommendationCard";

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
});
