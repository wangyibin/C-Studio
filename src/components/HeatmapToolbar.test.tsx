import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createInitialUiState } from "../state/uiState";
import { HeatmapToolbar } from "./HeatmapToolbar";

function openingButton(markup: string, ariaLabel: string) {
  return markup.match(new RegExp(`<button[^>]*aria-label="${ariaLabel}"[^>]*>`))?.[0] ?? "";
}

describe("HeatmapToolbar", () => {
  it("renders the complete expert toolbar without the inert grid control", () => {
    const uiState = createInitialUiState("ready");
    const markup = renderToStaticMarkup(
      <HeatmapToolbar uiState={uiState} onUiAction={() => undefined} totalSpanMb={200} />,
    );

    expect(markup).toContain('role="toolbar"');
    expect(markup).toContain('aria-label="Heatmap tools"');
    expect(markup).toContain('aria-label="Select tool"');
    expect(markup).toContain('aria-label="Split tool"');
    expect(markup).toContain('aria-label="Move tool"');
    expect(markup).toContain('aria-label="Contact map resolution"');
    expect(markup).toContain('aria-label="Color range minimum"');
    expect(markup).toContain('aria-label="Color range maximum"');
    expect(markup).toContain('aria-label="Contact map normalization"');
    expect(markup).toContain('aria-label="Chromosome boxes"');
    expect(markup).toContain('aria-label="Contig boxes"');
    expect(markup).toContain('aria-label="Fit whole genome"');
    expect(markup).toContain('aria-label="Jump target in megabases"');
    expect(markup).not.toContain("Grid");
  });

  it("exposes pressed states and disables selection actions when nothing is selected", () => {
    const uiState = createInitialUiState("ready");
    uiState.selectedTool = "split";
    const markup = renderToStaticMarkup(
      <HeatmapToolbar uiState={uiState} onUiAction={() => undefined} totalSpanMb={200} />,
    );

    expect(openingButton(markup, "Select tool")).toContain('aria-pressed="false"');
    expect(openingButton(markup, "Split tool")).toContain('aria-pressed="true"');
    expect(openingButton(markup, "Move tool")).toContain('aria-pressed="false"');
    expect(openingButton(markup, "Reverse selection")).toContain('disabled=""');
    expect(openingButton(markup, "Copy selection")).toContain('disabled=""');
    expect(openingButton(markup, "Lock resolution")).toContain('aria-pressed="false"');
    expect(openingButton(markup, "Automatic color range")).toContain('aria-pressed="true"');
    expect(openingButton(markup, "Chromosome boxes")).toContain('aria-pressed="true"');
    expect(openingButton(markup, "Contig boxes")).toContain('aria-pressed="true"');
  });

  it("enables selection actions and reflects imported display settings", () => {
    const uiState = createInitialUiState("ready");
    uiState.assembly.selection = { kind: "contigs", ids: ["Chr01:1:ctg1"] };
    uiState.contact.resolutionLocked = true;
    uiState.contact.colorScale = {
      ...uiState.contact.colorScale,
      min: 1.25,
      max: 7.5,
      auto: false,
    };
    uiState.assembly.showContigBoxes = false;
    uiState.normalization = "KR (Balanced)";

    const markup = renderToStaticMarkup(
      <HeatmapToolbar uiState={uiState} onUiAction={() => undefined} totalSpanMb={360} />,
    );

    expect(openingButton(markup, "Reverse selection")).not.toContain("disabled");
    expect(openingButton(markup, "Copy selection")).not.toContain("disabled");
    expect(openingButton(markup, "Unlock resolution")).toContain('aria-pressed="true"');
    expect(openingButton(markup, "Automatic color range")).toContain('aria-pressed="false"');
    expect(openingButton(markup, "Contig boxes")).toContain('aria-pressed="false"');
    expect(markup).toContain('value="1.25"');
    expect(markup).toContain('value="7.5"');
    expect(markup).toContain('<option value="KR (Balanced)" selected="">KR (Balanced)</option>');
    expect(markup).toContain('max="360"');
  });
});
