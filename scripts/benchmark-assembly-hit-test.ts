import {
  buildAssemblyEditModel,
  buildAssemblyHitTestIndex,
  buildAssemblyInteractionIndex,
  hitTestAssemblyLayout,
  insertionTargetAtScreenPoint,
} from "../src/state/assemblyEditing";
import type { ContactMapLayoutBlock } from "../src/state/importers";
import { assemblyCutTargetAtScreenPoint } from "../src/components/ContactMapViewport";

const counts = [1_000, 5_000, 20_000];
const widthPx = 1_600;
const heightPx = 900;
const viewportBlockCount = 240;
const hitQueryCount = 2_000;
const cutQueryCount = 600;
const samples = 5;

interface Query {
  point: { x: number; y: number };
  options: {
    widthPx: number;
    heightPx: number;
    tolerancePx: number;
    viewportXStart: number;
    viewportXEnd: number;
    viewportYStart: number;
    viewportYEnd: number;
  };
}

const results = counts.map((count) => {
  const blocks = benchmarkBlocks(count);
  const model = buildAssemblyEditModel(blocks);
  const insertionSelectedIds = new Set([blocks[blocks.length - 1].id]);
  const cutSelectedIds = new Set(blocks.map((block) => block.id));
  const buildStartedAt = performance.now();
  const hitIndex = buildAssemblyHitTestIndex(model);
  const insertionIndex = buildAssemblyInteractionIndex(
    model,
    insertionSelectedIds,
    "contigs",
    hitIndex,
  );
  const cutIndex = buildAssemblyInteractionIndex(model, cutSelectedIds, "contigs", hitIndex);
  const indexBuildMs = performance.now() - buildStartedAt;
  const hitQueries = benchmarkQueries(count, hitQueryCount, 0);
  const insertionQueries = benchmarkQueries(count, hitQueryCount, 1);
  const cutQueries = benchmarkQueries(count, cutQueryCount, 2);

  const linearHit = medianRun(() => {
    let checksum = 0;
    for (const query of hitQueries) {
      checksum += hitTestAssemblyLayout(model, query.point, query.options)?.id.length ?? 0;
    }
    return checksum;
  });
  const indexedHit = medianRun(() => {
    let checksum = 0;
    for (const query of hitQueries) {
      checksum += hitTestAssemblyLayout(model, query.point, query.options, hitIndex)?.id.length ?? 0;
    }
    return checksum;
  });
  const linearInsertion = medianRun(() => {
    let checksum = 0;
    for (const query of insertionQueries) {
      checksum += insertionTargetAtScreenPoint(
        model,
        insertionSelectedIds,
        query.point,
        query.options,
      )?.visualPosition ?? 0;
    }
    return checksum;
  });
  const indexedInsertion = medianRun(() => {
    let checksum = 0;
    for (const query of insertionQueries) {
      checksum += insertionTargetAtScreenPoint(
        model,
        insertionSelectedIds,
        query.point,
        query.options,
        insertionIndex,
      )?.visualPosition ?? 0;
    }
    return checksum;
  });
  const linearCut = medianRun(() => {
    let checksum = 0;
    for (const query of cutQueries) {
      checksum += assemblyCutTargetAtScreenPoint({
        model,
        selectedIds: cutSelectedIds,
        point: query.point,
        widthPx,
        heightPx,
        viewportXStart: query.options.viewportXStart,
        viewportXEnd: query.options.viewportXEnd,
        viewportYStart: query.options.viewportYStart,
        viewportYEnd: query.options.viewportYEnd,
      })?.visualPosition ?? 0;
    }
    return checksum;
  });
  const indexedCut = medianRun(() => {
    let checksum = 0;
    for (const query of cutQueries) {
      checksum += assemblyCutTargetAtScreenPoint({
        model,
        selectedIds: cutSelectedIds,
        interactionIndex: cutIndex,
        point: query.point,
        widthPx,
        heightPx,
        viewportXStart: query.options.viewportXStart,
        viewportXEnd: query.options.viewportXEnd,
        viewportYStart: query.options.viewportYStart,
        viewportYEnd: query.options.viewportYEnd,
      })?.visualPosition ?? 0;
    }
    return checksum;
  });

  if (
    linearHit.checksum !== indexedHit.checksum
    || linearInsertion.checksum !== indexedInsertion.checksum
    || linearCut.checksum !== indexedCut.checksum
  ) {
    throw new Error(`indexed hit-test checksum mismatch for ${count} contigs`);
  }

  return {
    contigs: count,
    indexBuildMs: rounded(indexBuildMs),
    hit: comparison(linearHit.medianMs, indexedHit.medianMs, hitQueryCount),
    insertion: comparison(
      linearInsertion.medianMs,
      indexedInsertion.medianMs,
      hitQueryCount,
    ),
    cut: comparison(linearCut.medianMs, indexedCut.medianMs, cutQueryCount),
  };
});

