import { useEffect, useState } from "react";
import { Check, Lock, Settings, Sparkles, Unlock } from "lucide-react";
import type { UiAction, UiState } from "../state/uiState";
import { contactResolutions, normalizations } from "../state/uiState";

interface ContactControlsProps {
  uiState: UiState;
  onUiAction: (action: UiAction) => void;
  onLoadExample: () => void;
}

const resolutionTicks = ["2.5 MB", "500 KB", "100 KB", "25 KB", "5 KB"];

function formatColorScaleTick(value: number) {
  return Number(value.toFixed(2)).toLocaleString();
}

function colorSliderUpperBound(min: number, max: number) {
  const largestValue = Math.max(8, min, max);
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(1, largestValue)));
  return Math.ceil(largestValue / magnitude) * magnitude;
}

export function ContactControls({ onLoadExample, onUiAction, uiState }: ContactControlsProps) {
  const resolutionIndex = contactResolutions.indexOf(uiState.contact.resolution);
  const safeResolutionIndex = Math.max(0, resolutionIndex);
  const colorScaleMin = uiState.contact.colorScale.min;
  const colorScaleMax = uiState.contact.colorScale.max;
  const colorScaleMid = (colorScaleMin + colorScaleMax) / 2;
  const colorSliderMax = colorSliderUpperBound(colorScaleMin, colorScaleMax);
  const [activeColorHandle, setActiveColorHandle] = useState<"min" | "max">("min");
  const [draftResolutionIndex, setDraftResolutionIndex] = useState(safeResolutionIndex);
  const [draftMin, setDraftMin] = useState(String(colorScaleMin));
  const [draftMax, setDraftMax] = useState(String(colorScaleMax));

  useEffect(() => {
    setDraftResolutionIndex(safeResolutionIndex);
  }, [safeResolutionIndex]);

  useEffect(() => {
    setDraftMin(String(colorScaleMin));
  }, [colorScaleMin]);

  useEffect(() => {
    setDraftMax(String(colorScaleMax));
  }, [colorScaleMax]);

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

  function commitResolution(rawIndex = draftResolutionIndex) {
    const nextIndex = Math.min(contactResolutions.length - 1, Math.max(0, rawIndex));
    const resolution = contactResolutions[nextIndex];
    if (resolution && resolution !== uiState.contact.resolution) {
      onUiAction({ type: "setContactResolution", resolution });
    }
  }

  return (
    <section className="contact-controls" aria-label="Contact map controls">
      <section className="heatmap-card import-card">
        <div className="card-title">Example Dataset</div>
        <button className="action-button import-example-button" type="button" onClick={onLoadExample}>
          <Sparkles size={16} />
          <span>Import example</span>
        </button>
      </section>

      <section className="heatmap-card resolution-card">
        <div className="card-title">Resolution (BP)</div>
        <div className="resolution-slider-row">
          <input
            className="resolution-range"
            type="range"
            min="0"
            max={contactResolutions.length - 1}
            step="1"
            value={draftResolutionIndex}
            onChange={(event) => setDraftResolutionIndex(Number(event.target.value))}
            onBlur={(event) => commitResolution(Number(event.currentTarget.value))}
            onKeyUp={(event) => commitResolution(Number(event.currentTarget.value))}
            onPointerUp={(event) => commitResolution(Number(event.currentTarget.value))}
          />
          <button
            className={`range-lock${uiState.contact.resolutionLocked ? " locked" : ""}`}
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
            {uiState.contact.resolutionLocked ? <Lock size={18} /> : <Unlock size={18} />}
          </button>
        </div>
        <div className="resolution-ticks" aria-hidden="true">
          {resolutionTicks.map((tick) => (
            <span key={tick}>{tick}</span>
          ))}
        </div>
      </section>

      <section className="heatmap-card color-card">
        <div className="card-title">Color Range</div>
        <div className="color-range-preview" aria-hidden="true">
          <div className="color-range-gradient" />
        </div>
        <div className="color-range-controls">
          <input
            className={`color-range-input color-range-min${activeColorHandle === "min" ? " active" : ""}`}
            type="range"
            min="0"
            max={Math.max(colorScaleMax, colorSliderMax)}
            step="0.1"
            value={Math.max(0, uiState.contact.colorScale.min)}
            onFocus={() => setActiveColorHandle("min")}
            onPointerDown={() => setActiveColorHandle("min")}
            onChange={(event) =>
              onUiAction({ type: "setColorScale", field: "min", value: Number(event.target.value) })
            }
          />
          <input
            className={`color-range-input color-range-max${activeColorHandle === "max" ? " active" : ""}`}
            type="range"
            min={Math.max(0, colorScaleMin)}
            max={colorSliderMax}
            step="0.1"
            value={Math.max(0, uiState.contact.colorScale.max)}
            onFocus={() => setActiveColorHandle("max")}
            onPointerDown={() => setActiveColorHandle("max")}
            onChange={(event) =>
              onUiAction({ type: "setColorScale", field: "max", value: Number(event.target.value) })
            }
          />
          <div className="color-range-buttons">
            <button
              type="button"
              aria-label="Halve color threshold"
              title="Halve color threshold"
              onClick={() => onUiAction({
                type: "setColorScale",
                field: "max",
                value: Math.max(Number.EPSILON, uiState.contact.colorScale.max * 0.5),
              })}
            >
              -
            </button>
            <button
              type="button"
              aria-label="Double color threshold"
              title="Double color threshold"
              onClick={() => onUiAction({
                type: "setColorScale",
                field: "max",
                value: uiState.contact.colorScale.max * 2,
              })}
            >
              +
            </button>
          </div>
        </div>
        <div className="color-range-scale">
          <span>{formatColorScaleTick(colorScaleMin)}</span>
          <span>{formatColorScaleTick(colorScaleMid)}</span>
          <span>{formatColorScaleTick(colorScaleMax)}</span>
        </div>
        <div className="color-range-number-row">
          <label>
            <span>Min</span>
            <input
              aria-label="Color range minimum"
              type="text"
              inputMode="decimal"
              min="0"
              value={draftMin}
              onChange={(event) => setDraftMin(event.target.value)}
              onBlur={(event) => commitColorScale("min", event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  commitColorScale("min", event.currentTarget.value);
                  event.currentTarget.blur();
                }
              }}
            />
          </label>
          <label>
            <span>Max</span>
            <input
              aria-label="Color range maximum"
              type="text"
              inputMode="decimal"
              min="0"
              value={draftMax}
              onChange={(event) => setDraftMax(event.target.value)}
              onBlur={(event) => commitColorScale("max", event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  commitColorScale("max", event.currentTarget.value);
                  event.currentTarget.blur();
                }
              }}
            />
          </label>
        </div>
        <button
          className="auto-color-button"
          type="button"
          aria-pressed={uiState.contact.colorScale.auto}
          onClick={() => onUiAction({ type: "resetColorScaleAuto" })}
        >
          <span className={`fake-check ${uiState.contact.colorScale.auto ? "checked" : ""}`}>
            {uiState.contact.colorScale.auto ? <Check size={12} /> : null}
          </span>
          Auto color
        </button>
      </section>

      <section className="heatmap-card overlay-card">
        <div className="card-title">Heatmap Boxes</div>
        <button
          className="check-row overlay-toggle-row"
          type="button"
          aria-pressed={uiState.assembly.showChromosomeBoxes}
          onClick={() => onUiAction({ type: "toggleAssemblyOverlay", overlay: "chromosome" })}
        >
          <span className={`fake-check ${uiState.assembly.showChromosomeBoxes ? "checked" : ""}`}>
            {uiState.assembly.showChromosomeBoxes ? <Check size={12} /> : null}
          </span>
          <span className="box-swatch chromosome-swatch" />
          Chromosome boxes
        </button>
        <button
          className="check-row overlay-toggle-row"
          type="button"
          aria-pressed={uiState.assembly.showContigBoxes}
          onClick={() => onUiAction({ type: "toggleAssemblyOverlay", overlay: "contig" })}
        >
          <span className={`fake-check ${uiState.assembly.showContigBoxes ? "checked" : ""}`}>
            {uiState.assembly.showContigBoxes ? <Check size={12} /> : null}
          </span>
          <span className="box-swatch contig-swatch" />
          Contig boxes
        </button>
      </section>

      <section className="heatmap-card normalization-card">
        <div className="card-title">Normalization</div>
        <select
          className="select-button"
          value={uiState.normalization}
          onChange={(event) =>
            onUiAction({
              type: "setNormalization",
              normalization: event.target.value as UiState["normalization"],
            })
          }
        >
          {normalizations.map((normalization) => (
            <option key={normalization} value={normalization}>
              {normalization}
            </option>
          ))}
        </select>
        <a className="settings-link">
          Normalization settings <Settings size={14} />
        </a>
      </section>
    </section>
  );
}
