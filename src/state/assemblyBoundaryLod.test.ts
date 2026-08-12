import { describe, expect, it } from "vitest";
import type { AssemblyChromosome } from "./assemblyEditing";
import { buildAssemblyBoundaryBands } from "./assemblyBoundaryLod";

function chromosome(id: string, visualStart: number, visualEnd: number): AssemblyChromosome {
  return { id, visualStart, visualEnd, blockIds: [id] };
}

const chromosomes = [
  chromosome("Chr01", 0, 400),
  chromosome("Chr02", 400, 800),
  chromosome("unplaced-1", 800, 805),
  chromosome("unplaced-2", 805, 810),
  chromosome("unplaced-3", 810, 815),
  chromosome("unplaced-4", 815, 820),
];

describe("buildAssemblyBoundaryBands", () => {
  it("collapses consecutive sub-pixel assembly objects without merging major chromosomes", () => {
    const bands = buildAssemblyBoundaryBands(
      chromosomes,
      { xStart: 0, xEnd: 1_000 },
      100,
      3,
    );

    expect(bands.map((band) => band.objectIds)).toEqual([
      ["Chr01"],
      ["Chr02"],
      ["unplaced-1", "unplaced-2", "unplaced-3", "unplaced-4"],
    ]);
    expect(bands[2]).toMatchObject({
      visualStart: 800,
      visualEnd: 820,
      collapsed: true,
    });
  });

  it("restores individual object boundaries after zooming in", () => {
    const bands = buildAssemblyBoundaryBands(
      chromosomes,
      { xStart: 800, xEnd: 820 },
      100,
      3,
    );

    expect(bands.map((band) => band.objectIds)).toEqual([
      ["unplaced-1"],
      ["unplaced-2"],
      ["unplaced-3"],
      ["unplaced-4"],
    ]);
    expect(bands.every((band) => !band.collapsed)).toBe(true);
  });

  it("does not join compact objects across a visible coordinate gap", () => {
    const bands = buildAssemblyBoundaryBands([
      chromosome("a", 0, 1),
      chromosome("b", 20, 21),
    ], { xStart: 0, xEnd: 100 }, 100, 3);

    expect(bands.map((band) => band.objectIds)).toEqual([["a"], ["b"]]);
  });
});
