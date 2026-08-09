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
      },
    ]);
    expect(layout.totalSpan).toBe(330);
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
});
