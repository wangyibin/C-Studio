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
