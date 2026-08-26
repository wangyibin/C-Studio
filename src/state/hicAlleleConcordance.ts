import type {
  ContactMapTile,
  ContactMapTileKey,
  ContactMapView,
} from "../App";
import type { ContactMapLayoutBlock } from "./importers";
import { forEachContactOverviewCell } from "./gfaHiCLinks";
import type { SyntenyAlleleSignalMask } from "./syntenyAllelePruning";
import type { ContactNormalization } from "./uiState";

export type HiCConcordanceOrientation = "parallel" | "antiparallel";
export type HiCConcordanceSupportUnit =
  | "raw-contact-weight"
  | "normalized-contact-weight";

export interface HiCAlleleConcordancePair {
  id: string;
  leftBlockId: string;
  rightBlockId: string;
  leftObjectId: string;
  rightObjectId: string;
  concordanceRatio: number;
  parallelRatio: number;
  antiparallelRatio: number;
  orientation: HiCConcordanceOrientation;
  support: number;
  supportUnit: HiCConcordanceSupportUnit;
  observedCellCount: number;
  resolvedWindowCount: number;
  coveredShorterWindowCount: number;
  lineRatio: number;
  lineExpectedRatio: number;
  lineEnrichment: number;
  lineZScore: number;
  lineWeight: number;
  lineOrientation: HiCConcordanceOrientation;
  lineCoveredLeftWindowCount: number;
  lineCoveredRightWindowCount: number;
  lineCoveredLeftWindowFraction: number;
  lineCoveredRightWindowFraction: number;
  lineReciprocalCoverage: number;
  lineEffectiveWindowCount: number;
  lineEffectiveWindowFraction: number;
  lineReciprocalSpanFraction: number;
  expectedOrientation?: HiCConcordanceOrientation;
  evidenceModel: "concordance" | "trans-line";
  confidence: "high" | "supported";
}

export interface HiCAlleleConcordanceResult {
  pairs: HiCAlleleConcordancePair[];
  maskByPair: Map<string, SyntenyAlleleSignalMask>;
  examinedPairCount: number;
  resolutionLimitedBlockCount: number;
  concordanceRatioCutoff: number;
  minimumSupport: number;
  requestedWindowCount: number;
  minimumLineWeight: number;
  minimumLineEnrichment: number;
  minimumLineZScore: number;
  minimumLineReciprocalCoverage: number;
  minimumLineEffectiveWindowFraction: number;
  minimumLineReciprocalSpanFraction: number;
  fingerprint: string;
}

export interface HiCAlleleConcordanceOptions {
  concordanceRatioCutoff?: number;
  minimumSupport?: number;
  requestedWindowCount?: number;
  minimumResolvedWindowCount?: number;
  minimumObservedCellCount?: number;
  minimumCoveredWindowCount?: number;
  minimumCoveredWindowFraction?: number;
  minimumLineWeight?: number;
  minimumLineEnrichment?: number;
  minimumLineZScore?: number;
  minimumLineReciprocalCoverage?: number;
  minimumLineEffectiveWindowFraction?: number;
  minimumLineReciprocalSpanFraction?: number;
  expectedOrientation?: HiCConcordanceOrientation;
  requireDifferentObjects?: boolean;
}

export interface HiCAlleleConcordanceLoadRequest {
  sourceBlockId: string;
  targetBlockId: string;
  expectedOrientation?: HiCConcordanceOrientation;
  objectLineId?: string;
  objectLineEnrichment?: number;
}

export interface HiCAlleleConcordanceQueryPlan {
  status: "ready";
  sourceBlock: ContactMapLayoutBlock;
  targetBlock: ContactMapLayoutBlock;
  sourceResolution: number;
  targetResolution: number;
  tileSizeBins: number;
  tiles: ContactMapTileKey[];
  requestedWindowCount: number;
  expectedOrientation?: HiCConcordanceOrientation;
  objectLineId?: string;
  objectLineEnrichment?: number;
}

export interface HiCObjectTransLine {
  id: string;
  leftObjectId: string;
  rightObjectId: string;
  orientation: HiCConcordanceOrientation;
  mode: number;
  windowCount: number;
  support: number;
  lineRatio: number;
  expectedLineRatio: number;
  enrichment: number;
  excessRatio: number;
  effectiveWindowCount: number;
}

export interface HiCTransLineCandidateResult {
  requests: HiCAlleleConcordanceLoadRequest[];
  objectLines: HiCObjectTransLine[];
  examinedObjectPairCount: number;
  resolutionLimitedObjectPairCount: number;
  fingerprint: string;
}

export interface HiCTransLineCandidateOptions {
  requestedWindowCount?: number;
  minimumSupport?: number;
  minimumEnrichment?: number;
  minimumExcessRatio?: number;
  minimumCoverageFraction?: number;
  minimumLineSpanFraction?: number;
  minimumEffectiveLineFraction?: number;
  projectionPaddingWindows?: number;
  candidatesPerSelection?: number;
}

export interface HiCAlleleConcordanceUnresolvedPlan {
  status: "unresolved";
  reason: string;
  resolution?: number;
}

export type HiCAlleleConcordancePlan =
  | HiCAlleleConcordanceQueryPlan
  | HiCAlleleConcordanceUnresolvedPlan;

export type HiCAlleleConcordanceLoadResult =
  | {
    status: "ready";
    result: HiCAlleleConcordanceResult;
    complete: boolean;
    missingTileCount: number;
  }
  | {
    status: "unresolved" | "unavailable" | "error";
    reason: string;
    resolution?: number;
  };

export type HiCAlleleConcordanceBatchLoader = (
  requests: ReadonlyArray<HiCAlleleConcordanceLoadRequest>,
) => Promise<HiCAlleleConcordanceLoadResult[]>;

interface BinMembership {
  block: ContactMapLayoutBlock;
  weight: number;
  localSourceCoordinate: number;
}

interface PairAccumulator {
  left: ContactMapLayoutBlock;
  right: ContactMapLayoutBlock;
  binWidth: number;
  resolvedWindowCount: number;
  shorterSide: "left" | "right";
  support: number;
  observedCellCount: number;
  coveredShorterWindows: Set<number>;
  differenceWeights: Map<number, number>;
  sumWeights: Map<number, number>;
  leftWindowCount: number;
  rightWindowCount: number;
  leftWindowWeights: Map<number, number>;
  rightWindowWeights: Map<number, number>;
  cellWeights: Map<number, number>;
}

const defaultOptions = {
  concordanceRatioCutoff: 0.2,
  minimumSupport: 20,
  requestedWindowCount: 50,
  minimumResolvedWindowCount: 5,
  minimumObservedCellCount: 3,
  minimumCoveredWindowCount: 3,
  minimumCoveredWindowFraction: 0.1,
  minimumLineWeight: 5,
  minimumLineEnrichment: 1.5,
  minimumLineZScore: 3,
  minimumLineReciprocalCoverage: 0.1,
  minimumLineEffectiveWindowFraction: 0,
  minimumLineReciprocalSpanFraction: 0.1,
};

const highConfidenceLineThresholds = {
  minimumZScore: 4,
  minimumReciprocalCoverage: 0.2,
  minimumEffectiveWindowFraction: 0.1,
  minimumReciprocalSpanFraction: 0.2,
};

const defaultTransLineCandidateOptions = {
  requestedWindowCount: 50,
  minimumSupport: 100,
  minimumEnrichment: 1.3,
  minimumExcessRatio: 0.02,
  minimumCoverageFraction: 0.75,
  minimumLineSpanFraction: 0.75,
  minimumEffectiveLineFraction: 0.4,
  projectionPaddingWindows: 1,
  candidatesPerSelection: 24,
};

