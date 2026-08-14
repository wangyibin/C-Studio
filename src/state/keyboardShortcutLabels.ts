export type DesktopShortcutPlatform = "mac" | "windows";

export interface KeyboardShortcutLabels {
  save: string;
  undo: string;
  redo: string;
  legacyUndo: string;
  legacyRedo: string;
  rename: string;
  reverse: string;
  copy: string;
  moveToDebris: string;
  deleteGap: string;
  deleteContig: string;
  resolutionWheel: string;
  resolutionLock: string;
  diagonalWheel: string;
  verticalWheel: string;
}

export function detectDesktopShortcutPlatform(
  platform = typeof navigator === "undefined"
    ? ""
    : `${navigator.platform} ${navigator.userAgent}`,
): DesktopShortcutPlatform {
  return /Mac|iPhone|iPad|iPod/i.test(platform) ? "mac" : "windows";
}

export function keyboardShortcutLabels(
  platform = detectDesktopShortcutPlatform(),
): KeyboardShortcutLabels {
  if (platform === "mac") {
    return {
      save: "⌘S",
      undo: "⌘Z",
      redo: "⇧⌘Z",
      legacyUndo: "⌘U",
      legacyRedo: "⌘R",
      rename: "⌘E",
      reverse: "⇧⌘R",
      copy: "⌘D",
      moveToDebris: "⇧⌘D",
      deleteGap: "⌘J",
      deleteContig: "⇧⌫",
      resolutionWheel: "⌘+Scroll",
      resolutionLock: "L",
      diagonalWheel: "Scroll",
      verticalWheel: "⇧⌘+Scroll",
    };
  }

  return {
    save: "Ctrl+S",
    undo: "Ctrl+Z",
    redo: "Ctrl+Y",
    legacyUndo: "Ctrl+U",
    legacyRedo: "Ctrl+R",
    rename: "Ctrl+E",
    reverse: "Ctrl+Shift+R",
    copy: "Ctrl+D",
    moveToDebris: "Ctrl+Shift+D",
    deleteGap: "Ctrl+J",
    deleteContig: "Shift+Del",
    resolutionWheel: "Ctrl+Scroll",
    resolutionLock: "L",
    diagonalWheel: "Scroll",
    verticalWheel: "Ctrl+Shift+Scroll",
  };
}
