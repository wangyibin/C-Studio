import { describe, expect, it } from "vitest";
import { buildPafSyntenyPreview } from "./pafPreview";
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
      pafRecords: buildPafSyntenyPreview(
        "ctgA\t20000\t1000\t13000\t+\tchr1\t30000\t7000\t19000\t11400\t12000\t60",
      ).records,
      viewport,
      layoutBlocks: [
        {
          id: "block-1",
          objectId: "chr1",
          sourceId: "ctgA",
          sourceStart: 0,
          sourceEnd: 20_000,
          visualStart: 10_000,
          visualEnd: 30_000,
          orientation: "+",
        },
      ],
    });

    expect(request.viewport).toBe(viewport);
    expect(request.layoutBlocks).toHaveLength(1);
    expect(request.minAlignmentLen).toBe(10_000);
    expect(request.pafRecords[0]).toMatchObject({
      queryName: "ctgA",
      queryLen: 20_000,
      queryStart: 1_000,
      queryEnd: 13_000,
      targetName: "chr1",
      targetLen: 30_000,
      mapq: 60,
    });
  });

  it("projects each copied assembly instance into its edited visual position", () => {
    const request = buildSyntenyViewRequest({
      pafRecords: buildPafSyntenyPreview(
        "ctgA\t20000\t1000\t15000\t+\tchr1\t40000\t7000\t21000\t13000\t14000\t60",
      ).records,
      viewport: { xStart: 0, xEnd: 40_000, yStart: 0, yEnd: 40_000 },
      layoutBlocks: [
        {
          id: "block-original",
          objectId: "chr1",
          sourceId: "ctgA",
          sourceStart: 0,
          sourceEnd: 20_000,
          visualStart: 0,
          visualEnd: 20_000,
          orientation: "+",
        },
        {
          id: "block-copy",
          objectId: "chr1",
          sourceId: "ctgA",
          sourceStart: 0,
          sourceEnd: 20_000,
          visualStart: 20_000,
          visualEnd: 40_000,
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
      ["block-original", 1000, 15_000, 40_000, "+"],
      ["block-copy", 25_000, 39_000, 40_000, "-"],
    ]);
  });

  it("renders retained split-chain fragments instead of one bounding-box line", () => {
    const request = buildSyntenyViewRequest({
      pafRecords: buildPafSyntenyPreview([
        "ctgA\t100000\t0\t8000\t+\tchr1\t200000\t10000\t18000\t7600\t8000\t60",
        "ctgA\t100000\t20000\t28000\t+\tchr1\t200000\t50000\t58000\t7200\t8000\t50",
      ].join("\n")).records,
      viewport: { xStart: 0, xEnd: 100_000, yStart: 0, yEnd: 100_000 },
      layoutBlocks: [{
        id: "block-1",
        objectId: "chr1",
        sourceId: "ctgA",
        sourceStart: 0,
        sourceEnd: 100_000,
        visualStart: 0,
        visualEnd: 100_000,
        orientation: "+",
      }],
    });

    expect(buildBrowserSyntenyView(request).blocks.map((block) => [
      block.visualStart,
      block.visualEnd,
      block.targetStart,
      block.targetEnd,
    ])).toEqual([
      [0, 8_000, 10_000, 18_000],
      [20_000, 28_000, 50_000, 58_000],
    ]);
  });
});
