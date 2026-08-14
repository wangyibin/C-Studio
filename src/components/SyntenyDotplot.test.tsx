import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SyntenyView } from "../state/syntenyView";
import {
  buildAssemblyTrack,
  buildDotplotLayout,
  dominantSyntenyTargetByChromosome,
  syntenyBlockIdsInSelection,
  syntenyHorizontalWheelDelta,
  syntenyViewForAssemblyExtent,
  syntenyTargetLaneTopRatio,
  SyntenyDotplot,
} from "./SyntenyDotplot";

describe("syntenyHorizontalWheelDelta", () => {
  it("maps mouse-wheel vertical motion and trackpad horizontal motion onto assembly X", () => {
    expect(syntenyHorizontalWheelDelta(0, 24)).toBe(24);
    expect(syntenyHorizontalWheelDelta(-36, 4)).toBe(-36);
    expect(syntenyHorizontalWheelDelta(8, -20)).toBe(-20);
  });

  it("sanitizes invalid wheel samples", () => {
    expect(syntenyHorizontalWheelDelta(Number.NaN, 12)).toBe(12);
    expect(syntenyHorizontalWheelDelta(Number.NaN, Number.NaN)).toBe(0);
  });
});

const syntenyView: SyntenyView = {
  viewport: { xStart: 0, xEnd: 2_000, yStart: 0, yEnd: 2_000 },
  blocks: [
    {
      assemblyBlockId: "Chr01:1:ctgA_d2",
      querySourceId: "ctgA",
      visualStart: 1_000,
      visualEnd: 1_500,
      targetId: "target-1",
      targetLength: 2_000,
      targetStart: 500,
      targetEnd: 1_000,
      strand: "+",
      mapq: 60,
      alignmentCount: 1,
    },
  ],
};

