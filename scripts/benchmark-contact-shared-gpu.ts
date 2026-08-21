const textureBudgetBytes = 96 * 1024 * 1024;
const virtualTextureBudgetBytes = 32 * 1024 * 1024;
const tileSizeBins = 256;
const bytesPerAtlasLayer = tileSizeBins * tileSizeBins * Float32Array.BYTES_PER_ELEMENT;
const pageTableReserveBytes = Math.min(
  4 * 1024 * 1024,
  virtualTextureBudgetBytes / 4,
);
const atlasBytes = virtualTextureBudgetBytes - pageTableReserveBytes;
const atlasLayers = Math.floor(atlasBytes / bytesPerAtlasLayer);
const canvasWidth = 1_600;
const canvasHeight = 1_600;
const fboBytes = canvasWidth * canvasHeight * 4;
const transitionCount = 240;
const sideTiles = 8;
const sampleRepeats = 120;

interface SyntheticFrame {
  keys: string[];
}

const frames: SyntheticFrame[] = Array.from({ length: transitionCount }, (_, frame) => {
  const lod = Math.floor(frame / 30) % 2;
  const originX = (frame * 2) % 48;
  const originY = Math.floor(frame / 12) % 16;
  const scope = `raw:lod${lod}`;
  const keys: string[] = [];
  for (let y = 0; y < sideTiles; y += 1) {
    for (let x = 0; x < sideTiles; x += 1) {
      keys.push(`${scope}:${originX + x}:${originY + y}`);
    }
  }
  return { keys };
});

function legacyRebuildAtlas() {
  let uploads = 0;
  let checksum = 0;
  for (let repeat = 0; repeat < sampleRepeats; repeat += 1) {
    for (const frame of frames) {
      const rebuilt = new Map<string, number>();
      for (const key of frame.keys) {
        rebuilt.set(key, rebuilt.size);
        uploads += 1;
      }
      checksum += rebuilt.size;
    }
  }
  return { uploads, checksum };
}

function persistentAtlas() {
  const layers = new Map<string, { layer: number; used: number }>();
  let useCounter = 0;
  let uploads = 0;
  let checksum = 0;
  for (let repeat = 0; repeat < sampleRepeats; repeat += 1) {
    for (const frame of frames) {
      const protectedKeys = new Set(frame.keys);
      const occupied = new Set([...layers.values()].map((entry) => entry.layer));
      const evictionCandidates = [...layers.entries()]
        .filter(([candidateKey]) => !protectedKeys.has(candidateKey))
        .sort(([, left], [, right]) => left.used - right.used);
      for (const key of frame.keys) {
        const resident = layers.get(key);
        if (resident) {
          resident.used = ++useCounter;
          continue;
        }
        let layer: number;
        if (layers.size < atlasLayers) {
          layer = 0;
          while (occupied.has(layer)) layer += 1;
          occupied.add(layer);
        } else {
          const candidate = evictionCandidates.shift();
          if (!candidate) {
            throw new Error("synthetic frame exceeds persistent atlas capacity");
          }
          layer = candidate[1].layer;
          layers.delete(candidate[0]);
        }
        layers.set(key, { layer, used: ++useCounter });
        uploads += 1;
      }
      checksum += layers.size;
    }
  }
  return { uploads, checksum };
}

function medianDuration(run: () => { uploads: number; checksum: number }) {
  const durations: number[] = [];
  let result = run();
  for (let sample = 0; sample < 7; sample += 1) {
    const startedAt = performance.now();
    result = run();
    durations.push(performance.now() - startedAt);
  }
  durations.sort((left, right) => left - right);
  return {
    medianMs: durations[Math.floor(durations.length / 2)]!,
    ...result,
  };
}

legacyRebuildAtlas();
persistentAtlas();
const legacy = medianDuration(legacyRebuildAtlas);
const persistent = medianDuration(persistentAtlas);
const legacyUploadsPerSequence = legacy.uploads / sampleRepeats;
const persistentUploadsPerSequence = persistent.uploads / sampleRepeats;
const legacyPeakBytes = (
  2 * (textureBudgetBytes / 2 + atlasBytes + fboBytes)
);
const persistentPeakBytes = atlasBytes + 2 * fboBytes;

console.log(JSON.stringify({
  benchmark: "contact_shared_context_persistent_atlas_resource_model",
  caveat: "headless resource/call-count model; not desktop GPU frame timing",
  canvas: { width: canvasWidth, height: canvasHeight },
  sequence: {
    transitions: transitionCount,
    visibleTilesPerFrame: sideTiles * sideTiles,
    lodLevels: 2,
    atlasLayers,
  },
  legacy: {
    contexts: 2,
    presentationFbos: 2,
    atlasAllocationsPerSequence: transitionCount,
    atlasUploadsPerSequence: legacyUploadsPerSequence,
    configuredPeakBytes: legacyPeakBytes,
    plannerMedianMs: Math.round(legacy.medianMs * 1_000) / 1_000,
    plannerMicrosecondsPerTransition: Math.round(
      (legacy.medianMs * 1_000) / (sampleRepeats * transitionCount) * 1_000,
    ) / 1_000,
  },
  shared: {
    contexts: 1,
    presentationFbos: 2,
    atlasAllocationsPerSequence: 1,
    atlasUploadsPerSequence: persistentUploadsPerSequence,
    configuredPeakBytes: persistentPeakBytes,
    plannerMedianMs: Math.round(persistent.medianMs * 1_000) / 1_000,
    plannerMicrosecondsPerTransition: Math.round(
      (persistent.medianMs * 1_000) / (sampleRepeats * transitionCount) * 1_000,
    ) / 1_000,
  },
  benefit: {
    atlasUploadReductionPercent: Math.round(
      (1 - persistentUploadsPerSequence / legacyUploadsPerSequence) * 10_000,
    ) / 100,
    configuredPeakByteReductionPercent: Math.round(
      (1 - persistentPeakBytes / legacyPeakBytes) * 10_000,
    ) / 100,
  },
  checksum: legacy.checksum + persistent.checksum,
}));
