import { describe, expect, it } from "vitest";
import type { ContactMapLayoutBlock } from "./importers";
import { contactTileKey } from "./contactTiles";
import {
  buildContactGpuLayoutMap,
  buildContactSourceAddressSpace,
  contactGpuCompactLayoutAddressData,
  contactGpuLayoutMapEntryAt,
  contactGpuLayoutMapIsExact,
  contactGpuLayoutMapExactFlag,
  contactGpuLayoutMapReverseFlag,
  contactGpuLayoutMapValidFlag,
  contactGpuMappedContactValue,
  contactGpuSourceTilePlan,
  contactSourceIdentityLayout,
} from "./contactSourceLayout";

const sources = [
  { name: "a", length: 4_000 },
  { name: "b", length: 3_000 },
];

function block(
  id: string,
  sourceId: string,
  sourceStart: number,
  sourceEnd: number,
  visualStart: number,
  orientation: ContactMapLayoutBlock["orientation"] = "+",
  gapLength = 0,
): ContactMapLayoutBlock {
  return {
    id,
    objectId: "chr1",
    sourceId,
    sourceStart,
    sourceEnd,
    visualStart,
    visualEnd: visualStart + sourceEnd - sourceStart,
    orientation,
    gapBefore: gapLength > 0 ? {
      componentType: "N",
      length: gapLength,
      gapType: "scaffold",
      linkage: "yes",
      linkageEvidence: "proximity_ligation",
    } : undefined,
  };
}

function layoutMap(layoutBlocks: ContactMapLayoutBlock[], end = 8_000) {
  return buildContactGpuLayoutMap({
    addressSpace: buildContactSourceAddressSpace(sources),
    layoutBlocks,
    resolution: 1_000,
    tileSizeBins: 4,
    viewport: { xStart: 0, xEnd: end },
  });
}

