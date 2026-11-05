import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exportAgpText } from "../../src/state/agpExport";
import { parseAgpLayout } from "../../src/state/importers";
import {
  operationHistoryFilename,
  parseOperationHistory,
  serializeOperationHistory,
} from "../../src/state/operationHistoryPersistence";
import { createInitialUiState, reduceUiState, type UiState } from "../../src/state/uiState";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/curation/${name}`, import.meta.url), "utf8");
const inputAgp = fixture("input.agp");
const expectedAgp = fixture("edited.agp");
const beforeSplitAgp = fixture("before-split.agp");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function curate(): UiState {
  let state = reduceUiState(createInitialUiState("Workflow regression"), {
    type: "setAssemblyBlocks", blocks: parseAgpLayout(inputAgp).blocks,
  });
  state = reduceUiState(state, { type: "selectAssemblyChromosome", id: "Chr02" });
  state = reduceUiState(state, { type: "moveAssemblySelectionBefore", targetBlockId: "Chr01:1:ctgA" });
  state = reduceUiState(state, { type: "selectAssemblyContig", id: "Chr01:3:ctgB", additive: false });
  state = reduceUiState(state, { type: "reverseAssemblySelection" });
  // Chr02 occupies [0, 8200); ctgB starts at 8200 + 4100 = 12300.
  state = reduceUiState(state, { type: "splitAssemblyContig", blockId: "Chr01:3:ctgB", visualPosition: 14300 });
  return state;
}

function saveAndReload(state: UiState): UiState {
  const directory = mkdtempSync(join(tmpdir(), "cstudio-curation-"));
  temporaryDirectories.push(directory);
  const agpPath = join(directory, "curated.agp");
  const historyPath = join(directory, operationHistoryFilename(agpPath));
  const canonicalAgp = exportAgpText(state.assembly.blocks);
  writeFileSync(agpPath, canonicalAgp);
  writeFileSync(historyPath, serializeOperationHistory({
    canonicalAgp,
    operationHistory: state.operationHistory,
    redoStack: state.redoStack,
    nextOperationId: state.nextOperationId,
  }));

  const layout = parseAgpLayout(readFileSync(agpPath, "utf8"));
  const history = parseOperationHistory(readFileSync(historyPath, "utf8"), exportAgpText(layout.blocks));
  return reduceUiState(createInitialUiState("Reopened project"), {
    type: "restoreAssemblyHistory", blocks: layout.blocks, ...history,
  });
}

describe("curation workflow with real AGP and history files", () => {
  it("imports, moves, reverses, splits, undoes/redoes, saves and reloads the reviewed result", () => {
    let state = curate();
    expect(exportAgpText(state.assembly.blocks)).toBe(expectedAgp);
    expect(state.operationHistory.map(({ type }) => type)).toEqual(["move", "reverse", "split_contig"]);
    expect(state.nextOperationId).toBe(4);
    expect(state.assembly.blocks.reduce((sum, block) => sum + block.sourceEnd - block.sourceStart, 0)).toBe(16000);

    state = reduceUiState(state, { type: "undo" });
    expect(exportAgpText(state.assembly.blocks)).toBe(beforeSplitAgp);
    state = reduceUiState(state, { type: "redo" });
    expect(exportAgpText(state.assembly.blocks)).toBe(expectedAgp);

    const reopened = saveAndReload(state);
    expect(exportAgpText(reopened.assembly.blocks)).toBe(expectedAgp);
    expect(reopened.operationHistory).toEqual(state.operationHistory);
    expect(reopened.redoStack).toEqual([]);
    expect(reopened.nextOperationId).toBe(4);
    expect(parseAgpLayout(expectedAgp).totalSpan).toBe(16400);

    let restored = reopened;
    for (let i = 0; i < 3; i++) restored = reduceUiState(restored, { type: "undo" });
    expect(exportAgpText(restored.assembly.blocks)).toBe(inputAgp);
    for (let i = 0; i < 3; i++) restored = reduceUiState(restored, { type: "redo" });
    expect(exportAgpText(restored.assembly.blocks)).toBe(expectedAgp);
  });

  it("preserves an undone branch on disk and replaces it when a new edit is made", () => {
    const undone = reduceUiState(curate(), { type: "undo" });
    let reopened = saveAndReload(undone);
    expect(exportAgpText(reopened.assembly.blocks)).toBe(beforeSplitAgp);
    expect(reopened.operationHistory).toHaveLength(2);
    expect(reopened.redoStack.map(({ type }) => type)).toEqual(["split_contig"]);
    expect(exportAgpText(reduceUiState(reopened, { type: "redo" }).assembly.blocks)).toBe(expectedAgp);

    // After parsing AGP again, look up its new row ID rather than reusing an old UI ID.
    const contig = reopened.assembly.blocks.find(({ sourceId }) => sourceId === "ctgB")!;
    reopened = reduceUiState(reopened, { type: "selectAssemblyContig", id: contig.id, additive: false });
    reopened = reduceUiState(reopened, { type: "reverseAssemblySelection" });
    expect(reopened.redoStack).toEqual([]);
    expect(reopened.operationHistory.at(-1)?.id).toBe(4);
    expect(reopened.nextOperationId).toBe(5);
    expect(exportAgpText(saveAndReload(reopened).assembly.blocks)).toBe(exportAgpText(reopened.assembly.blocks));
  });

  it("rejects a history file paired with a different AGP without changing the imported layout", () => {
    const state = curate();
    const history = serializeOperationHistory({
      canonicalAgp: expectedAgp,
      operationHistory: state.operationHistory,
      redoStack: state.redoStack,
      nextOperationId: state.nextOperationId,
    });
    const imported = parseAgpLayout(inputAgp);
    expect(() => parseOperationHistory(history, exportAgpText(imported.blocks))).toThrow(/does not match/);
    expect(exportAgpText(imported.blocks)).toBe(inputAgp);
  });
});
