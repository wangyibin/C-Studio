// @ts-expect-error Vitest executes this contract test in Node; the app tsconfig intentionally omits Node globals.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const viewportSource = readFileSync(new URL("./ContactMapViewport.tsx", import.meta.url), "utf8");
const contextMenuSource = readFileSync(new URL("./AssemblyContextMenu.tsx", import.meta.url), "utf8");
const inspectorSource = readFileSync(new URL("./InspectorPanel.tsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
const confirmedStylesStart = styles.lastIndexOf(":root {");
const confirmedRedesignStyles = confirmedStylesStart >= 0 ? styles.slice(confirmedStylesStart) : styles;

describe("confirmed contact map layout styles", () => {
  it("keeps the GFA expand button visible while truncating long preview metadata", () => {
    expect(styles).toMatch(
      /\.gfa-preview-header\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0, 1fr\) 18px;[^}]*overflow:\s*hidden;/,
    );
    expect(styles).toMatch(
      /\.gfa-preview-header \.gfa-preview-expand-button\s*\{[^}]*min-width:\s*18px;[^}]*max-width:\s*18px;/,
    );
    expect(styles).toMatch(
      /\.gfa-preview-title\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;/,
    );
    expect(styles).toMatch(
      /\.gfa-preview-stats dt,[\s\S]*?\.gfa-preview-stats dd\s*\{[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/,
    );
  });

  it("provides a responsive draggable inspector column", () => {
    expect(confirmedRedesignStyles).toContain("var(--inspector-width, 280px)");
    expect(confirmedRedesignStyles).toContain(".inspector-resize-handle");
    expect(confirmedRedesignStyles).toContain("cursor: col-resize;");
    expect(confirmedRedesignStyles).toContain("touch-action: none;");
  });

  it("lets inspector width drive a stable square heatmap overview", () => {
    expect(confirmedRedesignStyles).toMatch(
      /\.inspector \.inspector-overview:not\(\.synteny-overview-active\):not\(\.gfa-overview-active\) \.interactive-overview\s*\{[^}]*width:\s*100%;[^}]*height:\s*auto;[^}]*aspect-ratio:\s*1 \/ 1;/,
    );
  });

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
    expect(styles).toMatch(
      /\.coverage-reference-line\s*\{[\s\S]*?border-top:\s*1px dashed/,
    );
    expect(styles).toMatch(
      /\.coverage-reference-line\s*\{[\s\S]*?rgba\(58, 58, 60, 0\.82\)/,
    );
    expect(styles).toMatch(
      /\.coverage-controls\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) 18px;/,
    );
    expect(styles).toMatch(
      /\.coverage-visibility-control\s*\{[^}]*position:\s*static;/,
    );
    expect(styles).toMatch(
      /\.coverage-scale-control\s*\{[^}]*position:\s*relative;/,
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
      "const displayResolution = contactResolutionToBasePairs(uiState.contact.resolution)",
    );
    expect(appSource).toContain("const coverageLayoutBlocks = placeHiddenChromosomeBlocksAfter(");
    expect(appSource).toContain("Math.ceil(viewport.xEnd / displayResolution) * displayResolution");
    expect(appSource).toContain("coverageLayoutBlocks,\n      totalSpanBp,");
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
      'const commitAction = contactPanCommitAction(',
    );
    expect(viewportSource).toContain(
      'type: "commitContactViewportPan"',
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
    expect(contextMenuSource).toContain("Deselect");
    expect(viewportSource).toContain("<AssemblyContextMenu");
    expect(viewportSource).toContain('onContextMenu={openContextMenu}');
    expect(contextMenuSource).toContain('run({ type: "clearAssemblySelection" })');
  });

  it("shows and wires the curation shortcuts without direct destructive deletion", () => {
    expect(contextMenuSource).toContain("keyboardShortcutLabels");
    expect(contextMenuSource).toContain("<kbd>{shortcuts.rename}</kbd>");
    expect(contextMenuSource).toContain("<kbd>{shortcuts.copy}</kbd>");
    expect(contextMenuSource).toContain("<kbd>{shortcuts.moveToDebris}</kbd>");
    expect(contextMenuSource).toContain("<kbd>{shortcuts.deleteContig}</kbd>");
    expect(viewportSource).toContain("assemblyShortcutIntent");
    expect(viewportSource).toContain('openShortcutMenu("rename")');
    expect(viewportSource).toContain('openShortcutMenu("delete")');
    expect(viewportSource).toContain("deleteConfirmationOpenRef.current");
  });

  it("lets context-menu rows grow with wrapped labels instead of overlapping", () => {
    expect(styles).toMatch(
      /\.context-menu\s*\{[^}]*grid-auto-rows:\s*minmax\(32px, auto\);[^}]*width:\s*218px;/,
    );
    expect(styles).toMatch(
      /\.context-menu button\s*\{[^}]*min-height:\s*32px;[^}]*height:\s*auto;[^}]*font-size:\s*13px;[^}]*line-height:\s*1\.25;[^}]*overflow-wrap:\s*anywhere;/,
    );
  });

  it("reflows selected chromosome contigs without hiding their names", () => {
    expect(styles).toMatch(
      /\.selection-contig-label\s*\{[^}]*font-size:\s*10px;/,
    );
    expect(styles).toMatch(
      /\.selection-group\.selected \.selection-group-list\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit, minmax\(84px, 1fr\)\);/,
    );
    expect(styles).toMatch(
      /\.selection-group\.selected \.selection-contig-label\s*\{[^}]*font-size:\s*10px;[^}]*overflow-wrap:\s*anywhere;[^}]*white-space:\s*normal;/,
    );
    expect(styles).toMatch(
      /\.selection-group\.selected \.selection-chip\s*\{[^}]*height:\s*auto;[^}]*padding:\s*5px;/,
    );
  });

  it("uses the compact size for chromosome counts and block names", () => {
    expect(styles).toMatch(
      /\.selection-group-header strong\s*\{[^}]*font-size:\s*14px;/,
    );
    expect(styles).toMatch(
      /\.selection-block-label\s*\{[^}]*font-size:\s*14px;/,
    );
    expect(inspectorSource).toContain(
      'block.isComposite ? "selection-block-label" : "selection-contig-label"',
    );
  });

  it("uses the compact contig-name size in the contig information heading", () => {
    expect(styles).toMatch(
      /\.contig-occurrences:not\(\.block-details\) \.contig-occurrence-heading button span\s*\{[^}]*font-size:\s*12px;/,
    );
  });

  it("uses the compact contig-name size in copy and segment lists", () => {
    expect(styles).toMatch(
      /\.contig-other-locations button span\s*\{[^}]*font-size:\s*12px;/,
    );
  });

  it("renames a chromosome inline from its inspector header", () => {
    expect(inspectorSource).toContain("onDoubleClick={() => beginChromosomeRename(group.id)}");
    expect(inspectorSource).toContain('aria-label={`Rename chromosome ${group.id}`}');
    expect(inspectorSource).toContain("assemblyRenameValidationError");
    expect(inspectorSource).toContain('onUiAction({ type: "renameAssemblySelection", name })');
    expect(inspectorSource).toContain('if (event.key === "Escape")');
  });

  it("offers gap deletion only through the shared block-aware context menu", () => {
    expect(contextMenuSource).toContain("hasDeletableGap");
    expect(contextMenuSource).toContain("Delete gap / join blocks");
    expect(contextMenuSource).toContain('run({ type: "deleteAssemblyGaps" })');
  });

  it("requires explicit confirmation before deleting selected contigs", () => {
    expect(contextMenuSource).toContain("Delete contig…");
    expect(contextMenuSource).toContain('role="alertdialog"');
    expect(contextMenuSource).toContain("It will not be kept in debris");
    expect(contextMenuSource).toContain("Only copy — none remain");
    expect(contextMenuSource).toContain("copies removed — none remain");
    expect(contextMenuSource).toContain("copies remain");
    expect(contextMenuSource).toContain("Split copy · ${details.currentCopy.blocks.length} segments");
    expect(contextMenuSource).toContain("remaining copy is split");
    expect(contextMenuSource).toContain('run({ type: "deleteAssemblySelection" })');
    expect(contextMenuSource).toContain("canDeleteContigs");
  });

  it("offers chromosome-boundary removal only when the selection encloses a boundary", () => {
    expect(contextMenuSource).toContain("hasRemovableChromosomeBoundary");
    expect(contextMenuSource).toContain("Remove chr boundaries");
    expect(contextMenuSource).toContain('run({ type: "removeAssemblyChromosomeBoundaries" })');
  });

  it("offers an inline rename action for one selected contig or chromosome", () => {
    expect(contextMenuSource).toContain("Rename…");
    expect(contextMenuSource).toContain("assemblyRenameTarget");
    expect(contextMenuSource).toContain('run({ type: "renameAssemblySelection"');
    expect(contextMenuSource).toContain("New ${renameTarget.kind} name");
    expect(viewportSource).toContain("isEditableShortcutTarget(event.target)");
  });

  it("hides edit handles while Shift is acting as the range-selection modifier", () => {
    expect(styles).toMatch(
      /\.shift-selection-active \.assembly-rotate-button,[\s\S]*?\.shift-selection-active \.assembly-resize-handle,[\s\S]*?\.shift-selection-active \.contig-handle,[\s\S]*?\.shift-selection-active \.assembly-cut-marker,[\s\S]*?\.shift-selection-active \.assembly-insert-marker\s*\{[\s\S]*?visibility:\s*hidden;[\s\S]*?pointer-events:\s*none !important;/,
    );
  });

  it("renders the insertion arrow in black", () => {
    expect(styles).toMatch(
      /\.assembly-insert-marker\s*\{[^}]*color:\s*#000;/,
    );
  });

  it("shows chromosome-end insertion as hover-only frameless diagonal arrows", () => {
    expect(styles).toMatch(
      /\.assembly-chromosome-end-target\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent;[^}]*color:\s*#000;/,
    );
    expect(styles).toMatch(
      /\.assembly-chromosome-end-target\.end\s*\{[^}]*translate\(-100%, -100%\)/,
    );
    expect(styles).toMatch(
      /\.assembly-chromosome-end-target\.start\s*\{[^}]*translate\(0, 0\)/,
    );
    expect(viewportSource).toContain("<ArrowDownRight");
    expect(viewportSource).toContain("<ArrowUpLeft");
    expect(viewportSource).toMatch(
      /pointerState\.kind === "insert"[\s\S]*?pointerState\.chromosomeEnd[\s\S]*?assembly-chromosome-end-target/,
    );
  });

  it("renders a frameless cut marker with upper-left scissors and an exact cut point", () => {
    expect(styles).toMatch(
      /\.assembly-cut-marker\s*\{[^}]*background:\s*transparent;[^}]*border:\s*0;[^}]*box-shadow:\s*none;/,
    );
    expect(styles).toMatch(
      /\.assembly-cut-marker > svg\s*\{[^}]*rotate\(-135deg\);/,
    );
    expect(styles).toMatch(
      /\.assembly-overlay\.cut-preview-active,[\s\S]*?\.assembly-overlay\.cut-preview-active \.assembly-box\s*\{[^}]*cursor:\s*none;/,
    );
    expect(styles).toMatch(/\.assembly-cut-guide\s*\{[^}]*background:\s*#facc15;/);
    expect(styles).toMatch(/\.assembly-cut-point\s*\{[^}]*background:\s*#facc15;/);
  });

  it("replays the last heatmap pointer before paint when viewport geometry changes", () => {
    expect(viewportSource).toContain("lastAssemblyPointerRef.current = pointer");
    expect(viewportSource).toMatch(
      /usePrePaintEffect\(\(\) => \{[\s\S]*?lastAssemblyPointerRef\.current[\s\S]*?refreshAssemblyHoverAtClientPosition\(pointer\)[\s\S]*?uiState\.contact\.resolution/,
    );
    expect(viewportSource).toMatch(
      /onPointerLeave=\{\(\) => \{[\s\S]*?lastAssemblyPointerRef\.current = null;/,
    );
    expect(viewportSource).toContain("lockedCutBlockId: assemblyPointerStateRef.current.kind");
  });
});
