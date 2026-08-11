import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createInitialUiState } from "../state/uiState";
import type { AppStatus, ContactMapView, ExampleDatasetSummary } from "../App";
import {
  contactOverviewMapForDisplayedNormalization,
  InspectorPanel,
} from "./InspectorPanel";

const status: AppStatus = {
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
  it("does not show an overview from a different normalization", () => {
    const rawMap = { ...contactMap, normalization: "raw" as const };
    const iceOverview = {
      ...contactMap,
      normalization: "ice" as const,
      cells: [{ xBin: 0, yBin: 0, count: 24 }],
    };

    expect(
      contactOverviewMapForDisplayedNormalization(rawMap, iceOverview),
    ).toBe(rawMap);
    expect(
      contactOverviewMapForDisplayedNormalization(
        { ...rawMap, normalization: "ice" },
        iceOverview,
      ),
    ).toBe(iceOverview);
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
      />,
    );

    expect(markup).toContain('aria-label="Contact map overview"');
    expect(markup).toContain('class="overview-heatmap-canvas"');
    expect(markup).toContain("Overview");
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
    expect(markup).toContain('title="ctg1"');
    expect(markup).toContain('title="ctg2"');
    expect(markup).toContain('title="Double-click to rename Chr01"');
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
    expect(markup).toContain('aria-label="Contigs in Chr01_block_1"');
    expect(markup).toContain('class="selection-block-entry composite"');
    expect(markup).toContain("ctg1");
    expect(markup).toContain("ctg2");
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
