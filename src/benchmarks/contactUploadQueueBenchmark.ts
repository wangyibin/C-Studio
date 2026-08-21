import type { ContactMapTile } from "../App";
import {
  contactTileGpuUploadBudgetBytes,
  contactTileGpuUploadBudgetMilliseconds,
  createContactTileGpuRenderer,
  type ContactTileGpuPerformanceSnapshot,
  type ContactTileGpuScene,
} from "../components/contactTileGpu";

export interface ContactUploadQueueBenchmarkRun {
  accepted: boolean;
  callReturnMs: number;
  readyMs: number;
  queueFrames: number;
  deferredFrames: number;
  uploadedBytes: number;
  maxFrameBytes: number;
  maxFrameMs: number;
  fenceWaitFrames: number;
}

export interface ContactUploadQueueBenchmarkResult {
  benchmark: "contact_gpu_upload_queue";
  webglAvailable: boolean;
  tileCount: number;
  tileBytes: number;
  boundedBudgetBytes: number;
  boundedBudgetMs: number;
  bounded: ContactUploadQueueBenchmarkRun | null;
  unbounded: ContactUploadQueueBenchmarkRun | null;
  caveat: string;
}

const tileSizeBins = 256;
const tileCount = 24;
const tileBytes = tileSizeBins * tileSizeBins * Float32Array.BYTES_PER_ELEMENT;

/** Compare the production frame budget with the old one-call bulk submission. */
export async function runContactUploadQueueBenchmark(): Promise<ContactUploadQueueBenchmarkResult> {
  const scene = benchmarkScene();
  const bounded = await runUploadBenchmark(scene, false);
  const unbounded = await runUploadBenchmark(scene, true);
  return {
    benchmark: "contact_gpu_upload_queue",
    webglAvailable: bounded !== null && unbounded !== null,
    tileCount,
    tileBytes,
    boundedBudgetBytes: contactTileGpuUploadBudgetBytes,
    boundedBudgetMs: contactTileGpuUploadBudgetMilliseconds,
    bounded,
    unbounded,
    caveat: "Headless browser timing measures CPU submission and fence-ready latency; it is not a Tauri/WebView2 desktop GPU acceptance result.",
  };
}

async function runUploadBenchmark(
  scene: ContactTileGpuScene,
  unbounded: boolean,
): Promise<ContactUploadQueueBenchmarkRun | null> {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  canvas.style.width = "256px";
  canvas.style.height = "256px";
  canvas.style.position = "fixed";
  canvas.style.left = "-1000px";
  document.body.append(canvas);
  const renderer = createContactTileGpuRenderer(canvas, 96 * 1024 * 1024, {
    performanceEnabled: false,
    texturePreference: "r32f",
    uploadBudgetBytes: unbounded ? Number.MAX_SAFE_INTEGER : contactTileGpuUploadBudgetBytes,
    uploadBudgetMilliseconds: unbounded
      ? Number.MAX_SAFE_INTEGER
      : contactTileGpuUploadBudgetMilliseconds,
    virtualTextureEnabled: true,
  });
  if (!renderer) {
    canvas.remove();
    return null;
  }

  const startedAt = performance.now();
  let resolvePresented!: (presented: boolean) => void;
  const presented = new Promise<boolean>((resolve) => {
    resolvePresented = resolve;
  });
  const callStartedAt = performance.now();
  const accepted = renderer.setScene(scene, resolvePresented);
  const callReturnMs = performance.now() - callStartedAt;
  const wasPresented = accepted && await Promise.race([
    presented,
    new Promise<false>((resolve) => globalThis.setTimeout(() => resolve(false), 5_000)),
  ]);
  const readyMs = performance.now() - startedAt;
  const snapshot = renderer.performanceSnapshot();
  renderer.destroy();
  canvas.remove();
  return benchmarkRun(accepted && wasPresented, callReturnMs, readyMs, snapshot);
}

function benchmarkRun(
  accepted: boolean,
  callReturnMs: number,
  readyMs: number,
  snapshot: ContactTileGpuPerformanceSnapshot,
): ContactUploadQueueBenchmarkRun {
  return {
    accepted,
    callReturnMs: round(callReturnMs),
    readyMs: round(readyMs),
    queueFrames: snapshot.uploadQueueFrames,
    deferredFrames: snapshot.uploadQueueDeferredFrames,
    uploadedBytes: snapshot.uploadQueueBytes,
    maxFrameBytes: snapshot.uploadQueueMaxFrameBytes,
    maxFrameMs: round(snapshot.uploadQueueMaxFrameMilliseconds),
    fenceWaitFrames: snapshot.uploadFenceWaitFrames,
  };
}

function benchmarkScene(): ContactTileGpuScene {
  const denseValues = new Float32Array(tileSizeBins * tileSizeBins);
  denseValues.fill(1);
  const tiles: ContactMapTile[] = Array.from({ length: tileCount }, (_, tileX) => ({
    tileX,
    tileY: 0,
    cells: [],
    denseValues,
    denseOccupiedCount: denseValues.length,
  }));
  const tileSpan = tileSizeBins * 1_000;
  return {
    dataScope: "upload-queue-benchmark",
    descriptors: tiles.map((tile) => ({
      key: `${tile.tileX}:${tile.tileY}:source`,
      tile,
      transpose: false,
    })),
    generation: 1,
    resolution: 1_000,
    tileSizeBins,
    visibleLayerComplete: true,
    viewport: {
      xStart: 0,
      xEnd: tileCount * tileSpan,
      yStart: 0,
      yEnd: tileSpan,
    },
    renderStyle: {
      colormap: "Reds",
      colorScale: { log: false, min: 0, max: 10 },
    },
  };
}

function round(value: number) {
  return Math.round(value * 1_000) / 1_000;
}
