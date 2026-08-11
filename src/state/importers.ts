export interface AgpTextSummary {
  lineCount: number;
  objectCount: number;
  componentCount: number;
  gapCount: number;
  maxObjectSpan: number;
}

export interface AgpGapMetadata {
  componentType: "N" | "U";
  length: number;
  gapType: string;
  linkage: string;
  linkageEvidence: string;
}

export interface ContactMapSplitParent {
  id: string;
  displayName?: string;
  isSourceSegment?: boolean;
  copyInstanceId?: string;
  splitParent?: ContactMapSplitParent;
}

export interface ContactMapLayoutBlock {
  id: string;
  objectId: string;
  sourceId: string;
  /** User-facing/exported contig name; sourceId remains the immutable data lookup key. */
  displayName?: string;
  /** True when this placement is a source interval created by an in-app contig split. */
  isSourceSegment?: boolean;
  /** Stable placement lineage; split segments share one copy instance. */
  copyInstanceId?: string;
  /** Snapshot of the direct pre-split block, used to restore it when its gap is joined. */
  splitParent?: ContactMapSplitParent;
  sourceStart: number;
  sourceEnd: number;
  visualStart: number;
  visualEnd: number;
  orientation: "+" | "-" | "?" | "0" | "na";
  componentType?: string;
  assemblyBlockId?: string | null;
  gapBefore?: AgpGapMetadata;
}

export interface AgpLayout {
  blocks: ContactMapLayoutBlock[];
  totalSpan: number;
}

interface ImportedAgpLayoutBlock {
  id: string;
  objectId?: string;
  sourceId: string;
  displayName?: string;
  sourceStart: number;
  sourceEnd: number;
  visualStart: number;
  visualEnd?: number;
  orientation: ContactMapLayoutBlock["orientation"];
  componentType?: string;
  assemblyBlockId?: string | null;
  gapBefore?: AgpGapMetadata;
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
  interface ParsedComponent {
    id: string;
    objectStart: number;
    sourceId: string;
    sourceStart: number;
    sourceEnd: number;
    orientation: ContactMapLayoutBlock["orientation"];
    componentType: string;
    gapBefore?: AgpGapMetadata;
  }

  interface ParsedObject {
    id: string;
    span: number;
    components: ParsedComponent[];
    pendingGap?: AgpGapMetadata;
  }

  const objectOrder: ParsedObject[] = [];
  const objects = new Map<string, ParsedObject>();

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
    const object = objects.get(objectId) ?? {
      id: objectId,
      span: 0,
      components: [],
    };
    if (!objects.has(objectId)) {
      objects.set(objectId, object);
      objectOrder.push(object);
    }
    object.span = Math.max(object.span, finiteNumber(objectEnd, object.span));

    if (componentType === "U" || componentType === "N") {
      const coordinateLength = Math.max(0, objectEnd - objectStart);
      object.pendingGap = {
        componentType,
        length: Math.max(0, finiteNumber(Number(columns[5]), coordinateLength)),
        gapType: columns[6],
        linkage: columns[7],
        linkageEvidence: columns[8],
      };
      continue;
    }

    const componentId = columns[5];
    const componentStart = Number(columns[6]) - 1;
    const componentEnd = Number(columns[7]);
    const orientation = normalizeOrientation(columns[8]);

    const component: ParsedComponent = {
      id: `${objectId}:${partNumber}:${componentId}`,
      objectStart,
      sourceId: componentId,
      sourceStart: componentStart,
      sourceEnd: componentEnd,
      orientation,
      componentType,
    };
    if (object.pendingGap) {
      component.gapBefore = { ...object.pendingGap };
      object.pendingGap = undefined;
    }
    object.components.push(component);
  }

  const blocks: ContactMapLayoutBlock[] = [];
  let objectOffset = 0;
  for (const object of objectOrder) {
    for (const component of object.components) {
      const visualStart = objectOffset + component.objectStart;
      const block: ContactMapLayoutBlock = {
        id: component.id,
        objectId: object.id,
        sourceId: component.sourceId,
        sourceStart: component.sourceStart,
        sourceEnd: component.sourceEnd,
        visualStart,
        visualEnd: visualStart + Math.max(0, component.sourceEnd - component.sourceStart),
        orientation: component.orientation,
        componentType: component.componentType,
      };
      if (component.gapBefore) {
        block.gapBefore = { ...component.gapBefore };
      }
      blocks.push(block);
    }
    objectOffset += object.span;
  }

  return {
    blocks: assignAssemblyBlockIds(blocks, false),
    totalSpan: objectOffset,
  };
}

