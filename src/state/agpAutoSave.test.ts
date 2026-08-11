import { describe, expect, it } from "vitest";
import { agpAutoSaveDelayMs, shouldScheduleAgpAutoSave } from "./agpAutoSave";

describe("AGP auto-save", () => {
  it("waits five seconds and requires an existing Save As target", () => {
    expect(agpAutoSaveDelayMs).toBe(5_000);
    expect(shouldScheduleAgpAutoSave({
      enabled: true,
      savePath: null,
      dirty: true,
      hasBlocks: true,
    })).toBe(false);
    expect(shouldScheduleAgpAutoSave({
      enabled: true,
      savePath: "/tmp/assembly.agp",
      dirty: true,
      hasBlocks: true,
    })).toBe(true);
  });

  it("does not run while disabled, clean, or empty", () => {
    expect(shouldScheduleAgpAutoSave({
      enabled: false,
      savePath: "/tmp/assembly.agp",
      dirty: true,
      hasBlocks: true,
    })).toBe(false);
    expect(shouldScheduleAgpAutoSave({
      enabled: true,
      savePath: "/tmp/assembly.agp",
      dirty: false,
      hasBlocks: true,
    })).toBe(false);
    expect(shouldScheduleAgpAutoSave({
      enabled: true,
      savePath: "/tmp/assembly.agp",
      dirty: true,
      hasBlocks: false,
    })).toBe(false);
  });
});
