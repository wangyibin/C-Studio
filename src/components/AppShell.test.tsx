import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ContactMapView, ExampleDatasetSummary } from "../App";
import { keyboardShortcutLabels } from "../state/keyboardShortcutLabels";
import { createInitialUiState, type UiState } from "../state/uiState";
import { AppShell, clampInspectorPanelWidth } from "./AppShell";

function renderShell(
  rightCollapsed = false,
  contactMap: ContactMapView | null = null,
  normalization: UiState["normalization"] = "None (Raw)",
  project: {
    dataset?: ExampleDatasetSummary | null;
    isAgpDirty?: boolean;
    autoSaveEnabled?: boolean;
    autoSaveAvailable?: boolean;
  } = {},
) {
  const uiState = createInitialUiState("Ready");
  uiState.layout.rightCollapsed = rightCollapsed;
  uiState.normalization = normalization;

  return renderToStaticMarkup(
    <AppShell
      dataset={project.dataset ?? null}
      contactMap={contactMap}
      overviewContactMap={null}
      syntenyView={null}
      coverageView={null}
      pafText=""
      pafImported={false}
      onPafTextChange={() => undefined}
      agpInputRef={createRef<HTMLInputElement>()}
      pafInputRef={createRef<HTMLInputElement>()}
      coverageInputRef={createRef<HTMLInputElement>()}
      onAgpFileSelected={() => undefined}
      onContactFileSelected={() => undefined}
      onPafFileRequested={() => undefined}
      onPafFileSelected={() => undefined}
      onCoverageFileRequested={() => undefined}
      onCoverageFileSelected={() => undefined}
      onExportAgp={() => undefined}
      autoSaveEnabled={project.autoSaveEnabled ?? false}
      autoSaveAvailable={project.autoSaveAvailable ?? false}
      isAgpDirty={project.isAgpDirty ?? false}
      onAutoSaveEnabledChange={() => undefined}
      onLoadExample={() => undefined}
      status={{
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
    expect(markup).toContain('class="heatmap-toolbar"');
    expect(markup).toContain("Assembly (.agp)");
    expect(markup).toContain("Contact map (.cool/.mcool)");
    expect(markup).toContain("Synteny alignments (.paf)");
    expect(markup).toContain("Coverage track");
    expect(markup).toContain("Load example project");
    expect(markup).toContain('aria-keyshortcuts="F10"');
    expect(markup).toContain('role="separator"');
    expect(markup).toContain('aria-label="Resize inspector"');
    expect(markup).toContain('aria-keyshortcuts="Control+Z Meta+Z Control+U Meta+U"');
    expect(markup).toContain('aria-keyshortcuts="Meta+Shift+Z Control+Y Control+R Meta+R"');
    expect(markup).toContain('aria-label="Save edited AGP"');
    expect(markup).toContain('aria-keyshortcuts="Control+S Meta+S"');
    expect(markup).toContain('aria-label="Auto-save"');
    expect(markup).toContain("Save As once to enable auto-save");
    expect(markup).toContain('aria-label="Keyboard shortcuts"');
    expect(markup).toContain(`<dt>Save AGP</dt><dd>${shortcuts.save}</dd>`);
    expect(markup).toContain(`<dt>Rename</dt><dd>${shortcuts.rename}</dd>`);
    expect(markup).toContain(`<dt>Move to debris</dt><dd>${shortcuts.moveToDebris}</dd>`);
    expect(markup).not.toContain(`<dt>Rename</dt><dd>${otherRenameLabel}</dd>`);
    expect(markup).toContain("Delete gap / join");
    expect(markup).toContain(`<dt>Delete contig</dt><dd>${shortcuts.deleteContig}</dd>`);
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
      agp_layout: { blocks: [], totalSpan: 0 },
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
