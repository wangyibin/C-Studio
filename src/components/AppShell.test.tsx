import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ContactMapView, ExampleDatasetSummary } from "../App";
import { keyboardShortcutLabels } from "../state/keyboardShortcutLabels";
import { resolveChromosomeVisibility } from "../state/chromosomeVisibility";
import { classifyGfaScaffolds } from "../state/gfaHomologLayout";
import { createInitialUiState, type UiState } from "../state/uiState";
import { AppShell, clampGfaPanelHeight, clampInspectorPanelWidth } from "./AppShell";

function renderShell(
  rightCollapsed = false,
  contactMap: ContactMapView | null = null,
  normalization: UiState["normalization"] = "None (Raw)",
  project: {
    dataset?: ExampleDatasetSummary | null;
    isAgpDirty?: boolean;
    autoSaveEnabled?: boolean;
    autoSaveAvailable?: boolean;
    gfaHomologPattern?: string;
    includeUnanchoredInChromosomeFilter?: boolean;
  } = {},
) {
  const uiState = createInitialUiState("Ready");
  uiState.layout.rightCollapsed = rightCollapsed;
  uiState.normalization = normalization;
  const viewAssemblyBlocks = project.dataset?.agp_layout.blocks ?? [];
  const gfaHomologPattern = project.gfaHomologPattern ?? "(Chr\\d+)g(\\d+)";
  const classification = classifyGfaScaffolds(
    [...new Set(viewAssemblyBlocks.map((block) => block.objectId))],
    gfaHomologPattern,
  );
  const chromosomeIds = classification.columns
    .flatMap((column) => column.scaffolds.map((scaffold) => scaffold.id));
  const unanchoredIds = classification.otherScaffolds.filter((id) => id !== "debris");
  const includeUnanchoredInChromosomeFilter = project.includeUnanchoredInChromosomeFilter ?? false;

  return renderToStaticMarkup(
    <AppShell
      dataset={project.dataset ?? null}
      contactMap={contactMap}
      overviewContactMap={null}
      syntenyView={null}
      coverageView={null}
      pafText=""
      pafImported={false}
      gfaDocument={null}
      gfaHomologPattern={gfaHomologPattern}
      onGfaHomologPatternChange={() => undefined}
      chromosomeVisibility={resolveChromosomeVisibility(chromosomeIds, new Set(), "", {
        unanchoredIds,
        includeUnanchored: includeUnanchoredInChromosomeFilter,
      })}
      hiddenChromosomeIds={new Set()}
      chromosomeFilterPattern=""
      includeUnanchoredInChromosomeFilter={includeUnanchoredInChromosomeFilter}
      viewAssemblyBlocks={viewAssemblyBlocks}
      onHiddenChromosomeIdsChange={() => undefined}
      onChromosomeFilterPatternChange={() => undefined}
      onIncludeUnanchoredInChromosomeFilterChange={() => undefined}
      onPafTextChange={() => undefined}
      agpInputRef={createRef<HTMLInputElement>()}
      gfaInputRef={createRef<HTMLInputElement>()}
      pafInputRef={createRef<HTMLInputElement>()}
      coverageInputRef={createRef<HTMLInputElement>()}
      onAgpFileRequested={() => undefined}
      onAgpFileSelected={() => undefined}
      onGfaFileSelected={() => undefined}
      onContactFileSelected={() => undefined}
      onPafFileRequested={() => undefined}
      onPafFileSelected={() => undefined}
      onCoverageFileRequested={() => undefined}
      onCoverageFileSelected={() => undefined}
      onExportAgp={() => undefined}
      onExportAgpAs={() => undefined}
      autoSaveEnabled={project.autoSaveEnabled ?? false}
      autoSaveAvailable={project.autoSaveAvailable ?? false}
      isAgpDirty={project.isAgpDirty ?? false}
      onAutoSaveEnabledChange={() => undefined}
      onLoadExample={() => undefined}
      onReloadAssembly={() => undefined}
      onClearAllData={() => undefined}
      status={{
        version: "0.1.3",
        engine: "c-studio-core",
        coordinate_convention: "0-based half-open",
        supported_operations: [],
      }}
      statusMessage="Ready"
      uiState={uiState}
      onUiAction={() => undefined}
    />,
  );
}

