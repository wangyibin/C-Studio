import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createInitialUiState } from "../state/uiState";
import { ContactControls } from "./ContactControls";

describe("ContactControls", () => {
  it("shows color range tick labels from the active color scale", () => {
    const uiState = createInitialUiState("ready");
    uiState.contact.colorScale = {
      ...uiState.contact.colorScale,
      min: 2.5,
      max: 10,
      auto: false,
    };

    const markup = renderToStaticMarkup(
      <ContactControls uiState={uiState} onUiAction={() => undefined} onLoadExample={() => undefined} />,
    );

    expect(markup).toContain(
      '<div class="color-range-scale"><span>2.5</span><span>6.25</span><span>10</span></div>',
    );
  });

  it("renders editable color range controls for min and max", () => {
    const uiState = createInitialUiState("ready");
    uiState.contact.colorScale = {
      ...uiState.contact.colorScale,
      min: 1.25,
      max: 7.5,
      auto: false,
    };

    const markup = renderToStaticMarkup(
      <ContactControls uiState={uiState} onUiAction={() => undefined} onLoadExample={() => undefined} />,
    );

    expect(markup).toContain('aria-label="Color range minimum"');
    expect(markup).toContain('aria-label="Color range maximum"');
    expect(markup).toContain('type="text"');
    expect(markup).toContain('value="1.25"');
    expect(markup).toContain('value="7.5"');
  });

  it("keeps slider bounds large enough for imported color ranges", () => {
    const uiState = createInitialUiState("ready");
    uiState.contact.colorScale = {
      ...uiState.contact.colorScale,
      min: 17.3,
      max: 590,
      auto: true,
    };

    const markup = renderToStaticMarkup(
      <ContactControls uiState={uiState} onUiAction={() => undefined} onLoadExample={() => undefined} />,
    );

    expect(markup).toContain('class="color-range-input color-range-max"');
    expect(markup).toContain('max="600"');
    expect(markup).toContain('value="590"');
  });

  it("places color range tick labels directly below the slider", () => {
    const uiState = createInitialUiState("ready");

    const markup = renderToStaticMarkup(
      <ContactControls uiState={uiState} onUiAction={() => undefined} onLoadExample={() => undefined} />,
    );
    const sliderIndex = markup.indexOf('<div class="color-range-controls">');
    const scaleIndex = markup.indexOf('<div class="color-range-scale">');
    const numberRowIndex = markup.indexOf('<div class="color-range-number-row">');

    expect(sliderIndex).toBeGreaterThan(-1);
    expect(scaleIndex).toBeGreaterThan(sliderIndex);
    expect(numberRowIndex).toBeGreaterThan(scaleIndex);
  });

  it("shows a one-click import example button in the left control column", () => {
    const uiState = createInitialUiState("ready");

    const markup = renderToStaticMarkup(
      <ContactControls uiState={uiState} onUiAction={() => undefined} onLoadExample={() => undefined} />,
    );

    expect(markup).toContain("Import example");
    expect(markup).toContain("Example Dataset");
  });

  it("renders an unlocked resolution control by default", () => {
    const uiState = createInitialUiState("ready");

    const markup = renderToStaticMarkup(
      <ContactControls uiState={uiState} onUiAction={() => undefined} onLoadExample={() => undefined} />,
    );

    expect(markup).toContain('class="range-lock"');
    expect(markup).toContain('aria-label="Lock resolution"');
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).toContain('title="Lock resolution during zoom"');
    expect(markup).toContain('class="lucide lucide-pin"');
    expect(markup).not.toContain('class="lucide lucide-unlock"');
    expect(markup).toContain('<span>500 KB</span>');
    expect(markup).not.toContain('<span>2.5 MB</span>');
  });

  it("shows a visible and accessible locked resolution state", () => {
    const uiState = createInitialUiState("ready");
    uiState.contact.resolutionLocked = true;

    const markup = renderToStaticMarkup(
      <ContactControls uiState={uiState} onUiAction={() => undefined} onLoadExample={() => undefined} />,
    );

    expect(markup).toContain('class="range-lock locked"');
    expect(markup).toContain('aria-label="Unlock resolution"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('title="Resolution locked at 500 kb"');
    expect(markup).toContain('class="lucide lucide-pin"');
    expect(markup).not.toContain('class="lucide lucide-lock"');
  });

  it("offers independent chromosome, block, and child-contig box controls", () => {
    const uiState = createInitialUiState("ready");

    const markup = renderToStaticMarkup(
      <ContactControls uiState={uiState} onUiAction={() => undefined} onLoadExample={() => undefined} />,
    );

    expect(markup).toContain("Chromosome boxes");
    expect(markup).toContain("Block boxes");
    expect(markup).toContain("Contig boxes");
    expect(markup).toContain('class="box-swatch block-swatch"');
    expect(markup).toContain('class="box-swatch contig-swatch"');
  });

});
