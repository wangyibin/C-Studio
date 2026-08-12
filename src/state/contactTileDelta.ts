import type { ContactMapTile } from "../App";
import { forEachContactTileCell } from "./contactTileData";
import {
  canonicalContactTile,
  contactTileKey,
  type ContactMapTileKey,
} from "./contactTiles";
import type { ContactViewport } from "./contactViewport";

export interface ContactTileDenseDeltaBuffer {
  tile: ContactMapTileKey;
  counts: Float64Array;
  occupied: Uint8Array;
  occupiedCount: number;
}

export interface ContactTileDeltaBatch {
  deltas: readonly ContactMapTile[];
  changedTileKeys: readonly string[];
}

export type ContactTileDeltaListener = (batch: ContactTileDeltaBatch) => void;

/** A stable imperative stream handle; React only sees its start and end. */
export interface ContactTileDeltaRenderStream {
  generation: number;
  resolution: number;
  viewport: ContactViewport;
  accumulator: ContactTileDeltaAccumulator;
  onFirstPaint?: () => void;
}

/**
 * Frontend half of the additive single-scan protocol. Dense per-tile buffers
 * make repeated cell updates O(1), while final snapshots return the existing
 * sparse packed tile shape consumed by the renderer and LRU.
 */
export class ContactTileDeltaAccumulator {
  private readonly tiles = new Map<string, ContactTileDenseDeltaBuffer>();
  private readonly listeners = new Set<ContactTileDeltaListener>();
  private snapshotBuildCountValue = 0;

  constructor(
    requestedTiles: readonly ContactMapTileKey[],
    readonly tileSizeBins: number,
  ) {
    if (!Number.isSafeInteger(tileSizeBins) || tileSizeBins < 1 || tileSizeBins > 1_024) {
      throw new RangeError("delta tile size must be an integer in 1..1024");
    }
    const cellCapacity = tileSizeBins * tileSizeBins;
    for (const requested of requestedTiles) {
      const tile = canonicalContactTile(requested);
      const key = contactTileKey(tile);
      if (!this.tiles.has(key)) {
        this.tiles.set(key, {
          tile,
          counts: new Float64Array(cellCapacity),
          occupied: new Uint8Array(cellCapacity),
          occupiedCount: 0,
        });
      }
    }
  }

  /**
   * Add one streamed batch without materializing cumulative sparse tiles.
   * Renderers subscribe to the raw delta and read exact cumulative values from
   * the fixed dense buffers. LRU-ready snapshots are deferred to finish().
   */
  merge(deltas: readonly ContactMapTile[]): string[] {
    const changed = new Set<string>();
    for (const delta of deltas) {
      const key = contactTileKey(delta);
      const target = this.tiles.get(key);
      if (!target) {
        throw new Error(`contact tile delta contains unrequested tile ${key}`);
      }
      forEachContactTileCell(delta, this.tileSizeBins, (xBin, yBin, count) => {
        const xLocal = xBin - target.tile.tileX * this.tileSizeBins;
        const yLocal = yBin - target.tile.tileY * this.tileSizeBins;
        if (
          xLocal < 0
          || xLocal >= this.tileSizeBins
          || yLocal < 0
          || yLocal >= this.tileSizeBins
        ) {
          throw new RangeError(`contact tile delta cell is outside ${key}`);
        }
        const index = yLocal * this.tileSizeBins + xLocal;
        if (target.occupied[index] === 0) {
          target.occupied[index] = 1;
          target.occupiedCount += 1;
        }
        target.counts[index] += count;
        changed.add(key);
      });
    }
    const changedTileKeys = [...changed];
    if (changedTileKeys.length > 0) {
      const batch = { deltas, changedTileKeys };
      for (const listener of this.listeners) {
        listener(batch);
      }
    }
    return changedTileKeys;
  }

  subscribe(listener: ContactTileDeltaListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  denseBuffer(tile: ContactMapTileKey): ContactTileDenseDeltaBuffer | undefined {
    return this.tiles.get(contactTileKey(canonicalContactTile(tile)));
  }

  denseBuffers(): readonly ContactTileDenseDeltaBuffer[] {
    return [...this.tiles.values()];
  }

  snapshotTiles(tileKeys: readonly string[]): ContactMapTile[] {
    return tileKeys.map((key) => {
      const tile = this.tiles.get(key);
      if (!tile) {
        throw new Error(`contact tile snapshot contains unrequested tile ${key}`);
      }
      return this.snapshot(tile);
    });
  }

  finish(): ContactMapTile[] {
    return [...this.tiles.values()]
      .sort((left, right) => (
        left.tile.tileY - right.tile.tileY || left.tile.tileX - right.tile.tileX
      ))
      .map((tile) => this.snapshot(tile));
  }

  get allocatedBytes() {
    let bytes = 0;
    for (const tile of this.tiles.values()) {
      bytes += tile.counts.byteLength + tile.occupied.byteLength;
    }
    return bytes;
  }

  get snapshotBuildCount() {
    return this.snapshotBuildCountValue;
  }

  private snapshot(tile: ContactTileDenseDeltaBuffer): ContactMapTile {
    this.snapshotBuildCountValue += 1;
    const xLocal = new Uint16Array(tile.occupiedCount);
    const yLocal = new Uint16Array(tile.occupiedCount);
    const counts = new Float64Array(tile.occupiedCount);
    let output = 0;
    for (let index = 0; index < tile.occupied.length; index += 1) {
      if (tile.occupied[index] === 0) {
        continue;
      }
      xLocal[output] = index % this.tileSizeBins;
      yLocal[output] = Math.floor(index / this.tileSizeBins);
      counts[output] = tile.counts[index];
      output += 1;
    }
    return {
      tileX: tile.tile.tileX,
      tileY: tile.tile.tileY,
      cells: [],
      packedCells: { xLocal, yLocal, counts },
    };
  }
}
