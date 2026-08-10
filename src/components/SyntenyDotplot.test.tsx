import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SyntenyView } from "../state/syntenyView";
import { buildDotplotLayout, SyntenyDotplot } from "./SyntenyDotplot";

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
    expect(markup).toContain("Heatmap X · assembly");
  });

  it("keeps positive and reverse alignments anchored to opposite reference directions", () => {
    const positive = buildDotplotLayout(syntenyView).blocks[0];
    const reverse = buildDotplotLayout({
      ...syntenyView,
      blocks: [{ ...syntenyView.blocks[0], strand: "-" }],
    }).blocks[0];

    expect(positive?.left).toBe(50);
    expect(positive?.angle).toBeGreaterThan(0);
    expect(reverse?.left).toBe(50);
    expect(reverse?.angle).toBeLessThan(0);
    expect(reverse?.top).toBeGreaterThan(positive?.top ?? 0);
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
    expect(layout.blocks[0]?.top).toBeLessThan(layout.blocks[1]?.top ?? 0);
  });
});
