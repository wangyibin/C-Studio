import { exportAgpText } from "./agpExport";
import { describe, expect, it, vi } from "vitest";
import { agpSaveChunkChars, boundedTextChunks, operationHistoryChunks, writeAgpBundleStreaming } from "./agpStreamingSave";
import { parseOperationHistory, serializeOperationHistory } from "./operationHistoryPersistence";
import type { OperationRecord } from "./uiState";

const operation: OperationRecord = {
  id: 1, type: "reverse", label: "test 🧬", position: { x: 0, y: 0 },
  beforeAssembly: { blocks: [], selection: null },
  afterAssembly: { blocks: [], selection: null },
};
const input = { canonicalAgp: exportAgpText([]), operationHistory: [operation], redoStack: [{ ...operation, id: 2 }], nextOperationId: 3 };

describe("streaming AGP save", () => {
  it("retains the existing history schema, including undo and redo branches", () => {
    const text = [...operationHistoryChunks(input)].join("");
    expect(JSON.parse(text)).toEqual(JSON.parse(serializeOperationHistory(input)));
    expect(parseOperationHistory(text, input.canonicalAgp)).toEqual({
      operationHistory: input.operationHistory, redoStack: input.redoStack, nextOperationId: 3,
    });
  });
  it("bounds chunks and preserves Unicode across native UTF-8 conversions", () => {
    const text = "x".repeat(agpSaveChunkChars - 1) + "🧬" + "中文".repeat(agpSaveChunkChars);
    const chunks = [...boundedTextChunks([text])];
    expect(chunks.every(chunk => chunk.length > 0 && chunk.length <= agpSaveChunkChars)).toBe(true);
    expect(chunks.map(chunk => new TextDecoder().decode(new TextEncoder().encode(chunk))).join("")).toBe(text);
  });
  it("never stringifies a complete history or snapshot", () => {
    const spy = vi.spyOn(JSON, "stringify");
    [...operationHistoryChunks(input)];
    const args = spy.mock.calls.map(call => call[0]);
    spy.mockRestore();
    expect(args).not.toContain(input.operationHistory);
    expect(args).not.toContain(operation);
    expect(args).not.toContain(operation.beforeAssembly);
  });
  it("sends bounded requests sequentially and commits after all chunks", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    invoke.mockResolvedValueOnce(7);
    invoke.mockImplementation(async (command: string) => command === "begin_agp_stream_save" ? 7 : command === "finish_agp_stream_save" ? "/tmp/test.agp" : undefined);
    expect(await writeAgpBundleStreaming(invoke, "/tmp/test.agp", input)).toBe("/tmp/test.agp");
    expect(invoke.mock.calls[invoke.mock.calls.length - 1]?.[0]).toBe("finish_agp_stream_save");
    const writes = invoke.mock.calls.filter(call => call[0] === "append_agp_stream_save");
    expect(writes.map(call => call[1].part)).toEqual(["agp", "history"]);
  });
  it("aborts without committing if a write fails", async () => {
    const invoke = vi.fn().mockResolvedValueOnce(7).mockRejectedValueOnce(new Error("disk full")).mockResolvedValue(undefined);
    await expect(writeAgpBundleStreaming(invoke, "/tmp/test.agp", input)).rejects.toThrow("disk full");
    expect(invoke.mock.calls[invoke.mock.calls.length - 1]).toEqual(["abort_agp_stream_save", { session: 7 }]);
    expect(invoke.mock.calls.some(call => call[0] === "finish_agp_stream_save")).toBe(false);
  });
});
