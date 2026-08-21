import type { ContactMapTile } from "../App";
import { forEachContactTileCell } from "./contactTileData";
import {
  contactTileR16fEmptySentinel,
  contactTileR16fIsFinite,
} from "./contactTileR16f";
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
  /** Completed display-cache payload; authoritative `-1`-sentinel Float32 texture data. */
  completeValues?: Float32Array;
  /** Completed GPU-ready display-cache payload; `0xbc00` is the empty sentinel. */
  completeR16fValues?: Uint16Array;
}

export interface ContactTileDenseFloat32Payload {
  tileX: number;
  tileY: number;
  values: Float32Array;
  occupiedCount: number;
  format?: "float32";
}

export interface ContactTileDenseR16fPayload {
  tileX: number;
  tileY: number;
  values: Uint16Array;
  occupiedCount: number;
  format: "r16f";
}

export type ContactTileDenseCompletePayload =
  | ContactTileDenseFloat32Payload
  | ContactTileDenseR16fPayload;

export interface ContactTileDeltaBatch {
  deltas: readonly ContactMapTile[];
  changedTileKeys: readonly string[];
  denseCompleteTileKeys?: readonly string[];
}

export type ContactTileDeltaListener = (batch: ContactTileDeltaBatch) => void;

/**
 * Cumulative pixels observed before the stream's terminal sentinel. This shape
 * is deliberately not a ContactMapTile[] so it cannot be passed accidentally
 * to an authoritative cache merge that expects completed tiles from finish().
 */
export interface ContactTileDeltaPreviewBatch {
  completeness: "partial";
  tiles: ContactMapTile[];
}

/** Merge complete progressive tiles once; duplicate chunks must not add counts twice. */
export function mergeCompleteContactTilesIntoDeltaAccumulator(
  accumulator: ContactTileDeltaAccumulator,
  mergedTileKeys: Set<string>,
  tiles: readonly ContactMapTile[],
) {
  const unseenTiles = tiles.filter((tile) => !mergedTileKeys.has(contactTileKey(tile)));
  const changed = accumulator.merge(unseenTiles);
  for (const tile of unseenTiles) {
    mergedTileKeys.add(contactTileKey(tile));
  }
  return changed;
}

/** A stable imperative stream handle; React only sees its start and end. */
export interface ContactTileDeltaRenderStream {
  generation: number;
  resolution: number;
  viewport: ContactViewport;
  accumulator: ContactTileDeltaAccumulator;
  /** Populate the hidden back GPU surface instead of overlaying the retained front frame. */
  retainPreviousFrame?: boolean;
  onFirstPaint?: () => void;
}

/**
 * Frontend half of the additive single-scan protocol. Dense per-tile buffers
 * make repeated cell updates O(1). Final snapshots keep completed cache hits
 * in their Float32/R16F wire format and pack only genuinely streamed sparse tiles for the LRU.
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
      if (target.completeValues || target.completeR16fValues) {
        throw new Error(`contact tile delta follows a completed dense tile ${key}`);
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

  /** Install terminal Float32/R16F display tiles without rebuilding sparse cells. */
  mergeDenseComplete(tiles: readonly ContactTileDenseCompletePayload[]): string[] {
    const changedTileKeys: string[] = [];
    const expectedValues = this.tileSizeBins * this.tileSizeBins;
    for (const dense of tiles) {
      if (dense.tileX > dense.tileY) {
        throw new RangeError("dense contact tiles must use canonical coordinates");
      }
      const tile = canonicalContactTile({ tileX: dense.tileX, tileY: dense.tileY });
      const key = contactTileKey(tile);
      const target = this.tiles.get(key);
      if (!target) {
        throw new Error(`dense contact tile contains unrequested tile ${key}`);
      }
      if (target.occupiedCount !== 0 || target.completeValues || target.completeR16fValues) {
        throw new Error(`dense contact tile replaces existing data ${key}`);
      }
      if (dense.values.length !== expectedValues) {
        throw new RangeError(`dense contact tile ${key} does not match tile size`);
      }
      let occupiedCount = 0;
      if (dense.format === "r16f") {
        for (const value of dense.values) {
          if (!contactTileR16fIsFinite(value)) {
            throw new RangeError(`dense R16F contact tile ${key} contains a non-finite value`);
          }
          if (value !== contactTileR16fEmptySentinel) {
            occupiedCount += 1;
          }
        }
        target.completeR16fValues = dense.values;
      } else {
        for (const value of dense.values) {
          if (!Number.isFinite(value)) {
            throw new RangeError(`dense contact tile ${key} contains a non-finite value`);
          }
          if (value !== -1) {
            occupiedCount += 1;
          }
        }
        target.completeValues = dense.values;
      }
      if (occupiedCount !== dense.occupiedCount) {
        throw new RangeError(`dense contact tile ${key} occupied count mismatch`);
      }
      target.occupiedCount = occupiedCount;
      // Completed cache hits no longer need the additive Float64/occupancy staging pair.
      target.counts = new Float64Array(0);
      target.occupied = new Uint8Array(0);
      changedTileKeys.push(key);
    }
    if (changedTileKeys.length > 0) {
      const batch = {
        deltas: [] as readonly ContactMapTile[],
        changedTileKeys,
        denseCompleteTileKeys: changedTileKeys,
      };
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

  previewBatch(tileKeys: readonly string[]): ContactTileDeltaPreviewBatch {
    return {
      completeness: "partial",
      tiles: tileKeys.map((key) => {
        const tile = this.tiles.get(key);
        if (!tile) {
          throw new Error(`contact tile snapshot contains unrequested tile ${key}`);
        }
        return this.snapshot(tile);
      }),
    };
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
      bytes += tile.counts.byteLength
        + tile.occupied.byteLength
        + (tile.completeValues?.byteLength ?? 0)
        + (tile.completeR16fValues?.byteLength ?? 0);
    }
    return bytes;
  }

  get snapshotBuildCount() {
    return this.snapshotBuildCountValue;
  }

  private snapshot(tile: ContactTileDenseDeltaBuffer): ContactMapTile {
    this.snapshotBuildCountValue += 1;
    if (tile.completeValues) {
      return {
        tileX: tile.tile.tileX,
        tileY: tile.tile.tileY,
        cells: [],
        denseValues: tile.completeValues,
        denseOccupiedCount: tile.occupiedCount,
      };
    }
    if (tile.completeR16fValues) {
      return {
        tileX: tile.tile.tileX,
        tileY: tile.tile.tileY,
        cells: [],
        denseR16fValues: tile.completeR16fValues,
        denseOccupiedCount: tile.occupiedCount,
      };
    }
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
