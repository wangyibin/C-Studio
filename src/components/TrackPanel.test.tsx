// @ts-expect-error Vitest executes this CSS contract test in Node; the app tsconfig omits Node globals.
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CoverageView } from "../state/coverageView";
import { createInitialUiState } from "../state/uiState";
import {
  buildCoverageChromosomeBoundaries,
  buildCoverageSelectionRanges,
  buildCoverageTrackBars,
  coverageAutoScaleDomain,
  coverageBlockIdAtRatio,
  coverageContigIdsInRatioRange,
  coverageRatioWindowStyle,
  coverageReferenceDepth,
  coverageReferenceMultiples,
  coverageSelectionIsAdditive,
  coverageValueHeightRatio,
  normalizeCoverageMultiplier,
  TrackPanel,
} from "./TrackPanel";

const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

const coverageView: CoverageView = {
  resolution: 50,
  viewport: { xStart: 0, xEnd: 100, yStart: 0, yEnd: 1 },
  bins: [{ xBin: 0, value: 12 }, { xBin: 1, value: 30 }],
};

describe("TrackPanel", () => {
  it("keeps coverage visibility and settings controls side by side when collapsed", () => {
    expect(styles).toMatch(
      /\.coverage-controls\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0, 1fr\) 18px;/,
    );
    expect(styles).toMatch(
      /\.coverage-control-buttons\s*\{[^}]*display:\s*flex;[^}]*gap:\s*2px;/,
    );
    expect(styles).toMatch(
      /\.coverage-visibility-control\s*\{[^}]*position:\s*static;[^}]*width:\s*15px;/,
    );
    expect(styles).toMatch(
      /\.coverage-scale-control\s*\{[^}]*position:\s*relative;/,
    );
    expect(styles).toMatch(
      /@media \(max-width:\s*760px\)[\s\S]*\.coverage-axis-labels\s*\{[^}]*display:\s*none;/,
    );
  });

  it("removes coverage y-axis labels when the track is hidden", () => {
    const uiState = createInitialUiState("ready");
    uiState.tracks.coverageVisible = false;
    const markup = renderToStaticMarkup(
      <TrackPanel
        coverageView={coverageView}
        uiState={uiState}
        onUiAction={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="Show coverage track"');
    expect(markup).toContain('class="coverage-control-buttons"');
    expect(markup).not.toContain('class="coverage-axis-labels"');
  });

  it("maps real coverage bins to assembly contig instances", () => {
    const uiState = createInitialUiState("ready");
    uiState.assembly.blocks = [
      {
        id: "Chr01:1:ctgA",
        objectId: "Chr01",
        sourceId: "ctgA",
        sourceStart: 0,
        sourceEnd: 100,
        visualStart: 0,
        visualEnd: 100,
        orientation: "+",
      },
    ];

    expect(buildCoverageTrackBars(coverageView, uiState.assembly.blocks)).toEqual([
      {
        xBin: 0,
        value: 12,
        blockId: "Chr01:1:ctgA",
        leftRatio: 0,
        widthRatio: 0.5,
      },
      {
        xBin: 1,
        value: 30,
        blockId: "Chr01:1:ctgA",
        leftRatio: 0.5,
        widthRatio: 0.5,
      },
    ]);
  });

  it("renders a compact accessible track without visible labels or copy controls", () => {
    const uiState = createInitialUiState("ready");
    uiState.assembly.blocks = [
      {
        id: "Chr01:1:ctgA",
        objectId: "Chr01",
        sourceId: "ctgA",
        sourceStart: 0,
        sourceEnd: 100,
        visualStart: 0,
        visualEnd: 100,
        orientation: "+",
      },
    ];
    uiState.assembly.selection = { kind: "contigs", ids: ["Chr01:1:ctgA"] };

    const markup = renderToStaticMarkup(
      <TrackPanel
        coverageView={coverageView}
        uiState={uiState}
        onUiAction={() => undefined}
      />,
    );

    expect(markup).not.toContain("Coverage Distribution");
    expect(markup).not.toContain("Copy to target");
    expect(markup).not.toContain(">Hidden<");
    expect(markup).toContain('aria-label="Coverage track"');
    expect(markup).toContain('aria-label="Hide coverage track"');
    expect(markup).toContain('aria-label="Set coverage range"');
    expect(markup).toContain('aria-label="Coverage minimum"');
    expect(markup).toContain('aria-label="Coverage maximum"');
    expect(markup).toContain('aria-label="Coverage automatic multiplier"');
    expect(markup).toContain('data-scale-min="0"');
    expect(markup).toContain('data-scale-max="52.5"');
    expect(markup).toContain('data-auto-multiplier="2.5"');
    expect(markup).toContain('data-coverage-reference-depth="21"');
    expect(markup).toContain('class="coverage-reference-lines"');
    expect(markup).toContain('class="coverage-axis-labels"');
    expect(markup).toContain('class="coverage-axis-label coverage-axis-label-1x"');
    expect(markup).toContain('class="coverage-axis-label coverage-axis-label-2x"');
    expect(markup).toContain('data-coverage-multiple="1"');
    expect(markup).toContain('data-coverage-multiple="2"');
    expect(markup).not.toContain('<small>1×</small>');
    expect(markup).not.toContain('<small>2×</small>');
    expect(markup).toContain('Auto 2.5×');
    expect(markup).toContain('Shift-drag selects multiple contigs');
    expect(markup).toContain('aria-label="Select ctgA in coverage"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('data-block-id="Chr01:1:ctgA"');
  });

  it("clips partial edge bins to their exact viewport positions", () => {
    const partialView: CoverageView = {
      resolution: 50,
      viewport: { xStart: 25, xEnd: 125, yStart: 0, yEnd: 1 },
      bins: [
        { xBin: 0, value: 10 },
        { xBin: 1, value: 20 },
        { xBin: 2, value: 30 },
      ],
    };

    expect(buildCoverageTrackBars(partialView, [
      {
        id: "Chr01:1:ctgA",
        objectId: "Chr01",
        sourceId: "ctgA",
        sourceStart: 0,
        sourceEnd: 100,
        visualStart: 0,
        visualEnd: 100,
        orientation: "+",
      },
    ])).toEqual([
      expect.objectContaining({ xBin: 0, leftRatio: 0, widthRatio: 0.25 }),
      expect.objectContaining({ xBin: 1, leftRatio: 0.25, widthRatio: 0.5 }),
      expect.objectContaining({ xBin: 2, leftRatio: 0.75, widthRatio: 0.25 }),
    ]);
  });

  it("defaults to 2.5 times automatic headroom and accepts a custom multiplier", () => {
    const automatic = coverageAutoScaleDomain([12, 30]);

    expect(automatic).toEqual({ min: 0, max: 52.5 });
    expect(coverageValueHeightRatio(21, automatic)).toBeCloseTo(0.4);
    expect(coverageAutoScaleDomain([])).toEqual({ min: 0, max: 2.5 });
    expect(coverageAutoScaleDomain([12, 30], 2.5)).toEqual({ min: 0, max: 52.5 });
    expect(coverageAutoScaleDomain([12, 30], 1.25)).toEqual({ min: 0, max: 26.25 });
    expect(coverageAutoScaleDomain([12, 30], 0.5)).toEqual({ min: 0, max: 21 });
    expect(coverageAutoScaleDomain([12, 30], Number.NaN)).toEqual({ min: 0, max: 52.5 });
    expect(normalizeCoverageMultiplier(200)).toBe(100);
    expect(normalizeCoverageMultiplier(Number.NaN, 3)).toBe(3);
    expect(coverageValueHeightRatio(5, { min: 10, max: 20 })).toBe(0);
    expect(coverageValueHeightRatio(15, { min: 10, max: 20 })).toBe(0.5);
    expect(coverageValueHeightRatio(30, { min: 10, max: 20 })).toBe(1);
  });

  it("uses the current visible non-zero median for 1x", () => {
    expect(coverageReferenceDepth([0, 7, 8, 9, 30])).toBe(8.5);
    expect(coverageReferenceDepth([0, 8, 10, 30])).toBe(10);
    expect(coverageReferenceDepth([0, Number.NaN, Number.POSITIVE_INFINITY])).toBeNull();
  });

  it("adds 3x only for a sustained high-depth signal and ignores isolated spikes", () => {
    const normalDepth = Array.from({ length: 100 }, () => 10);
    expect(coverageReferenceMultiples([...normalDepth, 1_000])).toEqual([1, 2]);

    const threeCopyDepth = [
      ...Array.from({ length: 90 }, () => 10),
      ...Array.from({ length: 10 }, () => 32),
    ];
    expect(coverageReferenceMultiples(threeCopyDepth)).toEqual([1, 2, 3]);
    expect(coverageAutoScaleDomain(threeCopyDepth)).toEqual({ min: 0, max: 32.5 });
  });

  it("renders the adaptive 3x line only when the visible track sustains that depth", () => {
    const uiState = createInitialUiState("ready");
    uiState.assembly.blocks = [{
      id: "Chr01:1:ctgA",
      objectId: "Chr01",
      sourceId: "ctgA",
      sourceStart: 0,
      sourceEnd: 100,
      visualStart: 0,
      visualEnd: 100,
      orientation: "+",
    }];
    const values = [
      ...Array.from({ length: 90 }, () => 10),
      ...Array.from({ length: 10 }, () => 32),
    ];
    const markup = renderToStaticMarkup(
      <TrackPanel
        coverageView={{
          resolution: 1,
          viewport: { xStart: 0, xEnd: 100, yStart: 0, yEnd: 1 },
          bins: values.map((value, xBin) => ({ xBin, value })),
        }}
        uiState={uiState}
        onUiAction={() => undefined}
      />,
    );

    expect(markup).toContain('class="coverage-axis-label coverage-axis-label-3x"');
    expect(markup).toContain('class="coverage-reference-line coverage-reference-3x"');
    expect(markup).toContain('data-coverage-multiple="3"');
    expect(markup).not.toContain('data-coverage-multiple="4"');
  });

  it("projects only real chromosome boundaries into the coverage viewport", () => {
    const blocks = [
      {
        id: "A",
        objectId: "Chr01",
        sourceId: "ctgA",
        sourceStart: 0,
        sourceEnd: 40,
        visualStart: 0,
        visualEnd: 40,
        orientation: "+" as const,
      },
      {
        id: "B",
        objectId: "Chr01",
        sourceId: "ctgB",
        sourceStart: 0,
        sourceEnd: 60,
        visualStart: 40,
        visualEnd: 100,
        orientation: "+" as const,
      },
      {
        id: "C",
        objectId: "Chr02",
        sourceId: "ctgC",
        sourceStart: 0,
        sourceEnd: 80,
        visualStart: 100,
        visualEnd: 180,
        orientation: "+" as const,
      },
    ];

    expect(buildCoverageChromosomeBoundaries(
      { xStart: 25, xEnd: 150, yStart: 0, yEnd: 1 },
      blocks,
    )).toEqual([{ positionBp: 100, leftRatio: 0.6 }]);
    expect(buildCoverageChromosomeBoundaries(null, blocks)).toEqual([]);

    const uiState = createInitialUiState("ready");
    uiState.assembly.blocks = blocks;
    const markup = renderToStaticMarkup(
      <TrackPanel
        coverageView={{
          resolution: 25,
          viewport: { xStart: 25, xEnd: 150, yStart: 0, yEnd: 1 },
          bins: [],
        }}
        uiState={uiState}
        onUiAction={() => undefined}
      />,
    );
    expect(markup).toContain('class="coverage-chromosome-grid"');
    expect(markup).toContain('data-boundary-bp="100"');
    expect(markup).toContain('left:60%');
  });

  it("collapses dense unplaced-object boundaries and restores them after zoom", () => {
    const blocks = [
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

    expect(buildCoverageChromosomeBoundaries(
      { xStart: 0, xEnd: 1_000, yStart: 0, yEnd: 1 },
      blocks,
      100,
    ).map((boundary) => boundary.positionBp)).toEqual([400, 800, 820]);

    expect(buildCoverageChromosomeBoundaries(
      { xStart: 800, xEnd: 820, yStart: 0, yEnd: 1 },
      blocks,
      100,
    ).map((boundary) => boundary.positionBp)).toEqual([805, 810, 815]);
  });

  it("projects coverage against the live heatmap viewport when resize exposes empty field", () => {
    const uiState = createInitialUiState("ready");
    uiState.assembly.blocks = [
      {
        id: "A",
        objectId: "Chr01",
        sourceId: "ctgA",
        sourceStart: 0,
        sourceEnd: 100,
        visualStart: 0,
        visualEnd: 100,
        orientation: "+",
      },
      {
        id: "B",
        objectId: "Chr02",
        sourceId: "ctgB",
        sourceStart: 0,
        sourceEnd: 200,
        visualStart: 100,
        visualEnd: 300,
        orientation: "+",
      },
    ];

    const markup = renderToStaticMarkup(
      <TrackPanel
        coverageView={{
          resolution: 50,
          viewport: { xStart: 0, xEnd: 300, yStart: 0, yEnd: 1 },
          bins: [],
        }}
        viewport={{ xStart: 0, xEnd: 450, yStart: 0, yEnd: 300 }}
        uiState={uiState}
        onUiAction={() => undefined}
      />,
    );

    expect(markup).toContain('data-viewport-x-end="450"');
    expect(markup).toContain('data-boundary-bp="100"');
    expect(markup).toContain('left:22.22222222222222%');
  });

  it("projects every selected contig onto the exact coverage viewport", () => {
    const selectionBlocks = [
      {
        id: "A",
        objectId: "Chr01",
        sourceId: "ctgA",
        sourceStart: 0,
        sourceEnd: 50,
        visualStart: 0,
        visualEnd: 50,
        orientation: "+" as const,
      },
      {
        id: "B",
        objectId: "Chr01",
        sourceId: "ctgB",
        sourceStart: 0,
        sourceEnd: 50,
        visualStart: 50,
        visualEnd: 100,
        orientation: "+" as const,
      },
      {
        id: "C",
        objectId: "Chr02",
        sourceId: "ctgC",
        sourceStart: 0,
        sourceEnd: 50,
        visualStart: 100,
        visualEnd: 150,
        orientation: "+" as const,
      },
    ];

    expect(buildCoverageSelectionRanges(
      { xStart: 25, xEnd: 125, yStart: 0, yEnd: 1 },
      selectionBlocks,
      new Set(["A", "B"]),
    )).toEqual([
      { id: "A", leftRatio: 0, widthRatio: 0.25 },
      { id: "B", leftRatio: 0.25, widthRatio: 0.5 },
    ]);
    expect(coverageBlockIdAtRatio(
      { xStart: 0, xEnd: 150, yStart: 0, yEnd: 1 },
      selectionBlocks,
      0.1,
    )).toBe("A");
    expect(coverageBlockIdAtRatio(
      { xStart: 0, xEnd: 150, yStart: 0, yEnd: 1 },
      selectionBlocks,
      0.5,
    )).toBe("B");
    expect(coverageBlockIdAtRatio(
      { xStart: 0, xEnd: 150, yStart: 0, yEnd: 1 },
      selectionBlocks,
      1,
    )).toBe("C");
  });

  it("reserves Shift for drag selection and Command or Control for discrete toggles", () => {
    expect(coverageSelectionIsAdditive({ shiftKey: false, metaKey: false, ctrlKey: false })).toBe(false);
    expect(coverageSelectionIsAdditive({ shiftKey: true, metaKey: false, ctrlKey: false })).toBe(false);
    expect(coverageSelectionIsAdditive({ shiftKey: false, metaKey: true, ctrlKey: false })).toBe(true);
    expect(coverageSelectionIsAdditive({ shiftKey: false, metaKey: false, ctrlKey: true })).toBe(true);
  });

  it("selects every ordered contig covered by a Shift-drag window", () => {
    const blocks = Array.from({ length: 6 }, (_, index) => ({
      id: `contig-${index + 1}`,
      objectId: "Chr01",
      sourceId: `ctg${index + 1}`,
      sourceStart: 0,
      sourceEnd: 10,
      visualStart: index * 10,
      visualEnd: (index + 1) * 10,
      orientation: "+" as const,
    }));
    expect(coverageContigIdsInRatioRange(
      { xStart: 0, xEnd: 60, yStart: 0, yEnd: 1 },
      blocks,
      0,
      1,
    )).toEqual(blocks.map((block) => block.id));
  });

  it("selects every contig intersecting a Shift-drag window in either direction", () => {
    const blocks = Array.from({ length: 6 }, (_, index) => ({
      id: `contig-${index + 1}`,
      objectId: "Chr01",
      sourceId: `ctg${index + 1}`,
      sourceStart: 0,
      sourceEnd: 10,
      visualStart: index * 10,
      visualEnd: (index + 1) * 10,
      orientation: "+" as const,
    }));
    const viewport = { xStart: 0, xEnd: 60, yStart: 0, yEnd: 1 };

    expect(coverageContigIdsInRatioRange(viewport, blocks, 0.18, 0.82)).toEqual([
      "contig-2",
      "contig-3",
      "contig-4",
      "contig-5",
    ]);
    expect(coverageContigIdsInRatioRange(viewport, blocks, 0.82, 0.18)).toEqual([
      "contig-2",
      "contig-3",
      "contig-4",
      "contig-5",
    ]);
    expect(coverageRatioWindowStyle(0.8, 0.2)).toEqual({ left: "20%", width: "60%" });
  });

  it("expands a heatmap chromosome selection into all matching coverage ranges", () => {
    const uiState = createInitialUiState("ready");
    uiState.assembly.blocks = [
      {
        id: "A",
        objectId: "Chr01",
        sourceId: "ctgA",
        sourceStart: 0,
        sourceEnd: 50,
        visualStart: 0,
        visualEnd: 50,
        orientation: "+",
      },
      {
        id: "B",
        objectId: "Chr01",
        sourceId: "ctgB",
        sourceStart: 0,
        sourceEnd: 50,
        visualStart: 50,
        visualEnd: 100,
        orientation: "+",
      },
    ];
    uiState.assembly.selection = { kind: "chromosome", id: "Chr01" };

    const markup = renderToStaticMarkup(
      <TrackPanel coverageView={coverageView} uiState={uiState} onUiAction={() => undefined} />,
    );

    expect(markup).toContain('class="coverage-selection-layer"');
    expect(markup.match(/data-block-id="A"/g)).toHaveLength(2);
    expect(markup.match(/data-block-id="B"/g)).toHaveLength(2);
  });
});
