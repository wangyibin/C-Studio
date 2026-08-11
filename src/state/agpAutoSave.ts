export const agpAutoSaveDelayMs = 5_000;

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
