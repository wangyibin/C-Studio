import type { ContactMapLayoutBlock } from "./importers";

export type GfaSegmentSide = "start" | "end";

export interface GfaSegmentEvidence {
  name: string;
  length: number | null;
  readDepth: number | null;
  hasSequence: boolean;
  aRecordCount: number;
  haplotypeCounts: Record<string, number>;
}

export interface GfaLinkEvidence {
  id: string;
  from: { segmentName: string; orientation: "+" | "-"; side: GfaSegmentSide };
  to: { segmentName: string; orientation: "+" | "-"; side: GfaSegmentSide };
  overlap: string;
}

export interface GfaImportSummary {
  lineCount: number;
  segmentCount: number;
  linkCount: number;
  aRecordCount: number;
  warningCount: number;
}

export interface GfaEvidenceDocument {
  fileName: string;
  segments: Record<string, GfaSegmentEvidence>;
  segmentOrder: string[];
  links: GfaLinkEvidence[];
  summary: GfaImportSummary;
  warnings: string[];
}

export type GfaGraphNodeKind = "placed" | "unplaced";

export interface GfaGraphNode {
  id: string;
  occurrenceId: string | null;
  segmentName: string;
  groupId: string;
  assemblyBlockId: string | null;
  kind: GfaGraphNodeKind;
  orientation: ContactMapLayoutBlock["orientation"];
  length: number;
  order: number;
  readDepth: number | null;
}

export type GfaGraphEdgeKind = "agp-joined" | "agp-gap" | "gfa-link";

export interface GfaGraphEdge {
  id: string;
  source: string;
  target: string;
  kind: GfaGraphEdgeKind;
  overlap?: string;
  gapLength?: number;
  sourceSide?: GfaSegmentSide;
  targetSide?: GfaSegmentSide;
}

export interface GfaAssemblyGraph {
  nodes: GfaGraphNode[];
  edges: GfaGraphEdge[];
  groupOrder: string[];
  matchedSegmentCount: number;
  unmatchedSegmentCount: number;
  ambiguousLinkCount: number;
  truncated: boolean;
}

const warningLimit = 50;

export function parseGfaText(text: string, fileName = "assembly.gfa"): GfaEvidenceDocument {
  const segments: Record<string, GfaSegmentEvidence> = {};
  const segmentOrder: string[] = [];
  const links: GfaLinkEvidence[] = [];
  const warnings: string[] = [];
  const canonicalLinks = new Set<string>();
  let lineCount = 0;
  let aRecordCount = 0;

  function warn(message: string) {
    if (warnings.length < warningLimit) {
      warnings.push(message);
    }
  }

  function segmentForEvidence(name: string) {
    if (!segments[name]) {
      segments[name] = {
        name,
        length: null,
        readDepth: null,
        hasSequence: false,
        aRecordCount: 0,
        haplotypeCounts: {},
      };
      segmentOrder.push(name);
    }
    return segments[name];
  }

  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    if (!rawLine || rawLine.startsWith("#")) {
      continue;
    }
    const columns = rawLine.split("\t");
    const recordType = columns[0];
    lineCount += 1;

    if (recordType === "S") {
      if (columns.length < 3 || !columns[1]) {
        warn(`Line ${index + 1}: invalid S record`);
        continue;
      }
      const name = columns[1];
      const segment = segmentForEvidence(name);
      const sequence = columns[2];
      const sequenceLength = sequence && sequence !== "*" ? sequence.length : null;
      const taggedLength = integerTag(columns.slice(3), "LN");
      segment.hasSequence = sequenceLength !== null;
      segment.length = taggedLength ?? sequenceLength;
      segment.readDepth = integerTag(columns.slice(3), "rd");
      continue;
    }

    if (recordType === "L") {
      if (
        columns.length < 6
        || !columns[1]
        || !columns[3]
        || !isGfaOrientation(columns[2])
        || !isGfaOrientation(columns[4])
      ) {
        warn(`Line ${index + 1}: invalid L record`);
        continue;
      }
      const fromSide: GfaSegmentSide = columns[2] === "+" ? "end" : "start";
      const toSide: GfaSegmentSide = columns[4] === "+" ? "start" : "end";
      const canonical = canonicalLinkKey(columns[1], fromSide, columns[3], toSide, columns[5]);
      if (canonicalLinks.has(canonical)) {
        continue;
      }
      canonicalLinks.add(canonical);
      links.push({
        id: `gfa-link-${links.length + 1}`,
        from: { segmentName: columns[1], orientation: columns[2], side: fromSide },
        to: { segmentName: columns[3], orientation: columns[4], side: toSide },
        overlap: columns[5],
      });
      continue;
    }

    if (recordType === "A") {
      aRecordCount += 1;
      if (columns.length < 5 || !columns[1]) {
        warn(`Line ${index + 1}: invalid A record`);
        continue;
      }
      const segment = segmentForEvidence(columns[1]);
      segment.aRecordCount += 1;
      const haplotype = stringTag(columns.slice(5), "HG");
      if (haplotype) {
        segment.haplotypeCounts[haplotype] = (segment.haplotypeCounts[haplotype] ?? 0) + 1;
      }
    }
  }

  for (const link of links) {
    if (!segments[link.from.segmentName] || !segments[link.to.segmentName]) {
      warn(`Link ${link.id} references a missing S segment`);
    }
  }

  return {
    fileName,
    segments,
    segmentOrder,
    links,
    summary: {
      lineCount,
      segmentCount: Object.keys(segments).length,
      linkCount: links.length,
      aRecordCount,
      warningCount: warnings.length,
    },
    warnings,
  };
}

