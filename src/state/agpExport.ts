import type { ContactMapLayoutBlock } from "./importers";

export function exportAgpText(blocks: ContactMapLayoutBlock[]): string {
  const objectOrder = uniqueObjectIds(blocks);
  const lines: string[] = [];

  for (const objectId of objectOrder) {
    const objectBlocks = blocks.filter((block) => block.objectId === objectId);
    let objectStart = 1;

    objectBlocks.forEach((block, index) => {
      const length = Math.max(0, block.sourceEnd - block.sourceStart);
      const objectEnd = objectStart + length - 1;
      lines.push(
        [
          objectId,
          objectStart,
          objectEnd,
          index + 1,
          "W",
          block.sourceId,
          block.sourceStart + 1,
          block.sourceEnd,
          block.orientation,
        ].join("\t"),
      );
      objectStart = objectEnd + 1;
    });
  }

  return `${lines.join("\n")}\n`;
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
