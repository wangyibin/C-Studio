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
  it("matches Juicebox's continuous red alpha mapping", () => {
    expect(contactColorAt("Reds", 0)).toEqual({ red: 255, green: 0, blue: 0, alpha: 0 });
    expect(contactColorAt("Reds", 0.1)).toEqual({
      red: 255,
      green: 0,
      blue: 0,
      alpha: 25 / 255,
    });
    expect(contactColorAt("Reds", 0.5).alpha).toBe(127 / 255);
    expect(contactColorAt("Reds", 1).alpha).toBe(1);
    expect(contactColorAt("Reds", 3).alpha).toBe(1);
  });

  it("keeps low positive contacts visible instead of mapping the first 20% to white", () => {
    expect(contactColorCss("Reds", 0.05)).toBe("rgba(255, 0, 0, 0.047058823529411764)");
  });
});

describe("contactColorLut", () => {
  const colormaps: ContactColormap[] = ["Reds", "Viridis", "Magma", "Inferno", "Turbo"];

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

  it("uses explicit lower-bound 8-bit intensity quantization", () => {
    expect(contactColorLutIndex("Reds", Number.NaN)).toBe(0);
    expect(contactColorLutIndex("Reds", -1)).toBe(0);
    expect(contactColorLutIndex("Reds", 0)).toBe(0);
    expect(contactColorLutIndex("Reds", 0.5)).toBe(127);
    expect(contactColorLutIndex("Reds", 254 / 255)).toBe(254);
    expect(contactColorLutIndex("Reds", 1)).toBe(255);
    expect(contactColorLutIndex("Reds", Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("is exact for Reds and exact at every LUT representative for every palette", () => {
    const sampleIntensities = [-1, 0, 0.001, 0.05, 0.1, 0.5, 0.9, 0.999, 1, 3];
    const reds = contactColorLut("Reds", 0.2);
    for (const intensity of sampleIntensities) {
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

  it("matches existing CSS colors exactly for Reds and within one alpha byte for palettes", () => {
    const cssFromLut = (lut: Uint8ClampedArray, colormap: ContactColormap, intensity: number) => {
      const color = contactColorFromLut(lut, colormap, intensity);
      return `rgba(${color.red}, ${color.green}, ${color.blue}, ${color.alpha})`;
    };
    for (const intensity of [0, 0.05, 0.1, 0.5, 0.999, 1]) {
      expect(cssFromLut(contactColorLut("Reds", 0.88), "Reds", intensity)).toBe(
        contactColorCss("Reds", intensity, 0.88),
      );
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
    const stopCounts: Record<Exclude<ContactColormap, "Reds">, number> = {
      Viridis: 4,
      Magma: 4,
      Inferno: 4,
      Turbo: 5,
    };

    for (const [colormap, stopCount] of Object.entries(stopCounts) as Array<[
      Exclude<ContactColormap, "Reds">,
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

  it("retains existing alpha rules and clamps palette opacity", () => {
    const reds = contactColorLut("Reds", 0.01);
    expect(contactColorFromLut(reds, "Reds", 0).alpha).toBe(0);
    expect(contactColorFromLut(reds, "Reds", 127 / 255).alpha).toBe(127 / 255);
    expect(contactColorFromLut(reds, "Reds", 1).alpha).toBe(1);

    for (const colormap of colormaps.filter((name) => name !== "Reds")) {
      const alphaBytes = (opacity: number) => Array.from(
        { length: contactColorLutSize },
        (_, index) => contactColorLut(colormap, opacity)[index * 4 + 3],
      );
      expect(new Set(alphaBytes(0.42))).toEqual(new Set([Math.round(0.42 * 255)]));
      expect(new Set(alphaBytes(-3))).toEqual(new Set([0]));
      expect(new Set(alphaBytes(3))).toEqual(new Set([255]));
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
