import { describe, expect, it } from "vitest";
import { juiceboxShortcutIntent, type JuiceboxShortcutInput } from "./juiceboxShortcuts";

const baseInput: JuiceboxShortcutInput = {
  key: "",
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
  editable: false,
};

function shortcut(input: Partial<JuiceboxShortcutInput>) {
  return juiceboxShortcutIntent({ ...baseInput, ...input });
}

describe("juiceboxShortcutIntent", () => {
  it("maps the Juicebox shortcuts that have direct C-Studio equivalents", () => {
    expect(shortcut({ key: "s", metaKey: true })).toBe("save");
    expect(shortcut({ key: "S", ctrlKey: true })).toBe("save");
    expect(shortcut({ key: "s", metaKey: true, editable: true })).toBe("save");
    expect(shortcut({ key: "l" })).toBe("toggle-resolution-lock");
    expect(shortcut({ key: "L" })).toBe("toggle-resolution-lock");
    expect(shortcut({ key: "u", metaKey: true })).toBe("undo");
    expect(shortcut({ key: "U", ctrlKey: true })).toBe("undo");
    expect(shortcut({ key: "z", metaKey: true })).toBe("undo");
    expect(shortcut({ key: "Z", ctrlKey: true })).toBe("undo");
    expect(shortcut({ key: "r", metaKey: true })).toBe("redo");
    expect(shortcut({ key: "R", ctrlKey: true })).toBe("redo");
    expect(shortcut({ key: "z", metaKey: true, shiftKey: true })).toBe("redo");
    expect(shortcut({ key: "y", ctrlKey: true })).toBe("redo");
  });

  it("does not consume unsupported Juicebox functions or browser text-entry keys", () => {
    for (const key of ["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10"]) {
      expect(shortcut({ key })).toBeNull();
    }
    expect(shortcut({ key: "u" })).toBeNull();
    expect(shortcut({ key: "r", altKey: true })).toBeNull();
    expect(shortcut({ key: "r", ctrlKey: true, shiftKey: true })).toBeNull();
    expect(shortcut({ key: "y", metaKey: true })).toBeNull();
    expect(shortcut({ key: "l", editable: true })).toBeNull();
    expect(shortcut({ key: "l", repeat: true })).toBeNull();
    expect(shortcut({ key: "l", shiftKey: true })).toBeNull();
    expect(shortcut({ key: "l", metaKey: true })).toBeNull();
    expect(shortcut({ key: "s", metaKey: true, shiftKey: true })).toBeNull();
    expect(shortcut({ key: "s", ctrlKey: true, repeat: true })).toBeNull();
  });
});
