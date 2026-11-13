import { describe, expect, it } from "vitest";
import {
  agpAutoSaveDelayMs,
  agpSavePlan,
  agpSaveDialogPath,
  editedAgpFilename,
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

  it("always opens a dialog for Save As, including after saving", () => {
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

describe("AGP save dialog location", () => {
  it.each([
    ["/data/project/groups.agp", "/data/project/groups.edited.agp"],
    ["C:\\data\\project\\groups.agp", "C:\\data\\project\\groups.edited.agp"],
    ["/groups.agp", "/groups.edited.agp"],
    ["groups.agp", "groups.edited.agp"],
    ["", "groups.edited.agp"],
  ])("defaults to the loaded AGP folder: %s", (source, expected) => {
    expect(agpSaveDialogPath(source, "groups.edited.agp", null)).toBe(expected);
  });

  it("keeps the destination previously chosen by the user", () => {
    expect(agpSaveDialogPath("/project/groups.agp", "groups.edited.agp", "/output/result.agp"))
      .toBe("/output/result.agp");
  });
});

describe("save filename continuity", () => {
  it("reuses the first download name across repeated saves", () => {
    let currentPath = "groups.edit.agp";
    let downloadedName: string | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const filename = editedAgpFilename(currentPath, downloadedName);
      expect(filename).toBe("groups.edit.edited.agp");
      downloadedName = filename;
      currentPath = filename;
    }
  });

  it("preserves a user-chosen native filename exactly", () => {
    expect(editedAgpFilename("groups.edit.agp", "/project/groups.edit.eidt.agp"))
      .toBe("groups.edit.eidt.agp");
  });

  it("starts a new suggestion for a newly loaded assembly", () => {
    expect(editedAgpFilename("/other/new.agp", null)).toBe("new.edited.agp");
  });
});