const maximumAlleleEvidenceTilesPerPair = 16;

interface ObjectSpan {
  objectId: string;
  start: number;
  end: number;
  blocks: ContactMapLayoutBlock[];
}

interface ObjectBinMembership {
  object: ObjectSpan;
  weight: number;
  normalizedCoordinate: number;
}

interface ObjectLineAccumulator {
  left: ObjectSpan;
  right: ObjectSpan;
  windowCount: number;
  support: number;
  coveredLeftWindows: Set<number>;
  coveredRightWindows: Set<number>;
  differenceWeights: Map<number, number>;
  sumWeights: Map<number, number>;
  cellWeights: Map<number, number>;
}

/**
 * Detect distributed cross-object Hi-C lines, then project each line onto a
 * bounded, per-selection contig shortlist. This precedes the fine concordance
 * query; it does not change AGP order or use sequence-synteny evidence.
 */
export function buildHiCTransLineCandidates(
  contactMap: ContactMapView,
  blocks: ReadonlyArray<ContactMapLayoutBlock>,
  selectedBlockIds: ReadonlySet<string>,
  options: HiCTransLineCandidateOptions = {},
): HiCTransLineCandidateResult {
  const resolvedOptions = sanitizeTransLineCandidateOptions(options);
  const resolution = Number.isFinite(contactMap.resolution)
    ? Math.max(1, Math.floor(contactMap.resolution))
    : 0;
  const minimumObjectLineSupport = (contactMap.normalization ?? "raw") === "raw"
    ? resolvedOptions.minimumSupport
    : 0;
  if (resolution <= 0 || selectedBlockIds.size === 0) {
    return emptyTransLineCandidateResult(contactMap, resolvedOptions);
  }
  const objectSpans = buildObjectSpans(blocks.filter(validLayoutBlock));
  const membershipsByBin = buildObjectBinMemberships(objectSpans, resolution);
  const accumulators = new Map<string, ObjectLineAccumulator>();
  const resolutionLimitedPairs = new Set<string>();

  forEachContactOverviewCell(contactMap, (xBin, yBin, count) => {
    if (!Number.isFinite(count) || count <= 0) {
      return;
    }
    const xMemberships = membershipsByBin.get(xBin);
    const yMemberships = membershipsByBin.get(yBin);
    if (!xMemberships || !yMemberships) {
      return;
    }
    for (const xMembership of xMemberships) {
      for (const yMembership of yMemberships) {
        if (xMembership.object.objectId === yMembership.object.objectId) {
          continue;
        }
        const ordered = xMembership.object.objectId.localeCompare(
          yMembership.object.objectId,
        ) <= 0;
        const left = ordered ? xMembership : yMembership;
        const right = ordered ? yMembership : xMembership;
        const key = canonicalHiCPairKey(left.object.objectId, right.object.objectId);
        const shorterLength = Math.min(
          left.object.end - left.object.start,
          right.object.end - right.object.start,
        );
        const windowCount = Math.min(
          resolvedOptions.requestedWindowCount,
          Math.floor(shorterLength / resolution),
        );
        if (windowCount < defaultOptions.minimumResolvedWindowCount) {
          resolutionLimitedPairs.add(key);
          continue;
        }
        const accumulator = accumulators.get(key) ?? {
          left: left.object,
          right: right.object,
          windowCount,
          support: 0,
          coveredLeftWindows: new Set<number>(),
          coveredRightWindows: new Set<number>(),
          differenceWeights: new Map<number, number>(),
          sumWeights: new Map<number, number>(),
          cellWeights: new Map<number, number>(),
        };
        const leftWindow = clampInteger(
          left.normalizedCoordinate * accumulator.windowCount,
          0,
          accumulator.windowCount - 1,
        );
        const rightWindow = clampInteger(
          right.normalizedCoordinate * accumulator.windowCount,
          0,
          accumulator.windowCount - 1,
        );
        const contribution = count * left.weight * right.weight;
        if (!Number.isFinite(contribution) || contribution <= 0) {
          continue;
        }
        accumulator.support += contribution;
        accumulator.coveredLeftWindows.add(leftWindow);
        accumulator.coveredRightWindows.add(rightWindow);
        incrementWeight(
          accumulator.differenceWeights,
          rightWindow - leftWindow,
          contribution,
        );
        incrementWeight(
          accumulator.sumWeights,
          rightWindow + leftWindow,
          contribution,
        );
        incrementWeight(
          accumulator.cellWeights,
          leftWindow * accumulator.windowCount + rightWindow,
          contribution,
        );
        accumulators.set(key, accumulator);
      }
    }
  });

  const objectLines = [...accumulators.values()].flatMap((accumulator) => {
    const line = strongestDistributedObjectLine(accumulator, resolvedOptions);
    const requiredCoverage = Math.ceil(
      accumulator.windowCount * resolvedOptions.minimumCoverageFraction,
    );
    if (
      !line
      || accumulator.support < minimumObjectLineSupport
      || accumulator.coveredLeftWindows.size < requiredCoverage
      || accumulator.coveredRightWindows.size < requiredCoverage
      || line.enrichment < resolvedOptions.minimumEnrichment
      || line.excessRatio < resolvedOptions.minimumExcessRatio
    ) {
      return [];
    }
    return [{
      id: `hic-trans-line:${encodeURIComponent(accumulator.left.objectId)}:`
        + encodeURIComponent(accumulator.right.objectId),
      leftObjectId: accumulator.left.objectId,
      rightObjectId: accumulator.right.objectId,
      orientation: line.orientation,
      mode: line.mode,
      windowCount: accumulator.windowCount,
      support: accumulator.support,
      lineRatio: line.lineRatio,
      expectedLineRatio: line.expectedLineRatio,
      enrichment: line.enrichment,
      excessRatio: line.excessRatio,
      effectiveWindowCount: line.effectiveWindowCount,
    } satisfies HiCObjectTransLine];
  }).sort((left, right) => (
    right.enrichment - left.enrichment
    || right.excessRatio - left.excessRatio
    || left.leftObjectId.localeCompare(right.leftObjectId)
    || left.rightObjectId.localeCompare(right.rightObjectId)
  ));

  const spansById = new Map(objectSpans.map((object) => [object.objectId, object]));
  const candidatesBySourceLine = new Map<string, Map<string, Array<{
    targetBlock: ContactMapLayoutBlock;
    distance: number;
    overlap: number;
    line: HiCObjectTransLine;
  }>>>();
  for (const line of objectLines) {
    const left = spansById.get(line.leftObjectId);
    const right = spansById.get(line.rightObjectId);
    if (!left || !right) {
      continue;
    }
    for (const [sourceObject, targetObject] of [[left, right], [right, left]] as const) {
      const sourceLength = sourceObject.end - sourceObject.start;
      const targetLength = targetObject.end - targetObject.start;
      for (const sourceBlock of sourceObject.blocks) {
        if (!selectedBlockIds.has(sourceBlock.id)) {
          continue;
        }
        const sourceWindowStart = (
          (sourceBlock.visualStart - sourceObject.start)
          / sourceLength
          * line.windowCount
        );
        const sourceWindowEnd = (
          (sourceBlock.visualEnd - sourceObject.start)
          / sourceLength
          * line.windowCount
        );
        let projectedStart: number;
        let projectedEnd: number;
        if (line.orientation === "parallel") {
          const signedMode = sourceObject.objectId === line.leftObjectId
            ? line.mode
            : -line.mode;
          projectedStart = sourceWindowStart + signedMode;
          projectedEnd = sourceWindowEnd + signedMode;
        } else {
          projectedStart = line.mode - sourceWindowEnd;
          projectedEnd = line.mode - sourceWindowStart;
        }
        projectedStart -= resolvedOptions.projectionPaddingWindows;
        projectedEnd += resolvedOptions.projectionPaddingWindows;
        const projectedMidpoint = (projectedStart + projectedEnd) / 2;
        for (const targetBlock of targetObject.blocks) {
          const targetWindowStart = (
            (targetBlock.visualStart - targetObject.start)
            / targetLength
            * line.windowCount
          );
          const targetWindowEnd = (
            (targetBlock.visualEnd - targetObject.start)
            / targetLength
            * line.windowCount
          );
          const overlap = Math.min(projectedEnd, targetWindowEnd)
            - Math.max(projectedStart, targetWindowStart);
          if (overlap <= 0) {
            continue;
          }
          const byLine = candidatesBySourceLine.get(sourceBlock.id) ?? new Map();
          const candidates = byLine.get(line.id) ?? [];
          candidates.push({
            targetBlock,
            distance: Math.abs(
              (targetWindowStart + targetWindowEnd) / 2 - projectedMidpoint,
            ),
            overlap,
            line,
          });
          byLine.set(line.id, candidates);
          candidatesBySourceLine.set(sourceBlock.id, byLine);
        }
      }
    }
  }

  const blocksById = new Map(blocks.map((block) => [block.id, block]));
  const requestsByKey = new Map<string, HiCAlleleConcordanceLoadRequest>();
  for (const sourceBlockId of [...selectedBlockIds].sort()) {
    const sourceBlock = blocksById.get(sourceBlockId);
    const byLine = candidatesBySourceLine.get(sourceBlockId);
    if (!sourceBlock || !byLine) {
      continue;
    }
    let queues = [...byLine.values()]
      .map((candidates) => [...candidates].sort((left, right) => (
        left.distance - right.distance
        || right.overlap - left.overlap
        || right.line.enrichment - left.line.enrichment
        || left.targetBlock.id.localeCompare(right.targetBlock.id)
      )))
      .sort((left, right) => (
        (right[0]?.line.enrichment ?? 0) - (left[0]?.line.enrichment ?? 0)
      ));
    let cursor = 0;
    let selectedCount = 0;
    while (queues.length > 0 && selectedCount < resolvedOptions.candidatesPerSelection) {
      const queue = queues[cursor % queues.length]!;
      const candidate = queue.shift();
      if (candidate) {
        const sameBlockOrientation = (sourceBlock.orientation === "-")
          === (candidate.targetBlock.orientation === "-");
        const expectedOrientation: HiCConcordanceOrientation = (
          (candidate.line.orientation === "parallel") === sameBlockOrientation
        ) ? "parallel" : "antiparallel";
        const request = {
          sourceBlockId,
          targetBlockId: candidate.targetBlock.id,
          expectedOrientation,
          objectLineId: candidate.line.id,
          objectLineEnrichment: candidate.line.enrichment,
        };
        const key = alleleConcordanceRequestKey(request);
        if (!requestsByKey.has(key)) {
          requestsByKey.set(key, request);
          selectedCount += 1;
        }
      }
      queues = queues.filter((values) => values.length > 0);
      cursor += 1;
    }
  }
  const requests = [...requestsByKey.values()];
  return {
    requests,
    objectLines,
    examinedObjectPairCount: accumulators.size,
    resolutionLimitedObjectPairCount: resolutionLimitedPairs.size,
    fingerprint: [
      "hic-trans-line-candidates-v1",
      contactMap.layoutScope ?? "no-layout",
      contactMap.renderGeneration ?? "no-generation",
      resolution,
      contactMap.normalization ?? "raw",
      ...objectLines.map((line) => (
        `${line.id}:${line.orientation}:${line.mode}:${line.enrichment.toPrecision(8)}:`
        + line.effectiveWindowCount.toPrecision(8)
      )),
      ...requests.map(alleleConcordanceRequestKey),
    ].join("|"),
  };
}

