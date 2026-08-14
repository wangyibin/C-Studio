import type {
  GfaAssemblyGraph,
  GfaEvidenceDocument,
  GfaGraphEdge,
  GfaGraphNode,
  GfaSegmentSide,
} from "./gfa";
import type { GfaHiCLink } from "./gfaHiCLinks";
import type { ContactMapLayoutBlock } from "./importers";

export type GfaCurationIssueKind =
  | "orientation-conflict"
  | "gap-bridge"
  | "off-backbone"
  | "unplaced-neighbor"
  | "copy-ambiguity";

export type GfaCurationIssuePriority = "high" | "medium" | "info";

export interface GfaCurationPlacementEvidence {
  nodeId: string;
  segmentName: string;
  groupId: string;
  assemblyBlockId: string | null;
  assemblyUnitId: string | null;
  orientation: GfaGraphNode["orientation"];
  kind: GfaGraphNode["kind"];
  length: number;
  readDepth: number | null;
}

export interface GfaCurationAgpEvidence {
  relationship: "adjacent" | "same-scaffold-nonadjacent" | "cross-scaffold" | "unplaced";
  gapLength: number | null;
  leftNodeId: string | null;
  rightNodeId: string | null;
}

export interface GfaCurationLinkEvidence {
  edgeId: string;
  sourceNodeId: string;
  sourceSide: GfaSegmentSide | null;
  targetNodeId: string;
  targetSide: GfaSegmentSide | null;
  overlap: string | null;
  pairLinkCount: number;
  followsCurrentAdjacency: boolean | null;
}

export interface GfaCurationHiCEvidence {
  linkId: string;
  rawCount: number;
  normalizedCountPerMb2: number;
  percentile: number;
}

export interface GfaCurationIssue {
  id: string;
  kind: GfaCurationIssueKind;
  priority: GfaCurationIssuePriority;
  title: string;
  summary: string;
  interpretation: string;
  limitations: string[];
  nodeIds: string[];
  focusAssemblyUnitIds: string[];
  placements: GfaCurationPlacementEvidence[];
  agp: GfaCurationAgpEvidence | null;
  gfa: GfaCurationLinkEvidence | null;
  hic: GfaCurationHiCEvidence | null;
  ambiguityCount?: number;
}

interface BuildGfaCurationIssuesOptions {
  document: GfaEvidenceDocument;
  graph: GfaAssemblyGraph;
  assemblyBlocks: ReadonlyArray<ContactMapLayoutBlock>;
  hiCLinks?: ReadonlyArray<GfaHiCLink>;
  maxIssues?: number;
}

interface AgpAdjacency {
  edge: GfaGraphEdge;
  left: GfaGraphNode;
  right: GfaGraphNode;
}

interface GfaPair {
  source: GfaGraphNode;
  target: GfaGraphNode;
  edges: GfaGraphEdge[];
}

const defaultMaximumIssues = 40;
const maximumHiCOnlyIssues = 12;

/**
 * Build a bounded, read-only review queue from the current AGP projection.
 *
 * These are evidence candidates, not edit instructions. In particular, the
 * absence of a GFA edge is never treated as an AGP error, and copied segment
 * links are summarized without assigning them to a Cartesian product of
 * occurrences.
 */
