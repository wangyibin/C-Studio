import { describe, expect, it } from "vitest";
import { contactColorAt, contactColorCss } from "./contactColor";

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
