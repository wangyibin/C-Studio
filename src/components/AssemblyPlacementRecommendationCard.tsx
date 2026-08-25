import { useEffect, useMemo, useRef, useState } from "react";
import type { ContactMapView } from "../App";
import {
  assemblyContigDisplayName,
  type AssemblySelection,
} from "../state/assemblyEditing";
import {
  buildPlacementRecommendationPlan,
  buildPlacementRecommendationPreviewLayout,
  placementEndpointRequestKey,
  rankPlacementRecommendations,
  type PlacementGroupOccupancyConflict,
  type PlacementRecommendation,
} from "../state/assemblyPlacementRecommendation";
import {
  buildGfaAssemblyGraph,
  type GfaEvidenceDocument,
} from "../state/gfa";
import type {
  GfaEndpointHiCBatchLoader,
  GfaEndpointHiCLoadResult,
} from "../state/gfaEndpointHiC";
import {
  buildLengthNormalizedGfaHiCLinks,
  gfaHiCContactMapUsesLayout,
  maximumGfaHiCLinks,
} from "../state/gfaHiCLinks";
import type { ContactMapLayoutBlock } from "../state/importers";
import { buildPafSyntenyPreview } from "../state/pafPreview";
import { buildReferenceSyntenyAllelePruning } from "../state/syntenyAllelePruning";
import type { UiAction } from "../state/uiState";
import type { ContactNormalization } from "../state/uiState";

interface AssemblyPlacementRecommendationCardProps {
  blocks: ContactMapLayoutBlock[];
  selection: AssemblySelection | null;
  overviewContactMap: ContactMapView | null;
  expectedNormalization: ContactNormalization;
  pafText?: string;
  gfaDocument?: GfaEvidenceDocument | null;
  onLoadEndpointHiCBatch?: GfaEndpointHiCBatchLoader;
  activePreviewId?: string | null;
  onPreviewChange?: (candidate: PlacementRecommendation | null) => void;
  onUiAction: (action: UiAction) => void;
}

interface RecommendationLoadState {
  key: string;
  status: "idle" | "loading" | "ready" | "error";
  resultsByRequest: Map<string, GfaEndpointHiCLoadResult>;
  reason?: string;
}

const recommendationOverviewPartnerLimit = 12;
const recommendationSyntenyMatchingPartnerLimit = 24;
const recommendationResultLimit = 3;

