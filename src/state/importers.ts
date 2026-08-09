export interface AgpTextSummary {
  lineCount: number;
  objectCount: number;
  componentCount: number;
  gapCount: number;
  maxObjectSpan: number;
}

export interface ContactMapLayoutBlock {
  id: string;
  objectId: string;
  sourceId: string;
  sourceStart: number;
  sourceEnd: number;
  visualStart: number;
  visualEnd: number;
  orientation: "+" | "-" | "?";
}

export interface AgpLayout {
  blocks: ContactMapLayoutBlock[];
  totalSpan: number;
}

interface ImportedAgpLayoutBlock {
  id: string;
  objectId?: string;
  sourceId: string;
  sourceStart: number;
  sourceEnd: number;
  visualStart: number;
  visualEnd?: number;
  orientation: ContactMapLayoutBlock["orientation"];
}

interface ImportedAgpLayout {
  blocks: ImportedAgpLayoutBlock[];
  totalSpan: number;
}

export function summarizeAgpText(text: string): AgpTextSummary {
  const objects = new Set<string>();
  let lineCount = 0;
  let componentCount = 0;
  let gapCount = 0;
  let maxObjectSpan = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const columns = line.split("\t");
    if (columns.length !== 9) {
      continue;
    }

    lineCount += 1;
    objects.add(columns[0]);
    maxObjectSpan = Math.max(maxObjectSpan, Number(columns[2]));

    if (columns[4] === "U" || columns[4] === "N") {
      gapCount += 1;
    } else {
      componentCount += 1;
    }
  }

  return {
    lineCount,
    objectCount: objects.size,
    componentCount,
    gapCount,
    maxObjectSpan,
  };
}

export function parseAgpLayout(text: string): AgpLayout {
  const objectOffsets = new Map<string, number>();
  const objectEnds = new Map<string, number>();
  const blocks: ContactMapLayoutBlock[] = [];
  let nextObjectOffset = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const columns = line.split("\t");
    if (columns.length !== 9) {
      continue;
    }

    const objectId = columns[0];
    const objectStart = Number(columns[1]) - 1;
    const objectEnd = Number(columns[2]);
    const partNumber = columns[3];
    const componentType = columns[4];

    if (!objectOffsets.has(objectId)) {
      objectOffsets.set(objectId, nextObjectOffset);
    }

    if (componentType === "U" || componentType === "N") {
      objectEnds.set(objectId, Math.max(objectEnds.get(objectId) ?? 0, objectEnd));
      continue;
    }

    const componentId = columns[5];
    const componentStart = Number(columns[6]) - 1;
    const componentEnd = Number(columns[7]);
    const orientation = normalizeOrientation(columns[8]);
    const visualStart = (objectOffsets.get(objectId) ?? 0) + objectStart;

    blocks.push({
      id: `${objectId}:${partNumber}:${componentId}`,
      objectId,
      sourceId: componentId,
      sourceStart: componentStart,
      sourceEnd: componentEnd,
      visualStart,
      visualEnd: visualStart + (componentEnd - componentStart),
      orientation,
    });

    objectEnds.set(objectId, Math.max(objectEnds.get(objectId) ?? 0, objectEnd));
    nextObjectOffset = [...objectEnds.values()].reduce((total, span) => total + span, 0);
  }

  return {
    blocks,
    totalSpan: [...objectEnds.values()].reduce((total, span) => total + span, 0),
  };
}

export function normalizeImportedAgpLayout(layout: ImportedAgpLayout): AgpLayout {
  const blocks = layout.blocks.map((block) => {
    const sourceStart = finiteNumber(block.sourceStart, 0);
    const sourceEnd = finiteNumber(block.sourceEnd, sourceStart);
    const visualStart = finiteNumber(block.visualStart, 0);
    const visualLength = Math.max(0, sourceEnd - sourceStart);
    const visualEnd = finiteNumber(block.visualEnd, visualStart + visualLength);

    return {
      id: block.id,
      objectId: block.objectId ?? block.id.split(":")[0] ?? block.sourceId,
      sourceId: block.sourceId,
      sourceStart,
      sourceEnd,
      visualStart,
      visualEnd,
      orientation: block.orientation,
    };
  });
  const totalSpan = Number.isFinite(layout.totalSpan)
    ? Math.max(layout.totalSpan, 0, ...blocks.map((block) => block.visualEnd))
    : Math.max(0, ...blocks.map((block) => block.visualEnd));

  return { blocks, totalSpan };
}

function finiteNumber(value: number | undefined, fallback: number) {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function normalizeOrientation(value: string): ContactMapLayoutBlock["orientation"] {
  if (value === "-") {
    return "-";
  }

  if (value === "?") {
    return "?";
  }

  return "+";
}
