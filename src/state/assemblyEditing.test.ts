import { describe, expect, it } from "vitest";
import {
  assemblyContigDisplayName,
  assemblyContigSelectionIntent,
  assemblyRenameTarget,
  assemblyRenameValidationError,
  buildAssemblyEditModel,
  chromosomeEndInsertionTargets,
  createAssemblyBlockFromGfa,
  contigIdsInScreenSelection,
  DEFAULT_INSERTED_GAP,
  deleteContigSelection,
  deleteGapsBetweenSelection,
  dissolveAssemblyBlockSelection,
  groupAssemblyBlocksByChromosome,
  hasDeletableGap,
  hasDissolvableAssemblyBlock,
  hasRemovableChromosomeBoundary,
  hitTestAssemblyLayout,
  insertionTargetAtScreenPoint,
  isContigSelected,
  copySelection,
  copySelectionBefore,
  addChromosomeBoundariesToSelection,
  moveSelectionBefore,
  moveSelectionToDebris,
  planGfaBlockCreation,
  pointSelectsWholeChromosome,
  reverseSelection,
  removeChromosomeBoundariesFromSelection,
  renameAssemblySelection,
  selectChromosome,
  selectContig,
  selectContigs,
  splitContigAtVisualPosition,
} from "./assemblyEditing";
import type { GfaLinkEvidence } from "./gfa";
import { exportAgpText } from "./agpExport";
import { parseAgpLayout, type ContactMapLayoutBlock } from "./importers";

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

describe("GFA-aware block editing", () => {
  const selected = { kind: "contigs" as const, ids: ["Chr01:1:ctg1", "Chr01:2:ctg2"] };
  const overlapLink: GfaLinkEvidence = {
    id: "link-1",
    from: { segmentName: "ctg1", orientation: "+", side: "end" },
    to: { segmentName: "ctg2", orientation: "-", side: "end" },
    overlap: "12M",
  };

  it("creates one block and trims an accepted GFA overlap once from the displayed right utg", () => {
    const created = createAssemblyBlockFromGfa(blocks, selected, [overlapLink]);

    expect(created.slice(0, 2).map((block) => block.assemblyBlockId)).toEqual([
      "Chr01_block_1",
      "Chr01_block_1",
    ]);
    expect(created[1]).toMatchObject({ sourceStart: 0, sourceEnd: 138 });
    expect(created[1].gfaOverlapBefore).toMatchObject({
      linkId: "link-1",
      cigar: "12M",
      trimmedBases: 12,
      originalSourceStart: 0,
      originalSourceEnd: 150,
    });
    expect(exportAgpText(created)).toContain("\tctg2\t1\t138\t-");
  });

  it("dissolves the generated block, restores trimmed source coordinates, and inserts an AGP gap", () => {
    const created = createAssemblyBlockFromGfa(blocks, selected, [overlapLink]);
    const dissolved = dissolveAssemblyBlockSelection(created, {
      kind: "contigs",
      ids: [created[0].assemblyBlockId!],
    });

    expect(dissolved.slice(0, 2).map((block) => block.assemblyBlockId)).toEqual([null, null]);
    expect(dissolved[1]).toMatchObject({ sourceStart: 0, sourceEnd: 150 });
    expect(dissolved[1].gapBefore).toEqual(DEFAULT_INSERTED_GAP);
    expect(dissolved[1].gfaOverlapBefore).toBeUndefined();
  });

  it("enables dissolve only when the selection touches a composite block", () => {
    const created = createAssemblyBlockFromGfa(blocks, selected, [overlapLink]);
    expect(hasDissolvableAssemblyBlock(created, {
      kind: "contigs",
      ids: [created[0].assemblyBlockId!],
    })).toBe(true);
    expect(hasDissolvableAssemblyBlock(created, {
      kind: "contigs",
      ids: [created[0].id],
      exact: true,
    })).toBe(true);
    expect(hasDissolvableAssemblyBlock(blocks, selected)).toBe(false);
  });

  it("does not record another create operation for utgs already in the same block", () => {
    const created = createAssemblyBlockFromGfa(blocks, selected, [overlapLink]);
    expect(planGfaBlockCreation(created, {
      kind: "contigs",
      ids: created.slice(0, 2).map((block) => block.id),
      exact: true,
    }, [overlapLink])).toEqual({
      ok: false,
      reason: "Selected utgs already belong to one block.",
    });
  });

  it("blocks ambiguous, orientation-conflicting, and gapped overlaps", () => {
    expect(planGfaBlockCreation(blocks, selected, [{ ...overlapLink, overlap: "10M2I" }]))
      .toEqual({ ok: false, reason: "Overlap 10M2I is not a simple ungapped M/= CIGAR; review it before joining." });
    expect(planGfaBlockCreation(blocks, selected, [{
      ...overlapLink,
      to: { ...overlapLink.to, side: "start" },
    }])).toEqual({
      ok: false,
      reason: "GFA link orientation conflicts at ctg1 → ctg2.",
    });
    expect(planGfaBlockCreation(blocks, selected, [overlapLink, { ...overlapLink, id: "link-2" }])).toEqual({
      ok: false,
      reason: "Multiple GFA overlaps match ctg1 → ctg2.",
    });
  });
});

