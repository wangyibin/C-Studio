import type { ContactMapLayoutBlock } from "./importers";

export interface ContactSourceMetadata {
  name: string;
  length: number;
}

export interface ContactSourceResolution {
  blocks: ContactMapLayoutBlock[];
  remappedSourceIds: string[];
  unresolvedSourceIds: string[];
}

interface DerivedSourceName {
  base: string;
  index: number;
}

interface DerivedPiece {
  sourceId: string;
  index: number;
  length: number;
}

interface CoordinateSourceName {
  base: string;
  start: number;
  end: number;
}

/**
 * Resolve externally split AGP component names against an unsplit Cooler axis.
 *
 * A derived name is never interpreted when the Cooler contains that exact
 * source name. Otherwise, coordinate names such as `utg1:1-10000` are checked
 * against the AGP component length and the unsplit Cooler source bounds.
 * `_d2 ... _dN` names may be projected onto `utg1` only when the observed AGP
 * pieces are consecutive and an unsuffixed first piece proves that all piece
 * lengths exactly partition the Cooler source. The AGP fields remain untouched;
 * this cloned layout is used only for contact lookup.
 */
export function resolveContactLayoutSources(
  blocks: ContactMapLayoutBlock[],
  coolSources: ReadonlyArray<ContactSourceMetadata>,
): ContactSourceResolution {
  const coolNames = new Set<string>();
  const coolLengths = new Map<string, number>();
  const duplicateCoolNames = new Set<string>();
  for (const source of coolSources) {
    if (
      source.name.trim().length === 0
      || !Number.isSafeInteger(source.length)
      || source.length <= 0
    ) {
      continue;
    }
    coolNames.add(source.name);
    if (coolLengths.has(source.name)) {
      coolLengths.delete(source.name);
      duplicateCoolNames.add(source.name);
    } else if (!duplicateCoolNames.has(source.name)) {
      coolLengths.set(source.name, source.length);
    }
  }
  if (blocks.length === 0 || coolNames.size === 0) {
    return {
      blocks,
      remappedSourceIds: [],
      unresolvedSourceIds: coolNames.size === 0
        ? []
        : uniqueSorted(blocks.map((block) => block.sourceId)),
    };
  }

  const missingSourceIds = uniqueSorted(
    blocks
      .map((block) => block.sourceId)
      .filter((sourceId) => !coolNames.has(sourceId)),
  );
  const derivedByBase = new Map<string, DerivedPiece[]>();
  const resolvedIntervals = new Map<string, { base: string; offset: number }>();

  for (const sourceId of missingSourceIds) {
    const coordinateSource = parseCoordinateSourceName(sourceId);
    const coordinateBaseLength = coordinateSource
      ? coolLengths.get(coordinateSource.base)
      : undefined;
    if (coordinateSource && coordinateBaseLength !== undefined) {
      const sourceBlocks = blocks.filter((block) => block.sourceId === sourceId);
      const pieceLength = sourcePieceLength(sourceBlocks);
      const interval = pieceLength === null
        ? null
        : coordinateSourceInterval(coordinateSource, pieceLength);
      if (interval && interval.end <= coordinateBaseLength) {
        resolvedIntervals.set(sourceId, {
          base: coordinateSource.base,
          offset: interval.start,
        });
        continue;
      }
    }

    const derived = parseDerivedSourceName(sourceId);
    const baseLength = derived ? coolLengths.get(derived.base) : undefined;
    if (!derived || baseLength === undefined) {
      continue;
    }
    const sourceBlocks = blocks.filter((block) => block.sourceId === sourceId);
    const pieceLength = sourcePieceLength(sourceBlocks);
    if (pieceLength === null) {
      continue;
    }
    const pieces = derivedByBase.get(derived.base) ?? [];
    pieces.push({ sourceId, index: derived.index, length: pieceLength });
    derivedByBase.set(derived.base, pieces);
  }

  for (const [base, pieces] of derivedByBase) {
    pieces.sort((left, right) => left.index - right.index);
    if (!derivedIndexesAreConsecutive(pieces)) {
      continue;
    }
    const coolLength = coolLengths.get(base)!;
    const derivedLength = pieces.reduce((total, piece) => total + piece.length, 0);
    const firstPieceLength = coolLength - derivedLength;
    if (
      !Number.isSafeInteger(firstPieceLength)
      || firstPieceLength <= 0
      || !blocks.some((block) => (
        block.sourceId === base
        && block.sourceStart === 0
        && block.sourceEnd === firstPieceLength
      ))
    ) {
      continue;
    }

    let offset = firstPieceLength;
    for (const piece of pieces) {
      resolvedIntervals.set(piece.sourceId, { base, offset });
      offset += piece.length;
    }
    if (offset !== coolLength) {
      for (const piece of pieces) {
        resolvedIntervals.delete(piece.sourceId);
      }
    }
  }

  if (resolvedIntervals.size === 0) {
    return {
      blocks,
      remappedSourceIds: [],
      unresolvedSourceIds: missingSourceIds,
    };
  }

  const resolvedBlocks = blocks.map((block) => {
    const resolved = resolvedIntervals.get(block.sourceId);
    if (!resolved) {
      return block;
    }
    return {
      ...block,
      displayName: block.displayName ?? block.sourceId,
      sourceId: resolved.base,
      sourceStart: resolved.offset + block.sourceStart,
      sourceEnd: resolved.offset + block.sourceEnd,
    };
  });
  const remappedSourceIds = uniqueSorted([...resolvedIntervals.keys()]);
  const remappedSet = new Set(remappedSourceIds);
  return {
    blocks: resolvedBlocks,
    remappedSourceIds,
    unresolvedSourceIds: missingSourceIds.filter((sourceId) => !remappedSet.has(sourceId)),
  };
}