export function AssemblyPlacementRecommendationCard({
  blocks,
  selection,
  overviewContactMap,
  expectedNormalization,
  pafText = "",
  gfaDocument = null,
  onLoadEndpointHiCBatch,
  activePreviewId = null,
  onPreviewChange = () => undefined,
  onUiAction,
}: AssemblyPlacementRecommendationCardProps) {
  const overviewReady = Boolean(
    overviewContactMap
    && gfaHiCContactMapUsesLayout(overviewContactMap, blocks)
    && (overviewContactMap.normalization ?? "raw") === expectedNormalization,
  );
  const coarseLinks = useMemo(() => overviewContactMap && overviewReady
    ? buildLengthNormalizedGfaHiCLinks(
      overviewContactMap,
      blocks,
      blocks.map((block) => ({ id: block.id, occurrenceId: block.id })),
      maximumGfaHiCLinks,
      recommendationSyntenyMatchingPartnerLimit,
    )
    : [], [blocks, overviewContactMap, overviewReady]);
  const gfaEdges = useMemo(() => gfaDocument
    ? buildGfaAssemblyGraph(gfaDocument, blocks, Number.POSITIVE_INFINITY).edges
    : [], [blocks, gfaDocument]);
  const syntenyPruning = useMemo(() => buildReferenceSyntenyAllelePruning(
    buildPafSyntenyPreview(pafText).records,
    blocks,
    coarseLinks,
  ), [blocks, coarseLinks, pafText]);
  const plan = useMemo(() => buildPlacementRecommendationPlan({
    blocks,
    selection,
    coarseLinks,
    gfaEdges,
    syntenyMaskByPair: syntenyPruning.maskByPair,
    syntenyAlleleGroups: syntenyPruning.groups,
    syntenyAnchors: syntenyPruning.anchors,
    syntenyAlleleEdges: syntenyPruning.alleleEdges,
    overviewPartnerLimit: recommendationOverviewPartnerLimit,
  }), [
    blocks,
    coarseLinks,
    gfaEdges,
    selection,
    syntenyPruning.groups,
    syntenyPruning.alleleEdges,
    syntenyPruning.anchors,
    syntenyPruning.maskByPair,
  ]);
  const planKey = useMemo(() => plan.status === "ready"
    ? [
      ...plan.selectedBlocks.map((block) => block.id),
      overviewContactMap?.layoutScope ?? "no-layout",
      overviewContactMap?.normalization ?? "raw",
      expectedNormalization,
      syntenyPruning.fingerprint,
      ...blocks.map((block) => [
        block.id,
        block.objectId,
        block.sourceId,
        block.sourceStart,
        block.sourceEnd,
        block.visualStart,
        block.visualEnd,
        block.orientation,
      ].join(":")),
      ...plan.requests.map(placementEndpointRequestKey),
    ].join("\u0000")
    : `unavailable:${plan.reason}`,
  [blocks, expectedNormalization, overviewContactMap?.layoutScope, overviewContactMap?.normalization, plan, syntenyPruning.fingerprint]);
  const [loadState, setLoadState] = useState<RecommendationLoadState>({
    key: "",
    status: "idle",
    resultsByRequest: new Map(),
  });
  const [previewedRecommendationIds, setPreviewedRecommendationIds] = useState<Set<string>>(
    () => new Set(),
  );

  useEffect(() => {
    onPreviewChange(null);
    setPreviewedRecommendationIds(new Set());
  }, [onPreviewChange, planKey]);

  useEffect(() => {
    if (plan.status !== "ready") {
      setLoadState({ key: planKey, status: "idle", resultsByRequest: new Map() });
      return undefined;
    }
    if (plan.requests.length === 0) {
      setLoadState({ key: planKey, status: "ready", resultsByRequest: new Map() });
      return undefined;
    }
    if (!overviewReady) {
      setLoadState({ key: planKey, status: "idle", resultsByRequest: new Map() });
      return undefined;
    }
    if (!onLoadEndpointHiCBatch) {
      setLoadState({
        key: planKey,
        status: "error",
        resultsByRequest: new Map(),
        reason: "Endpoint contact querying is available in the desktop app.",
      });
      return undefined;
    }

    let active = true;
    const timeout = window.setTimeout(() => {
      setLoadState({ key: planKey, status: "loading", resultsByRequest: new Map() });
      void onLoadEndpointHiCBatch(plan.requests).then((results) => {
        if (!active) {
          return;
        }
        const resultsByRequest = new Map<string, GfaEndpointHiCLoadResult>();
        plan.requests.forEach((request, index) => {
          const result = results[index];
          if (result) {
            resultsByRequest.set(placementEndpointRequestKey(request), result);
          }
        });
        setLoadState({ key: planKey, status: "ready", resultsByRequest });
      }).catch((error) => {
        if (!active) {
          return;
        }
        setLoadState({
          key: planKey,
          status: "error",
          resultsByRequest: new Map(),
          reason: `Placement evidence query failed: ${String(error)}`,
        });
      });
    }, 120);

    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [onLoadEndpointHiCBatch, overviewReady, plan, planKey]);

  if (!selection) {
    return null;
  }
  if (plan.status !== "ready") {
    return (
      <div className="placement-recommendation-card status-unavailable" role="region" aria-label="Placement recommendation">
        <div className="placement-recommendation-heading">
          <strong>Placement recommendation</strong>
          <small>MVP</small>
        </div>
        <p>{plan.reason}</p>
      </div>
    );
  }
  if (!overviewReady) {
    return (
      <div className="placement-recommendation-card status-loading" role="region" aria-label="Placement recommendation" aria-busy="true">
        <div className="placement-recommendation-heading">
          <span>
            <strong>Placement recommendation</strong>
            <small>{placementBlockLabel(plan.selectedBlocks)}</small>
          </span>
          <em>Top 3</em>
        </div>
        <p>Waiting for a whole-assembly contact overview matching the current AGP…</p>
      </div>
    );
  }

  const recommendations = loadState.key === planKey && loadState.status === "ready"
    ? rankPlacementRecommendations(
      plan,
      loadState.resultsByRequest,
      blocks,
      recommendationResultLimit,
      "paf-adjacency",
    )
    : [];
  const loading = loadState.key !== planKey || loadState.status === "idle"
    || loadState.status === "loading";

  return (
    <div
      className={`placement-recommendation-card status-${loadState.status}`}
      role="region"
      aria-label="Placement recommendation"
    >
      <div className="placement-recommendation-heading">
        <span>
          <strong>Placement recommendation</strong>
          <small>{placementBlockLabel(plan.selectedBlocks)}</small>
        </span>
        <em>Top 3</em>
      </div>
      {plan.copyAmbiguous ? (
        <p className="placement-recommendation-warning">
          At least one source interval has multiple current copies; contact evidence cannot uniquely assign every occurrence.
        </p>
      ) : null}
      {plan.occupancyConflicts.length > 0 ? (
        <p className="placement-recommendation-warning">
          Group occupancy ranking demoted {placementOccupancyConflictSummary(
            plan.occupancyConflicts,
          )}; compatible groups rank first.
        </p>
      ) : null}
      {syntenyPruning.groups.length > 0 || syntenyPruning.duplicateOccurrencePairCount > 0 ? (
        <p className="placement-recommendation-warning">
          {pafText.trim() ? "Synteny PAF allele-aware" : "Duplicate-aware"} ranking: {
            syntenyPruning.groups.length
          } allele {
            syntenyPruning.groups.length === 1 ? "group" : "groups"
          } · {syntenyPruning.directAllelePairCount} direct, {
            syntenyPruning.crossAllelePairCount
          } cross-allele and {syntenyPruning.duplicateOccurrencePairCount} duplicated-occurrence Hi-C {
            syntenyPruning.directAllelePairCount
              + syntenyPruning.crossAllelePairCount
              + syntenyPruning.duplicateOccurrencePairCount === 1 ? "pair" : "pairs"
          } masked.
        </p>
      ) : pafText.trim() ? (
        <p className="placement-recommendation-warning">
          No high-confidence co-syntenic allele group was found; contact scores are unchanged.
        </p>
      ) : null}
      {plan.syntenyAdjacencies.length > 0 ? (
        <p className="placement-recommendation-warning">
          PAF adjacency ranking added {plan.syntenyAdjacencies.length} nearest upstream/downstream {
            plan.syntenyAdjacencies.length === 1 ? "anchor" : "anchors"
          } to the candidate comparison; overlapping allele loci remain excluded.
        </p>
      ) : null}
      {pafText.trim() && syntenyPruning.alleleEdges.length > 0 ? (
        <p className="placement-recommendation-warning">
          Pairwise PAF shadow: {syntenyPruning.alleleEdges.length} direct source-locus {
            syntenyPruning.alleleEdges.length === 1 ? "edge" : "edges"
          } covering {syntenyPruning.pairwiseAlleleOccurrencePairCount} current-occurrence {
            syntenyPruning.pairwiseAlleleOccurrencePairCount === 1 ? "pair" : "pairs"
          }; {syntenyPruning.shadowOnlyAlleleOccurrencePairCount} additional {
            syntenyPruning.shadowOnlyAlleleOccurrencePairCount === 1 ? "pair is" : "pairs are"
          } detected but not yet hard-masked.
        </p>
      ) : null}
      {syntenyPruning.multiMappingBlockCount > 0 ? (
        <p className="placement-recommendation-warning">
          {syntenyPruning.multiMappingBlockCount} PAF-multimapping {
            syntenyPruning.multiMappingBlockCount === 1 ? "block was" : "blocks were"
          } treated as duplicated/repetitive and excluded from hard pruning.
        </p>
      ) : null}
      {loading ? (
        <p className="placement-recommendation-status" aria-busy="true">
          Comparing candidate boundaries and both orientations…
        </p>
      ) : loadState.status === "error" ? (
        <p className="placement-recommendation-status error">{loadState.reason}</p>
      ) : recommendations.length === 0 ? (
        <p className="placement-recommendation-status">
          No candidate has usable endpoint contact or oriented GFA support.
        </p>
      ) : (
        <ol className="placement-recommendation-list">
          {recommendations.map((recommendation) => (
            <PlacementRecommendationItem
              key={recommendation.id}
              recommendation={recommendation}
              blocks={blocks}
              active={activePreviewId === recommendation.id}
              previewed={previewedRecommendationIds.has(recommendation.id)}
              onPreviewStart={() => {
                onPreviewChange(recommendation);
              }}
              onPreviewEnd={() => {
                onPreviewChange(null);
                setPreviewedRecommendationIds((current) => {
                  if (current.has(recommendation.id)) {
                    return current;
                  }
                  const next = new Set(current);
                  next.add(recommendation.id);
                  return next;
                });
              }}
              onApply={() => {
                onPreviewChange(null);
                const preview = buildPlacementRecommendationPreviewLayout(
                  blocks,
                  selection,
                  recommendation,
                );
                onUiAction({
                  type: "applyAssemblyPlacementRecommendation",
                  selectedBlockIds: recommendation.selectedBlockIds,
                  targetBlockId: recommendation.targetBlockId,
                  targetObjectId: recommendation.targetObjectId,
                  orientation: recommendation.orientation,
                });
                const totalSpanMb = Math.max(
                  0.000001,
                  ...blocks.map((block) => block.visualEnd / 1_000_000),
                );
                onUiAction({
                  type: "jumpContactViewportToRegions",
                  xCenterBp: preview?.centerBp ?? recommendation.visualPosition,
                  yCenterBp: preview?.centerBp ?? recommendation.visualPosition,
                  selectedBlockIds: recommendation.selectedBlockIds,
                  totalSpanMb,
                  label: `applied placement candidate ${recommendation.rank}`,
                  transient: true,
                });
              }}
            />
          ))}
        </ol>
      )}
      <p className="placement-recommendation-caveat">
        Hold Preview to inspect the proposed layout; release to return. Only Apply edits the AGP and creates one undoable operation.
      </p>
    </div>
  );
}

function PlacementRecommendationItem({
  recommendation,
  blocks,
  active,
  previewed,
  onPreviewStart,
  onPreviewEnd,
  onApply,
}: {
  recommendation: PlacementRecommendation;
  blocks: ContactMapLayoutBlock[];
  active: boolean;
  previewed: boolean;
  onPreviewStart: () => void;
  onPreviewEnd: () => void;
  onApply: () => void;
}) {
  const previewPointerIdRef = useRef<number | null>(null);
  const keyboardPreviewActiveRef = useRef(false);
  const blocksById = new Map(blocks.map((block) => [block.id, block]));
  const boundary = placementBoundaryLabel(recommendation, blocksById);
  const stopPointerPreview = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (previewPointerIdRef.current !== event.pointerId) {
      return;
    }
    previewPointerIdRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    onPreviewEnd();
  };
  return (
    <li className={`${active ? "active" : ""}${recommendation.isCurrent ? " current" : ""}`}>
      <div className="placement-recommendation-title">
        <span className="placement-recommendation-rank">{recommendation.rank}</span>
        <span>
          <strong>{recommendation.targetObjectId} · {boundary}</strong>
          <small>{placementOrientationLabel(recommendation)}</small>
        </span>
        <em className={`confidence-${recommendation.confidence}`}>
          {confidenceLabel(recommendation.confidence)}
        </em>
      </div>
      <div className="placement-recommendation-evidence">
        <span>{placementRecommendationOccupancyLabel(recommendation)}</span>
        <span>{recommendation.supportedJunctionCount}/2 contact sides</span>
        <span>{recommendation.bestEndpointMatchCount} endpoint maxima</span>
        {recommendation.pafAdjacencyMatchCount > 0 ? (
          <span>{recommendation.pafAdjacencyMatchCount}/2 PAF-adjacent sides</span>
        ) : null}
        {recommendation.gfaMatchCount > 0 ? (
          <span>{recommendation.gfaMatchCount} GFA port {recommendation.gfaMatchCount === 1 ? "match" : "matches"}</span>
        ) : null}
        {recommendation.syntenyPrunedJunctionCount > 0 ? (
          <span>{recommendation.syntenyPrunedJunctionCount} synteny-pruned {
            recommendation.syntenyPrunedJunctionCount === 1 ? "side" : "sides"
          }</span>
        ) : null}
        {recommendation.contactScore > 0 ? (
          <span>{formatScore(recommendation.contactScore)} signal/Mb²</span>
        ) : null}
      </div>
      <div className="placement-recommendation-actions">
        <button
          type="button"
          className="placement-preview-hold"
          disabled={recommendation.isCurrent}
          aria-pressed={active}
          title={recommendation.isCurrent
            ? "This recommendation is already the current placement"
            : "Hold to show the proposed heatmap layout; release to return"}
          onPointerDown={(event) => {
            if (event.button !== 0 || previewPointerIdRef.current !== null) {
              return;
            }
            event.preventDefault();
            previewPointerIdRef.current = event.pointerId;
            event.currentTarget.setPointerCapture(event.pointerId);
            onPreviewStart();
          }}
          onPointerUp={stopPointerPreview}
          onPointerCancel={stopPointerPreview}
          onLostPointerCapture={(event) => {
            if (previewPointerIdRef.current === event.pointerId) {
              previewPointerIdRef.current = null;
              onPreviewEnd();
            }
          }}
          onKeyDown={(event) => {
            if (
              (event.key === " " || event.key === "Enter")
              && !event.repeat
              && !keyboardPreviewActiveRef.current
            ) {
              event.preventDefault();
              keyboardPreviewActiveRef.current = true;
              onPreviewStart();
            }
          }}
          onKeyUp={(event) => {
            if (
              (event.key === " " || event.key === "Enter")
              && keyboardPreviewActiveRef.current
            ) {
              event.preventDefault();
              keyboardPreviewActiveRef.current = false;
              onPreviewEnd();
            }
          }}
          onBlur={() => {
            if (keyboardPreviewActiveRef.current) {
              keyboardPreviewActiveRef.current = false;
              onPreviewEnd();
            }
          }}
        >
          {recommendation.isCurrent
            ? "Already current"
            : active ? "Release to return" : "Hold Preview"}
        </button>
        {recommendation.isCurrent ? (
          <strong>Current placement</strong>
        ) : previewed ? (
          <button type="button" className="primary" onClick={onApply}>
            Apply placement
          </button>
        ) : (
          <small>{active
            ? "Placement temporarily applied to heatmap…"
            : "Hold Preview before applying"}</small>
        )}
      </div>
    </li>
  );
}

