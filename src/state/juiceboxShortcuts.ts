export type JuiceboxShortcutIntent =
  | "save"
  | "undo"
  | "redo"
  | "toggle-resolution-lock"
  | "toggle-annotations"
  | "toggle-inspector"
  | "open-file-menu";

export interface JuiceboxShortcutInput {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  editable: boolean;
}

/** Map only Juicebox shortcuts that have a real C-Studio equivalent. */
export function juiceboxShortcutIntent({
  key,
  ctrlKey,
  metaKey,
  altKey,
  shiftKey,
  repeat,
  editable,
}: JuiceboxShortcutInput): JuiceboxShortcutIntent | null {
  const menuModifier = ctrlKey || metaKey;
  const normalizedKey = key.toLowerCase();
  if (!altKey && menuModifier && !shiftKey && !repeat && normalizedKey === "s") {
    return "save";
  }

  if (editable || altKey) {
    return null;
  }

  if (menuModifier) {
    if (normalizedKey === "z") {
      return shiftKey ? "redo" : "undo";
    }
    if (!shiftKey && normalizedKey === "y" && ctrlKey && !metaKey) {
      return "redo";
    }
    if (!shiftKey && normalizedKey === "u") {
      return "undo";
    }
    if (!shiftKey && normalizedKey === "r") {
      return "redo";
    }
    return null;
  }

  if (shiftKey || repeat) {
    return null;
  }

  switch (key.toUpperCase()) {
    case "L":
      return "toggle-resolution-lock";
    case "F2":
      return "toggle-annotations";
    case "F9":
      return "toggle-inspector";
    case "F10":
      return "open-file-menu";
    default:
      return null;
  }
}

/** Keep application-level shortcuts out of text-entry and editable controls. */
export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const tagName = target.tagName.toLowerCase();
  return target.isContentEditable
    || tagName === "input"
    || tagName === "textarea"
    || tagName === "select"
    || target.closest("[contenteditable='true'], [contenteditable='plaintext-only']") !== null;
}
