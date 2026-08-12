import { describe, expect, it } from "vitest";
import { buildGfaAssemblyGraph, parseGfaText } from "./gfa";

describe("GFA evidence import", () => {
  it("parses hifiasm S/L/A records and canonicalizes reverse-equivalent links", () => {
    const document = parseGfaText([
      "S\ta\t*\tLN:i:100\trd:i:12",
      "S\tb\tACGT\trd:i:9",
      "A\ta\t0\t+\tread1\t0\t90\tid:i:1\tHG:A:p",
      "L\ta\t+\tb\t-\t20M",
      "L\tb\t+\ta\t-\t20M",
    ].join("\n"), "test.gfa");

    expect(document.fileName).toBe("test.gfa");
    expect(document.summary).toMatchObject({ segmentCount: 2, linkCount: 1, aRecordCount: 1 });
    expect(document.segments.a).toMatchObject({ length: 100, readDepth: 12, aRecordCount: 1 });
    expect(document.segments.a.haplotypeCounts.p).toBe(1);
    expect(document.segments.b).toMatchObject({ length: 4, hasSequence: true });
    expect(document.links[0]).toMatchObject({
      from: { segmentName: "a", side: "end" },
      to: { segmentName: "b", side: "end" },
      overlap: "20M",
    });
  });

  it("organizes placed nodes by AGP and distinguishes joined and gapped junctions", () => {
    const document = parseGfaText([
      "S\ta\t*\tLN:i:100",
      "S\tb\t*\tLN:i:100",
      "S\tc\t*\tLN:i:100",
      "L\ta\t+\tc\t+\t10M",
    ].join("\n"));
    const graph = buildGfaAssemblyGraph(document, [
      { id: "a1", objectId: "Chr01", sourceId: "a", sourceStart: 0, sourceEnd: 100, visualStart: 0, visualEnd: 100, orientation: "+", assemblyBlockId: "Chr01_block_1" },
      { id: "b1", objectId: "Chr01", sourceId: "b", sourceStart: 0, sourceEnd: 100, visualStart: 100, visualEnd: 200, orientation: "+", assemblyBlockId: "Chr01_block_1" },
      { id: "c1", objectId: "Chr01", sourceId: "c", sourceStart: 0, sourceEnd: 100, visualStart: 300, visualEnd: 400, orientation: "+", gapBefore: { componentType: "U", length: 100, gapType: "scaffold", linkage: "yes", linkageEvidence: "map" } },
    ]);

    expect(graph.groupOrder).toEqual(["Chr01"]);
    expect(graph.edges.map((edge) => edge.kind)).toEqual([
      "agp-joined",
      "agp-gap",
      "gfa-link",
    ]);
    expect(graph.matchedSegmentCount).toBe(3);
    expect(graph.unmatchedSegmentCount).toBe(0);
    expect(graph.nodes.find((node) => node.id === "a1")?.assemblyBlockId).toBe("Chr01_block_1");
    expect(graph.nodes.find((node) => node.id === "a1")?.length).toBe(100);
  });

  it("keeps graph-only segments in an Unplaced group", () => {
    const document = parseGfaText("S\ta\t*\tLN:i:100\nS\tb\t*\tLN:i:80");
    const graph = buildGfaAssemblyGraph(document, [
      { id: "a1", objectId: "Chr01", sourceId: "a", sourceStart: 0, sourceEnd: 100, visualStart: 0, visualEnd: 100, orientation: "+" },
    ]);

    expect(graph.groupOrder).toEqual(["Chr01", "Unplaced"]);
    expect(graph.nodes.find((node) => node.segmentName === "b")?.kind).toBe("unplaced");
    expect(graph.nodes.find((node) => node.segmentName === "b")?.length).toBe(80);
    expect(graph.unmatchedSegmentCount).toBe(1);
  });

  it("uses the current AGP occurrence interval instead of GFA LN for placed node length", () => {
    const document = parseGfaText("S\ta\t*\tLN:i:1000");
    const graph = buildGfaAssemblyGraph(document, [
      { id: "a-slice", objectId: "Chr01g1", sourceId: "a", sourceStart: 100, sourceEnd: 340, visualStart: 0, visualEnd: 240, orientation: "+" },
    ]);

    expect(graph.nodes[0].length).toBe(240);
  });
});