describe("SyntenyDotplot", () => {
  it("renders assembly instances as keyboard-accessible selectable blocks", () => {
    const markup = renderToStaticMarkup(
      <SyntenyDotplot
        syntenyView={syntenyView}
        assemblyBlocks={[{
          id: "Chr01:1:ctgA_d2",
          objectId: "Chr01",
          sourceId: "ctgA",
          sourceStart: 0,
          sourceEnd: 500,
          visualStart: 1_000,
          visualEnd: 1_500,
          orientation: "+",
        }]}
        selectedAssemblyBlockIds={["Chr01:1:ctgA_d2"]}
        onSelectBlock={() => undefined}
      />,
    );

    expect(markup).toContain("<button");
    expect(markup).toContain('aria-label="Select Chr01:1:ctgA_d2 synteny block"');
    expect(markup).toContain('aria-label="Select ctgA in synteny"');
    expect(markup).toContain('data-block-id="Chr01:1:ctgA_d2"');
    expect(markup).toContain('data-target-id="target-1"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain("dotplot-segment  selected");
    expect(markup).toContain('class="synteny-plot-frame"');
    expect(markup).toContain('class="synteny-chromosome-band last-visible"');
    expect(markup).toContain('class="synteny-chromosome-hit"');
    expect(markup.match(/class="synteny-chromosome-hit"/g)).toHaveLength(1);
    expect(markup).toContain('data-target-id="top"');
    expect(markup).toMatch(
      /class="synteny-chromosome-band last-visible"[^>]*style="left:0%;width:100%"/,
    );
    expect(markup).not.toContain("synteny-contig-segment dense");
    expect(markup).toContain("Assembly");
  });

  it("renders the inspector variant as a non-editable pan-and-expand preview", () => {
    const markup = renderToStaticMarkup(
      <SyntenyDotplot
        syntenyView={syntenyView}
        interactionMode="preview"
        onDoubleClick={() => undefined}
      />,
    );

    expect(markup).toContain("synteny-preview-only");
    expect(markup).toContain("double-click to open the interactive synteny view");
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain('tabindex="-1"');
    expect(markup).not.toContain("synteny-chromosome-hit");
  });

  it("keeps positive and reverse alignments anchored to opposite reference directions", () => {
    const positive = buildDotplotLayout(syntenyView).blocks[0];
    const reverse = buildDotplotLayout({
      ...syntenyView,
      blocks: [{ ...syntenyView.blocks[0], strand: "-" }],
    }).blocks[0];

    expect(positive?.left).toBe(53);
    expect(positive?.angle).toBeGreaterThan(0);
    expect(reverse?.left).toBe(53);
    expect(reverse?.angle).toBeLessThan(0);
    expect(reverse?.top).toBeGreaterThan(positive?.top ?? 0);
  });

  it("keeps segment endpoints aligned on a non-square canvas", () => {
    const canvasAspectRatio = 2;
    const block = buildDotplotLayout(syntenyView, canvasAspectRatio).blocks[0];
    expect(block).toBeDefined();

    const angleRadians = ((block?.angle ?? 0) * Math.PI) / 180;
    const renderedDeltaXPercent = (block?.width ?? 0) * Math.cos(angleRadians);
    const renderedDeltaYPercent = canvasAspectRatio
      * (block?.width ?? 0)
      * Math.sin(angleRadians);

    expect(block?.left).toBe(53);
    expect(renderedDeltaXPercent).toBeCloseTo(22, 8);
    expect(renderedDeltaYPercent).toBeCloseTo(21.5, 8);
  });

  it("separates reference chromosomes into stable target lanes", () => {
    const layout = buildDotplotLayout({
      ...syntenyView,
      blocks: [
        syntenyView.blocks[0],
        {
          ...syntenyView.blocks[0],
          assemblyBlockId: "Chr01:2:ctgB",
          querySourceId: "ctgB",
          targetId: "target-2",
          targetLength: 4_000,
          targetStart: 500,
          targetEnd: 1_000,
        },
      ],
    });

    expect(layout.targetLanes.map((lane) => [lane.id, lane.targetLength])).toEqual([
      ["target-1", 2_000],
      ["target-2", 4_000],
    ]);
    expect(layout.targetLanes[0]?.top).toBeLessThan(layout.targetLanes[1]?.top ?? 0);
    expect(layout.targetLanes[1]?.height).toBeGreaterThan(layout.targetLanes[0]?.height ?? 0);
    expect(layout.blocks[0]?.top).toBeLessThan(layout.blocks[1]?.top ?? 0);
  });

  it("deduplicates the synteny blocks intersected by a Shift-drag rectangle", () => {
    expect(syntenyBlockIdsInSelection([
      { id: "contig-1", left: 10, right: 30, top: 10, bottom: 20 },
      { id: "contig-1", left: 20, right: 40, top: 18, bottom: 24 },
      { id: "contig-2", left: 70, right: 90, top: 50, bottom: 60 },
    ], { x: 45, y: 30 }, { x: 15, y: 5 })).toEqual(["contig-1"]);
  });

  it("maps each reference lane top into its chromosome-cell selection strip", () => {
    expect(syntenyTargetLaneTopRatio(7)).toBe(0);
    expect(syntenyTargetLaneTopRatio(50)).toBe(0.5);
    expect(syntenyTargetLaneTopRatio(93)).toBe(1);
  });

  it("keeps only the strongest reference lane for each assembly chromosome", () => {
    const assemblyBlocks = [
      {
        id: "Chr01:1:ctgA_d2",
        objectId: "Chr01",
        sourceId: "ctgA",
        sourceStart: 0,
        sourceEnd: 500,
        visualStart: 1_000,
        visualEnd: 1_500,
        orientation: "+" as const,
      },
      {
        id: "Chr01:2:ctgB",
        objectId: "Chr01",
        sourceId: "ctgB",
        sourceStart: 0,
        sourceEnd: 800,
        visualStart: 0,
        visualEnd: 800,
        orientation: "+" as const,
      },
    ];
    const dominant = dominantSyntenyTargetByChromosome({
      ...syntenyView,
      blocks: [
        { ...syntenyView.blocks[0], visualStart: 1_000, visualEnd: 1_200 },
        {
          ...syntenyView.blocks[0],
          assemblyBlockId: "Chr01:2:ctgB",
          querySourceId: "ctgB",
          visualStart: 0,
          visualEnd: 800,
          targetId: "target-2",
        },
      ],
    }, assemblyBlocks);

    expect([...dominant.entries()]).toEqual([["Chr01", "target-2"]]);
  });

  it("removes empty assembly space beyond the last visible chromosome", () => {
    const displayView = syntenyViewForAssemblyExtent(syntenyView, [{
      id: "Chr01:1:ctgA_d2",
      objectId: "Chr01",
      sourceId: "ctgA",
      sourceStart: 0,
      sourceEnd: 500,
      visualStart: 1_000,
      visualEnd: 1_500,
      orientation: "+",
    }]);

    expect(displayView?.viewport).toEqual({
      ...syntenyView.viewport,
      xStart: 1_000,
      xEnd: 1_500,
    });
  });

  it("orders assembly chromosomes from left to right", () => {
    const track = buildAssemblyTrack(syntenyView, [
      {
        id: "Chr02:1:ctgB",
        objectId: "Chr02",
        sourceId: "ctgB",
        sourceStart: 0,
        sourceEnd: 500,
        visualStart: 1_500,
        visualEnd: 2_000,
        orientation: "+",
      },
      {
        id: "Chr01:1:ctgA",
        objectId: "Chr01",
        sourceId: "ctgA",
        sourceStart: 0,
        sourceEnd: 500,
        visualStart: 0,
        visualEnd: 500,
        orientation: "+",
      },
    ]);

    expect(track.chromosomes.map((chromosome) => chromosome.id)).toEqual(["Chr01", "Chr02"]);
    expect(track.chromosomes[0]?.left).toBeLessThan(track.chromosomes[1]?.left ?? 0);
  });

  it("uses compact visual bands without removing chromosome hit segments", () => {
    const assemblyBlocks = [
      ["Chr01", 0, 400],
      ["Chr02", 400, 800],
      ["unplaced-1", 800, 805],
      ["unplaced-2", 805, 810],
      ["unplaced-3", 810, 815],
      ["unplaced-4", 815, 820],
    ].map(([id, visualStart, visualEnd]) => ({
      id: String(id),
      objectId: String(id),
      sourceId: String(id),
      sourceStart: 0,
      sourceEnd: Number(visualEnd) - Number(visualStart),
      visualStart: Number(visualStart),
      visualEnd: Number(visualEnd),
      orientation: "+" as const,
    }));
    const overviewTrack = buildAssemblyTrack({
      viewport: { xStart: 0, xEnd: 1_000, yStart: 0, yEnd: 1 },
      blocks: [],
    }, assemblyBlocks, 100);

    expect(overviewTrack.chromosomes).toHaveLength(6);
    expect(overviewTrack.chromosomeBands.map((band) => band.objectIds)).toEqual([
      ["Chr01"],
      ["Chr02"],
      ["unplaced-1", "unplaced-2", "unplaced-3", "unplaced-4"],
    ]);

    const zoomedTrack = buildAssemblyTrack({
      viewport: { xStart: 800, xEnd: 820, yStart: 0, yEnd: 1 },
      blocks: [],
    }, assemblyBlocks, 100);
    expect(zoomedTrack.chromosomeBands.map((band) => band.objectIds)).toEqual([
      ["unplaced-1"],
      ["unplaced-2"],
      ["unplaced-3"],
      ["unplaced-4"],
    ]);
  });

});
