import type { AgpGapMetadata, ContactMapLayoutBlock } from "./importers";

export function exportAgpText(blocks: ContactMapLayoutBlock[]): string {
  const objectOrder = uniqueObjectIds(blocks);
  const lines: string[] = [];

  for (const objectId of objectOrder) {
    const objectBlocks = blocks.filter((block) => block.objectId === objectId);
    let objectStart = 1;
    let partNumber = 1;

    objectBlocks.forEach((block) => {
      if (block.gapBefore && block.gapBefore.length > 0) {
        lines.push(serializeGapRow(objectId, objectStart, partNumber, block.gapBefore));
        objectStart += block.gapBefore.length;
        partNumber += 1;
      }

      const length = Math.max(0, block.sourceEnd - block.sourceStart);
      const objectEnd = objectStart + length - 1;
      lines.push(
        [
          objectId,
          objectStart,
          objectEnd,
          partNumber,
          block.componentType ?? "W",
          block.displayName?.trim() || block.sourceId,
          block.sourceStart + 1,
          block.sourceEnd,
          block.orientation,
        ].join("\t"),
      );
      objectStart = objectEnd + 1;
      partNumber += 1;
    });
  }

  return `${lines.join("\n")}\n`;
}

function serializeGapRow(
  objectId: string,
  objectStart: number,
  partNumber: number,
  gap: AgpGapMetadata,
) {
  const objectEnd = objectStart + gap.length - 1;
  return [
    objectId,
    objectStart,
    objectEnd,
    partNumber,
    gap.componentType,
    gap.length,
    gap.gapType,
    gap.linkage,
    gap.linkageEvidence,
  ].join("\t");
}

function uniqueObjectIds(blocks: ContactMapLayoutBlock[]) {
  const objectIds: string[] = [];
  const seen = new Set<string>();

  for (const block of blocks) {
    if (!seen.has(block.objectId)) {
      objectIds.push(block.objectId);
      seen.add(block.objectId);
    }
  }

  return objectIds;
}