const structuredBlocks: ContactMapLayoutBlock[] = [
  {
    id: "Chr01:1:ctgA",
    objectId: "Chr01",
    sourceId: "ctgA",
    sourceStart: 0,
    sourceEnd: 100,
    visualStart: 0,
    visualEnd: 100,
    orientation: "+",
    componentType: "W",
    assemblyBlockId: "Chr01_block_1",
  },
  {
    id: "Chr01:2:ctgB",
    objectId: "Chr01",
    sourceId: "ctgB",
    sourceStart: 10,
    sourceEnd: 60,
    visualStart: 100,
    visualEnd: 150,
    orientation: "-",
    componentType: "W",
    assemblyBlockId: "Chr01_block_1",
  },
  {
    id: "Chr01:4:ctgC",
    objectId: "Chr01",
    sourceId: "ctgC",
    sourceStart: 0,
    sourceEnd: 60,
    visualStart: 190,
    visualEnd: 250,
    orientation: "+",
    componentType: "W",
    assemblyBlockId: null,
    gapBefore: {
      componentType: "U",
      length: 40,
      gapType: "contig",
      linkage: "yes",
      linkageEvidence: "map",
    },
  },
  {
    id: "Chr01:6:ctgD",
    objectId: "Chr01",
    sourceId: "ctgD",
    sourceStart: 0,
    sourceEnd: 30,
    visualStart: 270,
    visualEnd: 300,
    orientation: "+",
    componentType: "W",
    assemblyBlockId: "Chr01_block_2",
    gapBefore: {
      componentType: "N",
      length: 20,
      gapType: "scaffold",
      linkage: "no",
      linkageEvidence: "na",
    },
  },
  {
    id: "Chr01:7:ctgE",
    objectId: "Chr01",
    sourceId: "ctgE",
    sourceStart: 5,
    sourceEnd: 75,
    visualStart: 300,
    visualEnd: 370,
    orientation: "-",
    componentType: "W",
    assemblyBlockId: "Chr01_block_2",
  },
  {
    id: "Chr02:1:ctgF",
    objectId: "Chr02",
    sourceId: "ctgF",
    sourceStart: 0,
    sourceEnd: 80,
    visualStart: 370,
    visualEnd: 450,
    orientation: "+",
    componentType: "W",
    assemblyBlockId: null,
  },
];

