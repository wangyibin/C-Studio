import { describe, expect, it } from "vitest";
import { exportAgpText } from "./agpExport";
import type { ContactMapLayoutBlock } from "./importers";
import {
  operationHistoryFilename,
  parseOperationHistory,
  serializeOperationHistory,
} from "./operationHistoryPersistence";
import type { OperationRecord } from "./uiState";

const beforeBlocks: ContactMapLayoutBlock[] = [{
  id: "Chr01:1:ctg1",
  objectId: "Chr01",
  sourceId: "ctg1",
  sourceStart: 0,
  sourceEnd: 100,
  visualStart: 0,
  visualEnd: 100,
  orientation: "+",
}];
const afterBlocks: ContactMapLayoutBlock[] = [{ ...beforeBlocks[0], orientation: "-" }];
const operation: OperationRecord = {
  id: 1,
  type: "reverse",
  label: "Selection reversed",
  position: { x: 0, y: 0 },
  beforeAssembly: { blocks: beforeBlocks, selection: null },
  afterAssembly: { blocks: afterBlocks, selection: null },
};

describe("operation history persistence", () => {
  it("round-trips applied operations for the exact AGP", () => {
    const canonicalAgp = exportAgpText(afterBlocks);
    const text = serializeOperationHistory({
      canonicalAgp,
      operationHistory: [operation],
      redoStack: [],
      nextOperationId: 2,
    });

    expect(parseOperationHistory(text, canonicalAgp)).toEqual({
      operationHistory: [operation],
      redoStack: [],
      nextOperationId: 2,
    });
  });

  it("persists placement recommendation operations", () => {
    const recommendationOperation: OperationRecord = {
      ...operation,
      type: "place_recommendation",
      label: "Placed ctg1 on Chr02 (-)",
    };
    const canonicalAgp = exportAgpText(afterBlocks);
    const text = serializeOperationHistory({
      canonicalAgp,
      operationHistory: [recommendationOperation],
      redoStack: [],
      nextOperationId: 2,
    });

    expect(parseOperationHistory(text, canonicalAgp).operationHistory[0]?.type)
      .toBe("place_recommendation");
  });

  it("round-trips the undone redo branch against its before snapshot", () => {
    const canonicalAgp = exportAgpText(beforeBlocks);
    const text = serializeOperationHistory({
      canonicalAgp,
      operationHistory: [],
      redoStack: [operation],
      nextOperationId: 2,
    });

    expect(parseOperationHistory(text, canonicalAgp)).toEqual({
      operationHistory: [],
      redoStack: [operation],
      nextOperationId: 2,
    });
  });

  it("rejects a stale same-prefix sidecar whose AGP no longer matches", () => {
    const text = serializeOperationHistory({
      canonicalAgp: exportAgpText(afterBlocks),
      operationHistory: [operation],
      redoStack: [],
      nextOperationId: 2,
    });

    expect(() => parseOperationHistory(text, exportAgpText(beforeBlocks)))
      .toThrow("does not match the imported AGP contents");
  });

  it("derives a same-prefix sidecar name across supported AGP names", () => {
    expect(operationHistoryFilename("/tmp/sample.edited.agp")).toBe("sample.edited.history.json");
    expect(operationHistoryFilename("C:\\data\\sample.agp.gz")).toBe("sample.history.json");
    expect(operationHistoryFilename("assembly.txt")).toBe("assembly.history.json");
  });
});