/** Plan a bounded full-contig rectangle at approximately 50 bins per shorter contig. */
export function planHiCAlleleConcordanceQuery(
  sourceBlock: ContactMapLayoutBlock,
  targetBlock: ContactMapLayoutBlock,
  availableResolutions: ReadonlyArray<number>,
  tileSizeBins = 256,
  requestedWindowCount = defaultOptions.requestedWindowCount,
  evidence: Pick<
    HiCAlleleConcordanceLoadRequest,
    "expectedOrientation" | "objectLineId" | "objectLineEnrichment"
  > = {},
): HiCAlleleConcordancePlan {
  if (!validLayoutBlock(sourceBlock) || !validLayoutBlock(targetBlock)) {
    return { status: "unresolved", reason: "An allelic-evidence contig has an invalid span." };
  }
  if (sourceBlock.sourceId === targetBlock.sourceId) {
    return { status: "unresolved", reason: "Occurrences of one source are handled as copy evidence." };
  }
  if (!Number.isSafeInteger(tileSizeBins) || tileSizeBins <= 0) {
    return { status: "unresolved", reason: "The contact tile size is invalid." };
  }
  const safeWindowCount = safePositiveInteger(
    requestedWindowCount,
    defaultOptions.requestedWindowCount,
  );
  const resolutions = [...new Set(
    availableResolutions
      .filter((resolution) => Number.isFinite(resolution) && resolution > 0)
      .map((resolution) => Math.round(resolution)),
  )].sort((left, right) => left - right);
  if (resolutions.length === 0) {
    return { status: "unresolved", reason: "No contact-map resolution is available for allelic evidence." };
  }
  const shortestLength = Math.min(blockLength(sourceBlock), blockLength(targetBlock));
  const desiredResolution = Math.max(1, Math.floor(shortestLength / safeWindowCount));
  const sourceResolution = [...resolutions]
    .reverse()
    .find((resolution) => resolution <= desiredResolution)
    ?? resolutions[0];
  const targetResolution = Math.max(
    sourceResolution,
    Math.ceil(desiredResolution / sourceResolution) * sourceResolution,
  );
  if (shortestLength < targetResolution * defaultOptions.minimumResolvedWindowCount) {
    return {
      status: "unresolved",
      resolution: targetResolution,
      reason: `${formatBp(targetResolution)} bins cannot resolve enough windows across the shorter contig.`,
    };
  }
  const sourceTiles = tilesForBlock(sourceBlock, targetResolution, tileSizeBins);
  const targetTiles = tilesForBlock(targetBlock, targetResolution, tileSizeBins);
  const tilesByKey = new Map<string, ContactMapTileKey>();
  for (const sourceTile of sourceTiles) {
    for (const targetTile of targetTiles) {
      const tileX = Math.min(sourceTile, targetTile);
      const tileY = Math.max(sourceTile, targetTile);
      tilesByKey.set(`${tileX}:${tileY}`, { tileX, tileY });
    }
  }
  const tiles = [...tilesByKey.values()].sort((left, right) => (
    left.tileY - right.tileY || left.tileX - right.tileX
  ));
  if (tiles.length > maximumAlleleEvidenceTilesPerPair) {
    return {
      status: "unresolved",
      resolution: targetResolution,
      reason: `Allelic evidence would require ${tiles.length} tiles; the safety limit is ${maximumAlleleEvidenceTilesPerPair}.`,
    };
  }
  return {
    status: "ready",
    sourceBlock,
    targetBlock,
    sourceResolution,
    targetResolution,
    tileSizeBins,
    tiles,
    requestedWindowCount: safeWindowCount,
    expectedOrientation: evidence.expectedOrientation,
    objectLineId: evidence.objectLineId,
    objectLineEnrichment: evidence.objectLineEnrichment,
  };
}