describe("AppShell confirmed workspace", () => {
  it("renders the two-row toolbar and consolidates all data imports", () => {
    const markup = renderShell();
    const shortcuts = keyboardShortcutLabels();
    const otherRenameLabel = shortcuts.rename === "⌘E" ? "Ctrl+E" : "⌘E";

    expect(markup).toContain('class="app-toolbar-stack"');
    expect(markup).toContain('class="global-toolbar"');
    expect(markup).toContain('class="global-homolog-pattern"');
    expect(markup).toContain('aria-label="Homologous chromosome regular expression"');
    expect(markup).toContain('value="(Chr\\d+)g(\\d+)"');
    expect(markup).toContain('class="chromosome-filter-menu"');
    expect(markup).toContain('aria-label="Filter chromosomes shown in assembly views"');
    expect(markup).toContain("Heatmap · dotplot · coverage · GFA · AGP unchanged");
    expect(markup).toContain('aria-label="Chromosome display regular expression"');
    expect(markup).toContain("Press Enter or leave the field to apply this filter");
    expect(markup).toContain('aria-label="Include unanchored objects in chromosome filter"');
    expect(markup).toContain("Displayed chromosomes");
    expect(markup).toContain("Showing 0 of 0");
    expect(markup).toContain('class="heatmap-toolbar"');
    expect(markup).toContain("Assembly (.agp)");
    expect(markup).toContain("Assembly graph (.gfa)");
    expect(markup).toContain("Contact map (.cool/.mcool)");
    expect(markup).toContain("Synteny alignments (.paf)");
    expect(markup).toContain("Coverage track");
    expect(markup).toContain("Load example project");
    expect(markup).toContain("Reload assembly…");
    expect(markup).toContain('title="No source AGP loaded"');
    expect(markup).toContain("Clear all loaded data…");
    expect(markup).toContain('title="No loaded data"');
    expect(markup).toContain('aria-keyshortcuts="F10"');
    expect(markup).toContain('role="separator"');
    expect(markup).toContain('aria-label="Resize inspector"');
    expect(markup).toContain('aria-keyshortcuts="Control+Z Meta+Z Control+U Meta+U"');
    expect(markup).toContain('aria-keyshortcuts="Meta+Shift+Z Control+Y Control+R Meta+R"');
    expect(markup).toContain('aria-label="Save edited AGP"');
    expect(markup).toContain('aria-label="Save edited AGP as"');
    expect(markup).toContain('aria-keyshortcuts="Control+S Meta+S"');
    expect(markup).toContain('aria-label="Auto-save"');
    expect(markup).toContain("Save As once to enable auto-save");
    expect(markup).toContain('aria-label="Keyboard shortcuts"');
    expect(markup).toContain("0.1.3");
    expect(markup).toContain(`<dt>Save AGP</dt><dd>${shortcuts.save}</dd>`);
    expect(markup).toContain(`<dt>Rename</dt><dd>${shortcuts.rename}</dd>`);
    expect(markup).toContain(`<dt>Move to debris</dt><dd>${shortcuts.moveToDebris}</dd>`);
    expect(markup).not.toContain(`<dt>Rename</dt><dd>${otherRenameLabel}</dd>`);
    expect(markup).toContain("Delete gap / join");
    expect(markup).toContain(`<dt>Delete contig</dt><dd>${shortcuts.deleteContig}</dd>`);
    expect(markup).toContain(`<dt>Pan diagonally</dt><dd>${shortcuts.diagonalWheel}</dd>`);
    expect(markup).toContain(`<dt>Pan vertically</dt><dd>${shortcuts.verticalWheel}</dd>`);
  });

  it("marks an invalid global homolog regex in the top toolbar", () => {
    const markup = renderShell(false, null, "None (Raw)", {
      gfaHomologPattern: "(Chr\\d+",
    });

    expect(markup).toContain('class="global-homolog-pattern invalid"');
    expect(markup).toContain("Invalid regular expression:");
  });

  it("offers unanchored AGP objects as one aggregated filter option", () => {
    const dataset: ExampleDatasetSummary = {
      agp_path: "/tmp/unanchored.agp",
      mcool_path: "",
      cool_path: "",
      paf_path: null,
      coverage_path: null,
      agp_lines: 2,
      agp_objects: 2,
      agp_components: 2,
      agp_gaps: 0,
      max_object_span: 100,
      mcool_size_bytes: 0,
      agp_layout: {
        blocks: [
          {
            id: "Chr01g1:1:ctg1",
            objectId: "Chr01g1",
            sourceId: "ctg1",
            sourceStart: 0,
            sourceEnd: 100,
            visualStart: 0,
            visualEnd: 100,
            orientation: "+",
          },
          {
            id: "utg1:1:utg1",
            objectId: "utg1",
            sourceId: "utg1",
            sourceStart: 0,
            sourceEnd: 50,
            visualStart: 100,
            visualEnd: 150,
            orientation: "+",
          },
        ],
        totalSpan: 150,
      },
    };

    const markup = renderShell(false, null, "None (Raw)", { dataset });
    const listStart = markup.indexOf('class="chromosome-filter-list"');
    const listEnd = markup.indexOf("</div>", listStart);
    const chromosomeList = markup.slice(listStart, listEnd);

    expect(markup).toContain("Unanchored / unmatched");
    expect(markup).toContain("1 AGP object");
    expect(chromosomeList).toContain("Chr01g1");
    expect(chromosomeList).not.toContain("utg1");
    expect(markup).toContain("Use None plus this option to show only unanchored objects.");
  });

  it("clamps the bottom GFA panel between a usable minimum and workspace share", () => {
    expect(clampGfaPanelHeight(80, 900)).toBe(180);
    expect(clampGfaPanelHeight(360, 900)).toBe(360);
    expect(clampGfaPanelHeight(900, 900)).toBe(585);
  });

  it("removes the former side and bottom tool surfaces while wiring both genome axes", () => {
    const markup = renderShell();

    expect(markup).not.toContain("left-tool-column");
    expect(markup).not.toContain("bottom-dock");
    expect(markup).not.toContain("map-heading");
    expect(markup).toContain('aria-label="X axis whole-genome navigator"');
    expect(markup).toContain('aria-label="Y axis whole-genome navigator"');
    expect(markup).toContain('class="map-axis-ticks map-axis-ticks-x"');
    expect(markup).toContain('class="map-axis-ticks map-axis-ticks-y"');
    expect(markup).toContain('aria-label="Inspector"');
    expect(markup).toContain('aria-label="Block boxes"');
    expect(markup).toContain('aria-label="Contig boxes"');
    expect(markup).toContain('aria-keyshortcuts="F2"');
    expect(markup).toContain('aria-keyshortcuts="F9"');
    expect(markup).toContain('aria-label="Heatmap window controls"');
    expect(markup).toContain('aria-label="Expand heatmap window"');
    expect(markup).toContain('aria-label="Close heatmap window"');
  });

  it("marks unsaved names consistently and enables auto-save only after Save As", () => {
    const dataset: ExampleDatasetSummary = {
      agp_path: "/tmp/renamed.agp",
      mcool_path: "",
      cool_path: "",
      paf_path: null,
      coverage_path: null,
      agp_lines: 1,
      agp_objects: 1,
      agp_components: 1,
      agp_gaps: 0,
      max_object_span: 100,
      mcool_size_bytes: 0,
      agp_layout: {
        blocks: [{
          id: "Chr01:1:ctg1",
          objectId: "Chr01",
          sourceId: "ctg1",
          sourceStart: 0,
          sourceEnd: 100,
          visualStart: 0,
          visualEnd: 100,
          orientation: "+",
        }],
        totalSpan: 100,
      },
    };
    const markup = renderShell(false, null, "None (Raw)", {
      dataset,
      isAgpDirty: true,
      autoSaveEnabled: true,
      autoSaveAvailable: true,
    });

    expect(markup).toContain("renamed.agp*");
    expect(markup).toContain("/tmp/renamed.agp*");
    expect(markup).toContain('aria-label="Auto-save" checked=""');
    expect(markup).not.toContain("Save As once to enable auto-save");
    expect(markup).toContain('title="Remove every loaded data source"');
    expect(markup).not.toContain('title="No loaded data"');
    expect(markup).toContain('title="Discard all assembly edits and reload the source AGP"');
    expect(markup).not.toContain('title="No source AGP loaded"');
  });

  it("allows the inspector to collapse without changing the heatmap workspace", () => {
    const markup = renderShell(true);

    expect(markup).not.toContain('aria-label="Inspector"');
    expect(markup).not.toContain('aria-label="Resize inspector"');
    expect(markup).toContain('class="workspace right-collapsed"');
    expect(markup).toContain('aria-label="Contact map viewport"');
  });

  it("clamps the resizable inspector without crowding out the heatmap", () => {
    expect(clampInspectorPanelWidth(100, 1_400)).toBe(260);
    expect(clampInspectorPanelWidth(420, 1_400)).toBe(420);
    expect(clampInspectorPanelWidth(800, 1_400)).toBe(520);
    expect(clampInspectorPanelWidth(500, 800)).toBe(360);
  });

  it("shows which normalization is still displayed during an async mode switch", () => {
    const rawMap: ContactMapView = {
      resolution: 10_000,
      normalization: "raw",
      viewport: { xStart: 0, xEnd: 10_000, yStart: 0, yEnd: 10_000 },
      cells: [],
    };
    const pendingMarkup = renderShell(false, rawMap, "ICE (Balanced)");
    const appliedMarkup = renderShell(
      false,
      { ...rawMap, normalization: "ice" },
      "ICE (Balanced)",
    );

    expect(pendingMarkup).toContain(
      "Normalization: ICE (Balanced) (showing None (Raw))",
    );
    expect(appliedMarkup).not.toContain("showing None (Raw)");
  });
});
