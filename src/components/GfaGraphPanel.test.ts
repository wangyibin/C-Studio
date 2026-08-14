import { describe, expect, it } from "vitest";
import {
  assemblyScaffoldColorMap,
  defaultAssemblyScaffoldColor,
} from "../state/assemblyPalette";
import {
  defaultGfaReviewOpen,
  gfaAgpJunctionPoints,
  gfaAgpBandageJunctionPoints,
  gfaAssemblyUnitId,
  gfaAssemblyUnitIdsInSelection,
  gfaChromosomeLabelSelection,
  gfaContextMenuSelectionIntent,
  gfaNodeMatchesAssemblySelection,
  gfaAutomaticBandagePaths,
  gfaBandagePathContainsPoint,
  gfaBandagePathPort,
  gfaBandageFocalNodeIds,
  gfaEndpointHiCRequestBatchSize,
  gfaEndpointHiCLinksForRelationVisibility,
  gfaInitialBandagePathPoints,
  gfaPreviewPlacements,
  gfaReshapeBandageBlockPaths,
  gfaRigidBlockNodeIds,
  graphForChromosomeConnectionVisibility,
  graphForGfaOnlyNodeVisibility,
  graphForGuidedNodeVisibility,
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

describe("GFA endpoint contact loading", () => {
  it("uses 32-pair batches when the desktop batch loader is connected", () => {
    expect(gfaEndpointHiCRequestBatchSize(true)).toBe(32);
    expect(gfaEndpointHiCRequestBatchSize(false)).toBe(1);
  });

  it("separates anchor-unanchor contacts from non-homolog anchor contacts", () => {
    const homologs = classifyGfaScaffolds(["Chr01g1", "Chr01g2", "Chr02g1"]);
    const nodes = new Map([
      ["same-a", { groupId: "Chr01g1", kind: "placed" as const }],
      ["same-b", { groupId: "Chr01g1", kind: "placed" as const }],
      ["homolog", { groupId: "Chr01g2", kind: "placed" as const }],
      ["non-homolog", { groupId: "Chr02g1", kind: "placed" as const }],
      ["unanchor-a", { groupId: "Unplaced", kind: "placed" as const }],
      ["unanchor-b", { groupId: "Unplaced", kind: "unplaced" as const }],
    ]);
    const links = [
      { source: "same-a", target: "same-b", relation: "within" },
      { source: "same-a", target: "homolog", relation: "homolog" },
      { source: "same-a", target: "non-homolog", relation: "non-homolog" },
      { source: "same-a", target: "unanchor-a", relation: "anchor-unanchor" },
      { source: "unanchor-a", target: "unanchor-b", relation: "within-unanchor" },
      { source: "same-a", target: "missing", relation: "missing" },
    ];
    const visibleRelations = (
      showHomolog: boolean,
      showNonHomolog: boolean,
      showAnchorUnanchor: boolean,
    ) => (
      gfaEndpointHiCLinksForRelationVisibility(
        links,
        nodes,
        homologs,
        showHomolog,
        showNonHomolog,
        showAnchorUnanchor,
      ).map((link) => link.relation)
    );

    expect(visibleRelations(true, true, true)).toEqual([
      "within",
      "homolog",
      "non-homolog",
      "anchor-unanchor",
      "within-unanchor",
    ]);
    expect(visibleRelations(false, true, true)).toEqual([
      "within",
      "non-homolog",
      "anchor-unanchor",
      "within-unanchor",
    ]);
    expect(visibleRelations(true, false, true)).toEqual([
      "within",
      "homolog",
      "anchor-unanchor",
      "within-unanchor",
    ]);
    expect(visibleRelations(true, true, false)).toEqual([
      "within",
      "homolog",
      "non-homolog",
      "within-unanchor",
    ]);
    expect(visibleRelations(false, false, false)).toEqual(["within", "within-unanchor"]);
  });
});

describe("GFA review panel", () => {
  it("starts closed while retaining the Review toggle", () => {
    expect(defaultGfaReviewOpen).toBe(false);
  });
});

describe("GFA chromosome label selection", () => {
  const nodes = [
    { groupId: "Chr01g1", anchorY: 40, occurrenceId: "ctg-1", assemblyBlockId: "block-a" },
    { groupId: "Chr01g1", anchorY: 44, occurrenceId: "ctg-2", assemblyBlockId: "block-a" },
    { groupId: "Chr01g1", anchorY: 42, occurrenceId: "ctg-3", assemblyBlockId: null },
    { groupId: "Chr02g1", anchorY: 100, occurrenceId: "ctg-4", assemblyBlockId: null },
    { groupId: "Unplaced", anchorY: 42, occurrenceId: "ctg-u", assemblyBlockId: null },
  ];
  const chromosomes = new Set(["Chr01g1", "Chr02g1"]);

  it("selects every unique assembly unit on the Shift-clicked chromosome row", () => {
    expect(gfaChromosomeLabelSelection(nodes, chromosomes, { x: 125, y: 42 }, 1))
      .toEqual(["block-a", "ctg-3"]);
  });

  it("does not treat node space, another row, or an unplaced label as a chromosome label", () => {
    expect(gfaChromosomeLabelSelection(nodes, chromosomes, { x: 220, y: 42 }, 1)).toBeNull();
    expect(gfaChromosomeLabelSelection(nodes, chromosomes, { x: 125, y: 72 }, 1)).toBeNull();
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

describe("Bandage-only block reshaping", () => {
  it("automatically bends one rigid block toward linked topology without changing x order", () => {
    const nodes = [
      { id: "a", groupId: "Chr01g1", assemblyBlockId: "block-1", order: 1 },
      { id: "b", groupId: "Chr01g1", assemblyBlockId: "block-1", order: 2 },
      { id: "c", groupId: "Chr02g1", assemblyBlockId: "block-2", order: 3 },
    ];
    const positions = new Map([
      ["a", { x: 40, y: 100 }],
      ["b", { x: 120, y: 100 }],
      ["c", { x: 150, y: 220 }],
    ]);
    const widths = new Map([["a", 76], ["b", 76], ["c", 60]]);
    const paths = gfaAutomaticBandagePaths(
      nodes,
      [{ source: "b", target: "c", kind: "gfa-link" }],
      positions,
      widths,
    );
    const first = paths.get("a")!;
    const second = paths.get("b")!;

    expect(first[0].x).toBeLessThan(first[first.length - 1].x);
    expect(first[first.length - 1].x).toBeLessThan(second[0].x);
    expect(second[1].y).toBeGreaterThan(100);
    expect(second[1].y - 100).toBeGreaterThan(first[0].y - 100);
  });

  it("keeps the automatic route straight when no external GFA link supports a bend", () => {
    const nodes = [
      { id: "a", groupId: "Chr01g1", assemblyBlockId: "block-1", order: 1 },
      { id: "b", groupId: "Chr01g1", assemblyBlockId: "block-1", order: 2 },
    ];
    const positions = new Map([
      ["a", { x: 40, y: 100 }],
      ["b", { x: 120, y: 100 }],
    ]);
    const widths = new Map([["a", 76], ["b", 76]]);
    const paths = gfaAutomaticBandagePaths(nodes, [], positions, widths);

    expect(paths.get("a")!.every((point) => point.y === 100)).toBe(true);
    expect(paths.get("b")!.every((point) => point.y === 100)).toBe(true);
  });

  it("creates a straight, length-scaled control path", () => {
    const points = gfaInitialBandagePathPoints(100, 40, 144);

    expect(points).toHaveLength(3);
    expect(points[0]).toEqual({ x: 28, y: 40 });
    expect(points[2]).toEqual({ x: 172, y: 40 });
  });

  it("moves the grabbed point most and bends adjacent block points with falloff", () => {
    const paths = [
      { id: "a", width: 72, pathPoints: gfaInitialBandagePathPoints(36, 0, 72) },
      { id: "b", width: 72, pathPoints: gfaInitialBandagePathPoints(108, 0, 72) },
    ];
    const reshaped = gfaReshapeBandageBlockPaths(paths, "a", 2, { x: 20, y: 40 });
    const active = reshaped.get("a")!;
    const neighbour = reshaped.get("b")!;

    expect(active[2].y).toBe(40);
    expect(active[1].y).toBeGreaterThan(0);
    expect(active[1].y).toBeLessThan(active[2].y);
    expect(neighbour[0].y).toBeGreaterThan(neighbour[2].y);
    expect(neighbour[0].y).toBeGreaterThan(0);
  });

  it("caps deformation and keeps GFA ports on the bent visual endpoints", () => {
    const path = gfaInitialBandagePathPoints(50, 20, 100);
    const reshaped = gfaReshapeBandageBlockPaths(
      [{ id: "a", width: 100, pathPoints: path }],
      "a",
      0,
      { x: 1_000, y: -1_000 },
    ).get("a")!;

    expect(reshaped[0]).toEqual({ x: 18, y: -45 });
    expect(gfaBandagePathPort(reshaped, "+", "start")).toEqual(reshaped[0]);
    expect(gfaBandagePathPort(reshaped, "-", "start")).toEqual(reshaped[reshaped.length - 1]);
  });

  it("hits the bent polyline rather than its old rectangular centre", () => {
    const path = [{ x: 0, y: 0 }, { x: 50, y: 35 }, { x: 100, y: 0 }];

    expect(gfaBandagePathContainsPoint(path, { x: 50, y: 31 }, 6)).toBe(true);
    expect(gfaBandagePathContainsPoint(path, { x: 50, y: -20 }, 6)).toBe(false);
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

  it("matches heatmap selections at either occurrence or rigid-block scope", () => {
    const node = {
      id: "placed-a",
      occurrenceId: "placed-a",
      assemblyBlockId: "block-a",
    };
    expect(gfaNodeMatchesAssemblySelection(node, new Set(["placed-a"]))).toBe(true);
    expect(gfaNodeMatchesAssemblySelection(node, new Set(["block-a"]))).toBe(true);
    expect(gfaNodeMatchesAssemblySelection(node, new Set(["placed-b"]))).toBe(false);
  });

  it("focuses an unselected assembly node before opening the shared context menu", () => {
    const node = {
      id: "placed-a",
      occurrenceId: "placed-a",
      assemblyBlockId: "block-a",
    };

    expect(gfaContextMenuSelectionIntent(node, new Set(["placed-b"]))).toEqual(["block-a"]);
    expect(gfaContextMenuSelectionIntent(node, new Set(["placed-a"]))).toBeNull();
    expect(gfaContextMenuSelectionIntent(node, new Set(["block-a"]))).toBeNull();
    expect(gfaContextMenuSelectionIntent({
      id: "gfa-only",
      occurrenceId: null,
      assemblyBlockId: null,
    }, new Set())).toBeNull();
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

  it("keeps junctions locked to AGP ends after blocks cross during manual placement", () => {
    expect(gfaAgpJunctionPoints(
      { x: 210, y: 70, width: 60 },
      { x: 100, y: 50, width: 40 },
    )).toEqual({
      source: { x: 240, y: 70 },
      target: { x: 80, y: 50 },
    });
  });

  it("keeps bent Bandage junctions on ordered path ends instead of the nearest pair", () => {
    expect(gfaAgpBandageJunctionPoints(
      [{ x: 210, y: 70 }, { x: 260, y: 90 }],
      [{ x: 70, y: 50 }, { x: 120, y: 65 }],
    )).toEqual({
      source: { x: 260, y: 90 },
      target: { x: 70, y: 50 },
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

  it("applies Non-AGP and Disconnected independently in Guided", () => {
    const graph: GfaAssemblyGraph = {
      nodes: [
        node("focus", "Chr01g1"),
        node("linked-agp", "utg000024l"),
        node("linked-gfa", "Unplaced", "unplaced"),
        node("disconnected-agp", "utg000025l"),
        node("disconnected-gfa", "Unplaced", "unplaced"),
      ],
      edges: [
        { id: "focus-agp", source: "focus", target: "linked-agp", kind: "gfa-link" },
        { id: "focus-gfa", source: "focus", target: "linked-gfa", kind: "gfa-link" },
        {
          id: "disconnected-pair",
          source: "disconnected-agp",
          target: "disconnected-gfa",
          kind: "gfa-link",
        },
      ],
      groupOrder: ["Chr01g1", "utg000024l", "utg000025l", "Unplaced"],
      matchedSegmentCount: 3,
      unmatchedSegmentCount: 2,
      ambiguousLinkCount: 0,
      truncated: false,
    };
    const homologs = classifyGfaScaffolds(graph.groupOrder);
    const visible = new Set(["focus"]);

    expect(graphForGuidedNodeVisibility(graph, visible, homologs, false, false)
      .nodes.map((candidate) => candidate.id)).toEqual(["focus", "linked-agp"]);
    expect(graphForGuidedNodeVisibility(graph, visible, homologs, true, false)
      .nodes.map((candidate) => candidate.id)).toEqual(["focus", "linked-agp", "linked-gfa"]);
    expect(graphForGuidedNodeVisibility(graph, visible, homologs, false, true)
      .nodes.map((candidate) => candidate.id)).toEqual([
        "focus",
        "linked-agp",
        "disconnected-agp",
      ]);
    expect(graphForGuidedNodeVisibility(graph, visible, homologs, true, true)
      .nodes.map((candidate) => candidate.id)).toEqual([
        "focus",
        "linked-agp",
        "linked-gfa",
        "disconnected-agp",
        "disconnected-gfa",
      ]);
  });

  it("keeps a GFA link between a retained selection and refreshed Guided focus", () => {
    const graph: GfaAssemblyGraph = {
      nodes: [node("selected", "Chr01g1"), node("refreshed", "Chr01g1")],
      edges: [{ id: "selected-refreshed", source: "selected", target: "refreshed", kind: "gfa-link" }],
      groupOrder: ["Chr01g1"],
      matchedSegmentCount: 2,
      unmatchedSegmentCount: 0,
      ambiguousLinkCount: 0,
      truncated: false,
    };
    const homologs = classifyGfaScaffolds(graph.groupOrder);

    expect(graphForGuidedNodeVisibility(
      graph,
      new Set(["selected", "refreshed"]),
      homologs,
      false,
      false,
    ).edges.map((edge) => edge.id)).toEqual(["selected-refreshed"]);
  });
});
