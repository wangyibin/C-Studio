import type { ContactMapLayoutBlock } from "./importers";
import type { GfaLinkEvidence, GfaSegmentSide } from "./gfa";

export interface AssemblyChromosome {
  id: string;
  visualStart: number;
  visualEnd: number;
  blockIds: string[];
}

export interface AssemblyBlockGroup {
  id: string;
  objectId: string;
  visualStart: number;
  visualEnd: number;
  contigIds: string[];
  isComposite: boolean;
}

export interface AssemblyGapRange {
  id: string;
  objectId: string;
  visualStart: number;
  visualEnd: number;
  leftBlockId: string | null;
  rightBlockId: string;
  metadata: NonNullable<ContactMapLayoutBlock["gapBefore"]>;
}

export interface AssemblyEditModel {
  /** Flat contig placements consumed by the contact/coverage/synteny projections. */
  blocks: ContactMapLayoutBlock[];
  /** Atomic assembly blocks. Singleton blocks use their contig id directly. */
  assemblyBlocks: AssemblyBlockGroup[];
  gaps: AssemblyGapRange[];
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
  | { kind: "contigs"; ids: string[]; exact?: boolean }
  | { kind: "chromosome"; id: string };

export interface AssemblyRenameTarget {
  kind: "contig" | "chromosome";
  currentName: string;
}

export type AssemblyHit =
  | { kind: "contig"; id: string }
  | { kind: "chromosome-boundary"; id: string };

export interface AssemblySelectionModifiers {
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}

export type AssemblyContigSelectionIntent =
  | { type: "clear"; anchorId: null }
  | { type: "select"; id: string; additive: boolean; anchorId: string }
  | { type: "select-range"; ids: string[]; anchorId: string };

export interface MapPoint {
  x: number;
  y: number;
}

export interface AssemblyInsertionTarget {
  targetBlockId: string | null;
  visualPosition: number;
  targetObjectId?: string;
  chromosomeEnd?: "start" | "end";
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
export const DEFAULT_INSERTED_GAP = {
  componentType: "U" as const,
  length: 100,
  gapType: "contig",
  linkage: "no",
  linkageEvidence: "na",
};

export function buildAssemblyEditModel(blocks: ContactMapLayoutBlock[]): AssemblyEditModel {
  const assemblyBlocks = buildAssemblyBlockGroups(blocks);
  const chromosomes = new Map<string, AssemblyChromosome>();

  for (const block of assemblyBlocks) {
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
    assemblyBlocks,
    gaps: buildAssemblyGapRanges(blocks, assemblyBlocks),
    chromosomes: [...chromosomes.values()].sort((left, right) => left.visualStart - right.visualStart),
    totalSpan: Math.max(0, ...blocks.map((block) => block.visualEnd)),
  };
}

export function assemblyUnitId(block: ContactMapLayoutBlock) {
  return block.assemblyBlockId || block.id;
}

export function assemblyUnitIdForContig(
  blocks: ContactMapLayoutBlock[],
  contigOrBlockId: string,
) {
  const block = blocks.find((candidate) => candidate.id === contigOrBlockId);
  if (!block) {
    return contigOrBlockId;
  }
  return block.isSourceSegment ? block.id : assemblyUnitId(block);
}

export function assemblyContigDisplayName(block: ContactMapLayoutBlock) {
  return block.displayName?.trim() || block.sourceId;
}

export function assemblyCopyInstanceId(block: ContactMapLayoutBlock) {
  return block.copyInstanceId?.trim()
    || block.id.replace(/(?::(?:left|right))+$/, "");
}

export interface AssemblyCopyIntervalGroup {
  id: string;
  blocks: ContactMapLayoutBlock[];
  overlappingBlocks: ContactMapLayoutBlock[];
  coversInterval: boolean;
  isSplit: boolean;
}

export function assemblyCopyIntervalGroups(
  blocks: ContactMapLayoutBlock[],
  target: ContactMapLayoutBlock,
): AssemblyCopyIntervalGroup[] {
  const blocksByCopy = new Map<string, ContactMapLayoutBlock[]>();
  for (const block of blocks) {
    if (block.sourceId !== target.sourceId) {
      continue;
    }
    const copyId = assemblyCopyInstanceId(block);
    const copyBlocks = blocksByCopy.get(copyId) ?? [];
    copyBlocks.push(block);
    blocksByCopy.set(copyId, copyBlocks);
  }

  return [...blocksByCopy].map(([id, copyBlocks]) => {
    const orderedBlocks = [...copyBlocks].sort((left, right) => (
      left.sourceStart - right.sourceStart
      || left.sourceEnd - right.sourceEnd
      || left.visualStart - right.visualStart
    ));
    const overlappingBlocks = orderedBlocks.filter((block) => (
      block.sourceEnd > target.sourceStart && block.sourceStart < target.sourceEnd
    ));
    let coveredUntil = target.sourceStart;
    let coversInterval = false;
    for (const block of overlappingBlocks) {
      const intervalStart = Math.max(target.sourceStart, block.sourceStart);
      const intervalEnd = Math.min(target.sourceEnd, block.sourceEnd);
      if (intervalStart > coveredUntil) {
        break;
      }
      coveredUntil = Math.max(coveredUntil, intervalEnd);
      if (coveredUntil >= target.sourceEnd) {
        coversInterval = true;
        break;
      }
    }
    return {
      id,
      blocks: orderedBlocks,
      overlappingBlocks,
      coversInterval,
      isSplit: orderedBlocks.length > 1,
    };
  }).sort((left, right) => (
    Math.min(...left.blocks.map((block) => block.visualStart))
    - Math.min(...right.blocks.map((block) => block.visualStart))
  ));
}

export function assemblyRenameTarget(
  blocks: ContactMapLayoutBlock[],
  selection: AssemblySelection | null,
): AssemblyRenameTarget | null {
  if (selection?.kind === "chromosome") {
    return blocks.some((block) => block.objectId === selection.id)
      ? { kind: "chromosome", currentName: selection.id }
      : null;
  }
  if (selection?.kind !== "contigs" || selection.ids.length !== 1) {
    return null;
  }

  const selectedIds = selectedBlockIds(blocks, selection);
  if (selectedIds.length !== 1) {
    return null;
  }
  const selectedBlock = blocks.find((block) => block.id === selectedIds[0]);
  return selectedBlock
    ? { kind: "contig", currentName: assemblyContigDisplayName(selectedBlock) }
    : null;
}

export function assemblyRenameValidationError(
  blocks: ContactMapLayoutBlock[],
  selection: AssemblySelection | null,
  requestedName: string,
): string | null {
  const target = assemblyRenameTarget(blocks, selection);
  if (!target) {
    return "Select one contig or one chromosome to rename.";
  }
  const name = requestedName.trim();
  if (!name) {
    return "Name cannot be empty.";
  }
  if (/\s/.test(name)) {
    return "AGP names cannot contain whitespace.";
  }
  if (name === target.currentName) {
    return null;
  }
  if (target.kind === "chromosome") {
    return blocks.some((block) => block.objectId === name)
      ? "A chromosome already uses this name."
      : null;
  }

  const selectedIds = new Set(selectedBlockIds(blocks, selection));
  return blocks.some((block) => (
    !selectedIds.has(block.id) && assemblyContigDisplayName(block) === name
  ))
    ? "A contig already uses this name."
    : null;
}

export function renameAssemblySelection(
  blocks: ContactMapLayoutBlock[],
  selection: AssemblySelection | null,
  requestedName: string,
): ContactMapLayoutBlock[] {
  const target = assemblyRenameTarget(blocks, selection);
  const name = requestedName.trim();
  if (
    !target
    || assemblyRenameValidationError(blocks, selection, name)
    || name === target.currentName
  ) {
    return blocks;
  }

  if (target.kind === "chromosome") {
    return blocks.map((block) => block.objectId === target.currentName
      ? { ...block, objectId: name }
      : block);
  }

  const selectedIds = new Set(selectedBlockIds(blocks, selection));
  return blocks.map((block) => {
    if (!selectedIds.has(block.id)) {
      return block;
    }
    return {
      ...block,
      displayName: name === block.sourceId ? undefined : name,
    };
  });
}

function buildAssemblyBlockGroups(blocks: ContactMapLayoutBlock[]): AssemblyBlockGroup[] {
  return orderedAssemblyUnits(blocks).map((unit) => ({
    id: unit.id,
    objectId: unit.objectId,
    visualStart: Math.min(...unit.blocks.map((block) => block.visualStart)),
    visualEnd: Math.max(...unit.blocks.map((block) => block.visualEnd)),
    contigIds: unit.blocks.map((block) => block.id),
    isComposite: unit.blocks.length > 1,
  }));
}

function buildAssemblyGapRanges(
  blocks: ContactMapLayoutBlock[],
  assemblyBlocks: AssemblyBlockGroup[],
): AssemblyGapRange[] {
  const unitByContigId = new Map(
    assemblyBlocks.flatMap((block) => block.contigIds.map((contigId) => [contigId, block.id] as const)),
  );
  const gaps: AssemblyGapRange[] = [];

  blocks.forEach((block, index) => {
    const gap = block.gapBefore;
    if (!gap || gap.length <= 0) {
      return;
    }
    const previous = index > 0 && blocks[index - 1]?.objectId === block.objectId
      ? blocks[index - 1]
      : null;
    gaps.push({
      id: `${block.objectId}:gap-before:${block.id}`,
      objectId: block.objectId,
      visualStart: block.visualStart - gap.length,
      visualEnd: block.visualStart,
      leftBlockId: previous ? unitByContigId.get(previous.id) ?? assemblyUnitId(previous) : null,
      rightBlockId: unitByContigId.get(block.id) ?? assemblyUnitId(block),
      metadata: gap,
    });
  });

  return gaps;
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

export function assemblyContigIdsBetween(
  blocks: ContactMapLayoutBlock[],
  anchorId: string,
  targetId: string,
) {
  const orderedBlocks = [...blocks].sort((left, right) => (
    left.visualStart - right.visualStart || left.visualEnd - right.visualEnd
  ));
  const units = orderedAssemblyUnits(orderedBlocks);
  const resolvedAnchorId = resolveAssemblyUnitId(units, anchorId);
  const resolvedTargetId = resolveAssemblyUnitId(units, targetId);
  const anchorIndex = units.findIndex((unit) => unit.id === resolvedAnchorId);
  const targetIndex = units.findIndex((unit) => unit.id === resolvedTargetId);
  if (targetIndex < 0) {
    return [];
  }
  if (anchorIndex < 0) {
    return [units[targetIndex].id];
  }

  const startIndex = Math.min(anchorIndex, targetIndex);
  const endIndex = Math.max(anchorIndex, targetIndex);
  return units.slice(startIndex, endIndex + 1).map((unit) => unit.id);
}

export function assemblyContigSelectionIntent(
  blocks: ContactMapLayoutBlock[],
  selection: AssemblySelection | null,
  _anchorId: string | null,
  targetId: string,
  modifiers: AssemblySelectionModifiers,
): AssemblyContigSelectionIntent {
  if (modifiers.metaKey || modifiers.ctrlKey) {
    return { type: "select", id: targetId, additive: true, anchorId: targetId };
  }

  if (
    modifiers.shiftKey
    && selection?.kind === "contigs"
    && (
      selection.ids.includes(targetId)
      || selectedBlockIds(blocks, selection).includes(targetId)
    )
  ) {
    return { type: "clear", anchorId: null };
  }

  return { type: "select", id: targetId, additive: false, anchorId: targetId };
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

  for (const block of buildAssemblyBlockGroups(blocks)) {
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
    if (block.contigIds.some((id) => selected.has(id))) {
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
  const units = orderedAssemblyUnits(blocks);
  const selectedUnitIds = selectedAssemblyUnitIds(units, selection);
  if (selectedUnitIds.size === 0) {
    return blocks;
  }

  const reversed = units
    .filter((unit) => selectedUnitIds.has(unit.id))
    .reverse()
    .map((unit) => reverseAssemblyUnit(unit));
  const reversedGapBeforeBySlot = reverseSelectedGapOrder(units, selectedUnitIds);
  let nextReversedIndex = 0;
  const reorderedUnits = units.map((slot, slotIndex) => {
    if (!selectedUnitIds.has(slot.id)) {
      return slot;
    }

    const reversedUnit = reversed[nextReversedIndex++];
    return retargetAssemblyUnit(reversedUnit, slot.objectId, {
      value: reversedGapBeforeBySlot.get(slotIndex),
    });
  });
  const structured = hasExplicitAssemblyStructure(blocks);
  const bounded = ensureAssemblyUnitBoundaries(reorderedUnits, structured)
    .flatMap((unit) => unit.blocks);

  return recomputeVisualCoordinates(
    structured ? rebuildAssemblyBlockMembership(bounded) : bounded,
  );
}

export function moveSelectionBefore(
  blocks: ContactMapLayoutBlock[],
  selection: AssemblySelection | null,
  targetBlockId: string | null,
  targetObjectId?: string,
): ContactMapLayoutBlock[] {
  const units = orderedAssemblyUnits(blocks);
  const selectedUnitIds = selectedAssemblyUnitIds(units, selection);
  const resolvedTargetId = targetBlockId === null
    ? null
    : resolveAssemblyUnitId(units, targetBlockId);
  if (
    selectedUnitIds.size === 0
    || (resolvedTargetId !== null && selectedUnitIds.has(resolvedTargetId))
    || (targetBlockId === null && selection?.kind !== "chromosome" && !targetObjectId)
  ) {
    return blocks;
  }

  const movingUnits = units.filter((unit) => selectedUnitIds.has(unit.id));
  const remainingUnits = units.filter((unit) => !selectedUnitIds.has(unit.id));
  const targetIndex = targetBlockId === null
    ? remainingUnits.length
    : remainingUnits.findIndex((unit) => unit.id === resolvedTargetId);
  if (targetIndex < 0) {
    return blocks;
  }

  const resolvedTargetObjectId = targetObjectId
    ?? remainingUnits[targetIndex]?.objectId
    ?? movingUnits[0]?.objectId;
  const retargetedMovingUnits = selection?.kind === "chromosome" && !targetObjectId
    ? movingUnits
    : movingUnits.map((unit) => retargetAssemblyUnit(unit, resolvedTargetObjectId));
  const reorderedUnits = ensureAssemblyUnitBoundaries([
    ...remainingUnits.slice(0, targetIndex),
    ...retargetedMovingUnits,
    ...remainingUnits.slice(targetIndex),
  ], hasExplicitAssemblyStructure(blocks));
  const reordered = reorderedUnits.flatMap((unit) => unit.blocks);

  if (reordered.length !== blocks.length) {
    return blocks;
  }

  if (reordered.every((block, index) => (
    block.id === blocks[index]?.id && block.objectId === blocks[index]?.objectId
  ))) {
    return blocks;
  }

  return recomputeVisualCoordinates(
    hasExplicitAssemblyStructure(blocks)
      ? rebuildAssemblyBlockMembership(reordered)
      : reordered,
  );
}

export function moveSelectionToDebris(
  blocks: ContactMapLayoutBlock[],
  selection: AssemblySelection | null,
): ContactMapLayoutBlock[] {
  const units = orderedAssemblyUnits(blocks);
  const selectedUnitIds = selectedAssemblyUnitIds(units, selection);
  if (selectedUnitIds.size === 0) {
    return blocks;
  }

  const movingUnits = units
    .filter((unit) => selectedUnitIds.has(unit.id))
    .map((unit) => retargetAssemblyUnit(unit, DEBRIS_OBJECT_ID));
  const remainingUnits = units.filter((unit) => !selectedUnitIds.has(unit.id));
  const reorderedUnits = ensureAssemblyUnitBoundaries(
    [...remainingUnits, ...movingUnits],
    hasExplicitAssemblyStructure(blocks),
  );

  const reordered = reorderedUnits.flatMap((unit) => unit.blocks);
  return recomputeVisualCoordinates(
    hasExplicitAssemblyStructure(blocks)
      ? rebuildAssemblyBlockMembership(reordered)
      : reordered,
  );
}

export function deleteContigSelection(
  blocks: ContactMapLayoutBlock[],
  selection: AssemblySelection | null,
): ContactMapLayoutBlock[] {
  if (selection?.kind !== "contigs") {
    return blocks;
  }

  const selected = new Set(selectedBlockIds(blocks, selection));
  if (selected.size === 0) {
    return blocks;
  }

  const remaining = blocks.filter((block) => !selected.has(block.id));
  const structured = hasExplicitAssemblyStructure(blocks);
  const bounded = ensureFlatAssemblyBoundaries(remaining, structured);
  return recomputeVisualCoordinates(
    structured ? rebuildAssemblyBlockMembership(bounded) : bounded,
  );
}

export interface GfaBlockJoinPlan {
  leftBlockId: string;
  rightBlockId: string;
  linkId: string | null;
  overlap: string | null;
  trimRightBases: number;
}

export type GfaBlockCreationPlan =
  | { ok: true; selectedBlockIds: string[]; joins: GfaBlockJoinPlan[] }
  | { ok: false; reason: string };

export interface UnplacedGfaPlacementInput {
  segmentName: string;
  length: number;
  targetObjectId: string;
  /** Insert before this assembly unit; null appends to the target object. */
  targetBlockId: string | null;
  orientation: "+" | "-";
}

export type UnplacedGfaPlacementPlan =
  | {
      ok: true;
      blocks: ContactMapLayoutBlock[];
      insertedBlockId: string;
      insertedIndex: number;
      gapBefore: ContactMapLayoutBlock["gapBefore"];
      gapAfter: ContactMapLayoutBlock["gapBefore"];
    }
  | { ok: false; reason: string };

/**
 * Build an explicit AGP placement for one GFA segment that is absent from the
 * current assembly. GFA topology remains evidence only: new boundaries use an
 * unknown 100 bp AGP gap instead of inferring adjacency from an L record.
 */
export function planUnplacedGfaPlacement(
  blocks: ContactMapLayoutBlock[],
  input: UnplacedGfaPlacementInput,
): UnplacedGfaPlacementPlan {
  if (!input.segmentName.trim()) {
    return { ok: false, reason: "The GFA segment name is empty." };
  }
  if (!Number.isSafeInteger(input.length) || input.length <= 0) {
    return { ok: false, reason: "The GFA segment needs a known positive integer length." };
  }
  if (input.orientation !== "+" && input.orientation !== "-") {
    return { ok: false, reason: "Choose a forward or reverse orientation." };
  }
  if (blocks.some((block) => block.sourceId === input.segmentName)) {
    return { ok: false, reason: `${input.segmentName} is already placed in the current AGP.` };
  }

  const units = orderedAssemblyUnits(blocks);
  const objectUnits = units.filter((unit) => unit.objectId === input.targetObjectId);
  if (objectUnits.length === 0) {
    return { ok: false, reason: `Target chromosome ${input.targetObjectId} is not available.` };
  }

  let insertedIndex: number;
  if (input.targetBlockId === null) {
    const lastObjectBlockIndex = blocks.reduce((lastIndex, block, index) => (
      block.objectId === input.targetObjectId ? index : lastIndex
    ), -1);
    insertedIndex = lastObjectBlockIndex + 1;
  } else {
    const resolvedTargetId = resolveAssemblyUnitId(units, input.targetBlockId);
    const targetUnit = units.find((unit) => unit.id === resolvedTargetId);
    if (!targetUnit || targetUnit.objectId !== input.targetObjectId) {
      return { ok: false, reason: "The insertion point is not on the selected chromosome." };
    }
    insertedIndex = blocks.findIndex((block) => block.id === targetUnit.blocks[0]?.id);
  }
  if (insertedIndex < 0 || insertedIndex > blocks.length) {
    return { ok: false, reason: "The insertion point is no longer available." };
  }

  const previous = blocks[insertedIndex - 1];
  const next = blocks[insertedIndex];
  const hasPreviousInObject = previous?.objectId === input.targetObjectId;
  const hasNextInObject = next?.objectId === input.targetObjectId;
  const insertedBlockId = nextGfaPlacementId(
    blocks,
    input.targetObjectId,
    input.segmentName,
  );
  const inserted: ContactMapLayoutBlock = {
    id: insertedBlockId,
    objectId: input.targetObjectId,
    sourceId: input.segmentName,
    sourceStart: 0,
    sourceEnd: input.length,
    visualStart: 0,
    visualEnd: input.length,
    orientation: input.orientation,
    componentType: "W",
    assemblyBlockId: null,
    gapBefore: hasPreviousInObject ? { ...DEFAULT_INSERTED_GAP } : undefined,
  };
  const placed = [
    ...blocks.slice(0, insertedIndex),
    inserted,
    ...blocks.slice(insertedIndex),
  ];

  // A segment placed at the start or in the middle also needs an explicit
  // boundary on its right. Preserve an existing positive AGP gap when one is
  // already attached to the following unit; otherwise create an unknown gap.
  if (hasNextInObject) {
    const followingIndex = insertedIndex + 1;
    const following = placed[followingIndex]!;
    if (!following.gapBefore || following.gapBefore.length <= 0) {
      placed[followingIndex] = {
        ...following,
        gapBefore: { ...DEFAULT_INSERTED_GAP },
      };
    }
  }

  const structured = hasExplicitAssemblyStructure(blocks);
  const normalized = recomputeVisualCoordinates(
    structured ? rebuildAssemblyBlockMembership(placed) : placed,
  );
  const normalizedInsertedIndex = normalized.findIndex((block) => block.id === insertedBlockId);
  const normalizedNext = normalized[normalizedInsertedIndex + 1];
  return {
    ok: true,
    blocks: normalized,
    insertedBlockId,
    insertedIndex: normalizedInsertedIndex,
    gapBefore: normalized[normalizedInsertedIndex]?.gapBefore,
    gapAfter: normalizedNext?.objectId === input.targetObjectId
      ? normalizedNext.gapBefore
      : undefined,
  };
}

export function placeUnplacedGfaSegment(
  blocks: ContactMapLayoutBlock[],
  input: UnplacedGfaPlacementInput,
) {
  const plan = planUnplacedGfaPlacement(blocks, input);
  return plan.ok ? plan.blocks : blocks;
}

/**
 * Validate the exact, current AGP neighbours that a user wants to turn into
 * one logical block. A positive overlap is accepted only from one uniquely
 * oriented GFA L record with a simple ungapped M/= CIGAR; indel and clipped
 * CIGARs remain review-only.
 */
export function planGfaBlockCreation(
  blocks: ContactMapLayoutBlock[],
  selection: AssemblySelection | null,
  links: ReadonlyArray<GfaLinkEvidence>,
): GfaBlockCreationPlan {
  const selectedIds = new Set(selectedBlockIds(blocks, selection));
  const selected = blocks.filter((block) => selectedIds.has(block.id));
  if (selected.length < 2) {
    return { ok: false, reason: "Select at least two adjacent utgs." };
  }
  const firstIndex = blocks.findIndex((block) => block.id === selected[0].id);
  const contiguous = selected.every((block, index) => blocks[firstIndex + index]?.id === block.id);
  if (!contiguous || selected.some((block) => block.objectId !== selected[0].objectId)) {
    return { ok: false, reason: "Selected utgs must be consecutive on one chromosome." };
  }
  const existingBlockId = selected[0].assemblyBlockId;
  if (existingBlockId && selected.every((block) => block.assemblyBlockId === existingBlockId)) {
    return { ok: false, reason: "Selected utgs already belong to one block." };
  }

  const joins: GfaBlockJoinPlan[] = [];
  for (let index = 1; index < selected.length; index += 1) {
    const left = selected[index - 1];
    const right = selected[index];
    const leftSide = displayedAssemblySide(left, "right");
    const rightSide = displayedAssemblySide(right, "left");
    const betweenSources = links.filter((link) => (
      (link.from.segmentName === left.sourceId && link.to.segmentName === right.sourceId)
      || (link.from.segmentName === right.sourceId && link.to.segmentName === left.sourceId)
    ));
    const matches = betweenSources.filter((link) => gfaLinkMatchesBoundary(
      link,
      left.sourceId,
      leftSide,
      right.sourceId,
      rightSide,
    ));
    if (matches.length > 1) {
      return { ok: false, reason: `Multiple GFA overlaps match ${left.sourceId} → ${right.sourceId}.` };
    }
    if (matches.length === 0 && betweenSources.length > 0) {
      return { ok: false, reason: `GFA link orientation conflicts at ${left.sourceId} → ${right.sourceId}.` };
    }
    const link = matches[0] ?? null;
    const trimRightBases = link ? exactGfaOverlapLength(link.overlap) : 0;
    if (link && trimRightBases === null) {
      return { ok: false, reason: `Overlap ${link.overlap} is not a simple ungapped M/= CIGAR; review it before joining.` };
    }
    if ((trimRightBases ?? 0) > 0 && !isKnownAssemblyOrientation(right.orientation)) {
      return { ok: false, reason: `Orientation ${right.orientation} cannot safely resolve the overlap on ${right.sourceId}.` };
    }
    if ((trimRightBases ?? 0) >= right.sourceEnd - right.sourceStart) {
      return { ok: false, reason: `Overlap is not shorter than ${right.sourceId}.` };
    }
    joins.push({
      leftBlockId: left.id,
      rightBlockId: right.id,
      linkId: link?.id ?? null,
      overlap: link?.overlap ?? null,
      trimRightBases: trimRightBases ?? 0,
    });
  }
  return { ok: true, selectedBlockIds: selected.map((block) => block.id), joins };
}

/** Apply one validated GFA-aware block creation without modifying the source FASTA. */
export function createAssemblyBlockFromGfa(
  blocks: ContactMapLayoutBlock[],
  selection: AssemblySelection | null,
  links: ReadonlyArray<GfaLinkEvidence>,
): ContactMapLayoutBlock[] {
  const plan = planGfaBlockCreation(blocks, selection, links);
  if (!plan.ok) {
    return blocks;
  }
  const selectedIds = new Set(plan.selectedBlockIds);
  const joinByRightId = new Map(plan.joins.map((join) => [join.rightBlockId, join]));
  const edited = blocks.map((block) => {
    const join = joinByRightId.get(block.id);
    if (!selectedIds.has(block.id)) {
      return block;
    }
    let next = { ...block };
    if (join) {
      next.gapBefore = undefined;
      if (join.trimRightBases > 0 && join.linkId && join.overlap) {
        next.gfaOverlapBefore = {
          linkId: join.linkId,
          cigar: join.overlap,
          trimmedBases: join.trimRightBases,
          originalSourceStart: block.sourceStart,
          originalSourceEnd: block.sourceEnd,
        };
        if (block.orientation === "-") {
          next.sourceEnd -= join.trimRightBases;
        } else {
          next.sourceStart += join.trimRightBases;
        }
      }
    }
    return next;
  });
  return recomputeVisualCoordinates(rebuildAssemblyBlockMembership(edited));
}

/** Split selected composite blocks into singleton logical units and undo their GFA overlap trims. */
export function dissolveAssemblyBlockSelection(
  blocks: ContactMapLayoutBlock[],
  selection: AssemblySelection | null,
): ContactMapLayoutBlock[] {
  const selectedIds = new Set(selectedBlockIds(blocks, selection));
  const selectedCompositeIds = new Set(
    blocks
      .filter((block) => selectedIds.has(block.id) && block.assemblyBlockId)
      .map((block) => block.assemblyBlockId!),
  );
  if (selectedCompositeIds.size === 0) {
    return blocks;
  }
  let changed = false;
  const firstIndexByCompositeId = new Map<string, number>();
  blocks.forEach((block, index) => {
    if (block.assemblyBlockId && !firstIndexByCompositeId.has(block.assemblyBlockId)) {
      firstIndexByCompositeId.set(block.assemblyBlockId, index);
    }
  });
  const edited = blocks.map((block, index) => {
    if (!block.assemblyBlockId || !selectedCompositeIds.has(block.assemblyBlockId)) {
      return block;
    }
    changed = true;
    const overlap = block.gfaOverlapBefore;
    return {
      ...block,
      assemblyBlockId: null,
      gapBefore: index === firstIndexByCompositeId.get(block.assemblyBlockId)
        ? block.gapBefore
        : { ...DEFAULT_INSERTED_GAP },
      sourceStart: overlap?.originalSourceStart ?? block.sourceStart,
      sourceEnd: overlap?.originalSourceEnd ?? block.sourceEnd,
      gfaOverlapBefore: undefined,
    };
  });
  return changed ? recomputeVisualCoordinates(rebuildAssemblyBlockMembership(edited)) : blocks;
}

/** True when the current selection touches at least one composite assembly block. */
export function hasDissolvableAssemblyBlock(
  blocks: ContactMapLayoutBlock[],
  selection: AssemblySelection | null,
) {
  const selectedIds = new Set(selectedBlockIds(blocks, selection));
  return blocks.some((block) => selectedIds.has(block.id) && Boolean(block.assemblyBlockId));
}

function displayedAssemblySide(
  block: ContactMapLayoutBlock,
  displayed: "left" | "right",
): GfaSegmentSide {
  if (block.orientation === "-") {
    return displayed === "left" ? "end" : "start";
  }
  return displayed === "left" ? "start" : "end";
}

function gfaLinkMatchesBoundary(
  link: GfaLinkEvidence,
  leftName: string,
  leftSide: GfaSegmentSide,
  rightName: string,
  rightSide: GfaSegmentSide,
) {
  return (
    link.from.segmentName === leftName
    && link.from.side === leftSide
    && link.to.segmentName === rightName
    && link.to.side === rightSide
  ) || (
    link.to.segmentName === leftName
    && link.to.side === leftSide
    && link.from.segmentName === rightName
    && link.from.side === rightSide
  );
}

function exactGfaOverlapLength(cigar: string): number | null {
  if (cigar === "*") {
    return null;
  }
  const operations = [...cigar.matchAll(/(\d+)([M=])/g)];
  if (operations.length === 0 || operations.map((match) => match[0]).join("") !== cigar) {
    return null;
  }
  const length = operations.reduce((sum, match) => sum + Number(match[1]), 0);
  return Number.isSafeInteger(length) ? length : null;
}

function isKnownAssemblyOrientation(orientation: ContactMapLayoutBlock["orientation"]) {
  return orientation === "+" || orientation === "-";
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

  const retargeted = blocks.map((block, blockIndex) => ({
    ...block,
    objectId: nextObjectIdByBlockIndex.get(blockIndex) ?? block.objectId,
  }));
  const structured = hasExplicitAssemblyStructure(blocks);
  const bounded = ensureFlatAssemblyBoundaries(retargeted, structured);
  return recomputeVisualCoordinates(
    structured ? rebuildAssemblyBlockMembership(bounded) : bounded,
  );
}

function chromosomeBoundaryIndexesWithinSelection(
  blocks: ContactMapLayoutBlock[],
  selection: AssemblySelection | null,
) {
  if (selection?.kind !== "contigs") {
    return [];
  }

  const units = orderedAssemblyUnits(blocks);
  const selectedUnitIds = selectedAssemblyUnitIds(units, selection);
  const boundaryIndexes: number[] = [];
  for (let index = 1; index < units.length; index += 1) {
    const left = units[index - 1];
    const right = units[index];
    if (
      selectedUnitIds.has(left.id)
      && selectedUnitIds.has(right.id)
      && left.objectId !== right.objectId
    ) {
      boundaryIndexes.push(index);
    }
  }
  return boundaryIndexes;
}

export function hasRemovableChromosomeBoundary(
  blocks: ContactMapLayoutBlock[],
  selection: AssemblySelection | null,
) {
  return chromosomeBoundaryIndexesWithinSelection(blocks, selection).length > 0;
}

export function removeChromosomeBoundariesFromSelection(
  blocks: ContactMapLayoutBlock[],
  selection: AssemblySelection | null,
): ContactMapLayoutBlock[] {
  const units = orderedAssemblyUnits(blocks);
  const boundaryIndexes = chromosomeBoundaryIndexesWithinSelection(blocks, selection);
  if (boundaryIndexes.length === 0) {
    return blocks;
  }

  // Merge every chromosome boundary enclosed by the selection into the
  // chromosome on its left. Retarget the complete chromosome, not only the
  // selected edge blocks, so the resulting AGP object remains coherent.
  const mergedInto = new Map<string, string>();
  const resolveObjectId = (objectId: string) => {
    let resolved = objectId;
    const visited = new Set<string>();
    while (mergedInto.has(resolved) && !visited.has(resolved)) {
      visited.add(resolved);
      resolved = mergedInto.get(resolved) ?? resolved;
    }
    return resolved;
  };

  boundaryIndexes.forEach((index) => {
    const leftObjectId = resolveObjectId(units[index - 1].objectId);
    const rightObjectId = resolveObjectId(units[index].objectId);
    if (leftObjectId !== rightObjectId) {
      mergedInto.set(rightObjectId, leftObjectId);
    }
  });

  const retargeted = blocks.map((block) => ({
    ...block,
    objectId: resolveObjectId(block.objectId),
  }));
  const structured = hasExplicitAssemblyStructure(blocks);
  const bounded = ensureFlatAssemblyBoundaries(retargeted, structured);
  return recomputeVisualCoordinates(
    structured ? rebuildAssemblyBlockMembership(bounded) : bounded,
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
  let reordered: ContactMapLayoutBlock[];
  if (copiedObjectId) {
    const copiedBlocks = buildCopiedBlocks(blocks, selected, copiedObjectId);
    const lastSelectedIndex = Math.max(
      ...blocks.map((block, index) => (selected.has(block.id) ? index : -1)),
    );
    reordered = [
      ...blocks.slice(0, lastSelectedIndex + 1),
      ...copiedBlocks,
      ...blocks.slice(lastSelectedIndex + 1),
    ];
  } else {
    const selectedIdsByObject = new Map<string, Set<string>>();
    const lastSelectedIndexByObject = new Map<string, number>();
    blocks.forEach((block, index) => {
      if (!selected.has(block.id)) {
        return;
      }
      const objectSelection = selectedIdsByObject.get(block.objectId) ?? new Set<string>();
      objectSelection.add(block.id);
      selectedIdsByObject.set(block.objectId, objectSelection);
      lastSelectedIndexByObject.set(block.objectId, index);
    });
    const copiedBlocksByObject = new Map(
      [...selectedIdsByObject].map(([objectId, objectSelection]) => [
        objectId,
        buildCopiedBlocks(blocks, objectSelection, null),
      ] as const),
    );
    reordered = blocks.flatMap((block, index) => (
      lastSelectedIndexByObject.get(block.objectId) === index
        ? [block, ...(copiedBlocksByObject.get(block.objectId) ?? [])]
        : [block]
    ));
  }
  const structured = hasExplicitAssemblyStructure(blocks);
  const bounded = ensureFlatAssemblyBoundaries(reordered, structured);
  return recomputeVisualCoordinates(structured ? rebuildAssemblyBlockMembership(bounded) : bounded);
}

export function copySelectionBefore(
  blocks: ContactMapLayoutBlock[],
  selection: AssemblySelection | null,
  targetBlockId: string,
): ContactMapLayoutBlock[] {
  const selectedIds = selectedBlockIds(blocks, selection);
  const units = orderedAssemblyUnits(blocks);
  const resolvedTargetId = resolveAssemblyUnitId(units, targetBlockId);
  const selectedUnitIds = selectedAssemblyUnitIds(units, selection);
  if (selectedIds.length === 0 || selectedUnitIds.has(resolvedTargetId)) {
    return blocks;
  }

  const targetUnit = units.find((unit) => unit.id === resolvedTargetId);
  const targetIndex = targetUnit
    ? blocks.findIndex((block) => block.id === targetUnit.blocks[0]?.id)
    : -1;
  const targetBlock = blocks[targetIndex];
  if (!targetBlock) {
    return blocks;
  }

  const copiedBlocks = buildCopiedBlocks(blocks, new Set(selectedIds), targetBlock.objectId);
  const structured = hasExplicitAssemblyStructure(blocks);
  const bounded = ensureFlatAssemblyBoundaries([
    ...blocks.slice(0, targetIndex),
    ...copiedBlocks,
    ...blocks.slice(targetIndex),
  ], structured);
  return recomputeVisualCoordinates(structured ? rebuildAssemblyBlockMembership(bounded) : bounded);
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

  const sourceCut = block.orientation === "-"
    ? block.sourceEnd - offset
    : block.sourceStart + offset;
  const copyInstanceId = assemblyCopyInstanceId(block);
  const splitParent = {
    id: block.id,
    displayName: block.displayName,
    isSourceSegment: block.isSourceSegment,
    copyInstanceId: block.copyInstanceId,
    splitParent: block.splitParent,
  };

  const left: ContactMapLayoutBlock = {
    ...block,
    id: `${block.id}:left`,
    copyInstanceId,
    splitParent,
    sourceStart: block.orientation === "-" ? sourceCut : block.sourceStart,
    sourceEnd: block.orientation === "-" ? block.sourceEnd : sourceCut,
    isSourceSegment: true,
    assemblyBlockId: null,
  };
  const right: ContactMapLayoutBlock = {
    ...block,
    id: `${block.id}:right`,
    copyInstanceId,
    splitParent,
    sourceStart: block.orientation === "-" ? block.sourceStart : sourceCut,
    sourceEnd: block.orientation === "-" ? sourceCut : block.sourceEnd,
    isSourceSegment: true,
    assemblyBlockId: null,
    gapBefore: { ...DEFAULT_INSERTED_GAP },
  };

  return recomputeVisualCoordinates(rebuildAssemblyBlockMembership([
    ...blocks.slice(0, blockIndex),
    left,
    right,
    ...blocks.slice(blockIndex + 1),
  ]));
}

export function hasDeletableGap(
  blocks: ContactMapLayoutBlock[],
  selection: AssemblySelection | null,
) {
  if (selection?.kind !== "contigs") {
    return false;
  }
  const units = orderedAssemblyUnits(blocks);
  const selected = selectedAssemblyUnitIds(units, selection);
  return units.some((unit, index) => (
    index > 0
    && selected.has(unit.id)
    && selected.has(units[index - 1].id)
    && units[index - 1].objectId === unit.objectId
    && Boolean(unit.blocks[0]?.gapBefore?.length)
  ));
}

export function deleteGapsBetweenSelection(
  blocks: ContactMapLayoutBlock[],
  selection: AssemblySelection | null,
): ContactMapLayoutBlock[] {
  if (selection?.kind !== "contigs") {
    return blocks;
  }
  const selected = new Set(selectedBlockIds(blocks, selection));
  const deletedGapBeforeIds = new Set<string>();
  const joinedBlocks = blocks.map((block, index) => {
    const previous = blocks[index - 1];
    if (
      !previous
      || previous.objectId !== block.objectId
      || !selected.has(previous.id)
      || !selected.has(block.id)
      || !block.gapBefore?.length
    ) {
      return block;
    }

    deletedGapBeforeIds.add(block.id);
    return { ...block, gapBefore: undefined };
  });

  if (deletedGapBeforeIds.size === 0) {
    return blocks;
  }

  const restoredBlocks = joinedBlocks.reduce<ContactMapLayoutBlock[]>((result, block) => {
    const previous = result[result.length - 1];
    if (
      previous
      && deletedGapBeforeIds.has(block.id)
      && canRestoreSplitSiblings(previous, block)
    ) {
      result[result.length - 1] = restoreSplitSiblings(previous, block);
      return result;
    }
    result.push(block);
    return result;
  }, []);

  return recomputeVisualCoordinates(
    rebuildAssemblyBlockMembership(restoredBlocks),
  );
}

function canRestoreSplitSiblings(
  left: ContactMapLayoutBlock,
  right: ContactMapLayoutBlock,
) {
  const leftParentId = left.splitParent?.id ?? directSplitParentId(left.id);
  const rightParentId = right.splitParent?.id ?? directSplitParentId(right.id);
  const sourceIntervalsTouch = left.sourceEnd === right.sourceStart
    || right.sourceEnd === left.sourceStart;
  return Boolean(
    leftParentId
    && leftParentId === rightParentId
    && left.objectId === right.objectId
    && left.sourceId === right.sourceId
    && assemblyCopyInstanceId(left) === assemblyCopyInstanceId(right)
    && left.orientation === right.orientation
    && sourceIntervalsTouch,
  );
}

function directSplitParentId(id: string) {
  const parentId = id.replace(/:(?:left|right)$/, "");
  return parentId === id ? null : parentId;
}

function restoreSplitSiblings(
  left: ContactMapLayoutBlock,
  right: ContactMapLayoutBlock,
): ContactMapLayoutBlock {
  const splitParent = left.splitParent?.id === right.splitParent?.id
    ? left.splitParent
    : undefined;
  const id = splitParent?.id ?? directSplitParentId(left.id) ?? left.id;
  const sourceStart = Math.min(left.sourceStart, right.sourceStart);
  const sourceEnd = Math.max(left.sourceEnd, right.sourceEnd);
  const fallbackIsSourceSegment = /:(?:left|right)$/.test(id);
  return {
    ...left,
    id,
    sourceStart,
    sourceEnd,
    displayName: splitParent
      ? splitParent.displayName
      : left.displayName === right.displayName
        ? left.displayName
        : undefined,
    isSourceSegment: splitParent?.isSourceSegment ?? fallbackIsSourceSegment,
    copyInstanceId: splitParent?.copyInstanceId ?? assemblyCopyInstanceId(left),
    splitParent: splitParent?.splitParent,
  };
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

  // A split segment is an independently selectable contig even when its left
  // half remains visually nested inside the original no-gap assembly block.
  const sourceSegment = findLastInBox(
    model.blocks.filter((block) => block.isSourceSegment),
    visualX,
    visualY,
  );
  if (sourceSegment) {
    return { kind: "contig", id: sourceSegment.id };
  }

  const block = findLastInBox(model.assemblyBlocks, visualX, visualY);
  if (block) {
    return { kind: "contig", id: block.id };
  }

  const chromosome = findLastInBox(model.chromosomes, visualX, visualY);
  if (chromosome && pointSelectsWholeChromosome(chromosome, visualX, visualY)) {
    return { kind: "chromosome-boundary", id: chromosome.id };
  }

  return null;
}

export function pointSelectsWholeChromosome(
  chromosome: Pick<AssemblyChromosome, "visualStart" | "visualEnd">,
  visualX: number,
  visualY: number,
) {
  const span = chromosome.visualEnd - chromosome.visualStart;
  if (span <= 0) {
    return false;
  }
  const midpoint = chromosome.visualStart + span / 2;
  return (visualX >= midpoint && visualY < midpoint)
    || (visualX < midpoint && visualY >= midpoint);
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

  return model.assemblyBlocks
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
  const selectedBlocks = model.assemblyBlocks.filter((block) => (
    block.contigIds.some((id) => selectedIds.has(id)) || selectedIds.has(block.id)
  ));
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

  if (selectionKind !== "chromosome") {
    for (const target of chromosomeEndInsertionTargets(model, selectedIds)) {
      const boundaryX = ((target.visualPosition - viewportXStart) / viewportXSpan) * widthPx;
      const boundaryY = ((target.visualPosition - viewportYStart) / viewportYSpan) * heightPx;
      const offset = target.chromosomeEnd === "start" ? 9 : -9;
      const targetX = boundaryX + offset;
      const targetY = boundaryY + offset;
      if (
        Math.abs(point.x - targetX) <= tolerancePx
        && Math.abs(point.y - targetY) <= tolerancePx
      ) {
        return target;
      }
    }
  }

  for (let index = 0; index < model.assemblyBlocks.length; index += 1) {
    const target = model.assemblyBlocks[index];
    const previous = index > 0 ? model.assemblyBlocks[index - 1] : null;
    const isChromosomeBoundary = previous === null || previous.objectId !== target.objectId;
    const previousSelected = previous
      ? selectedIds.has(previous.id) || previous.contigIds.some((id) => selectedIds.has(id))
      : false;
    const targetSelected = selectedIds.has(target.id)
      || target.contigIds.some((id) => selectedIds.has(id));
    if (
      (selectionKind !== "chromosome" && isChromosomeBoundary)
      || (selectionKind === "chromosome"
        && !isChromosomeBoundary
        && target.objectId === DEBRIS_OBJECT_ID)
      || previousSelected
      || targetSelected
    ) {
      continue;
    }

    const boundaryX = ((target.visualStart - viewportXStart) / viewportXSpan) * widthPx;
    const boundaryY = ((target.visualStart - viewportYStart) / viewportYSpan) * heightPx;
    if (
      Math.abs(point.x - boundaryX) <= tolerancePx
      && Math.abs(point.y - boundaryY) <= tolerancePx
    ) {
      return {
        targetBlockId: target.id,
        visualPosition: target.visualStart,
        ...(selectionKind === "chromosome" && !isChromosomeBoundary
          ? { targetObjectId: target.objectId }
          : {}),
      };
    }
  }

  const lastBlock = model.assemblyBlocks[model.assemblyBlocks.length - 1];
  if (
    selectionKind === "chromosome"
    && lastBlock
    && lastBlock.objectId !== DEBRIS_OBJECT_ID
    && !selectedIds.has(lastBlock.id)
    && !lastBlock.contigIds.some((id) => selectedIds.has(id))
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

export function chromosomeEndInsertionTargets(
  model: AssemblyEditModel,
  selectedIds: ReadonlySet<string>,
): AssemblyInsertionTarget[] {
  const blockIsSelected = (block: AssemblyEditModel["assemblyBlocks"][number] | undefined) => (
    Boolean(block)
    && (selectedIds.has(block!.id) || block!.contigIds.some((id) => selectedIds.has(id)))
  );
  const targets: AssemblyInsertionTarget[] = [];

  for (const chromosome of model.chromosomes) {
    if (chromosome.id === DEBRIS_OBJECT_ID) {
      continue;
    }
    const firstIndex = model.assemblyBlocks.findIndex((block) => block.objectId === chromosome.id);
    if (firstIndex < 0) {
      continue;
    }
    let lastIndex = firstIndex;
    while (model.assemblyBlocks[lastIndex + 1]?.objectId === chromosome.id) {
      lastIndex += 1;
    }

    const firstBlock = model.assemblyBlocks[firstIndex];
    const nextBlock = model.assemblyBlocks[lastIndex + 1];
    if (!blockIsSelected(firstBlock)) {
      targets.push({
        targetBlockId: firstBlock.id,
        targetObjectId: chromosome.id,
        visualPosition: chromosome.visualStart,
        chromosomeEnd: "start",
      });
    }
    if (!blockIsSelected(nextBlock)) {
      targets.push({
        targetBlockId: nextBlock?.id ?? null,
        targetObjectId: chromosome.id,
        visualPosition: chromosome.visualEnd,
        chromosomeEnd: "end",
      });
    }
  }

  return targets;
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

  if (selection.kind === "contigs" && selection.exact) {
    const exactIds = new Set(selection.ids);
    return blocks.filter((block) => exactIds.has(block.id)).map((block) => block.id);
  }

  const explicitlySelectedSegments = selection.kind === "contigs"
    ? new Set(
        blocks
          .filter((block) => block.isSourceSegment && selection.ids.includes(block.id))
          .map((block) => block.id),
      )
    : new Set<string>();
  const unitSelection = selection.kind === "contigs" && explicitlySelectedSegments.size > 0
    ? {
        ...selection,
        ids: selection.ids.filter((id) => !explicitlySelectedSegments.has(id)),
      }
    : selection;
  const units = orderedAssemblyUnits(blocks);
  const selectedUnits = selectedAssemblyUnitIds(units, unitSelection);
  return blocks
    .filter((block) => (
      explicitlySelectedSegments.has(block.id) || selectedUnits.has(assemblyUnitId(block))
    ))
    .map((block) => block.id);
}

interface OrderedAssemblyUnit {
  id: string;
  objectId: string;
  blocks: ContactMapLayoutBlock[];
}

function orderedAssemblyUnits(blocks: ContactMapLayoutBlock[]): OrderedAssemblyUnit[] {
  const units: OrderedAssemblyUnit[] = [];

  for (const block of blocks) {
    const id = assemblyUnitId(block);
    const previous = units[units.length - 1];
    if (previous && previous.id === id && previous.objectId === block.objectId) {
      previous.blocks.push(block);
    } else {
      units.push({ id, objectId: block.objectId, blocks: [block] });
    }
  }

  return units;
}

function selectedAssemblyUnitIds(
  units: OrderedAssemblyUnit[],
  selection: AssemblySelection | null,
) {
  if (!selection) {
    return new Set<string>();
  }
  if (selection.kind === "chromosome") {
    return new Set(
      units.filter((unit) => unit.objectId === selection.id).map((unit) => unit.id),
    );
  }

  const selected = new Set(selection.ids);
  return new Set(
    units
      .filter((unit) => (
        selected.has(unit.id) || unit.blocks.some((block) => selected.has(block.id))
      ))
      .map((unit) => unit.id),
  );
}

function resolveAssemblyUnitId(units: OrderedAssemblyUnit[], blockOrContigId: string) {
  return units.find((unit) => (
    unit.id === blockOrContigId || unit.blocks.some((block) => block.id === blockOrContigId)
  ))?.id ?? blockOrContigId;
}

function reverseAssemblyUnit(unit: OrderedAssemblyUnit): OrderedAssemblyUnit {
  const gapBefore = unit.blocks[0]?.gapBefore;
  const reversedBlocks = [...unit.blocks]
    .reverse()
    .map((block, index) => ({
      ...block,
      gapBefore: index === 0 ? gapBefore : undefined,
      orientation: flipOrientation(block.orientation),
    }));
  return { ...unit, blocks: reversedBlocks };
}

function reverseSelectedGapOrder(
  units: OrderedAssemblyUnit[],
  selectedUnitIds: ReadonlySet<string>,
) {
  const gapBeforeBySlot = new Map<number, ContactMapLayoutBlock["gapBefore"]>();
  let runStart = 0;

  while (runStart < units.length) {
    const first = units[runStart];
    if (!selectedUnitIds.has(first.id)) {
      runStart += 1;
      continue;
    }

    let runEnd = runStart;
    while (
      runEnd + 1 < units.length
      && selectedUnitIds.has(units[runEnd + 1].id)
      && units[runEnd + 1].objectId === first.objectId
    ) {
      runEnd += 1;
    }

    gapBeforeBySlot.set(runStart, first.blocks[0]?.gapBefore);
    for (let offset = 1; offset <= runEnd - runStart; offset += 1) {
      gapBeforeBySlot.set(
        runStart + offset,
        units[runEnd - offset + 1].blocks[0]?.gapBefore,
      );
    }
    runStart = runEnd + 1;
  }

  return gapBeforeBySlot;
}

function retargetAssemblyUnit(
  unit: OrderedAssemblyUnit,
  objectId: string,
  gapBeforeOverride?: { value: ContactMapLayoutBlock["gapBefore"] },
): OrderedAssemblyUnit {
  return {
    ...unit,
    objectId,
    blocks: unit.blocks.map((block, index) => ({
      ...block,
      objectId,
      gapBefore: index === 0 && gapBeforeOverride
        ? gapBeforeOverride.value
        : block.gapBefore,
    })),
  };
}

function hasExplicitAssemblyStructure(blocks: ContactMapLayoutBlock[]) {
  return blocks.some((block) => (
    Object.prototype.hasOwnProperty.call(block, "assemblyBlockId")
    || Object.prototype.hasOwnProperty.call(block, "gapBefore")
    || Object.prototype.hasOwnProperty.call(block, "componentType")
  ));
}

function ensureAssemblyUnitBoundaries(
  units: OrderedAssemblyUnit[],
  enabled: boolean,
): OrderedAssemblyUnit[] {
  if (!enabled) {
    return units;
  }

  const displacedLeadingGaps = new Map<
    string,
    NonNullable<ContactMapLayoutBlock["gapBefore"]>[]
  >();
  const withoutLeadingGaps = units.map((unit, index) => {
    const previous = units[index - 1];
    const startsObject = !previous || previous.objectId !== unit.objectId;
    const gapBefore = unit.blocks[0]?.gapBefore;
    if (!startsObject || gapBefore === undefined) {
      return unit;
    }
    if (gapBefore.length > 0) {
      const objectGaps = displacedLeadingGaps.get(unit.objectId) ?? [];
      objectGaps.push(gapBefore);
      displacedLeadingGaps.set(unit.objectId, objectGaps);
    }
    return setAssemblyUnitGapBefore(unit, undefined);
  });

  const nextDisplacedGapByObject = new Map<string, number>();
  return withoutLeadingGaps.map((unit, index) => {
    const previous = withoutLeadingGaps[index - 1];
    if (
      !previous
      || previous.objectId !== unit.objectId
      || unit.blocks[0]?.gapBefore?.length
    ) {
      return unit;
    }

    const nextDisplacedGap = nextDisplacedGapByObject.get(unit.objectId) ?? 0;
    const gapBefore = displacedLeadingGaps.get(unit.objectId)?.[nextDisplacedGap]
      ?? { ...DEFAULT_INSERTED_GAP };
    nextDisplacedGapByObject.set(unit.objectId, nextDisplacedGap + 1);
    return setAssemblyUnitGapBefore(unit, gapBefore);
  });
}

function setAssemblyUnitGapBefore(
  unit: OrderedAssemblyUnit,
  gapBefore: ContactMapLayoutBlock["gapBefore"],
): OrderedAssemblyUnit {
  return {
    ...unit,
    blocks: unit.blocks.map((block, blockIndex) => (
      blockIndex === 0 ? { ...block, gapBefore } : block
    )),
  };
}

function ensureFlatAssemblyBoundaries(
  blocks: ContactMapLayoutBlock[],
  enabled: boolean,
) {
  return ensureAssemblyUnitBoundaries(orderedAssemblyUnits(blocks), enabled)
    .flatMap((unit) => unit.blocks);
}

function rebuildAssemblyBlockMembership(
  blocks: ContactMapLayoutBlock[],
): ContactMapLayoutBlock[] {
  const runs: Array<{ objectId: string; indexes: number[] }> = [];
  blocks.forEach((block, index) => {
    const previous = blocks[index - 1];
    const startsRun = !previous
      || previous.objectId !== block.objectId
      || Boolean(block.gapBefore?.length);
    if (startsRun) {
      runs.push({ objectId: block.objectId, indexes: [] });
    }
    runs[runs.length - 1]?.indexes.push(index);
  });

  const nextBlockOrdinal = new Map<string, number>();
  const membership = new Map<number, string | null>();
  for (const run of runs) {
    if (run.indexes.length <= 1) {
      membership.set(run.indexes[0], null);
      continue;
    }
    const ordinal = (nextBlockOrdinal.get(run.objectId) ?? 0) + 1;
    nextBlockOrdinal.set(run.objectId, ordinal);
    const id = `${run.objectId}_block_${ordinal}`;
    run.indexes.forEach((index) => membership.set(index, id));
  }

  return blocks.map((block, index) => ({
    ...block,
    assemblyBlockId: membership.get(index) ?? null,
  }));
}

function recomputeVisualCoordinates(blocks: ContactMapLayoutBlock[]): ContactMapLayoutBlock[] {
  let visualStart = 0;

  return blocks.map((block) => {
    const length = Math.max(0, block.sourceEnd - block.sourceStart);
    const gapLength = Number.isFinite(block.gapBefore?.length)
      ? Math.max(0, Number(block.gapBefore?.length))
      : 0;
    visualStart += gapLength;
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
  const copiedUnitIds = new Map<string, string>();
  return blocks
    .filter((block) => selected.has(block.id))
    .reduce<ContactMapLayoutBlock[]>((copies, block) => {
      const copyInstanceId = nextCopySourceId([...blocks, ...copies], block.sourceId);
      const targetObjectId = copiedObjectId ?? block.objectId;
      let copiedAssemblyBlockId: string | null = null;
      if (block.assemblyBlockId) {
        copiedAssemblyBlockId = copiedUnitIds.get(block.assemblyBlockId) ?? null;
        if (!copiedAssemblyBlockId) {
          copiedAssemblyBlockId = nextAssemblyBlockId(
            [...blocks, ...copies],
            targetObjectId,
          );
          copiedUnitIds.set(block.assemblyBlockId, copiedAssemblyBlockId);
        }
      }
      const id = nextCopyId([...blocks, ...copies], block, copyInstanceId);
      return [
        ...copies,
        {
          ...block,
          id,
          copyInstanceId: id,
          splitParent: undefined,
          objectId: targetObjectId,
          assemblyBlockId: copiedAssemblyBlockId,
        },
      ];
    }, []);
}

function nextAssemblyBlockId(blocks: ContactMapLayoutBlock[], objectId: string) {
  const prefix = `${objectId}_block_`;
  const ordinals = blocks
    .map((block) => block.assemblyBlockId)
    .filter((id): id is string => Boolean(id?.startsWith(prefix)))
    .map((id) => Number(id.slice(prefix.length)))
    .filter(Number.isFinite);
  const ordinal = ordinals.length > 0 ? Math.max(...ordinals) + 1 : 1;
  return `${prefix}${ordinal}`;
}

function nextGfaPlacementId(
  blocks: ContactMapLayoutBlock[],
  objectId: string,
  segmentName: string,
) {
  const existingIds = new Set(blocks.map((block) => block.id));
  const prefix = `gfa-placement:${objectId}:${segmentName}`;
  let id = prefix;
  let ordinal = 1;
  while (existingIds.has(id)) {
    ordinal += 1;
    id = `${prefix}:${ordinal}`;
  }
  return id;
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

  return orientation;
}
