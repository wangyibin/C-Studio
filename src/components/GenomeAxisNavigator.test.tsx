import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  buildGenomeSegments,
  calculateViewportWindow,
  centerRatioForKey,
  clamp,
  GenomeAxisNavigator,
  genomeSegmentAtRatio,
} from "./GenomeAxisNavigator";

describe("GenomeAxisNavigator helpers", () => {
  it("clamps values and resolves non-finite input to the lower bound", () => {
    expect(clamp(-4, 0, 10)).toBe(0);
    expect(clamp(7, 0, 10)).toBe(7);
    expect(clamp(14, 0, 10)).toBe(10);
    expect(clamp(Number.NaN, 0, 10)).toBe(0);
    expect(clamp(5, 10, 0)).toBe(5);
  });

  it("keeps the viewport window inside the genome at both edges", () => {
    expect(calculateViewportWindow(100, 20, 5)).toEqual({
      startMb: 0,
      endMb: 20,
      centerMb: 10,
      startRatio: 0,
      endRatio: 0.2,
      centerRatio: 0.1,
      spanRatio: 0.2,
    });
    expect(calculateViewportWindow(100, 20, 95)).toEqual({
      startMb: 80,
      endMb: 100,
      centerMb: 90,
      startRatio: 0.8,
      endRatio: 1,
      centerRatio: 0.9,
      spanRatio: 0.2,
    });
  });

  it("turns an oversized viewport into one full-genome window", () => {
    expect(calculateViewportWindow(80, 200, 12)).toEqual({
      startMb: 0,
      endMb: 80,
      centerMb: 40,
      startRatio: 0,
      endRatio: 1,
      centerRatio: 0.5,
      spanRatio: 1,
    });
    expect(calculateViewportWindow(0, 20, 10).spanRatio).toBe(0);
  });

  it("sorts, clips, and aggregates adjacent assembly blocks into genome segments", () => {
    const segments = buildGenomeSegments([
      { id: "b3", objectId: "Chr02", visualStart: 60_000_000, visualEnd: 110_000_000 },
      { id: "b1", objectId: "Chr01", visualStart: -1_000_000, visualEnd: 20_000_000 },
      { id: "invalid", objectId: "Chr01", visualStart: 50, visualEnd: 50 },
      { id: "b2", objectId: "Chr01", visualStart: 22_000_000, visualEnd: 60_000_000 },
    ], 100);

    expect(segments).toEqual([
      {
        id: "Chr01:0",
        objectId: "Chr01",
        startMb: 0,
        endMb: 60,
        startRatio: 0,
        endRatio: 0.6,
        spanRatio: 0.6,
        blockCount: 2,
      },
      {
        id: "Chr02:1",
        objectId: "Chr02",
        startMb: 60,
        endMb: 100,
        startRatio: 0.6,
        endRatio: 1,
        spanRatio: 0.4,
        blockCount: 1,
      },
    ]);
  });

  it("keeps repeated non-adjacent chromosome runs as distinct segments", () => {
    const segments = buildGenomeSegments([
      { id: "a", objectId: "Chr01", visualStart: 0, visualEnd: 20_000_000 },
      { id: "b", objectId: "Chr02", visualStart: 20_000_000, visualEnd: 40_000_000 },
      { id: "c", objectId: "Chr01", visualStart: 40_000_000, visualEnd: 60_000_000 },
    ], 60);

    expect(segments.map((segment) => [segment.id, segment.objectId])).toEqual([
      ["Chr01:0", "Chr01"],
      ["Chr02:1", "Chr02"],
      ["Chr01:2", "Chr01"],
    ]);
  });

  it("resolves the hovered chromosome segment on either genome axis", () => {
    const segments = buildGenomeSegments([
      { id: "a", objectId: "Chr01", visualStart: 0, visualEnd: 60_000_000 },
      { id: "b", objectId: "Chr02", visualStart: 60_000_000, visualEnd: 100_000_000 },
    ], 100);

    expect(genomeSegmentAtRatio(segments, 0.25)?.objectId).toBe("Chr01");
    expect(genomeSegmentAtRatio(segments, 0.75)?.objectId).toBe("Chr02");
    expect(genomeSegmentAtRatio(segments, 1)?.objectId).toBe("Chr02");
    expect(genomeSegmentAtRatio([], 0.5)).toBeNull();
  });

  it("maps keyboard navigation to clamped center ratios", () => {
    expect(centerRatioForKey("Home", 0.5, 0.2)).toBe(0.1);
    expect(centerRatioForKey("End", 0.5, 0.2)).toBe(0.9);
    expect(centerRatioForKey("ArrowRight", 0.5, 0.2)).toBeCloseTo(0.52);
    expect(centerRatioForKey("PageUp", 0.5, 0.2)).toBeCloseTo(0.32);
    expect(centerRatioForKey("Enter", 0.5, 0.2)).toBeNull();
  });

});

