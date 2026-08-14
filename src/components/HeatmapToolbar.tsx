import { useEffect, useState } from "react";
import {
  ArrowRight,
  Grid2X2,
  Lock,
  Maximize2,
  Sparkles,
  Square,
  Unlock,
} from "lucide-react";
import type { UiAction, UiState } from "../state/uiState";
import {
  availableContactResolutions,
  normalizations,
  storedContactResolutionsForDataset,
} from "../state/uiState";
import { resolveContactJumpInputs } from "../state/contactJump";

export interface HeatmapToolbarProps {
  uiState: UiState;
  onUiAction: (action: UiAction) => void;
  totalSpanMb: number;
  useStoredResolutionOptions?: boolean;
  availableResolutionBasePairs?: number[];
}

export function HeatmapToolbar({
  onUiAction,
  useStoredResolutionOptions = false,
  availableResolutionBasePairs = [],
  totalSpanMb,
  uiState,
}: HeatmapToolbarProps) {
  const safeTotalSpanMb = Number.isFinite(totalSpanMb) && totalSpanMb > 0
    ? totalSpanMb
    : uiState.contact.totalSpanMb;
  const viewportResolutionOptions = availableContactResolutions(
    uiState.contact,
    safeTotalSpanMb,
    false,
  );
  const resolutionOptions = useStoredResolutionOptions && availableResolutionBasePairs.length > 0
    ? storedContactResolutionsForDataset(availableResolutionBasePairs)
    : viewportResolutionOptions;
  const resolutionIndex = resolutionOptions.indexOf(uiState.contact.resolution);
  const safeResolutionIndex = Math.max(0, resolutionIndex);
  const resolutionSignature = resolutionOptions.join("|");
  const colorScaleMin = uiState.contact.colorScale.min;
  const colorScaleMax = uiState.contact.colorScale.max;
  const [draftResolutionIndex, setDraftResolutionIndex] = useState(safeResolutionIndex);
  const [draftMin, setDraftMin] = useState(String(colorScaleMin));
  const [draftMax, setDraftMax] = useState(String(colorScaleMax));
  const [draftJumpX, setDraftJumpX] = useState("");
  const [draftJumpY, setDraftJumpY] = useState("");
  const [jumpError, setJumpError] = useState<string | null>(null);
  const draftResolutionRatio = resolutionOptions.length <= 1
    ? 0
    : draftResolutionIndex / (resolutionOptions.length - 1);
  const resolutionIndicatorLeft = 9 + draftResolutionRatio * 162;

  useEffect(() => {
    setDraftResolutionIndex(safeResolutionIndex);
  }, [resolutionSignature, safeResolutionIndex]);

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
      onUiAction({
        type: "setContactResolution",
        resolution,
      });
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

  function commitContactJump() {
    const resolved = resolveContactJumpInputs(
      uiState.assembly.blocks,
      draftJumpX,
      draftJumpY,
    );
    if (!resolved.ok) {
      setJumpError(resolved.error);
      onUiAction({ type: "appendLog", message: `Jump failed: ${resolved.error}` });
      return;
    }

    setJumpError(null);
    onUiAction({
      type: "jumpContactViewportToRegions",
      xCenterBp: resolved.x.centerBp,
      yCenterBp: resolved.y.centerBp,
      selectedBlockIds: [...new Set([resolved.x.blockId, resolved.y.blockId])],
      totalSpanMb: safeTotalSpanMb,
      label: resolved.label,
    });
  }

  return (
    <section
      className="heatmap-toolbar"
      role="toolbar"
      aria-label="Heatmap tools"
      aria-orientation="horizontal"
    >
      <div className="heatmap-toolbar-group heatmap-resolution-control" role="group" aria-label="Resolution">
        <div className="heatmap-resolution-scale">
          <span className="heatmap-resolution-heading">
            <span className="heatmap-toolbar-label" aria-hidden="true">Resolution</span>
            <span className="heatmap-resolution-value" aria-live="polite">
              {resolutionOptions[draftResolutionIndex] ?? uiState.contact.resolution}
            </span>
          </span>
          <span className="heatmap-resolution-track">
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
            <span
              className="heatmap-resolution-indicator"
              aria-hidden="true"
              style={{ left: `${resolutionIndicatorLeft}px` }}
            />
            <span className="heatmap-resolution-ticks" aria-hidden="true">
              {resolutionOptions.map((resolution, index) => {
                const isFirst = index === 0;
                const isLast = index === resolutionOptions.length - 1;
                const isMiddle = index === Math.round((resolutionOptions.length - 1) / 2);
                const showLabel = isFirst || isMiddle || isLast;
                const position = resolutionOptions.length <= 1
                  ? 0
                  : (index / (resolutionOptions.length - 1)) * 100;
                return (
                  <span
                    className={`heatmap-resolution-tick${
                      isFirst ? " first" : isLast ? " last" : ""
                    }`}
                    key={resolution}
                    style={{ left: `${position}%` }}
                  >
                    <i />
                    {showLabel ? <small>{resolution}</small> : null}
                  </span>
                );
              })}
            </span>
          </span>
        </div>
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
        <span className="heatmap-color-fields">
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
        </span>
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
          className={`heatmap-toolbar-button${uiState.assembly.showBlockBoxes ? " active" : ""}`}
          type="button"
          aria-label="Block boxes"
          aria-pressed={uiState.assembly.showBlockBoxes}
          onClick={() => onUiAction({ type: "toggleAssemblyOverlay", overlay: "block" })}
        >
          <Grid2X2 size={15} aria-hidden="true" />
          <span>Block</span>
        </button>
        <button
          className={`heatmap-toolbar-button${uiState.assembly.showContigBoxes ? " active" : ""}`}
          type="button"
          aria-label="Contig boxes"
          aria-pressed={uiState.assembly.showContigBoxes}
          onClick={() => onUiAction({ type: "toggleAssemblyOverlay", overlay: "contig" })}
        >
          <Square size={13} strokeWidth={1} aria-hidden="true" />
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
        <span className="heatmap-toolbar-label">Jump</span>
        <div
          className={`heatmap-jump-fields${jumpError ? " invalid" : ""}`}
          title={jumpError ?? "Enter contig or contig:start-end. Leave one axis blank to use the other for both."}
        >
          <label className="heatmap-jump-field">
            <span>X</span>
            <input
              type="text"
              value={draftJumpX}
              placeholder="contig[:start-end]"
              aria-label="X contig or interval"
              aria-invalid={Boolean(jumpError)}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                setDraftJumpX(event.currentTarget.value);
                setJumpError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  commitContactJump();
                }
              }}
            />
          </label>
          <label className="heatmap-jump-field">
            <span>Y</span>
            <input
              type="text"
              value={draftJumpY}
              placeholder="contig[:start-end]"
              aria-label="Y contig or interval"
              aria-invalid={Boolean(jumpError)}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                setDraftJumpY(event.currentTarget.value);
                setJumpError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  commitContactJump();
                }
              }}
            />
          </label>
        </div>
        <button
          className="heatmap-toolbar-icon-button"
          type="button"
          aria-label="Jump to contig or interval"
          title={jumpError ?? "Jump to X/Y contig regions"}
          disabled={!draftJumpX.trim() && !draftJumpY.trim()}
          onClick={commitContactJump}
        >
          <ArrowRight size={15} aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}
