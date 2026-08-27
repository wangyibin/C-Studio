import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createInitialUiState } from "../state/uiState";
import { HeatmapToolbar } from "./HeatmapToolbar";

function openingButton(markup: string, ariaLabel: string) {
  return markup.match(new RegExp(`<button[^>]*aria-label="${ariaLabel}"[^>]*>`))?.[0] ?? "";
}

describe("HeatmapToolbar", () => {
  it("renders the compact expert toolbar without the editing tool picker", () => {
    const uiState = createInitialUiState("ready");
    const markup = renderToStaticMarkup(
      <HeatmapToolbar uiState={uiState} onUiAction={() => undefined} totalSpanMb={200} />,
    );

    expect(markup).toContain('role="toolbar"');
    expect(markup).toContain('aria-label="Heatmap tools"');
    expect(markup).not.toContain('aria-label="Editing tools"');
    expect(markup).not.toContain('aria-label="Select tool"');
    expect(markup).not.toContain('aria-label="Split tool"');
    expect(markup).not.toContain('aria-label="Move tool"');
    expect(markup).not.toContain('aria-label="Selection actions"');
    expect(markup).not.toContain('aria-label="Reverse selection"');
    expect(markup).not.toContain('aria-label="Copy selection"');
    expect(markup).toContain('class="lucide lucide-pin"');
    expect(markup).not.toContain('class="lucide lucide-unlock"');
    expect(markup).toContain('aria-label="Contact map resolution"');
    expect(markup).toContain('<span class="heatmap-resolution-heading">');
    expect(markup).toContain('<span class="heatmap-resolution-value" aria-live="polite">500 kb</span>');
    expect(markup).not.toContain('aria-label="Stored contact map resolution"');
    expect(markup).not.toContain('<select class="heatmap-resolution-value"');
    expect(markup).toContain('class="heatmap-resolution-options" role="radiogroup" aria-label="Contact map resolution" aria-busy="false"');
    expect(markup.match(/class="heatmap-resolution-option"[^>]*role="radio"/g)).toHaveLength(9);
    expect(markup).toContain('role="radio" aria-label="500 kb" aria-checked="true" tabindex="0"');
    expect(markup).not.toContain('type="range"');
    expect(markup).not.toContain("<small>Max</small>");
    expect(markup).not.toContain("<small>Min</small>");
    expect(markup).not.toContain('class="heatmap-resolution-indicator"');
    expect(markup.match(/<small class="heatmap-resolution-label(?: [^"]+)?"/g)).toHaveLength(3);
    expect(markup).toContain('class="heatmap-resolution-label first"');
    expect(markup).toContain('class="heatmap-resolution-label last"');
    expect(markup).toContain('aria-label="Color range minimum"');
    expect(markup).toContain('aria-label="Color range maximum"');
    expect(markup).toContain('aria-label="Heatmap color map"');
    expect(markup).toContain('<option value="redp1_r_half" selected="">redp1_r_half</option><option value="Reds">Classic Reds</option>');
    expect(markup).toContain('<option value="Graphite">Graphite</option>');
    expect(markup).toContain('<option value="redp1_r">redp1_r</option>');
    expect(markup).toContain('<option value="Rose">Rose</option>');
    expect(markup).toContain('<option value="Cividis">Cividis</option>');
    expect(markup).toContain('<option value="Mako">Mako</option>');
    expect(markup).toContain('<option value="Amber">Amber</option>');
    expect(markup).toContain('data-colormap="redp1_r_half"');
    expect(markup).not.toContain('aria-label="Adaptive boundary contrast"');
    expect(markup).not.toContain('>Edges</span>');
    expect(markup).toContain('class="heatmap-color-fields"');
    expect(markup).not.toContain('class="heatmap-color-separator"');
    expect(markup).toContain('<label class="heatmap-toolbar-group heatmap-normalization-control"><span class="heatmap-toolbar-label">Normalization</span><select');
    expect(markup).toContain('aria-label="Contact map normalization"');
    expect(markup).toContain('aria-label="Chromosome boxes"');
    expect(markup).toContain('aria-label="Block boxes"');
    expect(markup).toContain('aria-label="Contig boxes"');
    expect(markup).not.toContain('aria-label="Fit whole genome"');
    expect(markup).toContain('aria-label="X contig or interval"');
    expect(markup).toContain('aria-label="Y contig or interval"');
    expect(markup).toContain('placeholder="contig[:start-end]"');
    expect(markup).toContain('aria-label="Jump to contig or interval"');
    expect(markup).not.toContain('aria-label="Jump target in megabases"');
    expect(markup).not.toContain("Grid");
  });

  it("renders display controls when nothing is selected", () => {
    const uiState = createInitialUiState("ready");
    uiState.selectedTool = "split";
    const markup = renderToStaticMarkup(
      <HeatmapToolbar uiState={uiState} onUiAction={() => undefined} totalSpanMb={200} />,
    );

    expect(markup).not.toContain('aria-label="Split tool"');
    expect(openingButton(markup, "Lock resolution")).toContain('aria-pressed="false"');
    expect(openingButton(markup, "Automatic color range")).toContain('aria-pressed="true"');
    expect(openingButton(markup, "Chromosome boxes")).toContain('aria-pressed="true"');
    expect(openingButton(markup, "Block boxes")).toContain('aria-pressed="true"');
    expect(openingButton(markup, "Contig boxes")).toContain('aria-pressed="true"');
  });

  it("shows every pyramid level that actually exists in an mcool", () => {
    const uiState = createInitialUiState("ready");
    uiState.contact.resolution = "2 Mb";
    const markup = renderToStaticMarkup(
      <HeatmapToolbar
        uiState={uiState}
        onUiAction={() => undefined}
        totalSpanMb={200}
        useStoredResolutionOptions
        availableResolutionBasePairs={[
          2_500_000,
          2_000_000,
          1_000_000,
          500_000,
          250_000,
          100_000,
          50_000,
          25_000,
          10_000,
          5_000,
          1_000,
        ]}
      />,
    );

    expect(markup).toContain('role="radio" aria-label="2 Mb" aria-checked="true" tabindex="0"');
    expect(markup).toContain('<span class="heatmap-resolution-value" aria-live="polite">2 Mb</span>');
    expect(markup.match(/class="heatmap-resolution-option"[^>]*role="radio"/g)).toHaveLength(11);
    expect(markup).not.toContain('<select class="heatmap-resolution-value"');
    expect(markup).toContain("2.5 Mb");
    expect(markup).toContain("1 kb");
    expect(markup).not.toContain("2 kb");
  });

  it("does not expose generic levels while mcool metadata is unavailable", () => {
    const uiState = createInitialUiState("ready");
    const markup = renderToStaticMarkup(
      <HeatmapToolbar
        uiState={uiState}
        onUiAction={() => undefined}
        totalSpanMb={10_000}
        useStoredResolutionOptions
        availableResolutionBasePairs={[]}
      />,
    );

    expect(markup).toContain(">Loading…</span>");
    expect(markup).toContain('role="radiogroup" aria-label="Contact map resolution" aria-busy="true"');
    expect(markup).not.toContain('role="radio"');
    expect(markup).not.toContain("2.5 Mb");
    expect(markup).not.toContain("2 Mb");
    expect(markup).not.toContain("1 Mb");
  });

  it("reflects imported display settings", () => {
    const uiState = createInitialUiState("ready");
    uiState.assembly.selection = { kind: "contigs", ids: ["Chr01:1:ctg1"] };
    uiState.contact.resolutionLocked = true;
    uiState.contact.colorScale = {
      ...uiState.contact.colorScale,
      min: 1.25,
      max: 7.5,
      auto: false,
    };
    uiState.contact.colormap = "Plum";
    uiState.assembly.showBlockBoxes = false;
    uiState.assembly.showContigBoxes = false;
    uiState.normalization = "KR (Balanced)";

    const markup = renderToStaticMarkup(
      <HeatmapToolbar uiState={uiState} onUiAction={() => undefined} totalSpanMb={360} />,
    );

    expect(openingButton(markup, "Unlock resolution")).toContain('aria-pressed="true"');
    expect(markup).toContain('class="lucide lucide-pin"');
    expect(markup).not.toContain('class="lucide lucide-lock"');
    expect(openingButton(markup, "Automatic color range")).toContain('aria-pressed="false"');
    expect(openingButton(markup, "Block boxes")).toContain('aria-pressed="false"');
    expect(openingButton(markup, "Contig boxes")).toContain('aria-pressed="false"');
    expect(markup).toContain('value="1.25"');
    expect(markup).toContain('value="7.5"');
    expect(markup).toContain('<option value="Plum" selected="">Plum</option>');
    expect(markup).toContain('data-colormap="Plum"');
    expect(markup).toContain('<option value="KR (Balanced)" selected="">KR (Balanced)</option>');
    expect(markup.match(/placeholder="contig\[:start-end\]"/g)).toHaveLength(2);
  });
});
