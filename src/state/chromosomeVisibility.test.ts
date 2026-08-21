import { describe, expect, it } from "vitest";
import {
  buildChromosomeViewLayout,
  chromosomeDisplayScope,
  intersectVisibleChromosomes,
  placeHiddenChromosomeBlocksAfter,
  resolveChromosomeVisibility,
  updateHiddenChromosomeSelection,
} from "./chromosomeVisibility";

const blocks = [
  { id: "a", objectId: "Chr1", sourceId: "a", sourceStart: 0, sourceEnd: 100, visualStart: 0, visualEnd: 100, orientation: "+" as const },
  { id: "b", objectId: "Chr2", sourceId: "b", sourceStart: 0, sourceEnd: 50, visualStart: 100, visualEnd: 150, orientation: "+" as const },
  { id: "c", objectId: "Chr2", sourceId: "c", sourceStart: 10, sourceEnd: 40, visualStart: 160, visualEnd: 190, orientation: "-" as const, gapBefore: { componentType: "N" as const, length: 10, gapType: "scaffold", linkage: "yes", linkageEvidence: "paired-ends" } },
  { id: "d", objectId: "Chr3", sourceId: "d", sourceStart: 0, sourceEnd: 25, visualStart: 190, visualEnd: 215, orientation: "+" as const },
];

describe("resolveChromosomeVisibility", () => {
  it("shows every chromosome by default", () => {
    const visibility = resolveChromosomeVisibility(
      ["Chr01g1", "Chr01g2", "Chr02g1"],
      new Set(),
      "",
    );

    expect([...visibility.visibleIds]).toEqual(["Chr01g1", "Chr01g2", "Chr02g1"]);
    expect(visibility.unanchoredIds).toEqual([]);
    expect(visibility.active).toBe(false);
    expect(visibility.error).toBeNull();
  });

  it("combines checkbox exclusions with a name regex", () => {
    const visibility = resolveChromosomeVisibility(
      ["Chr01g1", "Chr01g2", "Chr02g1"],
      new Set(["Chr01g2"]),
      "^Chr01",
    );

    expect([...visibility.visibleIds]).toEqual(["Chr01g1"]);
    expect(visibility.active).toBe(true);
  });

  it("reports an invalid regex without hiding manually visible chromosomes", () => {
    const visibility = resolveChromosomeVisibility(
      ["Chr01g1", "Chr01g2"],
      new Set(["Chr01g2"]),
      "(Chr01",
    );

    expect([...visibility.visibleIds]).toEqual(["Chr01g1"]);
    expect(visibility.error).toContain("Invalid regular expression:");
  });

  it("keeps unanchored objects aggregated and optional during chromosome filtering", () => {
    const hiddenByDefault = resolveChromosomeVisibility(
      ["Chr01g1", "Chr02g1"],
      new Set(),
      "^Chr01",
      { unanchoredIds: ["utg1", "utg2", "utg1"], includeUnanchored: false },
    );
    const included = resolveChromosomeVisibility(
      ["Chr01g1", "Chr02g1"],
      new Set(),
      "^Chr01",
      { unanchoredIds: ["utg1", "utg2"], includeUnanchored: true },
    );

    expect(hiddenByDefault.unanchoredIds).toEqual(["utg1", "utg2"]);
    expect([...hiddenByDefault.visibleIds]).toEqual(["Chr01g1"]);
    expect([...included.visibleIds]).toEqual(["Chr01g1", "utg1", "utg2"]);
    expect(included.active).toBe(true);
  });

  it("treats an explicit regex that matches every chromosome as an active filter", () => {
    const visibility = resolveChromosomeVisibility(
      ["Chr01g1", "Chr02g1"],
      new Set(),
      "^Chr",
      { unanchoredIds: ["utg1"] },
    );

    expect([...visibility.visibleIds]).toEqual(["Chr01g1", "Chr02g1"]);
    expect(visibility.active).toBe(true);
  });

  it("shows unanchored objects with the unfiltered default view", () => {
    const visibility = resolveChromosomeVisibility(
      ["Chr01g1"],
      new Set(),
      "",
      { unanchoredIds: ["utg1", "utg2"] },
    );

    expect([...visibility.visibleIds]).toEqual(["Chr01g1", "utg1", "utg2"]);
    expect(visibility.active).toBe(false);
  });

  it("intersects automatic viewport chromosomes with the explicit filter", () => {
    expect([...intersectVisibleChromosomes(
      new Set(["Chr01g1", "Chr01g2"]),
      new Set(["Chr01g2", "Chr02g1"]),
    )]).toEqual(["Chr01g2"]);
  });

  it("uses an explicit filter as the scope even outside the automatic focus", () => {
    const visible = chromosomeDisplayScope(
      new Set(["Chr05g1", "Chr05g2"]),
      {
        active: true,
        visibleIds: new Set(["Chr01g2", "Chr01g3", "Chr01g4"]),
      },
    );

    expect([...visible]).toEqual(["Chr01g2", "Chr01g3", "Chr01g4"]);
  });

  it("keeps the automatic focus when no explicit filter is active", () => {
    const visible = chromosomeDisplayScope(
      new Set(["Chr05g1", "Chr05g2"]),
      {
        active: false,
        visibleIds: new Set(["Chr01g1", "Chr05g1", "Chr05g2"]),
      },
    );

    expect([...visible]).toEqual(["Chr05g1", "Chr05g2"]);
  });
});