export function buildGfaAssemblyGraph(
  document: GfaEvidenceDocument,
  assemblyBlocks: ContactMapLayoutBlock[],
  maxNodes = 1_200,
): GfaAssemblyGraph {
  const orderedBlocks = [...assemblyBlocks].sort((left, right) => (
    left.visualStart - right.visualStart || left.visualEnd - right.visualEnd
  ));
  const nodes: GfaGraphNode[] = [];
  const occurrencesBySource = new Map<string, GfaGraphNode[]>();
  const groupOrder: string[] = [];
  const seenGroups = new Set<string>();

  for (const [order, block] of orderedBlocks.entries()) {
    if (!document.segments[block.sourceId] || nodes.length >= maxNodes) {
      continue;
    }
    if (!seenGroups.has(block.objectId)) {
      seenGroups.add(block.objectId);
      groupOrder.push(block.objectId);
    }
    const node: GfaGraphNode = {
      id: block.id,
      occurrenceId: block.id,
      segmentName: block.sourceId,
      groupId: block.objectId,
      assemblyBlockId: block.assemblyBlockId ?? null,
      kind: "placed",
      orientation: block.orientation,
      length: Math.max(1, block.sourceEnd - block.sourceStart),
      order,
      readDepth: document.segments[block.sourceId].readDepth,
    };
    nodes.push(node);
    const occurrences = occurrencesBySource.get(block.sourceId) ?? [];
    occurrences.push(node);
    occurrencesBySource.set(block.sourceId, occurrences);
  }

  const matchedNames = new Set(occurrencesBySource.keys());
  const unplacedNames = document.segmentOrder.filter((name) => !matchedNames.has(name));
  if (unplacedNames.length > 0 && nodes.length < maxNodes) {
    groupOrder.push("Unplaced");
    for (const [index, name] of unplacedNames.entries()) {
      if (nodes.length >= maxNodes) {
        break;
      }
      const segment = document.segments[name];
      const node: GfaGraphNode = {
        id: `gfa-unplaced:${name}`,
        occurrenceId: null,
        segmentName: name,
        groupId: "Unplaced",
        assemblyBlockId: null,
        kind: "unplaced",
        orientation: "+",
        length: Math.max(1, segment.length ?? 1),
        order: index,
        readDepth: segment.readDepth,
      };
      nodes.push(node);
      occurrencesBySource.set(name, [node]);
    }
  }

  const edges: GfaGraphEdge[] = [];
  const nodeIds = new Set(nodes.map((node) => node.id));
  const blocksByObject = new Map<string, ContactMapLayoutBlock[]>();
  for (const block of orderedBlocks) {
    if (!nodeIds.has(block.id)) {
      continue;
    }
    const values = blocksByObject.get(block.objectId) ?? [];
    values.push(block);
    blocksByObject.set(block.objectId, values);
  }
  for (const [objectId, blocks] of blocksByObject) {
    for (let index = 1; index < blocks.length; index += 1) {
      const left = blocks[index - 1];
      const right = blocks[index];
      const gapLength = Math.max(0, right.gapBefore?.length ?? 0);
      edges.push({
        id: `agp:${objectId}:${left.id}:${right.id}`,
        source: left.id,
        target: right.id,
        kind: gapLength > 0 ? "agp-gap" : "agp-joined",
        gapLength: gapLength || undefined,
      });
    }
  }

  let ambiguousLinkCount = 0;
  for (const link of document.links) {
    const fromOccurrences = occurrencesBySource.get(link.from.segmentName) ?? [];
    const toOccurrences = occurrencesBySource.get(link.to.segmentName) ?? [];
    if (fromOccurrences.length !== 1 || toOccurrences.length !== 1) {
      if (fromOccurrences.length > 0 && toOccurrences.length > 0) {
        ambiguousLinkCount += 1;
      }
      continue;
    }
    edges.push({
      id: link.id,
      source: fromOccurrences[0].id,
      target: toOccurrences[0].id,
      kind: "gfa-link",
      overlap: link.overlap,
      sourceSide: link.from.side,
      targetSide: link.to.side,
    });
  }

  return {
    nodes,
    edges,
    groupOrder,
    matchedSegmentCount: matchedNames.size,
    unmatchedSegmentCount: unplacedNames.length,
    ambiguousLinkCount,
    truncated: nodes.length < matchedNames.size + unplacedNames.length,
  };
}

