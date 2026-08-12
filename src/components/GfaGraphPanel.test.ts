import { describe, expect, it } from "vitest";
import {
  assemblyScaffoldColorMap,
  defaultAssemblyScaffoldColor,
} from "../state/assemblyPalette";
import {
  gfaAgpJunctionPoints,
  gfaAssemblyUnitId,
  gfaAssemblyUnitIdsInSelection,
  gfaBandageFocalNodeIds,
  gfaPreviewPlacements,
  gfaRigidBlockNodeIds,
  graphForChromosomeConnectionVisibility,
  graphForGfaOnlyNodeVisibility,
  graphForVisibleHomologScaffolds,
} from "./GfaGraphPanel";
import { classifyGfaScaffolds } from "../state/gfaHomologLayout";
import type { GfaAssemblyGraph, GfaGraphNode } from "../state/gfa";

describe("GFA chromosome palette", () => {
  it("provides sixteen non-repeating categorical colors for a homolog group", () => {
    const colors = Array.from({ length: 16 }, (_, index) => (
      defaultAssemblyScaffoldColor(`Chr01g${index + 1}`, index)
    ));

    expect(new Set(colors).size).toBe(16);
    expect(colors.slice(0, 4)).toEqual([
      "hsl(211 76% 32%)",
      "hsl(31 70% 42%)",
      "hsl(301 64% 52%)",
      "hsl(121 76% 43%)",
    ]);
    expect(colors[15]).toBe("hsl(166 66% 34%)");
  });

  it("starts a shifted lightness cycle instead of repeating member one at member seventeen", () => {
    expect(defaultAssemblyScaffoldColor("Chr01g17", 16)).toBe("hsl(222 76% 40%)");
    expect(defaultAssemblyScaffoldColor("Chr01g17", 16)).not.toBe(
      defaultAssemblyScaffoldColor("Chr01g1", 0),
    );
  });

  it("uses distinct curated hues for different homolog groups", () => {
    expect(defaultAssemblyScaffoldColor("Chr01g1", 0)).not.toBe(defaultAssemblyScaffoldColor("Chr02g1", 1));
    expect(defaultAssemblyScaffoldColor("Chr02g1", 1)).toBe("hsl(28 76% 32%)");
  });

  it("honors custom homolog classification indices", () => {
    const colors = assemblyScaffoldColorMap(["hapA-1", "hapA-2"], "(hapA)-(\\d+)");
    expect(colors.get("hapA-2")).toBe("hsl(31 70% 42%)");
  });
});

describe("GFA compact preview layout", () => {
  function previewNode(id: string, groupId: string, order: number, placed = true): GfaGraphNode {
    return {
      id,
      occurrenceId: placed ? id : null,
      segmentName: id,
      groupId,
      assemblyBlockId: null,
      kind: placed ? "placed" : "unplaced",
      orientation: "+",
      length: 100,
      order,
      readDepth: null,
    };
  }

  it("spreads homolog lanes vertically and keeps unanchors in a right-hand zone", () => {
    const graph: GfaAssemblyGraph = {
      nodes: [
        previewNode("a1", "Chr01g1", 0),
        previewNode("a2", "Chr01g1", 1),
        previewNode("b1", "Chr01g2", 2),
        previewNode("c1", "Chr01g3", 3),
        previewNode("d1", "Chr01g4", 4),
        previewNode("u1", "Unplaced", 5, false),
      ],
      edges: [
        { id: "joined", source: "a1", target: "a2", kind: "agp-joined" },
        { id: "linked", source: "a2", target: "u1", kind: "gfa-link" },
      ],
      groupOrder: ["Chr01g1", "Chr01g2", "Chr01g3", "Chr01g4", "Unplaced"],
      matchedSegmentCount: 5,
      unmatchedSegmentCount: 1,
      ambiguousLinkCount: 0,
      truncated: false,
    };
    const homologs = classifyGfaScaffolds(graph.groupOrder);
    const placements = gfaPreviewPlacements(graph, homologs, 300, 120);

    expect(placements.get("a1")!.y).toBeLessThan(placements.get("b1")!.y);
    expect(placements.get("b1")!.y).toBeLessThan(placements.get("c1")!.y);
    expect(placements.get("c1")!.y).toBeLessThan(placements.get("d1")!.y);
    expect(placements.get("d1")!.y - placements.get("a1")!.y).toBeGreaterThan(80);
    expect(placements.get("u1")!.x).toBeGreaterThan(placements.get("a2")!.x);
    expect([...placements.values()].every((point) => (
      point.x >= 0 && point.x <= 300 && point.y >= 0 && point.y <= 120
    ))).toBe(true);
  });
});

