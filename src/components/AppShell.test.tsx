import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ContactMapView } from "../App";
import { createInitialUiState, type UiState } from "../state/uiState";
import { AppShell } from "./AppShell";

function renderShell(
  rightCollapsed = false,
  contactMap: ContactMapView | null = null,
  normalization: UiState["normalization"] = "None (Raw)",
) {
  const uiState = createInitialUiState("Ready");
  uiState.layout.rightCollapsed = rightCollapsed;
  uiState.normalization = normalization;

  return renderToStaticMarkup(
    <AppShell
      dataset={null}
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

    expect(markup).toContain('class="app-toolbar-stack"');
    expect(markup).toContain('class="global-toolbar"');
    expect(markup).toContain('class="heatmap-toolbar"');
    expect(markup).toContain("Assembly (.agp)");
    expect(markup).toContain("Contact map (.cool/.mcool)");
    expect(markup).toContain("Synteny alignments (.paf)");
    expect(markup).toContain("Coverage track");
    expect(markup).toContain("Load example project");
    expect(markup).toContain('aria-keyshortcuts="F10"');
    expect(markup).toContain('aria-keyshortcuts="Control+U Meta+U"');
    expect(markup).toContain('aria-keyshortcuts="Control+R Meta+R"');
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
    expect(markup).toContain('aria-keyshortcuts="F2"');
    expect(markup).toContain('aria-keyshortcuts="F9"');
  });

  it("allows the inspector to collapse without changing the heatmap workspace", () => {
    const markup = renderShell(true);

    expect(markup).not.toContain('aria-label="Inspector"');
    expect(markup).toContain('class="workspace right-collapsed"');
    expect(markup).toContain('aria-label="Contact map viewport"');
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
