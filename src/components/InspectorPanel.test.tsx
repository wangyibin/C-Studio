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
        onSelectSyntenyBlock={() => undefined}
        pafText=""
        onPafTextChange={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="Contact map overview"');
    expect(markup).toContain('class="overview-heatmap-canvas"');
    expect(markup).toContain("Overview");
  });

  it("renders live multi-contig selection details and chromosome groups", () => {
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
        onSelectSyntenyBlock={() => undefined}
        pafText=""
        onPafTextChange={() => undefined}
      />,
    );

    expect(markup).toContain("2 contigs");
    expect(markup).toContain("2 chromosomes");
    expect(markup).toContain("Chr01");
    expect(markup).toContain("Chr02");
    expect(markup).toContain("ctg2");
    expect(markup).toContain("ctg3");
  });
});
