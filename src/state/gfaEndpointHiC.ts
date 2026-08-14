import type { ContactMapTile, ContactMapTileKey } from "../App";
import { forEachContactTileCell } from "./contactTileData";
import type { GfaSegmentSide } from "./gfa";
import type { ContactMapLayoutBlock } from "./importers";
import type { ContactNormalization } from "./uiState";

export type GfaDisplayedEndpoint = "left" | "right";

export interface GfaEndpointWindow {
  blockId: string;
  endpoint: GfaDisplayedEndpoint;
  startBp: number;
  endBp: number;
}

export interface GfaEndpointHiCQueryPlan {
  status: "ready";
  sourceBlockId: string;
  targetBlockId: string;
  sourceResolution: number;
  targetResolution: number;
  tileSizeBins: number;
  tiles: ContactMapTileKey[];
  sourceWindows: Record<GfaDisplayedEndpoint, GfaEndpointWindow>;
  targetWindows: Record<GfaDisplayedEndpoint, GfaEndpointWindow>;
}

export interface GfaEndpointHiCUnresolvedPlan {
  status: "unresolved";
  reason: string;
  resolution?: number;
}

export type GfaEndpointHiCPlan = GfaEndpointHiCQueryPlan | GfaEndpointHiCUnresolvedPlan;

export interface GfaEndpointHiCQuadrant {
  sourceEndpoint: GfaDisplayedEndpoint;
  targetEndpoint: GfaDisplayedEndpoint;
  rawCount: number;
  normalizedCountPerMb2: number;
}

export interface GfaEndpointHiCEvidence {
  sourceBlockId: string;
  targetBlockId: string;
  resolution: number;
  normalization: ContactNormalization;
  sourceWindowBp: number;
  targetWindowBp: number;
  quadrants: GfaEndpointHiCQuadrant[];
  bestQuadrant: GfaEndpointHiCQuadrant | null;
  contrastToNext: number | null;
  observedCellCount: number;
  complete: boolean;
  missingTileCount: number;
}

export type GfaEndpointHiCLoadResult =
  | { status: "ready"; evidence: GfaEndpointHiCEvidence }
  | { status: "unresolved" | "unavailable" | "error"; reason: string; resolution?: number };

export type GfaEndpointHiCLoader = (
  sourceBlockId: string,
  targetBlockId: string,
) => Promise<GfaEndpointHiCLoadResult>;

export interface GfaEndpointHiCLoadRequest {
  sourceBlockId: string;
  targetBlockId: string;
}

export type GfaEndpointHiCBatchLoader = (
  requests: ReadonlyArray<GfaEndpointHiCLoadRequest>,
) => Promise<GfaEndpointHiCLoadResult[]>;

const minimumDesiredResolution = 5_000;
const maximumDesiredResolution = 25_000;
const maximumEndpointWindowBp = 500_000;
const endpointWindowFraction = 0.25;
const targetBinsAcrossShortestPlacement = 40;
const minimumBinsPerEndpointWindow = 2;

/**
 * Plan a small, on-demand tile request for four displayed endpoint pairs.
 * The plan refuses to split an endpoint when the stored matrix cannot provide
 * at least two bins per non-overlapping terminal window.
 */
