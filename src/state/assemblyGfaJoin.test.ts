import { describe, expect, it } from "vitest";
import { exportAgpText } from "./agpExport";
import {
  createAssemblyBlockFromGfa,
  deleteGapsBetweenSelection,
  dissolveAssemblyBlockSelection,
  splitContigAtVisualPosition,
} from "./assemblyEditing";
import { parseGfaText } from "./gfa";
import { parseAgpLayout } from "./importers";
import { parseOperationHistory, serializeOperationHistory } from "./operationHistoryPersistence";
import { createInitialUiState, reduceUiState } from "./uiState";

function selectedPair(left = "+", right = "+") {
  const layout = parseAgpLayout([
    `Chr01\t1\t100\t1\tW\tctg1\t1\t100\t${left}`,
    "Chr01\t101\t200\t2\tU\t100\tcontig\tno\tna",
    `Chr01\t201\t350\t3\tW\tctg2\t1\t150\t${right}`,
  ].join("\n"));
  let state = reduceUiState(createInitialUiState("Ready"), {
    type: "setAssemblyBlocks", blocks: layout.blocks,
  });
  state = reduceUiState(state, {
    type: "selectAssemblyContigs", ids: layout.blocks.map((block) => block.id),
  });
  return state;
}

function linksFor(record: string) {
  return parseGfaText(`S\tctg1\t*\tLN:i:100\nS\tctg2\t*\tLN:i:150\n${record}`).links;
}

