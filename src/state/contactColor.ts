import type { ContactColormap } from "./uiState";

export interface ContactRgba {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

const colormapStops: Record<Exclude<ContactColormap, "Reds">, number[]> = {
  Viridis: [0x440154, 0x31688e, 0x35b779, 0xfde725],
  Magma: [0x000004, 0x721f81, 0xf1605d, 0xfcfdbf],
  Inferno: [0x000004, 0x781c6d, 0xed6925, 0xfcffa4],
  Turbo: [0x30123b, 0x28a5f6, 0x7ef658, 0xfaba39, 0x7a0403],
};

/**
 * Match Juicebox's default contact-map color scale: solid red whose alpha is
 * the count divided by the automatic threshold. Other optional C-Studio
 * palettes retain their existing discrete presentation.
 */
export function contactColorAt(
  colormap: ContactColormap,
  intensity: number,
  paletteAlpha = 0.9,
): ContactRgba {
  const value = clamp01(intensity);
  if (colormap === "Reds") {
    return {
      red: 255,
      green: 0,
      blue: 0,
      alpha: Math.floor(255 * value) / 255,
    };
  }

  const stops = colormapStops[colormap];
  const color = stops[Math.min(stops.length - 1, Math.floor(value * stops.length))] ?? stops[0];

  return {
    red: (color >> 16) & 255,
    green: (color >> 8) & 255,
    blue: color & 255,
    alpha: clamp01(paletteAlpha),
  };
}

export function contactColorCss(
  colormap: ContactColormap,
  intensity: number,
  paletteAlpha = 0.9,
) {
  const color = contactColorAt(colormap, intensity, paletteAlpha);
  return `rgba(${color.red}, ${color.green}, ${color.blue}, ${color.alpha})`;
}

export function contactColorHex(color: Pick<ContactRgba, "red" | "green" | "blue">) {
  return (color.red << 16) | (color.green << 8) | color.blue;
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}
