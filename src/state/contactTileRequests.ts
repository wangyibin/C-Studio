import {
  canonicalContactTile,
  contactTileCacheKey,
  type ContactTileCacheKeyResolver,
  type ContactMapTileKey,
} from "./contactTiles";

interface ContactTileFlight<Tile> {
  requestId: number;
  promise: Promise<Tile>;
}

export interface LoadContactTileBatchInput<Tile extends ContactMapTileKey> {
  scope: string;
  tiles: ContactMapTileKey[];
  cacheKeyForTile?: ContactTileCacheKeyResolver;
  nextRequestId: () => number;
  load: (requestId: number, tiles: ContactMapTileKey[]) => Promise<Tile[]>;
}

/**
 * Shares one promise per scoped tile while a backend batch is in flight.
 * Entries are removed by identity so a late completion can never delete a
 * newer retry for the same tile.
 */
export class ContactTileFlightRegistry<Tile extends ContactMapTileKey> {
  private readonly flights = new Map<string, ContactTileFlight<Tile>>();

  requestIdsFor(
    scope: string,
    tiles: ContactMapTileKey[],
    cacheKeyForTile: ContactTileCacheKeyResolver = (tile) => contactTileCacheKey(scope, tile),
  ): number[] {
    const requestIds = new Set<number>();
    for (const tile of tiles) {
      const flight = this.flights.get(cacheKeyForTile(tile));
      if (flight) {
        requestIds.add(flight.requestId);
      }
    }
    return [...requestIds];
  }

  loadBatch({
    scope,
    tiles,
    cacheKeyForTile = (tile) => contactTileCacheKey(scope, tile),
    nextRequestId,
    load,
  }: LoadContactTileBatchInput<Tile>): Promise<Tile[]> {
    const requestedTiles = tiles.map(canonicalContactTile);
    const promisesByKey = new Map<string, Promise<Tile>>();
    const missingTilesByKey = new Map<string, ContactMapTileKey>();

    for (const tile of requestedTiles) {
      const key = cacheKeyForTile(tile);
      const existing = this.flights.get(key);
      if (existing) {
        promisesByKey.set(key, existing.promise);
      } else {
        missingTilesByKey.set(key, tile);
      }
    }

    if (missingTilesByKey.size > 0) {
      const requestId = nextRequestId();
      const missingTiles = [...missingTilesByKey.values()];
      // Defer the loader by one microtask so every tile flight is published
      // synchronously before another caller can claim an overlapping tile.
      const responseByKey = Promise.resolve()
        .then(() => load(requestId, missingTiles))
        .then((loadedTiles) => {
          const loadedByKey = new Map<string, Tile>();
          for (const tile of loadedTiles) {
            loadedByKey.set(cacheKeyForTile(tile), tile);
          }
          for (const key of missingTilesByKey.keys()) {
            if (!loadedByKey.has(key)) {
              throw new Error(`contact tile response missing ${key}`);
            }
          }
          return loadedByKey;
        });

      for (const [key] of missingTilesByKey) {
        let entry!: ContactTileFlight<Tile>;
        const promise = responseByKey.then(
          (loadedByKey) => {
            this.deleteIfCurrent(key, entry);
            return loadedByKey.get(key) as Tile;
          },
          (error: unknown) => {
            this.deleteIfCurrent(key, entry);
            throw error;
          },
        );
        entry = { requestId, promise };
        this.flights.set(key, entry);
        promisesByKey.set(key, promise);
      }
    }

    return Promise.all(
      requestedTiles.map((tile) => {
        const key = cacheKeyForTile(tile);
        const promise = promisesByKey.get(key) ?? this.flights.get(key)?.promise;
        if (!promise) {
          return Promise.reject(new Error(`contact tile flight missing ${key}`));
        }
        return promise;
      }),
    );
  }

  clear(): void {
    this.flights.clear();
  }

  get size(): number {
    return this.flights.size;
  }

  private deleteIfCurrent(key: string, entry: ContactTileFlight<Tile>): void {
    if (this.flights.get(key) === entry) {
      this.flights.delete(key);
    }
  }
}
