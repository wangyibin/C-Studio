import { describe, expect, it } from "vitest";
import {
  addChromosomeBoundariesToSelection,
  deleteGapsBetweenSelection,
  reverseSelection,
  splitContigAtVisualPosition,
} from "./assemblyEditing";
import { exportAgpText } from "./agpExport";
import { parseAgpLayout, type ContactMapLayoutBlock } from "./importers";

describe("exportAgpText", () => {
  it("serializes edited layout blocks as 9-column AGP component rows", () => {
    const blocks: ContactMapLayoutBlock[] = [
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
      {
        id: "Chr01:2:ctg2:right",
        objectId: "Chr01",
        sourceId: "ctg2",
        sourceStart: 60,
        sourceEnd: 150,
        visualStart: 100,
        visualEnd: 190,
        orientation: "-",
      },
      {
        id: "Chr02:1:ctg3:copy1",
        objectId: "Chr02",
        sourceId: "ctg3",
        sourceStart: 10,
        sourceEnd: 90,
        visualStart: 190,
        visualEnd: 270,
        orientation: "+",
      },
    ];

    expect(exportAgpText(blocks)).toBe(
      [
        "Chr01\t1\t100\t1\tW\tctg1\t1\t100\t+",
        "Chr01\t101\t190\t2\tW\tctg2\t61\t150\t-",
        "Chr02\t1\t80\t1\tW\tctg3\t11\t90\t+",
        "",
      ].join("\n"),
    );
  });

  it("exports an internal chromosome split as three independent AGP objects", () => {
    const blocks: ContactMapLayoutBlock[] = [1, 2, 3, 4].map((index) => ({
      id: `Chr01:${index}:ctg${index}`,
      objectId: "Chr01",
      sourceId: `ctg${index}`,
      sourceStart: 0,
      sourceEnd: 100,
      visualStart: (index - 1) * 100,
      visualEnd: index * 100,
      orientation: index % 2 === 0 ? "-" : "+",
    }));
    const bounded = addChromosomeBoundariesToSelection(blocks, {
      kind: "contigs",
      ids: ["Chr01:2:ctg2", "Chr01:3:ctg3"],
    });

    expect(exportAgpText(bounded)).toBe(
      [
        "Chr01\t1\t100\t1\tW\tctg1\t1\t100\t+",
        "Chr01_d2\t1\t100\t1\tW\tctg2\t1\t100\t-",
        "Chr01_d2\t101\t200\t2\tW\tctg3\t1\t100\t+",
        "Chr01_d3\t1\t100\t1\tW\tctg4\t1\t100\t-",
        "",
      ].join("\n"),
    );
  });

  it("round-trips component runs and exact N/U gap metadata", () => {
    const source = [
      "ChrA\t1\t10\t1\tW\tctg1\t11\t20\t+",
      "ChrA\t11\t20\t2\tF\tctg2\t21\t30\t-",
      "ChrA\t21\t25\t3\tN\t5\tscaffold\tno\tna",
      "ChrA\t26\t35\t4\tW\tctg3\t1\t10\t?",
      "ChrA\t36\t135\t5\tU\t100\tcontig\tyes\tmap",
      "ChrA\t136\t145\t6\tW\tctg4\t1\t10\t+",
      "ChrB\t1\t8\t1\tW\tctg5\t3\t10\t+",
    ].join("\n");

    const parsed = parseAgpLayout(source);
    const exported = exportAgpText(parsed.blocks);

    expect(exported).toBe(`${source}\n`);

    const reparsed = parseAgpLayout(exported);
    expect(reparsed.totalSpan).toBe(parsed.totalSpan);
    expect(reparsed.blocks).toEqual(parsed.blocks);
    expect(reparsed.blocks.map((block) => block.assemblyBlockId)).toEqual([
      "ChrA_block_1",
      "ChrA_block_1",
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("round-trips 0/na orientations and leaves them unchanged when reversing", () => {
    const source = [
      "ChrO\t1\t10\t1\tW\tctgZero\t11\t20\t0",
      "ChrO\t11\t20\t2\tF\tctgNa\t31\t40\tna",
    ].join("\n");
    const parsed = parseAgpLayout(source);

    expect(exportAgpText(parsed.blocks)).toBe(`${source}\n`);

    const reversed = reverseSelection(parsed.blocks, { kind: "chromosome", id: "ChrO" });
    expect(reversed.map((block) => [block.sourceId, block.orientation])).toEqual([
      ["ctgNa", "na"],
      ["ctgZero", "0"],
    ]);
    expect(exportAgpText(reversed)).toBe([
      "ChrO\t1\t10\t1\tF\tctgNa\t31\t40\tna",
      "ChrO\t11\t20\t2\tW\tctgZero\t11\t20\t0",
      "",
    ].join("\n"));
  });

  it("exports a split-contig gap and restores the original component when joined", () => {
    const imported = parseAgpLayout([
      "Chr01\t1\t100\t1\tW\tctgA\t1\t100\t+",
      "Chr01\t101\t200\t2\tW\tctgB\t1\t100\t+",
    ].join("\n"));
    const split = splitContigAtVisualPosition(imported.blocks, "Chr01:2:ctgB", 150);

    expect(exportAgpText(split)).toBe([
      "Chr01\t1\t100\t1\tW\tctgA\t1\t100\t+",
      "Chr01\t101\t150\t2\tW\tctgB\t1\t50\t+",
      "Chr01\t151\t250\t3\tU\t100\tcontig\tno\tna",
      "Chr01\t251\t300\t4\tW\tctgB\t51\t100\t+",
      "",
    ].join("\n"));

    const joined = deleteGapsBetweenSelection(split, {
      kind: "contigs",
      ids: ["Chr01_block_1", "Chr01:2:ctgB:right"],
    });
    expect(exportAgpText(joined)).toBe([
      "Chr01\t1\t100\t1\tW\tctgA\t1\t100\t+",
      "Chr01\t101\t200\t2\tW\tctgB\t1\t100\t+",
      "",
    ].join("\n"));
  });
});
