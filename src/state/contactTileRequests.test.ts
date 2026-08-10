import { describe, expect, it } from "vitest";
import type { ContactMapLayoutBlock } from "./importers";
import {
  createContactTileCacheKeyResolver,
  type ContactMapTileKey,
} from "./contactTiles";
import { ContactTileFlightRegistry } from "./contactTileRequests";

interface TestTile extends ContactMapTileKey {
  value: string;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

describe("contact tile in-flight requests", () => {
  it("loads partially overlapping batches only once per tile", async () => {
    const registry = new ContactTileFlightRegistry<TestTile>();
    const first = deferred<TestTile[]>();
    const second = deferred<TestTile[]>();
    const calls: ContactMapTileKey[][] = [];
    let requestId = 0;
    const load = (_id: number, tiles: ContactMapTileKey[]) => {
      calls.push(tiles);
      return calls.length === 1 ? first.promise : second.promise;
    };
    const tileA = { tileX: 0, tileY: 0 };
    const tileB = { tileX: 0, tileY: 1 };
    const tileC = { tileX: 1, tileY: 1 };

    const firstResult = registry.loadBatch({
      scope: "scope",
      tiles: [tileA, tileB],
      nextRequestId: () => ++requestId,
      load,
    });
    const secondResult = registry.loadBatch({
      scope: "scope",
      tiles: [tileB, tileC],
      nextRequestId: () => ++requestId,
      load,
    });
    await Promise.resolve();

    expect(calls).toEqual([[tileA, tileB], [tileC]]);
    expect(registry.requestIdsFor("scope", [tileA, tileB, tileC])).toEqual([1, 2]);

    first.resolve([
      { ...tileA, value: "A" },
      { ...tileB, value: "B" },
    ]);
    second.resolve([{ ...tileC, value: "C" }]);

    await expect(firstResult).resolves.toMatchObject([{ value: "A" }, { value: "B" }]);
    await expect(secondResult).resolves.toMatchObject([{ value: "B" }, { value: "C" }]);
    expect(registry.size).toBe(0);
  });

  it("publishes a flight synchronously and shares canonical duplicates", async () => {
    const registry = new ContactTileFlightRegistry<TestTile>();
    const response = deferred<TestTile[]>();
    let loadCount = 0;
    let requestId = 0;
    const load = (_id: number, tiles: ContactMapTileKey[]) => {
      loadCount += 1;
      expect(tiles).toEqual([{ tileX: 2, tileY: 5 }]);
      return response.promise;
    };

    const upper = registry.loadBatch({
      scope: "scope",
      tiles: [{ tileX: 2, tileY: 5 }],
      nextRequestId: () => ++requestId,
      load,
    });
    const lower = registry.loadBatch({
      scope: "scope",
      tiles: [{ tileX: 5, tileY: 2 }],
      nextRequestId: () => ++requestId,
      load,
    });
    await Promise.resolve();

    expect(loadCount).toBe(1);
    response.resolve([{ tileX: 2, tileY: 5, value: "shared" }]);
    await expect(upper).resolves.toMatchObject([{ value: "shared" }]);
    await expect(lower).resolves.toMatchObject([{ value: "shared" }]);
  });

  it("cleans rejected flights so a current generation can retry", async () => {
    const registry = new ContactTileFlightRegistry<TestTile>();
    const tile = { tileX: 3, tileY: 3 };
    let loadCount = 0;
    let requestId = 0;
    const load = async (): Promise<TestTile[]> => {
      loadCount += 1;
      if (loadCount === 1) {
        throw new Error("contact tile request cancelled");
      }
      return [{ ...tile, value: "retry" }];
    };

    await expect(registry.loadBatch({
      scope: "scope",
      tiles: [tile],
      nextRequestId: () => ++requestId,
      load,
    })).rejects.toThrow("cancelled");
    expect(registry.size).toBe(0);

    await expect(registry.loadBatch({
      scope: "scope",
      tiles: [tile],
      nextRequestId: () => ++requestId,
      load,
    })).resolves.toMatchObject([{ value: "retry" }]);
    expect(loadCount).toBe(2);
  });

  it("does not let a late old completion delete a replacement flight", async () => {
    const registry = new ContactTileFlightRegistry<TestTile>();
    const oldResponse = deferred<TestTile[]>();
    const newResponse = deferred<TestTile[]>();
    const tile = { tileX: 4, tileY: 6 };
    let loadCount = 0;
    let requestId = 0;
    const load = () => {
      loadCount += 1;
      return loadCount === 1 ? oldResponse.promise : newResponse.promise;
    };

    const oldResult = registry.loadBatch({
      scope: "scope",
      tiles: [tile],
      nextRequestId: () => ++requestId,
      load,
    });
    await Promise.resolve();
    registry.clear();
    const newResult = registry.loadBatch({
      scope: "scope",
      tiles: [tile],
      nextRequestId: () => ++requestId,
      load,
    });
    await Promise.resolve();

    oldResponse.resolve([{ ...tile, value: "old" }]);
    await expect(oldResult).resolves.toMatchObject([{ value: "old" }]);
    expect(registry.requestIdsFor("scope", [tile])).toEqual([2]);

    newResponse.resolve([{ ...tile, value: "new" }]);
    await expect(newResult).resolves.toMatchObject([{ value: "new" }]);
    expect(registry.size).toBe(0);
  });

  it("does not share an in-flight tile across normalization modes", async () => {
    const registry = new ContactTileFlightRegistry<TestTile>();
    const tile = { tileX: 1, tileY: 4 };
    const layoutBlocks: ContactMapLayoutBlock[] = [{
      id: "block-a",
      objectId: "Chr01",
      sourceId: "A",
      sourceStart: 0,
      sourceEnd: 100,
      visualStart: 0,
      visualEnd: 100,
      orientation: "+",
    }];
    const rawKey = createContactTileCacheKeyResolver(
      "/tmp/input.cool",
      10,
      10,
      "raw",
      layoutBlocks,
    );
    const krKey = createContactTileCacheKeyResolver(
      "/tmp/input.cool",
      10,
      10,
      "kr",
      layoutBlocks,
    );
    let loadCount = 0;
    let requestId = 0;
    const load = async (): Promise<TestTile[]> => {
      loadCount += 1;
      return [{ ...tile, value: String(loadCount) }];
    };

    await Promise.all([
      registry.loadBatch({
        scope: "raw-render",
        tiles: [tile],
        cacheKeyForTile: rawKey,
        nextRequestId: () => ++requestId,
        load,
      }),
      registry.loadBatch({
        scope: "kr-render",
        tiles: [tile],
        cacheKeyForTile: krKey,
        nextRequestId: () => ++requestId,
        load,
      }),
    ]);

    expect(loadCount).toBe(2);
  });

  it("rejects and cleans a batch when the backend omits a tile", async () => {
    const registry = new ContactTileFlightRegistry<TestTile>();
    const tile = { tileX: 7, tileY: 8 };

    await expect(registry.loadBatch({
      scope: "scope",
      tiles: [tile],
      nextRequestId: () => 1,
      load: async () => [],
    })).rejects.toThrow("response missing");
    expect(registry.size).toBe(0);
  });

  it("shares unaffected flights while isolating an edited tile in the same batch", async () => {
    const layout = (order: string[], reverseSource?: string): ContactMapLayoutBlock[] => (
      order.map((sourceId, index) => ({
        id: `block-${sourceId}`,
        objectId: "Chr01",
        sourceId,
        sourceStart: 0,
        sourceEnd: 100,
        visualStart: index * 100,
        visualEnd: (index + 1) * 100,
        orientation: sourceId === reverseSource ? "-" : "+",
      }))
    );
    const sources = ["A", "B", "C", "D", "E", "F"];
    const oldKey = createContactTileCacheKeyResolver(
      "/tmp/input.cool",
      10,
      10,
      "raw",
      layout(sources),
    );
    const newKey = createContactTileCacheKeyResolver(
      "/tmp/input.cool",
      10,
      10,
      "raw",
      layout(sources, "B"),
    );
    const registry = new ContactTileFlightRegistry<TestTile>();
    const oldResponse = deferred<TestTile[]>();
    const newResponse = deferred<TestTile[]>();
    const affected = { tileX: 1, tileY: 4 };
    const unaffected = { tileX: 0, tileY: 4 };
    const calls: ContactMapTileKey[][] = [];
    let requestId = 0;

    const oldResult = registry.loadBatch({
      scope: "old-render-revision",
      tiles: [affected, unaffected],
      cacheKeyForTile: oldKey,
      nextRequestId: () => ++requestId,
      load: async (_id, tiles) => {
        calls.push(tiles);
        return oldResponse.promise;
      },
    });
    await Promise.resolve();

    expect(registry.requestIdsFor(
      "new-render-revision",
      [affected, unaffected],
      newKey,
    )).toEqual([1]);

    const newResult = registry.loadBatch({
      scope: "new-render-revision",
      tiles: [affected, unaffected],
      cacheKeyForTile: newKey,
      nextRequestId: () => ++requestId,
      load: async (_id, tiles) => {
        calls.push(tiles);
        return newResponse.promise;
      },
    });
    await Promise.resolve();
    expect(calls).toEqual([[affected, unaffected], [affected]]);
    expect(registry.requestIdsFor(
      "new-render-revision",
      [affected, unaffected],
      newKey,
    )).toEqual([2, 1]);

    newResponse.resolve([{ ...affected, value: "new-affected" }]);
    await Promise.resolve();
    oldResponse.resolve([
      { ...affected, value: "old-affected" },
      { ...unaffected, value: "shared-unaffected" },
    ]);

    await expect(oldResult).resolves.toMatchObject([
      { value: "old-affected" },
      { value: "shared-unaffected" },
    ]);
    await expect(newResult).resolves.toMatchObject([
      { value: "new-affected" },
      { value: "shared-unaffected" },
    ]);
    expect(registry.size).toBe(0);
  });
});