/** Score one bounded raw contact rectangle with the same binned concordance implementation. */
export function scoreHiCAlleleConcordanceQuery(
  plan: HiCAlleleConcordanceQueryPlan,
  tiles: ReadonlyArray<ContactMapTile>,
  normalization: ContactNormalization = "raw",
): HiCAlleleConcordanceLoadResult {
  const availableTileKeys = new Set(tiles.map((tile) => canonicalTileKey(tile)));
  const missingTileCount = plan.tiles.filter(
    (tile) => !availableTileKeys.has(canonicalTileKey(tile)),
  ).length;
  if (missingTileCount > 0) {
    return {
      status: "ready",
      result: emptyResult(
        sanitizeOptions({ requestedWindowCount: plan.requestedWindowCount }),
        0,
        {
          resolution: plan.targetResolution,
          normalization,
          viewport: pairViewport(plan.sourceBlock, plan.targetBlock),
          cells: [],
        },
      ),
      complete: false,
      missingTileCount,
    };
  }
  const map: ContactMapView = {
    resolution: plan.targetResolution,
    normalization,
    viewport: pairViewport(plan.sourceBlock, plan.targetBlock),
    cells: [],
    tileSizeBins: plan.tileSizeBins,
    tiles: [...tiles],
    layoutBlocks: [plan.sourceBlock, plan.targetBlock],
    visibleLayerComplete: true,
  };
  return {
    status: "ready",
    result: buildHiCAlleleConcordance(
      map,
      [plan.sourceBlock, plan.targetBlock],
      {
        requestedWindowCount: plan.requestedWindowCount,
        expectedOrientation: plan.expectedOrientation,
        requireDifferentObjects: true,
      },
    ),
    complete: true,
    missingTileCount: 0,
  };
}

/**
 * Approximate read-pair concordance from a completed binned whole-assembly
 * contact map. The score uses the dominant modes of y-x and y+x after scaling
 * by the shorter contig length. One matrix cell contributes its projected
 * contact weight at the source-coordinate midpoint of each bin.
 *
 * The current AGP remains the coordinate authority and is never changed. A
 * pair is rejected when the overview cannot resolve at least a handful of
 * windows or when its support is concentrated in too few shorter-axis windows;
 * this prevents one coarse hotspot from becoming a false allele call.
 */
