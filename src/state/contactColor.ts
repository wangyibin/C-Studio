import type { ContactColormap } from "./uiState";

export interface ContactRgba {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

export const contactColorLutSize = 256;

const colormapStops: Record<Exclude<ContactColormap, "Reds">, number[]> = {
  Viridis: [0x440154, 0x31688e, 0x35b779, 0xfde725],
  Magma: [0x000004, 0x721f81, 0xf1605d, 0xfcfdbf],
  Inferno: [0x000004, 0x781c6d, 0xed6925, 0xfcffa4],
  Turbo: [0x30123b, 0x28a5f6, 0x7ef658, 0xfaba39, 0x7a0403],
};

const colorLutCache = new Map<ContactColormap, Map<number, Uint8ClampedArray>>();

/**
 * Match Juicebox Desktop's default observed-map scale. Juicebox constructs an
 * opaque ContinuousColorScale from white to java.awt.Color.RED; keeping the
 * interpolation in RGB rather than alpha also makes the result independent of
 * whatever happens to be painted behind the heatmap.
 */
export function contactColorAt(
  colormap: ContactColormap,
  intensity: number,
  paletteAlpha = 0.9,
): ContactRgba {
  const value = clamp01(intensity);
  if (colormap === "Reds") {
    const redAmount = Math.floor(255 * value);
    const whiteComponent = 255 - redAmount;
    return {
      red: 255,
      green: whiteComponent,
      blue: whiteComponent,
      alpha: 1,
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

/**
 * Return a shared 256-entry packed RGBA lookup table for one palette and opacity.
 *
 * Entry `i` occupies bytes `i * 4..i * 4 + 4`. RGB values reuse the existing
 * `contactColorAt` definition at intensity `i / 255`; alpha is rounded to its
 * nearest 8-bit byte, as required by ImageData. Consumers map an arbitrary
 * intensity with `contactColorLutIndex`. Reds uses an opaque white-to-red entry
 * at every 8-bit intensity; the discrete palettes select a representative entry
 * from the same color stop, so their existing hard boundaries remain exact. The
 * returned cached table is shared and must be treated as read-only.
 */
export function contactColorLut(
  colormap: ContactColormap,
  paletteAlpha = 0.9,
): Uint8ClampedArray {
  const opacityByte = Math.round(clamp01(paletteAlpha) * 255);
  const opacity = opacityByte / 255;
  let byOpacity = colorLutCache.get(colormap);
  if (!byOpacity) {
    byOpacity = new Map();
    colorLutCache.set(colormap, byOpacity);
  }

  const cached = byOpacity.get(opacityByte);
  if (cached) {
    return cached;
  }

  const lut = new Uint8ClampedArray(contactColorLutSize * 4);
  for (let index = 0; index < contactColorLutSize; index += 1) {
    const color = contactColorAt(
      colormap,
      index / (contactColorLutSize - 1),
      opacity,
    );
    const offset = index * 4;
    lut[offset] = color.red;
    lut[offset + 1] = color.green;
    lut[offset + 2] = color.blue;
    lut[offset + 3] = Math.round(color.alpha * 255);
  }
  byOpacity.set(opacityByte, lut);
  return lut;
}

export function contactColorLutIndex(
  colormap: ContactColormap,
  intensity: number,
): number {
  const value = clamp01(intensity);
  if (colormap === "Reds") {
    return Math.floor(value * (contactColorLutSize - 1));
  }

  const stopCount = colormapStops[colormap].length;
  const stopIndex = Math.min(stopCount - 1, Math.floor(value * stopCount));
  const representativeIntensity = (stopIndex + 0.5) / stopCount;
  return Math.floor(representativeIntensity * (contactColorLutSize - 1));
}

export function contactColorFromLut(
  lut: Uint8ClampedArray,
  colormap: ContactColormap,
  intensity: number,
): ContactRgba {
  const offset = contactColorLutIndex(colormap, intensity) * 4;
  return {
    red: lut[offset] ?? 0,
    green: lut[offset + 1] ?? 0,
    blue: lut[offset + 2] ?? 0,
    alpha: (lut[offset + 3] ?? 0) / 255,
  };
}

export function contactColorHex(color: Pick<ContactRgba, "red" | "green" | "blue">) {
  return (color.red << 16) | (color.green << 8) | color.blue;
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}
