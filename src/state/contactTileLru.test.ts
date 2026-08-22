import { describe, expect, it } from "vitest";
import {
  contactTileViewportHistoryKeys,
  contactTileRenderCache,
  ContactTileResolutionLru,
  defaultContactTileLruLimits,
  retainContactTileViewportFootprint,
  type ContactTileLruEntry,
} from "./contactTileLru";

interface TestTile {
  label: string;
}

function tile(
  key: string,
  cellCount = 1,
  label = key,
  valueBytes = cellCount,
): ContactTileLruEntry<TestTile> {
  return { key, cellCount, value: { label }, valueBytes };
}

function scope(id: string, resolution: number) {
  return { id, resolution };
}

describe("ContactTileResolutionLru", () => {
  it("uses a byte-bounded backtrack budget across three resolution scopes", () => {
    expect(defaultContactTileLruLimits).toEqual({
      maxScopes: 3,
      maxTiles: 192,
      maxCells: 12_000_000,
      maxBytes: 32 * 1024 * 1024,
    });
    expect(new ContactTileResolutionLru<TestTile>().limits).toEqual(
      defaultContactTileLruLimits,
    );
  });

  it("evicts the least-recently-used whole scope before a newer resolution", () => {
    const cache = new ContactTileResolutionLru<TestTile>({ maxScopes: 2 });
    cache.merge(scope("10-kb", 10_000), [tile("10-a"), tile("10-b")]);
    cache.merge(scope("25-kb", 25_000), [tile("25-a")]);

    expect(cache.get("10-a")).toEqual({ label: "10-a" });
    const result = cache.merge(scope("50-kb", 50_000), [tile("50-a")]);

    expect(result.evicted.map(({ key, reason }) => [key, reason])).toEqual([
      ["25-a", "scope-limit"],
    ]);
    expect(cache.stats().scopes.map(({ id }) => id)).toEqual(["10-kb", "50-kb"]);
    expect(cache.has("10-b")).toBe(true);
  });

  it("keeps same-resolution render scopes independent", () => {
    const cache = new ContactTileResolutionLru<TestTile>();
    cache.merge(scope("raw|layout-a", 25_000), [tile("raw-key")]);
    cache.merge(scope("ice|layout-a", 25_000), [tile("ice-key")]);
    cache.merge(scope("raw|layout-b", 25_000), [tile("edited-key")]);

    expect(cache.stats().scopes).toMatchObject([
      { id: "raw|layout-a", resolution: 25_000, tileCount: 1, cellCount: 1 },
      { id: "ice|layout-a", resolution: 25_000, tileCount: 1, cellCount: 1 },
      { id: "raw|layout-b", resolution: 25_000, tileCount: 1, cellCount: 1 },
    ]);
  });

  it("reassigns a reusable projection key to its newest render scope without duplication", () => {
    const cache = new ContactTileResolutionLru<TestTile>();
    const opaqueKey = "/tmp/a|b.mcool|25000|256|raw|hash:with:colons:0:1";
    cache.merge(scope("layout-a", 25_000), [tile(opaqueKey, 7)]);

    cache.touch(scope("layout-b", 25_000), [opaqueKey]);

    expect(cache.size).toBe(1);
    expect(cache.cellCount).toBe(7);
    expect(cache.stats().scopes).toMatchObject([
      { id: "layout-b", resolution: 25_000, tileCount: 1, cellCount: 7 },
    ]);
    expect(cache.peek(opaqueKey)).toEqual({ label: opaqueKey });
  });

  it("enforces the tile and cell budgets after a complete batch merge", () => {
    const tileLimited = new ContactTileResolutionLru<TestTile>({
      maxScopes: 3,
      maxTiles: 2,
      maxCells: 100,
    });
    const tileResult = tileLimited.merge(scope("scope", 10_000), [
      tile("a"),
      tile("b"),
      tile("c"),
    ]);
    expect(tileResult.evicted).toMatchObject([{ key: "a", reason: "tile-limit" }]);
    expect([...tileLimited.toMap().keys()]).toEqual(["b", "c"]);

    const cellLimited = new ContactTileResolutionLru<TestTile>({
      maxScopes: 3,
      maxTiles: 10,
      maxCells: 5,
    });
    const cellResult = cellLimited.merge(scope("scope", 10_000), [
      tile("a", 2),
      tile("b", 2),
      tile("c", 3),
    ]);
    expect(cellResult.evicted.map(({ key, reason }) => [key, reason])).toEqual([
      ["a", "cell-limit"],
    ]);
    expect(cellLimited.cellCount).toBe(5);
  });

  it("evicts by retained bytes independently of occupied cell count", () => {
    const cache = new ContactTileResolutionLru<TestTile>({
      maxTiles: 10,
      maxCells: 100,
      maxBytes: 400,
    });
    const result = cache.merge(scope("scope", 10_000), [
      tile("a", 1, "a", 100),
      tile("b", 1, "b", 100),
    ]);

    expect(result.evicted.map(({ key, reason }) => [key, reason])).toEqual([
      ["a", "byte-limit"],
    ]);
    expect(cache.residentBytes).toBeLessThanOrEqual(400);
    expect(cache.has("b")).toBe(true);
  });

  it("keeps an over-budget visible assembly complete outside the strict LRU", () => {
    const cache = new ContactTileResolutionLru<TestTile>({
      maxTiles: 10,
      maxCells: 5,
    });
    const visibleAssembly = new Map([
      ["visible-a", { label: "visible-a" }],
      ["visible-b", { label: "visible-b" }],
    ]);

    cache.merge(scope("current", 10_000), [
      tile("visible-a", 3),
      tile("visible-b", 3),
    ]);
    const renderCache = contactTileRenderCache(cache.toMap(), visibleAssembly);

    expect(cache.cellCount).toBeLessThanOrEqual(5);
    expect(cache.size).toBe(1);
    expect([...renderCache.keys()].sort()).toEqual(["visible-a", "visible-b"]);
    expect(visibleAssembly.size).toBe(2);
  });

  it("keeps idle-prefetched scopes behind foreground recency", () => {
    const cache = new ContactTileResolutionLru<TestTile>({ maxScopes: 2 });
    cache.merge(scope("current", 25_000), [tile("current")]);
    cache.merge(
      scope("neighbor", 10_000),
      [tile("prefetched")],
      { recency: "background" },
    );

    expect(cache.stats().scopes.map(({ id }) => id)).toEqual(["neighbor", "current"]);
    expect(cache.view().get("prefetched")).toEqual({ label: "prefetched" });

    const result = cache.merge(scope("next-current", 50_000), [tile("next")]);
    expect(result.evicted.map(({ key, reason }) => [key, reason])).toEqual([
      ["prefetched", "scope-limit"],
    ]);
    expect(cache.has("current")).toBe(true);
  });

  it("does not promote an existing scope when a background batch extends it", () => {
    const cache = new ContactTileResolutionLru<TestTile>();
    cache.merge(scope("neighbor", 10_000), [tile("old-prefetch")]);
    cache.merge(scope("current", 25_000), [tile("current")]);

    cache.merge(
      scope("neighbor", 10_000),
      [tile("new-prefetch")],
      { recency: "background" },
    );

    expect(cache.stats().scopes.map(({ id }) => id)).toEqual(["neighbor", "current"]);
    expect([...cache.view().keys()]).toEqual(["old-prefetch", "current", "new-prefetch"]);
  });

  it("can retain a new adjacent background scope while replacing a stale layer", () => {
    const cache = new ContactTileResolutionLru<TestTile>({ maxScopes: 3 });
    cache.merge(scope("stale-a", 10_000), [tile("stale-a")]);
    cache.merge(scope("stale-b", 25_000), [tile("stale-b")]);
    cache.merge(scope("current", 50_000), [tile("current")]);

    const result = cache.merge(
      scope("adjacent", 100_000),
      [tile("adjacent")],
      {
        recency: "background",
        scopes: new Set(["current", "adjacent"]),
      },
    );

    expect(result.evicted.map(({ key, reason }) => [key, reason])).toEqual([
      ["stale-a", "scope-limit"],
    ]);
    expect(cache.stats().scopes.map(({ id }) => id)).toEqual([
      "adjacent",
      "stale-b",
      "current",
    ]);
  });

  it("admits both adjacent scopes when the shared desired set is protected", () => {
    const cache = new ContactTileResolutionLru<TestTile>({ maxScopes: 3 });
    cache.merge(scope("stale-a", 10_000), [tile("stale-a")]);
    cache.merge(scope("stale-b", 25_000), [tile("stale-b")]);
    cache.merge(scope("current", 50_000), [tile("current")]);
    const desiredScopes = new Set(["current", "coarse", "fine"]);

    cache.merge(
      scope("coarse", 100_000),
      [tile("coarse")],
      { recency: "background", scopes: desiredScopes },
    );
    cache.merge(
      scope("fine", 5_000),
      [tile("fine")],
      { recency: "background", scopes: desiredScopes },
    );

    expect(cache.stats().scopes.map(({ id }) => id)).toEqual([
      "fine",
      "coarse",
      "current",
    ]);
    expect(cache.has("stale-a")).toBe(false);
    expect(cache.has("stale-b")).toBe(false);
  });

  it("prefers evicting unprotected keys while keeping budgets strict", () => {
    const cache = new ContactTileResolutionLru<TestTile>({
      maxTiles: 2,
      maxCells: 100,
    });
    cache.merge(scope("current", 10_000), [tile("visible"), tile("old")]);

    const result = cache.merge(
      scope("current", 10_000),
      [tile("new")],
      { keys: new Set(["visible"]) },
    );

    expect(result.evicted.map(({ key }) => key)).toEqual(["old"]);
    expect([...cache.toMap().keys()]).toEqual(["visible", "new"]);
  });

  it("updates cell accounting and recency when a tile is replaced", () => {
    const cache = new ContactTileResolutionLru<TestTile>({ maxCells: 6 });
    cache.merge(scope("scope", 10_000), [tile("a", 2), tile("b", 2)]);
    cache.merge(scope("scope", 10_000), [tile("a", 4, "replacement")]);

    expect(cache.cellCount).toBe(6);
    expect([...cache.toMap().keys()]).toEqual(["b", "a"]);
    expect(cache.peek("a")).toEqual({ label: "replacement" });
  });

  it("returns detached map snapshots and clears all scope metadata", () => {
    const cache = new ContactTileResolutionLru<TestTile>();
    cache.merge(scope("scope", 10_000), [tile("a")]);
    const snapshot = cache.toMap();
    snapshot.delete("a");

    expect(cache.has("a")).toBe(true);
    cache.clear();
    expect(cache.stats()).toEqual({
      tileCount: 0,
      cellCount: 0,
      residentBytes: 0,
      scopes: [],
    });
  });

  it("rejects ambiguous scope metadata before mutating the cache", () => {
    const cache = new ContactTileResolutionLru<TestTile>();
    cache.merge(scope("same-scope", 10_000), [tile("a")]);

    expect(() => {
      cache.merge(scope("same-scope", 25_000), [tile("b")]);
    }).toThrow(/changed resolution/);
    expect([...cache.toMap().keys()]).toEqual(["a"]);
  });
});

