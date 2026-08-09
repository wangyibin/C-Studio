import { describe, expect, it } from "vitest";
import {
  buildAssemblyEditModel,
  contigIdsInScreenSelection,
  groupAssemblyBlocksByChromosome,
  hitTestAssemblyLayout,
  insertionTargetAtScreenPoint,
  isContigSelected,
  copySelection,
  copySelectionBefore,
  addChromosomeBoundariesToSelection,
  moveSelectionBefore,
  moveSelectionToDebris,
  reverseSelection,
  selectChromosome,
  selectContig,
  selectContigs,
  splitContigAtVisualPosition,
} from "./assemblyEditing";
import type { ContactMapLayoutBlock } from "./importers";

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
    id: "Chr01:2:ctg2",
    objectId: "Chr01",
    sourceId: "ctg2",
    sourceStart: 0,
    sourceEnd: 150,
    visualStart: 100,
    visualEnd: 250,
    orientation: "-",
  },
  {
    id: "Chr02:1:ctg3",
    objectId: "Chr02",
    sourceId: "ctg3",
    sourceStart: 0,
    sourceEnd: 80,
    visualStart: 250,
    visualEnd: 330,
    orientation: "+",
  },
];

describe("assemblyEditing", () => {
  it("builds chromosome boundaries from AGP object ids", () => {
    const model = buildAssemblyEditModel(blocks);

    expect(model.chromosomes).toEqual([
      { id: "Chr01", visualStart: 0, visualEnd: 250, blockIds: ["Chr01:1:ctg1", "Chr01:2:ctg2"] },
      { id: "Chr02", visualStart: 250, visualEnd: 330, blockIds: ["Chr02:1:ctg3"] },
    ]);
  });

  it("groups contigs by chromosome and tracks selected counts", () => {
    const model = buildAssemblyEditModel(blocks);

    const groups = groupAssemblyBlocksByChromosome(model.blocks, {
      kind: "contigs",
      ids: ["Chr01:2:ctg2", "Chr02:1:ctg3"],
    });

    expect(groups).toEqual([
      {
        id: "Chr01",
        visualStart: 0,
        visualEnd: 250,
        blockIds: ["Chr01:1:ctg1", "Chr01:2:ctg2"],
        totalCount: 2,
        selectedCount: 1,
        totalLength: 250,
        selectedLength: 150,
      },
      {
        id: "Chr02",
        visualStart: 250,
        visualEnd: 330,
        blockIds: ["Chr02:1:ctg3"],
        totalCount: 1,
        selectedCount: 1,
        totalLength: 80,
        selectedLength: 80,
      },
    ]);
  });

  it("selects contigs and chromosomes with additive selection", () => {
    let selection = selectContig(null, "Chr01:1:ctg1", false);
    selection = selectContig(selection, "Chr01:2:ctg2", true);

    expect(selection).toEqual({ kind: "contigs", ids: ["Chr01:1:ctg1", "Chr01:2:ctg2"] });
    expect(selectChromosome(selection, "Chr02", false)).toEqual({ kind: "chromosome", id: "Chr02" });
  });

  it("toggles selected contigs off during additive selection", () => {
    let selection = selectContig(null, "Chr01:1:ctg1", false);

    selection = selectContig(selection, "Chr01:1:ctg1", true);

    expect(selection).toBeNull();
  });

  it("replaces selection with the contigs inside a Juicebox-style drag box", () => {
    const model = buildAssemblyEditModel(blocks);

    expect(
      contigIdsInScreenSelection(
        model,
        { x: 10, y: 10 },
        { x: 240, y: 240 },
        { sizePx: 330, tolerancePx: 0 },
      ),
    ).toEqual(["Chr01:1:ctg1", "Chr01:2:ctg2"]);
    expect(selectContigs(["Chr01:1:ctg1", "Chr01:2:ctg2", "Chr01:1:ctg1"])).toEqual({
      kind: "contigs",
      ids: ["Chr01:1:ctg1", "Chr01:2:ctg2"],
    });
  });

  it("detects whether a clicked contig is already selected", () => {
    const selection = { kind: "contigs" as const, ids: ["Chr01:1:ctg1"] };

    expect(isContigSelected(selection, "Chr01:1:ctg1")).toBe(true);
    expect(isContigSelected(selection, "Chr01:2:ctg2")).toBe(false);
    expect(isContigSelected({ kind: "chromosome", id: "Chr01" }, "Chr01:1:ctg1")).toBe(false);
  });

  it("reverses selected contigs as one oriented segment", () => {
    const reversed = reverseSelection(blocks, { kind: "contigs", ids: ["Chr01:1:ctg1", "Chr01:2:ctg2"] });

    expect(reversed.map((block) => [block.id, block.orientation, block.visualStart, block.visualEnd])).toEqual([
      ["Chr01:2:ctg2", "+", 0, 150],
      ["Chr01:1:ctg1", "-", 150, 250],
      ["Chr02:1:ctg3", "+", 250, 330],
    ]);
  });

  it("rotates a four-contig group from 1+2+3+4+ to 4-3-2-1-", () => {
    const fourBlocks: ContactMapLayoutBlock[] = [1, 2, 3, 4].map((index) => ({
      id: `block-${index}`,
      objectId: "Chr01",
      sourceId: `ctg-${index}`,
      sourceStart: 0,
      sourceEnd: 100,
      visualStart: (index - 1) * 100,
      visualEnd: index * 100,
      orientation: "+",
    }));

    const rotated = reverseSelection(fourBlocks, {
      kind: "contigs",
      ids: fourBlocks.map((block) => block.id),
    });

    expect(rotated.map((block) => [block.id, block.orientation])).toEqual([
      ["block-4", "-"],
      ["block-3", "-"],
      ["block-2", "-"],
      ["block-1", "-"],
    ]);
    expect(rotated.map((block) => [block.visualStart, block.visualEnd])).toEqual([
      [0, 100],
      [100, 200],
      [200, 300],
      [300, 400],
    ]);
  });

  it("reverses a whole chromosome as one oriented segment", () => {
    const reversed = reverseSelection(blocks, { kind: "chromosome", id: "Chr01" });

    expect(reversed.map((block) => [block.id, block.orientation, block.visualStart, block.visualEnd])).toEqual([
      ["Chr01:2:ctg2", "+", 0, 150],
      ["Chr01:1:ctg1", "-", 150, 250],
      ["Chr02:1:ctg3", "+", 250, 330],
    ]);
  });

  it("moves selected contigs before a target contig and recomputes visual coordinates", () => {
    const moved = moveSelectionBefore(blocks, { kind: "contigs", ids: ["Chr02:1:ctg3"] }, "Chr01:2:ctg2");

    expect(moved.map((block) => [block.id, block.objectId, block.visualStart, block.visualEnd])).toEqual([
      ["Chr01:1:ctg1", "Chr01", 0, 100],
      ["Chr02:1:ctg3", "Chr01", 100, 180],
      ["Chr01:2:ctg2", "Chr01", 180, 330],
    ]);
  });

  it("moves a whole chromosome before another chromosome without merging their ids", () => {
    const moved = moveSelectionBefore(
      blocks,
      { kind: "chromosome", id: "Chr02" },
      "Chr01:1:ctg1",
    );

    expect(moved.map((block) => [block.id, block.objectId, block.visualStart, block.visualEnd])).toEqual([
      ["Chr02:1:ctg3", "Chr02", 0, 80],
      ["Chr01:1:ctg1", "Chr01", 80, 180],
      ["Chr01:2:ctg2", "Chr01", 180, 330],
    ]);
  });

  it("keeps the original blocks for a chromosome move that would not change its position", () => {
    expect(moveSelectionBefore(
      blocks,
      { kind: "chromosome", id: "Chr01" },
      "Chr02:1:ctg3",
    )).toBe(blocks);
  });

  it("copies selected contigs after the source segment with stable copy ids", () => {
    const copied = copySelection(blocks, { kind: "contigs", ids: ["Chr01:1:ctg1", "Chr01:2:ctg2"] });

    expect(copied.map((block) => [block.id, block.sourceId, block.visualStart, block.visualEnd])).toEqual([
      ["Chr01:1:ctg1", "ctg1", 0, 100],
      ["Chr01:2:ctg2", "ctg2", 100, 250],
      ["Chr01:1:ctg1_d2", "ctg1", 250, 350],
      ["Chr01:2:ctg2_d2", "ctg2", 350, 500],
      ["Chr02:1:ctg3", "ctg3", 500, 580],
    ]);
  });

  it("copies a whole chromosome as a new chromosome boundary", () => {
    const copied = copySelection(blocks, { kind: "chromosome", id: "Chr01" });

    expect(copied.map((block) => [block.id, block.objectId, block.sourceId, block.visualStart, block.visualEnd])).toEqual([
      ["Chr01:1:ctg1", "Chr01", "ctg1", 0, 100],
      ["Chr01:2:ctg2", "Chr01", "ctg2", 100, 250],
      ["Chr01:1:ctg1_d2", "Chr01_d2", "ctg1", 250, 350],
      ["Chr01:2:ctg2_d2", "Chr01_d2", "ctg2", 350, 500],
      ["Chr02:1:ctg3", "Chr02", "ctg3", 500, 580],
    ]);

    expect(buildAssemblyEditModel(copied).chromosomes.map((chromosome) => chromosome.id)).toEqual([
      "Chr01",
      "Chr01_d2",
      "Chr02",
    ]);
  });

  it("copies selected contigs before a target and adopts the target chromosome", () => {
    const copied = copySelectionBefore(
      blocks,
      { kind: "contigs", ids: ["Chr01:1:ctg1"] },
      "Chr02:1:ctg3",
    );

    expect(copied.map((block) => [block.id, block.objectId, block.sourceId, block.visualStart])).toEqual([
      ["Chr01:1:ctg1", "Chr01", "ctg1", 0],
      ["Chr01:2:ctg2", "Chr01", "ctg2", 100],
      ["Chr01:1:ctg1_d2", "Chr02", "ctg1", 250],
      ["Chr02:1:ctg3", "Chr02", "ctg3", 350],
    ]);
  });

  it("moves selected contigs to debris at the end of the layout", () => {
    const moved = moveSelectionToDebris(blocks, { kind: "contigs", ids: ["Chr01:2:ctg2"] });

    expect(moved.map((block) => [block.id, block.objectId, block.visualStart, block.visualEnd])).toEqual([
      ["Chr01:1:ctg1", "Chr01", 0, 100],
      ["Chr02:1:ctg3", "Chr02", 100, 180],
      ["Chr01:2:ctg2", "debris", 180, 330],
    ]);
  });

  it("adds chromosome boundaries around selected contigs", () => {
    const bounded = addChromosomeBoundariesToSelection(blocks, { kind: "contigs", ids: ["Chr01:2:ctg2"] });

    expect(bounded.map((block) => [block.id, block.objectId, block.visualStart, block.visualEnd])).toEqual([
      ["Chr01:1:ctg1", "Chr01", 0, 100],
      ["Chr01:2:ctg2", "Chr01_d2", 100, 250],
      ["Chr02:1:ctg3", "Chr02", 250, 330],
    ]);
    expect(buildAssemblyEditModel(bounded).chromosomes.map((chromosome) => chromosome.id)).toEqual([
      "Chr01",
      "Chr01_d2",
      "Chr02",
    ]);
  });

  it("splits an internal chromosome selection into three uniquely named segments", () => {
    const chromosomeBlocks: ContactMapLayoutBlock[] = [1, 2, 3, 4, 5, 6].map((index) => ({
      id: `Chr01:${index}:ctg${index}`,
      objectId: "Chr01",
      sourceId: `ctg${index}`,
      sourceStart: 0,
      sourceEnd: 100,
      visualStart: (index - 1) * 100,
      visualEnd: index * 100,
      orientation: index % 2 === 0 ? "-" : "+",
    }));

    const bounded = addChromosomeBoundariesToSelection(chromosomeBlocks, {
      kind: "contigs",
      ids: ["Chr01:3:ctg3", "Chr01:4:ctg4"],
    });

    expect(bounded.map((block) => block.objectId)).toEqual([
      "Chr01",
      "Chr01",
      "Chr01_d2",
      "Chr01_d2",
      "Chr01_d3",
      "Chr01_d3",
    ]);
    expect(buildAssemblyEditModel(bounded).chromosomes).toEqual([
      {
        id: "Chr01",
        visualStart: 0,
        visualEnd: 200,
        blockIds: ["Chr01:1:ctg1", "Chr01:2:ctg2"],
      },
      {
        id: "Chr01_d2",
        visualStart: 200,
        visualEnd: 400,
        blockIds: ["Chr01:3:ctg3", "Chr01:4:ctg4"],
      },
      {
        id: "Chr01_d3",
        visualStart: 400,
        visualEnd: 600,
        blockIds: ["Chr01:5:ctg5", "Chr01:6:ctg6"],
      },
    ]);
    expect(bounded.map(({ objectId: _objectId, ...block }) => block)).toEqual(
      chromosomeBlocks.map(({ objectId: _objectId, ...block }) => block),
    );
  });

  it("allocates chromosome suffixes globally across repeated splits", () => {
    const chromosomeBlocks: ContactMapLayoutBlock[] = [1, 2, 3, 4, 5].map((index) => ({
      id: `Chr01:${index}:ctg${index}`,
      objectId: "Chr01",
      sourceId: `ctg${index}`,
      sourceStart: 0,
      sourceEnd: 100,
      visualStart: (index - 1) * 100,
      visualEnd: index * 100,
      orientation: "+",
    }));
    const firstSplit = addChromosomeBoundariesToSelection(chromosomeBlocks, {
      kind: "contigs",
      ids: ["Chr01:2:ctg2", "Chr01:3:ctg3", "Chr01:4:ctg4"],
    });

    const secondSplit = addChromosomeBoundariesToSelection(firstSplit, {
      kind: "contigs",
      ids: ["Chr01:3:ctg3"],
    });

    expect(secondSplit.map((block) => block.objectId)).toEqual([
      "Chr01",
      "Chr01_d2",
      "Chr01_d4",
      "Chr01_d5",
      "Chr01_d3",
    ]);
    expect(new Set(secondSplit.map((block) => block.objectId).filter((id, index, ids) => (
      index === 0 || id !== ids[index - 1]
    ))).size).toBe(5);
  });

  it("splits selections inside different chromosomes independently", () => {
    const chromosomeBlocks: ContactMapLayoutBlock[] = ["Chr01", "Chr02"].flatMap(
      (objectId, chromosomeIndex) => [1, 2, 3].map((part) => ({
        id: `${objectId}:${part}:ctg${chromosomeIndex + 1}${part}`,
        objectId,
        sourceId: `ctg${chromosomeIndex + 1}${part}`,
        sourceStart: 0,
        sourceEnd: 100,
        visualStart: (chromosomeIndex * 3 + part - 1) * 100,
        visualEnd: (chromosomeIndex * 3 + part) * 100,
        orientation: "+" as const,
      })),
    );

    const bounded = addChromosomeBoundariesToSelection(chromosomeBlocks, {
      kind: "contigs",
      ids: ["Chr01:2:ctg12", "Chr02:2:ctg22"],
    });

    expect(bounded.map((block) => block.objectId)).toEqual([
      "Chr01",
      "Chr01_d2",
      "Chr01_d3",
      "Chr02",
      "Chr02_d2",
      "Chr02_d3",
    ]);
  });

  it("does not add boundaries around an already complete chromosome selection", () => {
    expect(addChromosomeBoundariesToSelection(blocks, {
      kind: "contigs",
      ids: ["Chr01:1:ctg1", "Chr01:2:ctg2"],
    })).toBe(blocks);
  });

  it("splits a contig at a visual position into left and right source intervals", () => {
    const split = splitContigAtVisualPosition(blocks, "Chr01:2:ctg2", 160);

    expect(split.map((block) => [block.id, block.sourceStart, block.sourceEnd, block.visualStart, block.visualEnd])).toEqual([
      ["Chr01:1:ctg1", 0, 100, 0, 100],
      ["Chr01:2:ctg2:left", 0, 60, 100, 160],
      ["Chr01:2:ctg2:right", 60, 150, 160, 250],
      ["Chr02:1:ctg3", 0, 80, 250, 330],
    ]);
    expect(split[1]?.orientation).toBe("-");
    expect(split[2]?.orientation).toBe("-");
  });

  it("hit-tests contig body and chromosome boundaries in map pixels", () => {
    const model = buildAssemblyEditModel(blocks);

    expect(hitTestAssemblyLayout(model, { x: 30, y: 32 }, { sizePx: 330, tolerancePx: 8 })).toEqual({
      kind: "contig",
      id: "Chr01:1:ctg1",
    });
    expect(hitTestAssemblyLayout(model, { x: 250, y: 251 }, { sizePx: 330, tolerancePx: 8 })).toEqual({
      kind: "contig",
      id: "Chr02:1:ctg3",
    });
  });

  it("hit-tests inside diagonal contig and chromosome boxes", () => {
    const model = buildAssemblyEditModel(blocks);

    expect(hitTestAssemblyLayout(model, { x: 120, y: 220 }, { sizePx: 330, tolerancePx: 8 })).toEqual({
      kind: "contig",
      id: "Chr01:2:ctg2",
    });
    expect(hitTestAssemblyLayout(model, { x: 20, y: 240 }, { sizePx: 330, tolerancePx: 8 })).toEqual({
      kind: "chromosome-boundary",
      id: "Chr01",
    });
  });

  it("hit-tests against the visible contact viewport when zoomed", () => {
    const model = buildAssemblyEditModel(blocks);

    expect(
      hitTestAssemblyLayout(
        model,
        { x: 0, y: 2 },
        { sizePx: 100, tolerancePx: 8, viewportStart: 250, viewportEnd: 330 },
      ),
    ).toEqual({
      kind: "contig",
      id: "Chr02:1:ctg3",
    });
    expect(
      hitTestAssemblyLayout(
        model,
        { x: 50, y: 52 },
        { sizePx: 100, tolerancePx: 8, viewportStart: 250, viewportEnd: 330 },
      ),
    ).toEqual({
      kind: "contig",
      id: "Chr02:1:ctg3",
    });
  });

  it("hit-tests X and Y against their independent panned viewports", () => {
    const model = buildAssemblyEditModel(blocks);

    expect(
      hitTestAssemblyLayout(
        model,
        { x: 120, y: 0 },
        {
          sizePx: 330,
          tolerancePx: 0,
          viewportXStart: 0,
          viewportXEnd: 330,
          viewportYStart: 100,
          viewportYEnd: 430,
        },
      ),
    ).toEqual({ kind: "contig", id: "Chr01:2:ctg2" });
  });

  it("offers insertion only directly on a boundary between two unselected contigs", () => {
    const model = buildAssemblyEditModel(blocks);
    const selected = new Set(["Chr02:1:ctg3"]);

    expect(insertionTargetAtScreenPoint(
      model,
      selected,
      { x: 100, y: 100 },
      { sizePx: 330, tolerancePx: 7 },
    )).toEqual({ targetBlockId: "Chr01:2:ctg2", visualPosition: 100 });
    expect(insertionTargetAtScreenPoint(
      model,
      selected,
      { x: 109, y: 100 },
      { sizePx: 330, tolerancePx: 7 },
    )).toBeNull();
    expect(insertionTargetAtScreenPoint(
      model,
      new Set(),
      { x: 100, y: 100 },
      { sizePx: 330, tolerancePx: 7 },
    )).toBeNull();
  });

  it("does not offer insertion at chromosome boundaries or beside selected contigs", () => {
    const model = buildAssemblyEditModel(blocks);

    expect(insertionTargetAtScreenPoint(
      model,
      new Set(["Chr01:1:ctg1"]),
      { x: 100, y: 100 },
      { sizePx: 330, tolerancePx: 7 },
    )).toBeNull();
    expect(insertionTargetAtScreenPoint(
      model,
      new Set(["Chr01:1:ctg1"]),
      { x: 250, y: 250 },
      { sizePx: 330, tolerancePx: 7 },
    )).toBeNull();
  });

  it("offers chromosome selections insertion points only at other chromosome boundaries", () => {
    const model = buildAssemblyEditModel(blocks);
    const selectedChromosome = new Set(["Chr02:1:ctg3"]);

    expect(insertionTargetAtScreenPoint(
      model,
      selectedChromosome,
      { x: 0, y: 0 },
      { sizePx: 330, tolerancePx: 7, selectionKind: "chromosome" },
    )).toEqual({ targetBlockId: "Chr01:1:ctg1", visualPosition: 0 });
    expect(insertionTargetAtScreenPoint(
      model,
      selectedChromosome,
      { x: 100, y: 100 },
      { sizePx: 330, tolerancePx: 7, selectionKind: "chromosome" },
    )).toBeNull();

    expect(insertionTargetAtScreenPoint(
      model,
      new Set(["Chr01:1:ctg1", "Chr01:2:ctg2"]),
      { x: 330, y: 330 },
      { sizePx: 330, tolerancePx: 7, selectionKind: "chromosome" },
    )).toEqual({ targetBlockId: null, visualPosition: 330 });
    expect(insertionTargetAtScreenPoint(
      model,
      selectedChromosome,
      { x: 250, y: 250 },
      { sizePx: 330, tolerancePx: 7, selectionKind: "chromosome" },
    )).toBeNull();
  });

  it("offers contig insertion at AGP gaps inside the target chromosome", () => {
    const blocksWithGap = [
      blocks[0],
      {
        ...blocks[1],
        visualStart: 110,
        visualEnd: 260,
      },
      {
        ...blocks[2],
        visualStart: 260,
        visualEnd: 340,
      },
    ];
    const model = buildAssemblyEditModel(blocksWithGap);

    expect(insertionTargetAtScreenPoint(
      model,
      new Set(["Chr02:1:ctg3"]),
      { x: 110, y: 110 },
      { sizePx: 340, tolerancePx: 7 },
    )).toEqual({ targetBlockId: "Chr01:2:ctg2", visualPosition: 110 });
  });

  it("places the chromosome end slot before debris rather than after it", () => {
    const blocksWithDebris = [
      ...blocks,
      {
        id: "debris:1:ctg4",
        objectId: "debris",
        sourceId: "ctg4",
        sourceStart: 0,
        sourceEnd: 50,
        visualStart: 330,
        visualEnd: 380,
        orientation: "+" as const,
      },
    ];
    const model = buildAssemblyEditModel(blocksWithDebris);
    const selectedChromosome = new Set(["Chr01:1:ctg1", "Chr01:2:ctg2"]);

    expect(insertionTargetAtScreenPoint(
      model,
      selectedChromosome,
      { x: 330, y: 330 },
      { sizePx: 380, tolerancePx: 7, selectionKind: "chromosome" },
    )).toEqual({ targetBlockId: "debris:1:ctg4", visualPosition: 330 });
    expect(insertionTargetAtScreenPoint(
      model,
      selectedChromosome,
      { x: 380, y: 380 },
      { sizePx: 380, tolerancePx: 7, selectionKind: "chromosome" },
    )).toBeNull();
    expect(insertionTargetAtScreenPoint(
      model,
      new Set(["debris:1:ctg4"]),
      { x: 0, y: 0 },
      { sizePx: 380, tolerancePx: 7, selectionKind: "chromosome" },
    )).toBeNull();
  });
});
