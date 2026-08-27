import { describe, expect, it } from "vitest";
import {
  contactColorAt,
  contactColorCss,
  contactColorFromLut,
  contactColorLut,
  contactColorLutIndex,
  contactColorLutSize,
} from "./contactColor";
import type { ContactColormap } from "./uiState";

describe("contactColorAt", () => {
  it("matches Juicebox Desktop's opaque white-to-red scale", () => {
    expect(contactColorAt("Reds", 0)).toEqual({ red: 255, green: 255, blue: 255, alpha: 1 });
    expect(contactColorAt("Reds", 0.1)).toEqual({
      red: 255,
      green: 230,
      blue: 230,
      alpha: 1,
    });
    expect(contactColorAt("Reds", 0.5)).toEqual({ red: 255, green: 128, blue: 128, alpha: 1 });
    expect(contactColorAt("Reds", 1)).toEqual({ red: 255, green: 0, blue: 0, alpha: 1 });
    expect(contactColorAt("Reds", 3)).toEqual({ red: 255, green: 0, blue: 0, alpha: 1 });
  });

  it("keeps low positive contacts visible instead of mapping the first 20% to white", () => {
    expect(contactColorCss("Reds", 0.05)).toBe("rgba(255, 243, 243, 1)");
  });
});

describe("contactColorLut", () => {
  const colormaps: ContactColormap[] = [
    "Graphite",
    "Plum",
    "redp1_r_half",
    "redp1_r",
    "Rose",
    "Cividis",
    "Mako",
    "Amber",
    "Reds",
    "Viridis",
    "Magma",
    "Inferno",
    "Turbo",
  ];

  function expectRgba8Equivalent(
    actual: ReturnType<typeof contactColorFromLut>,
    expected: ReturnType<typeof contactColorAt>,
  ) {
    expect(actual.red).toBe(expected.red);
    expect(actual.green).toBe(expected.green);
    expect(actual.blue).toBe(expected.blue);
    expect(Math.abs(actual.alpha - expected.alpha)).toBeLessThanOrEqual(0.5 / 255);
  }

  it("contains 256 entries and preserves both intensity endpoints", () => {
    for (const colormap of colormaps) {
      const lut = contactColorLut(colormap, 0.73);

      expect(lut).toBeInstanceOf(Uint8ClampedArray);
      expect(lut).toHaveLength(contactColorLutSize * 4);
      expectRgba8Equivalent(contactColorFromLut(lut, colormap, 0), contactColorAt(colormap, 0, 0.73));
      expectRgba8Equivalent(contactColorFromLut(lut, colormap, 1), contactColorAt(colormap, 1, 0.73));
      expect(contactColorFromLut(lut, colormap, -10)).toEqual(
        contactColorFromLut(lut, colormap, 0),
      );
      expect(contactColorFromLut(lut, colormap, 10)).toEqual(
        contactColorFromLut(lut, colormap, 1),
      );
    }
  });

  it("interpolates the continuous palettes across their designed stops", () => {
    expect(contactColorAt("Graphite", 0, 1)).toEqual({
      red: 248,
      green: 250,
      blue: 252,
      alpha: 1,
    });
    expect(contactColorAt("Graphite", 1, 1)).toEqual({
      red: 15,
      green: 23,
      blue: 42,
      alpha: 1,
    });
    expect(contactColorAt("Plum", 0.5, 1)).toEqual({
      red: 184,
      green: 167,
      blue: 209,
      alpha: 1,
    });
    expect(contactColorAt("redp1_r_half", 0, 1)).toMatchObject({ red: 251, green: 225, blue: 214 });
    expect(contactColorAt("redp1_r_half", 1, 1)).toMatchObject({ red: 179, green: 35, blue: 25 });
    expect(contactColorAt("redp1_r", 0, 1)).toMatchObject({ red: 251, green: 225, blue: 214 });
    expect(contactColorAt("redp1_r", 1, 1)).toMatchObject({ red: 43, green: 7, blue: 92 });
    expect(contactColorAt("Rose", 1, 1)).toMatchObject({ red: 127, green: 29, blue: 58 });
    expect(contactColorAt("Cividis", 1, 1)).toMatchObject({ red: 253, green: 231, blue: 55 });
    expect(contactColorAt("Mako", 1, 1)).toMatchObject({ red: 16, green: 36, blue: 62 });
    expect(contactColorAt("Amber", 1, 1)).toMatchObject({ red: 87, green: 38, blue: 11 });
    expect(contactColorLutIndex("Graphite", 0.5)).toBe(127);
    expect(contactColorLutIndex("Plum", 0.5)).toBe(127);
    expect(contactColorLutIndex("Rose", 0.5)).toBe(127);
  });

  it("uses explicit lower-bound 8-bit intensity quantization", () => {
    expect(contactColorLutIndex("Reds", Number.NaN)).toBe(0);
    expect(contactColorLutIndex("Reds", -1)).toBe(0);
    expect(contactColorLutIndex("Reds", 0)).toBe(0);
    expect(contactColorLutIndex("Reds", 0.5)).toBe(127);
    expect(contactColorLutIndex("Reds", 254 / 255)).toBe(254);
    expect(contactColorLutIndex("Reds", 1)).toBe(255);
    expect(contactColorLutIndex("Reds", Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("is exact at every LUT representative for every palette", () => {
    const reds = contactColorLut("Reds", 0.2);
    for (let index = 0; index < contactColorLutSize; index += 1) {
      const intensity = index / (contactColorLutSize - 1);
      expect(contactColorFromLut(reds, "Reds", intensity)).toEqual(
        contactColorAt("Reds", intensity, 0.2),
      );
    }

    for (const colormap of colormaps) {
      const lut = contactColorLut(colormap, 0.61);
      for (let index = 0; index < contactColorLutSize; index += 1) {
        expectRgba8Equivalent(
          contactColorFromLut(lut, colormap, index / 255),
          contactColorAt(colormap, index / 255, 0.61),
        );
      }
    }
  });

  it("keeps Reds byte-identical and palette alpha within one byte of direct colors", () => {
    for (const intensity of [0, 0.05, 0.1, 0.5, 0.999, 1]) {
      const quantized = contactColorFromLut(contactColorLut("Reds", 0.88), "Reds", intensity);
      const direct = contactColorAt("Reds", intensity, 0.88);
      expect(quantized).toEqual(direct);
    }

    for (const colormap of colormaps.filter((name) => name !== "Reds")) {
      const opacity = 0.42;
      const quantized = contactColorFromLut(contactColorLut(colormap, opacity), colormap, 0.37);
      const direct = contactColorAt(colormap, 0.37, opacity);
      expect(quantized).toMatchObject({
        red: direct.red,
        green: direct.green,
        blue: direct.blue,
      });
      expect(Math.abs(quantized.alpha - direct.alpha)).toBeLessThanOrEqual(0.5 / 255);
    }
  });

  it("preserves every discrete-palette stop boundary exactly", () => {
    const stopCounts: Record<"Viridis" | "Magma" | "Inferno" | "Turbo", number> = {
      Viridis: 4,
      Magma: 4,
      Inferno: 4,
      Turbo: 5,
    };

    for (const [colormap, stopCount] of Object.entries(stopCounts) as Array<[
      keyof typeof stopCounts,
      number,
    ]>) {
      const lut = contactColorLut(colormap, 0.88);
      const samples = [
        ...Array.from({ length: 10_001 }, (_, sample) => sample / 10_000),
        ...Array.from({ length: stopCount - 1 }, (_, index) => (index + 1) / stopCount),
      ];
      for (const intensity of samples) {
        const direct = contactColorAt(colormap, intensity, 0.88);
        const quantized = contactColorFromLut(lut, colormap, intensity);
        expect(quantized).toMatchObject({
          red: direct.red,
          green: direct.green,
          blue: direct.blue,
        });
      }
    }
  });

  it("keeps Juicebox Reds opaque and clamps optional palette opacity", () => {
    const reds = contactColorLut("Reds", 0.01);
    expect(contactColorFromLut(reds, "Reds", 0).alpha).toBe(1);
    expect(contactColorFromLut(reds, "Reds", 127 / 255).alpha).toBe(1);
    expect(contactColorFromLut(reds, "Reds", 1).alpha).toBe(1);

    for (const colormap of ["Viridis", "Magma", "Inferno", "Turbo"] as const) {
      const alphaBytes = (opacity: number) => Array.from(
        { length: contactColorLutSize },
        (_, index) => contactColorLut(colormap, opacity)[index * 4 + 3],
      );
      expect(new Set(alphaBytes(0.42))).toEqual(new Set([Math.round(0.42 * 255)]));
      expect(new Set(alphaBytes(-3))).toEqual(new Set([0]));
      expect(new Set(alphaBytes(3))).toEqual(new Set([255]));
    }
    for (const colormap of [
      "Graphite",
      "Plum",
      "redp1_r_half",
      "redp1_r",
      "Rose",
      "Cividis",
      "Mako",
      "Amber",
    ] as const) {
      const alphaBytes = Array.from(
        { length: contactColorLutSize },
        (_, index) => contactColorLut(colormap, 0.1)[index * 4 + 3],
      );
      expect(new Set(alphaBytes)).toEqual(new Set([255]));
    }
  });

  it("reuses shared tables by colormap and normalized opacity", () => {
    const first = contactColorLut("Viridis", 0.5);
    const repeated = contactColorLut("Viridis", 0.5);

    expect(repeated).toBe(first);
    expect(contactColorLut("Viridis", 2)).toBe(contactColorLut("Viridis", 1));
    expect(contactColorLut("Viridis", -2)).toBe(contactColorLut("Viridis", 0));
    expect(contactColorLut("Viridis", 0.42)).toBe(contactColorLut("Viridis", 107 / 255));
    expect(contactColorLut("Viridis", 0.6)).not.toBe(first);
    expect(contactColorLut("Magma", 0.5)).not.toBe(first);
  });
});