export function buildGfaCurationIssues({
  document,
  graph,
  assemblyBlocks,
  hiCLinks = [],
  maxIssues = defaultMaximumIssues,
}: BuildGfaCurationIssuesOptions): GfaCurationIssue[] {
  if (!Number.isSafeInteger(maxIssues) || maxIssues <= 0) {
    return [];
  }

  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const blocksById = new Map(assemblyBlocks.map((block) => [block.id, block]));
  const adjacencyByPair = new Map<string, AgpAdjacency>();
  for (const edge of graph.edges) {
    if (edge.kind === "gfa-link") {
      continue;
    }
    const source = nodesById.get(edge.source);
    const target = nodesById.get(edge.target);
    if (!source || !target) {
      continue;
    }
    const [left, right] = source.order <= target.order ? [source, target] : [target, source];
    adjacencyByPair.set(nodePairKey(left.id, right.id), { edge, left, right });
  }

  const gfaPairs = new Map<string, GfaPair>();
  for (const edge of graph.edges) {
    if (edge.kind !== "gfa-link") {
      continue;
    }
    const source = nodesById.get(edge.source);
    const target = nodesById.get(edge.target);
    if (!source || !target) {
      continue;
    }
    const key = nodePairKey(source.id, target.id);
    const pair = gfaPairs.get(key);
    if (pair) {
      pair.edges.push(edge);
    } else {
      gfaPairs.set(key, { source, target, edges: [edge] });
    }
  }

  const hiCByPair = hiCEvidenceByPair(hiCLinks);
  const issues: GfaCurationIssue[] = [];
  const issueByPair = new Map<string, GfaCurationIssue>();

  for (const [pairKey, pair] of gfaPairs) {
    const { source, target, edges } = pair;
    const adjacency = adjacencyByPair.get(pairKey) ?? null;
    const hic = hiCByPair.get(pairKey) ?? null;
    const placements = [
      placementEvidence(source),
      placementEvidence(target),
    ];
    const focusAssemblyUnitIds = uniqueStrings(
      placements.flatMap((placement) => placement.assemblyUnitId ?? []),
    );

    if (source.kind === "unplaced" || target.kind === "unplaced") {
      const unplaced = source.kind === "unplaced" ? source : target;
      const placed = source.kind === "placed" ? source : target;
      if (placed.kind !== "placed") {
        continue;
      }
      const edge = edges[0];
      const issue = makeIssue({
        id: `unplaced-neighbor:${pairKey}`,
        kind: "unplaced-neighbor",
        priority: hic && hic.percentile >= 0.95 ? "high" : "medium",
        title: `${unplaced.segmentName} has an anchored GFA neighbor`,
        summary: `${unplaced.segmentName} is not placed in the current AGP; its GFA link reaches ${placed.segmentName} on ${placed.groupId}.`,
        interpretation: "Use this as a candidate neighborhood to inspect; it does not establish a unique placement or chromosome path.",
        limitations: [
          "A GFA L record is oriented overlap evidence, not placement authority.",
          "Check repeat/copy ambiguity and independent 3D contact or synteny evidence before editing the AGP.",
        ],
        pair: { source, target, edges, edge, adjacency: null, hic },
        placements,
        focusAssemblyUnitIds,
      });
      issues.push(issue);
      issueByPair.set(pairKey, issue);
      continue;
    }

    if (adjacency) {
      const matchingEdge = edges.find((edge) => gfaLinkMatchesAgpAdjacency(
        edge,
        adjacency,
        nodesById,
      ));
      const orientationKnown = hasKnownOrientation(adjacency.left)
        && hasKnownOrientation(adjacency.right);
      if (!matchingEdge && orientationKnown) {
        const edge = edges[0];
        const issue = makeIssue({
          id: `orientation-conflict:${pairKey}`,
          kind: "orientation-conflict",
          priority: "high",
          title: `GFA ends conflict with ${adjacency.left.segmentName} → ${adjacency.right.segmentName}`,
          summary: "The pair is adjacent in the current AGP, but no direct GFA link between the pair uses the two displayed, facing ends.",
          interpretation: "Review the orientation and local branch structure before considering a flip or rearrangement.",
          limitations: [
            "Alternative graph branches can create valid links on non-facing ends.",
            "Whole-unitig 3D contact strength cannot by itself resolve which physical ends should face.",
          ],
          pair: { source, target, edges, edge, adjacency, hic },
          placements,
          focusAssemblyUnitIds,
        });
        issues.push(issue);
        issueByPair.set(pairKey, issue);
        continue;
      }

      const gapLength = adjacency.edge.gapLength ?? 0;
      if (matchingEdge && gapLength > 0) {
        const issue = makeIssue({
          id: `gap-bridge:${pairKey}`,
          kind: "gap-bridge",
          priority: hic && hic.percentile >= 0.95 ? "high" : "medium",
          title: `GFA link crosses a ${formatBasePairs(gapLength)} AGP gap`,
          summary: `${adjacency.left.segmentName} and ${adjacency.right.segmentName} are separated by an AGP gap, while a direct GFA link joins their facing displayed ends.`,
          interpretation: "This is a useful junction to inspect, but the GFA overlap must remain separate from the AGP gap record until the user explicitly edits the AGP.",
          limitations: [
            "Do not convert the GFA overlap CIGAR into an AGP gap length.",
            "A direct graph link does not prove that the existing gap should be deleted.",
          ],
          pair: { source, target, edges, edge: matchingEdge, adjacency, hic },
          placements,
          focusAssemblyUnitIds,
        });
        issues.push(issue);
        issueByPair.set(pairKey, issue);
      }
      continue;
    }

    const edge = edges[0];
    const sameScaffold = source.groupId === target.groupId;
    const combinedEvidence = Boolean(hic && hic.percentile >= 0.95);
    // Cross-scaffold GFA branches are common graph context. They enter the
    // review queue only when independent strong Hi-C evidence agrees, keeping
    // the queue focused instead of mirroring every visible graph edge.
    if (!sameScaffold && !combinedEvidence) {
      continue;
    }
    const issue = makeIssue({
      id: `off-backbone:${pairKey}`,
      kind: "off-backbone",
      priority: combinedEvidence ? "high" : "medium",
      title: combinedEvidence
        ? `GFA + strong 3D contacts connect a non-adjacent pair`
        : `GFA connects non-adjacent ${source.segmentName} and ${target.segmentName}`,
      summary: sameScaffold
        ? `The linked placements are on ${source.groupId}, but they are not adjacent in the current AGP.`
        : `The linked placements belong to ${source.groupId} and ${target.groupId} in the current AGP.`,
      interpretation: "Inspect the intervening AGP structure and alternative graph branches before considering any move.",
      limitations: [
        "A non-backbone GFA link may represent a repeat, bubble, homologous branch, or unresolved graph alternative.",
        "The queue does not infer a chromosome path from this link.",
      ],
      pair: { source, target, edges, edge, adjacency: null, hic },
      placements,
      focusAssemblyUnitIds,
    });
    issues.push(issue);
    issueByPair.set(pairKey, issue);
  }

  let hiCOnlyCount = 0;
  for (const link of [...hiCLinks].sort(compareHiCLinks)) {
    const pairKey = nodePairKey(link.source, link.target);
    const hic = hiCByPair.get(pairKey);
    if (!hic || hic.percentile < 0.95) {
      continue;
    }
    const existing = issueByPair.get(pairKey);
    if (existing) {
      continue;
    }
    if (hiCOnlyCount >= maximumHiCOnlyIssues) {
      break;
    }
    const source = nodesById.get(link.source);
    const target = nodesById.get(link.target);
    if (!source || !target || source.kind !== "placed" || target.kind !== "placed") {
      continue;
    }
    if (adjacencyByPair.has(pairKey)) {
      continue;
    }
    const placements = [placementEvidence(source), placementEvidence(target)];
    const focusAssemblyUnitIds = uniqueStrings(
      placements.flatMap((placement) => placement.assemblyUnitId ?? []),
    );
    const sameScaffold = source.groupId === target.groupId;
    const issue = makeIssue({
      id: `hic-off-backbone:${pairKey}`,
      kind: "off-backbone",
      priority: "medium",
      title: `Strong 3D contacts connect a non-adjacent pair`,
      summary: sameScaffold
        ? `${source.segmentName} and ${target.segmentName} are on ${source.groupId}, but are not adjacent in the current AGP.`
        : `${source.segmentName} and ${target.segmentName} are currently placed on ${source.groupId} and ${target.groupId}.`,
      interpretation: "Use the pair to inspect the local heatmap and other evidence; this score is a triage signal, not a move instruction.",
      limitations: [
        "The current score is normalized by placement lengths but not by genomic distance or local contact-decay background.",
        "Whole-unitig contacts do not identify the supported endpoint orientation.",
      ],
      pair: { source, target, edges: [], edge: null, adjacency: null, hic },
      placements,
      focusAssemblyUnitIds,
    });
    issues.push(issue);
    issueByPair.set(pairKey, issue);
    hiCOnlyCount += 1;
  }

  const ambiguityIssue = graph.ambiguousLinkCount > 0
    ? buildCopyAmbiguityIssue(document, graph)
    : null;
  const sorted = issues.sort(compareIssues);
  if (!ambiguityIssue) {
    return sorted.slice(0, maxIssues);
  }
  if (maxIssues === 1) {
    return [ambiguityIssue];
  }
  return [...sorted.slice(0, maxIssues - 1), ambiguityIssue];
}

