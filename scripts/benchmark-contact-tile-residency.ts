import {
  contactTileViewportHistoryKeys,
  ContactTileResolutionLru,
  defaultContactTileLruLimits,
  retainContactTileViewportFootprint,
  type ContactTileLruLimits,
  type ContactTileViewportResidencyHistory,
} from "../src/state/contactTileLru";

const tileSizeBins = 256;
const cellsPerDenseTile = tileSizeBins * tileSizeBins;
const bytesPerR16fTile = cellsPerDenseTile * Uint16Array.BYTES_PER_ELEMENT;
const tilesPerViewport = 16;
const visits = ["A", "B", "C", "B", "A"] as const;
const scope = { id: "dataset|1000|256|raw|layout", resolution: 1_000 };

interface BenchmarkTile {
  key: string;
}

function viewportKeys(name: typeof visits[number]) {
  const base = name.charCodeAt(0) - "A".charCodeAt(0);
  return Array.from({ length: tilesPerViewport }, (_, index) => (
    `${scope.id}|${base * tilesPerViewport + index}:0`
  ));
}

function runScenario(
  name: string,
  limits: Partial<ContactTileLruLimits>,
  keepViewportHistory: boolean,
) {
  const cache = new ContactTileResolutionLru<BenchmarkTile>(limits);
  let history: ContactTileViewportResidencyHistory = [];
  let totalHits = 0;
  let totalMisses = 0;
  const sequence = visits.map((visit) => {
    const keys = viewportKeys(visit);
    const hits = keys.filter((key) => cache.has(key)).length;
    const missingKeys = keys.filter((key) => !cache.has(key));
    const protectedKeys = new Set([
      ...keys,
      ...(keepViewportHistory ? contactTileViewportHistoryKeys(history) : []),
    ]);
    cache.merge(
      scope,
      missingKeys.map((key) => ({
        key,
        value: { key },
        cellCount: cellsPerDenseTile,
        valueBytes: bytesPerR16fTile,
      })),
      { keys: protectedKeys, scopes: new Set([scope.id]) },
    );
    if (keepViewportHistory) {
      history = retainContactTileViewportFootprint(history, keys);
    }
    totalHits += hits;
    totalMisses += missingKeys.length;
    return {
      visit,
      hits,
      misses: missingKeys.length,
      residentTiles: cache.size,
      residentMiB: round(cache.residentBytes / (1024 * 1024)),
    };
  });
  return {
    name,
    limits: cache.limits,
    totalHits,
    totalMisses,
    returnVisitHits: sequence.slice(3).reduce((sum, visit) => sum + visit.hits, 0),
    sequence,
  };
}

const legacy = runScenario("legacy-cell-budget", {
  maxScopes: 3,
  maxTiles: 96,
  maxCells: 750_000,
  maxBytes: Number.MAX_SAFE_INTEGER,
}, false);
const resident = runScenario("byte-budget-with-two-view-history", defaultContactTileLruLimits, true);

console.log(JSON.stringify({
  benchmark: "contact_tile_backtrack_residency",
  pattern: visits.join("->"),
  tileSizeBins,
  tilesPerViewport,
  bytesPerR16fTile,
  legacy,
  resident,
  avoidedReturnMisses: legacy.totalMisses - resident.totalMisses,
  caveat: "Deterministic cache benchmark; real Tauri/WebView2 acceptance still requires pointer-to-paint timing.",
}, null, 2));

function round(value: number) {
  return Math.round(value * 1_000) / 1_000;
}