function parseDerivedSourceName(sourceId: string): DerivedSourceName | null {
  const match = /^(.*)_d([0-9]+)$/.exec(sourceId);
  if (!match || !match[1]) {
    return null;
  }
  const index = Number(match[2]);
  return Number.isSafeInteger(index) && index >= 2 ? { base: match[1], index } : null;
}

function parseCoordinateSourceName(sourceId: string): CoordinateSourceName | null {
  const match = /^(.*):([0-9]+)-([0-9]+)$/.exec(sourceId);
  if (!match || !match[1]) {
    return null;
  }
  const start = Number(match[2]);
  const end = Number(match[3]);
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(end)
    || start < 0
    || end <= start
  ) {
    return null;
  }
  return { base: match[1], start, end };
}

function coordinateSourceInterval(
  source: CoordinateSourceName,
  pieceLength: number,
): { start: number; end: number } | null {
  const candidates = [
    // Chimeric-break boundary notation commonly reuses the cut coordinate:
    // 1-10000, 10000-20000. Normalize the leading 1 to source coordinate 0.
    { start: source.start === 1 ? 0 : source.start, end: source.end },
    // Standard 1-based closed coordinates: 1-10000, 10001-20000.
    { start: source.start - 1, end: source.end },
  ].filter((interval) => (
    interval.start >= 0
    && interval.end > interval.start
    && interval.end - interval.start === pieceLength
  ));
  const unique = new Map(candidates.map((interval) => [
    `${interval.start}:${interval.end}`,
    interval,
  ]));
  return unique.size === 1 ? [...unique.values()][0] : null;
}

function sourcePieceLength(blocks: ContactMapLayoutBlock[]): number | null {
  const pieceLength = Math.max(0, ...blocks.map((block) => block.sourceEnd));
  const coversPieceFromStart = blocks.some((block) => block.sourceStart === 0);
  if (
    !Number.isSafeInteger(pieceLength)
    || pieceLength <= 0
    || !coversPieceFromStart
    || blocks.some((block) => (
      !Number.isSafeInteger(block.sourceStart)
      || !Number.isSafeInteger(block.sourceEnd)
      || block.sourceStart < 0
      || block.sourceEnd <= block.sourceStart
      || block.sourceEnd > pieceLength
    ))
  ) {
    return null;
  }
  return pieceLength;
}

function derivedIndexesAreConsecutive(pieces: DerivedPiece[]) {
  return pieces.length > 0
    && pieces[0].index === 2
    && pieces.every((piece, index) => piece.index === index + 2);
}

function uniqueSorted(values: string[]) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
