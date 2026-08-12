import { describe, expect, it } from "vitest";

import {
  detectDesktopShortcutPlatform,
  keyboardShortcutLabels,
} from "./keyboardShortcutLabels";

describe("keyboard shortcut labels", () => {
  it("detects Apple desktop and mobile platforms as Mac-style keyboards", () => {
    expect(detectDesktopShortcutPlatform("MacIntel")).toBe("mac");
    expect(detectDesktopShortcutPlatform("iPad")).toBe("mac");
    expect(detectDesktopShortcutPlatform("Win32")).toBe("windows");
  });

  it("shows only the labels for the active platform", () => {
    expect(keyboardShortcutLabels("mac")).toMatchObject({
      save: "⌘S",
      rename: "⌘E",
      reverse: "⇧⌘R",
      deleteContig: "⇧⌫",
      resolutionWheel: "⌘+Scroll",
    });
    expect(keyboardShortcutLabels("windows")).toMatchObject({
      save: "Ctrl+S",
      rename: "Ctrl+E",
      reverse: "Ctrl+Shift+R",
      deleteContig: "Shift+Del",
      resolutionWheel: "Ctrl+Scroll",
    });
  });
});
