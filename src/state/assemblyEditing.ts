import type { ContactMapLayoutBlock } from "./importers";

export interface AssemblyChromosome {
  id: string;
  visualStart: number;
  visualEnd: number;
  blockIds: string[];
}

export interface AssemblyEditModel {
  blocks: ContactMapLayoutBlock[];
  chromosomes: AssemblyChromosome[];
  totalSpan: number;
}

export interface AssemblyChromosomeGroup extends AssemblyChromosome {
  totalCount: number;
  selectedCount: number;
  totalLength: number;
  selectedLength: number;
}

export type AssemblySelection =
  | { kind: "contigs"; ids: string[] }
  | { kind: "chromosome"; id: string };

export type AssemblyHit =
  | { kind: "contig"; id: string }
  | { kind: "chromosome-boundary"; id: string };

export interface MapPoint {
  x: number;
  y: number;
}

export interface AssemblyInsertionTarget {
  targetBlockId: string | null;
  visualPosition: number;
}

export interface HitTestOptions {
  sizePx?: number;
  widthPx?: number;
  heightPx?: number;
  tolerancePx: number;
  viewportStart?: number;
  viewportEnd?: number;
  viewportXStart?: number;
  viewportXEnd?: number;
  viewportYStart?: number;
  viewportYEnd?: number;
  selectionKind?: AssemblySelection["kind"];
}

const DEBRIS_OBJECT_ID = "debris";

export function buildAssemblyEditModel(blocks: ContactMapLayoutBlock[]): AssemblyEditModel {
  const chromosomes = new Map<string, AssemblyChromosome>();

  for (const block of blocks) {
    const chromosome = chromosomes.get(block.objectId) ?? {
      id: block.objectId,
      visualStart: block.visualStart,
      visualEnd: block.visualEnd,
      blockIds: [],
    };

    chromosome.visualStart = Math.min(chromosome.visualStart, block.visualStart);
    chromosome.visualEnd = Math.max(chromosome.visualEnd, block.visualEnd);
    chromosome.blockIds.push(block.id);
    chromosomes.set(block.objectId, chromosome);
  }

  return {
    blocks,
    chromosomes: [...chromosomes.values()].sort((left, right) => left.visualStart - right.visualStart),
    totalSpan: Math.max(0, ...blocks.map((block) => block.visualEnd)),
  };
}

export function selectContig(
  selection: AssemblySelection | null,
  id: string,
  additive: boolean,
): AssemblySelection | null {
  if (!additive || selection?.kind !== "contigs") {
    return { kind: "contigs", ids: [id] };
  }

  if (selection.ids.includes(id)) {
    const ids = selection.ids.filter((selectedId) => selectedId !== id);
    return ids.length > 0 ? { kind: "contigs", ids } : null;
  }

  return { kind: "contigs", ids: [...selection.ids, id] };
}

export function selectContigs(ids: string[]): AssemblySelection | null {
  const uniqueIds = [...new Set(ids)];
  return uniqueIds.length > 0 ? { kind: "contigs", ids: uniqueIds } : null;
}

export function isContigSelected(selection: AssemblySelection | null, id: string) {
  return selection?.kind === "contigs" && selection.ids.includes(id);
}

export function selectChromosome(
  _selection: AssemblySelection | null,
  id: string,
  _additive: boolean,
): AssemblySelection {
  return { kind: "chromosome", id };
}

export function groupAssemblyBlocksByChromosome(
  blocks: ContactMapLayoutBlock[],
  selection: AssemblySelection | null,
): AssemblyChromosomeGroup[] {
  const selected = new Set(selectedBlockIds(blocks, selection));
  const groups = new Map<string, AssemblyChromosomeGroup>();

  for (const block of blocks) {
    const group = groups.get(block.objectId) ?? {
      id: block.objectId,
      visualStart: block.visualStart,
      visualEnd: block.visualEnd,
      blockIds: [],
      totalCount: 0,
      selectedCount: 0,
      totalLength: 0,
      selectedLength: 0,
    };

    const length = Math.max(0, block.visualEnd - block.visualStart);
    group.visualStart = Math.min(group.visualStart, block.visualStart);
    group.visualEnd = Math.max(group.visualEnd, block.visualEnd);
    group.blockIds.push(block.id);
    group.totalCount += 1;
    group.totalLength += length;
    if (selected.has(block.id)) {
      group.selectedCount += 1;
      group.selectedLength += length;
    }
    groups.set(block.objectId, group);
  }

  return [...groups.values()].sort((left, right) => left.visualStart - right.visualStart);
}

