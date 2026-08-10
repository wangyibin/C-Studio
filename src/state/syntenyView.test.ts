import { describe, expect, it } from "vitest";
import {
  buildBrowserSyntenyView,
  buildSyntenyViewRequest,
  buildSyntenyViewport,
} from "./syntenyView";

describe("buildSyntenyViewRequest", () => {
  it("matches the heatmap X center, zoom span, and aspect ratio", () => {
    expect(buildSyntenyViewport({
      centerXMb: 120,
      totalSpanBp: 300_000_000,
      windowSizeBp: 40_000_000,
      viewportWidthPx: 1_200,
      viewportHeightPx: 600,
    })).toEqual({
      xStart: 80_000_000,
      xEnd: 160_000_000,
      yStart: 100_000_000,
      yEnd: 140_000_000,
    });
  });

  it("uses the exact heatmap X viewport for backend synteny requests", () => {
    const viewport = {
      xStart: 90_000_000,
      xEnd: 130_000_000,
      yStart: 10_000_000,
      yEnd: 70_000_000,
    };
    const request = buildSyntenyViewRequest({
      pafText: "ctgA\t1000\t100\t500\t+\tchr1\t2000\t700\t1100\t380\t400\t60",
      viewport,
      layoutBlocks: [
        {
          id: "block-1",
          objectId: "chr1",
          sourceId: "ctgA",
          sourceStart: 0,
          sourceEnd: 1000,
          visualStart: 10_000,
          visualEnd: 11_000,
          orientation: "+",
        },
      ],
    });

    expect(request.viewport).toBe(viewport);
    expect(request.layoutBlocks).toHaveLength(1);
    expect(request.pafRecords[0]).toMatchObject({
      queryName: "ctgA",
      queryLen: 1000,
      queryStart: 100,
      queryEnd: 500,
      targetName: "chr1",
      targetLen: 2000,
      mapq: 60,
    });
  });

  it("projects each copied assembly instance into its edited visual position", () => {
    const request = buildSyntenyViewRequest({
      pafText: "ctgA\t1000\t100\t500\t+\tchr1\t2000\t700\t1100\t380\t400\t60",
      viewport: { xStart: 0, xEnd: 2_000, yStart: 0, yEnd: 2_000 },
      layoutBlocks: [
        {
          id: "block-original",
          objectId: "chr1",
          sourceId: "ctgA",
          sourceStart: 0,
          sourceEnd: 1000,
          visualStart: 0,
          visualEnd: 1000,
          orientation: "+",
        },
        {
          id: "block-copy",
          objectId: "chr1",
          sourceId: "ctgA",
          sourceStart: 0,
          sourceEnd: 1000,
          visualStart: 1000,
          visualEnd: 2000,
          orientation: "-",
        },
      ],
    });

    const view = buildBrowserSyntenyView(request);

    expect(view.blocks.map((block) => [
      block.assemblyBlockId,
      block.visualStart,
      block.visualEnd,
      block.targetLength,
      block.strand,
    ])).toEqual([
      ["block-original", 100, 500, 2000, "+"],
      ["block-copy", 1500, 1900, 2000, "-"],
    ]);
  });
});