describe("completed viewport residency history", () => {
  it("keeps the newest two distinct footprints and promotes a revisited one", () => {
    let history = retainContactTileViewportFootprint([], ["a", "b"]);
    history = retainContactTileViewportFootprint(history, ["c", "d"]);
    history = retainContactTileViewportFootprint(history, ["e", "f"]);
    expect([...contactTileViewportHistoryKeys(history)].sort()).toEqual(["c", "d", "e", "f"]);

    history = retainContactTileViewportFootprint(history, ["c", "d"]);
    expect(history.map((footprint) => [...footprint])).toEqual([
      ["e", "f"],
      ["c", "d"],
    ]);
  });

  it("does not record an incomplete empty footprint", () => {
    const history = retainContactTileViewportFootprint([], ["visible"]);
    expect(retainContactTileViewportFootprint(history, [])).toBe(history);
  });

  it("evicts unrelated prefetch before either recent viewport footprint", () => {
    const cache = new ContactTileResolutionLru<TestTile>({
      maxTiles: 4,
      maxCells: 100,
      maxBytes: 10_000,
    });
    const activeScope = scope("current", 10_000);
    let history = retainContactTileViewportFootprint([], ["a-1", "a-2"]);
    cache.merge(activeScope, [tile("a-1"), tile("a-2")]);
    cache.merge(activeScope, [tile("prefetch-1"), tile("prefetch-2")], {
      recency: "background",
    });

    history = retainContactTileViewportFootprint(history, ["b-1", "b-2"]);
    cache.merge(activeScope, [tile("b-1"), tile("b-2")], {
      keys: contactTileViewportHistoryKeys(history),
    });

    expect([...cache.toMap().keys()].sort()).toEqual(["a-1", "a-2", "b-1", "b-2"]);
  });
});
