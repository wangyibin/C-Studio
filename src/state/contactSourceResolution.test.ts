import { describe, expect, it } from "vitest";
import type { ContactMapLayoutBlock } from "./importers";
import { resolveContactLayoutSources } from "./contactSourceResolution";

function block(
  sourceId: string,
  sourceEnd: number,
  visualStart: number,
  sourceStart = 0,
): ContactMapLayoutBlock {
  return {
    id: `Chr01:${visualStart + 1}:${sourceId}`,
    objectId: "Chr01",
    sourceId,
    sourceStart,
    sourceEnd,
    visualStart,
    visualEnd: visualStart + sourceEnd - sourceStart,
    orientation: "+",
  };
}

describe("resolveContactLayoutSources", () => {
  it("projects verified _dN AGP pieces onto one unsplit Cooler source", () => {
    const blocks = [
      block("utg1", 40, 0),
      block("utg1_d2", 35, 40),
      block("utg1_d3", 25, 75),
    ];

    const resolved = resolveContactLayoutSources(blocks, [{ name: "utg1", length: 100 }]);

    expect(resolved.remappedSourceIds).toEqual(["utg1_d2", "utg1_d3"]);
    expect(resolved.unresolvedSourceIds).toEqual([]);
    expect(resolved.blocks.map((value) => ({
      sourceId: value.sourceId,
      displayName: value.displayName,
      interval: [value.sourceStart, value.sourceEnd],
    }))).toEqual([
      { sourceId: "utg1", displayName: undefined, interval: [0, 40] },
      { sourceId: "utg1", displayName: "utg1_d2", interval: [40, 75] },
      { sourceId: "utg1", displayName: "utg1_d3", interval: [75, 100] },
    ]);
    expect(blocks[1]).toMatchObject({ sourceId: "utg1_d2", sourceStart: 0, sourceEnd: 35 });
  });

  it("keeps an exact Cooler source match instead of interpreting its suffix", () => {
    const blocks = [block("utg1", 40, 0), block("utg1_d2", 60, 40)];
    const resolved = resolveContactLayoutSources(blocks, [
      { name: "utg1", length: 100 },
      { name: "utg1_d2", length: 60 },
    ]);

    expect(resolved.blocks).toBe(blocks);
    expect(resolved.remappedSourceIds).toEqual([]);
    expect(resolved.unresolvedSourceIds).toEqual([]);
  });

  it("does not guess when pieces do not prove a complete partition", () => {
    const blocks = [block("utg1", 30, 0), block("utg1_d2", 35, 30), block("utg1_d3", 25, 65)];
    const resolved = resolveContactLayoutSources(blocks, [{ name: "utg1", length: 100 }]);

    expect(resolved.blocks).toBe(blocks);
    expect(resolved.remappedSourceIds).toEqual([]);
    expect(resolved.unresolvedSourceIds).toEqual(["utg1_d2", "utg1_d3"]);
  });

  it("does not skip a missing derived index", () => {
    const blocks = [block("utg1", 75, 0), block("utg1_d3", 25, 75)];
    const resolved = resolveContactLayoutSources(blocks, [{ name: "utg1", length: 100 }]);

    expect(resolved.remappedSourceIds).toEqual([]);
    expect(resolved.unresolvedSourceIds).toEqual(["utg1_d3"]);
  });

  it("reports unrelated AGP sources that are absent from Cooler", () => {
    const blocks = [block("different", 20, 0)];
    const resolved = resolveContactLayoutSources(blocks, [{ name: "utg1", length: 100 }]);

    expect(resolved.unresolvedSourceIds).toEqual(["different"]);
  });

  it("does not resolve a derived name through duplicate Cooler source names", () => {
    const blocks = [block("utg1", 40, 0), block("utg1_d2", 60, 40)];
    const resolved = resolveContactLayoutSources(blocks, [
      { name: "utg1", length: 100 },
      { name: "utg1", length: 100 },
    ]);

    expect(resolved.remappedSourceIds).toEqual([]);
    expect(resolved.unresolvedSourceIds).toEqual(["utg1_d2"]);
  });
});
