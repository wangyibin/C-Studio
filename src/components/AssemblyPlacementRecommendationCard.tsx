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
  selectedPlacementBlock,
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
import type {
  HiCAlleleConcordanceBatchLoader,
  HiCAlleleConcordanceLoadResult,
  HiCAlleleConcordancePair,
} from "../state/hicAlleleConcordance";
import { buildHiCTransLineCandidates } from "../state/hicAlleleConcordance";
import type { ContactMapLayoutBlock } from "../state/importers";
import type { PafPreviewRecord } from "../state/pafPreview";
import {
  buildReferenceSyntenyAllelePruning,
  type SyntenyAlleleSignalMask,
} from "../state/syntenyAllelePruning";
import type { UiAction } from "../state/uiState";
import type { ContactNormalization } from "../state/uiState";

interface AssemblyPlacementRecommendationCardProps {
  blocks: ContactMapLayoutBlock[];
  selection: AssemblySelection | null;
  overviewContactMap: ContactMapView | null;
  expectedNormalization: ContactNormalization;
  pafRecords?: ReadonlyArray<PafPreviewRecord>;
  gfaDocument?: GfaEvidenceDocument | null;
  onLoadEndpointHiCBatch?: GfaEndpointHiCBatchLoader;
  onLoadHiCAlleleConcordanceBatch?: HiCAlleleConcordanceBatchLoader;
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

interface AlleleConcordanceLoadState {
  key: string;
  status: "idle" | "loading" | "ready" | "error";
  results: HiCAlleleConcordanceLoadResult[];
  reason?: string;
}

const recommendationOverviewPartnerLimit = 12;
const recommendationSyntenyMatchingPartnerLimit = 24;
const recommendationResultLimit = 3;
const recommendationAlleleCandidateLimit = 24;
const emptyPafRecords: ReadonlyArray<PafPreviewRecord> = [];

export function AssemblyPlacementRecommendationCard({
  blocks,
  selection,
  overviewContactMap,
  expectedNormalization,
  pafRecords = emptyPafRecords,
  gfaDocument = null,
  onLoadEndpointHiCBatch,
  onLoadHiCAlleleConcordanceBatch,
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
  const hasPafEvidence = pafRecords.length > 0;
  const syntenyPruning = useMemo(() => buildReferenceSyntenyAllelePruning(
    pafRecords,
    blocks,
    coarseLinks,
  ), [blocks, coarseLinks, pafRecords]);
  const hicTransLineCandidates = useMemo(() => {
    if (hasPafEvidence || !overviewContactMap || !overviewReady) {
      return null;
    }
    const selected = selectedPlacementBlock(blocks, selection);
    if ("status" in selected) {
      return null;
    }
    return buildHiCTransLineCandidates(
      overviewContactMap,
      blocks,
      new Set(selected.blocks.map((block) => block.id)),
    );
  }, [blocks, hasPafEvidence, overviewContactMap, overviewReady, selection]);
  const hicAlleleRequests = useMemo(() => {
    if (hasPafEvidence) {
      return [];
    }
    if (hicTransLineCandidates && hicTransLineCandidates.requests.length > 0) {
      return hicTransLineCandidates.requests;
    }
    const selected = selectedPlacementBlock(blocks, selection);
    if ("status" in selected) {
      return [];
    }
    const selectedIds = new Set(selected.blocks.map((block) => block.id));
    const blocksById = new Map(blocks.map((block) => [block.id, block]));
    const requestsByKey = new Map<string, { sourceBlockId: string; targetBlockId: string }>();
    for (const link of coarseLinks) {
      const sourceSelected = selectedIds.has(link.source);
      const targetSelected = selectedIds.has(link.target);
      if (sourceSelected === targetSelected) {
        continue;
      }
      const sourceBlock = blocksById.get(link.source);
      const targetBlock = blocksById.get(link.target);
      if (!sourceBlock || !targetBlock || sourceBlock.objectId === targetBlock.objectId) {
        continue;
      }
      const request = {
        sourceBlockId: sourceSelected ? link.source : link.target,
        targetBlockId: sourceSelected ? link.target : link.source,
      };
      requestsByKey.set(alleleConcordanceRequestKey(request), request);
      if (requestsByKey.size >= recommendationAlleleCandidateLimit) {
        break;
      }
    }
    return [...requestsByKey.values()];
  }, [blocks, coarseLinks, hasPafEvidence, hicTransLineCandidates, selection]);
  const hicAlleleRequestKey = useMemo(() => [
    hasPafEvidence ? "paf-primary" : "hic-fallback",
    overviewContactMap?.layoutScope ?? "no-layout",
    hicTransLineCandidates?.fingerprint ?? "coarse-fallback",
    ...hicAlleleRequests.map(alleleConcordanceRequestKey),
  ].join("\u0000"), [
    hasPafEvidence,
    hicAlleleRequests,
    hicTransLineCandidates?.fingerprint,
    overviewContactMap?.layoutScope,
  ]);
  const [alleleLoadState, setAlleleLoadState] = useState<AlleleConcordanceLoadState>({
    key: "",
    status: "idle",
    results: [],
  });
  useEffect(() => {
    if (hasPafEvidence || hicAlleleRequests.length === 0) {
      setAlleleLoadState({ key: hicAlleleRequestKey, status: "ready", results: [] });
      return undefined;
    }
    if (!onLoadHiCAlleleConcordanceBatch) {
      setAlleleLoadState({
        key: hicAlleleRequestKey,
        status: "error",
        results: [],
        reason: "Fine-resolution allelic contact querying is available in the desktop app.",
      });
      return undefined;
    }
    let active = true;
    const timeout = window.setTimeout(() => {
      setAlleleLoadState({ key: hicAlleleRequestKey, status: "loading", results: [] });
      void onLoadHiCAlleleConcordanceBatch(hicAlleleRequests).then((results) => {
        if (active) {
          setAlleleLoadState({ key: hicAlleleRequestKey, status: "ready", results });
        }
      }).catch((error) => {
        if (active) {
          setAlleleLoadState({
            key: hicAlleleRequestKey,
            status: "error",
            results: [],
            reason: `Allelic concordance query failed: ${String(error)}`,
          });
        }
      });
    }, 120);
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [
    hasPafEvidence,
    hicAlleleRequestKey,
    hicAlleleRequests,
    onLoadHiCAlleleConcordanceBatch,
  ]);
  const currentAlleleResults = useMemo(() => (
    alleleLoadState.key === hicAlleleRequestKey && alleleLoadState.status === "ready"
      ? alleleLoadState.results.filter((result) => result.status === "ready" && result.complete)
      : []
  ), [alleleLoadState, hicAlleleRequestKey]);
  const hicAllelePairs = useMemo(() => currentAlleleResults.flatMap((result) => (
    result.status === "ready" ? result.result.pairs : []
  )), [currentAlleleResults]);
  const highConfidenceHiCAllelePairs = useMemo(
    () => hicAllelePairs.filter((pair) => pair.confidence === "high"),
    [hicAllelePairs],
  );
  const hicConcordanceSummary = useMemo(() => currentAlleleResults.find(
    (result) => result.status === "ready",
  ), [currentAlleleResults]);
  const hicAlleleFingerprint = useMemo(() => [
    hicAlleleRequestKey,
    ...currentAlleleResults.flatMap((result) => (
      result.status === "ready" ? [result.result.fingerprint] : []
    )),
  ].join("|"), [currentAlleleResults, hicAlleleRequestKey]);
  const hicAlleleMaskByPair = useMemo(() => {
    const masks = new Map<string, SyntenyAlleleSignalMask>();
    for (const result of currentAlleleResults) {
      if (result.status !== "ready") {
        continue;
      }
      for (const [key, mask] of result.result.maskByPair) {
        masks.set(key, mask);
      }
    }
    return masks;
  }, [currentAlleleResults]);
  const alleleMaskByPair = useMemo(() => (
    hasPafEvidence
      ? syntenyPruning.maskByPair
      : hicAlleleMaskByPair
  ), [hasPafEvidence, hicAlleleMaskByPair, syntenyPruning.maskByPair]);
  const plan = useMemo(() => buildPlacementRecommendationPlan({
    blocks,
    selection,
    coarseLinks,
    gfaEdges,
    syntenyMaskByPair: alleleMaskByPair,
    syntenyAlleleGroups: syntenyPruning.groups,
    syntenyAnchors: syntenyPruning.anchors,
    syntenyAlleleEdges: syntenyPruning.alleleEdges,
    hicAllelePairs: highConfidenceHiCAllelePairs,
    overviewPartnerLimit: recommendationOverviewPartnerLimit,
  }), [
    blocks,
    coarseLinks,
    gfaEdges,
    alleleMaskByPair,
    highConfidenceHiCAllelePairs,
    selection,
    syntenyPruning.groups,
    syntenyPruning.alleleEdges,
    syntenyPruning.anchors,
  ]);
  const planKey = useMemo(() => plan.status === "ready"
    ? [
      ...plan.selectedBlocks.map((block) => block.id),
      overviewContactMap?.layoutScope ?? "no-layout",
      overviewContactMap?.normalization ?? "raw",
      expectedNormalization,
      syntenyPruning.fingerprint,
      hicAlleleFingerprint,
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
  [
    blocks,
    expectedNormalization,
    hicAlleleFingerprint,
    overviewContactMap?.layoutScope,
    overviewContactMap?.normalization,
    plan,
    syntenyPruning.fingerprint,
  ]);
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
    if (
      !hasPafEvidence
      && (
        alleleLoadState.key !== hicAlleleRequestKey
        || alleleLoadState.status !== "ready"
      )
    ) {
      setLoadState({ key: planKey, status: "idle", resultsByRequest: new Map() });
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
  }, [
    alleleLoadState.key,
    alleleLoadState.status,
    hasPafEvidence,
    hicAlleleRequestKey,
    onLoadEndpointHiCBatch,
    overviewReady,
    plan,
    planKey,
  ]);

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

  const selectedBlockIds = new Set(plan.selectedBlocks.map((block) => block.id));
  const selectedPafExclusions = hasPafEvidence
    ? syntenyPruning.exclusions.filter((exclusion) => (
      exclusion.occurrenceBlockIds.some((id) => selectedBlockIds.has(id))
    ))
    : [];
  const occupiedGroupCount = new Set(
    plan.occupancyConflicts.map((conflict) => conflict.targetObjectId),
  ).size;
  const selectedPafReviewSourceCount = new Set(
    selectedPafExclusions.map((exclusion) => exclusion.sourceId),
  ).size;
  const selectedHiCAllelePairs = hicAllelePairs.filter((pair) => (
    selectedBlockIds.has(pair.leftBlockId) || selectedBlockIds.has(pair.rightBlockId)
  ));
  const currentAlleleLoadStatus = alleleLoadState.key === hicAlleleRequestKey
    ? alleleLoadState.status
    : "idle";
  const hicConcordanceRatioCutoff = hicConcordanceSummary?.status === "ready"
    ? hicConcordanceSummary.result.concordanceRatioCutoff
    : 0.2;
  const hicMinimumSupport = hicConcordanceSummary?.status === "ready"
    ? hicConcordanceSummary.result.minimumSupport
    : 20;
  const hicMinimumLineZScore = hicConcordanceSummary?.status === "ready"
    ? hicConcordanceSummary.result.minimumLineZScore
    : 4;
  const firstAlleleUnavailableReason = alleleLoadState.key === hicAlleleRequestKey
    ? alleleLoadState.results.find((result) => result.status !== "ready")?.reason
    : undefined;
  const reviewMessages = [
    plan.copyAmbiguous ? "copy assignment is ambiguous" : null,
    occupiedGroupCount > 0
      ? `${occupiedGroupCount} occupied ${occupiedGroupCount === 1 ? "group was" : "groups were"} demoted`
      : null,
    selectedPafReviewSourceCount > 0
      ? `${selectedPafReviewSourceCount} selected ${selectedPafReviewSourceCount === 1 ? "source needs" : "sources need"} PAF review`
      : null,
    selectedHiCAllelePairs.length > 0
      ? `${selectedHiCAllelePairs.length} binned-concordance ${
        selectedHiCAllelePairs.length === 1 ? "allelic partner was" : "allelic partners were"
      } inferred from binned contacts`
      : null,
  ].filter((message): message is string => message !== null);

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
      {reviewMessages.length > 0 ? (
        <p className="placement-recommendation-warning">
          Review: {reviewMessages.join("; ")}.
        </p>
      ) : null}
      {!hasPafEvidence ? (
        <p className="placement-recommendation-allele-evidence">
          {currentAlleleLoadStatus === "idle" || currentAlleleLoadStatus === "loading"
            ? "Hi-C allelic evidence: tracing cross-object h-trans lines and evaluating fine-resolution concordance…"
            : currentAlleleLoadStatus === "error"
              ? `Hi-C allelic evidence unavailable: ${alleleLoadState.reason ?? "query failed"}`
              : selectedHiCAllelePairs.length > 0
            ? `Hi-C allelic evidence: ${selectedHiCAllelePairs.slice(0, 3).map((pair) => (
              hicAllelePairLabel(pair, blocks)
            )).join("; ")}${selectedHiCAllelePairs.length > 3 ? "; …" : ""}.`
            : hicAlleleRequests.length === 0
              ? "Hi-C allelic evidence: no distributed cross-object line or fallback partner was available for fine concordance testing."
              : `Hi-C allelic evidence: no selected pair passed concordance ratio > ${
                hicConcordanceRatioCutoff.toFixed(2)
              } or background-adjusted line Z ≥ ${hicMinimumLineZScore.toFixed(1)} with at least ${
                formatScore(hicMinimumSupport)
              } raw contact weight.${
                firstAlleleUnavailableReason ? ` ${firstAlleleUnavailableReason}` : ""
              }`}
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
  const placementTitle = `${recommendation.targetObjectId} · ${boundary}`;
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
          <strong title={placementTitle}>{placementTitle}</strong>
          <small>{placementOrientationLabel(recommendation)}</small>
        </span>
        <em className={`confidence-${recommendation.confidence}`}>
          {confidenceLabel(recommendation.confidence)}
        </em>
      </div>
      <div className="placement-recommendation-evidence">
        <span>{placementRecommendationOccupancyLabel(recommendation, blocksById)}</span>
        <span>{recommendation.supportedJunctionCount}/{recommendation.availableJunctionCount} available contact sides</span>
        <span>{recommendation.bestEndpointMatchCount} endpoint maxima</span>
        {recommendation.pafAdjacencyMatchCount > 0 ? (
          <span>{recommendation.pafAdjacencyMatchCount}/{recommendation.availableJunctionCount} PAF-supported sides</span>
        ) : null}
        {recommendation.gfaMatchCount > 0 ? (
          <span>{recommendation.gfaMatchCount} GFA port {recommendation.gfaMatchCount === 1 ? "match" : "matches"}</span>
        ) : null}
        {recommendation.syntenyPrunedJunctionCount > 0 ? (
          <span>{recommendation.syntenyPrunedJunctionCount} allele-pruned {
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

function alleleConcordanceRequestKey(request: {
  sourceBlockId: string;
  targetBlockId: string;
}) {
  return request.sourceBlockId.localeCompare(request.targetBlockId) <= 0
    ? `${request.sourceBlockId}\u0000${request.targetBlockId}`
    : `${request.targetBlockId}\u0000${request.sourceBlockId}`;
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

function hicAllelePairLabel(
  pair: HiCAlleleConcordancePair,
  blocks: ReadonlyArray<ContactMapLayoutBlock>,
) {
  const blocksById = new Map(blocks.map((block) => [block.id, block]));
  const left = blocksById.get(pair.leftBlockId);
  const right = blocksById.get(pair.rightBlockId);
  const leftLabel = left ? assemblyContigDisplayName(left) : pair.leftBlockId;
  const rightLabel = right ? assemblyContigDisplayName(right) : pair.rightBlockId;
  const supportLabel = pair.supportUnit === "raw-contact-weight"
    ? "raw contact weight"
    : "normalized contact weight";
  const lineLabel = pair.evidenceModel === "trans-line"
    ? `, line Z ${pair.lineZScore.toFixed(1)}`
    : "";
  const confidenceLabel = pair.confidence === "high" ? "high" : "supported";
  return `${leftLabel} ↔ ${rightLabel} (${confidenceLabel}, CR `
    + `${pair.concordanceRatio.toFixed(2)}${lineLabel}, `
    + `${formatScore(pair.support)} ${supportLabel}, ${pair.orientation})`;
}

function placementRecommendationOccupancyLabel(
  recommendation: PlacementRecommendation,
  blocksById: ReadonlyMap<string, ContactMapLayoutBlock>,
) {
  if (recommendation.occupancyConflicts.length === 0) {
    return "No detected source/locus conflict";
  }
  const kinds = new Set(recommendation.occupancyConflicts.map((conflict) => conflict.kind));
  const pafCoverage = Math.max(
    0,
    ...recommendation.occupancyConflicts
      .filter((conflict) => conflict.kind === "paf-allele-locus")
      .map((conflict) => conflict.selectedLocusCoverage ?? 0),
  );
  const hicConflicts = recommendation.occupancyConflicts.filter(
    (conflict) => conflict.kind === "hic-concordance",
  );
  const hicPartners = [...new Set(hicConflicts.flatMap((conflict) => (
    conflict.occupiedBlockIds.map((id) => {
      const block = blocksById.get(id);
      return block ? assemblyContigDisplayName(block) : id;
    })
  )))];
  const hicConcordanceRatio = Math.max(
    0,
    ...hicConflicts.map((conflict) => conflict.concordanceRatio ?? 0),
  );
  return [
    kinds.has("exact-source") ? "Exact-source conflict" : null,
    kinds.has("paf-allele-locus")
      ? `PAF locus occupied${pafCoverage > 0 ? ` (${Math.round(pafCoverage * 100)}% selected locus)` : ""}`
      : null,
    kinds.has("hic-concordance")
      ? `Hi-C allele occupied${hicPartners.length > 0 ? `: ${hicPartners.join(", ")}` : ""}${
        hicConcordanceRatio > 0 ? ` (CR ${hicConcordanceRatio.toFixed(2)})` : ""
      }`
      : null,
  ].filter((label): label is string => label !== null).join(" + ");
}
