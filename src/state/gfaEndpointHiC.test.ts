import { describe, expect, it } from "vitest";
import type { ContactMapTile } from "../App";
import {
  physicalSideForDisplayedEndpoint,
  planGfaEndpointHiCQuery,
  scoreGfaEndpointHiC,
} from "./gfaEndpointHiC";
import type { ContactMapLayoutBlock } from "./importers";

function block(
  id: string,
  visualStart: number,
  length: number,
  orientation: ContactMapLayoutBlock["orientation"] = "+",
): ContactMapLayoutBlock {
  return {
    id,
    objectId: "Chr01g1",
    sourceId: id,
    sourceStart: 0,
    sourceEnd: length,
    visualStart,
    visualEnd: visualStart + length,
    orientation,
  };
}

describe("endpoint-level GFA Hi-C", () => {
  it("plans only tiles intersecting the four terminal windows", () => {
    const plan = planGfaEndpointHiCQuery(
      block("a", 0, 5_000_000),
      block("b", 20_000_000, 4_000_000),
      [1_000, 5_000, 10_000, 25_000],
      256,
    );

    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;
    expect(plan).toMatchObject({
      sourceResolution: 25_000,
      targetResolution: 25_000,
      sourceWindows: {
        left: { startBp: 0, endBp: 500_000 },
        right: { startBp: 4_500_000, endBp: 5_000_000 },
      },
      targetWindows: {
        left: { startBp: 20_000_000, endBp: 20_500_000 },
        right: { startBp: 23_500_000, endBp: 24_000_000 },
      },
    });
    expect(plan.tiles.length).toBeLessThanOrEqual(4);
  });

  it("refuses to manufacture endpoint precision from coarse bins", () => {
    const plan = planGfaEndpointHiCQuery(
      block("short", 0, 100_000),
      block("long", 1_000_000, 2_000_000),
      [25_000],
    );

    expect(plan).toMatchObject({ status: "unresolved", resolution: 25_000 });
    if (plan.status === "unresolved") {
      expect(plan.reason).toContain("cannot separate both displayed ends");
    }
  });

  it("scores all four quadrants and keeps matrix symmetry", () => {
    const plan = planGfaEndpointHiCQuery(
      block("a", 0, 1_000_000),
      block("b", 2_000_000, 1_000_000),
      [100_000],
      256,
    );
    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;
    const tile: ContactMapTile = {
      tileX: 0,
      tileY: 0,
      cells: [
        { xBin: 0, yBin: 20, count: 5 },
        { xBin: 0, yBin: 29, count: 8 },
        // Reversed coordinates must still contribute to source-right/target-left.
        { xBin: 20, yBin: 9, count: 20 },
        { xBin: 9, yBin: 29, count: 4 },
      ],
    };
    const evidence = scoreGfaEndpointHiC(plan, [tile]);

    expect(evidence.complete).toBe(true);
    expect(evidence.quadrants.map((quadrant) => quadrant.rawCount)).toEqual([5, 8, 20, 4]);
    expect(evidence.bestQuadrant).toMatchObject({
      sourceEndpoint: "right",
      targetEndpoint: "left",
      rawCount: 20,
    });
    expect(evidence.contrastToNext).toBeCloseTo(2.5);
    expect(evidence.observedCellCount).toBe(4);
  });

  it("weights bins that only partially overlap a terminal window", () => {
    const source = block("a", 25_000, 200_000);
    const target = block("b", 425_000, 200_000);
    const plan = planGfaEndpointHiCQuery(source, target, [10_000], 256);
    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;
    const evidence = scoreGfaEndpointHiC(plan, [{
      tileX: 0,
      tileY: 0,
      cells: [{ xBin: 2, yBin: 42, count: 10 }],
    }]);

    // Both windows begin halfway through their bins: 10 * 0.5 * 0.5.
    expect(evidence.quadrants[0].rawCount).toBeCloseTo(2.5);
  });

  it("maps displayed endpoints back to physical GFA segment sides", () => {
    expect(physicalSideForDisplayedEndpoint("+", "left")).toBe("start");
    expect(physicalSideForDisplayedEndpoint("+", "right")).toBe("end");
    expect(physicalSideForDisplayedEndpoint("-", "left")).toBe("end");
    expect(physicalSideForDisplayedEndpoint("-", "right")).toBe("start");
    expect(physicalSideForDisplayedEndpoint("?", "left")).toBeNull();
  });
});
