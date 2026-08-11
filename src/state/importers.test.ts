import { describe, expect, it } from "vitest";
import { normalizeImportedAgpLayout, parseAgpLayout, summarizeAgpText } from "./importers";

describe("summarizeAgpText", () => {
  it("summarizes AGP components and gaps", () => {
    const summary = summarizeAgpText(
      [
        "Chr01\t1\t100\t1\tW\tctg1\t1\t100\t+",
        "Chr01\t101\t200\t2\tU\t100\tcontig\tyes\tmap",
        "Chr02\t1\t50\t1\tW\tctg2\t1\t50\t-",
      ].join("\n"),
    );

    expect(summary).toEqual({
      lineCount: 3,
      objectCount: 2,
      componentCount: 2,
      gapCount: 1,
      maxObjectSpan: 200,
    });
  });
});

describe("parseAgpLayout", () => {
  it("builds visual layout blocks from contig-level AGP components", () => {
    const layout = parseAgpLayout(
      [
        "Chr01\t1\t100\t1\tW\tctg1\t1\t100\t+",
        "Chr01\t101\t150\t2\tU\t50\tcontig\tyes\tmap",
        "Chr01\t151\t250\t3\tW\tctg2\t1\t100\t-",
        "Chr02\t1\t80\t1\tW\tctg3\t11\t90\t+",
      ].join("\n"),
    );

    expect(layout.blocks).toEqual([
      {
        id: "Chr01:1:ctg1",
        objectId: "Chr01",
        sourceId: "ctg1",
        sourceStart: 0,
        sourceEnd: 100,
        visualStart: 0,
        visualEnd: 100,
        orientation: "+",
        componentType: "W",
      },
      {
        id: "Chr01:3:ctg2",
        objectId: "Chr01",
        sourceId: "ctg2",
        sourceStart: 0,
        sourceEnd: 100,
        visualStart: 150,
        visualEnd: 250,
        orientation: "-",
        componentType: "W",
        gapBefore: {
          componentType: "U",
          length: 50,
          gapType: "contig",
          linkage: "yes",
          linkageEvidence: "map",
        },
      },
      {
        id: "Chr02:1:ctg3",
        objectId: "Chr02",
        sourceId: "ctg3",
        sourceStart: 10,
        sourceEnd: 90,
        visualStart: 250,
        visualEnd: 330,
        orientation: "+",
        componentType: "W",
      },
    ]);
    expect(layout.totalSpan).toBe(330);
  });

  it("groups maximal no-gap component runs and leaves singleton runs unwrapped", () => {
    const layout = parseAgpLayout(
      [
        "ChrA\t1\t40\t1\tW\tctg1\t5\t44\t+",
        "ChrA\t41\t70\t2\tF\tctg2\t11\t40\t-",
        "ChrA\t71\t95\t3\tN\t25\tscaffold\tno\tna",
        "ChrA\t96\t115\t4\tW\tctg3\t1\t20\t+",
        "ChrA\t116\t135\t5\tW\tctg4\t1\t20\t+",
        "ChrA\t136\t235\t6\tU\t100\tcontig\tyes\tmap",
        "ChrA\t236\t245\t7\tW\tctg5\t1\t10\t?",
        "ChrB\t1\t10\t1\tW\tctg6\t1\t10\t+",
      ].join("\n"),
    );

    expect(layout.blocks.map((block) => ({
      sourceId: block.sourceId,
      componentType: block.componentType,
      assemblyBlockId: block.assemblyBlockId,
      gapBefore: block.gapBefore,
      sourceInterval: [block.sourceStart, block.sourceEnd],
      visualInterval: [block.visualStart, block.visualEnd],
    }))).toEqual([
      {
        sourceId: "ctg1",
        componentType: "W",
        assemblyBlockId: "ChrA_block_1",
        gapBefore: undefined,
        sourceInterval: [4, 44],
        visualInterval: [0, 40],
      },
      {
        sourceId: "ctg2",
        componentType: "F",
        assemblyBlockId: "ChrA_block_1",
        gapBefore: undefined,
        sourceInterval: [10, 40],
        visualInterval: [40, 70],
      },
      {
        sourceId: "ctg3",
        componentType: "W",
        assemblyBlockId: "ChrA_block_2",
        gapBefore: {
          componentType: "N",
          length: 25,
          gapType: "scaffold",
          linkage: "no",
          linkageEvidence: "na",
        },
        sourceInterval: [0, 20],
        visualInterval: [95, 115],
      },
      {
        sourceId: "ctg4",
        componentType: "W",
        assemblyBlockId: "ChrA_block_2",
        gapBefore: undefined,
        sourceInterval: [0, 20],
        visualInterval: [115, 135],
      },
      {
        sourceId: "ctg5",
        componentType: "W",
        assemblyBlockId: undefined,
        gapBefore: {
          componentType: "U",
          length: 100,
          gapType: "contig",
          linkage: "yes",
          linkageEvidence: "map",
        },
        sourceInterval: [0, 10],
        visualInterval: [235, 245],
      },
      {
        sourceId: "ctg6",
        componentType: "W",
        assemblyBlockId: undefined,
        gapBefore: undefined,
        sourceInterval: [0, 10],
        visualInterval: [245, 255],
      },
    ]);
    expect(layout.totalSpan).toBe(255);
  });

  it("preserves deprecated unknown and irrelevant AGP orientations", () => {
    const layout = parseAgpLayout([
      "ChrO\t1\t10\t1\tW\tctgZero\t11\t20\t0",
      "ChrO\t11\t20\t2\tF\tctgNa\t31\t40\tna",
    ].join("\n"));

    expect(layout.blocks.map((block) => block.orientation)).toEqual(["0", "na"]);
  });
});

