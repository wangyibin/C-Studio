import { describe, expect, it } from "vitest";
import {
  classifyGfaScaffolds,
  defaultGfaHomologPattern,
  gfaBandageControlPoint,
  gfaBandageNodeWidths,
  gfaCurationNodeWidths,
  gfaHomologRowGap,
  gfaLinkScope,
  layoutGfaNodesBandage,
  layoutGfaNodesForCuration,
  layoutGfaNodesGuided,
  layoutGfaNodesByHomolog,
} from "./gfaHomologLayout";

describe("GFA homologous chromosome grouping", () => {
  it("uses the first capture as the column and sorts the second capture within it", () => {
    const result = classifyGfaScaffolds([
      "Chr02g2",
      "Chr01g4",
      "Chr01g1",
      "utg000001l",
      "Chr02g1",
    ]);

    expect(defaultGfaHomologPattern).toBe("(Chr\\d+)g(\\d+)");
    expect(result.columns).toEqual([
      {
        id: "Chr01",
        scaffolds: [
          { id: "Chr01g1", member: "1" },
          { id: "Chr01g4", member: "4" },
        ],
      },
      {
        id: "Chr02",
        scaffolds: [
          { id: "Chr02g1", member: "1" },
          { id: "Chr02g2", member: "2" },
        ],
      },
    ]);
    expect(result.otherScaffolds).toEqual(["utg000001l"]);
    expect(result.error).toBeNull();
  });

  it("reports invalid expressions without dropping scaffold ids", () => {
    const result = classifyGfaScaffolds(["Chr01g1", "Unplaced"], "(");

    expect(result.error).toContain("Invalid regular expression");
    expect(result.columns).toEqual([]);
    expect(result.otherScaffolds).toEqual(["Chr01g1", "Unplaced"]);
  });

  it("places chromosomes in horizontal rows with larger gaps between non-homolog groups", () => {
    const homologs = classifyGfaScaffolds(["Chr01g1", "Chr01g2", "Chr02g1"]);
    const positions = layoutGfaNodesByHomolog([
      { id: "a2", groupId: "Chr01g1", order: 2 },
      { id: "a1", groupId: "Chr01g1", order: 1 },
      { id: "b1", groupId: "Chr01g2", order: 3 },
      { id: "c1", groupId: "Chr02g1", order: 4 },
    ], homologs);

    expect(positions.get("a1")!.x).toBeLessThan(positions.get("a2")!.x);
    expect(positions.get("b1")!.y - positions.get("a1")!.y).toBe(44);
    expect(positions.get("c1")!.y - positions.get("b1")!.y).toBeGreaterThan(100);
    expect(positions.get("a1")!.y).toBe(positions.get("a2")!.y);
  });

  it("expands homolog lane spacing for a 12-copy chromosome group", () => {
    const scaffoldIds = Array.from({ length: 12 }, (_, index) => `Chr01g${index + 1}`);
    const homologs = classifyGfaScaffolds(scaffoldIds);
    const nodes = scaffoldIds.map((groupId, index) => ({
      id: `node-${index + 1}`,
      groupId,
      order: index,
    }));
    const positions = layoutGfaNodesByHomolog(nodes, homologs);

    expect(gfaHomologRowGap(4)).toBe(44);
    expect(gfaHomologRowGap(8)).toBe(64);
    expect(gfaHomologRowGap(12)).toBe(84);
    for (let index = 1; index < nodes.length; index += 1) {
      expect(positions.get(nodes[index].id)!.y - positions.get(nodes[index - 1].id)!.y).toBe(84);
    }
  });

  it("keeps unitigs inside one block touching and separates consecutive blocks", () => {
    const homologs = classifyGfaScaffolds(["Chr01g1"]);
    const positions = layoutGfaNodesByHomolog([
      { id: "a", groupId: "Chr01g1", assemblyBlockId: "block-1", order: 1 },
      { id: "b", groupId: "Chr01g1", assemblyBlockId: "block-1", order: 2 },
      { id: "c", groupId: "Chr01g1", assemblyBlockId: "block-2", order: 3 },
    ], homologs);

    const widths = gfaCurationNodeWidths([
      { id: "a", groupId: "Chr01g1", assemblyBlockId: "block-1", order: 1 },
      { id: "b", groupId: "Chr01g1", assemblyBlockId: "block-1", order: 2 },
      { id: "c", groupId: "Chr01g1", assemblyBlockId: "block-2", order: 3 },
    ]);
    const touchingDistance = widths.get("a")! / 2 + widths.get("b")! / 2;
    expect(positions.get("b")!.x - positions.get("a")!.x).toBe(touchingDistance + 4);
    expect(positions.get("c")!.x - positions.get("b")!.x).toBeGreaterThan(touchingDistance + 4);
    expect(positions.get("a")!.y).toBe(positions.get("c")!.y);
  });

  it("does not create chromosome rows for regex-unmatched scaffolds", () => {
    const homologs = classifyGfaScaffolds(["Chr01g1", "utg000024l", "debris"]);
    const positions = layoutGfaNodesByHomolog([
      { id: "chr", groupId: "Chr01g1", order: 1 },
      { id: "unanchor", groupId: "utg000024l", order: 2 },
      { id: "debris", groupId: "debris", order: 3 },
    ], homologs);

    expect([...positions.keys()]).toEqual(["chr"]);
  });

  it("classifies GFA links as homologous or non-homologous", () => {
    const homologs = classifyGfaScaffolds(["Chr01g1", "Chr01g2", "Chr02g1", "debris"]);

    expect(gfaLinkScope("Chr01g1", "Chr01g1", homologs)).toBe("within-scaffold");
    expect(gfaLinkScope("Chr01g1", "Chr01g2", homologs)).toBe("homolog");
    expect(gfaLinkScope("Chr01g1", "Chr02g1", homologs)).toBe("non-homolog");
    expect(gfaLinkScope("Chr01g1", "debris", homologs)).toBe("non-homolog");
  });

  it("lays out Bandage topology while keeping each AGP block rigid", () => {
    const nodes = [
      { id: "a", groupId: "Chr01g1", assemblyBlockId: "block-1", order: 1 },
      { id: "b", groupId: "Chr01g1", assemblyBlockId: "block-1", order: 2 },
      { id: "c", groupId: "Chr04g3", assemblyBlockId: "block-9", order: 3 },
    ];
    const edges = [
      { source: "a", target: "c", kind: "gfa-link" as const },
      { source: "c", target: "b", kind: "gfa-link" as const },
    ];
    const first = layoutGfaNodesBandage(nodes, edges);
    const second = layoutGfaNodesBandage(nodes, edges);

    expect([...first]).toEqual([...second]);
    const widths = gfaBandageNodeWidths(nodes);
    expect(first.get("a")!.y).toBe(first.get("b")!.y);
    expect(first.get("a")!.x).toBeLessThan(first.get("b")!.x);
    expect(first.get("b")!.x - first.get("a")!.x).toBe(
      widths.get("a")! / 2 + 4 + widths.get("b")! / 2,
    );
    expect(Math.hypot(
      first.get("a")!.x - first.get("c")!.x,
      first.get("a")!.y - first.get("c")!.y,
    )).toBeLessThan(260);
  });

  it("keeps the Guided AGP backbone ordered and places one-hop neighbors in lanes", () => {
    const nodes = [
      { id: "a", groupId: "Chr01g1", assemblyBlockId: "block-1", order: 1, length: 40_000 },
      { id: "b", groupId: "Chr01g1", assemblyBlockId: "block-1", order: 2, length: 60_000 },
      { id: "c", groupId: "Chr01g1", assemblyBlockId: "block-2", order: 3, length: 50_000 },
      { id: "left-branch", groupId: "Unplaced", order: 4, length: 30_000 },
      { id: "right-branch", groupId: "Unplaced", order: 5, length: 30_000 },
    ];
    const positions = layoutGfaNodesGuided(nodes, [
      { source: "b", target: "c", kind: "agp-joined" },
      { source: "a", target: "left-branch", kind: "gfa-link" },
      { source: "c", target: "right-branch", kind: "gfa-link" },
    ], new Set(["a", "b", "c"]));
    const widths = gfaBandageNodeWidths(nodes);

    expect(positions.get("a")!.y).toBe(positions.get("b")!.y);
    expect(positions.get("b")!.y).toBe(positions.get("c")!.y);
    expect(positions.get("a")!.x).toBeLessThan(positions.get("b")!.x);
    expect(positions.get("b")!.x).toBeLessThan(positions.get("c")!.x);
    expect(positions.get("b")!.x - positions.get("a")!.x).toBe(
      widths.get("a")! / 2 + 4 + widths.get("b")! / 2,
    );
    expect(positions.get("left-branch")!.y).not.toBe(positions.get("a")!.y);
    expect(positions.get("right-branch")!.y).not.toBe(positions.get("c")!.y);
    expect(positions.get("left-branch")!.x).toBeLessThan(positions.get("right-branch")!.x);
  });

  it("separates Guided backbones from different scaffolds without changing either order", () => {
    const nodes = [
      { id: "a1", groupId: "Chr01g1", order: 1 },
      { id: "a2", groupId: "Chr01g1", order: 2 },
      { id: "b1", groupId: "Chr01g2", order: 3 },
      { id: "b2", groupId: "Chr01g2", order: 4 },
    ];
    const focal = new Set(nodes.map((node) => node.id));
    const first = layoutGfaNodesGuided(nodes, [], focal);
    const second = layoutGfaNodesGuided(nodes, [], focal);

    expect([...first]).toEqual([...second]);
    expect(first.get("a1")!.x).toBeLessThan(first.get("a2")!.x);
    expect(first.get("b1")!.x).toBeLessThan(first.get("b2")!.x);
    expect(first.get("a1")!.y).not.toBe(first.get("b1")!.y);
  });

  it("does not combine equal block ids from different chromosomes", () => {
    const nodes = [
      { id: "a", groupId: "Chr01g1", assemblyBlockId: "block-1", order: 1 },
      { id: "b", groupId: "Chr01g2", assemblyBlockId: "block-1", order: 2 },
    ];
    const positions = layoutGfaNodesBandage(nodes, []);

    expect(Math.hypot(
      positions.get("a")!.x - positions.get("b")!.x,
      positions.get("a")!.y - positions.get("b")!.y,
    )).toBeGreaterThan(50);
  });

  it("scales Bandage node width linearly from AGP or GFA sequence length", () => {
    const widths = gfaBandageNodeWidths([
      { id: "short", groupId: "Chr01g1", order: 1, length: 10_000 },
      { id: "middle", groupId: "Chr01g1", order: 2, length: 100_000 },
      { id: "long", groupId: "Unplaced", order: 3, length: 200_000 },
    ]);

    expect(widths.get("middle")! / widths.get("short")!).toBe(10);
    expect(widths.get("long")! / widths.get("middle")!).toBe(2);
  });

  it("caps extreme lengths without losing the readable minimum", () => {
    const widths = gfaBandageNodeWidths([
      { id: "tiny", groupId: "Unplaced", order: 1, length: 1 },
      { id: "huge", groupId: "Unplaced", order: 2, length: 1_000_000_000 },
    ]);

    expect(widths.get("tiny")).toBe(18);
    expect(widths.get("huge")).toBe(360);
  });

  it("packs disconnected Bandage components into a finite deterministic canvas", () => {
    const nodes = Array.from({ length: 60 }, (_, index) => ({
      id: `n-${index}`,
      groupId: `Chr${index}g1`,
      order: index,
    }));
    const positions = layoutGfaNodesBandage(nodes, []);

    expect(positions.size).toBe(60);
    expect([...positions.values()].every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
    expect(Math.max(...[...positions.values()].map((point) => point.y))).toBeGreaterThan(100);
  });

  it("recomputes a Bandage-style curve when either node moves", () => {
    const first = gfaBandageControlPoint({ x: 0, y: 0 }, { x: 100, y: 0 }, 1, 0.2, 18, 96);
    const moved = gfaBandageControlPoint({ x: 0, y: 0 }, { x: 100, y: 80 }, 1, 0.2, 18, 96);

    expect(first).toEqual({ x: 50, y: 20 });
    expect(moved).not.toEqual(first);
  });

  it("keeps placed chromosome rows fixed and puts linked unanchored nodes to the right", () => {
    const nodes = [
      { id: "placed-1", groupId: "Chr01g1", order: 1 },
      { id: "placed-2", groupId: "Chr01g1", order: 2 },
      { id: "branch", groupId: "Unplaced", order: 1 },
    ];
    const homologs = classifyGfaScaffolds(["Chr01g1", "Unplaced"]);
    const base = layoutGfaNodesByHomolog(nodes, homologs);
    const positions = layoutGfaNodesForCuration(nodes, [
      { source: "placed-1", target: "placed-2", kind: "agp-joined" },
      { source: "placed-2", target: "branch", kind: "gfa-link" },
    ], homologs);

    expect(positions.get("placed-1")).toEqual(base.get("placed-1"));
    expect(positions.get("placed-2")).toEqual(base.get("placed-2"));
    expect(positions.get("branch")!.x).toBeGreaterThan(positions.get("placed-2")!.x + 50);
    expect(Math.abs(positions.get("branch")!.y - positions.get("placed-2")!.y)).toBeLessThan(100);
  });

  it("treats a regex-unmatched AGP singleton as an unanchor, not a chromosome row", () => {
    const nodes = [
      { id: "placed", groupId: "Chr01g1", order: 1 },
      { id: "singleton", groupId: "utg000024l", order: 2 },
    ];
    const homologs = classifyGfaScaffolds(["Chr01g1", "utg000024l"]);
    const positions = layoutGfaNodesForCuration(nodes, [
      { source: "placed", target: "singleton", kind: "gfa-link" },
    ], homologs);

    expect(positions.get("singleton")!.x).toBeGreaterThan(positions.get("placed")!.x + 50);
    expect(Math.abs(positions.get("singleton")!.y - positions.get("placed")!.y)).toBeLessThan(100);
  });

  it("returns the same frozen curation layout for the same graph", () => {
    const nodes = [
      { id: "a", groupId: "Chr01g1", order: 1 },
      { id: "b", groupId: "Unplaced", order: 1 },
    ];
    const edges = [{ source: "a", target: "b", kind: "gfa-link" as const }];
    const homologs = classifyGfaScaffolds(["Chr01g1", "Unplaced"]);

    expect([...layoutGfaNodesForCuration(nodes, edges, homologs)]).toEqual([
      ...layoutGfaNodesForCuration(nodes, edges, homologs),
    ]);
  });

  it("packs disconnected unanchored nodes to the right of every chromosome row", () => {
    const placed = { id: "placed", groupId: "Chr01g1", order: 1 };
    const unplaced = Array.from({ length: 100 }, (_, index) => ({
      id: `unplaced-${index}`,
      groupId: "Unplaced",
      order: index,
    }));
    const nodes = [placed, ...unplaced];
    const homologs = classifyGfaScaffolds(["Chr01g1", "Unplaced"]);
    const positions = layoutGfaNodesForCuration(nodes, [], homologs);
    const values = unplaced.map((node) => positions.get(node.id)!);

    expect(Math.min(...values.map((point) => point.x))).toBeGreaterThan(positions.get("placed")!.x + 900);
    expect(Math.max(...values.map((point) => point.x)) - Math.min(...values.map((point) => point.x))).toBeGreaterThan(300);
    expect(Math.max(...values.map((point) => point.y)) - Math.min(...values.map((point) => point.y))).toBeGreaterThan(30);
  });

  it("keeps a proportional blank zone before disconnected utgs on long chromosomes", () => {
    const placed = Array.from({ length: 240 }, (_, index) => ({
      id: `placed-${index}`,
      groupId: "Chr01g1",
      order: index,
    }));
    const island = { id: "island", groupId: "Unplaced", order: 241 };
    const homologs = classifyGfaScaffolds(["Chr01g1", "Unplaced"]);
    const positions = layoutGfaNodesForCuration([...placed, island], [], homologs);
    const placedX = placed.map((node) => positions.get(node.id)!.x);
    const placedSpan = Math.max(...placedX) - Math.min(...placedX);
    const blankZone = positions.get("island")!.x - Math.max(...placedX);

    expect(blankZone).toBeGreaterThan(placedSpan * 0.2);
  });

  it("places only single-homolog components beside their group and separates ambiguous and disconnected evidence", () => {
    const nodes = [
      { id: "chr1", groupId: "Chr01g1", order: 1 },
      { id: "chr2", groupId: "Chr02g1", order: 2 },
      { id: "u1", groupId: "Unplaced", order: 3 },
      { id: "u2", groupId: "Unplaced", order: 4 },
      { id: "cross", groupId: "Unplaced", order: 5 },
      { id: "island", groupId: "Unplaced", order: 6 },
    ];
    const homologs = classifyGfaScaffolds(["Chr01g1", "Chr02g1", "Unplaced"]);
    const positions = layoutGfaNodesForCuration(nodes, [
      { source: "u1", target: "u2", kind: "gfa-link" },
      { source: "u1", target: "chr2", kind: "gfa-link" },
      { source: "u2", target: "chr2", kind: "gfa-link" },
      { source: "cross", target: "chr1", kind: "gfa-link" },
      { source: "cross", target: "chr2", kind: "gfa-link" },
    ], homologs);

    const componentY = (positions.get("u1")!.y + positions.get("u2")!.y) / 2;
    expect(Math.abs(componentY - positions.get("chr2")!.y)).toBeLessThan(
      Math.abs(componentY - positions.get("chr1")!.y),
    );
    expect(positions.get("u1")!.x).toBeLessThan(positions.get("cross")!.x);
    expect(positions.get("island")!.x - positions.get("cross")!.x).toBeGreaterThan(600);
  });

  it("uses full-graph evidence to keep a viewport-truncated cross-group component neutral", () => {
    const visibleNodes = [
      { id: "chr1", groupId: "Chr01g1", order: 1 },
      { id: "cross", groupId: "Unplaced", order: 2 },
    ];
    const evidenceNodes = [
      ...visibleNodes,
      { id: "chr2", groupId: "Chr02g1", order: 3 },
    ];
    const visibleEdges = [
      { source: "cross", target: "chr1", kind: "gfa-link" as const },
    ];
    const evidenceEdges = [
      ...visibleEdges,
      { source: "cross", target: "chr2", kind: "gfa-link" as const },
    ];
    const homologs = classifyGfaScaffolds(["Chr01g1", "Chr02g1", "Unplaced"]);
    const localOnly = layoutGfaNodesForCuration(visibleNodes, visibleEdges, homologs);
    const fullEvidence = layoutGfaNodesForCuration(
      visibleNodes,
      visibleEdges,
      homologs,
      evidenceNodes,
      evidenceEdges,
    );

    expect(fullEvidence.get("cross")!.x - fullEvidence.get("chr1")!.x).toBeGreaterThan(
      localOnly.get("cross")!.x - localOnly.get("chr1")!.x + 100,
    );
  });
});
