import { describe, expect, it } from "vitest";
import { addChromosomeBoundariesToSelection } from "./assemblyEditing";
import { exportAgpText } from "./agpExport";
import type { ContactMapLayoutBlock } from "./importers";

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
});