export function buildHiCAlleleConcordance(
  contactMap: ContactMapView,
  blocks: ReadonlyArray<ContactMapLayoutBlock>,
  options: HiCAlleleConcordanceOptions = {},
): HiCAlleleConcordanceResult {
  const resolvedOptions = sanitizeOptions(options);
  const supportUnit: HiCConcordanceSupportUnit =
    (contactMap.normalization ?? "raw") === "raw"
      ? "raw-contact-weight"
      : "normalized-contact-weight";
  const resolution = Number.isFinite(contactMap.resolution)
    ? Math.max(1, Math.floor(contactMap.resolution))
    : 0;
  if (resolution <= 0) {
    return emptyResult(resolvedOptions, blocks.length, contactMap);
  }

  const validBlocks = blocks.filter(validLayoutBlock);
  const resolutionLimitedBlockCount = validBlocks.filter((block) => (
    blockLength(block) < resolution * resolvedOptions.minimumResolvedWindowCount
  )).length;
  const eligibleBlocks = validBlocks.filter((block) => (
    blockLength(block) >= resolution * resolvedOptions.minimumResolvedWindowCount
  ));
  const membershipsByBin = buildBinMemberships(eligibleBlocks, resolution);
  const accumulators = new Map<string, PairAccumulator>();

  forEachContactOverviewCell(contactMap, (xBin, yBin, count) => {
    if (!Number.isFinite(count) || count <= 0) {
      return;
    }
    const xMemberships = membershipsByBin.get(xBin);
    const yMemberships = membershipsByBin.get(yBin);
    if (!xMemberships || !yMemberships) {
      return;
    }
    for (const xMembership of xMemberships) {
      for (const yMembership of yMemberships) {
        const xBlock = xMembership.block;
        const yBlock = yMembership.block;
        if (
          xBlock.id === yBlock.id
          || xBlock.sourceId === yBlock.sourceId
          || (xBin === yBin && xBlock.id.localeCompare(yBlock.id) >= 0)
        ) {
          continue;
        }
        const [left, right, leftCoordinate, rightCoordinate] =
          xBlock.id.localeCompare(yBlock.id) <= 0
            ? [xBlock, yBlock, xMembership.localSourceCoordinate, yMembership.localSourceCoordinate]
            : [yBlock, xBlock, yMembership.localSourceCoordinate, xMembership.localSourceCoordinate];
        const key = canonicalHiCPairKey(left.id, right.id);
        const accumulator = accumulators.get(key) ?? createAccumulator(
          left,
          right,
          resolution,
          resolvedOptions.requestedWindowCount,
        );
        const contribution = count * xMembership.weight * yMembership.weight;
        if (!Number.isFinite(contribution) || contribution <= 0) {
          continue;
        }
        const differenceMode = Math.floor(
          (rightCoordinate - leftCoordinate) / accumulator.binWidth,
        );
        const sumMode = Math.floor(
          (rightCoordinate + leftCoordinate) / accumulator.binWidth,
        );
        incrementWeight(accumulator.differenceWeights, differenceMode, contribution);
        incrementWeight(accumulator.sumWeights, sumMode, contribution);
        accumulator.support += contribution;
        accumulator.observedCellCount += 1;
        const leftWindow = clampInteger(
          leftCoordinate / accumulator.binWidth,
          0,
          accumulator.leftWindowCount - 1,
        );
        const rightWindow = clampInteger(
          rightCoordinate / accumulator.binWidth,
          0,
          accumulator.rightWindowCount - 1,
        );
        incrementWeight(accumulator.leftWindowWeights, leftWindow, contribution);
        incrementWeight(accumulator.rightWindowWeights, rightWindow, contribution);
        incrementWeight(
          accumulator.cellWeights,
          leftWindow * accumulator.rightWindowCount + rightWindow,
          contribution,
        );
        const shorterCoordinate = accumulator.shorterSide === "left"
          ? leftCoordinate
          : rightCoordinate;
        accumulator.coveredShorterWindows.add(clampInteger(
          Math.floor(shorterCoordinate / accumulator.binWidth),
          0,
          accumulator.resolvedWindowCount - 1,
        ));
        accumulators.set(key, accumulator);
      }
    }
  });

  const pairs = [...accumulators.values()].flatMap((accumulator) => {
    const parallelWeight = maximumWeight(accumulator.differenceWeights);
    const antiparallelWeight = maximumWeight(accumulator.sumWeights);
    const parallelRatio = accumulator.support > 0
      ? parallelWeight / accumulator.support
      : 0;
    const antiparallelRatio = accumulator.support > 0
      ? antiparallelWeight / accumulator.support
      : 0;
    const concordanceRatio = Math.max(parallelRatio, antiparallelRatio);
    const orientation: HiCConcordanceOrientation = parallelRatio >= antiparallelRatio
      ? "parallel"
      : "antiparallel";
    const line = strongestPairLineBand(accumulator);
    const requiredCoveredWindows = Math.max(
      resolvedOptions.minimumCoveredWindowCount,
      Math.ceil(
        accumulator.resolvedWindowCount * resolvedOptions.minimumCoveredWindowFraction,
      ),
    );
    const commonQualityPasses = (
      accumulator.support < resolvedOptions.minimumSupport
      || accumulator.observedCellCount < resolvedOptions.minimumObservedCellCount
      || accumulator.coveredShorterWindows.size < requiredCoveredWindows
    ) === false;
    const differentObjectPasses = !resolvedOptions.requireDifferentObjects
      || accumulator.left.objectId !== accumulator.right.objectId;
    const classicConcordancePasses = concordanceRatio > resolvedOptions.concordanceRatioCutoff
      && (
        !resolvedOptions.expectedOrientation
        || orientation === resolvedOptions.expectedOrientation
      );
    const significantTransLinePasses = (
      line.lineWeight >= resolvedOptions.minimumLineWeight
      && line.lineEnrichment >= resolvedOptions.minimumLineEnrichment
      && line.lineZScore >= resolvedOptions.minimumLineZScore
      && line.lineReciprocalCoverage
        >= resolvedOptions.minimumLineReciprocalCoverage
      && line.lineEffectiveWindowFraction
        >= resolvedOptions.minimumLineEffectiveWindowFraction
      && line.lineReciprocalSpanFraction
        >= resolvedOptions.minimumLineReciprocalSpanFraction
      && (
        !resolvedOptions.expectedOrientation
        || line.lineOrientation === resolvedOptions.expectedOrientation
      )
    );
    const highConfidenceLinePasses = (
      line.lineWeight >= resolvedOptions.minimumLineWeight
      && line.lineEnrichment >= resolvedOptions.minimumLineEnrichment
      && line.lineZScore >= highConfidenceLineThresholds.minimumZScore
      && line.lineReciprocalCoverage
        >= highConfidenceLineThresholds.minimumReciprocalCoverage
      && line.lineEffectiveWindowFraction
        >= highConfidenceLineThresholds.minimumEffectiveWindowFraction
      && line.lineReciprocalSpanFraction
        >= highConfidenceLineThresholds.minimumReciprocalSpanFraction
      && (
        !resolvedOptions.expectedOrientation
        || line.lineOrientation === resolvedOptions.expectedOrientation
      )
    );
    if (
      !commonQualityPasses
      || !differentObjectPasses
      || (!classicConcordancePasses && !significantTransLinePasses)
    ) {
      return [];
    }
    const evidenceModel: HiCAlleleConcordancePair["evidenceModel"] =
      classicConcordancePasses ? "concordance" : "trans-line";
    const confidence: HiCAlleleConcordancePair["confidence"] =
      highConfidenceLinePasses ? "high" : "supported";
    return [{
      id: `hic-concordance:${encodeURIComponent(accumulator.left.id)}:${encodeURIComponent(accumulator.right.id)}`,
      leftBlockId: accumulator.left.id,
      rightBlockId: accumulator.right.id,
      leftObjectId: accumulator.left.objectId,
      rightObjectId: accumulator.right.objectId,
      concordanceRatio,
      parallelRatio,
      antiparallelRatio,
      orientation: evidenceModel === "concordance" ? orientation : line.lineOrientation,
      support: accumulator.support,
      supportUnit,
      observedCellCount: accumulator.observedCellCount,
      resolvedWindowCount: accumulator.resolvedWindowCount,
      coveredShorterWindowCount: accumulator.coveredShorterWindows.size,
      ...line,
      expectedOrientation: resolvedOptions.expectedOrientation,
      evidenceModel,
      confidence,
    }];
  }).sort((left, right) => (
    right.concordanceRatio - left.concordanceRatio
    || right.support - left.support
    || left.leftBlockId.localeCompare(right.leftBlockId)
    || left.rightBlockId.localeCompare(right.rightBlockId)
  ));
  const maskByPair = new Map<string, SyntenyAlleleSignalMask>();
  for (const pair of pairs.filter((candidate) => candidate.confidence === "high")) {
    const key = canonicalHiCPairKey(pair.leftBlockId, pair.rightBlockId);
    maskByPair.set(key, {
      sourceBlockId: pair.leftBlockId,
      targetBlockId: pair.rightBlockId,
      factor: 0,
      reason: "hic-concordance",
      sourceGroupId: pair.id,
      targetGroupId: pair.id,
    });
  }
  const fingerprint = [
    "hic-allele-concordance-v3",
    contactMap.layoutScope ?? "no-layout",
    contactMap.renderGeneration ?? "no-generation",
    resolution,
    contactMap.normalization ?? "raw",
    resolvedOptions.requestedWindowCount,
    resolvedOptions.minimumSupport,
    resolvedOptions.concordanceRatioCutoff,
    resolvedOptions.minimumLineWeight,
    resolvedOptions.minimumLineEnrichment,
    resolvedOptions.minimumLineZScore,
    resolvedOptions.minimumLineReciprocalCoverage,
    resolvedOptions.minimumLineEffectiveWindowFraction,
    resolvedOptions.minimumLineReciprocalSpanFraction,
    resolvedOptions.expectedOrientation ?? "any-orientation",
    resolvedOptions.requireDifferentObjects ? "cross-object" : "any-object",
    ...pairs.map((pair) => (
      `${pair.id}:${pair.concordanceRatio.toPrecision(8)}:${pair.support.toPrecision(8)}:`
      + `${pair.orientation}:${pair.lineZScore.toPrecision(8)}:${pair.evidenceModel}:`
      + `${pair.confidence}:`
      + `${pair.coveredShorterWindowCount}/${pair.resolvedWindowCount}:`
      + `${pair.lineReciprocalCoverage.toPrecision(8)}:`
      + `${pair.lineEffectiveWindowFraction.toPrecision(8)}:`
      + pair.lineReciprocalSpanFraction.toPrecision(8)
    )),
  ].join("|");

  return {
    pairs,
    maskByPair,
    examinedPairCount: accumulators.size,
    resolutionLimitedBlockCount,
    concordanceRatioCutoff: resolvedOptions.concordanceRatioCutoff,
    minimumSupport: resolvedOptions.minimumSupport,
    requestedWindowCount: resolvedOptions.requestedWindowCount,
    minimumLineWeight: resolvedOptions.minimumLineWeight,
    minimumLineEnrichment: resolvedOptions.minimumLineEnrichment,
    minimumLineZScore: resolvedOptions.minimumLineZScore,
    minimumLineReciprocalCoverage: resolvedOptions.minimumLineReciprocalCoverage,
    minimumLineEffectiveWindowFraction:
      resolvedOptions.minimumLineEffectiveWindowFraction,
    minimumLineReciprocalSpanFraction:
      resolvedOptions.minimumLineReciprocalSpanFraction,
    fingerprint,
  };
}

