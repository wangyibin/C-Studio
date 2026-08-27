import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createInitialUiState } from "../state/uiState";
import { contactColorCss } from "../state/contactColor";
import type { AppStatus, ContactMapView, ExampleDatasetSummary } from "../App";
import {
  contactOverviewMapForDisplayedNormalization,
  contactOverviewWindowViewport,
  drawOverviewHeatmap,
  InspectorPanel,
} from "./InspectorPanel";

const status: AppStatus = {
  version: "test",
  engine: "test",
  coordinate_convention: "test",
  supported_operations: ["split"],
};

const dataset: ExampleDatasetSummary = {
  agp_path: "assembly.agp",
  mcool_path: "map.mcool",
  paf_path: null,
  agp_lines: 1,
  agp_objects: 1,
  agp_components: 1,
  agp_gaps: 0,
  max_object_span: 100,
  mcool_size_bytes: 1000,
  coverage_path: null,
  agp_layout: { blocks: [], totalSpan: 1000 },
  cool_path: "map.cool",
};

const contactMap: ContactMapView = {
  resolution: 1000,
  viewport: { xStart: 0, xEnd: 1000, yStart: 0, yEnd: 1000 },
  cells: [{ xBin: 0, yBin: 0, count: 12 }],
};

describe("InspectorPanel", () => {
  it("draws the overview with the active main-heatmap colormap", () => {
    const uiState = createInitialUiState("ready");
    uiState.contact.colormap = "Rose";
    const context = {
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      fillStyle: "",
    };
    const canvas = {
      width: 100,
      height: 100,
      getContext: vi.fn(() => context),
    } as unknown as HTMLCanvasElement;

    drawOverviewHeatmap(canvas, contactMap, uiState, 1_000);

    expect(context.fillStyle).toBe(contactColorCss("Rose", 1));
    expect(context.fillRect).toHaveBeenCalledTimes(2);
  });

  it("does not show an overview from a different normalization", () => {
    const rawMap = { ...contactMap, normalization: "raw" as const };
    const iceOverview = {
      ...contactMap,
      normalization: "ice" as const,
      cells: [{ xBin: 0, yBin: 0, count: 24 }],
    };

    expect(
      contactOverviewMapForDisplayedNormalization(rawMap, iceOverview),
    ).toBeNull();
    expect(
      contactOverviewMapForDisplayedNormalization(
        { ...rawMap, normalization: "ice" },
        iceOverview,
      ),
    ).toBe(iceOverview);
  });

  it("never stretches the local viewport map into the whole-genome overview", () => {
    const rawMap = { ...contactMap, normalization: "raw" as const };

    expect(
      contactOverviewMapForDisplayedNormalization(rawMap, null),
    ).toBeNull();
  });

  it("retains the last complete overview while a new layout is loading", () => {
    const currentLayoutMap = {
      ...contactMap,
      normalization: "raw" as const,
      layoutScope: "layout-b-visible",
    };
    const lastCompleteOverview = {
      ...contactMap,
      normalization: "raw" as const,
      layoutScope: "layout-a-overview",
      viewport: { xStart: 0, xEnd: 5_000_000, yStart: 0, yEnd: 5_000_000 },
    };

    expect(
      contactOverviewMapForDisplayedNormalization(
        currentLayoutMap,
        lastCompleteOverview,
      ),
    ).toBe(lastCompleteOverview);
  });

  it("keeps the overview window on the main heatmap's presented camera", () => {
    const uiState = createInitialUiState("ready");
    uiState.contact.viewportCenterXMb = 700;
    uiState.contact.viewportCenterYMb = 650;
    uiState.contact.viewportSpanMb = 100;
    const presentedViewport = {
      xStart: 100_000_000,
      xEnd: 500_000_000,
      yStart: 200_000_000,
      yEnd: 400_000_000,
    };

    expect(contactOverviewWindowViewport(
      presentedViewport,
      1_000_000_000,
      uiState,
    )).toBe(presentedViewport);
    expect(contactOverviewWindowViewport(
      null,
      1_000_000_000,
      uiState,
    )).not.toEqual(presentedViewport);
  });

  it("binds the overview to the active contact map", () => {
    const uiState = createInitialUiState("ready");

    const markup = renderToStaticMarkup(
      <InspectorPanel
        dataset={dataset}
        contactMap={contactMap}
        overviewContactMap={contactMap}
        status={status}
        statusMessage="ready"
        uiState={uiState}
        onUiAction={() => undefined}
        syntenyView={null}
        assemblyBlocks={uiState.assembly.blocks}
        selectedAssemblyBlockIds={[]}
        pafText=""
        onPafTextChange={() => undefined}
        onExpandHeatmap={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="Contact map overview"');
    expect(markup).toContain('class="overview-heatmap-canvas"');
    expect(markup).toContain('class="overview-expand-button"');
    expect(markup).toContain('aria-label="Expand heatmap window"');
    expect(markup).toContain(
      'title="Click to preview; double-click to expand the heatmap"',
    );
    expect(markup).toContain("Overview");
  });

  it("keeps stale overview pixels and their span in one atomic snapshot", () => {
    const uiState = createInitialUiState("ready");
    const rawMap = { ...contactMap, normalization: "raw" as const };
    const lastCompleteOverview = {
      ...rawMap,
      viewport: { xStart: 0, xEnd: 5_000_000, yStart: 0, yEnd: 5_000_000 },
    };
    const editedBlocks = [{
      id: "edited",
      objectId: "Chr01",
      sourceId: "ctg1",
      sourceStart: 0,
      sourceEnd: 3_000_000,
      visualStart: 0,
      visualEnd: 3_000_000,
      orientation: "+" as const,
    }];

    const markup = renderToStaticMarkup(
      <InspectorPanel
        dataset={dataset}
        contactMap={rawMap}
        overviewContactMap={lastCompleteOverview}
        status={status}
        statusMessage="ready"
        uiState={uiState}
        onUiAction={() => undefined}
        syntenyView={null}
        assemblyBlocks={editedBlocks}
        selectedAssemblyBlockIds={[]}
        pafText=""
        onPafTextChange={() => undefined}
      />,
    );

    expect(markup).toContain('<span class="overview-end">5 Mb</span>');
  });

  it("matches the overview window to the main viewport aspect ratio", () => {
    const uiState = createInitialUiState("ready");
    uiState.contact.viewportSpanMb = 100;
    uiState.contact.viewportCenterMb = 50;
    uiState.contact.viewportCenterXMb = 50;
    uiState.contact.viewportCenterYMb = 50;
    uiState.contact.viewportWidthPx = 1_000;
    uiState.contact.viewportHeightPx = 500;
    const wholeGenomeOverview = {
      ...contactMap,
      viewport: {
        xStart: 0,
        xEnd: 1_000_000_000,
        yStart: 0,
        yEnd: 1_000_000_000,
      },
    };

    const markup = renderToStaticMarkup(
      <InspectorPanel
        dataset={dataset}
        contactMap={wholeGenomeOverview}
        overviewContactMap={wholeGenomeOverview}
        status={status}
        statusMessage="ready"
        uiState={uiState}
        onUiAction={() => undefined}
        syntenyView={null}
        assemblyBlocks={[]}
        selectedAssemblyBlockIds={[]}
        pafText=""
        onPafTextChange={() => undefined}
      />,
    );

    expect(markup).toContain(
      'class="overview-window" style="left:0%;top:0%;width:20%;height:10%"',
    );
  });

  it("marks the synteny preview to fill the inspector overview area", () => {
    const uiState = createInitialUiState("ready");
    uiState.activeOverviewMode = "synteny";

    const markup = renderToStaticMarkup(
      <InspectorPanel
        dataset={dataset}
        contactMap={contactMap}
        overviewContactMap={contactMap}
        status={status}
        statusMessage="ready"
        uiState={uiState}
        onUiAction={() => undefined}
        syntenyView={null}
        assemblyBlocks={uiState.assembly.blocks}
        selectedAssemblyBlockIds={[]}
        pafText=""
        onPafTextChange={() => undefined}
      />,
    );

    expect(markup).toContain("inspector-overview synteny-overview-active");
    expect(markup).toContain("synteny-panel");
    expect(markup).not.toContain('class="synteny-preview-header"');
    expect(markup).not.toContain('class="synteny-preview-title"');
    expect(markup).toContain('class="synteny-preview-expand-button"');
    expect(markup).toContain('aria-label="Open interactive synteny view"');
    expect(markup).toContain(
      'title="Click to preview; double-click to open the interactive synteny view"',
    );
    expect(markup).not.toContain("Drag to pan the shared heatmap region");
  });

  it("renders GFA as the third overview tab and uses the shared preview area", () => {
    const uiState = createInitialUiState("ready");
    uiState.activeOverviewMode = "gfa";

    const markup = renderToStaticMarkup(
      <InspectorPanel
        dataset={dataset}
        contactMap={contactMap}
        overviewContactMap={contactMap}
        status={status}
        statusMessage="ready"
        uiState={uiState}
        onUiAction={() => undefined}
        syntenyView={null}
        assemblyBlocks={[]}
        selectedAssemblyBlockIds={[]}
        pafText=""
        onPafTextChange={() => undefined}
        gfaDocument={{
          fileName: "a-very-long-hifiasm-primary-assembly-graph-file-name.gfa",
          segments: {
            utg1: {
              name: "utg1",
              length: 100,
              readDepth: 10,
              hasSequence: false,
              aRecordCount: 1,
              haplotypeCounts: {},
            },
          },
          segmentOrder: ["utg1"],
          links: [],
          summary: {
            lineCount: 2,
            segmentCount: 1,
            linkCount: 0,
            aRecordCount: 1,
            warningCount: 0,
          },
          warnings: [],
        }}
      />,
    );

    expect(markup).toContain("Overview");
    expect(markup).toContain("Synteny");
    expect(markup).toContain(">GFA</button>");
    expect(markup).toContain("inspector-overview gfa-overview-active");
    expect(markup).toContain("gfa-preview-card embedded");
    expect(markup).toContain('class="gfa-preview-title"');
    expect(markup).toContain(
      'title="a-very-long-hifiasm-primary-assembly-graph-file-name.gfa"',
    );
    expect(markup).toContain('class="gfa-preview-expand-button"');
    expect(markup).toContain(
      'title="Click to preview; double-click to open the GFA graph panel"',
    );
    expect(markup).not.toContain("Double-click to inspect and elastically reposition the graph.");
  });

  it("renders live multi-block selection details and chromosome groups", () => {
    const uiState = createInitialUiState("ready");
    uiState.assembly.blocks = [
      {
        id: "Chr01:1:ctg1",
        objectId: "Chr01",
        sourceId: "ctg1",
        sourceStart: 0,
        sourceEnd: 100,
        visualStart: 0,
        visualEnd: 100,
        orientation: "+",
      },
      {
        id: "Chr01:2:ctg2",
        objectId: "Chr01",
        sourceId: "ctg2",
        sourceStart: 0,
        sourceEnd: 150,
        visualStart: 100,
        visualEnd: 250,
        orientation: "-",
      },
      {
        id: "Chr02:1:ctg3",
        objectId: "Chr02",
        sourceId: "ctg3",
        sourceStart: 0,
        sourceEnd: 80,
        visualStart: 250,
        visualEnd: 330,
        orientation: "+",
      },
    ];
    uiState.assembly.selection = { kind: "contigs", ids: ["Chr01:2:ctg2", "Chr02:1:ctg3"] };

    const markup = renderToStaticMarkup(
      <InspectorPanel
        dataset={dataset}
        contactMap={contactMap}
        overviewContactMap={contactMap}
        status={status}
        statusMessage="ready"
        uiState={uiState}
        onUiAction={() => undefined}
        syntenyView={null}
        assemblyBlocks={uiState.assembly.blocks}
        selectedAssemblyBlockIds={uiState.assembly.selection.ids}
        pafText=""
        onPafTextChange={() => undefined}
      />,
    );

    expect(markup).toContain("2 blocks");
    expect(markup).toContain("2 contigs");
    expect(markup).toContain("2 chromosomes");
    expect(markup).toContain("Chr01");
    expect(markup).toContain("Chr02");
    expect(markup).toContain("ctg2");
    expect(markup).toContain("ctg3");
    expect(markup).not.toContain("ctg1");
  });

  it("shows only the selected chromosome and its contigs", () => {
    const uiState = createInitialUiState("ready");
    uiState.assembly.blocks = [
      {
        id: "Chr01:1:ctg1",
        objectId: "Chr01",
        sourceId: "ctg1",
        sourceStart: 0,
        sourceEnd: 100,
        visualStart: 0,
        visualEnd: 100,
        orientation: "+",
      },
      {
        id: "Chr01:2:ctg2",
        objectId: "Chr01",
        sourceId: "ctg2",
        sourceStart: 0,
        sourceEnd: 150,
        visualStart: 100,
        visualEnd: 250,
        orientation: "-",
      },
      {
        id: "Chr02:1:ctg3",
        objectId: "Chr02",
        sourceId: "ctg3",
        sourceStart: 0,
        sourceEnd: 80,
        visualStart: 250,
        visualEnd: 330,
        orientation: "+",
      },
    ];
    uiState.assembly.selection = { kind: "chromosome", id: "Chr01" };

    const markup = renderToStaticMarkup(
      <InspectorPanel
        dataset={dataset}
        contactMap={contactMap}
        overviewContactMap={contactMap}
        status={status}
        statusMessage="ready"
        uiState={uiState}
        onUiAction={() => undefined}
        syntenyView={null}
        assemblyBlocks={uiState.assembly.blocks}
        selectedAssemblyBlockIds={["Chr01:1:ctg1", "Chr01:2:ctg2"]}
        pafText=""
        onPafTextChange={() => undefined}
      />,
    );

    expect(markup).toContain("Chr01");
    expect(markup).toContain("ctg1");
    expect(markup).toContain("ctg2");
    expect(markup.match(/class="selection-contig-label"/g)).toHaveLength(2);
    expect(markup).toContain('title="ctg1 (+)"');
    expect(markup).toContain('title="ctg2 (-)"');
    expect(markup).toContain(
      'ctg1 <strong class="selection-contig-orientation orientation-forward" aria-hidden="true">+</strong>',
    );
    expect(markup).toContain(
      'ctg2 <strong class="selection-contig-orientation orientation-reverse" aria-hidden="true">-</strong>',
    );
    expect(markup).toContain('title="Double-click to rename Chr01"');
    expect(markup).toContain('class="selection-group-heading"');
    expect(markup).toContain('class="selection-group-locate-button"');
    expect(markup).toContain('aria-label="Center and select chromosome Chr01"');
    expect(markup).not.toContain("Chr02");
    expect(markup).not.toContain("ctg3");
  });

  it("lists child contigs without counting a composite block id as a contig", () => {
    const uiState = createInitialUiState("ready");
    uiState.assembly.blocks = [
      {
        id: "Chr01:1:ctg1",
        objectId: "Chr01",
        sourceId: "ctg1",
        sourceStart: 0,
        sourceEnd: 100,
        visualStart: 0,
        visualEnd: 100,
        orientation: "+",
        assemblyBlockId: "Chr01_block_1",
      },
      {
        id: "Chr01:2:ctg2",
        objectId: "Chr01",
        sourceId: "ctg2",
        sourceStart: 0,
        sourceEnd: 150,
        visualStart: 100,
        visualEnd: 250,
        orientation: "-",
        assemblyBlockId: "Chr01_block_1",
      },
    ];
    uiState.assembly.selection = { kind: "contigs", ids: ["Chr01_block_1"] };

    const markup = renderToStaticMarkup(
      <InspectorPanel
        dataset={dataset}
        contactMap={contactMap}
        overviewContactMap={contactMap}
        status={status}
        statusMessage="ready"
        uiState={uiState}
        onUiAction={() => undefined}
        syntenyView={null}
        assemblyBlocks={uiState.assembly.blocks}
        selectedAssemblyBlockIds={["Chr01:1:ctg1", "Chr01:2:ctg2"]}
        pafText=""
        onPafTextChange={() => undefined}
      />,
    );

    expect(markup).toContain("1 block");
    expect(markup).toContain("2 contigs");
    expect(markup).toContain("Chr01_block_1");
    expect(markup).toContain('aria-label="Block details"');
    expect(markup).toContain('aria-label="Center and select block Chr01_block_1"');
    expect(markup).toContain("Current location");
    expect(markup).toContain("Chr01 · 1-250 bp");
    expect(markup).toContain("1 forward · 1 reverse");
    expect(markup).toContain("Locked as one unit");
    expect(markup).not.toContain('aria-label="Contig occurrences"');
    expect(markup).toContain(
      'class="block-member-list" aria-label="Contigs in Chr01_block_1"',
    );
    expect(markup).toContain('class="block-member-metadata"><span>100 bp</span>');
    expect(markup).toContain('class="block-member-metadata"><span>150 bp</span>');
    expect(markup).toContain('class="selection-block-entry composite"');
    expect(markup).toContain("ctg1");
    expect(markup).toContain("ctg2");
    expect(markup).toContain('aria-label="Center and select ctg1, orientation +"');
    expect(markup).toContain('aria-label="Center and select ctg2, orientation -"');
    expect(markup).toContain(
      'class="selection-contig-orientation orientation-forward" aria-hidden="true">+</strong>',
    );
    expect(markup).toContain(
      'class="selection-contig-orientation orientation-reverse" aria-hidden="true">-</strong>',
    );
  });

  it("groups split copy segments and exposes every related location", () => {
    const uiState = createInitialUiState("ready");
    uiState.assembly.blocks = [
      {
        id: "Chr01:1:utg1:left",
        objectId: "Chr01",
        sourceId: "utg1",
        displayName: "utg1:1-50",
        isSourceSegment: true,
        copyInstanceId: "utg1-copy-1",
        sourceStart: 0,
        sourceEnd: 50,
        visualStart: 0,
        visualEnd: 50,
        orientation: "+",
        assemblyBlockId: "Chr01_block_1",
      },
      {
        id: "Chr01:1:utg1:right",
        objectId: "Chr01",
        sourceId: "utg1",
        displayName: "utg1:51-100",
        isSourceSegment: true,
        copyInstanceId: "utg1-copy-1",
        sourceStart: 50,
        sourceEnd: 100,
        visualStart: 150,
        visualEnd: 200,
        orientation: "+",
        assemblyBlockId: null,
      },
      {
        id: "Chr02:1:utg1_d2",
        objectId: "Chr02",
        sourceId: "utg1",
        displayName: "utg1",
        copyInstanceId: "utg1-copy-2",
        sourceStart: 0,
        sourceEnd: 100,
        visualStart: 200,
        visualEnd: 300,
        orientation: "+",
        assemblyBlockId: null,
      },
      {
        id: "debris:1:utg1_d3:left",
        objectId: "debris",
        sourceId: "utg1",
        displayName: "utg1:1-25",
        isSourceSegment: true,
        copyInstanceId: "utg1-copy-3",
        sourceStart: 0,
        sourceEnd: 25,
        visualStart: 400,
        visualEnd: 425,
        orientation: "-",
        assemblyBlockId: null,
      },
      {
        id: "debris:1:utg1_d3:right",
        objectId: "debris",
        sourceId: "utg1",
        displayName: "utg1:26-50",
        isSourceSegment: true,
        copyInstanceId: "utg1-copy-3",
        sourceStart: 25,
        sourceEnd: 50,
        visualStart: 525,
        visualEnd: 550,
        orientation: "-",
        assemblyBlockId: null,
      },
    ];
    uiState.assembly.selection = {
      kind: "contigs",
      ids: ["Chr01:1:utg1:left"],
    };

    const markup = renderToStaticMarkup(
      <InspectorPanel
        dataset={dataset}
        contactMap={contactMap}
        overviewContactMap={contactMap}
        status={status}
        statusMessage="ready"
        uiState={uiState}
        onUiAction={() => undefined}
        syntenyView={null}
        assemblyBlocks={uiState.assembly.blocks}
        selectedAssemblyBlockIds={["Chr01:1:utg1:left"]}
        pafText=""
        onPafTextChange={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="Contig occurrences"');
    expect(markup).toContain("3 copies");
    expect(markup).toContain("utg1:1-50");
    expect(markup).toContain("Current location");
    expect(markup).toContain("Current copy");
    expect(markup).toContain("Split copy · 2 segments");
    expect(markup).toContain("Other segments in this copy");
    expect(markup).toContain("utg1:51-100");
    expect(markup).toContain("Other copies");
    expect(markup).toContain("utg1:1-25");
    expect(markup).toContain("utg1:26-50");
    expect(markup).toContain("Covers current interval");
    expect(markup).toContain("Chr02");
    expect(markup).toContain("debris");
    expect(markup).toContain('aria-label="Center and select utg1:1-50"');
    expect(markup).toContain(
      'aria-label="Center and select utg1:51-100 at Chr01 · Chr01:1:utg1:right · 151-200 bp · +"',
    );
    expect(markup).not.toContain('aria-label="Select utg1:51-100');
  });

  it("renders an actionable history timeline with impacted objects and an undone branch", () => {
    const uiState = createInitialUiState("ready");
    const operation = {
      id: 1,
      type: "reverse" as const,
      label: "Selection reversed",
      position: { x: 0, y: 0 },
      impact: {
        blockIds: ["Chr01:1:ctg1", "Chr01:2:ctg2"],
        sourceIds: ["ctg1", "ctg2"],
        chromosomeIds: ["Chr01"],
        selection: { kind: "contigs" as const, ids: ["Chr01:1:ctg1", "Chr01:2:ctg2"] },
      },
    };
    uiState.operationHistory = [operation];
    uiState.redoStack = [{
      ...operation,
      id: 2,
      label: "Selection moved",
    }];

    const markup = renderToStaticMarkup(
      <InspectorPanel
        dataset={dataset}
        contactMap={contactMap}
        overviewContactMap={contactMap}
        status={status}
        statusMessage="ready"
        uiState={uiState}
        onUiAction={() => undefined}
        syntenyView={null}
        assemblyBlocks={uiState.assembly.blocks}
        selectedAssemblyBlockIds={[]}
        pafText=""
        onPafTextChange={() => undefined}
      />,
    );

    expect(markup).toContain("1 applied · 1 undone");
    expect(markup).toContain("ctg1, ctg2");
    expect(markup).toContain("1 chromosome · 2 contigs");
    expect(markup).toContain('class="undone"');
    expect(markup).toContain("Undone");
    expect(markup).not.toContain("0, 0");
    expect(markup).toContain('aria-label="Focus Selection reversed"');
  });
});
