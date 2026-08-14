import { describe, expect, it } from "vitest";
import type { GfaGraphEdge, GfaGraphNode } from "./gfa";
import {
  buildGfaBandageLayoutRequest,
  gfaBandageLayoutUnitId,
  gfaBandageLayoutRequestKey,
  validatedGfaBandagePathMap,
} from "./gfaBandageLayout";

function node(id: string, orientation: GfaGraphNode["orientation"] = "+"): GfaGraphNode {
  return {
    id,
    occurrenceId: null,
    segmentName: id,
    groupId: "Unplaced",
    assemblyBlockId: null,
    kind: "unplaced",
    orientation,
    length: 100,
    order: 0,
    readDepth: null,
  };
}

describe("Rust GFA Bandage layout IPC", () => {
  it("sends every node and only valid GFA edges with physical endpoint defaults", () => {
    const nodes = [
      { ...node("a", "-"), groupId: "Chr01g1", assemblyBlockId: "block-1", order: 4 },
      { ...node("b"), groupId: "Chr01g1", assemblyBlockId: "block-1", order: 5 },
    ];
    const edges: GfaGraphEdge[] = [
      { id: "gfa", source: "a", target: "b", kind: "gfa-link" },
      { id: "agp", source: "a", target: "b", kind: "agp-joined" },
      { id: "outside", source: "a", target: "missing", kind: "gfa-link" },
    ];
    const request = buildGfaBandageLayoutRequest(
      nodes,
      edges,
      new Map([["a", 84], ["b", 120]]),
    );

    expect(request.nodes).toEqual([
      {
        id: "a",
        width: 84,
        orientation: "-",
        layoutUnitId: 'block:["Chr01g1","block-1"]',
        layoutOrder: 4,
      },
      {
        id: "b",
        width: 120,
        orientation: "+",
        layoutUnitId: 'block:["Chr01g1","block-1"]',
        layoutOrder: 5,
      },
    ]);
    expect(request.edges).toEqual([{
      source: "a",
      target: "b",
      sourceSide: "end",
      targetSide: "start",
    }]);
  });

  it("keys topology, endpoint directions, widths, and explicit relayout revision", () => {
    const first = {
      nodes: [{
        id: "a",
        width: 84,
        orientation: "+" as const,
        layoutUnitId: "unitig:a",
        layoutOrder: 0,
      }],
      edges: [] as Array<{
        source: string;
        target: string;
        sourceSide: "start" | "end";
        targetSide: "start" | "end";
      }>,
    };

    expect(gfaBandageLayoutRequestKey(first, 1)).not.toBe(
      gfaBandageLayoutRequestKey(first, 2),
    );
    expect(gfaBandageLayoutRequestKey(first, 1)).not.toBe(
      gfaBandageLayoutRequestKey({
        ...first,
        nodes: [{ ...first.nodes[0], width: 85 }],
      }, 1),
    );
  });

  it("scopes one composite layout unit to chromosome plus assembly block", () => {
    expect(gfaBandageLayoutUnitId({
      id: "a",
      groupId: "Chr01g1",
      assemblyBlockId: "block-1",
    })).toBe('block:["Chr01g1","block-1"]');
    expect(gfaBandageLayoutUnitId({
      id: "copy",
      groupId: "Chr01g2",
      assemblyBlockId: "block-1",
    })).not.toBe('block:["Chr01g1","block-1"]');
    expect(gfaBandageLayoutUnitId({
      id: "free",
      groupId: "Unplaced",
      assemblyBlockId: null,
    })).toBe("unitig:free");
  });

  it("rejects partial or non-finite native responses", () => {
    const expected = new Set(["a", "b"]);

    expect(() => validatedGfaBandagePathMap({
      algorithm: "cstudio-rust-multilevel-v1",
      paths: [{ id: "a", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }],
    }, expected)).toThrow("returned 1 of 2");
    expect(() => validatedGfaBandagePathMap({
      algorithm: "cstudio-rust-multilevel-v1",
      paths: [
        { id: "a", points: [{ x: 0, y: 0 }, { x: Number.NaN, y: 0 }] },
        { id: "b", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] },
      ],
    }, expected)).toThrow("returned 1 of 2");
  });
});
