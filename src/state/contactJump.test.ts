import { describe, expect, it } from "vitest";

import type { ContactMapLayoutBlock } from "./importers";
import { resolveContactJumpInputs, resolveContactJumpRegion } from "./contactJump";

const blocks: ContactMapLayoutBlock[] = [
  {
    id: "Chr01:1:ctgA",
    objectId: "Chr01",
    sourceId: "ctgA",
    sourceStart: 0,
    sourceEnd: 10_000,
    visualStart: 20_000,
    visualEnd: 30_000,
    orientation: "+",
  },
  {
    id: "Chr01:2:ctgB",
    objectId: "Chr01",
    sourceId: "ctgB",
    displayName: "renamedB",
    sourceStart: 1_000,
    sourceEnd: 11_000,
    visualStart: 30_000,
    visualEnd: 40_000,
    orientation: "-",
  },
];

describe("contact jump queries", () => {
  it("resolves a whole contig on both axes when only one input is provided", () => {
    expect(resolveContactJumpInputs(blocks, "ctgA", "")).toEqual({
      ok: true,
      x: {
        query: "ctgA",
        blockId: "Chr01:1:ctgA",
        contigName: "ctgA",
        visualStartBp: 20_000,
        visualEndBp: 30_000,
        centerBp: 25_000,
        spanBp: 10_000,
      },
      y: {
        query: "ctgA",
        blockId: "Chr01:1:ctgA",
        contigName: "ctgA",
        visualStartBp: 20_000,
        visualEndBp: 30_000,
        centerBp: 25_000,
        spanBp: 10_000,
      },
      label: "ctgA",
    });
  });

  it("maps source intervals through forward and reverse placements", () => {
    expect(resolveContactJumpRegion(blocks, "ctgA:100-1100")).toMatchObject({
      blockId: "Chr01:1:ctgA",
      visualStartBp: 20_100,
      visualEndBp: 21_100,
      centerBp: 20_600,
      spanBp: 1_000,
    });
    expect(resolveContactJumpRegion(blocks, "renamedB:2000-3000")).toMatchObject({
      query: "renamedB:2000-3000",
      blockId: "Chr01:2:ctgB",
      visualStartBp: 38_000,
      visualEndBp: 39_000,
      centerBp: 38_500,
      spanBp: 1_000,
    });
  });

  it("resolves independent X and Y targets", () => {
    const result = resolveContactJumpInputs(blocks, "ctgA:0-1000", "renamedB:1000-2000");
    expect(result).toMatchObject({
      ok: true,
      x: { centerBp: 20_500, spanBp: 1_000 },
      y: { centerBp: 39_500, spanBp: 1_000 },
    });
  });

  it("reports malformed, missing, and out-of-range queries", () => {
    expect(resolveContactJumpRegion(blocks, "ctgA:1000")).toBe(
      "Use contig or contig:start-end.",
    );
    expect(resolveContactJumpRegion(blocks, "missing:0-100")).toBe(
      "Contig “missing” was not found.",
    );
    expect(resolveContactJumpRegion(blocks, "ctgA:9000-11000")).toBe(
      "Interval must stay within ctgA:0-10000.",
    );
  });
});
