import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SyntenyView } from "../state/syntenyView";
import { SyntenyDotplot } from "./SyntenyDotplot";

const syntenyView: SyntenyView = {
  viewport: { xStart: 0, xEnd: 2_000, yStart: 0, yEnd: 2_000 },
  blocks: [
    {
      assemblyBlockId: "Chr01:1:ctgA_d2",
      querySourceId: "ctgA",
      visualStart: 1_000,
      visualEnd: 1_500,
      targetId: "target-1",
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
        selectedAssemblyBlockIds={["Chr01:1:ctgA_d2"]}
        onSelectBlock={() => undefined}
      />,
    );

    expect(markup).toContain("<button");
    expect(markup).toContain('aria-label="Select Chr01:1:ctgA_d2 synteny block"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain("dotplot-segment  selected");
  });
});
