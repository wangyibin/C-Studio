import { describe, expect, it } from "vitest";
import {
  agpAutoSaveDelayMs,
  agpSavePlan,
  shouldScheduleAgpAutoSave,
} from "./agpAutoSave";

describe("AGP auto-save", () => {
  it("opens a dialog on the first Save and then overwrites that selected path", () => {
    expect(agpSavePlan({ automatic: false, saveAs: false, savePath: null })).toBe("dialog");
    expect(agpSavePlan({
      automatic: false,
      saveAs: false,
      savePath: "C:\\project\\assembly.agp",
    })).toBe("overwrite");
  });

  it("always opens a dialog for Save As", () => {
    expect(agpSavePlan({ automatic: false, saveAs: true, savePath: null })).toBe("dialog");
    expect(agpSavePlan({
      automatic: false,
      saveAs: true,
      savePath: "C:\\project\\assembly.agp",
    })).toBe("dialog");
  });

  it("only auto-saves when an existing path is available", () => {
    expect(agpSavePlan({
      automatic: true,
      saveAs: false,
      savePath: "C:\\project\\assembly.agp",
    })).toBe("overwrite");
    expect(agpSavePlan({ automatic: true, saveAs: false, savePath: null }))
      .toBe("unavailable");
  });

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