/**
 * Apply a display budget after graph membership has been resolved. Required
 * nodes are never discarded, even when they alone exceed the soft budget.
 */
export function limitGfaAssemblyGraph(
  graph: GfaAssemblyGraph,
  maxNodes: number,
  requiredNodeIds: ReadonlySet<string> = new Set<string>(),
): GfaAssemblyGraph {
  const safeLimit = Number.isFinite(maxNodes)
    ? Math.max(0, Math.floor(maxNodes))
    : graph.nodes.length;
  if (graph.nodes.length <= safeLimit) {
    return graph;
  }

  const retainedIds = new Set(
    graph.nodes
      .filter((node) => requiredNodeIds.has(node.id))
      .map((node) => node.id),
  );
  let remaining = Math.max(0, safeLimit - retainedIds.size);
  for (const node of graph.nodes) {
    if (retainedIds.has(node.id) || remaining === 0) {
      continue;
    }
    retainedIds.add(node.id);
    remaining -= 1;
  }
  const nodes = graph.nodes.filter((node) => retainedIds.has(node.id));
  const presentGroupIds = new Set(nodes.map((node) => node.groupId));
  return {
    ...graph,
    nodes,
    edges: graph.edges.filter((edge) => (
      retainedIds.has(edge.source) && retainedIds.has(edge.target)
    )),
    groupOrder: graph.groupOrder.filter((groupId) => presentGroupIds.has(groupId)),
    truncated: true,
  };
}

function integerTag(columns: string[], tag: string) {
  const prefix = `${tag}:i:`;
  const value = columns.find((column) => column.startsWith(prefix));
  if (!value) {
    return null;
  }
  const parsed = Number(value.slice(prefix.length));
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function stringTag(columns: string[], tag: string) {
  const prefix = `${tag}:A:`;
  return columns.find((column) => column.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function isGfaOrientation(value: string): value is "+" | "-" {
  return value === "+" || value === "-";
}

function canonicalLinkKey(
  firstName: string,
  firstSide: GfaSegmentSide,
  secondName: string,
  secondSide: GfaSegmentSide,
  overlap: string,
) {
  const first = `${firstName}:${firstSide}`;
  const second = `${secondName}:${secondSide}`;
  return first.localeCompare(second) <= 0
    ? `${first}|${second}|${overlap}`
    : `${second}|${first}|${overlap}`;
}
