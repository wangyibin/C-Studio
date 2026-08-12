import { describe, expect, it } from "vitest";
import { classifyGfaScaffolds } from "./gfaHomologLayout";
import type { ContactMapLayoutBlock } from "./importers";
import {
  gfaContigsForHeatmapViewport,
  gfaPrimaryHomologScaffoldsForHeatmapViewport,
  gfaScaffoldsForHeatmapViewport,
} from "./gfaViewportSync";

function block(id: string, objectId: string, visualStart: number, visualEnd: number): ContactMapLayoutBlock {
  return {
    id,
    objectId,
    sourceId: id,
    sourceStart: 0,
    sourceEnd: visualEnd - visualStart,
    visualStart,
    visualEnd,
    orientation: "+",
    gapBefore: undefined,
  };
}

describe("GFA heatmap viewport synchronization", () => {
  it("expands a visible chromosome to its whole homolog group across both axes", () => {
    const blocks = [
      block("a", "Chr01g1", 0, 100),
      block("b", "Chr01g2", 100, 200),
      block("c", "Chr02g1", 200, 300),
    ];
    const homologs = classifyGfaScaffolds(["Chr01g1", "Chr01g2", "Chr02g1"]);
    const visible = gfaScaffoldsForHeatmapViewport(
      blocks,
      { xStart: 220, xEnd: 250, yStart: 120, yEnd: 140 },
      homologs,
    );

    expect([...visible].sort()).toEqual(["Chr01g1", "Chr01g2", "Chr02g1"]);
  });

  it("does not narrow a homolog group to the visible block or contig", () => {
    const blocks = [
      block("a1", "Chr01g1", 0, 50),
      block("a2", "Chr01g1", 50, 100),
      block("b", "Chr01g2", 100, 200),
      block("c", "Chr02g1", 200, 300),
    ];
    const homologs = classifyGfaScaffolds(["Chr01g1", "Chr01g2", "Chr02g1"]);
    const visible = gfaScaffoldsForHeatmapViewport(
      blocks,
      { xStart: 10, xEnd: 20, yStart: 10, yEnd: 20 },
      homologs,
    );

    expect([...visible].sort()).toEqual(["Chr01g1", "Chr01g2"]);
    expect(visible.has("Chr02g1")).toBe(false);
  });

  it("excludes visible scaffolds that do not match the homolog regex", () => {
    const blocks = [
      block("chr", "Chr01g1", 0, 100),
      block("unanchor", "utg000024l", 100, 200),
    ];
    const homologs = classifyGfaScaffolds(["Chr01g1", "utg000024l"]);

    expect([...gfaScaffoldsForHeatmapViewport(
      blocks,
      { xStart: 110, xEnd: 150, yStart: 110, yEnd: 150 },
      homologs,
    )]).toEqual([]);
    expect([...gfaPrimaryHomologScaffoldsForHeatmapViewport(
      blocks,
      { xStart: 110, xEnd: 150, yStart: 110, yEnd: 150 },
      homologs,
    )]).toEqual([]);
  });

  it("adds five AGP-order contigs on each side without crossing chromosomes", () => {
    const chr1 = Array.from({ length: 12 }, (_, index) => (
      block(`a${index}`, "Chr01g1", index * 10, index * 10 + 10)
    ));
    const chr2 = [block("b0", "Chr01g2", 120, 130)];

    expect([...gfaContigsForHeatmapViewport(
      [...chr1, ...chr2],
      { xStart: 60, xEnd: 70, yStart: 60, yEnd: 70 },
    )].sort()).toEqual([
      "a1", "a10", "a11", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9",
    ]);
  });

  it("unions flanking windows from the X and Y heatmap axes", () => {
    const blocks = [
      block("a0", "Chr01g1", 0, 10),
      block("a1", "Chr01g1", 10, 20),
      block("b0", "Chr01g2", 20, 30),
      block("b1", "Chr01g2", 30, 40),
    ];

    expect([...gfaContigsForHeatmapViewport(
      blocks,
      { xStart: 0, xEnd: 5, yStart: 35, yEnd: 40 },
      0,
    )].sort()).toEqual(["a0", "b1"]);
  });

  it("focuses the compact preview on one homolog group at the X-axis center", () => {
    const blocks = [
      block("a", "Chr01g1", 0, 100),
      block("b", "Chr01g2", 100, 200),
      block("c", "Chr02g1", 200, 300),
      block("d", "Chr02g2", 300, 400),
    ];
    const homologs = classifyGfaScaffolds(["Chr01g1", "Chr01g2", "Chr02g1", "Chr02g2"]);

    expect([...gfaPrimaryHomologScaffoldsForHeatmapViewport(
      blocks,
      { xStart: 220, xEnd: 260, yStart: 20, yEnd: 40 },
      homologs,
    )].sort()).toEqual(["Chr02g1", "Chr02g2"]);
  });

  it("uses the largest X overlap when the viewport center falls in an AGP gap", () => {
    const blocks = [
      block("a", "Chr01g1", 0, 80),
      block("b", "Chr02g1", 120, 150),
    ];
    const homologs = classifyGfaScaffolds(["Chr01g1", "Chr02g1"]);

    expect([...gfaPrimaryHomologScaffoldsForHeatmapViewport(
      blocks,
      { xStart: 30, xEnd: 130, yStart: 120, yEnd: 140 },
      homologs,
    )]).toEqual(["Chr01g1"]);
  });
});