function makeIssue({
  id,
  kind,
  priority,
  title,
  summary,
  interpretation,
  limitations,
  pair,
  placements,
  focusAssemblyUnitIds,
}: {
  id: string;
  kind: GfaCurationIssueKind;
  priority: GfaCurationIssuePriority;
  title: string;
  summary: string;
  interpretation: string;
  limitations: string[];
  pair: {
    source: GfaGraphNode;
    target: GfaGraphNode;
    edges: GfaGraphEdge[];
    edge: GfaGraphEdge | null;
    adjacency: AgpAdjacency | null;
    hic: GfaCurationHiCEvidence | null;
  };
  placements: GfaCurationPlacementEvidence[];
  focusAssemblyUnitIds: string[];
}): GfaCurationIssue {
  const { source, target, edge, edges, adjacency, hic } = pair;
  return {
    id,
    kind,
    priority,
    title,
    summary,
    interpretation,
    limitations,
    nodeIds: [source.id, target.id],
    focusAssemblyUnitIds,
    placements,
    agp: agpEvidence(source, target, adjacency),
    gfa: edge ? {
      edgeId: edge.id,
      sourceNodeId: edge.source,
      sourceSide: edge.sourceSide ?? null,
      targetNodeId: edge.target,
      targetSide: edge.targetSide ?? null,
      overlap: edge.overlap ?? null,
      pairLinkCount: edges.length,
      followsCurrentAdjacency: adjacency
        ? gfaLinkMatchesAgpAdjacency(edge, adjacency, new Map([
          [source.id, source],
          [target.id, target],
        ]))
        : null,
    } : null,
    hic,
  };
}

