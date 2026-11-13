import type { ContactMapLayoutBlock } from "./importers";
import type { ContactViewport } from "./contactViewport";
import type { GfaHomologClassification } from "./gfaHomologLayout";

/**
 * Lift the heatmap viewport to homolog-group scope. Any chromosome touched on
 * either heatmap axis reveals every chromosome in that homolog group; block and
 * contig coordinates deliberately do not narrow the GFA view further.
 */
export function gfaScaffoldsForHeatmapViewport(
  blocks: ContactMapLayoutBlock[],
  viewport: ContactViewport,
  homologs: GfaHomologClassification,
) {
  const visibleScaffolds = new Set<string>();
  for (const block of blocks) {
    const visibleOnX = overlaps(block.visualStart, block.visualEnd, viewport.xStart, viewport.xEnd);
    const visibleOnY = overlaps(block.visualStart, block.visualEnd, viewport.yStart, viewport.yEnd);
    if (visibleOnX || visibleOnY) {
      visibleScaffolds.add(block.objectId);
    }
  }

  const scaffoldToHomolog = new Map(
    homologs.columns.flatMap((column) => (
      column.scaffolds.map((scaffold) => [scaffold.id, column.id] as const)
    )),
  );
  const visibleHomologs = new Set(
    [...visibleScaffolds]
      .map((scaffold) => scaffoldToHomolog.get(scaffold))
      .filter((value): value is string => value !== undefined),
  );
  const output = new Set<string>();
  for (const column of homologs.columns) {
    if (visibleHomologs.has(column.id)) {
      for (const scaffold of column.scaffolds) {
        output.add(scaffold.id);
      }
    }
  }
  return output;
}

/**
 * Pick one stable homolog group for the compact inspector preview. The X-axis
 * center is the primary focus; a largest-overlap fallback avoids flicker when
 * the center lies in an AGP gap. Y is only used when X has no assembly content.
 */
export function gfaPrimaryHomologScaffoldsForHeatmapViewport(
  blocks: ContactMapLayoutBlock[],
  viewport: ContactViewport,
  homologs: GfaHomologClassification,
) {
  const focus = focusBlockForAxis(blocks, viewport.xStart, viewport.xEnd)
    ?? focusBlockForAxis(blocks, viewport.yStart, viewport.yEnd);
  if (!focus) {
    return new Set<string>();
  }
  const column = homologs.columns.find((candidate) => (
    candidate.scaffolds.some((scaffold) => scaffold.id === focus.objectId)
  ));
  return new Set(column?.scaffolds.map((scaffold) => scaffold.id) ?? []);
}

/** Assembly order is independent of the camera; rebuild only after an edit. */
export function buildGfaViewportIndex(blocks: ContactMapLayoutBlock[]) {
  const orderedByScaffold = new Map<string, ContactMapLayoutBlock[]>();
  const positionById = new Map<string, number>();
  for (const block of [...blocks].sort((left, right) => (
    left.visualStart - right.visualStart || left.visualEnd - right.visualEnd
  ))) {
    const values = orderedByScaffold.get(block.objectId) ?? [];
    positionById.set(block.id, values.length);
    values.push(block);
    orderedByScaffold.set(block.objectId, values);
  }
  return { orderedByScaffold, positionById };
}

export function gfaContigsForHeatmapViewport(
  blocks: ContactMapLayoutBlock[],
  viewport: ContactViewport,
  flankCount = 5,
  selectedOccurrenceIds: ReadonlySet<string> = new Set<string>(),
  index = buildGfaViewportIndex(blocks),
) {
  const selected = blocks.filter((block) => selectedOccurrenceIds.has(block.id));
  const viewportFocalBlocks = [
    focusBlockForAxis(blocks, viewport.xStart, viewport.xEnd),
    focusBlockForAxis(blocks, viewport.yStart, viewport.yEnd),
  ].filter((block): block is ContactMapLayoutBlock => block !== null);
  const focalBlocks = [...new Map(
    [...selected, ...viewportFocalBlocks].map((block) => [block.id, block]),
  ).values()];
  const output = new Set<string>();
  const safeFlankCount = Number.isFinite(flankCount) ? Math.max(0, Math.floor(flankCount)) : 0;
  for (const block of focalBlocks) {
    const scaffoldBlocks = index.orderedByScaffold.get(block.objectId) ?? [];
    const position = index.positionById.get(block.id);
    if (position === undefined) {
      continue;
    }
    for (
      let neighborIndex = Math.max(0, position - safeFlankCount);
      neighborIndex <= Math.min(scaffoldBlocks.length - 1, position + safeFlankCount);
      neighborIndex += 1
    ) {
      output.add(scaffoldBlocks[neighborIndex].id);
    }
  }
  return output;
}

function overlaps(start: number, end: number, viewportStart: number, viewportEnd: number) {
  return end > viewportStart && start < viewportEnd;
}

function focusBlockForAxis(
  blocks: ContactMapLayoutBlock[],
  viewportStart: number,
  viewportEnd: number,
) {
  const center = (viewportStart + viewportEnd) / 2;
  const centered = blocks.find((block) => block.visualStart <= center && block.visualEnd > center);
  if (centered) {
    return centered;
  }
  let best: ContactMapLayoutBlock | null = null;
  let largestOverlap = 0;
  for (const block of blocks) {
    const overlap = Math.min(block.visualEnd, viewportEnd) - Math.max(block.visualStart, viewportStart);
    if (overlap > largestOverlap || (
      overlap > 0 && overlap === largestOverlap && best && block.visualStart < best.visualStart
    )) {
      best = block;
      largestOverlap = overlap;
    }
  }
  return best;
}