export function planGfaEndpointHiCQuery(
  sourceBlock: ContactMapLayoutBlock,
  targetBlock: ContactMapLayoutBlock,
  availableResolutions: ReadonlyArray<number>,
  tileSizeBins = 256,
): GfaEndpointHiCPlan {
  const sourceLength = sourceBlock.visualEnd - sourceBlock.visualStart;
  const targetLength = targetBlock.visualEnd - targetBlock.visualStart;
  if (
    !Number.isFinite(sourceLength)
    || !Number.isFinite(targetLength)
    || sourceLength <= 0
    || targetLength <= 0
  ) {
    return { status: "unresolved", reason: "The selected placement has an invalid visual span." };
  }
  if (!Number.isSafeInteger(tileSizeBins) || tileSizeBins <= 0) {
    return { status: "unresolved", reason: "The contact tile size is invalid." };
  }

  const resolutions = [...new Set(
    availableResolutions
      .filter((resolution) => Number.isFinite(resolution) && resolution > 0)
      .map((resolution) => Math.round(resolution)),
  )].sort((left, right) => left - right);
  if (resolutions.length === 0) {
    return { status: "unresolved", reason: "No contact-map resolution is available for endpoint evidence." };
  }

  const shortestLength = Math.min(sourceLength, targetLength);
  const desiredResolution = clamp(
    Math.floor(shortestLength / targetBinsAcrossShortestPlacement),
    minimumDesiredResolution,
    maximumDesiredResolution,
  );
  const sourceResolution = [...resolutions]
    .reverse()
    .find((resolution) => resolution <= desiredResolution)
    ?? resolutions[0];
  const targetResolution = Math.max(
    sourceResolution,
    Math.ceil(desiredResolution / sourceResolution) * sourceResolution,
  );
  const sourceWindowBp = endpointWindowLength(sourceLength);
  const targetWindowBp = endpointWindowLength(targetLength);
  const minimumWindowBp = targetResolution * minimumBinsPerEndpointWindow;
  if (sourceWindowBp < minimumWindowBp || targetWindowBp < minimumWindowBp) {
    const limitingId = sourceWindowBp <= targetWindowBp ? sourceBlock.id : targetBlock.id;
    const limitingWindow = Math.min(sourceWindowBp, targetWindowBp);
    return {
      status: "unresolved",
      resolution: targetResolution,
      reason: `${formatBp(targetResolution)} bins cannot separate both displayed ends of ${limitingId}; its terminal window is only ${formatBp(limitingWindow)}.`,
    };
  }

  const sourceWindows = endpointWindows(sourceBlock, sourceWindowBp);
  const targetWindows = endpointWindows(targetBlock, targetWindowBp);
  const tiles = endpointTileKeys(
    sourceWindows,
    targetWindows,
    targetResolution,
    tileSizeBins,
  );
  return {
    status: "ready",
    sourceBlockId: sourceBlock.id,
    targetBlockId: targetBlock.id,
    sourceResolution,
    targetResolution,
    tileSizeBins,
    tiles,
    sourceWindows,
    targetWindows,
  };
}

/** Aggregate requested tiles into displayed L-L, L-R, R-L and R-R scores. */
export function scoreGfaEndpointHiC(
  plan: GfaEndpointHiCQueryPlan,
  tiles: ReadonlyArray<ContactMapTile>,
  normalization: ContactNormalization = "raw",
): GfaEndpointHiCEvidence {
  const quadrantCounts = new Map<string, number>([
    [quadrantKey("left", "left"), 0],
    [quadrantKey("left", "right"), 0],
    [quadrantKey("right", "left"), 0],
    [quadrantKey("right", "right"), 0],
  ]);
  let observedCellCount = 0;
  for (const tile of tiles) {
    forEachContactTileCell(tile, plan.tileSizeBins, (xBin, yBin, count) => {
      if (!Number.isFinite(count) || count <= 0) {
        return;
      }
      const xStart = xBin * plan.targetResolution;
      const xEnd = xStart + plan.targetResolution;
      const yStart = yBin * plan.targetResolution;
      const yEnd = yStart + plan.targetResolution;
      let used = false;
      for (const sourceEndpoint of ["left", "right"] as const) {
        const sourceWindow = plan.sourceWindows[sourceEndpoint];
        for (const targetEndpoint of ["left", "right"] as const) {
          const targetWindow = plan.targetWindows[targetEndpoint];
          const forwardWeight = intervalOverlapFraction(xStart, xEnd, sourceWindow)
            * intervalOverlapFraction(yStart, yEnd, targetWindow);
          const reverseWeight = intervalOverlapFraction(xStart, xEnd, targetWindow)
            * intervalOverlapFraction(yStart, yEnd, sourceWindow);
          const weight = forwardWeight + reverseWeight;
          if (weight <= 0) {
            continue;
          }
          const key = quadrantKey(sourceEndpoint, targetEndpoint);
          quadrantCounts.set(key, (quadrantCounts.get(key) ?? 0) + count * weight);
          used = true;
        }
      }
      if (used) {
        observedCellCount += 1;
      }
    });
  }

  const sourceWindowBp = plan.sourceWindows.left.endBp - plan.sourceWindows.left.startBp;
  const targetWindowBp = plan.targetWindows.left.endBp - plan.targetWindows.left.startBp;
  const normalizationAreaMb2 = (sourceWindowBp / 1_000_000) * (targetWindowBp / 1_000_000);
  const quadrants = ([
    ["left", "left"],
    ["left", "right"],
    ["right", "left"],
    ["right", "right"],
  ] as const).map(([sourceEndpoint, targetEndpoint]) => {
    const rawCount = quadrantCounts.get(quadrantKey(sourceEndpoint, targetEndpoint)) ?? 0;
    return {
      sourceEndpoint,
      targetEndpoint,
      rawCount,
      normalizedCountPerMb2: normalizationAreaMb2 > 0 ? rawCount / normalizationAreaMb2 : 0,
    };
  });
  const ranked = [...quadrants].sort((left, right) => (
    right.normalizedCountPerMb2 - left.normalizedCountPerMb2
    || quadrantKey(left.sourceEndpoint, left.targetEndpoint)
      .localeCompare(quadrantKey(right.sourceEndpoint, right.targetEndpoint))
  ));
  const bestQuadrant = (ranked[0]?.normalizedCountPerMb2 ?? 0) > 0 ? ranked[0] : null;
  const nextScore = ranked[1]?.normalizedCountPerMb2 ?? 0;
  const contrastToNext = bestQuadrant && nextScore > 0
    ? bestQuadrant.normalizedCountPerMb2 / nextScore
    : null;
  const returnedTileKeys = new Set(tiles.map((tile) => tileKey(tile)));
  const missingTileCount = plan.tiles.filter((tile) => !returnedTileKeys.has(tileKey(tile))).length;

  return {
    sourceBlockId: plan.sourceBlockId,
    targetBlockId: plan.targetBlockId,
    resolution: plan.targetResolution,
    normalization,
    sourceWindowBp,
    targetWindowBp,
    quadrants,
    bestQuadrant,
    contrastToNext,
    observedCellCount,
    complete: missingTileCount === 0,
    missingTileCount,
  };
}

