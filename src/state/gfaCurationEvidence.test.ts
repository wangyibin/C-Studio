import { describe, expect, it } from "vitest";
import type {
  GfaAssemblyGraph,
  GfaEvidenceDocument,
  GfaGraphEdge,
  GfaGraphNode,
} from "./gfa";
import { buildGfaCurationIssues } from "./gfaCurationEvidence";
import type { GfaHiCLink } from "./gfaHiCLinks";
import type { ContactMapLayoutBlock } from "./importers";

function node(
  id: string,
  order: number,
  options: Partial<GfaGraphNode> = {},
): GfaGraphNode {
  return {
    id,
    occurrenceId: id,
    segmentName: id,
    groupId: "Chr01g1",
    assemblyBlockId: null,
    kind: "placed",
    orientation: "+",
    length: 1_000_000,
    order,
    readDepth: 30,
    ...options,
  };
}

function graph(nodes: GfaGraphNode[], edges: GfaGraphEdge[], ambiguousLinkCount = 0): GfaAssemblyGraph {
  return {
    nodes,
    edges,
    groupOrder: [...new Set(nodes.map((value) => value.groupId))],
    matchedSegmentCount: nodes.filter((value) => value.kind === "placed").length,
    unmatchedSegmentCount: nodes.filter((value) => value.kind === "unplaced").length,
    ambiguousLinkCount,
    truncated: false,
  };
}

function block(value: GfaGraphNode, visualStart: number, gapLength = 0): ContactMapLayoutBlock {
  return {
    id: value.id,
    objectId: value.groupId,
    sourceId: value.segmentName,
    sourceStart: 0,
    sourceEnd: value.length,
    visualStart,
    visualEnd: visualStart + value.length,
    orientation: value.orientation,
    gapBefore: gapLength > 0 ? {
      componentType: "N",
      length: gapLength,
      gapType: "scaffold",
      linkage: "yes",
      linkageEvidence: "map",
    } : undefined,
  };
}

function document(linkCount = 1): GfaEvidenceDocument {
  return {
    fileName: "assembly.gfa",
    segments: {},
    segmentOrder: [],
    links: [],
    summary: {
      lineCount: 0,
      segmentCount: 0,
      linkCount,
      aRecordCount: 0,
      warningCount: 0,
    },
    warnings: [],
  };
}

function hic(source: string, target: string, score: number): GfaHiCLink {
  return {
    id: `hic:${source}:${target}`,
    source,
    target,
    rawCount: score * 2,
    normalizedCountPerMb2: score,
    lineWidth: 2,
  };
}

