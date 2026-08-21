import type { ContactMapLayoutBlock } from "./importers";

export interface ChromosomeVisibility {
  chromosomeIds: string[];
  /** AGP objects that are not classified as homolog chromosomes. */
  unanchoredIds: string[];
  visibleIds: ReadonlySet<string>;
  error: string | null;
  active: boolean;
}

interface ChromosomeVisibilityOptions {
  unanchoredIds?: ReadonlyArray<string>;
  /** Adds the aggregated unanchored group when a chromosome filter is active. */
  includeUnanchored?: boolean;
}

export interface ChromosomeViewLayout {
  /** Visible chromosomes, rebased into one contiguous display coordinate system. */
  blocks: ContactMapLayoutBlock[];
  /**
   * Full layout used by evidence projection. Visible chromosomes come first and
   * hidden placements follow outside totalSpan so copy-sharing stays unchanged.
   */
  projectionBlocks: ContactMapLayoutBlock[];
  totalSpan: number;
}

function rebaseBlocks(
  blocks: ReadonlyArray<ContactMapLayoutBlock>,
  initialCursor = 0,
) {
  let cursor = initialCursor;
  const rebased = blocks.map((block) => {
    cursor += Math.max(0, block.gapBefore?.length ?? 0);
    const visualStart = cursor;
    const visualEnd = visualStart + Math.max(0, block.sourceEnd - block.sourceStart);
    cursor = visualEnd;
    return { ...block, visualStart, visualEnd };
  });
  return { blocks: rebased, cursor };
}

/** Builds a display-only chromosome projection without mutating authoritative AGP blocks. */
export function buildChromosomeViewLayout(
  blocks: ReadonlyArray<ContactMapLayoutBlock>,
  visibility: Pick<ChromosomeVisibility, "active" | "visibleIds">,
): ChromosomeViewLayout {
  const originalBlocks = blocks as ContactMapLayoutBlock[];
  const originalTotalSpan = blocks.reduce(
    (largestEnd, block) => Math.max(largestEnd, block.visualEnd),
    0,
  );
  if (!visibility.active) {
    return {
      blocks: originalBlocks,
      projectionBlocks: originalBlocks,
      totalSpan: originalTotalSpan,
    };
  }

  const visible = blocks.filter((block) => visibility.visibleIds.has(block.objectId));
  const hidden = blocks.filter((block) => !visibility.visibleIds.has(block.objectId));
  const rebasedVisible = rebaseBlocks(visible);
  const rebasedHidden = rebaseBlocks(hidden, rebasedVisible.cursor);
  return {
    blocks: rebasedVisible.blocks,
    projectionBlocks: [...rebasedVisible.blocks, ...rebasedHidden.blocks],
    totalSpan: rebasedVisible.cursor,
  };
}

/**
 * Retains hidden placements for copy-share accounting while moving their
 * display coordinates beyond a concrete request viewport.
 */
export function placeHiddenChromosomeBlocksAfter(
  layout: ChromosomeViewLayout,
  minimumHiddenStart: number,
) {
  if (layout.projectionBlocks === layout.blocks) {
    return layout.projectionBlocks;
  }
  const visibleBlockIds = new Set(layout.blocks.map((block) => block.id));
  const firstHiddenBlock = layout.projectionBlocks.find(
    (block) => !visibleBlockIds.has(block.id),
  );
  if (!firstHiddenBlock) {
    return layout.projectionBlocks;
  }
  const shift = Math.max(
    0,
    Math.ceil(minimumHiddenStart) - firstHiddenBlock.visualStart,
  );
  if (shift === 0) {
    return layout.projectionBlocks;
  }
  return layout.projectionBlocks.map((block) => (
    visibleBlockIds.has(block.id)
      ? block
      : {
          ...block,
          visualStart: block.visualStart + shift,
          visualEnd: block.visualEnd + shift,
        }
  ));
}

export function resolveChromosomeVisibility(
  chromosomeIds: ReadonlyArray<string>,
  hiddenIds: ReadonlySet<string>,
  patternSource: string,
  options: ChromosomeVisibilityOptions = {},
): ChromosomeVisibility {
  const uniqueIds = [...new Set(chromosomeIds)];
  const chromosomeIdSet = new Set(uniqueIds);
  const unanchoredIds = [...new Set(options.unanchoredIds ?? [])]
    .filter((id) => !chromosomeIdSet.has(id));
  const source = patternSource.trim();
  let pattern: RegExp | null = null;
  let error: string | null = null;
  if (source) {
    try {
      pattern = new RegExp(source);
    } catch (cause) {
      error = `Invalid regular expression: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
  }

  const manuallyVisibleIds = uniqueIds.filter((id) => !hiddenIds.has(id));
  const visibleIds = new Set(
    pattern
      ? manuallyVisibleIds.filter((id) => pattern.test(id))
      : manuallyVisibleIds,
  );
  const active = uniqueIds.some((id) => hiddenIds.has(id))
    || (source !== "" && error === null);
  if (!active || options.includeUnanchored) {
    for (const id of unanchoredIds) {
      visibleIds.add(id);
    }
  }
  return {
    chromosomeIds: uniqueIds,
    unanchoredIds,
    visibleIds,
    error,
    active,
  };
}

export function intersectVisibleChromosomes(
  chromosomeIds: ReadonlySet<string>,
  visibleIds: ReadonlySet<string>,
) {
  return new Set([...chromosomeIds].filter((id) => visibleIds.has(id)));
}

/** Applies one checkbox state to a target chromosome or an anchored list range. */
export function updateHiddenChromosomeSelection(
  chromosomeIds: ReadonlyArray<string>,
  hiddenIds: ReadonlySet<string>,
  targetId: string,
  visible: boolean,
  anchorId: string | null = null,
) {
  const targetIndex = chromosomeIds.indexOf(targetId);
  if (targetIndex < 0) {
    return new Set(hiddenIds);
  }
  const anchorIndex = anchorId === null ? -1 : chromosomeIds.indexOf(anchorId);
  const rangeStart = anchorIndex < 0 ? targetIndex : Math.min(anchorIndex, targetIndex);
  const rangeEnd = anchorIndex < 0 ? targetIndex : Math.max(anchorIndex, targetIndex);
  const next = new Set(hiddenIds);
  for (let index = rangeStart; index <= rangeEnd; index += 1) {
    const chromosomeId = chromosomeIds[index];
    if (chromosomeId === undefined) {
      continue;
    }
    if (visible) {
      next.delete(chromosomeId);
    } else {
      next.add(chromosomeId);
    }
  }
  return next;
}

export function chromosomeDisplayScope(
  automaticIds: ReadonlySet<string>,
  visibility: Pick<ChromosomeVisibility, "active" | "visibleIds">,
) {
  return visibility.active
    ? new Set(visibility.visibleIds)
    : intersectVisibleChromosomes(automaticIds, visibility.visibleIds);
}
