import {
  contactTileVirtualCamera,
  contactTileVirtualPagePlan,
  contactTileVirtualPageTableData,
} from "../src/components/contactTileGpu";

const resolution = 250_000;
const tileSizeBins = 256;
const tileSpan = resolution * tileSizeBins;
const columns = 16;
const rows = 8;
const frameCount = 50_000;
const descriptors = Array.from({ length: columns * rows }, (_, index) => {
  const tileX = index % columns;
  const tileY = Math.floor(index / columns);
  return {
    key: `${tileX}:${tileY}`,
    tile: {
      tileX,
      tileY,
      cells: [{ xBin: tileX * tileSizeBins, yBin: tileY * tileSizeBins, count: index + 1 }],
    },
    transpose: false,
  };
});

const pagePlan = contactTileVirtualPagePlan(descriptors);
if (!pagePlan) {
  throw new Error("virtual page benchmark plan is empty");
}
const layers = new Map(pagePlan.populatedTiles.map(({ key }, layer) => [key, layer]));
const pageTable = contactTileVirtualPageTableData(pagePlan, layers);
if (!pageTable) {
  throw new Error("virtual page benchmark table is incomplete");
}

function legacyPointerFrames() {
  let checksum = 0;
  for (let frame = 0; frame < frameCount; frame += 1) {
    const xStart = (frame % 1_000) * 1_000;
    const viewportWidth = columns * tileSpan - 1;
    for (const descriptor of descriptors) {
      const renderedTileX = descriptor.transpose
        ? descriptor.tile.tileY
        : descriptor.tile.tileX;
      const renderedTileY = descriptor.transpose
        ? descriptor.tile.tileX
        : descriptor.tile.tileY;
      checksum += ((renderedTileX * tileSpan - xStart) / viewportWidth)
        + (renderedTileY * tileSpan) / (rows * tileSpan - 1);
    }
  }
  return checksum;
}

function virtualPointerFrames() {
  let checksum = 0;
  for (let frame = 0; frame < frameCount; frame += 1) {
    const xStart = (frame % 1_000) * 1_000;
    const camera = contactTileVirtualCamera({
      xStart,
      xEnd: xStart + columns * tileSpan - 1,
      yStart: 0,
      yEnd: rows * tileSpan - 1,
    }, resolution, tileSizeBins);
    // One page-table shader draw consumes these six camera scalars regardless
    // of the number of resident tiles.
    checksum += camera.pageX
      + camera.pageY
      + camera.localX
      + camera.localY
      + camera.spanX
      + camera.spanY;
  }
  return checksum;
}

function samples(run: () => number) {
  const durations: number[] = [];
  let checksum = 0;
  for (let sample = 0; sample < 9; sample += 1) {
    const startedAt = performance.now();
    checksum += run();
    durations.push(performance.now() - startedAt);
  }
  durations.sort((left, right) => left - right);
  return { medianMs: durations[Math.floor(durations.length / 2)]!, checksum };
}

// Warm V8 before recording medians.
legacyPointerFrames();
virtualPointerFrames();
const legacy = samples(legacyPointerFrames);
const virtual = samples(virtualPointerFrames);

console.log(JSON.stringify({
  benchmark: "contact_virtual_texture_pointer_cpu",
  resolution,
  tileSizeBins,
  residentTiles: descriptors.length,
  pageTable: { width: pagePlan.width, height: pagePlan.height, bytes: pageTable.byteLength },
  frameCount,
  legacy: { medianMs: Math.round(legacy.medianMs * 1_000) / 1_000, drawsPerFrame: descriptors.length },
  virtual: { medianMs: Math.round(virtual.medianMs * 1_000) / 1_000, drawsPerFrame: 1 },
  cpuSpeedup: Math.round((legacy.medianMs / virtual.medianMs) * 100) / 100,
  checksum: Math.round((legacy.checksum + virtual.checksum) * 1_000) / 1_000,
}));