describe("GFA curation review queue", () => {
  it("flags an adjacent GFA link that reaches non-facing physical ends", () => {
    const a = node("a", 0);
    const b = node("b", 1);
    const issues = buildGfaCurationIssues({
      document: document(),
      graph: graph([a, b], [
        { id: "agp", source: "a", target: "b", kind: "agp-joined" },
        {
          id: "gfa",
          source: "a",
          target: "b",
          kind: "gfa-link",
          sourceSide: "start",
          targetSide: "end",
          overlap: "20M",
        },
      ]),
      assemblyBlocks: [block(a, 0), block(b, 1_000_000)],
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      kind: "orientation-conflict",
      priority: "high",
      focusAssemblyUnitIds: ["a", "b"],
      gfa: { followsCurrentAdjacency: false, overlap: "20M" },
    });
  });

  it("keeps reverse-oriented facing ends and reports a direct link across an AGP gap", () => {
    const a = node("a", 0, { orientation: "-" });
    const b = node("b", 1, { orientation: "-" });
    const issues = buildGfaCurationIssues({
      document: document(),
      graph: graph([a, b], [
        { id: "agp", source: "a", target: "b", kind: "agp-gap", gapLength: 2_000 },
        {
          id: "gfa",
          source: "a",
          target: "b",
          kind: "gfa-link",
          sourceSide: "start",
          targetSide: "end",
          overlap: "120M",
        },
      ]),
      assemblyBlocks: [block(a, 0), block(b, 1_002_000, 2_000)],
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      kind: "gap-bridge",
      priority: "medium",
      agp: { relationship: "adjacent", gapLength: 2_000 },
      gfa: { followsCurrentAdjacency: true, overlap: "120M" },
    });
  });

  it("raises a non-adjacent pair when GFA and top-ranked Hi-C agree", () => {
    const a = node("a", 0);
    const b = node("b", 1);
    const c = node("c", 2);
    const issues = buildGfaCurationIssues({
      document: document(),
      graph: graph([a, b, c], [
        { id: "agp-ab", source: "a", target: "b", kind: "agp-joined" },
        { id: "agp-bc", source: "b", target: "c", kind: "agp-joined" },
        {
          id: "gfa-ac",
          source: "a",
          target: "c",
          kind: "gfa-link",
          sourceSide: "end",
          targetSide: "start",
          overlap: "0M",
        },
      ]),
      assemblyBlocks: [block(a, 0), block(b, 1_000_000), block(c, 2_000_000)],
      hiCLinks: [hic("a", "c", 30), hic("a", "b", 5)],
    });

    expect(issues[0]).toMatchObject({
      kind: "off-backbone",
      priority: "high",
      hic: { percentile: 1, normalizedCountPerMb2: 30 },
    });
    expect(issues[0].title).toContain("GFA + strong 3D contacts");
  });

  it("surfaces a GFA-only unitig as a candidate neighbor without assigning placement", () => {
    const placed = node("placed", 0, { assemblyBlockId: "block-1" });
    const unplaced = node("unplaced", 1, {
      occurrenceId: null,
      kind: "unplaced",
      groupId: "Unplaced",
    });
    const issues = buildGfaCurationIssues({
      document: document(),
      graph: graph([placed, unplaced], [{
        id: "gfa",
        source: "placed",
        target: "unplaced",
        kind: "gfa-link",
        sourceSide: "end",
        targetSide: "start",
        overlap: "10M",
      }]),
      assemblyBlocks: [block(placed, 0)],
    });

    expect(issues[0]).toMatchObject({
      kind: "unplaced-neighbor",
      focusAssemblyUnitIds: ["block-1"],
      agp: { relationship: "unplaced" },
    });
    expect(issues[0].interpretation).toContain("does not establish a unique placement");
  });

  it("keeps ordinary cross-scaffold GFA branches as graph context unless strong Hi-C agrees", () => {
    const a = node("a", 0, { groupId: "Chr01g1" });
    const b = node("b", 1, { groupId: "Chr02g1" });
    const gfaGraph = graph([a, b], [{
      id: "gfa",
      source: "a",
      target: "b",
      kind: "gfa-link",
      sourceSide: "end",
      targetSide: "start",
      overlap: "0M",
    }]);
    const blocks = [block(a, 0), block(b, 1_000_000)];

    expect(buildGfaCurationIssues({
      document: document(),
      graph: gfaGraph,
      assemblyBlocks: blocks,
    })).toEqual([]);

    expect(buildGfaCurationIssues({
      document: document(),
      graph: gfaGraph,
      assemblyBlocks: blocks,
      hiCLinks: [hic("a", "b", 20)],
    })[0]).toMatchObject({
      kind: "off-backbone",
      priority: "high",
    });
  });

  it("summarizes copied-occurrence ambiguity without expanding occurrence pairs", () => {
    const a = node("a", 0);
    const issues = buildGfaCurationIssues({
      document: document(12),
      graph: graph([a], [], 7),
      assemblyBlocks: [block(a, 0)],
    });

    expect(issues).toEqual([expect.objectContaining({
      kind: "copy-ambiguity",
      ambiguityCount: 7,
      nodeIds: [],
      focusAssemblyUnitIds: [],
    })]);
  });

  it("does not treat a missing GFA edge as an AGP error", () => {
    const a = node("a", 0);
    const b = node("b", 1);
    const issues = buildGfaCurationIssues({
      document: document(0),
      graph: graph([a, b], [
        { id: "agp", source: "a", target: "b", kind: "agp-joined" },
      ]),
      assemblyBlocks: [block(a, 0), block(b, 1_000_000)],
    });

    expect(issues).toEqual([]);
  });
});
