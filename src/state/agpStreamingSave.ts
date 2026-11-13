import type { OperationHistoryArchive } from "./operationHistoryPersistence";

export const agpSaveChunkChars = 128 * 1024;

// Serialize leaf records independently, never stringify an entire history or snapshot.
function* jsonTokens(value: unknown): Generator<string> {
  if (value === null || typeof value !== "object") {
    yield JSON.stringify(value) ?? "null";
  } else if (Array.isArray(value)) {
    yield "[";
    for (let i = 0; i < value.length; i++) {
      if (i) yield ",";
      yield* jsonTokens(value[i]);
    }
    yield "]";
  } else {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    if (entries.every(([, item]) => item === null || typeof item !== "object")) {
      yield JSON.stringify(value);
      return;
    }
    yield "{";
    for (let i = 0; i < entries.length; i++) {
      if (i) yield ",";
      yield JSON.stringify(entries[i][0]) + ":";
      yield* jsonTokens(entries[i][1]);
    }
    yield "}";
  }
}

export function* boundedTextChunks(tokens: Iterable<string>): Generator<string> {
  let pending = "";
  for (const token of tokens) {
    let offset = 0;
    while (offset < token.length) {
      let count = Math.min(agpSaveChunkChars - pending.length, token.length - offset);
      // Do not split a Unicode surrogate pair across native UTF-8 writes.
      const last = token.charCodeAt(offset + count - 1);
      if (last >= 0xd800 && last <= 0xdbff && offset + count < token.length) count--;
      if (count === 0) {
        yield pending;
        pending = "";
        continue;
      }
      pending += token.slice(offset, offset + count);
      offset += count;
      if (pending.length === agpSaveChunkChars) {
        yield pending;
        pending = "";
      }
    }
  }
  if (pending) yield pending;
}

export function operationHistoryChunks(input: OperationHistoryArchive & { canonicalAgp: string }) {
  return boundedTextChunks(jsonTokens({
    format: "c-studio-operation-history",
    version: 1,
    ...input,
  }));
}

type SaveInvoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>;

export async function writeAgpBundleStreaming(
  invoke: SaveInvoke,
  path: string,
  input: OperationHistoryArchive & { canonicalAgp: string },
  requireExisting = false,
): Promise<string | null> {
  const session = await invoke<number | null>("begin_agp_stream_save", { path, requireExisting });
  if (session === null) return null;
  try {
    for (const [part, chunks] of [
      ["agp", boundedTextChunks([input.canonicalAgp])],
      ["history", operationHistoryChunks(input)],
    ] as const) {
      for (const contents of chunks) {
        await invoke("append_agp_stream_save", { session, part, contents });
      }
    }
    return await invoke<string>("finish_agp_stream_save", { session });
  } catch (error) {
    await invoke("abort_agp_stream_save", { session }).catch(() => undefined);
    throw error;
  }
}
