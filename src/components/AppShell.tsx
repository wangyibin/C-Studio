import {
  Check,
  ChevronDown,
  Download,
  Ellipsis,
  PanelRight,
  Plus,
  Redo2,
  Undo2,
} from "lucide-react";
import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import type { AppStatus, ContactMapView, ExampleDatasetSummary } from "../App";
import type { CoverageView } from "../state/coverageView";
import type { SyntenyView } from "../state/syntenyView";
import type { UiAction, UiState } from "../state/uiState";
import {
  isEditableShortcutTarget,
  juiceboxShortcutIntent,
} from "../state/juiceboxShortcuts";
import { ContactMapViewport } from "./ContactMapViewport";
import { HeatmapToolbar } from "./HeatmapToolbar";
import { InspectorPanel } from "./InspectorPanel";
import { SyntenyDotplot } from "./SyntenyDotplot";

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
  onLoadExample: () => void;
  status: AppStatus;
  statusMessage: string;
  uiState: UiState;
  onUiAction: (action: UiAction) => void;
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
  onLoadExample,
  onUiAction,
  status,
  statusMessage,
  uiState,
}: AppShellProps) {
  const addDataMenuRef = useRef<HTMLDetailsElement>(null);
  const appMenuRef = useRef<HTMLDetailsElement>(null);
  const hiddenAssemblyOverlaysRef = useRef<{
    chromosome: boolean;
    contig: boolean;
  } | null>(null);
  const agpImported = Boolean(dataset?.agp_path);
  const contactImported = Boolean(dataset?.mcool_path || dataset?.cool_path);
  const coverageImported = Boolean(dataset?.coverage_path);
  const activeAssemblyTotalBp = uiState.assembly.blocks.reduce(
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

      const { showChromosomeBoxes, showContigBoxes } = uiState.assembly;
      if (showChromosomeBoxes || showContigBoxes) {
        hiddenAssemblyOverlaysRef.current = {
          chromosome: showChromosomeBoxes,
          contig: showContigBoxes,
        };
        onUiAction({
          type: "setAssemblyOverlayVisibility",
          chromosome: false,
          contig: false,
        });
        return;
      }

      const overlaysToRestore = hiddenAssemblyOverlaysRef.current ?? {
        chromosome: true,
        contig: true,
      };
      hiddenAssemblyOverlaysRef.current = null;
      onUiAction({
        type: "setAssemblyOverlayVisibility",
        chromosome: overlaysToRestore.chromosome,
        contig: overlaysToRestore.contig,
      });
    }

    window.addEventListener("keydown", handleJuiceboxShortcut, true);
    return () => window.removeEventListener("keydown", handleJuiceboxShortcut, true);
  }, [onUiAction, uiState.assembly, uiState.operationHistory.length, uiState.redoStack.length]);

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

            <button className="project-picker" type="button" aria-label="Current assembly project">
              <span>{fileName(dataset?.agp_path, "Untitled assembly")}</span>
              <ChevronDown size={14} aria-hidden="true" />
            </button>

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
              aria-keyshortcuts="Control+U Meta+U"
              title="Undo (⌘U / Ctrl+U)"
              disabled={uiState.operationHistory.length === 0}
              onClick={() => onUiAction({ type: "undo" })}
            >
              <Undo2 size={16} aria-hidden="true" />
            </button>
            <button
              className="global-icon-button"
              type="button"
              aria-label="Redo"
              aria-keyshortcuts="Control+R Meta+R"
              title="Redo (⌘R / Ctrl+R)"
              disabled={uiState.redoStack.length === 0}
              onClick={() => onUiAction({ type: "redo" })}
            >
              <Redo2 size={16} aria-hidden="true" />
            </button>
            <span className="toolbar-hairline" aria-hidden="true" />
            <button
              className="global-icon-button export-project-button"
              type="button"
              aria-label="Export edited AGP"
              disabled={!uiState.assembly.blocks.length}
              onClick={onExportAgp}
            >
              <Download size={16} aria-hidden="true" />
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
              </div>
            </details>
          </div>
        </div>

        <HeatmapToolbar uiState={uiState} onUiAction={onUiAction} totalSpanMb={totalSpanMb} />
      </header>

      <section className={`workspace${uiState.layout.rightCollapsed ? " right-collapsed" : ""}`}>
        <section className="center-workspace" aria-label="Assembly contact map workspace">
          <section className="map-stack">
            <section className={`main-view${uiState.layout.syntenySplitOpen ? " split-open" : ""}`}>
              <ContactMapViewport
                dataset={dataset}
                contactMap={contactMap}
                coverageView={coverageView}
                uiState={uiState}
                onUiAction={onUiAction}
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
                    selectedAssemblyBlockIds={
                      uiState.assembly.selection?.kind === "contigs" ? uiState.assembly.selection.ids : []
                    }
                    onSelectBlock={(id, additive) =>
                      onUiAction({ type: "selectAssemblyContig", id, additive })
                    }
                  />
                </aside>
              ) : null}
            </section>
          </section>
        </section>

        {uiState.layout.rightCollapsed ? null : (
          <InspectorPanel
            dataset={dataset}
            contactMap={contactMap}
            overviewContactMap={overviewContactMap}
            status={status}
            statusMessage={statusMessage}
            uiState={uiState}
            onUiAction={onUiAction}
            syntenyView={syntenyView}
            pafText={pafText}
            onPafTextChange={onPafTextChange}
          />
        )}
      </section>

      <footer className="status-bar" role="status" aria-live="polite">
        <span>Resolution: {uiState.contact.resolution}</span>
        <span>Normalization: {uiState.normalization}</span>
        <span>Matrix: {fileName(dataset?.mcool_path ?? dataset?.cool_path, "None")}</span>
        <span>Assembly: {fileName(dataset?.agp_path, "None")}</span>
        <span>Tool: {uiState.selectedTool}</span>
        <span>X: {uiState.contact.viewportCenterXMb.toFixed(2)} Mb</span>
        <span>Y: {uiState.contact.viewportCenterYMb.toFixed(2)} Mb</span>
        <strong>{statusMessage}</strong>
      </footer>
    </main>
  );
}
