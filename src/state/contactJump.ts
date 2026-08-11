import { assemblyContigDisplayName } from "./assemblyEditing";
import type { ContactMapLayoutBlock } from "./importers";

export interface ContactJumpRegion {
  query: string;
  blockId: string;
  contigName: string;
  visualStartBp: number;
  visualEndBp: number;
  centerBp: number;
  spanBp: number;
}

export type ContactJumpResolution =
  | {
      ok: true;
      x: ContactJumpRegion;
      y: ContactJumpRegion;
      label: string;
    }
  | {
      ok: false;
      error: string;
    };

interface ParsedContactJumpQuery {
  contigName: string;
  startBp: number | null;
  endBp: number | null;
}

export function resolveContactJumpInputs(
  blocks: ContactMapLayoutBlock[],
  xInput: string,
  yInput: string,
): ContactJumpResolution {
  const trimmedX = xInput.trim();
  const trimmedY = yInput.trim();
  if (!trimmedX && !trimmedY) {
    return { ok: false, error: "Enter a contig or interval for X or Y." };
  }
  if (blocks.length === 0) {
    return { ok: false, error: "Load an assembly before using Jump." };
  }

  const xQuery = trimmedX || trimmedY;
  const yQuery = trimmedY || trimmedX;
  const x = resolveContactJumpRegion(blocks, xQuery);
  if (typeof x === "string") {
    return { ok: false, error: `X: ${x}` };
  }
  const y = resolveContactJumpRegion(blocks, yQuery);
  if (typeof y === "string") {
    return { ok: false, error: `Y: ${y}` };
  }

  return {
    ok: true,
    x,
    y,
    label: trimmedX && trimmedY
      ? `X ${x.query}; Y ${y.query}`
      : x.query,
  };
}

export function resolveContactJumpRegion(
  blocks: ContactMapLayoutBlock[],
  input: string,
): ContactJumpRegion | string {
  const parsed = parseContactJumpQuery(input);
  if (typeof parsed === "string") {
    return parsed;
  }
  const matches = findMatchingContigs(blocks, parsed.contigName);
  if (matches.length === 0) {
    return `Contig “${parsed.contigName}” was not found.`;
  }
  if (matches.length > 1) {
    return `Contig “${parsed.contigName}” matches multiple placements; rename one to make it unique.`;
  }

  const block = matches[0]!;
  const startBp = parsed.startBp ?? block.sourceStart;
  const endBp = parsed.endBp ?? block.sourceEnd;
  if (startBp < block.sourceStart || endBp > block.sourceEnd) {
    return `Interval must stay within ${assemblyContigDisplayName(block)}:${block.sourceStart}-${block.sourceEnd}.`;
  }

  const visualStartBp = block.orientation === "-"
    ? block.visualStart + (block.sourceEnd - endBp)
    : block.visualStart + (startBp - block.sourceStart);
  const visualEndBp = block.orientation === "-"
    ? block.visualStart + (block.sourceEnd - startBp)
    : block.visualStart + (endBp - block.sourceStart);

  return {
    query: parsed.startBp === null
      ? assemblyContigDisplayName(block)
      : `${assemblyContigDisplayName(block)}:${startBp}-${endBp}`,
    blockId: block.id,
    contigName: assemblyContigDisplayName(block),
    visualStartBp,
    visualEndBp,
    centerBp: (visualStartBp + visualEndBp) / 2,
    spanBp: Math.max(1, visualEndBp - visualStartBp),
  };
}

function parseContactJumpQuery(input: string): ParsedContactJumpQuery | string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "Enter a contig or interval.";
  }
  const intervalMatch = trimmed.match(/^(.+):([\d,]+)-([\d,]+)$/);
  if (!intervalMatch) {
    return trimmed.includes(":")
      ? "Use contig or contig:start-end."
      : { contigName: trimmed, startBp: null, endBp: null };
  }

  const contigName = intervalMatch[1]?.trim() ?? "";
  const startBp = Number((intervalMatch[2] ?? "").replace(/,/g, ""));
  const endBp = Number((intervalMatch[3] ?? "").replace(/,/g, ""));
  if (!contigName || !Number.isSafeInteger(startBp) || !Number.isSafeInteger(endBp)) {
    return "Use integer coordinates in contig:start-end.";
  }
  if (startBp < 0 || endBp <= startBp) {
    return "Interval start must be non-negative and smaller than end.";
  }

  return { contigName, startBp, endBp };
}

function findMatchingContigs(
  blocks: ContactMapLayoutBlock[],
  requestedName: string,
) {
  const exactMatches = blocks.filter((block) => (
    assemblyContigDisplayName(block) === requestedName
    || block.sourceId === requestedName
    || block.id === requestedName
  ));
  if (exactMatches.length > 0) {
    return uniqueBlocks(exactMatches);
  }

  const normalizedName = requestedName.toLocaleLowerCase();
  return uniqueBlocks(blocks.filter((block) => (
    assemblyContigDisplayName(block).toLocaleLowerCase() === normalizedName
    || block.sourceId.toLocaleLowerCase() === normalizedName
    || block.id.toLocaleLowerCase() === normalizedName
  )));
}

function uniqueBlocks(blocks: ContactMapLayoutBlock[]) {
  return [...new Map(blocks.map((block) => [block.id, block])).values()];
}
