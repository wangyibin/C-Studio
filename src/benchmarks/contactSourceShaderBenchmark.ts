import type { ContactMapTile } from "../App";
import {
  createContactTileGpuRenderer,
  type ContactTileGpuScene,
} from "../components/contactTileGpu";
import {
  buildContactGpuLayoutMap,
  buildContactSourceAddressSpace,
  contactGpuSourceTilePlan,
} from "../state/contactSourceLayout";
import type { ContactMapLayoutBlock } from "../state/importers";

const resolution = 1_000;
const tileSizeBins = 4;
const canvasPixels = 64;

export interface ContactSourceShaderBenchmarkResult {
  webglAvailable: boolean;
  forward: boolean;
  reverse: boolean;
  gap: boolean;
  move: boolean;
  copyWeight: boolean;
  medianRedrawMs: number;
  sourceLayoutBytes: number;
}

export function runContactSourceShaderBenchmark(): ContactSourceShaderBenchmarkResult {
  const canvas = document.createElement("canvas");
  canvas.width = canvasPixels;
  canvas.height = canvasPixels;
  canvas.style.width = `${canvasPixels}px`;
  canvas.style.height = `${canvasPixels}px`;
  canvas.style.position = "fixed";
  canvas.style.left = "-1000px";
  document.body.append(canvas);
  const renderer = createContactTileGpuRenderer(canvas, 4 * 1024 * 1024, {
    texturePreference: "r32f",
    virtualTextureEnabled: true,
  });
  if (!renderer) {
    canvas.remove();
    return {
      webglAvailable: false,
      forward: false,
      reverse: false,
      gap: false,
      move: false,
      copyWeight: false,
      medianRedrawMs: Number.NaN,
      sourceLayoutBytes: 0,
    };
  }
  const matrix = new Float32Array([
    1, 2, 3, 4,
    2, 5, 6, 7,
    3, 6, 8, 9,
    4, 7, 9, 10,
  ]);
  const forwardBlocks = [layoutBlock("forward", 0, 4_000, 0, "+")];
  const forward = renderSourceScene(renderer, forwardBlocks, 4_000, matrix, "forward");
  const reverse = renderSourceScene(
    renderer,
    [layoutBlock("reverse", 0, 4_000, 0, "-")],
    4_000,
    matrix,
    "reverse",
  );
  const gap = renderSourceScene(renderer, [
    layoutBlock("gap-left", 0, 1_000, 0, "+"),
    layoutBlock("gap-right", 1_000, 4_000, 2_000, "+"),
  ], 4_000, matrix, "gap");
  const move = renderSourceScene(renderer, [
    layoutBlock("move-right", 2_000, 4_000, 0, "+"),
    layoutBlock("move-left", 0, 2_000, 2_000, "+"),
  ], 4_000, matrix, "move");
  const copyMatrix = new Float32Array(16).fill(8);
  const copied = renderSourceScene(renderer, [
    layoutBlock("copy-1", 0, 2_000, 0, "+"),
    layoutBlock("copy-2", 0, 2_000, 2_000, "+"),
  ], 2_000, copyMatrix, "copy");
  const referenceMatrix = new Float32Array(16).fill(2);
  const copyReference = renderSourceScene(
    renderer,
    forwardBlocks,
    4_000,
    referenceMatrix,
    "copy-reference",
  );

  renderSourceScene(renderer, forwardBlocks, 4_000, matrix, "benchmark");
  const redrawDurations: number[] = [];
  const viewport = { xStart: 0, xEnd: 4_000, yStart: 0, yEnd: 4_000 };
  for (let iteration = 0; iteration < 120; iteration += 1) {
    const startedAt = performance.now();
    renderer.setPanViewport(viewport);
    redrawDurations.push(performance.now() - startedAt);
  }
  redrawDurations.sort((left, right) => left - right);
  const snapshot = renderer.performanceSnapshot();
  const result = {
    webglAvailable: true,
    forward: !isWhite(forward[0]![0]!),
    reverse: samePixel(reverse[0]![1]!, forward[3]![2]!),
    gap: isWhite(gap[1]![2]!),
    move: samePixel(move[0]![3]!, forward[2]![1]!),
    copyWeight: samePixel(copied[0]![0]!, copyReference[0]![0]!),
    medianRedrawMs: redrawDurations[Math.floor(redrawDurations.length / 2)] ?? Number.NaN,
    sourceLayoutBytes: snapshot.sourceLayoutBytes,
  };
  renderer.destroy();
  canvas.remove();
  return result;
}