describe("GenomeAxisNavigator", () => {
  const assemblyBlocks = [
    { id: "b1", objectId: "Chr01", visualStart: 0, visualEnd: 60_000_000 },
    { id: "b2", objectId: "Chr02", visualStart: 60_000_000, visualEnd: 100_000_000 },
  ];

  it("renders an X chromosome band whose names are only exposed as hover titles", () => {
    const markup = renderToStaticMarkup(
      <GenomeAxisNavigator
        axis="x"
        totalSpanMb={100}
        viewportSpanMb={20}
        centerMb={50}
        assemblyBlocks={assemblyBlocks}
        onCommit={() => undefined}
      />,
    );

    expect(markup).toContain('class="genome-axis-navigator axis-x"');
    expect(markup).toContain('aria-orientation="horizontal"');
    expect(markup).toContain('class="genome-axis-segments genome-axis-chromosome-track"');
    expect(markup).toContain('class="genome-axis-segment segment-tone-0" style="fill:#94a3b8" data-object-id="Chr01" x="0" y="2" width="60"');
    expect(markup).toContain('class="genome-axis-segment segment-tone-1" style="fill:#94a3b8" data-object-id="Chr02" x="60" y="2" width="40"');
    expect(markup).toContain('class="genome-axis-window" x="40" y="2" width="20" height="16"');
    expect(markup).toContain('<title>Chr01: 0–60 Mb</title>');
    expect(markup).toContain('<title>Chr02: 60–100 Mb</title>');
    expect(markup).not.toContain('class="genome-axis-object-labels"');
    expect(markup).not.toContain('>Chr01</span>');
    expect(markup).not.toContain('>Chr02</span>');
  });

  it("renders a vertical ARIA slider with proportional chromosome segments, window, and handles", () => {
    const markup = renderToStaticMarkup(
      <GenomeAxisNavigator
        axis="y"
        totalSpanMb={100}
        viewportSpanMb={20}
        centerMb={50}
        assemblyBlocks={assemblyBlocks}
        onCommit={() => undefined}
      />,
    );

    expect(markup).toContain('class="genome-axis-navigator axis-y"');
    expect(markup).toContain('role="slider"');
    expect(markup).toContain('aria-orientation="vertical"');
    expect(markup).toContain('aria-valuemin="10"');
    expect(markup).toContain('aria-valuemax="90"');
    expect(markup).toContain('aria-valuenow="50"');
    expect(markup).toContain('class="genome-axis-segments genome-axis-chromosome-track"');
    expect(markup).toContain('class="genome-axis-segment segment-tone-0" style="fill:#94a3b8" data-object-id="Chr01" x="2" y="0" width="16" height="60"');
    expect(markup).toContain('class="genome-axis-segment segment-tone-1" style="fill:#94a3b8" data-object-id="Chr02" x="2" y="60" width="16" height="40"');
    expect(markup).toContain('class="genome-axis-window" x="2" y="40" width="16" height="20"');
    expect(markup).toContain('class="genome-axis-handle handle-start"');
    expect(markup).toContain('class="genome-axis-handle handle-end"');
  });
});
