import { describe, expect, it } from "vitest";
import { buildBrowserCoverageView, buildCoverageViewRequest, parseBedGraphText } from "./coverageView";
import type { ContactMapLayoutBlock } from "./importers";

const blocks: ContactMapLayoutBlock[] = [
  {
    id: "original",
    objectId: "Chr01",
    sourceId: "ctgA",
    sourceStart: 0,
    sourceEnd: 100,
    visualStart: 0,
    visualEnd: 100,
    orientation: "+",
  },
  {
    id: "copy",
    objectId: "Chr02",
    sourceId: "ctgA",
    sourceStart: 0,
    sourceEnd: 100,
    visualStart: 100,
    visualEnd: 200,
    orientation: "-",
  },
];

describe("coverageView", () => {
  it("parses bedGraph records and ignores metadata lines", () => {
    expect(parseBedGraphText("track type=bedGraph\n# comment\nctgA\t0\t50\t12.5")).toEqual([
      { chrom: "ctgA", start: 0, end: 50, value: 12.5 },
    ]);
  });

  it("reuses source coverage for copied and reversed assembly instances", () => {
    const request = buildCoverageViewRequest(
      [{ chrom: "ctgA", start: 0, end: 50, value: 20 }],
      blocks,
      200,
    );
    request.displayResolution = 50;

    expect(buildBrowserCoverageView(request).bins).toEqual([
      { xBin: 0, value: 20 },
      { xBin: 3, value: 20 },
    ]);
  });

  it("uses the heatmap X viewport and display resolution for coverage", () => {
    const request = buildCoverageViewRequest([], blocks, 200, {
      displayResolution: 25,
      viewport: { xStart: 45, xEnd: 155, yStart: 20, yEnd: 120 },
    });

    expect(request.displayResolution).toBe(25);
    expect(request.viewport).toEqual({ xStart: 45, xEnd: 155, yStart: 0, yEnd: 1 });
  });

  it("clamps a requested coverage viewport to the current assembly", () => {
    const request = buildCoverageViewRequest([], blocks, 200, {
      displayResolution: 10,
      viewport: { xStart: 180, xEnd: 260, yStart: 0, yEnd: 1 },
    });

    expect(request.viewport).toEqual({ xStart: 180, xEnd: 200, yStart: 0, yEnd: 1 });
  });
});