function renderSourceScene(
  renderer: NonNullable<ReturnType<typeof createContactTileGpuRenderer>>,
  blocks: ContactMapLayoutBlock[],
  sourceLength: number,
  values: Float32Array,
  dataScope: string,
) {
  const addressSpace = buildContactSourceAddressSpace([{ name: "source", length: sourceLength }]);
  const viewport = { xStart: 0, xEnd: 4_000, yStart: 0, yEnd: 4_000 };
  const xMap = buildContactGpuLayoutMap({
    addressSpace,
    layoutBlocks: blocks,
    resolution,
    tileSizeBins,
    viewport: { xStart: viewport.xStart, xEnd: viewport.xEnd },
  });
  const yMap = buildContactGpuLayoutMap({
    addressSpace,
    layoutBlocks: blocks,
    resolution,
    tileSizeBins,
    viewport: { xStart: viewport.yStart, xEnd: viewport.yEnd },
  });
  const plan = contactGpuSourceTilePlan(xMap, yMap);
  const tile: ContactMapTile = {
    tileX: 0,
    tileY: 0,
    cells: [],
    denseValues: values,
    denseOccupiedCount: values.length,
  };
  const sourceDescriptors = [{ key: `${dataScope}:0:0`, tile, transpose: false }];
  const scene: ContactTileGpuScene = {
    dataScope: `projected:${dataScope}`,
    descriptors: [],
    generation: 1,
    resolution,
    tileSizeBins,
    viewport,
    visibleLayerComplete: false,
    renderStyle: {
      colormap: "Reds",
      colorScale: { log: false, min: 0, max: 10 },
    },
    sourceLayout: {
      dataScope: `source:${dataScope}`,
      descriptors: sourceDescriptors,
      generation: 1,
      sourceTiles: plan.sourceTiles,
      xMap,
      yMap,
    },
  };
  if (!renderer.setScene(scene)) {
    throw new Error(`source shader scene failed: ${dataScope}`);
  }
  const gl = canvasContext(renderer);
  const pixels: number[][][] = [];
  for (let xBin = 0; xBin < tileSizeBins; xBin += 1) {
    const column: number[][] = [];
    for (let yBin = 0; yBin < tileSizeBins; yBin += 1) {
      const pixel = new Uint8Array(4);
      const x = Math.floor((xBin + 0.5) * canvasPixels / tileSizeBins);
      const y = canvasPixels - 1 - Math.floor((yBin + 0.5) * canvasPixels / tileSizeBins);
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      column.push([...pixel]);
    }
    pixels.push(column);
  }
  return pixels;
}

function canvasContext(
  renderer: NonNullable<ReturnType<typeof createContactTileGpuRenderer>>,
) {
  void renderer;
  const canvas = document.querySelector<HTMLCanvasElement>("canvas[style*='-1000px']");
  const gl = canvas?.getContext("webgl2");
  if (!gl) {
    throw new Error("source shader WebGL context disappeared");
  }
  return gl;
}

function layoutBlock(
  id: string,
  sourceStart: number,
  sourceEnd: number,
  visualStart: number,
  orientation: "+" | "-",
): ContactMapLayoutBlock {
  return {
    id,
    objectId: "chr1",
    sourceId: "source",
    sourceStart,
    sourceEnd,
    visualStart,
    visualEnd: visualStart + sourceEnd - sourceStart,
    orientation,
  };
}

function samePixel(left: readonly number[], right: readonly number[]) {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function isWhite(pixel: readonly number[]) {
  return pixel[0] === 255 && pixel[1] === 255 && pixel[2] === 255 && pixel[3] === 255;
}
