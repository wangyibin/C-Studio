import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SyntenyView } from "../state/syntenyView";
import {
  buildAssemblyTrack,
  buildDotplotLayout,
  dominantSyntenyTargetByChromosome,
  syntenyBlockIdsInSelection,
  syntenyViewForAssemblyExtent,
  syntenyTargetLaneTopRatio,
  SyntenyDotplot,
} from "./SyntenyDotplot";

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
    expect(positive?.angle).toBeLessThan(0);
    expect(reverse?.left).toBe(53);
    expect(reverse?.angle).toBeGreaterThan(0);
    expect(reverse?.top).toBeLessThan(positive?.top ?? 0);
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
    expect(layout.targetLanes[0]?.top).toBeGreaterThan(layout.targetLanes[1]?.top ?? 0);
    expect(layout.targetLanes[1]?.height).toBeGreaterThan(layout.targetLanes[0]?.height ?? 0);
    expect(layout.blocks[0]?.top).toBeGreaterThan(layout.blocks[1]?.top ?? 0);
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

});
