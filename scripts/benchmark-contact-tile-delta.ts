import type { ContactMapTile } from "../src/App";
import { ContactTileDeltaAccumulator } from "../src/state/contactTileDelta";

const tileSizeBins = 256;
const tileCount = 16;
const chunkCount = 35;
const cellsPerTilePerChunk = 768;
const requestedTiles = Array.from({ length: tileCount }, (_, index) => ({
  tileX: index % 4,
  tileY: Math.floor(index / 4) + 4,
}));

const chunks = Array.from({ length: chunkCount }, (_, chunkIndex) => (
  requestedTiles.map((tile, tileIndex): ContactMapTile => {
    const xLocal = new Uint16Array(cellsPerTilePerChunk);
    const yLocal = new Uint16Array(cellsPerTilePerChunk);
    const counts = new Float64Array(cellsPerTilePerChunk);
    for (let cell = 0; cell < cellsPerTilePerChunk; cell += 1) {
      xLocal[cell] = (cell * 17 + chunkIndex * 13 + tileIndex) % tileSizeBins;
      yLocal[cell] = (cell * 29 + chunkIndex * 7 + tileIndex * 3) % tileSizeBins;
      counts[cell] = 1 + ((cell + chunkIndex) % 11);
    }
    return { tileX: tile.tileX, tileY: tile.tileY, cells: [], packedCells: {
      xLocal,
      yLocal,
      counts,
    } };
  })
));

function run(legacySnapshots: boolean) {
  const accumulator = new ContactTileDeltaAccumulator(requestedTiles, tileSizeBins);
  const startedAt = performance.now();
  for (const chunk of chunks) {
    const changedTileKeys = accumulator.merge(chunk);
    if (legacySnapshots) {
      accumulator.previewBatch(changedTileKeys);
    }
  }
  accumulator.finish();
  return {
    milliseconds: performance.now() - startedAt,
    snapshotBuilds: accumulator.snapshotBuildCount,
    snapshotCellVisits: accumulator.snapshotBuildCount * tileSizeBins * tileSizeBins,
  };
}

function median(values: number[]) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)]!;
}

run(true);
run(false);
const samples = 7;
const legacy = Array.from({ length: samples }, () => run(true));
const direct = Array.from({ length: samples }, () => run(false));
const legacyMedianMs = median(legacy.map(({ milliseconds }) => milliseconds));
const directMedianMs = median(direct.map(({ milliseconds }) => milliseconds));

console.info(JSON.stringify({
  benchmark: "contact_tile_delta_frontend_snapshot",
  tileSizeBins,
  tileCount,
  chunkCount,
  deltaRecords: tileCount * chunkCount * cellsPerTilePerChunk,
  samples,
  legacy: {
    medianMs: Number(legacyMedianMs.toFixed(3)),
    snapshotBuilds: legacy[0]!.snapshotBuilds,
    snapshotCellVisits: legacy[0]!.snapshotCellVisits,
  },
  direct: {
    medianMs: Number(directMedianMs.toFixed(3)),
    snapshotBuilds: direct[0]!.snapshotBuilds,
    snapshotCellVisits: direct[0]!.snapshotCellVisits,
  },
  speedup: Number((legacyMedianMs / directMedianMs).toFixed(2)),
}));