function placementBoundaryLabel(
  recommendation: PlacementRecommendation,
  blocksById: ReadonlyMap<string, ContactMapLayoutBlock>,
) {
  const left = recommendation.leftBlockId
    ? blocksById.get(recommendation.leftBlockId)
    : null;
  const right = recommendation.rightBlockId
    ? blocksById.get(recommendation.rightBlockId)
    : null;
  if (left && right) {
    return `between ${assemblyContigDisplayName(left)} and ${assemblyContigDisplayName(right)}`;
  }
  if (right) {
    return `before ${assemblyContigDisplayName(right)}`;
  }
  if (left) {
    return `after ${assemblyContigDisplayName(left)}`;
  }
  return "only contig";
}

function placementBlockLabel(blocks: ReadonlyArray<ContactMapLayoutBlock>) {
  if (blocks.length === 1 && blocks[0]) {
    return assemblyContigDisplayName(blocks[0]);
  }
  return `${blocks.length}-contig block`;
}

function placementOrientationLabel(recommendation: PlacementRecommendation) {
  if (recommendation.selectedBlockIds.length === 1) {
    return `Orientation ${recommendation.orientation}`;
  }
  return recommendation.orientation === "+"
    ? "Block + · keep order"
    : "Block − · reverse order";
}

function confidenceLabel(confidence: PlacementRecommendation["confidence"]) {
  switch (confidence) {
    case "high": return "High";
    case "medium": return "Medium";
    case "ambiguous": return "Ambiguous";
    case "review": return "Review";
  }
}