export function normalizeImportedAgpLayout(layout: ImportedAgpLayout): AgpLayout {
  const blocks = layout.blocks.map((block) => {
    const sourceStart = finiteNumber(block.sourceStart, 0);
    const sourceEnd = finiteNumber(block.sourceEnd, sourceStart);
    const visualStart = finiteNumber(block.visualStart, 0);
    const visualLength = Math.max(0, sourceEnd - sourceStart);
    const visualEnd = finiteNumber(block.visualEnd, visualStart + visualLength);

    const normalized: ContactMapLayoutBlock = {
      id: block.id,
      objectId: block.objectId ?? block.id.split(":")[0] ?? block.sourceId,
      sourceId: block.sourceId,
      sourceStart,
      sourceEnd,
      visualStart,
      visualEnd,
      orientation: block.orientation,
    };
    if (block.displayName?.trim()) {
      normalized.displayName = block.displayName.trim();
    }
    if (block.componentType) {
      normalized.componentType = block.componentType;
    }
    const gapBefore = normalizeGapMetadata(block.gapBefore);
    if (gapBefore) {
      normalized.gapBefore = gapBefore;
    }
    return normalized;
  });
  const annotatedBlocks = assignAssemblyBlockIds(blocks, true);
  const totalSpan = Number.isFinite(layout.totalSpan)
    ? Math.max(layout.totalSpan, 0, ...annotatedBlocks.map((block) => block.visualEnd))
    : Math.max(0, ...annotatedBlocks.map((block) => block.visualEnd));

  return { blocks: annotatedBlocks, totalSpan };
}

function assignAssemblyBlockIds(
  blocks: ContactMapLayoutBlock[],
  inferGapsFromVisualCoordinates: boolean,
): ContactMapLayoutBlock[] {
  const annotated = blocks.map((block) => {
    const { assemblyBlockId: _assemblyBlockId, ...rest } = block;
    return { ...rest } as ContactMapLayoutBlock;
  });
  const indexesByObject = new Map<string, number[]>();

  annotated.forEach((block, index) => {
    const indexes = indexesByObject.get(block.objectId) ?? [];
    indexes.push(index);
    indexesByObject.set(block.objectId, indexes);
  });

  for (const [objectId, indexes] of indexesByObject) {
    if (inferGapsFromVisualCoordinates) {
      for (let position = 1; position < indexes.length; position += 1) {
        const previous = annotated[indexes[position - 1]];
        const current = annotated[indexes[position]];
        if (!current.gapBefore) {
          const inferredLength = Math.max(0, current.visualStart - previous.visualEnd);
          if (inferredLength > 0) {
            current.gapBefore = inferredGapMetadata(inferredLength);
          }
        }
      }
    }

    const runs: number[][] = [];
    for (const index of indexes) {
      const block = annotated[index];
      if (runs.length === 0 || block.gapBefore) {
        runs.push([]);
      }
      runs[runs.length - 1].push(index);
    }

    let blockOrdinal = 0;
    for (const run of runs) {
      if (run.length <= 1) {
        continue;
      }
      blockOrdinal += 1;
      const assemblyBlockId = `${objectId}_block_${blockOrdinal}`;
      for (const index of run) {
        annotated[index].assemblyBlockId = assemblyBlockId;
      }
    }
  }

  return annotated;
}

function inferredGapMetadata(length: number): AgpGapMetadata {
  return {
    componentType: "N",
    length,
    gapType: "contig",
    linkage: "no",
    linkageEvidence: "na",
  };
}

function normalizeGapMetadata(gap: AgpGapMetadata | undefined): AgpGapMetadata | undefined {
  if (!gap) {
    return undefined;
  }

  return {
    componentType: gap.componentType === "N" ? "N" : "U",
    length: Math.max(0, finiteNumber(gap.length, 0)),
    gapType: gap.gapType,
    linkage: gap.linkage,
    linkageEvidence: gap.linkageEvidence,
  };
}

function finiteNumber(value: number | undefined, fallback: number) {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function normalizeOrientation(value: string): ContactMapLayoutBlock["orientation"] {
  if (value === "-") {
    return "-";
  }

  if (value === "?" || value === "0" || value === "na") {
    return value;
  }

  return "+";
}