function sanitizeOptions(options: HiCAlleleConcordanceOptions) {
  return {
    concordanceRatioCutoff: finitePositiveOrZero(
      options.concordanceRatioCutoff,
      defaultOptions.concordanceRatioCutoff,
    ),
    minimumSupport: finitePositive(
      options.minimumSupport,
      defaultOptions.minimumSupport,
    ),
    requestedWindowCount: safePositiveInteger(
      options.requestedWindowCount,
      defaultOptions.requestedWindowCount,
    ),
    minimumResolvedWindowCount: safePositiveInteger(
      options.minimumResolvedWindowCount,
      defaultOptions.minimumResolvedWindowCount,
    ),
    minimumObservedCellCount: safePositiveInteger(
      options.minimumObservedCellCount,
      defaultOptions.minimumObservedCellCount,
    ),
    minimumCoveredWindowCount: safePositiveInteger(
      options.minimumCoveredWindowCount,
      defaultOptions.minimumCoveredWindowCount,
    ),
    minimumCoveredWindowFraction: clampNumber(
      finitePositiveOrZero(
        options.minimumCoveredWindowFraction,
        defaultOptions.minimumCoveredWindowFraction,
      ),
      0,
      1,
    ),
    minimumLineWeight: finitePositive(
      options.minimumLineWeight,
      defaultOptions.minimumLineWeight,
    ),
    minimumLineEnrichment: finitePositive(
      options.minimumLineEnrichment,
      defaultOptions.minimumLineEnrichment,
    ),
    minimumLineZScore: finitePositive(
      options.minimumLineZScore,
      defaultOptions.minimumLineZScore,
    ),
    minimumLineReciprocalCoverage: clampNumber(
      finitePositiveOrZero(
        options.minimumLineReciprocalCoverage,
        defaultOptions.minimumLineReciprocalCoverage,
      ),
      0,
      1,
    ),
    minimumLineEffectiveWindowFraction: clampNumber(
      finitePositiveOrZero(
        options.minimumLineEffectiveWindowFraction,
        defaultOptions.minimumLineEffectiveWindowFraction,
      ),
      0,
      1,
    ),
    minimumLineReciprocalSpanFraction: clampNumber(
      finitePositiveOrZero(
        options.minimumLineReciprocalSpanFraction,
        defaultOptions.minimumLineReciprocalSpanFraction,
      ),
      0,
      1,
    ),
    expectedOrientation: options.expectedOrientation,
    requireDifferentObjects: options.requireDifferentObjects === true,
  };
}

function emptyResult(
  options: ReturnType<typeof sanitizeOptions>,
  resolutionLimitedBlockCount: number,
  contactMap: ContactMapView,
): HiCAlleleConcordanceResult {
  return {
    pairs: [],
    maskByPair: new Map(),
    examinedPairCount: 0,
    resolutionLimitedBlockCount,
    concordanceRatioCutoff: options.concordanceRatioCutoff,
    minimumSupport: options.minimumSupport,
    requestedWindowCount: options.requestedWindowCount,
    minimumLineWeight: options.minimumLineWeight,
    minimumLineEnrichment: options.minimumLineEnrichment,
    minimumLineZScore: options.minimumLineZScore,
    minimumLineReciprocalCoverage: options.minimumLineReciprocalCoverage,
    minimumLineEffectiveWindowFraction: options.minimumLineEffectiveWindowFraction,
    minimumLineReciprocalSpanFraction: options.minimumLineReciprocalSpanFraction,
    fingerprint: [
      "hic-allele-concordance-v3",
      contactMap.layoutScope ?? "no-layout",
      contactMap.renderGeneration ?? "no-generation",
      contactMap.resolution,
      contactMap.normalization ?? "raw",
      "unavailable",
    ].join("|"),
  };
}

function validLayoutBlock(block: ContactMapLayoutBlock) {
  return Number.isFinite(block.visualStart)
    && Number.isFinite(block.visualEnd)
    && block.visualEnd > block.visualStart
    && Number.isFinite(block.sourceStart)
    && Number.isFinite(block.sourceEnd)
    && block.sourceEnd > block.sourceStart;
}

function blockLength(block: ContactMapLayoutBlock) {
  return block.visualEnd - block.visualStart;
}

function buildBinMemberships(
  blocks: ReadonlyArray<ContactMapLayoutBlock>,
  resolution: number,
) {
  const overlapsByBin = new Map<number, Array<{
    block: ContactMapLayoutBlock;
    overlap: number;
    overlapMidpoint: number;
  }>>();
  for (const block of blocks) {
    const firstBin = Math.floor(block.visualStart / resolution);
    const lastBin = Math.floor((block.visualEnd - 1) / resolution);
    for (let bin = firstBin; bin <= lastBin; bin += 1) {
      const overlapStart = Math.max(block.visualStart, bin * resolution);
      const overlapEnd = Math.min(block.visualEnd, (bin + 1) * resolution);
      const overlap = overlapEnd - overlapStart;
      if (overlap <= 0) {
        continue;
      }
      const values = overlapsByBin.get(bin) ?? [];
      values.push({
        block,
        overlap,
        overlapMidpoint: (overlapStart + overlapEnd) / 2,
      });
      overlapsByBin.set(bin, values);
    }
  }

  const membershipsByBin = new Map<number, BinMembership[]>();
  for (const [bin, overlaps] of overlapsByBin) {
    membershipsByBin.set(bin, overlaps.map(({ block, overlap, overlapMidpoint }) => {
      const displayedOffset = overlapMidpoint - block.visualStart;
      return {
        block,
        // The matrix cell represents the complete display bin, including any
        // neighboring layout interval not present in this bounded pair plan.
        weight: overlap / resolution,
        localSourceCoordinate: block.orientation === "-"
          ? blockLength(block) - displayedOffset
          : displayedOffset,
      };
    }));
  }
  return membershipsByBin;
}

function buildObjectSpans(
  blocks: ReadonlyArray<ContactMapLayoutBlock>,
): ObjectSpan[] {
  const spansById = new Map<string, ObjectSpan>();
  for (const block of blocks) {
    const span = spansById.get(block.objectId) ?? {
      objectId: block.objectId,
      start: block.visualStart,
      end: block.visualEnd,
      blocks: [],
    };
    span.start = Math.min(span.start, block.visualStart);
    span.end = Math.max(span.end, block.visualEnd);
    span.blocks.push(block);
    spansById.set(block.objectId, span);
  }
  return [...spansById.values()]
    .filter((span) => span.end > span.start)
    .map((span) => ({
      ...span,
      blocks: [...span.blocks].sort((left, right) => (
        left.visualStart - right.visualStart
        || left.visualEnd - right.visualEnd
        || left.id.localeCompare(right.id)
      )),
    }))
    .sort((left, right) => (
      left.start - right.start
      || left.end - right.end
      || left.objectId.localeCompare(right.objectId)
    ));
}

function buildObjectBinMemberships(
  objects: ReadonlyArray<ObjectSpan>,
  resolution: number,
) {
  const membershipsByBin = new Map<number, ObjectBinMembership[]>();
  for (const object of objects) {
    const length = object.end - object.start;
    const firstBin = Math.floor(object.start / resolution);
    const lastBin = Math.floor((object.end - 1) / resolution);
    for (let bin = firstBin; bin <= lastBin; bin += 1) {
      const overlapStart = Math.max(object.start, bin * resolution);
      const overlapEnd = Math.min(object.end, (bin + 1) * resolution);
      if (overlapEnd <= overlapStart) {
        continue;
      }
      const values = membershipsByBin.get(bin) ?? [];
      values.push({
        object,
        weight: (overlapEnd - overlapStart) / resolution,
        normalizedCoordinate: ((overlapStart + overlapEnd) / 2 - object.start) / length,
      });
      membershipsByBin.set(bin, values);
    }
  }
  return membershipsByBin;
}