describe("GFA rigid block dragging", () => {
  const nodes = [
    { id: "a", groupId: "Chr01g1", assemblyBlockId: "block-1" },
    { id: "b", groupId: "Chr01g1", assemblyBlockId: "block-1" },
    { id: "copy", groupId: "Chr01g2", assemblyBlockId: "block-1" },
    { id: "single", groupId: "Chr01g1", assemblyBlockId: null },
  ];

  it("moves every unitig in the selected block, but not another chromosome", () => {
    expect(gfaRigidBlockNodeIds(nodes, "b")).toEqual(["a", "b"]);
  });

  it("keeps an unblocked unitig as a singleton drag target", () => {
    expect(gfaRigidBlockNodeIds(nodes, "single")).toEqual(["single"]);
    expect(gfaRigidBlockNodeIds(nodes, "missing")).toEqual([]);
  });

  it("expands a Bandage contig window to the complete boundary block", () => {
    const visibleNodes = nodes.map((node) => ({
      ...node,
      occurrenceId: node.id,
    }));

    expect([...gfaBandageFocalNodeIds(visibleNodes, new Set(["b"]))]).toEqual(["b", "a"]);
    expect([...gfaBandageFocalNodeIds(visibleNodes, new Set(["single"]))]).toEqual(["single"]);
  });
});

describe("GFA Shift-drag selection", () => {
  const nodes = [
    { occurrenceId: "placed-a", assemblyBlockId: "block-a", x: 20, y: 20, width: 20, height: 10 },
    { occurrenceId: "placed-b", assemblyBlockId: null, x: 60, y: 20, width: 20, height: 10 },
    { occurrenceId: null, assemblyBlockId: null, x: 100, y: 20, width: 20, height: 10 },
    { occurrenceId: "placed-a-copy", assemblyBlockId: "block-a", x: 20, y: 60, width: 20, height: 10 },
  ];

  it("resolves every placed node to its whole assembly block", () => {
    expect(gfaAssemblyUnitId(nodes[0])).toBe("block-a");
    expect(gfaAssemblyUnitId(nodes[1])).toBe("placed-b");
    expect(gfaAssemblyUnitId(nodes[2])).toBeNull();
  });

  it("selects every assembly unit intersecting a box in either drag direction", () => {
    expect(gfaAssemblyUnitIdsInSelection(nodes, { x: 5, y: 10 }, { x: 75, y: 30 }))
      .toEqual(["block-a", "placed-b"]);
    expect(gfaAssemblyUnitIdsInSelection(nodes, { x: 75, y: 30 }, { x: 5, y: 10 }))
      .toEqual(["block-a", "placed-b"]);
  });

  it("ignores unanchored GFA-only nodes and deduplicates assembly blocks", () => {
    expect(gfaAssemblyUnitIdsInSelection(nodes, { x: 0, y: 0 }, { x: 120, y: 80 }))
      .toEqual(["block-a", "placed-b"]);
  });
});

describe("GFA AGP junction geometry", () => {
  it("connects facing visual edges regardless of negative contig orientation", () => {
    expect(gfaAgpJunctionPoints(
      { x: 100, y: 40, width: 80 },
      { x: 190, y: 40, width: 60 },
    )).toEqual({
      source: { x: 140, y: 40 },
      target: { x: 160, y: 40 },
    });
  });

  it("keeps junctions facing after blocks cross during manual placement", () => {
    expect(gfaAgpJunctionPoints(
      { x: 210, y: 70, width: 60 },
      { x: 100, y: 50, width: 40 },
    )).toEqual({
      source: { x: 180, y: 70 },
      target: { x: 120, y: 50 },
    });
  });
});

