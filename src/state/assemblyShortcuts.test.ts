import { describe, expect, it } from "vitest";

import { assemblyShortcutIntent, type AssemblyShortcutInput } from "./assemblyShortcuts";

const base: AssemblyShortcutInput = {
  key: "",
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
  editable: false,
};

function shortcut(input: Partial<AssemblyShortcutInput>) {
  return assemblyShortcutIntent({ ...base, ...input });
}

describe("assemblyShortcutIntent", () => {
  it("maps curation actions only to deliberate key chords", () => {
    expect(shortcut({ key: "e", metaKey: true })).toBe("rename");
    expect(shortcut({ key: "E", ctrlKey: true })).toBe("rename");
    expect(shortcut({ key: "R", metaKey: true, shiftKey: true })).toBe("reverse");
    expect(shortcut({ key: "r", ctrlKey: true, shiftKey: true })).toBe("reverse");
    expect(shortcut({ key: "d", metaKey: true })).toBe("copy");
    expect(shortcut({ key: "D", ctrlKey: true })).toBe("copy");
    expect(shortcut({ key: "d", metaKey: true, shiftKey: true })).toBe("move-to-debris");
    expect(shortcut({ key: "D", ctrlKey: true, shiftKey: true })).toBe("move-to-debris");
    expect(shortcut({ key: "j", metaKey: true })).toBe("delete-gap");
    expect(shortcut({ key: "J", ctrlKey: true })).toBe("delete-gap");
    expect(shortcut({ key: "Delete", shiftKey: true })).toBe("delete-contig");
    expect(shortcut({ key: "Backspace", shiftKey: true })).toBe("delete-contig");
  });

  it("ignores bare letters, text entry, repeats, Alt chords, and unsupported modifiers", () => {
    for (const key of ["e", "r", "d", "j"]) {
      expect(shortcut({ key })).toBeNull();
    }
    expect(shortcut({ key: "e", metaKey: true, editable: true })).toBeNull();
    expect(shortcut({ key: "r", metaKey: true, shiftKey: true, repeat: true })).toBeNull();
    expect(shortcut({ key: "d", metaKey: true, altKey: true })).toBeNull();
    expect(shortcut({ key: "j", metaKey: true, shiftKey: true })).toBeNull();
    expect(shortcut({ key: "Delete" })).toBeNull();
    expect(shortcut({ key: "[" })).toBeNull();
    expect(shortcut({ key: "]" })).toBeNull();
  });
});