function strongestDistributedObjectLine(
  accumulator: ObjectLineAccumulator,
  options: ReturnType<typeof sanitizeTransLineCandidateOptions>,
) {
  let best: {
    orientation: HiCConcordanceOrientation;
    mode: number;
    lineRatio: number;
    expectedLineRatio: number;
    enrichment: number;
    excessRatio: number;
    effectiveWindowCount: number;
    distributedExcessScore: number;
  } | null = null;
  if (accumulator.support <= 0) {
    return best;
  }
  const minimumSpan = Math.ceil(
    accumulator.windowCount * options.minimumLineSpanFraction,
  );
  for (const orientation of ["parallel", "antiparallel"] as const) {
    const weights = orientation === "parallel"
      ? accumulator.differenceWeights
      : accumulator.sumWeights;
    const minimumMode = orientation === "parallel" ? -accumulator.windowCount + 1 : 0;
    const maximumMode = orientation === "parallel"
      ? accumulator.windowCount - 1
      : accumulator.windowCount * 2 - 2;
    for (let mode = minimumMode; mode <= maximumMode; mode += 1) {
      const opportunities = objectLineOpportunityCount(
        accumulator.windowCount,
        orientation,
        mode,
      );
      if (opportunities < minimumSpan) {
        continue;
      }
      const lineCellWeights: number[] = [];
      for (const [cellKey, weight] of accumulator.cellWeights) {
        const leftWindow = Math.floor(cellKey / accumulator.windowCount);
        const rightWindow = cellKey % accumulator.windowCount;
        const onLine = orientation === "parallel"
          ? rightWindow - leftWindow === mode
          : rightWindow + leftWindow === mode;
        if (onLine) {
          lineCellWeights.push(weight);
        }
      }
      const lineWeight = weights.get(mode) ?? 0;
      const squaredWeight = lineCellWeights.reduce(
        (sum, weight) => sum + weight * weight,
        0,
      );
      const effectiveWindowCount = squaredWeight > 0
        ? lineWeight * lineWeight / squaredWeight
        : 0;
      if (
        effectiveWindowCount
        < Math.max(3, opportunities * options.minimumEffectiveLineFraction)
      ) {
        continue;
      }
      const lineRatio = lineWeight / accumulator.support;
      const expectedLineRatio = opportunities
        / (accumulator.windowCount * accumulator.windowCount);
      const excessRatio = lineRatio - expectedLineRatio;
      const candidate = {
        orientation,
        mode,
        lineRatio,
        expectedLineRatio,
        enrichment: expectedLineRatio > 0 ? lineRatio / expectedLineRatio : 0,
        excessRatio,
        effectiveWindowCount,
        distributedExcessScore: excessRatio * Math.sqrt(effectiveWindowCount),
      };
      if (
        !best
        || candidate.distributedExcessScore > best.distributedExcessScore
        || (
          candidate.distributedExcessScore === best.distributedExcessScore
          && (
            candidate.excessRatio > best.excessRatio
            || (
              candidate.excessRatio === best.excessRatio
              && candidate.enrichment > best.enrichment
            )
          )
        )
      ) {
        best = candidate;
      }
    }
  }
  return best;
}

function objectLineOpportunityCount(
  windowCount: number,
  orientation: HiCConcordanceOrientation,
  mode: number,
) {
  return orientation === "parallel"
    ? Math.max(0, windowCount - Math.abs(mode))
    : Math.max(0, windowCount - Math.abs(mode - (windowCount - 1)));
}

function alleleConcordanceRequestKey(
  request: Pick<HiCAlleleConcordanceLoadRequest, "sourceBlockId" | "targetBlockId">,
) {
  return canonicalHiCPairKey(request.sourceBlockId, request.targetBlockId);
}

function canonicalHiCPairKey(first: string, second: string) {
  return first.localeCompare(second) <= 0
    ? `${first}\u0000${second}`
    : `${second}\u0000${first}`;
}

function sanitizeTransLineCandidateOptions(options: HiCTransLineCandidateOptions) {
  return {
    requestedWindowCount: safePositiveInteger(
      options.requestedWindowCount,
      defaultTransLineCandidateOptions.requestedWindowCount,
    ),
    minimumSupport: finitePositive(
      options.minimumSupport,
      defaultTransLineCandidateOptions.minimumSupport,
    ),
    minimumEnrichment: finitePositive(
      options.minimumEnrichment,
      defaultTransLineCandidateOptions.minimumEnrichment,
    ),
    minimumExcessRatio: finitePositiveOrZero(
      options.minimumExcessRatio,
      defaultTransLineCandidateOptions.minimumExcessRatio,
    ),
    minimumCoverageFraction: clampNumber(
      finitePositiveOrZero(
        options.minimumCoverageFraction,
        defaultTransLineCandidateOptions.minimumCoverageFraction,
      ),
      0,
      1,
    ),
    minimumLineSpanFraction: clampNumber(
      finitePositiveOrZero(
        options.minimumLineSpanFraction,
        defaultTransLineCandidateOptions.minimumLineSpanFraction,
      ),
      0,
      1,
    ),
    minimumEffectiveLineFraction: clampNumber(
      finitePositiveOrZero(
        options.minimumEffectiveLineFraction,
        defaultTransLineCandidateOptions.minimumEffectiveLineFraction,
      ),
      0,
      1,
    ),
    projectionPaddingWindows: finitePositiveOrZero(
      options.projectionPaddingWindows,
      defaultTransLineCandidateOptions.projectionPaddingWindows,
    ),
    candidatesPerSelection: safePositiveInteger(
      options.candidatesPerSelection,
      defaultTransLineCandidateOptions.candidatesPerSelection,
    ),
  };
}

function emptyTransLineCandidateResult(
  contactMap: ContactMapView,
  options: ReturnType<typeof sanitizeTransLineCandidateOptions>,
): HiCTransLineCandidateResult {
  return {
    requests: [],
    objectLines: [],
    examinedObjectPairCount: 0,
    resolutionLimitedObjectPairCount: 0,
    fingerprint: [
      "hic-trans-line-candidates-v1",
      contactMap.layoutScope ?? "no-layout",
      contactMap.renderGeneration ?? "no-generation",
      contactMap.resolution,
      contactMap.normalization ?? "raw",
      options.requestedWindowCount,
      "unavailable",
    ].join("|"),
  };
}

function createAccumulator(
  left: ContactMapLayoutBlock,
  right: ContactMapLayoutBlock,
  resolution: number,
  requestedWindowCount: number,
): PairAccumulator {
  const leftLength = blockLength(left);
  const rightLength = blockLength(right);
  const shorterLength = Math.min(leftLength, rightLength);
  const resolvedWindowCount = Math.max(
    1,
    Math.min(requestedWindowCount, Math.floor(shorterLength / resolution)),
  );
  const binWidth = Math.max(1, Math.floor(shorterLength / resolvedWindowCount));
  return {
    left,
    right,
    binWidth,
    resolvedWindowCount,
    shorterSide: leftLength <= rightLength ? "left" : "right",
    support: 0,
    observedCellCount: 0,
    coveredShorterWindows: new Set(),
    differenceWeights: new Map(),
    sumWeights: new Map(),
    leftWindowCount: Math.max(1, Math.ceil(leftLength / binWidth)),
    rightWindowCount: Math.max(1, Math.ceil(rightLength / binWidth)),
    leftWindowWeights: new Map(),
    rightWindowWeights: new Map(),
    cellWeights: new Map(),
  };
}