describe("buildChromosomeViewLayout", () => {
  it("keeps the authoritative layout by reference when every chromosome is visible", () => {
    const layout = buildChromosomeViewLayout(blocks, {
      active: false,
      visibleIds: new Set(["Chr1", "Chr2", "Chr3"]),
    });

    expect(layout.blocks).toBe(blocks);
    expect(layout.projectionBlocks).toBe(blocks);
    expect(layout.totalSpan).toBe(215);
  });

  it("rebases visible chromosomes while retaining hidden placements after the display span", () => {
    const layout = buildChromosomeViewLayout(blocks, {
      active: true,
      visibleIds: new Set(["Chr2"]),
    });

    expect(layout.blocks.map(({ id, visualStart, visualEnd }) => ({ id, visualStart, visualEnd })))
      .toEqual([
        { id: "b", visualStart: 0, visualEnd: 50 },
        { id: "c", visualStart: 60, visualEnd: 90 },
      ]);
    expect(layout.totalSpan).toBe(90);
    expect(layout.projectionBlocks.map((block) => block.id)).toEqual(["b", "c", "a", "d"]);
    expect(layout.projectionBlocks[2]?.visualStart).toBe(90);
    expect(blocks[1]?.visualStart).toBe(100);
  });

  it("returns no display blocks when the explicit selection is empty", () => {
    const layout = buildChromosomeViewLayout(blocks, {
      active: true,
      visibleIds: new Set(),
    });

    expect(layout.blocks).toEqual([]);
    expect(layout.totalSpan).toBe(0);
    expect(layout.projectionBlocks).toHaveLength(blocks.length);
  });

  it("keeps hidden placements for copy shares but moves them beyond the request viewport", () => {
    const layout = buildChromosomeViewLayout(blocks, {
      active: true,
      visibleIds: new Set(["Chr2"]),
    });
    const projected = placeHiddenChromosomeBlocksAfter(layout, 150);

    expect(projected.map((block) => block.id)).toEqual(["b", "c", "a", "d"]);
    expect(projected.slice(0, 2).map((block) => block.visualStart)).toEqual([0, 60]);
    expect(projected[2]?.visualStart).toBe(150);
    expect(projected[3]?.visualStart).toBe(250);
    expect(layout.projectionBlocks[2]?.visualStart).toBe(90);
  });
});

describe("updateHiddenChromosomeSelection", () => {
  const chromosomeIds = ["Chr01g1", "Chr01g2", "Chr01g3", "Chr01g4", "Chr02g1"];

  it("changes only the target without a shift anchor", () => {
    expect([...updateHiddenChromosomeSelection(
      chromosomeIds,
      new Set(["Chr02g1"]),
      "Chr01g2",
      false,
    )]).toEqual(["Chr02g1", "Chr01g2"]);
  });

  it("hides the inclusive range between the anchor and target", () => {
    expect([...updateHiddenChromosomeSelection(
      chromosomeIds,
      new Set(),
      "Chr01g4",
      false,
      "Chr01g2",
    )]).toEqual(["Chr01g2", "Chr01g3", "Chr01g4"]);
  });

  it("shows a reverse range while preserving exclusions outside it", () => {
    expect([...updateHiddenChromosomeSelection(
      chromosomeIds,
      new Set(chromosomeIds),
      "Chr01g2",
      true,
      "Chr01g4",
    )]).toEqual(["Chr01g1", "Chr02g1"]);
  });

  it("falls back to the target when the anchor is stale", () => {
    expect([...updateHiddenChromosomeSelection(
      chromosomeIds,
      new Set(),
      "Chr01g3",
      false,
      "Chr99",
    )]).toEqual(["Chr01g3"]);
  });
});
