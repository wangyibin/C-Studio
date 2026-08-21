import {
  buildContactGpuLayoutMap,
  buildContactSourceAddressSpace,
  contactGpuSourceTilePlan,
} from "../src/state/contactSourceLayout";
import type { ContactMapLayoutBlock } from "../src/state/importers";

const sourceCount = 24;
const sourceLength = 10_000_000;
const gapLength = 250_000;
const resolution = 100_000;
const tileSizeBins = 256;
const repeats = 120;
const legacyCanvasPixels = 2_880;
const sources = Array.from({ length: sourceCount }, (_, index) => ({
  name: `source-${index}`,
  length: sourceLength,
}));
const addressSpace = buildContactSourceAddressSpace(sources);

let visualStart = 0;
const layoutBlocks: ContactMapLayoutBlock[] = [];
const append = (
  sourceIndex: number,
  copy: number,
  orientation: "+" | "-",
) => {
  const sourceId = `source-${sourceIndex}`;
  layoutBlocks.push({
    id: `${sourceId}:${copy}`,
    objectId: "synthetic",
    sourceId,
    sourceStart: 0,
    sourceEnd: sourceLength,
    visualStart,
    visualEnd: visualStart + sourceLength,
    orientation,
  });
  visualStart += sourceLength + gapLength;
};

// A moved/reversed assembly with one full source copy exercises all hot-map
// address and local c/(n_x*n_y) weight paths without materializing pixels.
for (let index = 0; index < sourceCount; index += 1) {
  const sourceIndex = (index * 7) % sourceCount;
  append(sourceIndex, 1, index % 2 === 0 ? "+" : "-");
  if (sourceIndex === 0) {
    append(sourceIndex, 2, "+");
  }
}
const viewport = { xStart: 0, xEnd: visualStart - gapLength };

function buildMaps() {
  const xMap = buildContactGpuLayoutMap({
    addressSpace,
    layoutBlocks,
    resolution,
    tileSizeBins,
    viewport,
  });
  const yMap = buildContactGpuLayoutMap({
    addressSpace,
    layoutBlocks,
    resolution,
    tileSizeBins,
    viewport,
  });
  return { xMap, yMap, tilePlan: contactGpuSourceTilePlan(xMap, yMap) };
}

buildMaps();
const durations: number[] = [];
let result = buildMaps();
for (let repeat = 0; repeat < repeats; repeat += 1) {
  const startedAt = performance.now();
  result = buildMaps();
  durations.push(performance.now() - startedAt);
}
durations.sort((left, right) => left - right);
const mapBytes = result.xMap.addressData.byteLength
  + result.yMap.addressData.byteLength
  + result.xMap.weightData.byteLength
  + result.yMap.weightData.byteLength;
const compactPageTableBytes = result.tilePlan.sourceTiles.length ** 2
  * 2
  * Uint32Array.BYTES_PER_ELEMENT;
const canvasSurfaceBytes = legacyCanvasPixels ** 2 * 4;
const removedCanvas2dAndDefaultBufferBytes = canvasSurfaceBytes * 3;
const copiedEntries = result.xMap.entries.filter((entry) => entry.copyCount === 2);

console.log(JSON.stringify({
  benchmark: "contact_source_layout_resource_model",
  caveat: "headless mapping timing and RGBA8 allocation estimate; not desktop GPU frame timing",
  layout: {
    sources: sourceCount,
    blocks: layoutBlocks.length,
    visualBinsPerAxis: result.xMap.entries.length,
    resolution,
    tileSizeBins,
  },
  sourceSpace: {
    sourceAxisTiles: result.tilePlan.sourceTiles.length,
    requestedCanonicalTiles: result.tilePlan.tiles.length,
    mapBytes,
    compactPageTableBytes,
    buildMedianMs: Math.round(durations[Math.floor(durations.length / 2)]! * 1_000) / 1_000,
  },
  semantics: {
    copiedBins: copiedEntries.length,
    copiedBinsUseHalfWeight: copiedEntries.every((entry) => entry.copyWeight === 0.5),
  },
  removedLegacyEstimate: {
    canvasPixels: legacyCanvasPixels,
    canvas2dSourceAndPreviewSurfaces: 2,
    preservedDefaultBuffers: 1,
    bytes: removedCanvas2dAndDefaultBufferBytes,
    mib: Math.round(removedCanvas2dAndDefaultBufferBytes / 1024 / 1024 * 100) / 100,
  },
}));