export function reverseSelection(
  blocks: ContactMapLayoutBlock[],
  selection: AssemblySelection | null,
): ContactMapLayoutBlock[] {
  const selectedIds = selectedBlockIds(blocks, selection);
  if (selectedIds.length === 0) {
    return blocks;
  }

  const selected = new Set(selectedIds);
  const reversed = blocks
    .filter((block) => selected.has(block.id))
    .reverse()
    .map((block) => ({ ...block, orientation: flipOrientation(block.orientation) }));
  let nextReversedIndex = 0;

  return recomputeVisualCoordinates(
    blocks.map((block) => (selected.has(block.id) ? reversed[nextReversedIndex++] : block)),
  );
}

export function moveSelectionBefore(
  blocks: ContactMapLayoutBlock[],
  selection: AssemblySelection | null,
  targetBlockId: string | null,
): ContactMapLayoutBlock[] {
  const selectedIds = selectedBlockIds(blocks, selection);
  if (
    selectedIds.length === 0
    || (targetBlockId !== null && selectedIds.includes(targetBlockId))
    || (targetBlockId === null && selection?.kind !== "chromosome")
  ) {
    return blocks;
  }

  const selected = new Set(selectedIds);
  const movingBlocks = blocks.filter((block) => selected.has(block.id));
  const remainingBlocks = blocks.filter((block) => !selected.has(block.id));
  const targetIndex = targetBlockId === null
    ? remainingBlocks.length
    : remainingBlocks.findIndex((block) => block.id === targetBlockId);
  if (targetIndex < 0) {
    return blocks;
  }

  const targetObjectId = remainingBlocks[targetIndex]?.objectId ?? movingBlocks[0]?.objectId;
  const retargetedMovingBlocks = selection?.kind === "chromosome"
    ? movingBlocks
    : movingBlocks.map((block) => ({ ...block, objectId: targetObjectId }));
  const reordered = [
    ...remainingBlocks.slice(0, targetIndex),
    ...retargetedMovingBlocks,
    ...remainingBlocks.slice(targetIndex),
  ];

  if (reordered.every((block, index) => (
    block.id === blocks[index]?.id && block.objectId === blocks[index]?.objectId
  ))) {
    return blocks;
  }

  return recomputeVisualCoordinates(reordered);
}

export function moveSelectionToDebris(
  blocks: ContactMapLayoutBlock[],
  selection: AssemblySelection | null,
): ContactMapLayoutBlock[] {
  const selectedIds = selectedBlockIds(blocks, selection);
  if (selectedIds.length === 0) {
    return blocks;
  }

  const selected = new Set(selectedIds);
  const movingBlocks = blocks.filter((block) => selected.has(block.id));
  const remainingBlocks = blocks.filter((block) => !selected.has(block.id));
  const movedBlocks = movingBlocks.map((block) => ({
    ...block,
    objectId: DEBRIS_OBJECT_ID,
  }));

  return recomputeVisualCoordinates([...remainingBlocks, ...movedBlocks]);
}

export function addChromosomeBoundariesToSelection(
  blocks: ContactMapLayoutBlock[],
  selection: AssemblySelection | null,
): ContactMapLayoutBlock[] {
  const selectedIds = selectedBlockIds(blocks, selection);
  if (selectedIds.length === 0 || selection?.kind !== "contigs") {
    return blocks;
  }

  const selected = new Set(selectedIds);
  const affectedObjectIds = new Set(
    blocks
      .filter((block) => selected.has(block.id))
      .map((block) => block.objectId),
  );
  const occupiedObjectIds = new Set(blocks.map((block) => block.objectId));
  const nextObjectIdByBlockIndex = new Map<number, string>();

  for (const objectId of affectedObjectIds) {
    const segments: number[][] = [];
    let previousBlockIndex = -2;
    let previousSelected = false;

    blocks.forEach((block, blockIndex) => {
      if (block.objectId !== objectId) {
        return;
      }

      const blockSelected = selected.has(block.id);
      const startsSegment = blockIndex !== previousBlockIndex + 1
        || blockSelected !== previousSelected;
      if (startsSegment) {
        segments.push([]);
      }
      segments[segments.length - 1]?.push(blockIndex);
      previousBlockIndex = blockIndex;
      previousSelected = blockSelected;
    });

    // A whole chromosome is already bounded. Only create new object ids when
    // the selection introduces at least one boundary inside that chromosome.
    if (segments.length <= 1) {
      continue;
    }

    segments.forEach((blockIndexes, segmentIndex) => {
      const segmentObjectId = segmentIndex === 0
        ? objectId
        : reserveNextObjectId(occupiedObjectIds, objectId);
      blockIndexes.forEach((blockIndex) => {
        nextObjectIdByBlockIndex.set(blockIndex, segmentObjectId);
      });
    });
  }

  if (nextObjectIdByBlockIndex.size === 0) {
    return blocks;
  }

  return recomputeVisualCoordinates(
    blocks.map((block, blockIndex) => ({
      ...block,
      objectId: nextObjectIdByBlockIndex.get(blockIndex) ?? block.objectId,
    })),
  );
}

