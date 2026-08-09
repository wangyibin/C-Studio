// @ts-expect-error Vitest executes this contract test in Node; the app tsconfig intentionally omits Node globals.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const viewportSource = readFileSync(new URL("./ContactMapViewport.tsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
const confirmedStylesStart = styles.lastIndexOf(":root {");
const confirmedRedesignStyles = confirmedStylesStart >= 0 ? styles.slice(confirmedStylesStart) : styles;

describe("confirmed contact map layout styles", () => {
  it("lets the outer heatmap stage consume independent available width and height", () => {
    expect(confirmedRedesignStyles).toContain(
      "grid-template-columns: 58px minmax(0, 1fr) 42px;",
    );
    expect(confirmedRedesignStyles).toContain(
      "grid-template-rows: 27px minmax(0, 1fr) 39px;",
    );
    expect(confirmedRedesignStyles).toMatch(
      /\.heatmap-stage\s*\{[\s\S]*?width:\s*100%;[\s\S]*?height:\s*100%;[\s\S]*?aspect-ratio:\s*auto;/,
    );
  });

  it("places the coverage track above the heatmap on their shared X grid", () => {
    expect(confirmedRedesignStyles).toMatch(
      /\.map-content\.has-coverage-track\s*\{[\s\S]*?"coverage-gutter coverage-track coverage-end"[\s\S]*?"ticks-y stage navigator-y"[\s\S]*?"bottom-corner navigator-x navigator-corner";/,
    );
    expect(styles).toMatch(
      /\.coverage-bars\s*\{[\s\S]*?grid-area:\s*coverage-track;/,
    );
    expect(viewportSource).toContain("<TrackPanel");
    expect(confirmedRedesignStyles).toContain(
      "grid-template-rows: 27px clamp(42px, 6.5vh, 59px) minmax(0, 1fr) 39px;",
    );
    expect(confirmedRedesignStyles).toContain(
      "grid-template-rows: 24px 36px minmax(0, 1fr) 34px;",
    );
    expect(styles).toMatch(
      /\.coverage-chromosome-grid\s*\{[\s\S]*?pointer-events:\s*none;/,
    );
    expect(styles).not.toContain(
      "repeating-linear-gradient(90deg, transparent 0 9.9%",
    );
    expect(styles).toMatch(
      /\.coverage-range-selection-preview\s*\{[\s\S]*?pointer-events:\s*none;/,
    );
  });

  it("queries coverage with the current heatmap X viewport and resolution", () => {
    expect(appSource).toContain(
      "displayResolution: contactResolutionToBasePairs(uiState.contact.resolution)",
    );
    expect(appSource).toContain("centerXMb: uiState.contact.viewportCenterXMb");
    expect(appSource).toContain("windowSizeBp: uiState.contact.viewportSpanMb * 1_000_000");
    expect(appSource).toContain("uiState.contact.viewportCenterXMb,");
    expect(appSource).toContain("uiState.contact.viewportWidthPx,");
    expect(appSource).toContain("uiState.contact.viewportHeightPx,");
  });

  it("keeps chromosome names hover-only while the viewport window remains draggable", () => {
    expect(confirmedRedesignStyles).toMatch(
      /\.genome-axis-window-group\s*\{\s*pointer-events:\s*none;/,
    );
    expect(confirmedRedesignStyles).not.toContain(".genome-axis-object-labels");
  });

  it("keeps slim navigator rails inside their layout cells", () => {
    expect(confirmedRedesignStyles).toMatch(
      /\.genome-navigator-shell\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);[^}]*grid-template-rows:\s*minmax\(0, 1fr\);[^}]*overflow:\s*hidden;/,
    );
    expect(confirmedRedesignStyles).toMatch(
      /\.genome-axis-navigator\s*\{[^}]*min-width:\s*0;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/,
    );
    expect(confirmedRedesignStyles).toMatch(
      /\.genome-axis-rail\s*\{[^}]*position:\s*absolute;[^}]*overflow:\s*hidden;/,
    );
    expect(confirmedRedesignStyles).toMatch(
      /\.genome-axis-navigator\.axis-x \.genome-axis-rail\s*\{[^}]*width:\s*100%;[^}]*height:\s*10px;/,
    );
    expect(confirmedRedesignStyles).toMatch(
      /\.genome-axis-navigator\.axis-y \.genome-axis-rail\s*\{[^}]*width:\s*10px;[^}]*height:\s*100%;/,
    );
    expect(confirmedRedesignStyles).not.toMatch(
      /\.genome-axis-rail\s*\{[^}]*overflow:\s*visible;/,
    );
  });

  it("handles heatmap wheels as non-passive panning instead of zooming", () => {
    expect(viewportSource).toContain(
      'stage.addEventListener("wheel", handleWheelPan, { passive: false });',
    );
    expect(viewportSource).toContain(
      'onUiAction({ type: "panContactViewport", deltaXMb, deltaYMb });',
    );
    expect(viewportSource).not.toContain("contactWheelZoomIntent");
    expect(viewportSource).not.toContain("onWheel={zoomWithWheel}");
  });

  it("protects the heatmap from the inspector in compact preview widths", () => {
    expect(confirmedRedesignStyles).toContain("@media (max-width: 760px)");
    expect(confirmedRedesignStyles).toMatch(
      /@media \(max-width: 760px\)[\s\S]*?\.workspace \.inspector\s*\{\s*display:\s*none;/,
    );
  });

  it("offers Deselect from the shared heatmap and coverage context menu", () => {
    expect(viewportSource).toContain("Deselect");
    expect(viewportSource).toContain('onContextMenu={openContextMenu}');
    expect(viewportSource).toContain('onUiAction({ type: "clearAssemblySelection" });');
  });

  it("hides edit handles while Shift is acting as the range-selection modifier", () => {
    expect(styles).toMatch(
      /\.shift-selection-active \.assembly-rotate-button,[\s\S]*?\.shift-selection-active \.assembly-resize-handle,[\s\S]*?\.shift-selection-active \.contig-handle,[\s\S]*?\.shift-selection-active \.assembly-insert-marker\s*\{[\s\S]*?visibility:\s*hidden;[\s\S]*?pointer-events:\s*none !important;/,
    );
  });
});
