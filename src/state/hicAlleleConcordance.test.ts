import { describe, expect, it } from "vitest";
import type { ContactMapView } from "../App";
import {
  buildHiCAlleleConcordance,
  buildHiCTransLineCandidates,
  planHiCAlleleConcordanceQuery,
  scoreHiCAlleleConcordanceQuery,
} from "./hicAlleleConcordance";
import type { ContactMapLayoutBlock } from "./importers";
import { syntenyAllelePairKey } from "./syntenyAllelePruning";

function block(
  id: string,
  objectId: string,
  visualStart: number,
  length = 5_000,
): ContactMapLayoutBlock {
  return {
    id,
    objectId,
    sourceId: id,
    sourceStart: 0,
    sourceEnd: length,
    visualStart,
    visualEnd: visualStart + length,
    orientation: "+",
  };
}

function contactMap(
  blocks: ContactMapLayoutBlock[],
  cells: ContactMapView["cells"],
  normalization: ContactMapView["normalization"] = "raw",
): ContactMapView {
  return {
    resolution: 100,
    normalization,
    viewport: { xStart: 0, xEnd: 10_000, yStart: 0, yEnd: 10_000 },
    cells,
    layoutBlocks: blocks,
    visibleLayerComplete: true,
  };
}

describe("binned Hi-C allele concordance", () => {
  it("plans and scores a bounded raw full-contig rectangle", () => {
    const blocks = [block("a", "Chr01g1", 0), block("b", "Chr01g2", 5_000)];
    const plan = planHiCAlleleConcordanceQuery(blocks[0], blocks[1], [10, 100]);
    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;
    expect(plan.targetResolution).toBe(100);
    expect(plan.tiles).toEqual([{ tileX: 0, tileY: 0 }]);

    const scored = scoreHiCAlleleConcordanceQuery(plan, [{
      tileX: 0,
      tileY: 0,
      cells: Array.from({ length: 10 }, (_, index) => ({
        xBin: index,
        yBin: 50 + index,
        count: 2,
      })),
    }]);

    expect(scored.status).toBe("ready");
    if (scored.status !== "ready") return;
    expect(scored.complete).toBe(true);
    expect(scored.result.pairs[0]).toMatchObject({
      leftBlockId: "a",
      rightBlockId: "b",
      concordanceRatio: 1,
      supportUnit: "raw-contact-weight",
    });
  });

  it("identifies a distributed parallel coordinate mode and masks the allelic link", () => {
    const blocks = [block("a", "Chr01g1", 0), block("b", "Chr01g2", 5_000)];
    const cells = Array.from({ length: 10 }, (_, index) => ({
      xBin: index,
      yBin: 50 + index,
      count: 2,
    }));

    const result = buildHiCAlleleConcordance(contactMap(blocks, cells), blocks);

    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]).toMatchObject({
      leftBlockId: "a",
      rightBlockId: "b",
      orientation: "parallel",
      support: 20,
      supportUnit: "raw-contact-weight",
      coveredShorterWindowCount: 10,
    });
    expect(result.pairs[0].concordanceRatio).toBeCloseTo(1);
    expect(result.maskByPair.get(syntenyAllelePairKey("a", "b"))).toMatchObject({
      factor: 0,
      reason: "hic-concordance",
    });
  });

  it("identifies the y+x mode for oppositely oriented allelic contacts", () => {
    const blocks = [block("a", "Chr01g1", 0), block("b", "Chr01g2", 5_000)];
    const cells = Array.from({ length: 10 }, (_, index) => ({
      xBin: index,
      yBin: 99 - index,
      count: 2,
    }));

    const result = buildHiCAlleleConcordance(contactMap(blocks, cells), blocks);

    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0].orientation).toBe("antiparallel");
    expect(result.pairs[0].concordanceRatio).toBeCloseTo(1);
  });

  it("rejects dispersed contacts and a single unresolved hotspot", () => {
    const blocks = [block("a", "Chr01g1", 0), block("b", "Chr01g2", 5_000)];
    const dispersed = Array.from({ length: 20 }, (_, index) => ({
      xBin: index,
      yBin: 50 + ((index * 7) % 50),
      count: 1,
    }));
    const hotspot = [{ xBin: 0, yBin: 50, count: 100 }];

    expect(buildHiCAlleleConcordance(
      contactMap(blocks, dispersed),
      blocks,
    ).pairs).toEqual([]);
    expect(buildHiCAlleleConcordance(
      contactMap(blocks, hotspot),
      blocks,
    ).pairs).toEqual([]);
  });

  it("does not infer alleles from split/copy occurrences of the same source", () => {
    const first = { ...block("a-1", "Chr01g1", 0), sourceId: "shared" };
    const second = { ...block("a-2", "Chr01g2", 5_000), sourceId: "shared" };
    const blocks = [first, second];
    const cells = Array.from({ length: 10 }, (_, index) => ({
      xBin: index,
      yBin: 50 + index,
      count: 2,
    }));

    const result = buildHiCAlleleConcordance(contactMap(blocks, cells), blocks);

    expect(result.examinedPairCount).toBe(0);
    expect(result.pairs).toEqual([]);
  });

  it("reports balanced matrix evidence as normalized contact weight", () => {
    const blocks = [block("a", "Chr01g1", 0), block("b", "Chr01g2", 5_000)];
    const cells = Array.from({ length: 10 }, (_, index) => ({
      xBin: index,
      yBin: 50 + index,
      count: 2,
    }));

    const result = buildHiCAlleleConcordance(
      contactMap(blocks, cells, "kr"),
      blocks,
    );

    expect(result.pairs[0]?.supportUnit).toBe("normalized-contact-weight");
  });

  it("projects a distributed cross-object h-trans line into contig candidates", () => {
    const blocks = [
      block("a1", "Homolog-A", 0, 2_500),
      block("a2", "Homolog-A", 2_500, 2_500),
      block("b1", "Homolog-B", 5_000, 2_500),
      block("b2", "Homolog-B", 7_500, 2_500),
    ];
    const cells = Array.from({ length: 50 }, (_, index) => ({
      xBin: index,
      yBin: 50 + index,
      count: 3,
    }));

    const result = buildHiCTransLineCandidates(
      contactMap(blocks, cells),
      blocks,
      new Set(["a1"]),
    );

    expect(result.objectLines).toHaveLength(1);
    expect(result.objectLines[0]).toMatchObject({
      leftObjectId: "Homolog-A",
      rightObjectId: "Homolog-B",
      orientation: "parallel",
      mode: 0,
    });
    expect(result.requests.map((request) => request.targetBlockId)).toContain("b1");
    expect(result.requests.every((request) => request.expectedOrientation === "parallel"))
      .toBe(true);
    expect(result.requests.every((request) => !request.targetBlockId.startsWith("a")))
      .toBe(true);
  });

  it("does not promote a single cross-object boundary hotspot into a line", () => {
    const blocks = [block("a", "Homolog-A", 0), block("b", "Homolog-B", 5_000)];
    const result = buildHiCTransLineCandidates(
      contactMap(blocks, [{ xBin: 49, yBin: 50, count: 200 }]),
      blocks,
      new Set(["a"]),
    );

    expect(result.objectLines).toEqual([]);
    expect(result.requests).toEqual([]);
  });

  it("accepts a background-significant thin band below the classic 0.2 ratio", () => {
    const blocks = [block("a", "Homolog-A", 0), block("b", "Homolog-B", 5_000)];
    const lineCells = Array.from({ length: 30 }, (_, index) => ({
      xBin: index,
      yBin: 50 + index + (index % 3) - 1,
      count: 1,
    }));
    const backgroundCells = Array.from({ length: 120 }, (_, index) => {
      const xBin = index % 50;
      let targetWindow = (index * 17 + Math.floor(index / 50) * 11) % 50;
      if (Math.abs(targetWindow - xBin) <= 2) {
        targetWindow = (targetWindow + 9) % 50;
      }
      return { xBin, yBin: 50 + targetWindow, count: 1 };
    });
    const plan = planHiCAlleleConcordanceQuery(
      blocks[0],
      blocks[1],
      [100],
      256,
      50,
      { expectedOrientation: "parallel" },
    );
    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;
    const scored = scoreHiCAlleleConcordanceQuery(plan, [{
      tileX: 0,
      tileY: 0,
      cells: [...lineCells, ...backgroundCells],
    }]);

    expect(scored.status).toBe("ready");
    if (scored.status !== "ready") return;
    expect(scored.result.pairs[0]?.concordanceRatio).toBeLessThanOrEqual(0.2);
    expect(scored.result.pairs[0]).toMatchObject({
      evidenceModel: "trans-line",
      lineOrientation: "parallel",
      expectedOrientation: "parallel",
      confidence: "high",
    });
    expect(scored.result.pairs[0]?.lineZScore).toBeGreaterThanOrEqual(4);
    expect(scored.result.pairs[0]?.lineReciprocalCoverage).toBeGreaterThanOrEqual(0.2);
    expect(scored.result.pairs[0]?.lineEffectiveWindowFraction).toBeGreaterThanOrEqual(0.1);
  });

  it("rejects a significant thin band confined to one local contig boundary", () => {
    const blocks = [block("a", "Homolog-A", 0), block("b", "Homolog-B", 5_000)];
    const localLineCells = Array.from({ length: 4 }, (_, index) => ({
      xBin: index,
      yBin: 50 + index,
      count: 7,
    }));
    const backgroundCells = Array.from({ length: 120 }, (_, index) => {
      const xBin = index % 50;
      let targetWindow = (index * 17 + Math.floor(index / 50) * 11) % 50;
      if (Math.abs(targetWindow - xBin) <= 2) {
        targetWindow = (targetWindow + 9) % 50;
      }
      return { xBin, yBin: 50 + targetWindow, count: 1 };
    });
    const plan = planHiCAlleleConcordanceQuery(
      blocks[0],
      blocks[1],
      [100],
      256,
      50,
      { expectedOrientation: "parallel" },
    );
    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;
    const scored = scoreHiCAlleleConcordanceQuery(plan, [{
      tileX: 0,
      tileY: 0,
      cells: [...localLineCells, ...backgroundCells],
    }]);

    expect(scored.status).toBe("ready");
    if (scored.status !== "ready") return;
    expect(scored.result.pairs).toEqual([]);
  });

  it("keeps a distributed but shorter Hi-C line as supported review evidence", () => {
    const blocks = [block("a", "Homolog-A", 0), block("b", "Homolog-B", 5_000)];
    const localLineCells = Array.from({ length: 6 }, (_, index) => ({
      xBin: index,
      yBin: 50 + index,
      count: 5,
    }));
    const backgroundCells = Array.from({ length: 120 }, (_, index) => {
      const xBin = index % 50;
      let targetWindow = (index * 17 + Math.floor(index / 50) * 11) % 50;
      if (Math.abs(targetWindow - xBin) <= 2) {
        targetWindow = (targetWindow + 9) % 50;
      }
      return { xBin, yBin: 50 + targetWindow, count: 1 };
    });
    const plan = planHiCAlleleConcordanceQuery(
      blocks[0],
      blocks[1],
      [100],
      256,
      50,
      { expectedOrientation: "parallel" },
    );
    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;
    const scored = scoreHiCAlleleConcordanceQuery(plan, [{
      tileX: 0,
      tileY: 0,
      cells: [...localLineCells, ...backgroundCells],
    }]);

    expect(scored.status).toBe("ready");
    if (scored.status !== "ready") return;
    expect(scored.result.pairs[0]).toMatchObject({
      evidenceModel: "trans-line",
      confidence: "supported",
    });
    expect(scored.result.maskByPair.has(syntenyAllelePairKey("a", "b"))).toBe(false);
  });
});