describe("contact source-space layout mapping", () => {
  it("builds a deterministic immutable source address axis", () => {
    const addressSpace = buildContactSourceAddressSpace(sources);
    expect(addressSpace.sources).toEqual([
      { sourceId: "a", ordinal: 0, sourceLength: 4_000, globalStart: 0, globalEnd: 4_000 },
      { sourceId: "b", ordinal: 1, sourceLength: 3_000, globalStart: 4_000, globalEnd: 7_000 },
    ]);
    expect(contactSourceIdentityLayout(addressSpace, 1_000).map((entry) => ({
      sourceId: entry.sourceId,
      visualStart: entry.visualStart,
      visualEnd: entry.visualEnd,
      orientation: entry.orientation,
    }))).toEqual([
      { sourceId: "a", visualStart: 0, visualEnd: 4_000, orientation: "+" },
      { sourceId: "b", visualStart: 4_000, visualEnd: 7_000, orientation: "+" },
    ]);
  });

  it("maps forward source bins and packs valid/exact GPU flags", () => {
    const map = layoutMap([block("a", "a", 0, 4_000, 0)]);
    expect(map.entries.slice(0, 4).map((entry) => entry.sourceGlobalBin)).toEqual([0, 1, 2, 3]);
    expect([...map.addressData.slice(0, 4)]).toEqual([
      0,
      0,
      contactGpuLayoutMapValidFlag | contactGpuLayoutMapExactFlag,
      0,
    ]);
  });

  it("maps reverse bins with the same sourceEnd - offset - 1 rule as Rust", () => {
    const map = layoutMap([block("a", "a", 0, 4_000, 0, "-")]);
    expect(map.entries.slice(0, 4).map((entry) => entry.sourcePosition)).toEqual([
      3_000,
      2_000,
      1_000,
      0,
    ]);
    expect(map.entries.slice(0, 4).map((entry) => entry.sourceGlobalBin)).toEqual([3, 2, 1, 0]);
    expect(map.addressData[2]).toBe(
      contactGpuLayoutMapValidFlag
      | contactGpuLayoutMapReverseFlag
      | contactGpuLayoutMapExactFlag,
    );
  });

  it("leaves AGP gaps unmapped while preserving the following source address", () => {
    const map = layoutMap([
      block("a", "a", 0, 2_000, 0),
      block("b", "b", 0, 3_000, 3_000, "+", 1_000),
    ]);
    expect(contactGpuLayoutMapEntryAt(map, 2)?.valid).toBe(false);
    expect(contactGpuLayoutMapEntryAt(map, 3)).toMatchObject({
      valid: true,
      sourceId: "b",
      sourcePosition: 0,
      sourceGlobalBin: 4,
    });
  });

  it("represents a move by changing only visual-to-source order", () => {
    const map = layoutMap([
      block("b", "b", 0, 3_000, 0),
      block("a", "a", 0, 4_000, 3_000),
    ]);
    expect(map.entries.slice(0, 7).map((entry) => entry.sourceId)).toEqual([
      "b", "b", "b", "a", "a", "a", "a",
    ]);
    expect(map.entries.slice(0, 7).map((entry) => entry.sourceGlobalBin)).toEqual([
      4, 5, 6, 0, 1, 2, 3,
    ]);
  });

  it("matches endpoint-local c/(n_x*n_y) weights for copied intervals", () => {
    const map = layoutMap([
      block("a-1", "a", 0, 1_000, 0),
      block("a-2", "a", 0, 1_000, 1_000),
      block("b-1", "b", 0, 1_000, 2_000),
      block("b-2", "b", 0, 1_000, 3_000),
      block("b-3", "b", 0, 1_000, 4_000),
    ]);
    const aCopies = map.entries.filter((entry) => entry.sourceId === "a");
    const bCopies = map.entries.filter((entry) => entry.sourceId === "b");
    expect(aCopies.map((entry) => [entry.copyCount, entry.copyWeight])).toEqual([
      [2, 0.5],
      [2, 0.5],
    ]);
    expect(bCopies.map((entry) => [entry.copyCount, entry.copyWeight])).toEqual([
      [3, 1 / 3],
      [3, 1 / 3],
      [3, 1 / 3],
    ]);
    const projected = aCopies.flatMap((x) => bCopies.map((y) => (
      contactGpuMappedContactValue(12, x, y)
    )));
    expect(projected).toEqual([2, 2, 2, 2, 2, 2]);
    expect(projected.reduce((total, value) => total + value, 0)).toBe(12);
  });

  it("uses local interval copy counts and restores full weight after deletion", () => {
    const copied = layoutMap([
      block("a-full", "a", 0, 2_000, 0),
      block("a-partial-copy", "a", 0, 1_000, 2_000),
    ], 4_000);
    expect(contactGpuLayoutMapEntryAt(copied, 0)?.copyWeight).toBe(0.5);
    expect(contactGpuLayoutMapEntryAt(copied, 1)?.copyWeight).toBe(1);

    const afterDelete = layoutMap([block("a-full", "a", 0, 2_000, 0)], 2_000);
    expect(afterDelete.entries.map((entry) => entry.copyWeight)).toEqual([1, 1]);
  });

  it("marks unaligned mappings as preview-only rather than exact", () => {
    const map = buildContactGpuLayoutMap({
      addressSpace: buildContactSourceAddressSpace(sources),
      layoutBlocks: [block("unaligned", "a", 500, 2_500, 0)],
      resolution: 1_000,
      tileSizeBins: 4,
      viewport: { xStart: 0, xEnd: 2_000 },
    });
    expect(map.entries.every((entry) => entry.valid && !entry.exact)).toBe(true);
    expect(contactGpuLayoutMapIsExact(map)).toBe(false);
    expect(map.addressData[2] & contactGpuLayoutMapExactFlag).toBe(0);
  });

  it("pads every source to its own resolution bin axis", () => {
    const addressSpace = buildContactSourceAddressSpace([
      { name: "short-a", length: 1_500 },
      { name: "short-b", length: 1_500 },
    ]);
    const identity = contactSourceIdentityLayout(addressSpace, 1_000);
    expect(identity.map((entry) => [entry.visualStart, entry.visualEnd])).toEqual([
      [0, 1_500],
      [2_000, 3_500],
    ]);
    const map = buildContactGpuLayoutMap({
      addressSpace,
      layoutBlocks: identity,
      resolution: 1_000,
      tileSizeBins: 2,
      viewport: { xStart: 0, xEnd: 4_000 },
    });
    expect(map.entries.map((entry) => entry.valid ? entry.sourceGlobalBin : null)).toEqual([
      0,
      1,
      2,
      3,
    ]);
    expect(contactGpuLayoutMapIsExact(map)).toBe(true);
  });

  it("maps a reverse partial terminal bin by projected source-bin starts", () => {
    const addressSpace = buildContactSourceAddressSpace([
      { name: "partial", length: 1_500 },
    ]);
    const map = buildContactGpuLayoutMap({
      addressSpace,
      layoutBlocks: [block("partial-reverse", "partial", 0, 1_500, 500, "-")],
      resolution: 1_000,
      tileSizeBins: 2,
      viewport: { xStart: 0, xEnd: 2_000 },
    });
    expect(map.entries.map((entry) => entry.sourceGlobalBin)).toEqual([1, 0]);
    expect(contactGpuLayoutMapIsExact(map)).toBe(true);
  });

  it("deduplicates copied bins into a canonical source tile cross product", () => {
    const addressSpace = buildContactSourceAddressSpace([
      { name: "a", length: 400 },
      { name: "b", length: 400 },
    ]);
    const blocks = [
      block("a-1", "a", 0, 400, 0),
      block("a-2", "a", 0, 400, 400),
      block("b", "b", 0, 400, 800),
    ];
    const buildMap = (xStart: number, xEnd: number) => buildContactGpuLayoutMap({
      addressSpace,
      layoutBlocks: blocks,
      resolution: 100,
      tileSizeBins: 2,
      viewport: { xStart, xEnd },
    });
    const plan = contactGpuSourceTilePlan(buildMap(0, 800), buildMap(400, 1_200));

    expect(plan.sourceTiles).toEqual([0, 1, 2, 3]);
    expect(plan.tiles).toHaveLength(7);
    expect(new Set(plan.tiles.map(contactTileKey)).size).toBe(7);
    const compact = contactGpuCompactLayoutAddressData(buildMap(0, 800), plan.sourceTiles);
    expect([compact[0], compact[4], compact[8], compact[12]]).toEqual([0, 0, 1, 1]);
  });
});
