import { describe, expect, it } from "vitest";
import type { ContactMapView } from "../App";
import type { GfaGraphNode } from "./gfa";
import {
  buildLengthNormalizedGfaHiCLinks,
  buildSelectedLengthNormalizedGfaHiCLinks,
  gfaHiCContactMapUsesLayout,
} from "./gfaHiCLinks";
import type { ContactMapLayoutBlock } from "./importers";

function block(
  id: string,
  visualStart: number,
  visualEnd: number,
): ContactMapLayoutBlock {
  return {
    id,
    objectId: "Chr01g1",
    sourceId: id,
    sourceStart: 0,
    sourceEnd: visualEnd - visualStart,
    visualStart,
    visualEnd,
    orientation: "+",
  };
}

function node(id: string): Pick<GfaGraphNode, "id" | "occurrenceId"> {
  return { id, occurrenceId: id };
}

function contactMap(
  blocks: ContactMapLayoutBlock[],
  cells: ContactMapView["cells"],
  resolution = 1_000_000,
): ContactMapView {
  return {
    resolution,
    viewport: { xStart: 0, xEnd: 4_000_000, yStart: 0, yEnd: 4_000_000 },
    cells,
    layoutBlocks: blocks,
  };
}

describe("length-normalized GFA Hi-C links", () => {
  it("accepts label-only changes but rejects a stale visual projection", () => {
    const blocks = [block("a", 0, 1_000_000), block("b", 1_000_000, 2_000_000)];
    const map = contactMap(blocks, []);

    expect(gfaHiCContactMapUsesLayout(map, blocks.map((value) => ({
      ...value,
      displayName: `renamed-${value.id}`,
    })))).toBe(true);
    expect(gfaHiCContactMapUsesLayout(map, blocks.map((value, index) => ({
      ...value,
      visualStart: value.visualStart + index * 10,
      visualEnd: value.visualEnd + index * 10,
    })))).toBe(false);
  });

  it("normalizes pair counts by the product of the two unitig lengths", () => {
    const blocks = [
      block("a", 0, 1_000_000),
      block("b", 1_000_000, 3_000_000),
      block("c", 3_000_000, 4_000_000),
    ];
    const links = buildLengthNormalizedGfaHiCLinks(
      contactMap(blocks, [
        { xBin: 0, yBin: 1, count: 20 },
        { xBin: 0, yBin: 3, count: 10 },
      ]),
      blocks,
      [node("a"), node("b"), node("c")],
    );

    expect(links.map((link) => [link.source, link.target])).toEqual([
      ["a", "b"],
      ["a", "c"],
    ]);
    expect(links[0].normalizedCountPerMb2).toBeCloseTo(10);
    expect(links[1].normalizedCountPerMb2).toBeCloseTo(10);
    expect(links[0].lineWidth).toBeCloseTo(links[1].lineWidth);
  });

  it("apportions a coarse bin by unitig overlap before length normalization", () => {
    const blocks = [
      block("a", 0, 500_000),
      block("b", 500_000, 1_000_000),
      block("c", 1_000_000, 2_000_000),
    ];
    const links = buildLengthNormalizedGfaHiCLinks(
      contactMap(blocks, [{ xBin: 0, yBin: 1, count: 12 }]),
      blocks,
      [node("a"), node("b"), node("c")],
    );

    expect(links).toHaveLength(2);
    expect(links.map((link) => link.rawCount)).toEqual([6, 6]);
    expect(links.map((link) => link.normalizedCountPerMb2)).toEqual([12, 12]);
  });

  it("reads packed/tiled overview cells without requiring object materialization", () => {
    const blocks = [block("a", 0, 1_000_000), block("b", 1_000_000, 2_000_000)];
    const map = contactMap(blocks, []);
    map.tileSizeBins = 4;
    map.tiles = [{
      tileX: 0,
      tileY: 0,
      cells: [],
      packedCells: {
        xLocal: new Uint16Array([0]),
        yLocal: new Uint16Array([1]),
        counts: new Float64Array([7]),
      },
    }];

    const links = buildLengthNormalizedGfaHiCLinks(map, blocks, [node("a"), node("b")]);

    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ source: "a", target: "b", rawCount: 7 });
  });

  it("skips self contacts, ignores GFA-only nodes, and keeps only the requested strongest links", () => {
    const blocks = [
      block("a", 0, 1_000_000),
      block("b", 1_000_000, 2_000_000),
      block("c", 2_000_000, 3_000_000),
    ];
    const links = buildLengthNormalizedGfaHiCLinks(
      contactMap(blocks, [
        { xBin: 0, yBin: 0, count: 100 },
        { xBin: 0, yBin: 1, count: 8 },
        { xBin: 0, yBin: 2, count: 3 },
      ]),
      blocks,
      [node("a"), node("b"), node("c"), { id: "gfa-only", occurrenceId: null }],
      1,
    );

    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ source: "a", target: "b", rawCount: 8 });
    expect(links[0].lineWidth).toBeCloseTo(5.4);
  });

  it("can retain coarse partners for every unitig instead of using a global edge cap", () => {
    const blocks = [
      block("a", 0, 1_000_000),
      block("b", 1_000_000, 2_000_000),
      block("c", 2_000_000, 3_000_000),
      block("d", 3_000_000, 4_000_000),
    ];
    const links = buildLengthNormalizedGfaHiCLinks(
      contactMap(blocks, [
        { xBin: 0, yBin: 1, count: 100 },
        { xBin: 2, yBin: 3, count: 1 },
      ]),
      blocks,
      blocks.map(({ id }) => node(id)),
      1,
      1,
    );

    expect(links.map((link) => [link.source, link.target])).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("limits focused aggregation to selected-by-candidate links", () => {
    const blocks = [
      block("a", 0, 1_000_000),
      block("b", 1_000_000, 2_000_000),
      block("c", 2_000_000, 3_000_000),
      block("d", 3_000_000, 4_000_000),
    ];
    const links = buildSelectedLengthNormalizedGfaHiCLinks(
      contactMap(blocks, [
        { xBin: 1, yBin: 2, count: 1_000 },
        { xBin: 0, yBin: 1, count: 8 },
        { xBin: 0, yBin: 2, count: 3 },
        { xBin: 0, yBin: 3, count: 1 },
      ]),
      blocks,
      blocks.map(({ id }) => node(id)),
      new Set(["a"]),
      10,
      2,
    );

    expect(links.map((link) => [link.source, link.target])).toEqual([
      ["a", "b"],
      ["a", "c"],
    ]);
    expect(links.every((link) => link.source === "a" || link.target === "a")).toBe(true);
  });

  it("does not traverse overview cells without a selected placement block", () => {
    const blocks = [block("a", 0, 1_000_000), block("b", 1_000_000, 2_000_000)];
    const map = contactMap(blocks, []);
    Object.defineProperty(map.cells, Symbol.iterator, {
      value: () => {
        throw new Error("overview cells should remain untouched");
      },
    });

    expect(buildSelectedLengthNormalizedGfaHiCLinks(
      map,
      blocks,
      blocks.map(({ id }) => node(id)),
      new Set(),
    )).toEqual([]);
  });
});
