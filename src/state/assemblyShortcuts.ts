export type AssemblyShortcutIntent =
  | "rename"
  | "reverse"
  | "copy"
  | "move-to-debris"
  | "delete-gap"
  | "delete-contig";

export interface AssemblyShortcutInput {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  editable: boolean;
}

export function assemblyShortcutIntent({
  key,
  ctrlKey,
  metaKey,
  altKey,
  shiftKey,
  repeat,
  editable,
}: AssemblyShortcutInput): AssemblyShortcutIntent | null {
  if (editable || repeat || altKey) {
    return null;
  }

  const normalizedKey = key.toLowerCase();
  const menuModifier = ctrlKey || metaKey;
  if (menuModifier) {
    if (!shiftKey) {
      switch (normalizedKey) {
        case "e":
          return "rename";
        case "d":
          return "copy";
        case "j":
          return "delete-gap";
        default:
          return null;
      }
    }

    switch (normalizedKey) {
      case "r":
        return "reverse";
      case "d":
        return "move-to-debris";
      default:
        return null;
    }
  }

  if (shiftKey) {
    return normalizedKey === "delete" || normalizedKey === "backspace"
      ? "delete-contig"
      : null;
  }

  return null;
}
