import { describe, expect, it } from "vitest";
import { buildBrowserSyntenyView, buildSyntenyViewRequest } from "./syntenyView";

describe("buildSyntenyViewRequest", () => {
  it("builds backend synteny requests from PAF text and the current overview viewport", () => {
    const request = buildSyntenyViewRequest({
      pafText: "ctgA\t1000\t100\t500\t+\tchr1\t2000\t700\t1100\t380\t400\t60",
      centerMb: 150,
      totalSpanBp: 300_000_000,
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

    expect(request.viewport).toEqual({
      xStart: 50_000_000,
      xEnd: 250_000_000,
      yStart: 50_000_000,
      yEnd: 250_000_000,
    });
    expect(request.layoutBlocks).toHaveLength(1);
    expect(request.pafRecords[0]).toMatchObject({
      queryName: "ctgA",
      queryLen: 1000,
      queryStart: 100,
      queryEnd: 500,
      targetName: "chr1",
      mapq: 60,
    });
  });

  it("projects each copied assembly instance into its edited visual position", () => {
    const request = buildSyntenyViewRequest({
      pafText: "ctgA\t1000\t100\t500\t+\tchr1\t2000\t700\t1100\t380\t400\t60",
      centerMb: 0.001,
      totalSpanBp: 2_000,
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
      block.strand,
    ])).toEqual([
      ["block-original", 100, 500, "+"],
      ["block-copy", 1500, 1900, "-"],
    ]);
  });
});