export function copySelection(
  blocks: ContactMapLayoutBlock[],
  selection: AssemblySelection | null,
): ContactMapLayoutBlock[] {
  const selectedIds = selectedBlockIds(blocks, selection);
  if (selectedIds.length === 0) {
    return blocks;
  }

  const selected = new Set(selectedIds);
  const copiedObjectId = selection?.kind === "chromosome"
    ? nextCopyObjectId(blocks, selection.id)
    : null;
  const copiedBlocks = buildCopiedBlocks(blocks, selected, copiedObjectId);
  const lastSelectedIndex = Math.max(...blocks.map((block, index) => (selected.has(block.id) ? index : -1)));

  return recomputeVisualCoordinates([
    ...blocks.slice(0, lastSelectedIndex + 1),
    ...copiedBlocks,
    ...blocks.slice(lastSelectedIndex + 1),
  ]);
}

export function copySelectionBefore(
  blocks: ContactMapLayoutBlock[],
  selection: AssemblySelection | null,
  targetBlockId: string,
): ContactMapLayoutBlock[] {
  const selectedIds = selectedBlockIds(blocks, selection);
  if (selectedIds.length === 0 || selectedIds.includes(targetBlockId)) {
    return blocks;
  }

  const targetIndex = blocks.findIndex((block) => block.id === targetBlockId);
  const targetBlock = blocks[targetIndex];
  if (!targetBlock) {
    return blocks;
  }

  const copiedBlocks = buildCopiedBlocks(blocks, new Set(selectedIds), targetBlock.objectId);
  return recomputeVisualCoordinates([
    ...blocks.slice(0, targetIndex),
    ...copiedBlocks,
    ...blocks.slice(targetIndex),
  ]);
}

export function splitContigAtVisualPosition(
  blocks: ContactMapLayoutBlock[],
  blockId: string,
  visualPosition: number,
): ContactMapLayoutBlock[] {
  const blockIndex = blocks.findIndex((block) => block.id === blockId);
  const block = blocks[blockIndex];
  if (!block) {
    return blocks;
  }

  const offset = Math.round(visualPosition - block.visualStart);
  const length = block.sourceEnd - block.sourceStart;
  if (offset <= 0 || offset >= length) {
    return blocks;
  }

  const left: ContactMapLayoutBlock = {
    ...block,
    id: `${block.id}:left`,
    sourceEnd: block.sourceStart + offset,
  };
  const right: ContactMapLayoutBlock = {
    ...block,
    id: `${block.id}:right`,
    sourceStart: block.sourceStart + offset,
  };

  return recomputeVisualCoordinates([
    ...blocks.slice(0, blockIndex),
    left,
    right,
    ...blocks.slice(blockIndex + 1),
  ]);
}

export function hitTestAssemblyLayout(
  model: AssemblyEditModel,
  point: MapPoint,
  options: HitTestOptions,
): AssemblyHit | null {
  const viewportXStart = options.viewportXStart ?? options.viewportStart ?? 0;
  const viewportXEnd = options.viewportXEnd ?? options.viewportEnd ?? model.totalSpan;
  const viewportYStart = options.viewportYStart ?? options.viewportStart ?? 0;
  const viewportYEnd = options.viewportYEnd ?? options.viewportEnd ?? model.totalSpan;
  const viewportXSpan = Math.max(1, viewportXEnd - viewportXStart);
  const viewportYSpan = Math.max(1, viewportYEnd - viewportYStart);
  const widthPx = Math.max(1, options.widthPx ?? options.sizePx ?? 1);
  const heightPx = Math.max(1, options.heightPx ?? options.sizePx ?? 1);
  const visualX = viewportXStart + (point.x / widthPx) * viewportXSpan;
  const visualY = viewportYStart + (point.y / heightPx) * viewportYSpan;

  const block = findLastInBox(model.blocks, visualX, visualY);
  if (block) {
    return { kind: "contig", id: block.id };
  }

  const chromosome = findLastInBox(model.chromosomes, visualX, visualY);
  if (chromosome) {
    return { kind: "chromosome-boundary", id: chromosome.id };
  }

  return null;
}

