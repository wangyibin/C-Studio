import type { ContactColormap } from "./uiState";

export interface ContactRgba {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

export const contactColorLutSize = 256;

type ContinuousContactColormap =
  | "Graphite"
  | "Plum"
  | "redp1_r_half"
  | "redp1_r"
  | "Rose"
  | "Cividis"
  | "Mako"
  | "Amber";

const baseContinuousColormapStops: Record<Exclude<ContinuousContactColormap, "redp1_r">, number[]> = {
  Graphite: [0xf8fafc, 0xe2e8f0, 0xcbd5e1, 0x64748b, 0x0f172a],
  Plum: [0xfafafc, 0xe9e5f3, 0xb8a7d1, 0x745a9b, 0x2e203f],
  // C-Phasing's default `redp1_r_half`: the first 128 RGB samples from
  // `colormaps.redp1_r`, matching cphasing.plot.half_colormaps.
  redp1_r_half: [
    0xfbe1d6, 0xfbdfd4, 0xfbddd2, 0xfbdbd0, 0xfbdacd, 0xfbd8cb, 0xfbd6c9, 0xfbd4c7,
    0xfbd3c4, 0xfbd1c2, 0xfacfc0, 0xfacdbe, 0xfaccbb, 0xfacab9, 0xfac8b7, 0xf9c7b5,
    0xf9c5b2, 0xf9c3b0, 0xf9c1ae, 0xf8c0ac, 0xf8beaa, 0xf8bca7, 0xf8bba5, 0xf7b9a3,
    0xf7b7a1, 0xf7b59f, 0xf6b39c, 0xf6b19a, 0xf6af97, 0xf6ad95, 0xf6ab93, 0xf6a990,
    0xf6a78e, 0xf6a58b, 0xf6a389, 0xf6a086, 0xf69e84, 0xf59c82, 0xf59a7f, 0xf5987d,
    0xf5967a, 0xf59378, 0xf49176, 0xf48f73, 0xf48d71, 0xf48b6f, 0xf3896c, 0xf3866a,
    0xf38468, 0xf28265, 0xf28063, 0xf27e60, 0xf17c5f, 0xf07a5d, 0xf0795c, 0xef775a,
    0xee7658, 0xee7457, 0xed7255, 0xec7153, 0xeb6f52, 0xeb6e50, 0xea6c4f, 0xe96a4d,
    0xe9694b, 0xe8674a, 0xe76548, 0xe76447, 0xe66245, 0xe56043, 0xe45f42, 0xe45d40,
    0xe35b3f, 0xe25a3d, 0xe1583b, 0xe1563a, 0xe05438, 0xdf5337, 0xde5236, 0xdd5136,
    0xdc5035, 0xdb4f34, 0xdb4e34, 0xda4e33, 0xd94d32, 0xd84c31, 0xd74b31, 0xd64a30,
    0xd5492f, 0xd4482f, 0xd3472e, 0xd2462d, 0xd2452d, 0xd1442c, 0xd0432b, 0xcf422a,
    0xce412a, 0xcd4029, 0xcc3f28, 0xcb3e28, 0xca3d27, 0xc93c26, 0xc83b26, 0xc83b25,
    0xc73a24, 0xc63924, 0xc53823, 0xc43723, 0xc33622, 0xc23522, 0xc23421, 0xc13321,
    0xc03220, 0xbf3120, 0xbe301f, 0xbd2f1f, 0xbc2e1e, 0xbc2d1e, 0xbb2c1d, 0xba2b1d,
    0xb92a1c, 0xb8291c, 0xb7281b, 0xb6271b, 0xb6261a, 0xb5251a, 0xb42419, 0xb32319,
  ],
  Rose: [0xffffff, 0xfde8e7, 0xf5a3a0, 0xd9485f, 0x7f1d3a],
  Cividis: [0x00204c, 0x414d6b, 0x7c7b78, 0xbcaf6f, 0xfde737],
  Mako: [0xf6fafa, 0xb8ddd6, 0x5aa6a4, 0x24657a, 0x10243e],
  Amber: [0xfffcf5, 0xfde7b2, 0xf5b942, 0xc56a16, 0x57260b],
};

const redp1rTailStops = [
  0xb22218, 0xb12218, 0xb02118, 0xb02118, 0xaf2018, 0xae2018, 0xad1f18, 0xac1f18,
  0xab1e18, 0xab1e17, 0xaa1d17, 0xa91d17, 0xa81c17, 0xa71c17, 0xa71b17, 0xa61b17,
  0xa51a17, 0xa41a16, 0xa31916, 0xa21916, 0xa21816, 0xa11816, 0xa01716, 0x9f1716,
  0x9e1616, 0x9e1616, 0x9d1617, 0x9c1619, 0x9b161b, 0x9b161d, 0x9a161f, 0x991721,
  0x991723, 0x981724, 0x971726, 0x961728, 0x96182a, 0x95182b, 0x94182d, 0x93182f,
  0x921830, 0x921932, 0x911934, 0x901935, 0x8f1937, 0x8e1939, 0x8d1a3a, 0x8d1a3c,
  0x8c1a3d, 0x8b1a3f, 0x8a1b41, 0x891a42, 0x891a41, 0x891a41, 0x881941, 0x881941,
  0x871841, 0x871841, 0x871741, 0x861741, 0x861641, 0x851641, 0x851541, 0x851541,
  0x841441, 0x841441, 0x831341, 0x831341, 0x831241, 0x821241, 0x821141, 0x811141,
  0x811040, 0x811040, 0x800f40, 0x800f40, 0x800e40, 0x7e0e42, 0x7d0e43, 0x7b0d45,
  0x7a0d47, 0x780d48, 0x770d4a, 0x760c4b, 0x740c4d, 0x720c4e, 0x710c50, 0x6f0c52,
  0x6e0c53, 0x6c0c55, 0x6a0c56, 0x690c58, 0x670c59, 0x650c5b, 0x630c5d, 0x620c5e,
  0x600c60, 0x5e0c61, 0x5c0c63, 0x590c64, 0x570c66, 0x550c68, 0x540c68, 0x520c68,
  0x510c67, 0x4f0b67, 0x4e0b66, 0x4c0b66, 0x4b0b65, 0x490a65, 0x470a64, 0x460a64,
  0x440a63, 0x430963, 0x410962, 0x400962, 0x3e0961, 0x3c0861, 0x3b0860, 0x390860,
  0x37085f, 0x36085f, 0x34075e, 0x32075e, 0x31075d, 0x2f075d, 0x2d075d, 0x2b075c,
];

const continuousColormapStops: Record<ContinuousContactColormap, number[]> = {
  ...baseContinuousColormapStops,
  redp1_r: [...baseContinuousColormapStops.redp1_r_half, ...redp1rTailStops],
};

const discreteColormapStops: Record<"Viridis" | "Magma" | "Inferno" | "Turbo", number[]> = {
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

  let color: number;
  if (isContinuousColormap(colormap)) {
    // Match the 256-entry GPU LUT exactly so the Canvas, Pixi, WebGL, and
    // virtual-texture paths cannot disagree by one RGB byte.
    const continuousValue = Math.floor(value * (contactColorLutSize - 1))
      / (contactColorLutSize - 1);
    color = interpolateColorStops(continuousColormapStops[colormap], continuousValue);
  } else {
    color = discreteColorAt(discreteColormapStops[colormap], value);
  }

  return {
    red: (color >> 16) & 255,
    green: (color >> 8) & 255,
    blue: color & 255,
    // The branded sequential maps define the final visible colors. Keeping
    // them opaque also makes Canvas, Pixi, and both WebGL renderers agree.
    alpha: isContinuousColormap(colormap) ? 1 : clamp01(paletteAlpha),
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
 * intensity with `contactColorLutIndex`. Reds and the continuous palettes preserve
 * the full 8-bit intensity ramp; the legacy discrete palettes select a representative
 * entry from the same color stop, so their existing hard boundaries remain exact.
 * The returned cached table is shared and must be treated as read-only.
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
  if (colormap === "Reds" || isContinuousColormap(colormap)) {
    return Math.floor(value * (contactColorLutSize - 1));
  }

  const stopCount = discreteColormapStops[colormap].length;
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

function isContinuousColormap(colormap: ContactColormap): colormap is ContinuousContactColormap {
  return colormap in continuousColormapStops;
}

function discreteColorAt(stops: readonly number[], value: number) {
  return stops[Math.min(stops.length - 1, Math.floor(value * stops.length))] ?? stops[0] ?? 0;
}

function interpolateColorStops(stops: readonly number[], value: number) {
  const scaled = value * Math.max(0, stops.length - 1);
  const lowerIndex = Math.min(stops.length - 1, Math.floor(scaled));
  const upperIndex = Math.min(stops.length - 1, lowerIndex + 1);
  const ratio = scaled - lowerIndex;
  const lower = stops[lowerIndex] ?? 0;
  const upper = stops[upperIndex] ?? lower;
  const channel = (shift: number) => Math.round(
    (((lower >> shift) & 255) * (1 - ratio))
    + (((upper >> shift) & 255) * ratio),
  );
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}