describe("shared gap/join action with imported GFA overlaps", () => {
  it.each([
    ["+", "+"], ["+", "-"], ["-", "+"], ["-", "-"],
  ])("trims a %s/%s boundary once and exports the correct AGP interval", (left, right) => {
    const before = selectedPair(left, right);
    const links = linksFor(`L\tctg1\t${left}\tctg2\t${right}\t10M2=`);
    const joined = reduceUiState(before, { type: "deleteAssemblyGaps", links });
    const trimmed = joined.assembly.blocks[1];

    expect(trimmed).toMatchObject({
      sourceStart: right === "+" ? 12 : 0,
      sourceEnd: right === "+" ? 150 : 138,
      visualStart: 100,
      visualEnd: 238,
      gfaOverlapBefore: { trimmedBases: 12, originalSourceStart: 0, originalSourceEnd: 150 },
    });
    expect(trimmed.gapBefore).toBeUndefined();
    expect(exportAgpText(joined.assembly.blocks)).toBe([
      `Chr01\t1\t100\t1\tW\tctg1\t1\t100\t${left}`,
      `Chr01\t101\t238\t2\tW\tctg2\t${right === "+" ? 13 : 1}\t${right === "+" ? 150 : 138}\t${right}`,
      "",
    ].join("\n"));
    expect(before.assembly.blocks[1].sourceEnd).toBe(150);
    expect(before.assembly.blocks[1].gapBefore?.length).toBe(100);
    expect(joined.operationHistory[joined.operationHistory.length - 1]?.label).toContain("12 bp GFA overlap trimmed");

    const selectedAgain = reduceUiState(joined, {
      type: "selectAssemblyContigs", ids: [trimmed.assemblyBlockId!],
    });
    expect(reduceUiState(selectedAgain, { type: "deleteAssemblyGaps", links })).toBe(selectedAgain);
    const undone = reduceUiState(joined, { type: "undo" });
    expect(exportAgpText(undone.assembly.blocks)).toBe(exportAgpText(before.assembly.blocks));
    expect(exportAgpText(reduceUiState(undone, { type: "redo" }).assembly.blocks))
      .toBe(exportAgpText(joined.assembly.blocks));
  });

  it("accepts reverse-equivalent GFA links", () => {
    const before = selectedPair();
    const joined = reduceUiState(before, {
      type: "deleteAssemblyGaps", links: linksFor("L\tctg2\t-\tctg1\t-\t12M"),
    });
    expect(joined.assembly.blocks[1].sourceStart).toBe(12);
  });

  it.each([["+", "+"], ["+", "-"], ["-", "+"], ["-", "-"]])(
    "uses the trimmed contig's hifiasm overlap for %s/%s regardless of record order",
    (left, right) => {
      const before = selectedPair(left, right);
      const flip = (orientation: string) => orientation === "+" ? "-" : "+";
      const records = [
        `L\tctg1\t${left}\tctg2\t${right}\t12M\tL1:i:88`,
        `L\tctg2\t${flip(right)}\tctg1\t${flip(left)}\t10M\tL1:i:140`,
      ];
      for (const ordered of [records, [...records].reverse()]) {
        const joined = reduceUiState(before, {
          type: "deleteAssemblyGaps", links: linksFor(ordered.join("\n")),
        });
        expect(joined.assembly.blocks[1]).toMatchObject({
          sourceStart: right === "+" ? 10 : 0,
          sourceEnd: right === "+" ? 150 : 140,
          gfaOverlapBefore: { cigar: "10M", trimmedBases: 10 },
        });
      }
    },
  );

  it.each([
    "L\tctg1\t+\tctg2\t+\t12M\nL\tctg2\t-\tctg1\t-\t10M",
    "L\tctg1\t+\tctg2\t+\t12M\tL1:i:88\nL\tctg2\t-\tctg1\t-\t10M\tL1:i:139",
    "L\tctg1\t+\tctg2\t+\t12M\tL1:i:88\nL\tctg1\t+\tctg2\t+\t10M\tL1:i:90",
  ])("still blocks genuinely ambiguous or unverified overlaps: %s", (record) => {
    const before = selectedPair();
    const joined = reduceUiState(before, { type: "deleteAssemblyGaps", links: linksFor(record) });
    expect(joined.assembly).toBe(before.assembly);
    expect(joined.operationHistory).toHaveLength(0);
    expect(joined.logEntries[joined.logEntries.length - 1].message).toContain("Multiple GFA overlaps");
  });

  it("exports the reported alfalfa three-contig join with both source overlaps removed", () => {
    const blocks = parseAgpLayout([
      "Chr07g2\t1\t4275527\t1\tW\tutg000068l\t1\t4275527\t-",
      "Chr07g2\t4275528\t4275627\t2\tU\t100\tcontig\tyes\tmap",
      "Chr07g2\t4275628\t4350794\t3\tW\tutg002455l\t1\t75167\t+",
      "Chr07g2\t4350795\t4350894\t4\tU\t100\tcontig\tyes\tmap",
      "Chr07g2\t4350895\t10855685\t5\tW\tutg000300l\t1\t6504791\t-",
    ].join("\n")).blocks;
    // S/L records from M1_hifi_ul_50k.p_utg.noseq.gfa. The first pair's
    // reciprocal arcs have unequal source lengths, so they are not duplicates.
    const links = parseGfaText([
      "S\tutg000068l\t*\tLN:i:4275527",
      "S\tutg002455l\t*\tLN:i:75167",
      "S\tutg000300l\t*\tLN:i:6504791",
      "L\tutg000068l\t-\tutg002455l\t+\t22922M\tL1:i:4252605\tL2:i:0",
      "L\tutg000300l\t+\tutg002455l\t-\t22098M\tL1:i:6482693\tL2:i:0",
      "L\tutg002455l\t+\tutg000300l\t-\t22098M\tL1:i:53069\tL2:i:0",
      "L\tutg002455l\t-\tutg000068l\t+\t22920M\tL1:i:52247\tL2:i:0",
    ].join("\n")).links;
    const selection = { kind: "contigs" as const, ids: blocks.map((block) => block.id) };
    const joined = deleteGapsBetweenSelection(blocks, selection, links);
    expect(exportAgpText(joined)).toBe([
      "Chr07g2\t1\t4275527\t1\tW\tutg000068l\t1\t4275527\t-",
      "Chr07g2\t4275528\t4327774\t2\tW\tutg002455l\t22921\t75167\t+",
      "Chr07g2\t4327775\t10810467\t3\tW\tutg000300l\t1\t6482693\t-",
      "",
    ].join("\n"));
    expect(joined[1].gfaOverlapBefore?.trimmedBases).toBe(22920);
    expect(joined[2].gfaOverlapBefore?.trimmedBases).toBe(22098);
  });

  it.each([{ links: [] }, { links: linksFor("L\tctg1\t+\tctg2\t+\t0M") }])(
    "keeps source intervals intact without a positive overlap",
    ({ links }) => {
      const joined = reduceUiState(selectedPair(), { type: "deleteAssemblyGaps", links });
      expect(joined.assembly.blocks[1]).toMatchObject({ sourceStart: 0, sourceEnd: 150, visualEnd: 250 });
      expect(joined.assembly.blocks[1].gapBefore).toBeUndefined();
      expect(joined.assembly.blocks[1].gfaOverlapBefore).toBeUndefined();
    },
  );

  it.each([
    ["L\tctg1\t+\tctg2\t+\t10M2I", "not a simple ungapped"],
    ["L\tctg1\t+\tctg2\t+\t*", "not a simple ungapped"],
    ["L\tctg1\t+\tctg2\t+\t150M", "not shorter"],
    ["L\tctg1\t+\tctg2\t-\t12M", "orientation conflicts"],
    ["L\tctg1\t+\tctg2\t+\t12M\nL\tctg1\t+\tctg2\t+\t13M", "Multiple GFA overlaps"],
  ])("rejects unsupported evidence without removing gaps: %s", (record, reason) => {
    const before = selectedPair();
    const after = reduceUiState(before, { type: "deleteAssemblyGaps", links: linksFor(record) });
    expect(after.assembly).toBe(before.assembly);
    expect(after.operationHistory).toBe(before.operationHistory);
    expect(after.logEntries[after.logEntries.length - 1]?.message).toContain(reason);
    expect(after.activeBottomPanel).toBe("messages");
    expect(after.layout.bottomCollapsed).toBe(false);
  });

  it("rejects a positive overlap when either AGP orientation is unknown", () => {
    for (const [left, right] of [["?", "+"], ["+", "na"]]) {
      const before = selectedPair(left, right);
      const after = reduceUiState(before, {
        type: "deleteAssemblyGaps", links: linksFor("L\tctg1\t+\tctg2\t+\t12M"),
      });
      expect(after.assembly).toBe(before.assembly);
      expect(after.logEntries[after.logEntries.length - 1]?.message).toContain("cannot safely resolve");
    }
  });

  it("does not re-trim internal joins when extending a composite block", () => {
    const before = selectedPair();
    const links = linksFor("L\tctg1\t+\tctg2\t+\t12M\nL\tctg2\t+\tctg3\t+\t8M");
    const first = deleteGapsBetweenSelection(before.assembly.blocks, before.assembly.selection, links);
    const extended = [...first, {
      ...before.assembly.blocks[1], id: "ctg3", sourceId: "ctg3", visualStart: 338, visualEnd: 488,
    }];
    const selection = { kind: "contigs" as const, ids: extended.map((block) => block.id) };
    for (const join of [deleteGapsBetweenSelection, createAssemblyBlockFromGfa]) {
      const joined = join(extended, selection, links);
      expect(joined[1].sourceStart).toBe(12);
      expect(joined[1].gfaOverlapBefore).toEqual(first[1].gfaOverlapBefore);
      expect(joined[2].sourceStart).toBe(8);
      const dissolved = dissolveAssemblyBlockSelection(joined, selection);
      expect(dissolved.map((block) => block.sourceStart)).toEqual([0, 0, 0]);
    }
  });

  it("leaves every boundary unchanged if a later selected join is invalid", () => {
    const before = selectedPair();
    const blocks = [...before.assembly.blocks, {
      ...before.assembly.blocks[1], id: "ctg3", sourceId: "ctg3", visualStart: 450, visualEnd: 600,
    }];
    const selection = { kind: "contigs" as const, ids: blocks.map((block) => block.id) };
    const links = linksFor("L\tctg1\t+\tctg2\t+\t12M\nL\tctg2\t+\tctg3\t+\t8M2I");
    expect(deleteGapsBetweenSelection(blocks, selection, links)).toBe(blocks);
    expect(blocks[1].sourceStart).toBe(0);
    expect(blocks[1].gapBefore?.length).toBe(100);
  });

  it("restores split siblings even when their contig has a GFA self-link", () => {
    const original = selectedPair().assembly.blocks.slice(0, 1);
    const split = splitContigAtVisualPosition(original, original[0].id, 50);
    const joined = deleteGapsBetweenSelection(split, {
      kind: "contigs", ids: split.map((block) => block.id),
    }, linksFor("L\tctg1\t+\tctg1\t+\t12M"));
    expect(joined).toHaveLength(1);
    expect(joined[0]).toMatchObject({ id: original[0].id, sourceStart: 0, sourceEnd: 100 });
    expect(joined[0].gfaOverlapBefore).toBeUndefined();
  });

  it("restores overlap metadata from saved history for dissolve and undo", () => {
    const before = selectedPair();
    const joined = reduceUiState(before, {
      type: "deleteAssemblyGaps", links: linksFor("L\tctg1\t+\tctg2\t+\t12M"),
    });
    const canonicalAgp = exportAgpText(joined.assembly.blocks);
    const archive = parseOperationHistory(serializeOperationHistory({
      canonicalAgp, operationHistory: joined.operationHistory,
      redoStack: joined.redoStack, nextOperationId: joined.nextOperationId,
    }), canonicalAgp);
    const reopened = reduceUiState(createInitialUiState("Reopened"), {
      type: "restoreAssemblyHistory", blocks: parseAgpLayout(canonicalAgp).blocks, ...archive,
    });
    expect(reopened.assembly.blocks[1].gfaOverlapBefore).toEqual(joined.assembly.blocks[1].gfaOverlapBefore);
    const selected = reduceUiState(reopened, {
      type: "selectAssemblyContigs", ids: [reopened.assembly.blocks[0].assemblyBlockId!],
    });
    const dissolved = reduceUiState(selected, { type: "dissolveAssemblyBlockSelection" });
    expect(exportAgpText(dissolved.assembly.blocks)).toBe(exportAgpText(before.assembly.blocks));
    expect(exportAgpText(reduceUiState(reopened, { type: "undo" }).assembly.blocks))
      .toBe(exportAgpText(before.assembly.blocks));
  });
});