function tilesForBlock(
  block: ContactMapLayoutBlock,
  resolution: number,
  tileSizeBins: number,
) {
  const tileSpanBp = resolution * tileSizeBins;
  const first = Math.floor(block.visualStart / tileSpanBp);
  const last = Math.floor((block.visualEnd - 1) / tileSpanBp);
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

function canonicalTileKey(tile: Pick<ContactMapTileKey, "tileX" | "tileY">) {
  const tileX = Math.min(tile.tileX, tile.tileY);
  const tileY = Math.max(tile.tileX, tile.tileY);
  return `${tileX}:${tileY}`;
}

function pairViewport(
  sourceBlock: ContactMapLayoutBlock,
  targetBlock: ContactMapLayoutBlock,
) {
  const start = Math.min(sourceBlock.visualStart, targetBlock.visualStart);
  const end = Math.max(sourceBlock.visualEnd, targetBlock.visualEnd);
  return { xStart: start, xEnd: end, yStart: start, yEnd: end };
}

function formatBp(value: number) {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })} Mb`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toLocaleString(undefined, { maximumFractionDigits: 2 })} kb`;
  }
  return `${Math.round(value)} bp`;
}

function incrementWeight(weights: Map<number, number>, key: number, value: number) {
  weights.set(key, (weights.get(key) ?? 0) + value);
}

function maximumWeight(weights: ReadonlyMap<number, number>) {
  let maximum = 0;
  for (const weight of weights.values()) {
    maximum = Math.max(maximum, weight);
  }
  return maximum;
}

function strongestPairLineBand(accumulator: PairAccumulator) {
  const empty = {
    lineRatio: 0,
    lineExpectedRatio: 0,
    lineEnrichment: 0,
    lineZScore: 0,
    lineWeight: 0,
    lineOrientation: "parallel" as HiCConcordanceOrientation,
    lineCoveredLeftWindowCount: 0,
    lineCoveredRightWindowCount: 0,
    lineCoveredLeftWindowFraction: 0,
    lineCoveredRightWindowFraction: 0,
    lineReciprocalCoverage: 0,
    lineEffectiveWindowCount: 0,
    lineEffectiveWindowFraction: 0,
    lineReciprocalSpanFraction: 0,
  };
  if (accumulator.support <= 0) {
    return empty;
  }
  let best = empty;
  let bestMode = 0;
  const radius = 1;
  for (const orientation of ["parallel", "antiparallel"] as const) {
    const weights = orientation === "parallel"
      ? accumulator.differenceWeights
      : accumulator.sumWeights;
    const minimumMode = orientation === "parallel"
      ? -accumulator.leftWindowCount + 1
      : 0;
    const maximumMode = orientation === "parallel"
      ? accumulator.rightWindowCount - 1
      : accumulator.leftWindowCount + accumulator.rightWindowCount - 2;
    for (let mode = minimumMode; mode <= maximumMode; mode += 1) {
      let observed = 0;
      for (let offset = -radius; offset <= radius; offset += 1) {
        observed += weights.get(mode + offset) ?? 0;
      }
      let expected = 0;
      for (const [leftWindow, leftWeight] of accumulator.leftWindowWeights) {
        for (let offset = -radius; offset <= radius; offset += 1) {
          const rightWindow = orientation === "parallel"
            ? leftWindow + mode + offset
            : mode + offset - leftWindow;
          expected += leftWeight
            * (accumulator.rightWindowWeights.get(rightWindow) ?? 0)
            / accumulator.support;
        }
      }
      const expectedFloor = Math.max(expected, 1);
      const candidate = {
        ...empty,
        lineRatio: observed / accumulator.support,
        lineExpectedRatio: expected / accumulator.support,
        lineEnrichment: observed / expectedFloor,
        lineZScore: (observed - expected) / Math.sqrt(expectedFloor),
        lineWeight: observed,
        lineOrientation: orientation,
      };
      if (
        candidate.lineZScore > best.lineZScore
        || (
          candidate.lineZScore === best.lineZScore
          && (
            candidate.lineEnrichment > best.lineEnrichment
            || (
              candidate.lineEnrichment === best.lineEnrichment
              && (
                candidate.lineRatio > best.lineRatio
                || (
                  candidate.lineRatio === best.lineRatio
                  && mode < bestMode
                )
              )
            )
          )
        )
      ) {
        best = candidate;
        bestMode = mode;
      }
    }
  }
  return {
    ...best,
    ...pairLineDistributionMetrics(
      accumulator,
      best.lineOrientation,
      bestMode,
      radius,
    ),
  };
}

function pairLineDistributionMetrics(
  accumulator: PairAccumulator,
  orientation: HiCConcordanceOrientation,
  mode: number,
  radius: number,
) {
  const leftWeights = new Map<number, number>();
  const rightWeights = new Map<number, number>();
  for (const [cellKey, weight] of accumulator.cellWeights) {
    const leftWindow = Math.floor(cellKey / accumulator.rightWindowCount);
    const rightWindow = cellKey % accumulator.rightWindowCount;
    const cellMode = orientation === "parallel"
      ? rightWindow - leftWindow
      : rightWindow + leftWindow;
    if (Math.abs(cellMode - mode) > radius) {
      continue;
    }
    incrementWeight(leftWeights, leftWindow, weight);
    incrementWeight(rightWeights, rightWindow, weight);
  }
  const lineWeight = [...leftWeights.values()].reduce(
    (sum, weight) => sum + weight,
    0,
  );
  const effectiveLeftWindowCount = effectiveWeightedCount(leftWeights, lineWeight);
  const effectiveRightWindowCount = effectiveWeightedCount(rightWeights, lineWeight);
  const lineCoveredLeftWindowFraction = leftWeights.size / accumulator.leftWindowCount;
  const lineCoveredRightWindowFraction = rightWeights.size / accumulator.rightWindowCount;
  const lineEffectiveWindowCount = Math.min(
    effectiveLeftWindowCount,
    effectiveRightWindowCount,
  );
  return {
    lineCoveredLeftWindowCount: leftWeights.size,
    lineCoveredRightWindowCount: rightWeights.size,
    lineCoveredLeftWindowFraction,
    lineCoveredRightWindowFraction,
    lineReciprocalCoverage: Math.min(
      lineCoveredLeftWindowFraction,
      lineCoveredRightWindowFraction,
    ),
    lineEffectiveWindowCount,
    lineEffectiveWindowFraction: Math.min(
      effectiveLeftWindowCount / accumulator.leftWindowCount,
      effectiveRightWindowCount / accumulator.rightWindowCount,
    ),
    lineReciprocalSpanFraction: Math.min(
      coveredWindowSpanFraction(leftWeights, accumulator.leftWindowCount),
      coveredWindowSpanFraction(rightWeights, accumulator.rightWindowCount),
    ),
  };
}

function effectiveWeightedCount(
  weights: ReadonlyMap<number, number>,
  totalWeight: number,
) {
  if (totalWeight <= 0) {
    return 0;
  }
  let squaredWeight = 0;
  for (const weight of weights.values()) {
    squaredWeight += weight * weight;
  }
  return squaredWeight > 0 ? totalWeight * totalWeight / squaredWeight : 0;
}

function coveredWindowSpanFraction(
  weights: ReadonlyMap<number, number>,
  windowCount: number,
) {
  if (weights.size === 0 || windowCount <= 0) {
    return 0;
  }
  const windows = [...weights.keys()];
  return (Math.max(...windows) - Math.min(...windows) + 1) / windowCount;
}

function finitePositive(value: number | undefined, fallback: number) {
  return Number.isFinite(value) && (value ?? 0) > 0 ? value as number : fallback;
}

function finitePositiveOrZero(value: number | undefined, fallback: number) {
  return Number.isFinite(value) && (value ?? -1) >= 0 ? value as number : fallback;
}

function safePositiveInteger(value: number | undefined, fallback: number) {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value as number : fallback;
}

function clampInteger(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function clampNumber(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}