describe("normalizeImportedAgpLayout", () => {
  it("fills frontend-only block fields from Tauri example dataset blocks", () => {
    const layout = normalizeImportedAgpLayout({
      totalSpan: 150,
      blocks: [
        {
          id: "Chr01:1:ctg1",
          sourceId: "ctg1",
          sourceStart: 0,
          sourceEnd: 100,
          visualStart: 50,
          orientation: "+",
        },
      ],
    });

    expect(layout).toEqual({
      totalSpan: 150,
      blocks: [
        {
          id: "Chr01:1:ctg1",
          objectId: "Chr01",
          sourceId: "ctg1",
          sourceStart: 0,
          sourceEnd: 100,
          visualStart: 50,
          visualEnd: 150,
          orientation: "+",
        },
      ],
    });
  });

  it("sanitizes incomplete imported blocks before backend contact-map requests", () => {
    const layout = normalizeImportedAgpLayout({
      totalSpan: Number.NaN,
      blocks: [
        {
          id: "Chr01:1:ctg1",
          sourceId: "ctg1",
          sourceStart: Number.NaN,
          sourceEnd: 100,
          visualStart: Number.NaN,
          visualEnd: Number.NaN,
          orientation: "+",
        },
      ],
    });

    expect(layout).toEqual({
      totalSpan: 100,
      blocks: [
        {
          id: "Chr01:1:ctg1",
          objectId: "Chr01",
          sourceId: "ctg1",
          sourceStart: 0,
          sourceEnd: 100,
          visualStart: 0,
          visualEnd: 100,
          orientation: "+",
        },
      ],
    });
  });

  it("infers gaps from visual spacing, preserves supplied metadata, and groups no-gap runs", () => {
    const layout = normalizeImportedAgpLayout({
      totalSpan: 245,
      blocks: [
        {
          id: "ChrA:1:ctg1",
          objectId: "ChrA",
          sourceId: "ctg1",
          sourceStart: 0,
          sourceEnd: 40,
          visualStart: 0,
          orientation: "+",
          componentType: "W",
        },
        {
          id: "ChrA:2:ctg2",
          objectId: "ChrA",
          sourceId: "ctg2",
          sourceStart: 0,
          sourceEnd: 30,
          visualStart: 40,
          orientation: "+",
          componentType: "F",
        },
        {
          id: "ChrA:4:ctg3",
          objectId: "ChrA",
          sourceId: "ctg3",
          sourceStart: 0,
          sourceEnd: 20,
          visualStart: 95,
          orientation: "+",
        },
        {
          id: "ChrA:5:ctg4",
          objectId: "ChrA",
          sourceId: "ctg4",
          sourceStart: 0,
          sourceEnd: 20,
          visualStart: 115,
          orientation: "+",
        },
        {
          id: "ChrA:7:ctg5",
          objectId: "ChrA",
          sourceId: "ctg5",
          sourceStart: 0,
          sourceEnd: 10,
          visualStart: 235,
          orientation: "+",
          gapBefore: {
            componentType: "U",
            length: 100,
            gapType: "contig",
            linkage: "yes",
            linkageEvidence: "map",
          },
        },
      ],
    });

    expect(layout.blocks.map((block) => block.assemblyBlockId)).toEqual([
      "ChrA_block_1",
      "ChrA_block_1",
      "ChrA_block_2",
      "ChrA_block_2",
      undefined,
    ]);
    expect(layout.blocks[2]?.gapBefore).toEqual({
      componentType: "N",
      length: 25,
      gapType: "contig",
      linkage: "no",
      linkageEvidence: "na",
    });
    expect(layout.blocks[4]?.gapBefore).toEqual({
      componentType: "U",
      length: 100,
      gapType: "contig",
      linkage: "yes",
      linkageEvidence: "map",
    });
    expect(layout.blocks[1]?.componentType).toBe("F");
  });
});