describe("GFA homolog and unanchored filtering", () => {
  function node(id: string, groupId: string, kind: "placed" | "unplaced" = "placed"): GfaGraphNode {
    return {
      id,
      occurrenceId: kind === "placed" ? id : null,
      segmentName: id,
      groupId,
      assemblyBlockId: null,
      kind,
      orientation: "+",
      length: 100,
      order: 0,
      readDepth: null,
    };
  }

  it("keeps linked unanchors in the homolog preview without making them chromosomes", () => {
    const graph: GfaAssemblyGraph = {
      nodes: [
        node("chr", "Chr01g1"),
        node("agp-unanchor", "utg000024l"),
        node("gfa-unanchor", "Unplaced", "unplaced"),
      ],
      edges: [
        { id: "linked-unanchor", source: "chr", target: "gfa-unanchor", kind: "gfa-link" },
      ],
      groupOrder: ["Chr01g1", "utg000024l", "Unplaced"],
      matchedSegmentCount: 2,
      unmatchedSegmentCount: 1,
      ambiguousLinkCount: 0,
      truncated: false,
    };
    const homologs = classifyGfaScaffolds(graph.groupOrder);
    const filtered = graphForVisibleHomologScaffolds(
      graph,
      new Set(["Chr01g1", "utg000024l"]),
      homologs,
      false,
    );

    expect(filtered.nodes.map((candidate) => candidate.id)).toEqual(["chr", "gfa-unanchor"]);
    expect(filtered.edges.map((edge) => edge.id)).toEqual(["linked-unanchor"]);
    expect(filtered.groupOrder).toEqual(["Chr01g1", "Unplaced"]);
  });

  it("keeps disconnected regex-unmatched AGP and GFA contigs in Curation", () => {
    const graph: GfaAssemblyGraph = {
      nodes: [
        node("chr", "Chr01g1"),
        node("agp-unanchor", "utg000024l"),
        node("gfa-unanchor", "Unplaced", "unplaced"),
      ],
      edges: [],
      groupOrder: ["Chr01g1", "utg000024l", "Unplaced"],
      matchedSegmentCount: 2,
      unmatchedSegmentCount: 1,
      ambiguousLinkCount: 0,
      truncated: false,
    };
    const homologs = classifyGfaScaffolds(graph.groupOrder);
    const filtered = graphForVisibleHomologScaffolds(
      graph,
      new Set(["Chr01g1", "utg000024l"]),
      homologs,
    );

    expect(filtered.nodes.map((candidate) => candidate.id)).toEqual([
      "chr",
      "agp-unanchor",
      "gfa-unanchor",
    ]);
    expect(filtered.groupOrder).toEqual(["Chr01g1", "utg000024l", "Unplaced"]);
  });

  it("hides only GFA-only utgs and their links by default", () => {
    const graph: GfaAssemblyGraph = {
      nodes: [
        node("chr", "Chr01g1"),
        node("agp-unanchor", "utg000024l"),
        node("gfa-only", "Unplaced", "unplaced"),
      ],
      edges: [
        { id: "agp-link", source: "chr", target: "agp-unanchor", kind: "gfa-link" },
        { id: "gfa-only-link", source: "chr", target: "gfa-only", kind: "gfa-link" },
      ],
      groupOrder: ["Chr01g1", "utg000024l", "Unplaced"],
      matchedSegmentCount: 2,
      unmatchedSegmentCount: 1,
      ambiguousLinkCount: 0,
      truncated: false,
    };

    const filtered = graphForGfaOnlyNodeVisibility(graph, false);
    expect(filtered.nodes.map((candidate) => candidate.id)).toEqual(["chr", "agp-unanchor"]);
    expect(filtered.edges.map((edge) => edge.id)).toEqual(["agp-link"]);
    expect(filtered.groupOrder).toEqual(["Chr01g1", "utg000024l"]);
    expect(graphForGfaOnlyNodeVisibility(graph, true)).toBe(graph);
  });

  it("hides components with no GFA-link path to a chromosome group", () => {
    const graph: GfaAssemblyGraph = {
      nodes: [
        node("chr", "Chr01g1"),
        node("bridge", "Unplaced", "unplaced"),
        node("connected", "utg000024l"),
        node("disconnected-a", "utg000025l"),
        node("disconnected-b", "Unplaced", "unplaced"),
      ],
      edges: [
        { id: "chr-bridge", source: "chr", target: "bridge", kind: "gfa-link" },
        { id: "bridge-connected", source: "bridge", target: "connected", kind: "gfa-link" },
        { id: "disconnected-pair", source: "disconnected-a", target: "disconnected-b", kind: "gfa-link" },
        { id: "agp-only", source: "chr", target: "disconnected-a", kind: "agp-joined" },
      ],
      groupOrder: ["Chr01g1", "Unplaced", "utg000024l", "utg000025l"],
      matchedSegmentCount: 3,
      unmatchedSegmentCount: 2,
      ambiguousLinkCount: 0,
      truncated: false,
    };
    const homologs = classifyGfaScaffolds(graph.groupOrder);
    const viewportGraph = {
      ...graph,
      nodes: graph.nodes.filter((candidate) => candidate.id !== "bridge"),
      edges: graph.edges.filter((edge) => edge.id !== "chr-bridge" && edge.id !== "bridge-connected"),
    };

    const filtered = graphForChromosomeConnectionVisibility(
      viewportGraph,
      graph,
      homologs,
      false,
    );
    expect(filtered.nodes.map((candidate) => candidate.id)).toEqual(["chr", "connected"]);
    expect(filtered.edges).toEqual([]);
    expect(filtered.groupOrder).toEqual(["Chr01g1", "utg000024l"]);
    expect(graphForChromosomeConnectionVisibility(graph, graph, homologs, true)).toBe(graph);
  });
});
