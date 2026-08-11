import {
  Check,
  ChevronDown,
  Ellipsis,
  PanelRight,
  Plus,
  Redo2,
  Save,
  Undo2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from "react";
import type { AppStatus, ContactMapView, ExampleDatasetSummary } from "../App";
import {
  assemblyContigSelectionIntent,
  selectedBlockIds,
} from "../state/assemblyEditing";
import type { CoverageView } from "../state/coverageView";
import type { ContactTileRenderMilestone } from "../state/contactTilePerformance";
import type { SyntenyView } from "../state/syntenyView";
import {
  contactNormalizationForBackend,
  contactNormalizationLabel,
  type UiAction,
  type UiState,
} from "../state/uiState";
import {
  isEditableShortcutTarget,
  juiceboxShortcutIntent,
} from "../state/juiceboxShortcuts";
import { keyboardShortcutLabels } from "../state/keyboardShortcutLabels";
import { ContactMapViewport } from "./ContactMapViewport";
import { HeatmapToolbar } from "./HeatmapToolbar";
import { InspectorPanel } from "./InspectorPanel";
import {
  SyntenyDotplot,
  type SyntenySelectionModifiers,
} from "./SyntenyDotplot";

interface AppShellProps {
  dataset: ExampleDatasetSummary | null;
  contactMap: ContactMapView | null;
  overviewContactMap: ContactMapView | null;
  syntenyView: SyntenyView | null;
  coverageView: CoverageView | null;
  pafText: string;
  pafImported: boolean;
  onPafTextChange: (value: string) => void;
  agpInputRef: RefObject<HTMLInputElement>;
  pafInputRef: RefObject<HTMLInputElement>;
  coverageInputRef: RefObject<HTMLInputElement>;
  onAgpFileSelected: (file: File) => void;
  onContactFileSelected: () => void;
  onPafFileRequested: () => void;
  onPafFileSelected: (file: File) => void;
  onCoverageFileRequested: () => void;
  onCoverageFileSelected: (file: File) => void;
  onExportAgp: () => void;
  autoSaveEnabled: boolean;
  autoSaveAvailable: boolean;
  isAgpDirty: boolean;
  onAutoSaveEnabledChange: (enabled: boolean) => void;
  onLoadExample: () => void;
  status: AppStatus;
  statusMessage: string;
  uiState: UiState;
  onUiAction: (action: UiAction) => void;
  onContactTileLayerCommit?: (event: ContactTileRenderMilestone) => void;
  onContactTileLayerPaintComplete?: (event: ContactTileRenderMilestone) => void;
}

export const inspectorPanelMinWidth = 260;
export const inspectorPanelMaxWidth = 520;
const inspectorPanelDefaultWidth = 326;
const inspectorPanelCompactWidth = 276;
const inspectorPanelKeyboardStep = 16;

export function clampInspectorPanelWidth(width: number, workspaceWidth: number) {
  const responsiveMaximum = Math.max(
    inspectorPanelMinWidth,
    Math.min(inspectorPanelMaxWidth, workspaceWidth * 0.45),
  );
  return Math.round(Math.min(responsiveMaximum, Math.max(inspectorPanelMinWidth, width)));
}

function defaultInspectorPanelWidth() {
  return typeof window !== "undefined" && window.innerWidth <= 1180
    ? inspectorPanelCompactWidth
    : inspectorPanelDefaultWidth;
}

function fileName(path: string | undefined, fallback: string) {
  if (!path) {
    return fallback;
  }
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? fallback;
}

export function AppShell({
  dataset,
  contactMap,
  overviewContactMap,
  syntenyView,
  coverageView,
  pafText,
  pafImported,
  onPafTextChange,
  agpInputRef,
  pafInputRef,
  coverageInputRef,
  onAgpFileSelected,
  onContactFileSelected,
  onPafFileRequested,
  onPafFileSelected,
  onCoverageFileRequested,
  onCoverageFileSelected,
  onExportAgp,
  autoSaveEnabled,
  autoSaveAvailable,
  isAgpDirty,
  onAutoSaveEnabledChange,
  onLoadExample,
  onContactTileLayerCommit,
  onContactTileLayerPaintComplete,
  onUiAction,
  status,
  statusMessage,
  uiState,
}: AppShellProps) {
  const shortcuts = keyboardShortcutLabels();
  const workspaceRef = useRef<HTMLElement>(null);
  const inspectorResizeRef = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
  } | null>(null);
  const [inspectorWidth, setInspectorWidth] = useState<number | null>(null);
  const projectMenuRef = useRef<HTMLDetailsElement>(null);
  const addDataMenuRef = useRef<HTMLDetailsElement>(null);
  const appMenuRef = useRef<HTMLDetailsElement>(null);
  const hiddenAssemblyOverlaysRef = useRef<{
    chromosome: boolean;
    block: boolean;
    contig: boolean;
  } | null>(null);
  const syntenySelectionAnchorRef = useRef<string | null>(null);
  const agpImported = Boolean(dataset?.agp_path);
  const contactImported = Boolean(dataset?.mcool_path || dataset?.cool_path);
  const coverageImported = Boolean(dataset?.coverage_path);
  const activeAssemblyBlocks = uiState.assembly.blocks.length > 0
    ? uiState.assembly.blocks
    : dataset?.agp_layout.blocks ?? [];
  const activeAssemblyTotalBp = activeAssemblyBlocks.reduce(
    (largestEnd, block) => Math.max(largestEnd, block.visualEnd),
    0,
  );
  const totalSpanMb = Math.max(
    0.000001,
    (
      activeAssemblyTotalBp
      || dataset?.agp_layout.totalSpan
      || uiState.contact.totalSpanMb * 1_000_000
    ) / 1_000_000,
  );
  const selectedAssemblyBlockIds = selectedBlockIds(
    activeAssemblyBlocks,
    uiState.assembly.selection,
  );
  const selectedContactNormalization = contactNormalizationForBackend(uiState.normalization);
  const displayedContactNormalization = contactMap?.normalization;
  const displayedNormalizationLabel =
    displayedContactNormalization !== undefined
    && displayedContactNormalization !== selectedContactNormalization
      ? ` (showing ${contactNormalizationLabel(displayedContactNormalization)})`
      : "";
  const assemblyFileName = fileName(dataset?.agp_path, "Untitled assembly");
  const displayedAssemblyFileName = `${assemblyFileName}${isAgpDirty ? "*" : ""}`;

  function workspaceWidth() {
    return workspaceRef.current?.clientWidth
      ?? (typeof window === "undefined" ? 1_200 : window.innerWidth);
  }

  function currentInspectorWidth() {
    return workspaceRef.current
      ?.querySelector<HTMLElement>(".inspector")
      ?.getBoundingClientRect().width
      ?? inspectorWidth
      ?? defaultInspectorPanelWidth();
  }

  function setClampedInspectorWidth(width: number) {
    setInspectorWidth(clampInspectorPanelWidth(width, workspaceWidth()));
  }

  function beginInspectorResize(event: ReactPointerEvent<HTMLButtonElement>) {
    inspectorResizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: currentInspectorWidth(),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.documentElement.classList.add("inspector-resizing");
  }

  function resizeInspector(event: ReactPointerEvent<HTMLButtonElement>) {
    const resize = inspectorResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) {
      return;
    }
    setClampedInspectorWidth(resize.startWidth + resize.startX - event.clientX);
  }

  function endInspectorResize(event: ReactPointerEvent<HTMLButtonElement>) {
    if (inspectorResizeRef.current?.pointerId !== event.pointerId) {
      return;
    }
    inspectorResizeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    document.documentElement.classList.remove("inspector-resizing");
  }

  function handleInspectorResizeKey(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setClampedInspectorWidth(currentInspectorWidth() + inspectorPanelKeyboardStep);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setClampedInspectorWidth(currentInspectorWidth() - inspectorPanelKeyboardStep);
    } else if (event.key === "Home") {
      event.preventDefault();
      setInspectorWidth(null);
    }
  }

  function selectSyntenyBlock(id: string, modifiers: SyntenySelectionModifiers) {
    const intent = assemblyContigSelectionIntent(
      activeAssemblyBlocks,
      uiState.assembly.selection,
      syntenySelectionAnchorRef.current,
      id,
      modifiers,
    );
    syntenySelectionAnchorRef.current = intent.anchorId;
    if (intent.type === "clear") {
      onUiAction({ type: "clearAssemblySelection" });
    } else if (intent.type === "select-range") {
      onUiAction({ type: "selectAssemblyContigs", ids: intent.ids });
    } else {
      onUiAction({ type: "selectAssemblyContig", id: intent.id, additive: intent.additive });
    }
  }

  function selectSyntenyBlocks(ids: string[]) {
    syntenySelectionAnchorRef.current = null;
    onUiAction({ type: "selectAssemblyContigs", ids });
  }

  useEffect(() => {
    function handleJuiceboxShortcut(event: KeyboardEvent) {
      const intent = juiceboxShortcutIntent({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        repeat: event.repeat,
        editable: isEditableShortcutTarget(event.target),
      });
      if (!intent) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      if (intent === "save") {
        if (uiState.assembly.blocks.length > 0) {
          onExportAgp();
        }
        return;
      }
      if (intent === "undo") {
        if (uiState.operationHistory.length > 0) {
          onUiAction({ type: "undo" });
        }
        return;
      }
      if (intent === "redo") {
        if (uiState.redoStack.length > 0) {
          onUiAction({ type: "redo" });
        }
        return;
      }
      if (intent === "toggle-inspector") {
        onUiAction({ type: "toggleLayoutPanel", panel: "right" });
        return;
      }
      if (intent === "open-file-menu") {
        addDataMenuRef.current?.setAttribute("open", "");
        addDataMenuRef.current?.querySelector<HTMLElement>("summary")?.focus();
        return;
      }

      const { showChromosomeBoxes, showBlockBoxes, showContigBoxes } = uiState.assembly;
      if (showChromosomeBoxes || showBlockBoxes || showContigBoxes) {
        hiddenAssemblyOverlaysRef.current = {
          chromosome: showChromosomeBoxes,
          block: showBlockBoxes,
          contig: showContigBoxes,
        };
        onUiAction({
          type: "setAssemblyOverlayVisibility",
          chromosome: false,
          block: false,
          contig: false,
        });
        return;
      }

      const overlaysToRestore = hiddenAssemblyOverlaysRef.current ?? {
        chromosome: true,
        block: true,
        contig: true,
      };
      hiddenAssemblyOverlaysRef.current = null;
      onUiAction({
        type: "setAssemblyOverlayVisibility",
        chromosome: overlaysToRestore.chromosome,
        block: overlaysToRestore.block,
        contig: overlaysToRestore.contig,
      });
    }

    window.addEventListener("keydown", handleJuiceboxShortcut, true);
    return () => window.removeEventListener("keydown", handleJuiceboxShortcut, true);
  }, [
    onExportAgp,
    onUiAction,
    uiState.assembly,
    uiState.operationHistory.length,
    uiState.redoStack.length,
  ]);

  useEffect(() => () => {
    document.documentElement.classList.remove("inspector-resizing");
  }, []);

  useEffect(() => {
    function closeToolbarMenusOutside(event: PointerEvent) {
      for (const menu of [projectMenuRef.current, addDataMenuRef.current]) {
        if (menu?.open && !menu.contains(event.target as Node)) {
          menu.open = false;
        }
      }
    }

    function closeToolbarMenusWithEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }
      for (const menu of [projectMenuRef.current, addDataMenuRef.current]) {
        if (menu?.open) {
          menu.open = false;
          menu.querySelector<HTMLElement>("summary")?.focus();
        }
      }
    }

    document.addEventListener("pointerdown", closeToolbarMenusOutside);
    window.addEventListener("keydown", closeToolbarMenusWithEscape);
    return () => {
      document.removeEventListener("pointerdown", closeToolbarMenusOutside);
      window.removeEventListener("keydown", closeToolbarMenusWithEscape);
    };
  }, []);

  function runAddDataAction(action: () => void) {
    addDataMenuRef.current?.removeAttribute("open");
    action();
  }

  return (
    <main className="app-shell">
      <header className="app-toolbar-stack">
        <div className="global-toolbar">
          <div className="global-toolbar-leading">
            <div className="brand" aria-label="C-Studio">
              <img className="brand-mark" src="/src-tauri/icons/icon.png" alt="" />
              <strong>C-Studio</strong>
            </div>

            <details ref={projectMenuRef} className="toolbar-disclosure project-menu-disclosure">
              <summary className="project-picker" aria-label="Current assembly project menu">
                <span>{displayedAssemblyFileName}</span>
                <ChevronDown size={14} aria-hidden="true" />
              </summary>
              <div className="toolbar-popover project-menu-popover">
                <label
                  className={`project-menu-toggle${autoSaveAvailable ? "" : " disabled"}`}
                  title={autoSaveAvailable
                    ? "Save automatically 5 seconds after changes"
                    : "Save As once to enable auto-save"}
                >
                  <span>Auto-save</span>
                  <input
                    type="checkbox"
                    aria-label="Auto-save"
                    checked={autoSaveAvailable && autoSaveEnabled}
                    disabled={!autoSaveAvailable}
                    onChange={(event) => onAutoSaveEnabledChange(event.currentTarget.checked)}
                  />
                </label>
              </div>
            </details>

            <span className={`project-health ${agpImported ? "ready" : "idle"}`} aria-label={agpImported ? "Assembly loaded" : "Assembly not loaded"} />

            <details ref={addDataMenuRef} className="toolbar-disclosure add-data-disclosure">
              <summary
                className="global-action-button"
                aria-keyshortcuts="F10"
                title="Open data menu (F10)"
              >
                <Plus size={15} aria-hidden="true" />
                <span>Add Data</span>
                <ChevronDown size={13} aria-hidden="true" />
              </summary>
              <div className="toolbar-popover add-data-popover" aria-label="Add data">
                <button type="button" onClick={() => runAddDataAction(() => agpInputRef.current?.click())}>
                  <span>Assembly (.agp)</span>
                  {agpImported ? <Check size={14} aria-label="Loaded" /> : null}
                </button>
                <button type="button" onClick={() => runAddDataAction(onContactFileSelected)}>
                  <span>Contact map (.cool/.mcool)</span>
                  {contactImported ? <Check size={14} aria-label="Loaded" /> : null}
                </button>
                <button type="button" onClick={() => runAddDataAction(onPafFileRequested)}>
                  <span>Synteny alignments (.paf)</span>
                  {pafImported ? <Check size={14} aria-label="Loaded" /> : null}
                </button>
                <button type="button" onClick={() => runAddDataAction(onCoverageFileRequested)}>
                  <span>Coverage track</span>
                  {coverageImported ? <Check size={14} aria-label="Loaded" /> : null}
                </button>
                <span className="popover-divider" aria-hidden="true" />
                <button type="button" onClick={() => runAddDataAction(onLoadExample)}>
                  <span>Load example project</span>
                </button>
              </div>
            </details>
          </div>

          <div className="global-toolbar-trailing" aria-label="Project actions">
            <input
              ref={agpInputRef}
              className="file-input"
              type="file"
              accept=".agp,.txt"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) {
                  onAgpFileSelected(file);
                }
                event.currentTarget.value = "";
              }}
            />
            <input
              ref={pafInputRef}
              className="file-input"
              type="file"
              accept=".paf,.txt"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) {
                  onPafFileSelected(file);
                }
                event.currentTarget.value = "";
              }}
            />
            <input
              ref={coverageInputRef}
              className="file-input"
              type="file"
              accept=".bedgraph,.bedGraph,.bg,.txt"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) {
                  onCoverageFileSelected(file);
                }
                event.currentTarget.value = "";
              }}
            />

            <button
              className="global-icon-button"
              type="button"
              aria-label="Undo"
              aria-keyshortcuts="Control+Z Meta+Z Control+U Meta+U"
              title={`Undo (${shortcuts.undo}; Juicebox: ${shortcuts.legacyUndo})`}
              disabled={uiState.operationHistory.length === 0}
              onClick={() => onUiAction({ type: "undo" })}
            >
              <Undo2 size={16} aria-hidden="true" />
            </button>
            <button
              className="global-icon-button"
              type="button"
              aria-label="Redo"
              aria-keyshortcuts="Meta+Shift+Z Control+Y Control+R Meta+R"
              title={`Redo (${shortcuts.redo}; Juicebox: ${shortcuts.legacyRedo})`}
              disabled={uiState.redoStack.length === 0}
              onClick={() => onUiAction({ type: "redo" })}
            >
              <Redo2 size={16} aria-hidden="true" />
            </button>
            <span className="toolbar-hairline" aria-hidden="true" />
            <button
              className="global-icon-button export-project-button"
              type="button"
              aria-label="Save edited AGP"
              aria-keyshortcuts="Control+S Meta+S"
              title={`Save edited AGP (${shortcuts.save})`}
              disabled={!uiState.assembly.blocks.length}
              onClick={onExportAgp}
            >
              <Save size={16} aria-hidden="true" />
            </button>
            <button
              className={`global-icon-button${uiState.layout.rightCollapsed ? "" : " active"}`}
              type="button"
              aria-label={uiState.layout.rightCollapsed ? "Show inspector" : "Hide inspector"}
              aria-keyshortcuts="F9"
              title="Show or hide inspector (F9)"
              aria-pressed={!uiState.layout.rightCollapsed}
              onClick={() => onUiAction({ type: "toggleLayoutPanel", panel: "right" })}
            >
              <PanelRight size={16} aria-hidden="true" />
            </button>
            <details ref={appMenuRef} className="toolbar-disclosure app-menu-disclosure">
              <summary className="global-icon-button" aria-label="More project information">
                <Ellipsis size={17} aria-hidden="true" />
              </summary>
              <div className="toolbar-popover app-menu-popover">
                <p><span>Core</span><strong>{status.engine}</strong></p>
                <p><span>Coordinates</span><strong>{status.coordinate_convention}</strong></p>
                <p><span>Status</span><strong>{statusMessage}</strong></p>
                <span className="popover-divider" aria-hidden="true" />
                <section className="app-shortcuts" aria-label="Keyboard shortcuts">
                  <h3>Keyboard shortcuts</h3>
                  <dl>
                    <div><dt>Save AGP</dt><dd>{shortcuts.save}</dd></div>
                    <div><dt>Undo</dt><dd>{shortcuts.undo}</dd></div>
                    <div><dt>Redo</dt><dd>{shortcuts.redo}</dd></div>
                    <div><dt>Rename</dt><dd>{shortcuts.rename}</dd></div>
                    <div><dt>Reverse / rotate</dt><dd>{shortcuts.reverse}</dd></div>
                    <div><dt>Copy</dt><dd>{shortcuts.copy}</dd></div>
                    <div><dt>Move to debris</dt><dd>{shortcuts.moveToDebris}</dd></div>
                    <div><dt>Delete gap / join</dt><dd>{shortcuts.deleteGap}</dd></div>
                    <div><dt>Delete contig</dt><dd>{shortcuts.deleteContig}</dd></div>
                    <div><dt>Deselect / cancel</dt><dd>Esc</dd></div>
                    <div><dt>Toggle annotations</dt><dd>F2</dd></div>
                    <div><dt>Toggle inspector</dt><dd>F9</dd></div>
                    <div><dt>Open data menu</dt><dd>F10</dd></div>
                  </dl>
                </section>
              </div>
            </details>
          </div>
        </div>

        <HeatmapToolbar uiState={uiState} onUiAction={onUiAction} totalSpanMb={totalSpanMb} />
      </header>

      <section
        ref={workspaceRef}
        className={`workspace${uiState.layout.rightCollapsed ? " right-collapsed" : ""}`}
        style={inspectorWidth === null
          ? undefined
          : ({ "--inspector-width": `${inspectorWidth}px` } as CSSProperties)}
      >
        <section className="center-workspace" aria-label="Assembly contact map workspace">
          <section className="map-stack">
            <section className={`main-view${uiState.layout.syntenySplitOpen ? " split-open" : ""}`}>
              <ContactMapViewport
                dataset={dataset}
                contactMap={contactMap}
                coverageView={coverageView}
                uiState={uiState}
                onUiAction={onUiAction}
                onContactTileLayerCommit={onContactTileLayerCommit}
                onContactTileLayerPaintComplete={onContactTileLayerPaintComplete}
              />
              {uiState.layout.syntenySplitOpen ? (
                <aside className="synteny-split-pane" aria-label="Synteny split view">
                  <div className="split-pane-header">
                    <strong>Synteny</strong>
                    <button
                      className="global-icon-button"
                      type="button"
                      aria-label="Close synteny split view"
                      onClick={() => onUiAction({ type: "setSyntenySplitOpen", open: false })}
                    >
                      ×
                    </button>
                  </div>
                  <SyntenyDotplot
                    syntenyView={syntenyView}
                    totalSpanMb={totalSpanMb}
                    assemblyBlocks={activeAssemblyBlocks}
                    selectedAssemblyBlockIds={selectedAssemblyBlockIds}
                    onSelectBlock={selectSyntenyBlock}
                    onSelectBlocks={selectSyntenyBlocks}
                    uiState={uiState}
                    onUiAction={onUiAction}
                  />
                </aside>
              ) : null}
            </section>
          </section>
        </section>

        {uiState.layout.rightCollapsed ? null : (
          <>
            <button
              type="button"
              className="inspector-resize-handle"
              role="separator"
              aria-label="Resize inspector"
              aria-orientation="vertical"
              aria-valuemin={inspectorPanelMinWidth}
              aria-valuemax={inspectorPanelMaxWidth}
              aria-valuenow={Math.round(inspectorWidth ?? defaultInspectorPanelWidth())}
              title="Drag to resize inspector; double-click to reset"
              onPointerDown={beginInspectorResize}
              onPointerMove={resizeInspector}
              onPointerUp={endInspectorResize}
              onPointerCancel={endInspectorResize}
              onDoubleClick={() => setInspectorWidth(null)}
              onKeyDown={handleInspectorResizeKey}
            />
            <InspectorPanel
              dataset={dataset}
              contactMap={contactMap}
              overviewContactMap={overviewContactMap}
              status={status}
              statusMessage={statusMessage}
              isAgpDirty={isAgpDirty}
              uiState={uiState}
              onUiAction={onUiAction}
              syntenyView={syntenyView}
              assemblyBlocks={activeAssemblyBlocks}
              selectedAssemblyBlockIds={selectedAssemblyBlockIds}
              pafText={pafText}
              onPafTextChange={onPafTextChange}
            />
          </>
        )}
      </section>

      <footer className="status-bar" role="status" aria-live="polite">
        <span>Resolution: {uiState.contact.resolution}</span>
        <span>
          Normalization: {uiState.normalization}{displayedNormalizationLabel}
        </span>
        <span>Matrix: {fileName(dataset?.mcool_path ?? dataset?.cool_path, "None")}</span>
        <span>Assembly: {dataset?.agp_path ? displayedAssemblyFileName : "None"}</span>
        <span>Tool: {uiState.selectedTool}</span>
        <span>X: {uiState.contact.viewportCenterXMb.toFixed(2)} Mb</span>
        <span>Y: {uiState.contact.viewportCenterYMb.toFixed(2)} Mb</span>
        <strong>{statusMessage}</strong>
      </footer>
    </main>
  );
}
