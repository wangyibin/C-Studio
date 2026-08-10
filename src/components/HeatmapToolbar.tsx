import { useEffect, useState } from "react";
import {
  ArrowRight,
  Copy,
  FlipHorizontal2,
  Grid2X2,
  Lock,
  Maximize2,
  Sparkles,
  Square,
  Unlock,
} from "lucide-react";
import type { UiAction, UiState } from "../state/uiState";
import { availableContactResolutions, normalizations } from "../state/uiState";

export interface HeatmapToolbarProps {
  uiState: UiState;
  onUiAction: (action: UiAction) => void;
  totalSpanMb: number;
}

export function HeatmapToolbar({ onUiAction, totalSpanMb, uiState }: HeatmapToolbarProps) {
  const safeTotalSpanMb = Number.isFinite(totalSpanMb) && totalSpanMb > 0
    ? totalSpanMb
    : uiState.contact.totalSpanMb;
  const resolutionOptions = availableContactResolutions(
    uiState.contact,
    safeTotalSpanMb,
  );
  const resolutionIndex = resolutionOptions.indexOf(uiState.contact.resolution);
  const safeResolutionIndex = Math.max(0, resolutionIndex);
  const colorScaleMin = uiState.contact.colorScale.min;
  const colorScaleMax = uiState.contact.colorScale.max;
  const hasSelection = uiState.assembly.selection !== null;
  const [draftResolutionIndex, setDraftResolutionIndex] = useState(safeResolutionIndex);
  const [draftMin, setDraftMin] = useState(String(colorScaleMin));
  const [draftMax, setDraftMax] = useState(String(colorScaleMax));

  useEffect(() => {
    setDraftResolutionIndex(safeResolutionIndex);
  }, [resolutionOptions.length, safeResolutionIndex]);

  useEffect(() => {
    setDraftMin(String(colorScaleMin));
  }, [colorScaleMin]);

  useEffect(() => {
    setDraftMax(String(colorScaleMax));
  }, [colorScaleMax]);

  function commitResolution(rawIndex = draftResolutionIndex) {
    const nextIndex = Math.min(resolutionOptions.length - 1, Math.max(0, rawIndex));
    const resolution = resolutionOptions[nextIndex];
    if (resolution && resolution !== uiState.contact.resolution) {
      onUiAction({ type: "setContactResolution", resolution });
    }
  }

  function commitColorScale(field: "min" | "max", rawValue: string) {
    if (rawValue.trim() === "") {
      if (field === "min") {
        setDraftMin(String(colorScaleMin));
      } else {
        setDraftMax(String(colorScaleMax));
      }
      return;
    }

    const value = Number(rawValue);
    if (!Number.isFinite(value)) {
      if (field === "min") {
        setDraftMin(String(colorScaleMin));
      } else {
        setDraftMax(String(colorScaleMax));
      }
      return;
    }

    onUiAction({ type: "setColorScale", field, value });
  }

  return (
    <section
      className="heatmap-toolbar"
      role="toolbar"
      aria-label="Heatmap tools"
      aria-orientation="horizontal"
    >
      <div className="heatmap-toolbar-group heatmap-selection-actions" role="group" aria-label="Selection actions">
        <button
          className="heatmap-toolbar-button"
          type="button"
          aria-label="Reverse selection"
          disabled={!hasSelection}
          onClick={() => onUiAction({ type: "reverseAssemblySelection" })}
        >
          <FlipHorizontal2 size={15} aria-hidden="true" />
          <span>Reverse</span>
        </button>
        <button
          className="heatmap-toolbar-button"
          type="button"
          aria-label="Copy selection"
          disabled={!hasSelection}
          onClick={() => onUiAction({ type: "copyAssemblySelection" })}
        >
          <Copy size={15} aria-hidden="true" />
          <span>Copy</span>
        </button>
      </div>

      <div className="heatmap-toolbar-group heatmap-resolution-control" role="group" aria-label="Resolution">
        <span className="heatmap-toolbar-label" aria-hidden="true">Resolution</span>
        <span className="heatmap-resolution-value" aria-live="polite">
          {resolutionOptions[draftResolutionIndex] ?? uiState.contact.resolution}
        </span>
        <input
          className="heatmap-resolution-range"
          type="range"
          min="0"
          max={resolutionOptions.length - 1}
          step="1"
          value={draftResolutionIndex}
          aria-label="Contact map resolution"
          aria-valuetext={resolutionOptions[draftResolutionIndex] ?? uiState.contact.resolution}
          onChange={(event) => setDraftResolutionIndex(Number(event.target.value))}
          onBlur={(event) => commitResolution(Number(event.currentTarget.value))}
          onKeyUp={(event) => commitResolution(Number(event.currentTarget.value))}
          onPointerUp={(event) => commitResolution(Number(event.currentTarget.value))}
        />
        <button
          className={`heatmap-toolbar-icon-button${uiState.contact.resolutionLocked ? " active" : ""}`}
          type="button"
          aria-label={uiState.contact.resolutionLocked ? "Unlock resolution" : "Lock resolution"}
          aria-pressed={uiState.contact.resolutionLocked}
          title={
            uiState.contact.resolutionLocked
              ? `Resolution locked at ${uiState.contact.resolution}`
              : "Lock resolution during zoom"
          }
          onClick={() => onUiAction({ type: "toggleContactResolutionLock" })}
        >
          {uiState.contact.resolutionLocked
            ? <Lock size={15} aria-hidden="true" />
            : <Unlock size={15} aria-hidden="true" />}
        </button>
      </div>

      <div className="heatmap-toolbar-group heatmap-color-control" role="group" aria-label="Color range">
        <span className="heatmap-red-gradient" aria-hidden="true" />
        <label className="heatmap-color-field">
          <span>Min</span>
          <input
            type="text"
            inputMode="decimal"
            min="0"
            value={draftMin}
            aria-label="Color range minimum"
            onChange={(event) => setDraftMin(event.target.value)}
            onBlur={(event) => commitColorScale("min", event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                commitColorScale("min", event.currentTarget.value);
                event.currentTarget.blur();
              }
            }}
          />
        </label>
        <span className="heatmap-color-separator" aria-hidden="true">–</span>
        <label className="heatmap-color-field">
          <span>Max</span>
          <input
            type="text"
            inputMode="decimal"
            min="0"
            value={draftMax}
            aria-label="Color range maximum"
            onChange={(event) => setDraftMax(event.target.value)}
            onBlur={(event) => commitColorScale("max", event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                commitColorScale("max", event.currentTarget.value);
                event.currentTarget.blur();
              }
            }}
          />
        </label>
        <button
          className={`heatmap-toolbar-button heatmap-auto-color${uiState.contact.colorScale.auto ? " active" : ""}`}
          type="button"
          aria-label="Automatic color range"
          aria-pressed={uiState.contact.colorScale.auto}
          onClick={() => onUiAction({ type: "resetColorScaleAuto" })}
        >
          <Sparkles size={14} aria-hidden="true" />
          <span>Auto</span>
        </button>
      </div>

      <label className="heatmap-toolbar-group heatmap-normalization-control">
        <span className="heatmap-toolbar-label">Normalization</span>
        <select
          value={uiState.normalization}
          aria-label="Contact map normalization"
          onChange={(event) => onUiAction({
            type: "setNormalization",
            normalization: event.target.value as UiState["normalization"],
          })}
        >
          {normalizations.map((normalization) => (
            <option key={normalization} value={normalization}>{normalization}</option>
          ))}
        </select>
      </label>

      <div
        className="heatmap-toolbar-group heatmap-box-controls"
        role="group"
        aria-label="Heatmap boxes"
        aria-keyshortcuts="F2"
        title="Show or hide heatmap annotations (F2)"
      >
        <button
          className={`heatmap-toolbar-button${uiState.assembly.showChromosomeBoxes ? " active" : ""}`}
          type="button"
          aria-label="Chromosome boxes"
          aria-pressed={uiState.assembly.showChromosomeBoxes}
          onClick={() => onUiAction({ type: "toggleAssemblyOverlay", overlay: "chromosome" })}
        >
          <Square size={15} aria-hidden="true" />
          <span>Chromosome</span>
        </button>
        <button
          className={`heatmap-toolbar-button${uiState.assembly.showContigBoxes ? " active" : ""}`}
          type="button"
          aria-label="Contig boxes"
          aria-pressed={uiState.assembly.showContigBoxes}
          onClick={() => onUiAction({ type: "toggleAssemblyOverlay", overlay: "contig" })}
        >
          <Grid2X2 size={15} aria-hidden="true" />
          <span>Contig</span>
        </button>
      </div>

      <div className="heatmap-toolbar-group heatmap-navigation-actions" role="group" aria-label="Viewport navigation">
        <button
          className="heatmap-toolbar-button"
          type="button"
          aria-label="Fit whole genome"
          onClick={() => onUiAction({ type: "fitContactViewport", totalSpanMb: safeTotalSpanMb })}
        >
          <Maximize2 size={15} aria-hidden="true" />
          <span>Fit</span>
        </button>
        <label className="heatmap-jump-field">
          <span>Jump</span>
          <input
            type="number"
            min="0"
            max={safeTotalSpanMb}
            step="0.01"
            value={uiState.contact.jumpTargetMb}
            aria-label="Jump target in megabases"
            onChange={(event) => {
              const valueMb = event.currentTarget.valueAsNumber;
              if (Number.isFinite(valueMb)) {
                onUiAction({ type: "setContactJumpTarget", valueMb });
              }
            }}
          />
        </label>
        <button
          className="heatmap-toolbar-icon-button"
          type="button"
          aria-label="Jump to genomic position"
          onClick={() => onUiAction({ type: "jumpContactViewport" })}
        >
          <ArrowRight size={15} aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}