export function physicalSideForDisplayedEndpoint(
  orientation: ContactMapLayoutBlock["orientation"],
  endpoint: GfaDisplayedEndpoint,
): GfaSegmentSide | null {
  if (orientation !== "+" && orientation !== "-") {
    return null;
  }
  if (endpoint === "left") {
    return orientation === "+" ? "start" : "end";
  }
  return orientation === "+" ? "end" : "start";
}

function endpointWindowLength(blockLength: number) {
  return Math.max(1, Math.min(
    maximumEndpointWindowBp,
    Math.floor(blockLength * endpointWindowFraction),
  ));
}

function endpointWindows(
  block: ContactMapLayoutBlock,
  windowBp: number,
): Record<GfaDisplayedEndpoint, GfaEndpointWindow> {
  return {
    left: {
      blockId: block.id,
      endpoint: "left",
      startBp: block.visualStart,
      endBp: block.visualStart + windowBp,
    },
    right: {
      blockId: block.id,
      endpoint: "right",
      startBp: block.visualEnd - windowBp,
      endBp: block.visualEnd,
    },
  };
}

function endpointTileKeys(
  sourceWindows: Record<GfaDisplayedEndpoint, GfaEndpointWindow>,
  targetWindows: Record<GfaDisplayedEndpoint, GfaEndpointWindow>,
  resolution: number,
  tileSizeBins: number,
) {
  const sourceTiles = new Set([
    ...tilesForWindow(sourceWindows.left, resolution, tileSizeBins),
    ...tilesForWindow(sourceWindows.right, resolution, tileSizeBins),
  ]);
  const targetTiles = new Set([
    ...tilesForWindow(targetWindows.left, resolution, tileSizeBins),
    ...tilesForWindow(targetWindows.right, resolution, tileSizeBins),
  ]);
  const keys = new Map<string, ContactMapTileKey>();
  for (const sourceTile of sourceTiles) {
    for (const targetTile of targetTiles) {
      const tileX = Math.min(sourceTile, targetTile);
      const tileY = Math.max(sourceTile, targetTile);
      const tile = { tileX, tileY };
      keys.set(tileKey(tile), tile);
    }
  }
  return [...keys.values()].sort((left, right) => (
    left.tileY - right.tileY || left.tileX - right.tileX
  ));
}

function tilesForWindow(window: GfaEndpointWindow, resolution: number, tileSizeBins: number) {
  const tileSpanBp = resolution * tileSizeBins;
  const first = Math.floor(window.startBp / tileSpanBp);
  const last = Math.floor((window.endBp - 1) / tileSpanBp);
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

function intervalOverlapFraction(
  binStart: number,
  binEnd: number,
  window: Pick<GfaEndpointWindow, "startBp" | "endBp">,
) {
  const overlap = Math.min(binEnd, window.endBp) - Math.max(binStart, window.startBp);
  return overlap > 0 ? overlap / Math.max(1, binEnd - binStart) : 0;
}

function quadrantKey(source: GfaDisplayedEndpoint, target: GfaDisplayedEndpoint) {
  return `${source}:${target}`;
}

function tileKey(tile: Pick<ContactMapTileKey, "tileX" | "tileY">) {
  const tileX = Math.min(tile.tileX, tile.tileY);
  const tileY = Math.max(tile.tileX, tile.tileY);
  return `${tileX}:${tileY}`;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function formatBp(value: number) {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })} Mb`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toLocaleString(undefined, { maximumFractionDigits: 2 })} kb`;
  }
  return `${value.toLocaleString()} bp`;
}