function formatScore(value: number) {
  return value.toLocaleString(undefined, {
    maximumFractionDigits: value >= 100 ? 1 : 2,
  });
}

function placementOccupancyConflictSummary(
  conflicts: ReadonlyArray<PlacementGroupOccupancyConflict>,
) {
  const kindsByObject = new Map<string, Set<PlacementGroupOccupancyConflict["kind"]>>();
  for (const conflict of conflicts) {
    const kinds = kindsByObject.get(conflict.targetObjectId) ?? new Set();
    kinds.add(conflict.kind);
    kindsByObject.set(conflict.targetObjectId, kinds);
  }
  const labels = [...kindsByObject]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([objectId, kinds]) => {
      const reasons = [
        kinds.has("exact-source") ? "exact source" : null,
        kinds.has("paf-allele-locus") ? "PAF allele locus" : null,
      ].filter((reason): reason is string => reason !== null);
      return `${objectId} (${reasons.join(" + ")})`;
    });
  const visible = labels.slice(0, 6);
  const remainder = labels.length - visible.length;
  return `${labels.length} chromosome ${labels.length === 1 ? "group" : "groups"}: ${
    visible.join(", ")
  }${remainder > 0 ? ` and ${remainder} more` : ""}`;
}

function placementRecommendationOccupancyLabel(
  recommendation: PlacementRecommendation,
) {
  if (recommendation.occupancyConflicts.length === 0) {
    return "No detected source/locus conflict";
  }
  const kinds = new Set(recommendation.occupancyConflicts.map((conflict) => conflict.kind));
  return [
    kinds.has("exact-source") ? "Exact-source conflict" : null,
    kinds.has("paf-allele-locus") ? "PAF allele-locus conflict" : null,
  ].filter((label): label is string => label !== null).join(" + ");
}