function buildCopyAmbiguityIssue(
  document: GfaEvidenceDocument,
  graph: GfaAssemblyGraph,
): GfaCurationIssue {
  return {
    id: "copy-ambiguity:summary",
    kind: "copy-ambiguity",
    priority: "info",
    title: `${graph.ambiguousLinkCount.toLocaleString()} copied-occurrence links need assignment`,
    summary: "These GFA links reference a segment with multiple current placements, so they are intentionally not drawn or assigned to every possible occurrence.",
    interpretation: "Choose a specific placement using independent positional evidence before interpreting one of these links.",
    limitations: [
      "Expanding copied segments into a Cartesian product would create misleading edges.",
      "GFA segment identity alone cannot determine which current AGP occurrence owns a link.",
      `${document.summary.linkCount.toLocaleString()} total GFA links were imported from ${document.fileName}.`,
    ],
    nodeIds: [],
    focusAssemblyUnitIds: [],
    placements: [],
    agp: null,
    gfa: null,
    hic: null,
    ambiguityCount: graph.ambiguousLinkCount,
  };
}

function hiCEvidenceByPair(links: ReadonlyArray<GfaHiCLink>) {
  const ranked = [...links].sort(compareHiCLinks);
  const byPair = new Map<string, GfaCurationHiCEvidence>();
  ranked.forEach((link, index) => {
    const percentile = ranked.length <= 1 ? 1 : 1 - index / (ranked.length - 1);
    byPair.set(nodePairKey(link.source, link.target), {
      linkId: link.id,
      rawCount: link.rawCount,
      normalizedCountPerMb2: link.normalizedCountPerMb2,
      percentile,
    });
  });
  return byPair;
}

function compareHiCLinks(left: GfaHiCLink, right: GfaHiCLink) {
  return right.normalizedCountPerMb2 - left.normalizedCountPerMb2
    || right.rawCount - left.rawCount
    || left.id.localeCompare(right.id);
}

