export const agpAutoSaveDelayMs = 5_000;

export type AgpSavePlan = "dialog" | "overwrite" | "unavailable";

export function agpSavePlan({
  automatic,
  saveAs,
  savePath,
}: {
  automatic: boolean;
  saveAs: boolean;
  savePath: string | null;
}): AgpSavePlan {
  if (automatic) {
    return savePath ? "overwrite" : "unavailable";
  }
  if (saveAs || !savePath) {
    return "dialog";
  }
  return "overwrite";
}

export function shouldScheduleAgpAutoSave({
  enabled,
  savePath,
  dirty,
  hasBlocks,
}: {
  enabled: boolean;
  savePath: string | null;
  dirty: boolean;
  hasBlocks: boolean;
}) {
  return enabled && Boolean(savePath) && dirty && hasBlocks;
}

/** Keep the suggested edited filename beside the loaded AGP on either desktop platform. */
export function agpSaveDialogPath(sourcePath: string, filename: string, savePath: string | null) {
  if (savePath) return savePath;
  const separatorIndex = Math.max(sourcePath.lastIndexOf("/"), sourcePath.lastIndexOf("\\"));
  return sourcePath.slice(0, separatorIndex + 1) + filename;
}

export function editedAgpFilename(sourcePath: string, savedPath: string | null = null) {
  const path = savedPath ?? sourcePath;
  const basename = path.split(/[\\/]/).filter(Boolean).pop() ?? "assembly.agp";
  if (savedPath) return basename;
  return basename.replace(/(?:\.agp(?:\.gz)?|\.txt)?$/i, ".edited.agp");
}