describe("assemblyEditing", () => {
  it("renames a chromosome without changing its contig data ids", () => {
    const selection = { kind: "chromosome" as const, id: "Chr01" };
    const renamed = renameAssemblySelection(blocks, selection, "ChrA");

    expect(renamed.map((block) => block.objectId)).toEqual(["ChrA", "ChrA", "Chr02"]);
    expect(renamed.map((block) => block.sourceId)).toEqual(["ctg1", "ctg2", "ctg3"]);
    expect(assemblyRenameValidationError(blocks, selection, "Chr02")).toBe(
      "A chromosome already uses this name.",
    );
  });

  it("renames one contig for display and AGP export while preserving its data lookup id", () => {
    const selection = { kind: "contigs" as const, ids: ["Chr01:1:ctg1"] };
    const renamed = renameAssemblySelection(blocks, selection, "contig_alpha");

    expect(assemblyRenameTarget(blocks, selection)).toEqual({
      kind: "contig",
      currentName: "ctg1",
    });
    expect(renamed[0]).toMatchObject({
      sourceId: "ctg1",
      displayName: "contig_alpha",
    });
    expect(assemblyContigDisplayName(renamed[0]!)).toBe("contig_alpha");
    expect(exportAgpText(renamed)).toContain("\tcontig_alpha\t1\t100\t+");
    expect(assemblyRenameValidationError(blocks, selection, "ctg2")).toBe(
      "A contig already uses this name.",
    );
  });

  it("only offers rename for a single atomic contig or chromosome", () => {
    expect(assemblyRenameTarget(structuredBlocks, {
      kind: "contigs",
      ids: ["Chr01_block_1"],
    })).toBeNull();
    expect(assemblyRenameTarget(blocks, {
      kind: "contigs",
      ids: ["Chr01:1:ctg1", "Chr01:2:ctg2"],
    })).toBeNull();
  });

  it("builds chromosome boundaries from AGP object ids", () => {
    const model = buildAssemblyEditModel(blocks);

    expect(model.chromosomes).toEqual([
      { id: "Chr01", visualStart: 0, visualEnd: 250, blockIds: ["Chr01:1:ctg1", "Chr01:2:ctg2"] },
      { id: "Chr02", visualStart: 250, visualEnd: 330, blockIds: ["Chr02:1:ctg3"] },
    ]);
  });

  it("builds composite blocks, explicit gaps, and bare singleton contigs", () => {
    const model = buildAssemblyEditModel(structuredBlocks);

    expect(model.assemblyBlocks).toEqual([
      {
        id: "Chr01_block_1",
        objectId: "Chr01",
        visualStart: 0,
        visualEnd: 150,
        contigIds: ["Chr01:1:ctgA", "Chr01:2:ctgB"],
        isComposite: true,
      },
      {
        id: "Chr01:4:ctgC",
        objectId: "Chr01",
        visualStart: 190,
        visualEnd: 250,
        contigIds: ["Chr01:4:ctgC"],
        isComposite: false,
      },
      {
        id: "Chr01_block_2",
        objectId: "Chr01",
        visualStart: 270,
        visualEnd: 370,
        contigIds: ["Chr01:6:ctgD", "Chr01:7:ctgE"],
        isComposite: true,
      },
      {
        id: "Chr02:1:ctgF",
        objectId: "Chr02",
        visualStart: 370,
        visualEnd: 450,
        contigIds: ["Chr02:1:ctgF"],
        isComposite: false,
      },
    ]);
    expect(model.gaps).toEqual([
      {
        id: "Chr01:gap-before:Chr01:4:ctgC",
        objectId: "Chr01",
        visualStart: 150,
        visualEnd: 190,
        leftBlockId: "Chr01_block_1",
        rightBlockId: "Chr01:4:ctgC",
        metadata: structuredBlocks[2]?.gapBefore,
      },
      {
        id: "Chr01:gap-before:Chr01:6:ctgD",
        objectId: "Chr01",
        visualStart: 250,
        visualEnd: 270,
        leftBlockId: "Chr01:4:ctgC",
        rightBlockId: "Chr01_block_2",
        metadata: structuredBlocks[3]?.gapBefore,
      },
    ]);
    expect(model.chromosomes).toEqual([
      {
        id: "Chr01",
        visualStart: 0,
        visualEnd: 370,
        blockIds: ["Chr01_block_1", "Chr01:4:ctgC", "Chr01_block_2"],
      },
      {
        id: "Chr02",
        visualStart: 370,
        visualEnd: 450,
        blockIds: ["Chr02:1:ctgF"],
      },
    ]);
    expect(model.totalSpan).toBe(450);
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

  it("uses clicks for replacement and Command or Control for discrete toggles", () => {
    const orderedBlocks: ContactMapLayoutBlock[] = [1, 2, 3, 4, 5, 6].map((index) => ({
      id: `contig-${index}`,
      objectId: "Chr01",
      sourceId: `ctg${index}`,
      sourceStart: 0,
      sourceEnd: 100,
      visualStart: (index - 1) * 100,
      visualEnd: index * 100,
      orientation: "+",
    }));
    const none = { shiftKey: false, metaKey: false, ctrlKey: false };

    expect(assemblyContigSelectionIntent(orderedBlocks, null, null, "contig-2", none)).toEqual({
      type: "select",
      id: "contig-2",
      additive: false,
      anchorId: "contig-2",
    });
    expect(assemblyContigSelectionIntent(
      orderedBlocks,
      { kind: "contigs", ids: ["contig-2"] },
      "contig-2",
      "contig-6",
      { ...none, shiftKey: true },
    )).toEqual({
      type: "select",
      id: "contig-6",
      additive: false,
      anchorId: "contig-6",
    });
    expect(assemblyContigSelectionIntent(
      orderedBlocks,
      { kind: "contigs", ids: ["contig-2"] },
      "contig-2",
      "contig-6",
      { ...none, metaKey: true },
    )).toEqual({
      type: "select",
      id: "contig-6",
      additive: true,
      anchorId: "contig-6",
    });
    expect(assemblyContigSelectionIntent(
      orderedBlocks,
      { kind: "contigs", ids: ["contig-2", "contig-3"] },
      "contig-2",
      "contig-3",
      { ...none, shiftKey: true },
    )).toEqual({
      type: "select",
      id: "contig-3",
      additive: false,
      anchorId: "contig-3",
    });
  });

  it("does not turn a Shift-click on a composite block into a range", () => {
    expect(assemblyContigSelectionIntent(
      structuredBlocks,
      { kind: "contigs", ids: ["Chr01_block_1"] },
      null,
      "Chr01_block_2",
      { shiftKey: true, metaKey: false, ctrlKey: false },
    )).toEqual({
      type: "select",
      id: "Chr01_block_2",
      additive: false,
      anchorId: "Chr01_block_2",
    });
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

  it("preserves zero and na orientations while reversing their order", () => {
    const unknownOrientations: ContactMapLayoutBlock[] = [
      {
        ...blocks[0]!,
        id: "Chr01:1:zero",
        sourceId: "zero",
        orientation: "0" as ContactMapLayoutBlock["orientation"],
      },
      {
        ...blocks[1]!,
        id: "Chr01:2:na",
        sourceId: "na",
        orientation: "na" as ContactMapLayoutBlock["orientation"],
      },
    ];

    const reversed = reverseSelection(unknownOrientations, {
      kind: "chromosome",
      id: "Chr01",
    });

    expect(reversed.map((block) => [block.sourceId, block.orientation])).toEqual([
      ["na", "na"],
      ["zero", "0"],
    ]);
  });

  it("reverses a composite assembly block atomically", () => {
    const reversed = reverseSelection(structuredBlocks, {
      kind: "contigs",
      ids: ["Chr01_block_1"],
    });

    expect(reversed.slice(0, 2).map((block) => [
      block.id,
      block.sourceId,
      block.orientation,
      block.assemblyBlockId,
      block.visualStart,
      block.visualEnd,
    ])).toEqual([
      ["Chr01:2:ctgB", "ctgB", "+", "Chr01_block_1", 0, 50],
      ["Chr01:1:ctgA", "ctgA", "-", "Chr01_block_1", 50, 150],
    ]);
    expect(reversed[2]?.gapBefore).toEqual(structuredBlocks[2]?.gapBefore);
  });

  it("reverses structured internal gaps and rebuilds block ordinals", () => {
    const reversed = reverseSelection(structuredBlocks, {
      kind: "chromosome",
      id: "Chr01",
    });

    expect(reversed.map((block) => [
      block.sourceId,
      block.orientation,
      block.gapBefore?.length,
      block.assemblyBlockId,
      block.visualStart,
      block.visualEnd,
    ])).toEqual([
      ["ctgE", "+", undefined, "Chr01_block_1", 0, 70],
      ["ctgD", "-", undefined, "Chr01_block_1", 70, 100],
      ["ctgC", "-", 20, null, 120, 180],
      ["ctgB", "+", 40, "Chr01_block_2", 220, 270],
      ["ctgA", "-", undefined, "Chr01_block_2", 270, 370],
      ["ctgF", "+", undefined, null, 370, 450],
    ]);
    expect(reversed[2]?.gapBefore).toEqual(structuredBlocks[3]?.gapBefore);
    expect(reversed[3]?.gapBefore).toEqual(structuredBlocks[2]?.gapBefore);
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

  it("inserts every contig from a selected chromosome into an internal target gap", () => {
    const moved = moveSelectionBefore(
      blocks,
      { kind: "chromosome", id: "Chr02" },
      "Chr01:2:ctg2",
      "Chr01",
    );

    expect(moved.map((block) => [block.id, block.objectId])).toEqual([
      ["Chr01:1:ctg1", "Chr01"],
      ["Chr02:1:ctg3", "Chr01"],
      ["Chr01:2:ctg2", "Chr01"],
    ]);
  });

  it("keeps the original blocks for a chromosome move that would not change its position", () => {
    expect(moveSelectionBefore(
      blocks,
      { kind: "chromosome", id: "Chr01" },
      "Chr02:1:ctg3",
    )).toBe(blocks);
  });

  it("moves a composite assembly block without separating its contigs", () => {
    const moved = moveSelectionBefore(
      structuredBlocks,
      { kind: "contigs", ids: ["Chr01_block_1"] },
      "Chr01_block_2",
    );
    const model = buildAssemblyEditModel(moved);

    expect(moved.map((block) => block.sourceId)).toEqual([
      "ctgC",
      "ctgA",
      "ctgB",
      "ctgD",
      "ctgE",
      "ctgF",
    ]);
    expect(model.assemblyBlocks.map((block) => block.contigIds)).toEqual([
      ["Chr01:4:ctgC"],
      ["Chr01:1:ctgA", "Chr01:2:ctgB"],
      ["Chr01:6:ctgD", "Chr01:7:ctgE"],
      ["Chr02:1:ctgF"],
    ]);
    expect(moved.map((block) => block.gapBefore?.length)).toEqual([
      undefined,
      40,
      undefined,
      20,
      undefined,
      undefined,
    ]);
    expect(moved.map((block) => [block.visualStart, block.visualEnd])).toEqual([
      [0, 60],
      [100, 200],
      [200, 250],
      [270, 300],
      [300, 370],
      [370, 450],
    ]);
  });

  it("does not reuse a displaced leading gap in a different chromosome", () => {
    const multiObjectBlocks: ContactMapLayoutBlock[] = [
      {
        id: "Chr01:1:a",
        objectId: "Chr01",
        sourceId: "a",
        sourceStart: 0,
        sourceEnd: 10,
        visualStart: 0,
        visualEnd: 10,
        orientation: "+",
        componentType: "W",
        assemblyBlockId: null,
      },
      {
        id: "Chr01:3:b",
        objectId: "Chr01",
        sourceId: "b",
        sourceStart: 0,
        sourceEnd: 10,
        visualStart: 50,
        visualEnd: 60,
        orientation: "+",
        componentType: "W",
        assemblyBlockId: null,
        gapBefore: { ...structuredBlocks[2]!.gapBefore!, length: 40 },
      },
      {
        id: "Chr02:1:c",
        objectId: "Chr02",
        sourceId: "c",
        sourceStart: 0,
        sourceEnd: 10,
        visualStart: 60,
        visualEnd: 70,
        orientation: "+",
        componentType: "W",
        assemblyBlockId: null,
      },
      {
        id: "Chr02:3:d",
        objectId: "Chr02",
        sourceId: "d",
        sourceStart: 0,
        sourceEnd: 10,
        visualStart: 90,
        visualEnd: 100,
        orientation: "+",
        componentType: "W",
        assemblyBlockId: null,
        gapBefore: { ...structuredBlocks[3]!.gapBefore!, length: 20 },
      },
    ];

    const moved = moveSelectionBefore(
      multiObjectBlocks,
      { kind: "contigs", ids: ["Chr02:1:c"] },
      "Chr01:3:b",
    );

    expect(moved.map((block) => [block.sourceId, block.objectId, block.gapBefore?.length])).toEqual([
      ["a", "Chr01", undefined],
      ["c", "Chr01", 100],
      ["b", "Chr01", 40],
      ["d", "Chr02", undefined],
    ]);
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
    expect(copied.slice(2, 4).map((block) => block.copyInstanceId)).toEqual([
      "Chr01:1:ctg1_d2",
      "Chr01:2:ctg2_d2",
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

  it("copies a composite assembly block atomically while preserving source ids", () => {
    const copied = copySelection(structuredBlocks, {
      kind: "contigs",
      ids: ["Chr01_block_1"],
    });
    const copiedModel = buildAssemblyEditModel(copied);
    const copiedUnit = copiedModel.assemblyBlocks.find((block) => (
      block.contigIds.includes("Chr01:1:ctgA_d2")
    ));

    expect(copied.slice(0, 4).map((block) => block.sourceId)).toEqual([
      "ctgA",
      "ctgB",
      "ctgA",
      "ctgB",
    ]);
    expect(copiedUnit).toMatchObject({
      objectId: "Chr01",
      contigIds: ["Chr01:1:ctgA_d2", "Chr01:2:ctgB_d2"],
      isComposite: true,
    });
    expect(copied.filter((block) => copiedUnit?.contigIds.includes(block.id)).map((block) => (
      block.assemblyBlockId
    ))).toEqual([copiedUnit?.id, copiedUnit?.id]);
  });

  it("inserts multi-object copies inside each source object segment", () => {
    const copied = copySelection(structuredBlocks, {
      kind: "contigs",
      ids: ["Chr01_block_1", "Chr02:1:ctgF"],
    });

    expect(copied.map((block) => [block.objectId, block.sourceId])).toEqual([
      ["Chr01", "ctgA"],
      ["Chr01", "ctgB"],
      ["Chr01", "ctgA"],
      ["Chr01", "ctgB"],
      ["Chr01", "ctgC"],
      ["Chr01", "ctgD"],
      ["Chr01", "ctgE"],
      ["Chr02", "ctgF"],
      ["Chr02", "ctgF"],
    ]);
    expect(copied.reduce<string[]>((segments, block) => (
      segments[segments.length - 1] === block.objectId
        ? segments
        : [...segments, block.objectId]
    ), [])).toEqual(["Chr01", "Chr02"]);

    const reparsed = parseAgpLayout(exportAgpText(copied));
    expect(reparsed.blocks.map((block) => [block.objectId, block.sourceId])).toEqual(
      copied.map((block) => [block.objectId, block.sourceId]),
    );
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

  it("moves a copied boundary gap behind the first unit of its target chromosome", () => {
    const copied = copySelectionBefore(
      structuredBlocks,
      { kind: "contigs", ids: ["Chr01:4:ctgC"] },
      "Chr02:1:ctgF",
    );
    const copiedContig = copied.find((block) => block.id === "Chr01:4:ctgC_d2");
    const target = copied.find((block) => block.id === "Chr02:1:ctgF");

    expect(copiedContig).toMatchObject({
      objectId: "Chr02",
      gapBefore: undefined,
      visualStart: 370,
      visualEnd: 430,
    });
    expect(target).toMatchObject({
      gapBefore: structuredBlocks[2]?.gapBefore,
      visualStart: 470,
      visualEnd: 550,
    });
  });

  it("moves selected contigs to debris at the end of the layout", () => {
    const moved = moveSelectionToDebris(blocks, { kind: "contigs", ids: ["Chr01:2:ctg2"] });

    expect(moved.map((block) => [block.id, block.objectId, block.visualStart, block.visualEnd])).toEqual([
      ["Chr01:1:ctg1", "Chr01", 0, 100],
      ["Chr02:1:ctg3", "Chr02", 100, 180],
      ["Chr01:2:ctg2", "debris", 180, 330],
    ]);
  });

  it("deletes only the selected contigs and closes the visual layout", () => {
    const deleted = deleteContigSelection(
      blocks,
      { kind: "contigs", ids: ["Chr01:2:ctg2"] },
    );

    expect(deleted.map((block) => [
      block.id,
      block.objectId,
      block.visualStart,
      block.visualEnd,
    ])).toEqual([
      ["Chr01:1:ctg1", "Chr01", 0, 100],
      ["Chr02:1:ctg3", "Chr02", 100, 180],
    ]);
    expect(deleteContigSelection(blocks, { kind: "chromosome", id: "Chr01" })).toBe(blocks);
  });

  it("deletes one selected split segment without deleting its sibling", () => {
    const split = splitContigAtVisualPosition(blocks, "Chr01:1:ctg1", 50);
    const deleted = deleteContigSelection(
      split,
      { kind: "contigs", ids: ["Chr01:1:ctg1:left"] },
    );

    expect(deleted.map((block) => [block.id, block.sourceStart, block.sourceEnd])).toEqual([
      ["Chr01:1:ctg1:right", 50, 100],
      ["Chr01:2:ctg2", 0, 150],
      ["Chr02:1:ctg3", 0, 80],
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

  it("removes chromosome boundaries enclosed by the selected blocks", () => {
    const selection = {
      kind: "contigs" as const,
      ids: ["Chr01:2:ctg2", "Chr02:1:ctg3"],
    };

    expect(hasRemovableChromosomeBoundary(blocks, selection)).toBe(true);
    const merged = removeChromosomeBoundariesFromSelection(blocks, selection);
    expect(merged.map((block) => [block.id, block.objectId])).toEqual([
      ["Chr01:1:ctg1", "Chr01"],
      ["Chr01:2:ctg2", "Chr01"],
      ["Chr02:1:ctg3", "Chr01"],
    ]);
    expect(merged.map((block) => block.orientation)).toEqual(["+", "-", "+"]);
  });

  it("retains a valid gap when structured chromosomes are joined", () => {
    const selection = {
      kind: "contigs" as const,
      ids: ["Chr01:6:ctgD", "Chr02:1:ctgF"],
    };
    const merged = removeChromosomeBoundariesFromSelection(structuredBlocks, selection);
    const joined = merged.find((block) => block.sourceId === "ctgF");

    expect(joined?.objectId).toBe("Chr01");
    expect(joined?.gapBefore).toEqual(DEFAULT_INSERTED_GAP);
    expect(joined?.visualStart).toBe(470);
  });

  it("keeps the original layout when the selection contains no chromosome boundary", () => {
    const selection = {
      kind: "contigs" as const,
      ids: ["Chr01:1:ctg1", "Chr01:2:ctg2"],
    };

    expect(hasRemovableChromosomeBoundary(blocks, selection)).toBe(false);
    expect(removeChromosomeBoundariesFromSelection(blocks, selection)).toBe(blocks);
  });

  it("removes gaps that become leading after chromosome retargeting", () => {
    const bounded = addChromosomeBoundariesToSelection(structuredBlocks, {
      kind: "contigs",
      ids: ["Chr01:4:ctgC"],
    });

    expect(bounded.map((block) => [
      block.sourceId,
      block.objectId,
      block.gapBefore?.length,
      block.visualStart,
    ])).toEqual([
      ["ctgA", "Chr01", undefined, 0],
      ["ctgB", "Chr01", undefined, 100],
      ["ctgC", "Chr01_d2", undefined, 150],
      ["ctgD", "Chr01_d3", undefined, 210],
      ["ctgE", "Chr01_d3", undefined, 240],
      ["ctgF", "Chr02", undefined, 310],
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

  it("splits a reverse contig in visual order and inserts a default gap", () => {
    const split = splitContigAtVisualPosition(blocks, "Chr01:2:ctg2", 160);

    expect(split.map((block) => [block.id, block.sourceStart, block.sourceEnd, block.visualStart, block.visualEnd])).toEqual([
      ["Chr01:1:ctg1", 0, 100, 0, 100],
      ["Chr01:2:ctg2:left", 90, 150, 100, 160],
      ["Chr01:2:ctg2:right", 0, 90, 260, 350],
      ["Chr02:1:ctg3", 0, 80, 350, 430],
    ]);
    expect(split[1]?.orientation).toBe("-");
    expect(split[2]?.orientation).toBe("-");
    expect(split.slice(1, 3).map((block) => assemblyContigDisplayName(block))).toEqual([
      "ctg2",
      "ctg2",
    ]);
    expect(split.slice(1, 3).every((block) => block.displayName === undefined)).toBe(true);
    expect(split.slice(1, 3).every((block) => block.isSourceSegment)).toBe(true);
    expect(split.slice(1, 3).map((block) => block.copyInstanceId)).toEqual([
      "Chr01:2:ctg2",
      "Chr01:2:ctg2",
    ]);
    expect(split[2]?.gapBefore).toEqual({
      componentType: "U",
      length: 100,
      gapType: "contig",
      linkage: "no",
      linkageEvidence: "na",
    });
    expect(split.map((block) => block.assemblyBlockId ?? null)).toEqual([
      "Chr01_block_1",
      "Chr01_block_1",
      null,
      null,
    ]);
  });

  it("splits a forward contig and preserves forward source interval order around the gap", () => {
    const forward: ContactMapLayoutBlock[] = [{
      id: "Chr03:1:ctgForward",
      objectId: "Chr03",
      sourceId: "ctgForward",
      sourceStart: 10,
      sourceEnd: 110,
      visualStart: 0,
      visualEnd: 100,
      orientation: "+",
      componentType: "W",
      assemblyBlockId: null,
    }];

    const split = splitContigAtVisualPosition(forward, "Chr03:1:ctgForward", 40);

    expect(split.map((block) => [
      block.id,
      block.sourceStart,
      block.sourceEnd,
      block.visualStart,
      block.visualEnd,
      block.assemblyBlockId ?? null,
    ])).toEqual([
      ["Chr03:1:ctgForward:left", 10, 50, 0, 40, null],
      ["Chr03:1:ctgForward:right", 50, 110, 140, 200, null],
    ]);
    expect(split[1]?.gapBefore).toEqual({
      componentType: "U",
      length: 100,
      gapType: "contig",
      linkage: "no",
      linkageEvidence: "na",
    });
    expect(split.map((block) => assemblyContigDisplayName(block))).toEqual([
      "ctgForward",
      "ctgForward",
    ]);
    expect(split.every((block) => block.displayName === undefined)).toBe(true);
    expect(split.every((block) => block.isSourceSegment)).toBe(true);
  });

  it("preserves a user-assigned contig name across split source intervals", () => {
    const renamed = renameAssemblySelection(
      blocks,
      { kind: "contigs", ids: ["Chr01:1:ctg1"] },
      "renamed_ctg1",
    );
    const split = splitContigAtVisualPosition(renamed, "Chr01:1:ctg1", 50);

    expect(split.slice(0, 2).map((block) => block.displayName)).toEqual([
      "renamed_ctg1",
      "renamed_ctg1",
    ]);
    expect(split.slice(0, 2).map((block) => [block.sourceStart, block.sourceEnd])).toEqual([
      [0, 50],
      [50, 100],
    ]);
  });

  it("copies only the selected half of a split contig inside a composite block", () => {
    const split = splitContigAtVisualPosition(
      structuredBlocks,
      "Chr01:2:ctgB",
      125,
    );
    const copied = copySelection(split, {
      kind: "contigs",
      ids: ["Chr01:2:ctgB:left"],
    });

    expect(copied.filter((block) => block.sourceId === "ctgA")).toHaveLength(1);
    expect(copied.filter((block) => (
      block.sourceId === "ctgB" && block.sourceStart === 35 && block.sourceEnd === 60
    ))).toHaveLength(2);
    expect(copied.filter((block) => (
      block.sourceId === "ctgB" && block.sourceStart === 10 && block.sourceEnd === 35
    ))).toHaveLength(1);
    expect(copied.filter((block) => (
      block.sourceStart === 35
      && block.sourceEnd === 60
      && assemblyContigDisplayName(block) === "ctgB"
    ))).toHaveLength(2);
  });

  it("deletes only a selected adjacent gap and rebuilds composite and singleton semantics", () => {
    const selection = {
      kind: "contigs" as const,
      ids: ["Chr01_block_1", "Chr01:4:ctgC"],
    };

    expect(hasDeletableGap(structuredBlocks, selection)).toBe(true);
    expect(hasDeletableGap(structuredBlocks, {
      kind: "contigs",
      ids: ["Chr01_block_1", "Chr01_block_2"],
    })).toBe(false);

    const joined = deleteGapsBetweenSelection(structuredBlocks, selection);
    const model = buildAssemblyEditModel(joined);

    expect(joined[2]?.gapBefore).toBeUndefined();
    expect(joined.slice(0, 3).map((block) => block.assemblyBlockId)).toEqual([
      "Chr01_block_1",
      "Chr01_block_1",
      "Chr01_block_1",
    ]);
    expect(model.assemblyBlocks.map((block) => ({
      id: block.id,
      contigIds: block.contigIds,
      isComposite: block.isComposite,
    }))).toEqual([
      {
        id: "Chr01_block_1",
        contigIds: ["Chr01:1:ctgA", "Chr01:2:ctgB", "Chr01:4:ctgC"],
        isComposite: true,
      },
      {
        id: "Chr01_block_2",
        contigIds: ["Chr01:6:ctgD", "Chr01:7:ctgE"],
        isComposite: true,
      },
      {
        id: "Chr02:1:ctgF",
        contigIds: ["Chr02:1:ctgF"],
        isComposite: false,
      },
    ]);
    expect(joined[5]?.assemblyBlockId).toBeNull();
  });

  it("restores contiguous split siblings to their original contig when their gap is deleted", () => {
    const split = splitContigAtVisualPosition(blocks, "Chr01:1:ctg1", 50);
    const selection = {
      kind: "contigs" as const,
      ids: ["Chr01:1:ctg1:left", "Chr01:1:ctg1:right"],
    };

    expect(hasDeletableGap(split, selection)).toBe(true);
    const joined = deleteGapsBetweenSelection(split, selection);

    expect(joined).toHaveLength(blocks.length);
    expect(joined[0]).toMatchObject({
      id: "Chr01:1:ctg1",
      sourceId: "ctg1",
      sourceStart: 0,
      sourceEnd: 100,
      visualStart: 0,
      visualEnd: 100,
      isSourceSegment: false,
    });
    expect(joined[0]?.gapBefore).toBeUndefined();
    expect(joined[0]?.displayName).toBeUndefined();
    expect(joined.some((block) => block.id.endsWith(":left") || block.id.endsWith(":right"))).toBe(false);
  });

  it("restores a copied source segment to its pre-split segment identity", () => {
    const sourceSegment: ContactMapLayoutBlock[] = [{
      id: "Chr01:1:utg1_d2",
      objectId: "Chr01",
      sourceId: "utg1",
      displayName: "utg1:1-50",
      isSourceSegment: true,
      copyInstanceId: "Chr01:1:utg1_d2",
      sourceStart: 0,
      sourceEnd: 50,
      visualStart: 0,
      visualEnd: 50,
      orientation: "+",
    }];
    const split = splitContigAtVisualPosition(sourceSegment, "Chr01:1:utg1_d2", 25);
    const joined = deleteGapsBetweenSelection(split, {
      kind: "contigs",
      ids: ["Chr01:1:utg1_d2:left", "Chr01:1:utg1_d2:right"],
    });

    expect(joined).toHaveLength(1);
    expect(joined[0]).toMatchObject({
      id: "Chr01:1:utg1_d2",
      displayName: "utg1:1-50",
      isSourceSegment: true,
      sourceStart: 0,
      sourceEnd: 50,
    });
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

  it("hit-tests a split segment before its containing composite block", () => {
    const split = splitContigAtVisualPosition(
      structuredBlocks,
      "Chr01:2:ctgB",
      125,
    );
    const model = buildAssemblyEditModel(split);

    expect(hitTestAssemblyLayout(
      model,
      { x: 110, y: 110 },
      { sizePx: model.totalSpan, tolerancePx: 8 },
    )).toEqual({
      kind: "contig",
      id: "Chr01:2:ctgB:left",
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
    expect(hitTestAssemblyLayout(model, { x: 240, y: 20 }, { sizePx: 330, tolerancePx: 8 })).toEqual({
      kind: "chromosome-boundary",
      id: "Chr01",
    });
    expect(hitTestAssemblyLayout(model, { x: 20, y: 120 }, { sizePx: 330, tolerancePx: 8 })).toBeNull();
    expect(pointSelectsWholeChromosome(model.chromosomes[0], 20, 120)).toBe(false);
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

  it("separates the two chromosome-end insertion choices with opposing hit targets", () => {
    const blocksWithThirdChromosome: ContactMapLayoutBlock[] = [
      ...blocks,
      {
        id: "Chr03:1:ctg4",
        objectId: "Chr03",
        sourceId: "ctg4",
        sourceStart: 0,
        sourceEnd: 70,
        visualStart: 330,
        visualEnd: 400,
        orientation: "+",
      },
    ];
    const model = buildAssemblyEditModel(blocksWithThirdChromosome);
    const selected = new Set(["Chr03:1:ctg4"]);

    expect(chromosomeEndInsertionTargets(model, selected)).toEqual(expect.arrayContaining([
      {
        targetBlockId: "Chr02:1:ctg3",
        targetObjectId: "Chr01",
        visualPosition: 250,
        chromosomeEnd: "end",
      },
      {
        targetBlockId: "Chr02:1:ctg3",
        targetObjectId: "Chr02",
        visualPosition: 250,
        chromosomeEnd: "start",
      },
    ]));
    expect(insertionTargetAtScreenPoint(
      model,
      selected,
      { x: 241, y: 241 },
      { sizePx: 400, tolerancePx: 7 },
    )).toMatchObject({ targetObjectId: "Chr01", chromosomeEnd: "end" });
    expect(insertionTargetAtScreenPoint(
      model,
      selected,
      { x: 259, y: 259 },
      { sizePx: 400, tolerancePx: 7 },
    )).toMatchObject({ targetObjectId: "Chr02", chromosomeEnd: "start" });
  });

  it("retargets a contig to the chosen chromosome end instead of the adjacent chromosome", () => {
    const blocksWithThirdChromosome: ContactMapLayoutBlock[] = [
      ...blocks,
      {
        id: "Chr03:1:ctg4",
        objectId: "Chr03",
        sourceId: "ctg4",
        sourceStart: 0,
        sourceEnd: 70,
        visualStart: 330,
        visualEnd: 400,
        orientation: "+",
      },
    ];
    const moved = moveSelectionBefore(
      blocksWithThirdChromosome,
      { kind: "contigs", ids: ["Chr03:1:ctg4"] },
      "Chr02:1:ctg3",
      "Chr01",
    );

    expect(moved.map((block) => [block.sourceId, block.objectId])).toEqual([
      ["ctg1", "Chr01"],
      ["ctg2", "Chr01"],
      ["ctg4", "Chr01"],
      ["ctg3", "Chr02"],
    ]);
  });

  it("offers chromosome selections insertion at chromosome boundaries and internal contig gaps", () => {
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
    )).toEqual({
      targetBlockId: "Chr01:2:ctg2",
      targetObjectId: "Chr01",
      visualPosition: 100,
    });

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