function compareIssues(left: GfaCurationIssue, right: GfaCurationIssue) {
  return priorityRank(left.priority) - priorityRank(right.priority)
    || kindRank(left.kind) - kindRank(right.kind)
    || (right.hic?.percentile ?? -1) - (left.hic?.percentile ?? -1)
    || left.title.localeCompare(right.title);
}

function priorityRank(priority: GfaCurationIssuePriority) {
  return priority === "high" ? 0 : priority === "medium" ? 1 : 2;
}

function kindRank(kind: GfaCurationIssueKind) {
  switch (kind) {
    case "orientation-conflict": return 0;
    case "gap-bridge": return 1;
    case "off-backbone": return 2;
    case "unplaced-neighbor": return 3;
    case "copy-ambiguity": return 4;
  }
}

function placementEvidence(node: GfaGraphNode): GfaCurationPlacementEvidence {
  return {
    nodeId: node.id,
    segmentName: node.segmentName,
    groupId: node.groupId,
    assemblyBlockId: node.assemblyBlockId,
    assemblyUnitId: node.kind === "placed" ? node.assemblyBlockId ?? node.occurrenceId : null,
    orientation: node.orientation,
    kind: node.kind,
    length: node.length,
    readDepth: node.readDepth,
  };
}

function agpEvidence(
  source: GfaGraphNode,
  target: GfaGraphNode,
  adjacency: AgpAdjacency | null,
): GfaCurationAgpEvidence {
  if (source.kind === "unplaced" || target.kind === "unplaced") {
    return { relationship: "unplaced", gapLength: null, leftNodeId: null, rightNodeId: null };
  }
  if (adjacency) {
    return {
      relationship: "adjacent",
      gapLength: adjacency.edge.gapLength ?? 0,
      leftNodeId: adjacency.left.id,
      rightNodeId: adjacency.right.id,
    };
  }
  return {
    relationship: source.groupId === target.groupId
      ? "same-scaffold-nonadjacent"
      : "cross-scaffold",
    gapLength: null,
    leftNodeId: null,
    rightNodeId: null,
  };
}

function gfaLinkMatchesAgpAdjacency(
  edge: GfaGraphEdge,
  adjacency: AgpAdjacency,
  nodesById: ReadonlyMap<string, GfaGraphNode>,
) {
  const source = nodesById.get(edge.source);
  const target = nodesById.get(edge.target);
  if (!source || !target || !edge.sourceSide || !edge.targetSide) {
    return false;
  }
  const sideByNodeId = new Map([
    [source.id, edge.sourceSide],
    [target.id, edge.targetSide],
  ]);
  return sideByNodeId.get(adjacency.left.id) === displayedPhysicalSide(adjacency.left, "right")
    && sideByNodeId.get(adjacency.right.id) === displayedPhysicalSide(adjacency.right, "left");
}

function displayedPhysicalSide(
  node: Pick<GfaGraphNode, "orientation">,
  displayedSide: "left" | "right",
): GfaSegmentSide | null {
  if (node.orientation !== "+" && node.orientation !== "-") {
    return null;
  }
  if (displayedSide === "left") {
    return node.orientation === "+" ? "start" : "end";
  }
  return node.orientation === "+" ? "end" : "start";
}

function hasKnownOrientation(node: Pick<GfaGraphNode, "orientation">) {
  return node.orientation === "+" || node.orientation === "-";
}

function nodePairKey(first: string, second: string) {
  return first.localeCompare(second) <= 0
    ? `${first}\u0000${second}`
    : `${second}\u0000${first}`;
}

function uniqueStrings(values: ReadonlyArray<string>) {
  return [...new Set(values)];
}

function formatBasePairs(value: number) {
  if (value >= 1_000_000) {
    return `${trimNumber(value / 1_000_000)} Mb`;
  }
  if (value >= 1_000) {
    return `${trimNumber(value / 1_000)} kb`;
  }
  return `${value.toLocaleString()} bp`;
}

function trimNumber(value: number) {
  return value.toFixed(value >= 10 ? 0 : 2).replace(/\.0+$|(?<=\.[0-9])0+$/, "");
}