console.log(JSON.stringify({
  benchmark: "assembly_edit_hit_test_index",
  caveat: "vite-node CPU microbenchmark; excludes DOM layout, rAF scheduling, React paint, and Tauri/WebView2 frame timing",
  queryGeometry: {
    widthPx,
    heightPx,
    viewportBlockCount,
    hitQueries: hitQueryCount,
    cutQueries: cutQueryCount,
    samples,
  },
  results,
}));

function benchmarkBlocks(count: number): ContactMapLayoutBlock[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `Chr${Math.floor(index / 100)}:${index}:ctg${index}`,
    objectId: `Chr${Math.floor(index / 100)}`,
    sourceId: `ctg${index}`,
    sourceStart: 0,
    sourceEnd: 8,
    visualStart: index * 10,
    visualEnd: index * 10 + 8,
    orientation: index % 2 === 0 ? "+" : "-",
  }));
}

function benchmarkQueries(count: number, queryCount: number, phase: number): Query[] {
  const visibleSpan = Math.min(count, viewportBlockCount) * 10;
  const maximumStartIndex = Math.max(0, count - viewportBlockCount);
  return Array.from({ length: queryCount }, (_, sample) => {
    const targetIndex = (sample * 7919 + phase * 104729) % count;
    const viewportStartIndex = Math.min(
      maximumStartIndex,
      Math.max(0, targetIndex - Math.floor(viewportBlockCount / 2)),
    );
    const viewportStart = viewportStartIndex * 10;
    const viewportEnd = viewportStart + visibleSpan;
    const visualPosition = targetIndex * 10 + (phase === 1 ? 0 : 4);
    return {
      point: {
        x: ((visualPosition - viewportStart) / visibleSpan) * widthPx,
        y: ((visualPosition - viewportStart) / visibleSpan) * heightPx,
      },
      options: {
        widthPx,
        heightPx,
        tolerancePx: 7,
        viewportXStart: viewportStart,
        viewportXEnd: viewportEnd,
        viewportYStart: viewportStart,
        viewportYEnd: viewportEnd,
      },
    };
  });
}

function medianRun(run: () => number) {
  run();
  const durations: number[] = [];
  let checksum = 0;
  for (let sample = 0; sample < samples; sample += 1) {
    const startedAt = performance.now();
    checksum = run();
    durations.push(performance.now() - startedAt);
  }
  durations.sort((left, right) => left - right);
  return { medianMs: durations[Math.floor(durations.length / 2)]!, checksum };
}

function comparison(linearMs: number, indexedMs: number, queryCount: number) {
  return {
    linearMicrosecondsPerQuery: rounded(linearMs * 1_000 / queryCount),
    indexedMicrosecondsPerQuery: rounded(indexedMs * 1_000 / queryCount),
    speedup: rounded(linearMs / Math.max(Number.EPSILON, indexedMs)),
  };
}

function rounded(value: number) {
  return Math.round(value * 1_000) / 1_000;
}