export function contigIdsInScreenSelection(
  model: AssemblyEditModel,
  start: MapPoint,
  end: MapPoint,
  options: HitTestOptions,
): string[] {
  const widthPx = Math.max(1, options.widthPx ?? options.sizePx ?? 1);
  const heightPx = Math.max(1, options.heightPx ?? options.sizePx ?? 1);
  const viewportXStart = options.viewportXStart ?? options.viewportStart ?? 0;
  const viewportXEnd = options.viewportXEnd ?? options.viewportEnd ?? model.totalSpan;
  const viewportYStart = options.viewportYStart ?? options.viewportStart ?? 0;
  const viewportYEnd = options.viewportYEnd ?? options.viewportEnd ?? model.totalSpan;
  const viewportXSpan = Math.max(1, viewportXEnd - viewportXStart);
  const viewportYSpan = Math.max(1, viewportYEnd - viewportYStart);
  const selectionLeft = Math.min(start.x, end.x);
  const selectionRight = Math.max(start.x, end.x);
  const selectionTop = Math.min(start.y, end.y);
  const selectionBottom = Math.max(start.y, end.y);

  return model.blocks
    .filter((block) => {
      const left = ((block.visualStart - viewportXStart) / viewportXSpan) * widthPx;
      const right = ((block.visualEnd - viewportXStart) / viewportXSpan) * widthPx;
      const top = ((block.visualStart - viewportYStart) / viewportYSpan) * heightPx;
      const bottom = ((block.visualEnd - viewportYStart) / viewportYSpan) * heightPx;
      return right >= selectionLeft
        && left <= selectionRight
        && bottom >= selectionTop
        && top <= selectionBottom;
    })
    .map((block) => block.id);
}

export function insertionTargetAtScreenPoint(
  model: AssemblyEditModel,
  selectedIds: ReadonlySet<string>,
  point: MapPoint,
  options: HitTestOptions,
): AssemblyInsertionTarget | null {
  if (selectedIds.size === 0) {
    return null;
  }
  const selectedBlocks = model.blocks.filter((block) => selectedIds.has(block.id));
  if (
    options.selectionKind === "chromosome"
    && selectedBlocks.length > 0
    && selectedBlocks.every((block) => block.objectId === DEBRIS_OBJECT_ID)
  ) {
    return null;
  }
  const widthPx = Math.max(1, options.widthPx ?? options.sizePx ?? 1);
  const heightPx = Math.max(1, options.heightPx ?? options.sizePx ?? 1);
  const viewportXStart = options.viewportXStart ?? options.viewportStart ?? 0;
  const viewportXEnd = options.viewportXEnd ?? options.viewportEnd ?? model.totalSpan;
  const viewportYStart = options.viewportYStart ?? options.viewportStart ?? 0;
  const viewportYEnd = options.viewportYEnd ?? options.viewportEnd ?? model.totalSpan;
  const viewportXSpan = Math.max(1, viewportXEnd - viewportXStart);
  const viewportYSpan = Math.max(1, viewportYEnd - viewportYStart);
  const tolerancePx = Math.max(1, options.tolerancePx);
  const selectionKind = options.selectionKind ?? "contigs";

  for (let index = 0; index < model.blocks.length; index += 1) {
    const target = model.blocks[index];
    const previous = index > 0 ? model.blocks[index - 1] : null;
    const isChromosomeBoundary = previous === null || previous.objectId !== target.objectId;
    if (
      (selectionKind === "chromosome" ? !isChromosomeBoundary : isChromosomeBoundary)
      || (previous !== null && selectedIds.has(previous.id))
      || selectedIds.has(target.id)
    ) {
      continue;
    }

    const boundaryX = ((target.visualStart - viewportXStart) / viewportXSpan) * widthPx;
    const boundaryY = ((target.visualStart - viewportYStart) / viewportYSpan) * heightPx;
    if (
      Math.abs(point.x - boundaryX) <= tolerancePx
      && Math.abs(point.y - boundaryY) <= tolerancePx
    ) {
      return { targetBlockId: target.id, visualPosition: target.visualStart };
    }
  }

  const lastBlock = model.blocks[model.blocks.length - 1];
  if (
    selectionKind === "chromosome"
    && lastBlock
    && lastBlock.objectId !== DEBRIS_OBJECT_ID
    && !selectedIds.has(lastBlock.id)
  ) {
    const boundaryX = ((model.totalSpan - viewportXStart) / viewportXSpan) * widthPx;
    const boundaryY = ((model.totalSpan - viewportYStart) / viewportYSpan) * heightPx;
    if (
      Math.abs(point.x - boundaryX) <= tolerancePx
      && Math.abs(point.y - boundaryY) <= tolerancePx
    ) {
      return { targetBlockId: null, visualPosition: model.totalSpan };
    }
  }

  return null;
}

function findLastInBox<T extends { visualStart: number; visualEnd: number }>(
  ranges: T[],
  visualX: number,
  visualY: number,
): T | undefined {
  for (let index = ranges.length - 1; index >= 0; index -= 1) {
    const candidate = ranges[index];
    if (
      visualX >= candidate.visualStart &&
      visualX < candidate.visualEnd &&
      visualY >= candidate.visualStart &&
      visualY < candidate.visualEnd
    ) {
      return candidate;
    }
  }

  return undefined;
}

export function selectedBlockIds(
  blocks: ContactMapLayoutBlock[],
  selection: AssemblySelection | null,
): string[] {
  if (!selection) {
    return [];
  }

  if (selection.kind === "contigs") {
    const selected = new Set(selection.ids);
    return blocks.filter((block) => selected.has(block.id)).map((block) => block.id);
  }

  return blocks.filter((block) => block.objectId === selection.id).map((block) => block.id);
}

function recomputeVisualCoordinates(blocks: ContactMapLayoutBlock[]): ContactMapLayoutBlock[] {
  let visualStart = 0;

  return blocks.map((block) => {
    const length = Math.max(0, block.sourceEnd - block.sourceStart);
    const nextBlock = {
      ...block,
      visualStart,
      visualEnd: visualStart + length,
    };
    visualStart = nextBlock.visualEnd;
    return nextBlock;
  });
}

function buildCopiedBlocks(
  blocks: ContactMapLayoutBlock[],
  selected: Set<string>,
  copiedObjectId: string | null,
) {
  return blocks
    .filter((block) => selected.has(block.id))
    .reduce<ContactMapLayoutBlock[]>((copies, block) => {
      const copyInstanceId = nextCopySourceId([...blocks, ...copies], block.sourceId);
      return [
        ...copies,
        {
          ...block,
          id: nextCopyId([...blocks, ...copies], block, copyInstanceId),
          objectId: copiedObjectId ?? block.objectId,
        },
      ];
    }, []);
}

function nextCopyId(blocks: ContactMapLayoutBlock[], block: ContactMapLayoutBlock, sourceId: string) {
  const existingIds = new Set(blocks.map((block) => block.id));
  let copyNumber = 1;
  const partNumber = block.id.split(":")[1] ?? "1";
  let id = `${block.objectId}:${partNumber}:${sourceId}`;

  while (existingIds.has(id)) {
    copyNumber += 1;
    id = `${block.objectId}:${block.id.split(":")[1] ?? "1"}:${sourceId}_copy${copyNumber}`;
  }

  return id;
}

function nextCopySourceId(blocks: ContactMapLayoutBlock[], sourceId: string) {
  const existingSuffixes = blocks
    .map((block) => extractCopyNumber(block.sourceId, sourceId))
    .filter((value): value is number => value !== null);

  const nextCopyNumber = existingSuffixes.length > 0 ? Math.max(...existingSuffixes) + 1 : 2;
  return `${extractCopyBase(sourceId)}_d${nextCopyNumber}`;
}

function nextCopyObjectId(blocks: ContactMapLayoutBlock[], objectId: string) {
  return reserveNextObjectId(new Set(blocks.map((block) => block.objectId)), objectId);
}

function reserveNextObjectId(occupiedObjectIds: Set<string>, objectId: string) {
  const existingSuffixes = [...occupiedObjectIds]
    .map((candidate) => extractCopyNumber(candidate, objectId))
    .filter((value): value is number => value !== null);

  const nextCopyNumber = existingSuffixes.length > 0 ? Math.max(...existingSuffixes) + 1 : 2;
  const nextObjectId = `${extractCopyBase(objectId)}_d${nextCopyNumber}`;
  occupiedObjectIds.add(nextObjectId);
  return nextObjectId;
}

function extractCopyBase(sourceId: string) {
  return sourceId.replace(/_d\d+$/, "");
}

function extractCopyNumber(sourceId: string, baseSourceId: string) {
  const base = extractCopyBase(baseSourceId);
  const match = sourceId.match(new RegExp(`^${escapeRegExp(base)}_d(\\d+)$`));
  return match ? Number(match[1]) : null;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function flipOrientation(orientation: ContactMapLayoutBlock["orientation"]): ContactMapLayoutBlock["orientation"] {
  if (orientation === "+") {
    return "-";
  }

  if (orientation === "-") {
    return "+";
  }

  return "?";
}
