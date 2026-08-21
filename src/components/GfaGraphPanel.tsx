import { ChevronDown, Maximize2, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { ContactMapView } from "../App";
import {
  assemblyContigDisplayName,
  buildAssemblyEditModel,
  planUnplacedGfaPlacement,
  type UnplacedGfaPlacementInput,
} from "../state/assemblyEditing";
import { exportAgpText } from "../state/agpExport";
import type { ContactMapLayoutBlock } from "../state/importers";
import {
  defaultAssemblyScaffoldColor,
  homologScaffoldColor,
  unplacedAssemblyColor,
} from "../state/assemblyPalette";
import {
  buildGfaAssemblyGraph,
  limitGfaAssemblyGraph,
  type GfaAssemblyGraph,
  type GfaEvidenceDocument,
  type GfaGraphEdge,
  type GfaGraphNode,
  type GfaSegmentEvidence,
  type GfaSegmentSide,
} from "../state/gfa";
import {
  buildGfaBandageLayoutRequest,
  gfaBandageLayoutRequestKey,
  validatedGfaBandagePathMap,
  type GfaBandageLayoutLoader,
} from "../state/gfaBandageLayout";
import {
  classifyGfaScaffolds,
  gfaBandageControlPoint,
  gfaBandageNodeWidths,
  gfaCurationNodeWidths,
  gfaLinkScope,
  layoutGfaNodePathsBandage,
  layoutGfaNodesForCuration,
  layoutGfaNodesGuided,
  gfaSmoothLinkCurve,
  type GfaLayoutMode,
  type GfaHomologClassification,
} from "../state/gfaHomologLayout";
import {
  buildLengthNormalizedGfaHiCLinks,
  gfaHiCContactMapUsesLayout,
  maximumGfaHiCLinks,
} from "../state/gfaHiCLinks";
import {
  buildGfaCurationIssues,
  type GfaCurationIssue,
  type GfaCurationPlacementEvidence,
} from "../state/gfaCurationEvidence";
import {
  physicalSideForDisplayedEndpoint,
  type GfaDisplayedEndpoint,
  type GfaEndpointHiCBatchLoader,
  type GfaEndpointHiCLoadResult,
  type GfaEndpointHiCLoader,
} from "../state/gfaEndpointHiC";
import {
  buildRankedGfaEndpointHiCLinks,
  defaultGfaEndpointHiCLinkLimit,
  gfaEndpointHiCOverviewPartnerLimit,
  gfaEndpointHiCPairCacheKey,
  maximumGfaEndpointHiCLinkLimit,
  normalizeGfaEndpointHiCLinkLimit,
  selectGfaEndpointHiCCandidates,
  type GfaEndpointHiCCandidate,
  type GfaEndpointHiCLink,
  type GfaEndpointHiCResultEntry,
} from "../state/gfaEndpointHiCLinks";
import type { UiAction, UiState } from "../state/uiState";
import {
  AssemblyContextMenu,
  type AssemblyContextMenuPosition,
} from "./AssemblyContextMenu";

interface GfaPreviewCardProps {
  document: GfaEvidenceDocument;
  assemblyBlocks: ContactMapLayoutBlock[];
  homologPattern: string;
  onExpand: () => void;
  embedded?: boolean;
  visibleScaffoldIds?: ReadonlySet<string>;
  chromosomeFilterActive?: boolean;
}

interface GfaGraphPanelProps {
  document: GfaEvidenceDocument;
  assemblyBlocks: ContactMapLayoutBlock[];
  contactMap: ContactMapView | null;
  onLayoutBandage?: GfaBandageLayoutLoader;
  onLoadEndpointHiC?: GfaEndpointHiCLoader;
  onLoadEndpointHiCBatch?: GfaEndpointHiCBatchLoader;
  selectedAssemblyBlockIds: string[];
  homologPattern: string;
  visibleScaffoldIds: ReadonlySet<string>;
  visibleContigIds: ReadonlySet<string>;
  chromosomeFilterActive: boolean;
  onRestoreHeatmap?: () => void;
  onClose: () => void;
  onSelectOccurrences: (ids: string[]) => void;
  uiState: UiState;
  onUiAction: (action: UiAction) => void;
}

interface GfaContextMenuState extends AssemblyContextMenuPosition {
  kind: "assembly" | "unplaced";
  nodeId?: string;
}

export interface GfaAgpPlacementTarget {
  value: string;
  label: string;
  targetBlockId: string | null;
}

interface LayoutNode extends GfaGraphNode {
  x: number;
  y: number;
  anchorX: number;
  anchorY: number;
  width: number;
  height: number;
  scaffoldColor: string;
  homologColumn: string | null;
  guidedFocal: boolean;
  manuallyPlaced: boolean;
  layoutMode: GfaLayoutMode;
  pathPoints: GfaPathPoint[];
}

export interface GfaPathPoint {
  x: number;
  y: number;
}

type CurationAssistantView = "queue" | "evidence";

interface SelectedEndpointHiCPair {
  key: string;
  sourceBlockId: string;
  targetBlockId: string;
}

interface EndpointHiCRequestState {
  key: string;
  loading: boolean;
  result: GfaEndpointHiCLoadResult | null;
}

interface EndpointHiCCandidateRequest {
  candidate: GfaEndpointHiCCandidate;
  cacheKey: string;
  sourceBlockId: string;
  targetBlockId: string;
}

interface EndpointHiCOverlayRequestState {
  key: string;
  loading: boolean;
  requestedCount: number;
  completedCount: number;
  entries: GfaEndpointHiCResultEntry[];
}

type EndpointHiCDisplayState =
  | { status: "not-applicable" }
  | { status: "ineligible"; reason: string }
  | { status: "loading" }
  | { status: "result"; result: GfaEndpointHiCLoadResult };

interface ViewTransform {
  x: number;
  y: number;
  scale: number;
}

interface GraphInteraction {
  pointerId: number;
  kind: "node" | "bandage-node" | "pan" | "selection";
  nodeId?: string;
  draggedNodes?: Array<{
    id: string;
    x: number;
    y: number;
    width: number;
    pathPoints: GfaPathPoint[];
  }>;
  grabbedPointIndex?: number;
  startGraphX?: number;
  startGraphY?: number;
  startClientX: number;
  startClientY: number;
  startViewX: number;
  startViewY: number;
  moved: boolean;
}

interface GfaSelectionBox {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

const defaultView: ViewTransform = { x: 24, y: 24, scale: 0.72 };
const graphNodeLimit = 1_200;
export const defaultGfaReviewOpen = false;

export function gfaAgpPlacementObjectIds(blocks: ContactMapLayoutBlock[]) {
  return buildAssemblyEditModel(blocks).chromosomes.map((chromosome) => chromosome.id);
}

/** List only complete assembly-unit boundaries so placement never splits a locked block. */
export function gfaAgpPlacementTargets(
  blocks: ContactMapLayoutBlock[],
  objectId: string,
): GfaAgpPlacementTarget[] {
  const model = buildAssemblyEditModel(blocks);
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const units = model.assemblyBlocks.filter((block) => block.objectId === objectId);
  if (units.length === 0) {
    return [];
  }
  const unitLabel = (contigIds: string[]) => {
    const names = contigIds.flatMap((id) => {
      const block = byId.get(id);
      return block ? [assemblyContigDisplayName(block)] : [];
    });
    if (names.length <= 1) {
      return names[0] ?? "unitig";
    }
    return `${names[0]}…${names[names.length - 1]} (${names.length} utgs)`;
  };
  return [
    {
      value: `before:${units[0].contigIds[0]}`,
      label: "Start",
      targetBlockId: units[0].contigIds[0] ?? null,
    },
    ...units.slice(1).map((unit) => ({
      value: `before:${unit.contigIds[0]}`,
      label: `Before ${unitLabel(unit.contigIds)}`,
      targetBlockId: unit.contigIds[0] ?? null,
    })),
    { value: "end", label: "End", targetBlockId: null },
  ];
}

export function gfaLayoutLayerDefaults(layoutMode: GfaLayoutMode) {
  return {
    showGfaOnlyNodes: layoutMode === "bandage",
    showDisconnectedNodes: layoutMode === "bandage",
    showAgpLinks: layoutMode !== "bandage",
  };
}

export function gfaEndpointHiCRequestBatchSize(batchLoaderConnected: boolean) {
  return batchLoaderConnected ? 32 : 1;
}

/** Resolve visibility shared by GFA and endpoint-contact links. */
export function gfaRelationLinkVisible(
  source: Pick<GfaGraphNode, "groupId">,
  target: Pick<GfaGraphNode, "groupId">,
  homologs: GfaHomologClassification,
  anchoredScaffoldIds: ReadonlySet<string>,
  showHomologLinks: boolean,
  showNonHomologLinks: boolean,
  showAnchorUnanchorLinks: boolean,
) {
  const sourceAnchored = anchoredScaffoldIds.has(source.groupId);
  const targetAnchored = anchoredScaffoldIds.has(target.groupId);
  if (sourceAnchored !== targetAnchored) {
    return showAnchorUnanchorLinks;
  }
  if (!sourceAnchored) {
    return true;
  }
  const scope = gfaLinkScope(source.groupId, target.groupId, homologs);
  return scope === "within-scaffold"
    || (scope === "homolog" ? showHomologLinks : showNonHomologLinks);
}

/** Apply the shared relation visibility rules to endpoint 3D contacts. */
export function gfaEndpointHiCLinksForRelationVisibility<
  T extends Pick<GfaEndpointHiCLink, "source" | "target">,
>(
  links: ReadonlyArray<T>,
  nodesById: ReadonlyMap<string, Pick<GfaGraphNode, "groupId">>,
  homologs: GfaHomologClassification,
  showHomologLinks: boolean,
  showNonHomologLinks: boolean,
  showAnchorUnanchorLinks: boolean,
): T[] {
  const anchoredScaffoldIds = homologScaffoldIds(homologs);
  return links.filter((link) => {
    const source = nodesById.get(link.source);
    const target = nodesById.get(link.target);
    if (!source || !target) {
      return false;
    }
    return gfaRelationLinkVisible(
      source,
      target,
      homologs,
      anchoredScaffoldIds,
      showHomologLinks,
      showNonHomologLinks,
      showAnchorUnanchorLinks,
    );
  });
}

function waitForGfaInteractionIdle(isInteracting: () => boolean) {
  return new Promise<void>((resolve) => {
    const waitForFrame = () => {
      window.requestAnimationFrame(() => {
        if (isInteracting()) {
          window.setTimeout(waitForFrame, 50);
        } else {
          resolve();
        }
      });
    };
    if (isInteracting()) {
      window.setTimeout(waitForFrame, 50);
    } else {
      waitForFrame();
    }
  });
}

/**
 * Resolve the rigid editing unit for a pointer drag. Assembly block ids are
 * scoped to a scaffold so copied/reused ids cannot couple separate chromosomes.
 */
export function gfaRigidBlockNodeIds(
  nodes: ReadonlyArray<Pick<GfaGraphNode, "id" | "groupId" | "assemblyBlockId">>,
  nodeId: string,
) {
  const selected = nodes.find((node) => node.id === nodeId);
  if (!selected?.assemblyBlockId) {
    return selected ? [selected.id] : [];
  }
  return nodes
    .filter((node) => (
      node.groupId === selected.groupId
      && node.assemblyBlockId === selected.assemblyBlockId
    ))
    .map((node) => node.id);
}

/**
 * AGP block membership is the manual-move lock boundary in Bandage mode.
 * Unblocked GFA-only unitigs retain adaptive control-point deformation.
 */
export function gfaBandageDragPlan(
  nodes: ReadonlyArray<Pick<GfaGraphNode, "id" | "groupId" | "assemblyBlockId">>,
  nodeId: string,
) {
  const selected = nodes.find((node) => node.id === nodeId);
  return {
    nodeIds: gfaRigidBlockNodeIds(nodes, nodeId),
    adaptive: Boolean(selected && !selected.assemblyBlockId),
  };
}

/** Build a straight fallback chain when no automatic Bandage path is available. */
export function gfaInitialBandagePathPoints(
  x: number,
  y: number,
  width: number,
): GfaPathPoint[] {
  const pointCount = Math.max(2, Math.ceil(Math.max(1, width) / 48) + 1);
  return Array.from({ length: pointCount }, (_, index) => ({
    x: x - width / 2 + width * index / (pointCount - 1),
    y,
  }));
}

/**
 * Move one Bandage unitig by its nearest control point. Adjacent control points
 * follow with Bandage's distance falloff, so the single Move interaction
 * naturally translates a short node or bends a longer one.
 */
export function gfaMoveBandagePath(
  pathPoints: ReadonlyArray<GfaPathPoint>,
  grabbedPointIndex: number,
  delta: GfaPathPoint,
  dragStrength = 3,
) {
  if (grabbedPointIndex < 0 || grabbedPointIndex >= pathPoints.length) {
    return pathPoints.map(copyPathPoint);
  }
  const safeDragStrength = Math.max(0.1, dragStrength);
  return pathPoints.map((point, index) => {
    const indexDistance = Math.abs(index - grabbedPointIndex);
    const weight = Math.pow(
      2,
      -Math.pow(indexDistance, 1.8) / safeDragStrength,
    );
    return {
      x: point.x + delta.x * weight,
      y: point.y + delta.y * weight,
    };
  });
}

/** Resolve a GFA segment side to the current endpoint of a bent Bandage node. */
export function gfaBandagePathPort(
  pathPoints: ReadonlyArray<GfaPathPoint>,
  orientation: GfaGraphNode["orientation"],
  side: GfaSegmentSide,
) {
  const visualSide = orientation === "-"
    ? side === "start" ? "end" : "start"
    : side;
  const point = visualSide === "start" ? pathPoints[0] : pathPoints[pathPoints.length - 1];
  return point ? copyPathPoint(point) : null;
}

/** Resolve both the live port and its outward path tangent after deformation. */
export function gfaBandagePathPortGeometry(
  pathPoints: ReadonlyArray<GfaPathPoint>,
  orientation: GfaGraphNode["orientation"],
  side: GfaSegmentSide,
) {
  const visualSide = orientation === "-"
    ? side === "start" ? "end" : "start"
    : side;
  const pointIndex = visualSide === "start" ? 0 : pathPoints.length - 1;
  const neighbourIndex = visualSide === "start" ? 1 : pathPoints.length - 2;
  const point = pathPoints[pointIndex];
  const neighbour = pathPoints[neighbourIndex];
  if (!point) {
    return null;
  }
  return {
    point: copyPathPoint(point),
    outward: neighbour
      ? { x: point.x - neighbour.x, y: point.y - neighbour.y }
      : { x: visualSide === "start" ? -1 : 1, y: 0 },
  };
}

/** GFA editing is block-based even when a node is an individually selectable source segment. */
export function gfaAssemblyUnitId(
  node: Pick<GfaGraphNode, "occurrenceId" | "assemblyBlockId">,
) {
  return node.assemblyBlockId || node.occurrenceId;
}

/** Match heatmap selection whether it arrives as an occurrence or rigid block id. */
export function gfaNodeMatchesAssemblySelection(
  node: Pick<GfaGraphNode, "id" | "occurrenceId" | "assemblyBlockId">,
  selectedIds: ReadonlySet<string>,
) {
  return selectedIds.has(node.id)
    || Boolean(node.occurrenceId && selectedIds.has(node.occurrenceId))
    || Boolean(node.assemblyBlockId && selectedIds.has(node.assemblyBlockId));
}

/** Right-clicking an unselected assembly node focuses it before opening the shared menu. */
export function gfaContextMenuSelectionIntent(
  node: Pick<GfaGraphNode, "id" | "occurrenceId" | "assemblyBlockId"> | null,
  selectedIds: ReadonlySet<string>,
) {
  if (!node || gfaNodeMatchesAssemblySelection(node, selectedIds)) {
    return null;
  }
  const unitId = gfaAssemblyUnitId(node);
  return unitId ? [unitId] : null;
}

/** Return assembly units whose node rectangles intersect a graph-space box. */
export function gfaAssemblyUnitIdsInSelection(
  nodes: ReadonlyArray<{
    occurrenceId: string | null;
    assemblyBlockId: string | null;
    x: number;
    y: number;
    width: number;
    height: number;
    pathPoints?: ReadonlyArray<GfaPathPoint>;
  }>,
  start: { x: number; y: number },
  end: { x: number; y: number },
) {
  const left = Math.min(start.x, end.x);
  const right = Math.max(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const bottom = Math.max(start.y, end.y);
  const ids = new Set<string>();
  for (const node of nodes) {
    const unitId = gfaAssemblyUnitId(node);
    if (!unitId) {
      continue;
    }
    const bounds = visualBoundsForNodeData(node);
    if (bounds.right >= left && bounds.left <= right && bounds.bottom >= top && bounds.top <= bottom) {
      ids.add(unitId);
    }
  }
  return [...ids];
}

interface GfaChromosomeRowNode {
  groupId: string;
  anchorY: number;
  occurrenceId: string | null;
  assemblyBlockId: string | null;
}

function gfaChromosomeRows(
  nodes: ReadonlyArray<GfaChromosomeRowNode>,
  chromosomeScaffolds: ReadonlySet<string>,
) {
  const rows = new Map<string, GfaChromosomeRowNode[]>();
  for (const node of nodes) {
    if (!chromosomeScaffolds.has(node.groupId)) {
      continue;
    }
    const values = rows.get(node.groupId) ?? [];
    values.push(node);
    rows.set(node.groupId, values);
  }
  return rows;
}

/** Resolve a Shift-click in the chromosome-label gutter to all assembly units on that row. */
export function gfaChromosomeLabelSelection(
  nodes: ReadonlyArray<GfaChromosomeRowNode>,
  chromosomeScaffolds: ReadonlySet<string>,
  point: { x: number; y: number },
  displayScale: number,
) {
  const safeScale = Math.max(0.01, displayScale);
  const fontSize = Math.max(11, 8 / safeScale);
  const verticalPadding = Math.max(5, 4 / safeScale);
  for (const [label, values] of gfaChromosomeRows(nodes, chromosomeScaffolds)) {
    const rowY = values.reduce((sum, node) => sum + node.anchorY, 0) / values.length;
    const estimatedTextWidth = Math.max(32, label.length * fontSize * 0.68);
    if (
      point.x >= 150 - estimatedTextWidth - 8 / safeScale
      && point.x <= 150 + 8 / safeScale
      && Math.abs(point.y - rowY) <= fontSize / 2 + verticalPadding
    ) {
      const ids = new Set<string>();
      for (const node of values) {
        const id = gfaAssemblyUnitId(node);
        if (id) {
          ids.add(id);
        }
      }
      return [...ids];
    }
  }
  return null;
}

/** Expand the Bandage contig window to complete AGP blocks at its boundaries. */
export function gfaBandageFocalNodeIds(
  nodes: ReadonlyArray<Pick<GfaGraphNode, "id" | "occurrenceId" | "groupId" | "assemblyBlockId">>,
  visibleContigIds: ReadonlySet<string>,
) {
  const focalNodes = nodes.filter((node) => (
    node.occurrenceId && visibleContigIds.has(node.occurrenceId)
  ));
  const focalIds = new Set(focalNodes.map((node) => node.id));
  const focalBlockKeys = new Set(focalNodes.flatMap((node) => (
    node.assemblyBlockId ? [`${node.groupId}\0${node.assemblyBlockId}`] : []
  )));
  for (const node of nodes) {
    if (
      node.assemblyBlockId
      && focalBlockKeys.has(`${node.groupId}\0${node.assemblyBlockId}`)
    ) {
      focalIds.add(node.id);
    }
  }
  return focalIds;
}

/**
 * AGP junctions describe directed adjacency in the edited chromosome layout.
 * The source is always attached to its displayed AGP end and the target to its
 * displayed AGP start. Manual placement must never make the junction swap ends.
 */
export function gfaAgpJunctionPoints(
  source: { x: number; y: number; width: number },
  target: { x: number; y: number; width: number },
) {
  return {
    source: {
      x: source.x + source.width / 2,
      y: source.y,
    },
    target: {
      x: target.x - target.width / 2,
      y: target.y,
    },
  };
}

/** Lock a bent Bandage AGP junction to the ordered path ends, never the nearest pair. */
export function gfaAgpBandageJunctionPoints(
  sourcePath: ReadonlyArray<GfaPathPoint>,
  targetPath: ReadonlyArray<GfaPathPoint>,
) {
  const source = sourcePath[sourcePath.length - 1];
  const target = targetPath[0];
  return source && target
    ? { source: copyPathPoint(source), target: copyPathPoint(target) }
    : null;
}

export function GfaPreviewCard({
  document,
  assemblyBlocks,
  homologPattern,
  onExpand,
  embedded = false,
  visibleScaffoldIds = new Set<string>(),
  chromosomeFilterActive = false,
}: GfaPreviewCardProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fullGraph = useMemo(
    () => buildGfaAssemblyGraph(document, assemblyBlocks, graphNodeLimit),
    [assemblyBlocks, document],
  );
  const homologs = useMemo(
    () => classifyGfaScaffolds(fullGraph.groupOrder, homologPattern),
    [fullGraph.groupOrder, homologPattern],
  );
  const graph = useMemo(
    () => graphForGfaOnlyNodeVisibility(
      graphForVisibleHomologScaffolds(
        fullGraph,
        visibleScaffoldIds,
        homologs,
        false,
        !chromosomeFilterActive,
      ),
      false,
    ),
    [chromosomeFilterActive, fullGraph, homologs, visibleScaffoldIds],
  );
  const chromosomeScaffolds = useMemo(
    () => homologScaffoldIds(homologs),
    [homologs],
  );
  const focusLabel = [...visibleScaffoldIds].sort().join(" · ");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const draw = () => drawGraphPreview(canvas, graph, homologs);
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [graph, homologs]);

  return (
    <section
      className={`gfa-preview-card${embedded ? " embedded" : ""}`}
      aria-label="GFA preview"
      title="Double-click to open the resizable GFA graph panel"
      onDoubleClick={onExpand}
    >
      <header className="gfa-preview-header">
        <span className="gfa-preview-title">
          <strong title={embedded ? document.fileName : "GFA Preview"}>
            {embedded ? document.fileName : "GFA Preview"}
          </strong>
          {embedded ? null : <small title={document.fileName}>{document.fileName}</small>}
          {embedded && focusLabel ? <small title={focusLabel}>{focusLabel}</small> : null}
        </span>
        <button
          className="gfa-preview-expand-button"
          type="button"
          aria-label="Open GFA graph panel"
          onClick={onExpand}
        >
          <Maximize2 size={11} aria-hidden="true" />
        </button>
      </header>
      <canvas ref={canvasRef} className="gfa-preview-canvas" />
      <dl className="gfa-preview-stats">
        <div><dt>Visible</dt><dd>{graph.nodes.length.toLocaleString()}</dd></div>
        <div><dt>Links</dt><dd>{graph.edges.filter((edge) => edge.kind === "gfa-link").length.toLocaleString()}</dd></div>
        <div><dt>Anchored</dt><dd>{graph.nodes.filter((node) => chromosomeScaffolds.has(node.groupId)).length.toLocaleString()}</dd></div>
        <div><dt>Unanchored</dt><dd>{graph.nodes.filter((node) => !chromosomeScaffolds.has(node.groupId)).length.toLocaleString()}</dd></div>
      </dl>
      {embedded ? null : <p>Double-click to inspect the topology-relaxed curation layout.</p>}
    </section>
  );
}

export function GfaGraphPanel({
  document,
  assemblyBlocks,
  contactMap,
  onLayoutBandage,
  onLoadEndpointHiC,
  onLoadEndpointHiCBatch,
  selectedAssemblyBlockIds,
  homologPattern,
  visibleScaffoldIds,
  visibleContigIds,
  chromosomeFilterActive,
  onRestoreHeatmap,
  onClose,
  onSelectOccurrences,
  uiState,
  onUiAction,
}: GfaGraphPanelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nodesRef = useRef<LayoutNode[]>([]);
  const graphRef = useRef<GfaAssemblyGraph | null>(null);
  const viewRef = useRef<ViewTransform>({ ...defaultView });
  const interactionRef = useRef<GraphInteraction | null>(null);
  const selectionBoxRef = useRef<GfaSelectionBox | null>(null);
  const fitViewPendingRef = useRef(true);
  const guidedGraphKeyRef = useRef("");
  const bandagePathStateRef = useRef(new Map<string, GfaPathPoint[]>());
  const [layoutRevision, setLayoutRevision] = useState(0);
  const [layoutMode, setLayoutMode] = useState<GfaLayoutMode>("curation");
  const [nativeBandageLayout, setNativeBandageLayout] = useState<{
    key: string;
    paths: Map<string, GfaPathPoint[]>;
  } | null>(null);
  const [bandageLayoutEngine, setBandageLayoutEngine] = useState<
    "loading" | "rust" | "fallback"
  >(onLayoutBandage ? "loading" : "fallback");
  const [showGfaOnlyNodesByLayout, setShowGfaOnlyNodesByLayout] = useState<Record<GfaLayoutMode, boolean>>({
    curation: gfaLayoutLayerDefaults("curation").showGfaOnlyNodes,
    guided: gfaLayoutLayerDefaults("guided").showGfaOnlyNodes,
    bandage: gfaLayoutLayerDefaults("bandage").showGfaOnlyNodes,
  });
  const [showAgpLinksByLayout, setShowAgpLinksByLayout] = useState<Record<GfaLayoutMode, boolean>>({
    curation: gfaLayoutLayerDefaults("curation").showAgpLinks,
    guided: gfaLayoutLayerDefaults("guided").showAgpLinks,
    bandage: gfaLayoutLayerDefaults("bandage").showAgpLinks,
  });
  const [showDisconnectedNodesByLayout, setShowDisconnectedNodesByLayout] = useState<
    Record<GfaLayoutMode, boolean>
  >({
    curation: gfaLayoutLayerDefaults("curation").showDisconnectedNodes,
    guided: gfaLayoutLayerDefaults("guided").showDisconnectedNodes,
    bandage: gfaLayoutLayerDefaults("bandage").showDisconnectedNodes,
  });
  const showGfaOnlyNodes = showGfaOnlyNodesByLayout[layoutMode];
  const showAgpLinks = showAgpLinksByLayout[layoutMode];
  const showDisconnectedNodes = showDisconnectedNodesByLayout[layoutMode];
  const [showGfaLinks, setShowGfaLinks] = useState(true);
  const [showHiCLinks, setShowHiCLinks] = useState(false);
  const [hiCLinkLimit, setHiCLinkLimit] = useState(defaultGfaEndpointHiCLinkLimit);
  const [showHomologLinks, setShowHomologLinks] = useState(true);
  const [showNonHomologLinks, setShowNonHomologLinks] = useState(true);
  const [showAnchorUnanchorLinks, setShowAnchorUnanchorLinks] = useState(true);
  const [toolbarDetailsOpen, setToolbarDetailsOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<GfaContextMenuState | null>(null);
  const [selectedUnplacedNodeId, setSelectedUnplacedNodeId] = useState<string | null>(null);
  const [placementNodeId, setPlacementNodeId] = useState<string | null>(null);
  const [curationAssistantOpen, setCurationAssistantOpen] = useState(defaultGfaReviewOpen);
  const [curationAssistantView, setCurationAssistantView] = useState<CurationAssistantView>("queue");
  const [selectedCurationIssueId, setSelectedCurationIssueId] = useState<string | null>(null);
  const endpointHiCCacheRef = useRef(new Map<string, GfaEndpointHiCLoadResult>());
  const endpointHiCInFlightRef = useRef(new Map<string, Promise<GfaEndpointHiCLoadResult>>());
  const endpointHiCCacheGenerationRef = useRef(0);
  const [endpointHiCRequest, setEndpointHiCRequest] = useState<EndpointHiCRequestState>({
    key: "",
    loading: false,
    result: null,
  });
  useEffect(() => {
    if (!contextMenu) {
      return;
    }
    const closeContextMenu = () => setContextMenu(null);
    const closeContextMenuOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeContextMenu();
      }
    };
    window.addEventListener("click", closeContextMenu);
    window.addEventListener("keydown", closeContextMenuOnEscape, true);
    return () => {
      window.removeEventListener("click", closeContextMenu);
      window.removeEventListener("keydown", closeContextMenuOnEscape, true);
    };
  }, [contextMenu]);
  const [endpointHiCOverlayRequest, setEndpointHiCOverlayRequest] = useState<EndpointHiCOverlayRequestState>({
    key: "",
    loading: false,
    requestedCount: 0,
    completedCount: 0,
    entries: [],
  });
  const loadEndpointHiCBatchCached = useCallback((requests: ReadonlyArray<{
    cacheKey: string;
    sourceBlockId: string;
    targetBlockId: string;
  }>): Promise<GfaEndpointHiCLoadResult[]> => {
    const promises = new Map<string, Promise<GfaEndpointHiCLoadResult>>();
    const missing = requests.filter((request) => {
      const cached = endpointHiCCacheRef.current.get(request.cacheKey);
      if (cached) {
        promises.set(request.cacheKey, Promise.resolve(cached));
        return false;
      }
      const inFlight = endpointHiCInFlightRef.current.get(request.cacheKey);
      if (inFlight) {
        promises.set(request.cacheKey, inFlight);
        return false;
      }
      return true;
    });
    if (missing.length > 0) {
      const generation = endpointHiCCacheGenerationRef.current;
      const batch = onLoadEndpointHiCBatch
        ? onLoadEndpointHiCBatch(missing.map(({ sourceBlockId, targetBlockId }) => ({
          sourceBlockId,
          targetBlockId,
        })))
        : onLoadEndpointHiC
          ? Promise.all(missing.map(({ sourceBlockId, targetBlockId }) => (
            onLoadEndpointHiC(sourceBlockId, targetBlockId)
          )))
          : Promise.resolve(missing.map((): GfaEndpointHiCLoadResult => ({
            status: "unavailable",
            reason: "Endpoint 3D contact querying is not connected in this view.",
          })));
      const safeBatch = batch.catch((error: unknown) => missing.map((): GfaEndpointHiCLoadResult => ({
        status: "error",
        reason: error instanceof Error ? error.message : String(error),
      })));
      missing.forEach((request, index) => {
        let flight!: Promise<GfaEndpointHiCLoadResult>;
        flight = safeBatch
          .then((results) => results[index] ?? ({
            status: "error",
            reason: "Endpoint 3D contact batch omitted a result.",
          }))
          .then((result) => {
            if (generation === endpointHiCCacheGenerationRef.current) {
              endpointHiCCacheRef.current.set(request.cacheKey, result);
            }
            return result;
          })
          .finally(() => {
            if (
              generation === endpointHiCCacheGenerationRef.current
              && endpointHiCInFlightRef.current.get(request.cacheKey) === flight
            ) {
              endpointHiCInFlightRef.current.delete(request.cacheKey);
            }
          });
        endpointHiCInFlightRef.current.set(request.cacheKey, flight);
        promises.set(request.cacheKey, flight);
      });
    }
    return Promise.all(requests.map((request) => promises.get(request.cacheKey)!));
  }, [onLoadEndpointHiC, onLoadEndpointHiCBatch]);
  const loadEndpointHiCCached = useCallback((
    cacheKey: string,
    sourceBlockId: string,
    targetBlockId: string,
  ): Promise<GfaEndpointHiCLoadResult> => loadEndpointHiCBatchCached([{
    cacheKey,
    sourceBlockId,
    targetBlockId,
  }]).then((results) => results[0]!), [loadEndpointHiCBatchCached]);
  const visibleScaffoldKey = [...visibleScaffoldIds].sort().join("\u0000");
  const visibleContigKey = [...visibleContigIds].sort().join("\u0000");
  const completeGraph = useMemo(
    () => buildGfaAssemblyGraph(document, assemblyBlocks, Number.POSITIVE_INFINITY),
    [assemblyBlocks, document],
  );
  const graph = useMemo(
    () => limitGfaAssemblyGraph(completeGraph, graphNodeLimit),
    [completeGraph],
  );
  const selectedIdsRef = useRef(new Set(selectedAssemblyBlockIds));
  selectedIdsRef.current = new Set([
    ...selectedAssemblyBlockIds,
    ...(selectedUnplacedNodeId ? [selectedUnplacedNodeId] : []),
  ]);
  const placementNode = placementNodeId
    ? completeGraph.nodes.find((node) => node.id === placementNodeId && node.kind === "unplaced") ?? null
    : null;
  const homologs = useMemo(
    () => classifyGfaScaffolds(completeGraph.groupOrder, homologPattern),
    [completeGraph.groupOrder, homologPattern],
  );
  const anchoredScaffoldIds = useMemo(
    () => homologScaffoldIds(homologs),
    [homologs],
  );
  const visibleGraphWithGfaOnlyNodes = useMemo(
    () => limitGfaAssemblyGraph(
      graphForVisibleHomologScaffolds(
        completeGraph,
        visibleScaffoldIds,
        homologs,
        showDisconnectedNodes,
        !chromosomeFilterActive,
      ),
      graphNodeLimit,
    ),
    [
      chromosomeFilterActive,
      completeGraph,
      homologs,
      showDisconnectedNodes,
      visibleScaffoldKey,
    ],
  );
  const guidedFocalNodeIds = useMemo(
    () => gfaBandageFocalNodeIds(completeGraph.nodes, visibleContigIds),
    [completeGraph, visibleContigKey],
  );
  const visibleGraph = useMemo(
    () => graphForGfaOnlyNodeVisibility(visibleGraphWithGfaOnlyNodes, showGfaOnlyNodes),
    [showGfaOnlyNodes, visibleGraphWithGfaOnlyNodes],
  );
  const visibleGuidedGraph = useMemo(
    () => graphForGuidedNodeVisibility(
      completeGraph,
      visibleContigIds,
      homologs,
      showGfaOnlyNodes,
      showDisconnectedNodes,
      graphNodeLimit,
      !chromosomeFilterActive,
    ),
    [
      chromosomeFilterActive,
      completeGraph,
      homologs,
      showDisconnectedNodes,
      showGfaOnlyNodes,
      visibleContigKey,
    ],
  );
  const visibleBandageGraph = useMemo(
    () => graphForGfaOnlyNodeVisibility(
      visibleGraphWithGfaOnlyNodes,
      showGfaOnlyNodes,
    ),
    [showGfaOnlyNodes, visibleGraphWithGfaOnlyNodes],
  );
  const activeGraph = layoutMode === "curation"
    ? visibleGraph
    : layoutMode === "guided" ? visibleGuidedGraph : visibleBandageGraph;
  const bandageLayoutRequest = useMemo(() => buildGfaBandageLayoutRequest(
    activeGraph.nodes,
    activeGraph.edges,
    gfaBandageNodeWidths(activeGraph.nodes),
  ), [activeGraph]);
  const bandageLayoutKey = useMemo(
    () => gfaBandageLayoutRequestKey(bandageLayoutRequest, layoutRevision),
    [bandageLayoutRequest, layoutRevision],
  );
  const guidedGraphKey = visibleGuidedGraph.nodes.map((node) => node.id).join("\u0000");
  const hiCContactMapReady = Boolean(
    contactMap && gfaHiCContactMapUsesLayout(contactMap, assemblyBlocks),
  );
  const hiCLinks = useMemo(
    () => contactMap && gfaHiCContactMapUsesLayout(contactMap, assemblyBlocks)
      ? buildLengthNormalizedGfaHiCLinks(
        contactMap,
        assemblyBlocks,
        activeGraph.nodes,
        maximumGfaHiCLinks,
        layoutMode === "guided"
          ? undefined
          : gfaEndpointHiCOverviewPartnerLimit(hiCLinkLimit),
      )
      : [],
    [activeGraph.nodes, assemblyBlocks, contactMap, hiCLinkLimit, layoutMode],
  );
  const activeNodesById = useMemo(
    () => new Map(activeGraph.nodes.map((node) => [node.id, node])),
    [activeGraph],
  );
  const visibleOverviewHiCLinks = useMemo(
    () => hiCLinks.filter((link) => (
      activeNodesById.has(link.source) && activeNodesById.has(link.target)
    )),
    [activeNodesById, hiCLinks],
  );
  const guidedCrossFocusHiCLinkIds = useMemo(() => {
    if (layoutMode !== "guided" || selectedAssemblyBlockIds.length === 0) {
      return new Set<string>();
    }
    const selectedIds = new Set(selectedAssemblyBlockIds);
    return new Set(visibleOverviewHiCLinks.flatMap((link) => (
      selectedIds.has(link.source) !== selectedIds.has(link.target) ? [link.id] : []
    )));
  }, [layoutMode, selectedAssemblyBlockIds, visibleOverviewHiCLinks]);
  const endpointHiCCandidates = useMemo(
    () => showHiCLinks && hiCContactMapReady && onLoadEndpointHiC
      ? selectGfaEndpointHiCCandidates(
        visibleOverviewHiCLinks,
        hiCLinkLimit,
        guidedCrossFocusHiCLinkIds,
      )
      : [],
    [
      guidedCrossFocusHiCLinkIds,
      hiCContactMapReady,
      hiCLinkLimit,
      onLoadEndpointHiC,
      showHiCLinks,
      visibleOverviewHiCLinks,
    ],
  );
  const assemblyBlocksById = useMemo(
    () => new Map(assemblyBlocks.map((block) => [block.id, block])),
    [assemblyBlocks],
  );
  const endpointHiCCandidateRequests = useMemo<EndpointHiCCandidateRequest[]>(
    () => endpointHiCCandidates.flatMap((candidate) => {
      const sourceBlock = assemblyBlocksById.get(candidate.link.source);
      const targetBlock = assemblyBlocksById.get(candidate.link.target);
      if (!sourceBlock || !targetBlock) {
        return [];
      }
      return [{
        candidate,
        sourceBlockId: sourceBlock.id,
        targetBlockId: targetBlock.id,
        cacheKey: gfaEndpointHiCPairCacheKey(
          sourceBlock,
          targetBlock,
          contactMap?.layoutScope,
          contactMap?.normalization,
        ),
      }];
    }),
    [
      assemblyBlocksById,
      contactMap?.layoutScope,
      contactMap?.normalization,
      endpointHiCCandidates,
    ],
  );
  const endpointHiCOverlayKey = useMemo(
    () => endpointHiCCandidateRequests.length > 0
      ? [
        hiCLinkLimit,
        ...endpointHiCCandidateRequests.map((request) => (
          `${request.cacheKey}\u0002${request.candidate.link.id}\u0002${request.candidate.overviewRank}`
        )),
      ].join("\u0001")
      : "",
    [endpointHiCCandidateRequests, hiCLinkLimit],
  );
  const visibleEndpointHiCLinks = useMemo(
    () => showHiCLinks && endpointHiCOverlayRequest.key === endpointHiCOverlayKey
      ? gfaEndpointHiCLinksForRelationVisibility(
        buildRankedGfaEndpointHiCLinks(
          endpointHiCOverlayRequest.entries,
          assemblyBlocks,
          hiCLinkLimit,
        ),
        activeNodesById,
        homologs,
        showHomologLinks,
        showNonHomologLinks,
        showAnchorUnanchorLinks,
      )
      : [],
    [
      activeNodesById,
      assemblyBlocks,
      endpointHiCOverlayKey,
      endpointHiCOverlayRequest.entries,
      endpointHiCOverlayRequest.key,
      hiCLinkLimit,
      homologs,
      showAnchorUnanchorLinks,
      showHomologLinks,
      showHiCLinks,
      showNonHomologLinks,
    ],
  );
  const curationIssues = useMemo(
    () => buildGfaCurationIssues({
      document,
      graph: activeGraph,
      assemblyBlocks,
      hiCLinks,
    }),
    [activeGraph, assemblyBlocks, document, hiCLinks],
  );
  const selectedCurationIssue = curationIssues.find(
    (issue) => issue.id === selectedCurationIssueId,
  ) ?? null;
  const selectedEndpointHiCPair = useMemo<SelectedEndpointHiCPair | null>(() => {
    const placed = selectedCurationIssue?.placements.filter(
      (placement) => placement.kind === "placed",
    ) ?? [];
    if (placed.length !== 2) {
      return null;
    }
    const sourceBlock = assemblyBlocks.find((block) => block.id === placed[0].nodeId);
    const targetBlock = assemblyBlocks.find((block) => block.id === placed[1].nodeId);
    if (!sourceBlock || !targetBlock) {
      return null;
    }
    return {
      sourceBlockId: sourceBlock.id,
      targetBlockId: targetBlock.id,
      key: gfaEndpointHiCPairCacheKey(
        sourceBlock,
        targetBlock,
        contactMap?.layoutScope,
        contactMap?.normalization,
      ),
    };
  }, [assemblyBlocks, contactMap?.layoutScope, contactMap?.normalization, selectedCurationIssue]);
  const endpointHiCDisplayState: EndpointHiCDisplayState = (() => {
    if (!selectedCurationIssue || selectedCurationIssue.placements.length === 0) {
      return { status: "not-applicable" };
    }
    if (!onLoadEndpointHiC) {
      return {
        status: "ineligible",
        reason: "Endpoint 3D contact querying is not connected in this view.",
      };
    }
    if (!selectedEndpointHiCPair) {
      const placedCount = selectedCurationIssue.placements.filter(
        (placement) => placement.kind === "placed",
      ).length;
      return {
        status: "ineligible",
        reason: placedCount === 2
          ? "The selected AGP occurrences are no longer available for endpoint comparison."
          : "Endpoint contacts require two specific unitig occurrences placed in the current AGP.",
      };
    }
    if (
      endpointHiCRequest.key === selectedEndpointHiCPair.key
      && endpointHiCRequest.result
    ) {
      return { status: "result", result: endpointHiCRequest.result };
    }
    return { status: "loading" };
  })();
  const visibleGraphRelationCount = activeGraph.edges.filter((edge) => {
    if (edge.kind !== "gfa-link") {
      return showAgpLinks;
    }
    if (!showGfaLinks) {
      return false;
    }
    const source = activeNodesById.get(edge.source);
    const target = activeNodesById.get(edge.target);
    if (!source || !target) {
      return false;
    }
    return gfaRelationLinkVisible(
      source,
      target,
      homologs,
      anchoredScaffoldIds,
      showHomologLinks,
      showNonHomologLinks,
      showAnchorUnanchorLinks,
    );
  }).length + visibleEndpointHiCLinks.length;

  useEffect(() => {
    bandagePathStateRef.current.clear();
    if (layoutMode === "bandage") {
      nodesRef.current = [];
      fitViewPendingRef.current = true;
    }
  }, [document]);

  useEffect(() => {
    const unplacedIds = new Set(
      completeGraph.nodes.filter((node) => node.kind === "unplaced").map((node) => node.id),
    );
    setSelectedUnplacedNodeId((current) => current && unplacedIds.has(current) ? current : null);
    setPlacementNodeId((current) => current && unplacedIds.has(current) ? current : null);
  }, [completeGraph]);

  useEffect(() => {
    setSelectedCurationIssueId((current) => (
      current && curationIssues.some((issue) => issue.id === current)
        ? current
        : curationIssues[0]?.id ?? null
    ));
    if (curationIssues.length === 0) {
      setCurationAssistantView("queue");
    }
  }, [curationIssues]);

  useEffect(() => {
    if (selectedAssemblyBlockIds.length === 0) {
      return;
    }
    const selectedIds = new Set(selectedAssemblyBlockIds);
    const matchingIssue = curationIssues.find((issue) => (
      issue.focusAssemblyUnitIds.some((id) => selectedIds.has(id))
    ));
    if (matchingIssue) {
      setSelectedCurationIssueId(matchingIssue.id);
    }
  }, [curationIssues, selectedAssemblyBlockIds]);

  useEffect(() => {
    endpointHiCCacheGenerationRef.current += 1;
    endpointHiCCacheRef.current.clear();
    endpointHiCInFlightRef.current.clear();
    setEndpointHiCRequest({ key: "", loading: false, result: null });
    setEndpointHiCOverlayRequest({
      key: "",
      loading: false,
      requestedCount: 0,
      completedCount: 0,
      entries: [],
    });
  }, [onLoadEndpointHiC]);

  useEffect(() => {
    if (
      !curationAssistantOpen
      || curationAssistantView !== "evidence"
      || !selectedEndpointHiCPair
      || !onLoadEndpointHiC
    ) {
      return undefined;
    }
    const cached = endpointHiCCacheRef.current.get(selectedEndpointHiCPair.key);
    if (cached) {
      setEndpointHiCRequest({
        key: selectedEndpointHiCPair.key,
        loading: false,
        result: cached,
      });
      return undefined;
    }

    let cancelled = false;
    setEndpointHiCRequest({
      key: selectedEndpointHiCPair.key,
      loading: true,
      result: null,
    });
    void loadEndpointHiCCached(
      selectedEndpointHiCPair.key,
      selectedEndpointHiCPair.sourceBlockId,
      selectedEndpointHiCPair.targetBlockId,
    ).then((result) => {
      if (cancelled) {
        return;
      }
      setEndpointHiCRequest({
        key: selectedEndpointHiCPair.key,
        loading: false,
        result,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [
    curationAssistantOpen,
    curationAssistantView,
    loadEndpointHiCCached,
    onLoadEndpointHiC,
    selectedEndpointHiCPair,
  ]);

  useEffect(() => {
    if (!endpointHiCOverlayKey || endpointHiCCandidateRequests.length === 0) {
      setEndpointHiCOverlayRequest((current) => current.key === ""
        ? current
        : {
          key: "",
          loading: false,
          requestedCount: 0,
          completedCount: 0,
          entries: [],
        });
      return undefined;
    }

    let cancelled = false;
    const cachedEntries = endpointHiCCandidateRequests.flatMap((request) => {
      const result = endpointHiCCacheRef.current.get(request.cacheKey);
      return result ? [{ candidate: request.candidate, result }] : [];
    });
    const missingRequests = endpointHiCCandidateRequests.filter(
      (request) => !endpointHiCCacheRef.current.has(request.cacheKey),
    );
    setEndpointHiCOverlayRequest({
      key: endpointHiCOverlayKey,
      loading: missingRequests.length > 0,
      requestedCount: endpointHiCCandidateRequests.length,
      completedCount: cachedEntries.length,
      entries: cachedEntries,
    });
    if (missingRequests.length === 0) {
      return undefined;
    }

    const entriesById = new Map(cachedEntries.map((entry) => [
      entry.candidate.link.id,
      entry,
    ]));
    let cursor = 0;
    let completedCount = cachedEntries.length;
    const publish = () => {
      if (cancelled) {
        return;
      }
      setEndpointHiCOverlayRequest({
        key: endpointHiCOverlayKey,
        loading: completedCount < endpointHiCCandidateRequests.length,
        requestedCount: endpointHiCCandidateRequests.length,
        completedCount,
        entries: [...entriesById.values()],
      });
    };
    const batchSize = gfaEndpointHiCRequestBatchSize(Boolean(onLoadEndpointHiCBatch));
    const runWorker = async () => {
      while (!cancelled) {
        const batch = missingRequests.slice(cursor, cursor + batchSize);
        cursor += batch.length;
        if (batch.length === 0) {
          return;
        }
        const results = await loadEndpointHiCBatchCached(batch);
        if (cancelled) {
          return;
        }
        results.forEach((result, index) => {
          const request = batch[index];
          if (request) {
            entriesById.set(request.candidate.link.id, { candidate: request.candidate, result });
            completedCount += 1;
          }
        });
        if (completedCount === endpointHiCCandidateRequests.length) {
          publish();
        }
        if (!cancelled && completedCount < endpointHiCCandidateRequests.length) {
          await waitForGfaInteractionIdle(() => interactionRef.current !== null);
        }
      }
    };
    const workerCount = 1;
    for (let index = 0; index < workerCount; index += 1) {
      void runWorker();
    }
    return () => {
      cancelled = true;
    };
  }, [
    endpointHiCCandidateRequests,
    endpointHiCOverlayKey,
    loadEndpointHiCBatchCached,
    onLoadEndpointHiCBatch,
  ]);

  useEffect(() => {
    if (layoutMode !== "bandage") {
      return;
    }
    if (!onLayoutBandage) {
      setBandageLayoutEngine("fallback");
      return;
    }
    if (nativeBandageLayout?.key === bandageLayoutKey) {
      return;
    }
    let cancelled = false;
    setBandageLayoutEngine("loading");
    void onLayoutBandage(bandageLayoutRequest)
      .then((response) => validatedGfaBandagePathMap(
        response,
        new Set(bandageLayoutRequest.nodes.map((node) => node.id)),
      ))
      .then((paths) => {
        if (cancelled) {
          return;
        }
        nodesRef.current = [];
        fitViewPendingRef.current = true;
        setNativeBandageLayout({ key: bandageLayoutKey, paths });
        setBandageLayoutEngine("rust");
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        console.warn("Rust GFA layout unavailable; using deterministic fallback", error);
        setBandageLayoutEngine("fallback");
      });
    return () => {
      cancelled = true;
    };
  }, [
    bandageLayoutKey,
    bandageLayoutRequest,
    layoutMode,
    nativeBandageLayout?.key,
    onLayoutBandage,
  ]);

  useEffect(() => {
    const guidedFocusChanged = layoutMode === "guided"
      && guidedGraphKeyRef.current !== guidedGraphKey;
    if (guidedFocusChanged) {
      nodesRef.current = [];
      fitViewPendingRef.current = true;
    }
    guidedGraphKeyRef.current = guidedGraphKey;
    const firstLayout = nodesRef.current.length === 0;
    graphRef.current = activeGraph;
    if (homologs.error && layoutMode === "curation") {
      return;
    }
    nodesRef.current = initializeLayoutNodes(
      activeGraph,
      homologs,
      nodesRef.current,
      layoutMode,
      completeGraph,
      guidedFocalNodeIds,
      bandagePathStateRef.current,
      nativeBandageLayout?.key === bandageLayoutKey
        ? nativeBandageLayout.paths
        : undefined,
    );
    if (firstLayout) {
      fitViewPendingRef.current = true;
    }
  }, [
    activeGraph,
    bandageLayoutKey,
    completeGraph,
    guidedFocalNodeIds,
    guidedGraphKey,
    homologs,
    layoutMode,
    layoutRevision,
    nativeBandageLayout,
  ]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) {
      drawCurrentGraph(canvas, graphRef.current, nodesRef.current, viewRef.current, selectedIdsRef.current, fitViewPendingRef, homologs, showGfaLinks, showHomologLinks, showNonHomologLinks, showAnchorUnanchorLinks, showAgpLinks, visibleEndpointHiCLinks, selectionBoxRef.current);
    }
  }, [activeGraph, homologs, selectedAssemblyBlockIds, selectedUnplacedNodeId, showGfaLinks, showHomologLinks, showNonHomologLinks, showAnchorUnanchorLinks, showAgpLinks, visibleEndpointHiCLinks]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const draw = () => drawCurrentGraph(canvas, graphRef.current, nodesRef.current, viewRef.current, selectedIdsRef.current, fitViewPendingRef, homologs, showGfaLinks, showHomologLinks, showNonHomologLinks, showAnchorUnanchorLinks, showAgpLinks, visibleEndpointHiCLinks, selectionBoxRef.current);
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => {
      observer.disconnect();
    };
  }, [graph, homologs, layoutMode, layoutRevision, showGfaLinks, showHomologLinks, showNonHomologLinks, showAnchorUnanchorLinks, showAgpLinks, visibleEndpointHiCLinks]);

  function switchLayoutMode(mode: GfaLayoutMode) {
    if (mode === layoutMode) {
      return;
    }
    if (layoutMode === "bandage") {
      rememberBandagePaths(bandagePathStateRef.current, nodesRef.current);
    }
    nodesRef.current = [];
    fitViewPendingRef.current = true;
    setLayoutMode(mode);
  }

  function resetLayout() {
    if (homologs.error && layoutMode === "curation") {
      return;
    }
    if (layoutMode === "bandage") {
      bandagePathStateRef.current.clear();
    }
    nodesRef.current = [];
    fitViewPendingRef.current = true;
    setLayoutRevision((revision) => revision + 1);
  }

  function autoLayoutBandage() {
    if (layoutMode !== "bandage") {
      return;
    }
    bandagePathStateRef.current.clear();
    nodesRef.current = [];
    fitViewPendingRef.current = true;
    setLayoutRevision((revision) => revision + 1);
  }

  function toggleGfaOnlyNodes() {
    nodesRef.current = [];
    fitViewPendingRef.current = true;
    setShowGfaOnlyNodesByLayout((current) => ({
      ...current,
      [layoutMode]: !current[layoutMode],
    }));
  }

  function toggleAgpLinks() {
    setShowAgpLinksByLayout((current) => ({
      ...current,
      [layoutMode]: !current[layoutMode],
    }));
  }

  function toggleDisconnectedNodes() {
    nodesRef.current = [];
    fitViewPendingRef.current = true;
    setShowDisconnectedNodesByLayout((current) => ({
      ...current,
      [layoutMode]: !current[layoutMode],
    }));
  }

  function inspectCurationIssue(issue: GfaCurationIssue) {
    setSelectedCurationIssueId(issue.id);
    setCurationAssistantView("evidence");
    if (issue.focusAssemblyUnitIds.length === 0) {
      return;
    }
    onSelectOccurrences(issue.focusAssemblyUnitIds);
    if (layoutMode !== "guided") {
      switchLayoutMode("guided");
    }
  }

  function showEvidenceForNode(nodeId: string) {
    const issue = curationIssues.find((candidate) => candidate.nodeIds.includes(nodeId));
    if (!issue) {
      return;
    }
    setSelectedCurationIssueId(issue.id);
    setCurationAssistantView("evidence");
  }

  function selectUnplacedNode(node: Pick<GfaGraphNode, "id">) {
    setSelectedUnplacedNodeId(node.id);
    selectedIdsRef.current = new Set([node.id]);
    onSelectOccurrences([]);
  }

  function openContextMenu(event: React.MouseEvent<HTMLCanvasElement>) {
    event.preventDefault();
    event.stopPropagation();
    const point = graphPointFromPointer(
      event.currentTarget,
      event.clientX,
      event.clientY,
      viewRef.current,
    );
    const node = nodeAtPoint(nodesRef.current, point.x, point.y);
    if (node?.kind === "unplaced") {
      selectUnplacedNode(node);
      showEvidenceForNode(node.id);
      setContextMenu({
        x: event.clientX,
        y: event.clientY,
        kind: "unplaced",
        nodeId: node.id,
      });
      return;
    }
    setSelectedUnplacedNodeId(null);
    const selectionIntent = gfaContextMenuSelectionIntent(node, selectedIdsRef.current);
    if (selectionIntent) {
      onSelectOccurrences(selectionIntent);
    }
    setContextMenu({ x: event.clientX, y: event.clientY, kind: "assembly" });
  }

  function pointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (event.button !== 0) {
      return;
    }
    setContextMenu(null);
    event.preventDefault();
    const canvas = event.currentTarget;
    const point = graphPointFromPointer(canvas, event.clientX, event.clientY, viewRef.current);
    const node = nodeAtPoint(nodesRef.current, point.x, point.y);
    const bandageDragPlan = node && layoutMode === "bandage"
      ? gfaBandageDragPlan(nodesRef.current, node.id)
      : null;
    const draggedNodeIds = node
      ? new Set(
        bandageDragPlan?.nodeIds
        ?? gfaRigidBlockNodeIds(nodesRef.current, node.id),
      )
      : new Set<string>();
    const adaptiveBandageMove = Boolean(
      node
      && !event.shiftKey
      && layoutMode === "bandage"
      && bandageDragPlan?.adaptive,
    );
    interactionRef.current = {
      pointerId: event.pointerId,
      kind: event.shiftKey
        ? "selection"
        : node
          ? adaptiveBandageMove ? "bandage-node" : "node"
          : "pan",
      nodeId: event.shiftKey ? undefined : node?.id,
      draggedNodes: node && !event.shiftKey
        ? nodesRef.current
          .filter((candidate) => draggedNodeIds.has(candidate.id))
          .map((candidate) => ({
            id: candidate.id,
            x: candidate.x,
            y: candidate.y,
            width: candidate.width,
            pathPoints: candidate.pathPoints.map(copyPathPoint),
          }))
        : undefined,
      grabbedPointIndex: adaptiveBandageMove && node
        ? closestBandageControlPointIndex(node.pathPoints, point)
        : undefined,
      startGraphX: node || event.shiftKey ? point.x : undefined,
      startGraphY: node || event.shiftKey ? point.y : undefined,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startViewX: viewRef.current.x,
      startViewY: viewRef.current.y,
      moved: false,
    };
    if (event.shiftKey) {
      selectionBoxRef.current = {
        startX: point.x,
        startY: point.y,
        currentX: point.x,
        currentY: point.y,
      };
      canvas.classList.add("gfa-selecting");
      drawCurrentGraph(canvas, graphRef.current, nodesRef.current, viewRef.current, selectedIdsRef.current, fitViewPendingRef, homologs, showGfaLinks, showHomologLinks, showNonHomologLinks, showAnchorUnanchorLinks, showAgpLinks, visibleEndpointHiCLinks, selectionBoxRef.current);
    }
    canvas.setPointerCapture(event.pointerId);
  }

  function pointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    const interaction = interactionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) {
      return;
    }
    const deltaX = event.clientX - interaction.startClientX;
    const deltaY = event.clientY - interaction.startClientY;
    interaction.moved ||= Math.hypot(deltaX, deltaY) > 3;
    if (interaction.kind === "selection") {
      const point = graphPointFromPointer(event.currentTarget, event.clientX, event.clientY, viewRef.current);
      if (selectionBoxRef.current) {
        selectionBoxRef.current.currentX = point.x;
        selectionBoxRef.current.currentY = point.y;
      }
      drawCurrentGraph(event.currentTarget, graphRef.current, nodesRef.current, viewRef.current, selectedIdsRef.current, fitViewPendingRef, homologs, showGfaLinks, showHomologLinks, showNonHomologLinks, showAnchorUnanchorLinks, showAgpLinks, visibleEndpointHiCLinks, selectionBoxRef.current);
      return;
    }
    if (interaction.kind === "pan") {
      viewRef.current.x = interaction.startViewX + deltaX;
      viewRef.current.y = interaction.startViewY + deltaY;
      drawCurrentGraph(event.currentTarget, graphRef.current, nodesRef.current, viewRef.current, selectedIdsRef.current, fitViewPendingRef, homologs, showGfaLinks, showHomologLinks, showNonHomologLinks, showAnchorUnanchorLinks, showAgpLinks, visibleEndpointHiCLinks);
      return;
    }
    if (
      interaction.draggedNodes
      && interaction.startGraphX !== undefined
      && interaction.startGraphY !== undefined
    ) {
      const point = graphPointFromPointer(event.currentTarget, event.clientX, event.clientY, viewRef.current);
      const graphDeltaX = point.x - interaction.startGraphX;
      const graphDeltaY = point.y - interaction.startGraphY;
      if (
        interaction.kind === "bandage-node"
        && interaction.nodeId
        && interaction.grabbedPointIndex !== undefined
      ) {
        const start = interaction.draggedNodes.find((candidate) => (
          candidate.id === interaction.nodeId
        ));
        if (!start) {
          return;
        }
        const movedPath = gfaMoveBandagePath(
          start.pathPoints,
          interaction.grabbedPointIndex,
          { x: graphDeltaX, y: graphDeltaY },
        );
        const movedNode = nodesRef.current.find((candidate) => candidate.id === interaction.nodeId);
        if (movedNode) {
          movedNode.pathPoints = movedPath;
          updateNodeCenterFromPath(movedNode);
        }
        drawCurrentGraph(event.currentTarget, graphRef.current, nodesRef.current, viewRef.current, selectedIdsRef.current, fitViewPendingRef, homologs, showGfaLinks, showHomologLinks, showNonHomologLinks, showAnchorUnanchorLinks, showAgpLinks, visibleEndpointHiCLinks);
        return;
      }
      const startsById = new Map(interaction.draggedNodes.map((node) => [node.id, node]));
      for (const node of nodesRef.current) {
        const start = startsById.get(node.id);
        if (start) {
          node.x = start.x + graphDeltaX;
          node.y = start.y + graphDeltaY;
          node.pathPoints = start.pathPoints.map((pathPoint) => ({
            x: pathPoint.x + graphDeltaX,
            y: pathPoint.y + graphDeltaY,
          }));
        }
      }
      drawCurrentGraph(event.currentTarget, graphRef.current, nodesRef.current, viewRef.current, selectedIdsRef.current, fitViewPendingRef, homologs, showGfaLinks, showHomologLinks, showNonHomologLinks, showAnchorUnanchorLinks, showAgpLinks, visibleEndpointHiCLinks);
    }
  }

  function pointerUp(event: React.PointerEvent<HTMLCanvasElement>) {
    const interaction = interactionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) {
      return;
    }
    if (interaction.kind === "selection") {
      const box = selectionBoxRef.current;
      const moved = Math.hypot(
        event.clientX - interaction.startClientX,
        event.clientY - interaction.startClientY,
      ) >= 8;
      if (box && moved) {
        const selection = gfaAssemblyUnitIdsInSelection(
          nodesRef.current,
          { x: box.startX, y: box.startY },
          { x: box.currentX, y: box.currentY },
        );
        setSelectedUnplacedNodeId(null);
        selectedIdsRef.current = new Set(selection);
        onSelectOccurrences(selection);
      } else {
        const point = graphPointFromPointer(event.currentTarget, event.clientX, event.clientY, viewRef.current);
        const chromosomeSelection = gfaChromosomeLabelSelection(
          nodesRef.current,
          homologScaffoldIds(homologs),
          point,
          viewRef.current.scale,
        );
        if (chromosomeSelection) {
          setSelectedUnplacedNodeId(null);
          selectedIdsRef.current = new Set(chromosomeSelection);
          onSelectOccurrences(chromosomeSelection);
          selectionBoxRef.current = null;
          event.currentTarget.classList.remove("gfa-selecting");
          drawCurrentGraph(event.currentTarget, graphRef.current, nodesRef.current, viewRef.current, selectedIdsRef.current, fitViewPendingRef, homologs, showGfaLinks, showHomologLinks, showNonHomologLinks, showAnchorUnanchorLinks, showAgpLinks, visibleEndpointHiCLinks);
          interactionRef.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
          return;
        }
        const node = nodeAtPoint(nodesRef.current, point.x, point.y);
        const unitId = node ? gfaAssemblyUnitId(node) : null;
        if (node?.kind === "unplaced") {
          selectUnplacedNode(node);
          showEvidenceForNode(node.id);
        } else if (unitId) {
          setSelectedUnplacedNodeId(null);
          selectedIdsRef.current = new Set([unitId]);
          onSelectOccurrences([unitId]);
          showEvidenceForNode(node!.id);
        } else {
          setSelectedUnplacedNodeId(null);
          selectedIdsRef.current = new Set();
          onSelectOccurrences([]);
        }
      }
      selectionBoxRef.current = null;
      event.currentTarget.classList.remove("gfa-selecting");
      drawCurrentGraph(event.currentTarget, graphRef.current, nodesRef.current, viewRef.current, selectedIdsRef.current, fitViewPendingRef, homologs, showGfaLinks, showHomologLinks, showNonHomologLinks, showAnchorUnanchorLinks, showAgpLinks, visibleEndpointHiCLinks);
    } else if ((interaction.kind === "node" || interaction.kind === "bandage-node") && interaction.nodeId) {
      const node = nodesRef.current.find((candidate) => candidate.id === interaction.nodeId);
      const unitId = node ? gfaAssemblyUnitId(node) : null;
      if (!interaction.moved) {
        if (node?.kind === "unplaced") {
          selectUnplacedNode(node);
          showEvidenceForNode(node.id);
        } else if (unitId) {
          setSelectedUnplacedNodeId(null);
          selectedIdsRef.current = new Set([unitId]);
          onSelectOccurrences([unitId]);
          showEvidenceForNode(node!.id);
        }
      }
      if (interaction.moved) {
        const draggedIds = new Set(interaction.draggedNodes?.map((dragged) => dragged.id));
        for (const candidate of nodesRef.current) {
          if (draggedIds.has(candidate.id)) {
            candidate.manuallyPlaced = true;
          }
        }
        if (layoutMode === "bandage") {
          rememberBandagePaths(bandagePathStateRef.current, nodesRef.current, draggedIds);
        }
      }
    }
    interactionRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function pointerCancel(event: React.PointerEvent<HTMLCanvasElement>) {
    const interaction = interactionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) {
      return;
    }
    if ((interaction.kind === "node" || interaction.kind === "bandage-node") && interaction.draggedNodes) {
      const startsById = new Map(interaction.draggedNodes.map((node) => [node.id, node]));
      for (const node of nodesRef.current) {
        const start = startsById.get(node.id);
        if (start) {
          node.x = start.x;
          node.y = start.y;
          node.pathPoints = start.pathPoints.map(copyPathPoint);
        }
      }
    }
    selectionBoxRef.current = null;
    interactionRef.current = null;
    event.currentTarget.classList.remove("gfa-selecting");
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    drawCurrentGraph(event.currentTarget, graphRef.current, nodesRef.current, viewRef.current, selectedIdsRef.current, fitViewPendingRef, homologs, showGfaLinks, showHomologLinks, showNonHomologLinks, showAnchorUnanchorLinks, showAgpLinks, visibleEndpointHiCLinks);
  }

  function zoom(event: React.WheelEvent<HTMLCanvasElement>) {
    event.preventDefault();
    const canvas = event.currentTarget;
    const bounds = canvas.getBoundingClientRect();
    const pointerX = event.clientX - bounds.left;
    const pointerY = event.clientY - bounds.top;
    const previousScale = viewRef.current.scale;
    const nextScale = clamp(previousScale * Math.exp(-event.deltaY * 0.001), 0.06, 3.5);
    const graphX = (pointerX - viewRef.current.x) / previousScale;
    const graphY = (pointerY - viewRef.current.y) / previousScale;
    viewRef.current.scale = nextScale;
    viewRef.current.x = pointerX - graphX * nextScale;
    viewRef.current.y = pointerY - graphY * nextScale;
    drawCurrentGraph(canvas, graphRef.current, nodesRef.current, viewRef.current, selectedIdsRef.current, fitViewPendingRef, homologs, showGfaLinks, showHomologLinks, showNonHomologLinks, showAnchorUnanchorLinks, showAgpLinks, visibleEndpointHiCLinks);
  }

  const contextUnplacedNode = contextMenu?.kind === "unplaced" && contextMenu.nodeId
    ? completeGraph.nodes.find((node) => node.id === contextMenu.nodeId && node.kind === "unplaced") ?? null
    : null;
  const placementSegment = placementNode
    ? document.segments[placementNode.segmentName] ?? null
    : null;

  return (
    <section className="gfa-graph-panel" aria-label="GFA assembly graph">
      <header className={`gfa-graph-toolbar${toolbarDetailsOpen ? " details-open" : ""}`}>
        <div className="gfa-toolbar-primary">
          <span className="gfa-toolbar-title">
            <strong>GFA Assembly Graph</strong>
            <small>
              {activeGraph.nodes.length.toLocaleString()} nodes · {visibleGraphRelationCount.toLocaleString()} visible relations
              {showHiCLinks && hiCContactMapReady
                ? ` · ${visibleEndpointHiCLinks.length.toLocaleString()} 3D contact links · Top ${hiCLinkLimit.toLocaleString()}/end${
                  endpointHiCOverlayRequest.key === endpointHiCOverlayKey && endpointHiCOverlayRequest.loading
                    ? ` (${endpointHiCOverlayRequest.completedCount}/${endpointHiCOverlayRequest.requestedCount})`
                    : ""
                }`
                : ""}
              {graph.ambiguousLinkCount ? ` · ${graph.ambiguousLinkCount.toLocaleString()} ambiguous links hidden` : ""}
              {graph.truncated ? ` · graph limited to ${graphNodeLimit.toLocaleString()} nodes` : ""}
            </small>
          </span>
          <div className="gfa-toolbar-layout">
            <span className="gfa-toolbar-section-label">Layout</span>
            <div className="gfa-layout-mode" role="group" aria-label="GFA graph layout mode">
              <button
                type="button"
                aria-pressed={layoutMode === "curation"}
                title="Arrange chromosome rows in AGP order and keep unitigs in each assembly block together"
                onClick={() => switchLayoutMode("curation")}
              >Curation</button>
              <button
                type="button"
                aria-pressed={layoutMode === "guided"}
                title="Keep the AGP backbone ordered and show one layer of GFA neighbors around the selected or heatmap-focus blocks"
                onClick={() => switchLayoutMode("guided")}
              >Guided</button>
              <button
                type="button"
                aria-pressed={layoutMode === "bandage"}
                title="Arrange segments from GFA topology only; AGP links are a separate optional layer"
                onClick={() => switchLayoutMode("bandage")}
              >Whole</button>
            </div>
            {layoutMode === "bandage" ? <>
              <span className="gfa-toolbar-divider" aria-hidden="true" />
              <button
                type="button"
                className="gfa-link-toggle gfa-auto-layout-button"
                aria-label="Run Whole automatic layout"
                title={bandageLayoutEngine === "loading"
                  ? "C-Studio's Rust multilevel graph layout is running"
                  : bandageLayoutEngine === "rust"
                    ? "Recompute with C-Studio's native Rust multilevel graph layout"
                    : "Native Rust layout is unavailable; recompute with the deterministic browser fallback"}
                onClick={autoLayoutBandage}
              >{bandageLayoutEngine === "loading" ? "Laying out…" : "Auto layout"}</button>
            </> : null}
            <span className="gfa-toolbar-divider" aria-hidden="true" />
            <span className="gfa-toolbar-section-label">Layers</span>
            <div className="gfa-layout-mode gfa-evidence-layers" role="group" aria-label="Graph evidence layers">
              <button
                type="button"
                aria-label="Toggle GFA links"
                aria-pressed={showGfaLinks}
                title="Show or hide all unitig links imported from the GFA"
                onClick={() => setShowGfaLinks((visible) => !visible)}
              >GFA</button>
            </div>
            <div
              className={`gfa-contact-layer-control${showHiCLinks ? " active" : ""}`}
              role="group"
              aria-label="3D contact layer controls"
            >
              <button
                type="button"
                className="gfa-contact-layer-toggle"
                aria-label="Toggle endpoint 3D contact links"
                aria-pressed={showHiCLinks}
                disabled={!hiCContactMapReady}
                title={hiCContactMapReady
                  ? "Show or hide endpoint-resolved 3D contact links from a Hi-C, Pore-C, or CiFi contact map; a link is drawn only when it ranks within Top X at both ends"
                  : contactMap
                    ? "The 3D contact overview is refreshing for the current assembly layout"
                    : "Load a compatible Hi-C, Pore-C, or CiFi contact map to enable this layer"}
                onClick={() => setShowHiCLinks((visible) => !visible)}
              >3D Contacts</button>
              <span className="gfa-contact-control-divider" aria-hidden="true" />
              <label
                className="gfa-contact-top-control"
                title="Apply the same strict length-normalized Top X filter independently to L and R of every currently drawn, contact-mappable unitig"
              >
                <span>Top/end</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={maximumGfaEndpointHiCLinkLimit}
                  step={1}
                  value={hiCLinkLimit}
                  disabled={!hiCContactMapReady}
                  aria-label="3D contact links per contig endpoint"
                  onChange={(event) => {
                    const value = Number(event.currentTarget.value);
                    if (Number.isFinite(value) && value > 0) {
                      setHiCLinkLimit(normalizeGfaEndpointHiCLinkLimit(value));
                    }
                  }}
                />
              </label>
            </div>
            <span className="gfa-toolbar-divider" aria-hidden="true" />
            <button
              type="button"
              className="gfa-link-toggle gfa-review-toggle"
              aria-label="Toggle GFA review queue and evidence card"
              aria-pressed={curationAssistantOpen}
              title="Show or hide read-only GFA and 3D contact review candidates"
              onClick={() => setCurationAssistantOpen((open) => !open)}
            >Review {curationIssues.length.toLocaleString()}</button>
            <button
              type="button"
              className="gfa-toolbar-details-toggle"
              aria-label={toolbarDetailsOpen ? "Hide GFA display options" : "Show GFA display options"}
              aria-expanded={toolbarDetailsOpen}
              title={toolbarDetailsOpen ? "Hide node, link, and legend options" : "Show node, link, and legend options"}
              onClick={() => setToolbarDetailsOpen((open) => !open)}
            >
              <span>Display</span>
              <ChevronDown size={13} aria-hidden="true" />
            </button>
            <button type="button" aria-label="Reset GFA graph layout" title="Reset graph layout" disabled={layoutMode === "curation" && Boolean(homologs.error)} onClick={resetLayout}>
              <RotateCcw size={14} aria-hidden="true" />
            </button>
            {onRestoreHeatmap ? (
              <button
                type="button"
                aria-label="Restore heatmap window"
                title="Restore heatmap window"
                onClick={onRestoreHeatmap}
              >
                <Maximize2 size={11} aria-hidden="true" />
              </button>
            ) : null}
            <button type="button" aria-label="Close GFA graph panel" title="Close GFA graph panel" onClick={onClose}>
              <X size={15} aria-hidden="true" />
            </button>
          </div>
        </div>
        {toolbarDetailsOpen ? <div className="gfa-toolbar-secondary">
          <div className="gfa-toolbar-node-filters" role="group" aria-label="GFA node visibility">
            <span className="gfa-toolbar-section-label">Show nodes</span>
            <button
              type="button"
              className="gfa-link-toggle"
              aria-label="Toggle unplaced unitigs"
              aria-pressed={showGfaOnlyNodes}
              title="Show or hide GFA unitigs that do not occur in the current AGP"
              onClick={toggleGfaOnlyNodes}
            >Unplaced</button>
            <button
              type="button"
              className="gfa-link-toggle"
              aria-label="Toggle disconnected GFA islands"
              aria-pressed={showDisconnectedNodes}
              title="Show or hide GFA components with no link path to any AGP chromosome"
              onClick={toggleDisconnectedNodes}
            >Islands</button>
          </div>
          <div className="gfa-toolbar-link-filters" role="group" aria-label="GFA and 3D contact link visibility">
            <span className="gfa-toolbar-section-label">Show links</span>
            <button
              type="button"
              className="gfa-link-toggle"
              aria-label="Toggle AGP links"
              aria-pressed={showAgpLinks}
              title="Show or hide all AGP adjacency and gap lines; hidden by default in Whole"
              onClick={toggleAgpLinks}
            >AGP</button>
            <button
              type="button"
              className="gfa-link-toggle"
              aria-label="Toggle GFA and 3D contact links between homologous chromosomes"
              aria-pressed={showHomologLinks}
              disabled={!showGfaLinks && !showHiCLinks}
              title="Show or hide GFA and 3D contact links between homologous chromosome members"
              onClick={() => setShowHomologLinks((visible) => !visible)}
            >Homolog</button>
            <button
              type="button"
              className="gfa-link-toggle"
              aria-label="Toggle GFA and 3D contact links between non-homologous chromosomes"
              aria-pressed={showNonHomologLinks}
              disabled={!showGfaLinks && !showHiCLinks}
              title="Show or hide GFA and 3D contact links between anchored chromosomes outside the same homolog group"
              onClick={() => setShowNonHomologLinks((visible) => !visible)}
            >Non-homolog</button>
            <button
              type="button"
              className="gfa-link-toggle"
              aria-label="Toggle GFA and 3D contact links between anchor and unanchor contigs"
              aria-pressed={showAnchorUnanchorLinks}
              disabled={!showGfaLinks && !showHiCLinks}
              title="Show or hide GFA and 3D contact links with one anchored endpoint and one unanchored endpoint"
              onClick={() => setShowAnchorUnanchorLinks((visible) => !visible)}
            >Anchor–unanchor</button>
          </div>
          <div className="gfa-toolbar-legend" aria-label="GFA graph line legend">
            <span className="gfa-toolbar-section-label">Lines</span>
            <span className="gfa-legend"><i className="joined" />Joined</span>
            <span className="gfa-legend"><i className="gap" />AGP gap</span>
            <span className="gfa-legend"><i className="link" />GFA link</span>
            <span className="gfa-legend"><i className="gap-link" />GFA across gap</span>
            <span className="gfa-legend"><i className="hic-link" />3D contacts</span>
          </div>
        </div> : null}
      </header>
      <div className={`gfa-canvas-frame${curationAssistantOpen ? " with-curation-assistant" : ""}`}>
        <canvas
          ref={canvasRef}
          className="gfa-graph-canvas"
          aria-label={layoutMode === "bandage"
            ? "Interactive Whole graph; drag a unitig to move and smoothly deform nearby path points, Shift-drag to select multiple blocks, right-click for assembly operations, drag empty space to pan, and scroll to zoom"
            : "Interactive GFA curation graph; drag a unitig to move its whole block, Shift-drag to select multiple blocks, right-click for assembly operations, drag empty space to pan, and scroll to zoom"}
          aria-haspopup="menu"
          onPointerDown={pointerDown}
          onPointerMove={pointerMove}
          onPointerUp={pointerUp}
          onPointerCancel={pointerCancel}
          onWheel={zoom}
          onContextMenu={openContextMenu}
        />
        {contextMenu?.kind === "assembly" ? (
          <AssemblyContextMenu
            position={contextMenu}
            uiState={uiState}
            onUiAction={onUiAction}
            onClose={() => setContextMenu(null)}
            fixed
          />
        ) : null}
        {contextMenu?.kind === "unplaced" && contextUnplacedNode ? (
          <GfaUnplacedContextMenu
            position={contextMenu}
            node={contextUnplacedNode}
            segment={document.segments[contextUnplacedNode.segmentName] ?? null}
            hasPlacementTarget={gfaAgpPlacementObjectIds(assemblyBlocks).length > 0}
            onAdd={() => {
              setPlacementNodeId(contextUnplacedNode.id);
              setContextMenu(null);
            }}
            onDeselect={() => {
              setSelectedUnplacedNodeId(null);
              setContextMenu(null);
            }}
          />
        ) : null}
        {curationAssistantOpen ? (
          <GfaCurationAssistant
            issues={curationIssues}
            selectedIssue={selectedCurationIssue}
            view={curationAssistantView}
            hiCAvailable={hiCContactMapReady}
            endpointHiC={endpointHiCDisplayState}
            onShowQueue={() => setCurationAssistantView("queue")}
            onInspectIssue={inspectCurationIssue}
          />
        ) : null}
      </div>
      {placementNode && placementSegment ? (
        <GfaUnplacedPlacementDialog
          key={placementNode.id}
          segment={placementSegment}
          assemblyBlocks={assemblyBlocks}
          onCancel={() => setPlacementNodeId(null)}
          onConfirm={(input) => {
            onUiAction({ type: "placeUnplacedGfaSegment", ...input });
            setPlacementNodeId(null);
            setSelectedUnplacedNodeId(null);
          }}
        />
      ) : null}
    </section>
  );
}

function GfaUnplacedContextMenu({
  position,
  node,
  segment,
  hasPlacementTarget,
  onAdd,
  onDeselect,
}: {
  position: AssemblyContextMenuPosition;
  node: GfaGraphNode;
  segment: GfaSegmentEvidence | null;
  hasPlacementTarget: boolean;
  onAdd: () => void;
  onDeselect: () => void;
}) {
  const menuWidth = 218;
  const left = typeof window === "undefined"
    ? position.x
    : clamp(position.x + 8, 8, Math.max(8, window.innerWidth - menuWidth - 8));
  const top = typeof window === "undefined"
    ? position.y
    : clamp(position.y + 8, 8, Math.max(8, window.innerHeight - 118));
  const knownLength = Number.isSafeInteger(segment?.length) && Number(segment?.length) > 0;
  const unavailableReason = !knownLength
    ? "This GFA segment has no reliable sequence or LN length."
    : !hasPlacementTarget
      ? "Import an AGP chromosome before placing this segment."
      : undefined;
  return (
    <div
      className="context-menu fixed-context-menu gfa-unplaced-context-menu"
      style={{ left, top }}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="gfa-unplaced-menu-summary">
        <strong>{node.segmentName}</strong>
        <small>{knownLength ? `${segment!.length!.toLocaleString()} bp · Unplaced` : "Length unavailable"}</small>
      </div>
      <button type="button" disabled={Boolean(unavailableReason)} title={unavailableReason} onClick={onAdd}>
        Add to AGP…
      </button>
      <button type="button" onClick={onDeselect}>Deselect</button>
    </div>
  );
}

function GfaUnplacedPlacementDialog({
  segment,
  assemblyBlocks,
  onCancel,
  onConfirm,
}: {
  segment: GfaSegmentEvidence;
  assemblyBlocks: ContactMapLayoutBlock[];
  onCancel: () => void;
  onConfirm: (input: UnplacedGfaPlacementInput) => void;
}) {
  const objectIds = useMemo(() => gfaAgpPlacementObjectIds(assemblyBlocks), [assemblyBlocks]);
  const [targetObjectId, setTargetObjectId] = useState(objectIds[0] ?? "");
  const [targetValue, setTargetValue] = useState("end");
  const [orientation, setOrientation] = useState<"+" | "-">("+");
  const targets = useMemo(
    () => gfaAgpPlacementTargets(assemblyBlocks, targetObjectId),
    [assemblyBlocks, targetObjectId],
  );
  const target = targets.find((candidate) => candidate.value === targetValue)
    ?? targets[targets.length - 1]
    ?? null;
  const input: UnplacedGfaPlacementInput = {
    segmentName: segment.name,
    length: segment.length ?? 0,
    targetObjectId,
    targetBlockId: target?.targetBlockId ?? null,
    orientation,
  };
  const plan = useMemo(
    () => planUnplacedGfaPlacement(assemblyBlocks, input),
    [assemblyBlocks, input.length, input.orientation, input.segmentName, input.targetBlockId, input.targetObjectId],
  );
  const agpComponentRow = useMemo(() => {
    if (!plan.ok) return null;
    return exportAgpText(plan.blocks).split("\n").find((line) => {
      const columns = line.split("\t");
      return columns[0] === targetObjectId
        && columns[5] === segment.name
        && columns[6] === "1"
        && columns[7] === String(segment.length);
    }) ?? null;
  }, [plan, segment.length, segment.name, targetObjectId]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  }, [onCancel]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (plan.ok) {
      onConfirm(input);
    }
  }

  return (
    <div
      className="assembly-delete-backdrop gfa-placement-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <form
        className="gfa-placement-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="gfa-placement-title"
        onSubmit={submit}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <span>
            <h2 id="gfa-placement-title">Add to AGP</h2>
            <p>{segment.name} · {segment.length?.toLocaleString() ?? "unknown"} bp</p>
          </span>
          <button type="button" aria-label="Close Add to AGP dialog" onClick={onCancel}><X size={14} /></button>
        </header>
        <div className="gfa-placement-fields">
          <label>
            <span>Chromosome</span>
            <select
              autoFocus
              value={targetObjectId}
              onChange={(event) => {
                setTargetObjectId(event.target.value);
                setTargetValue("end");
              }}
            >
              {objectIds.map((objectId) => <option key={objectId} value={objectId}>{objectId}</option>)}
            </select>
          </label>
          <label>
            <span>Position</span>
            <select value={target?.value ?? ""} onChange={(event) => setTargetValue(event.target.value)}>
              {targets.map((candidate) => (
                <option key={candidate.value} value={candidate.value}>{candidate.label}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Orientation</span>
            <select value={orientation} onChange={(event) => setOrientation(event.target.value as "+" | "-")}>
              <option value="+">Forward (+)</option>
              <option value="-">Reverse (−)</option>
            </select>
          </label>
        </div>
        <section className="gfa-placement-preview" aria-label="AGP placement preview">
          <strong>Preview</strong>
          {plan.ok ? (
            <>
              <dl>
                <div><dt>Left boundary</dt><dd>{formatPlacementGap(plan.gapBefore)}</dd></div>
                <div><dt>Right boundary</dt><dd>{formatPlacementGap(plan.gapAfter)}</dd></div>
              </dl>
              {agpComponentRow ? <code>{agpComponentRow}</code> : null}
            </>
          ) : <p role="alert">{plan.reason}</p>}
        </section>
        <p className="gfa-placement-note">
          New boundaries use unknown 100 bp AGP gaps. GFA links remain evidence and are not converted automatically.
        </p>
        <footer>
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="submit" className="gfa-placement-confirm" disabled={!plan.ok}>Add to AGP</button>
        </footer>
      </form>
    </div>
  );
}

function formatPlacementGap(gap: ContactMapLayoutBlock["gapBefore"]) {
  return gap && gap.length > 0
    ? `${gap.componentType} · ${gap.length.toLocaleString()} bp · ${gap.linkage === "no" ? "unknown" : gap.gapType}`
    : "Chromosome end";
}

function GfaCurationAssistant({
  issues,
  selectedIssue,
  view,
  hiCAvailable,
  endpointHiC,
  onShowQueue,
  onInspectIssue,
}: {
  issues: GfaCurationIssue[];
  selectedIssue: GfaCurationIssue | null;
  view: CurationAssistantView;
  hiCAvailable: boolean;
  endpointHiC: EndpointHiCDisplayState;
  onShowQueue: () => void;
  onInspectIssue: (issue: GfaCurationIssue) => void;
}) {
  const priorityCounts = issues.reduce(
    (counts, issue) => ({ ...counts, [issue.priority]: counts[issue.priority] + 1 }),
    { high: 0, medium: 0, info: 0 },
  );

  return (
    <aside className="gfa-curation-assistant" aria-label="GFA review queue and evidence">
      <header className="gfa-curation-assistant-header">
        {view === "evidence" ? (
          <button type="button" className="gfa-evidence-back" onClick={onShowQueue}>
            ← Queue
          </button>
        ) : (
          <span>
            <strong>Review queue</strong>
            <small>{issues.length.toLocaleString()} candidates</small>
          </span>
        )}
        <em>Read-only</em>
      </header>
      {view === "queue" ? (
        <div className="gfa-review-queue-view">
          <div className="gfa-review-summary" aria-label="Review candidate counts">
            <span className="high"><strong>{priorityCounts.high}</strong> high</span>
            <span className="medium"><strong>{priorityCounts.medium}</strong> review</span>
            <span className="info"><strong>{priorityCounts.info}</strong> context</span>
          </div>
          {!hiCAvailable ? (
            <p className="gfa-review-notice">3D contact triage is unavailable until the current assembly overview is ready.</p>
          ) : null}
          {issues.length > 0 ? (
            <ol className="gfa-review-list">
              {issues.map((issue) => (
                <li key={issue.id}>
                  <button
                    type="button"
                    className={`gfa-review-item priority-${issue.priority}`}
                    aria-label={`Inspect ${issue.title}`}
                    onClick={() => onInspectIssue(issue)}
                  >
                    <span className="gfa-review-item-heading">
                      <i aria-hidden="true" />
                      <strong>{issue.title}</strong>
                      <b aria-hidden="true">›</b>
                    </span>
                    <small>{issueKindLabel(issue.kind)}</small>
                    <p>{issue.summary}</p>
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <div className="gfa-review-empty">
              <strong>No review candidates</strong>
              <p>No endpoint conflict, gap bridge, strong non-adjacent 3D contact pair, or copy ambiguity was found in the current graph scope.</p>
            </div>
          )}
        </div>
      ) : selectedIssue ? (
        <GfaEvidenceCard
          issue={selectedIssue}
          endpointHiC={endpointHiC}
          onFocus={() => onInspectIssue(selectedIssue)}
        />
      ) : (
        <div className="gfa-review-empty">
          <strong>No evidence selected</strong>
          <button type="button" onClick={onShowQueue}>Return to queue</button>
        </div>
      )}
    </aside>
  );
}

function GfaEvidenceCard({
  issue,
  endpointHiC,
  onFocus,
}: {
  issue: GfaCurationIssue;
  endpointHiC: EndpointHiCDisplayState;
  onFocus: () => void;
}) {
  return (
    <article className="gfa-evidence-card" aria-label={`Evidence for ${issue.title}`}>
      <div className="gfa-evidence-title-row">
        <span className={`gfa-priority-badge priority-${issue.priority}`}>
          {issuePriorityLabel(issue.priority)}
        </span>
        <span>{issueKindLabel(issue.kind)}</span>
      </div>
      <h3>{issue.title}</h3>
      <p className="gfa-evidence-summary">{issue.summary}</p>
      {issue.focusAssemblyUnitIds.length > 0 ? (
        <button type="button" className="gfa-evidence-focus" onClick={onFocus}>
          Focus in Guided
        </button>
      ) : null}

      {issue.placements.length > 0 ? (
        <section>
          <h4>Placements</h4>
          <div className="gfa-evidence-placement-list">
            {issue.placements.map((placement) => (
              <dl key={placement.nodeId}>
                <div><dt>Unitig</dt><dd>{placement.segmentName}</dd></div>
                <div><dt>AGP</dt><dd>{placement.kind === "placed" ? placement.groupId : "Not placed"}</dd></div>
                <div><dt>Orientation</dt><dd>{placement.orientation}</dd></div>
                <div><dt>Length</dt><dd>{formatEvidenceBasePairs(placement.length)}</dd></div>
                <div><dt>Read depth</dt><dd>{placement.readDepth ?? "Not provided"}</dd></div>
              </dl>
            ))}
          </div>
        </section>
      ) : null}

      {issue.agp ? (
        <section>
          <h4>Current AGP</h4>
          <dl className="gfa-evidence-facts">
            <div><dt>Relationship</dt><dd>{agpRelationshipLabel(issue.agp.relationship)}</dd></div>
            {issue.agp.gapLength !== null ? (
              <div><dt>Gap</dt><dd>{formatEvidenceBasePairs(issue.agp.gapLength)}</dd></div>
            ) : null}
          </dl>
        </section>
      ) : null}

      {issue.gfa ? (
        <section>
          <h4>GFA link</h4>
          <dl className="gfa-evidence-facts">
            <div>
              <dt>Ends</dt>
              <dd>{gfaLinkEndsLabel(issue)}</dd>
            </div>
            <div><dt>Overlap</dt><dd>{issue.gfa.overlap ?? "Not provided"}</dd></div>
            <div><dt>Pair links</dt><dd>{issue.gfa.pairLinkCount.toLocaleString()}</dd></div>
          </dl>
        </section>
      ) : null}

      {issue.hic ? (
        <section>
          <h4>3D contact overview</h4>
          <dl className="gfa-evidence-facts">
            <div><dt>Raw apportioned</dt><dd>{formatEvidenceNumber(issue.hic.rawCount)}</dd></div>
            <div><dt>Length-normalized</dt><dd>{formatEvidenceNumber(issue.hic.normalizedCountPerMb2)} contacts/Mb²</dd></div>
            <div><dt>Rank</dt><dd>Top {Math.max(1, Math.round((1 - issue.hic.percentile) * 100))}%</dd></div>
          </dl>
        </section>
      ) : null}

      {endpointHiC.status !== "not-applicable" ? (
        <GfaEndpointHiCEvidenceSection issue={issue} state={endpointHiC} />
      ) : null}

      <section className="gfa-evidence-interpretation">
        <h4>What it supports</h4>
        <p>{issue.interpretation}</p>
      </section>
      <section className="gfa-evidence-limits">
        <h4>Limits</h4>
        <ul>
          {issue.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}
        </ul>
      </section>
    </article>
  );
}

function GfaEndpointHiCEvidenceSection({
  issue,
  state,
}: {
  issue: GfaCurationIssue;
  state: Exclude<EndpointHiCDisplayState, { status: "not-applicable" }>;
}) {
  if (state.status === "loading") {
    return (
      <section className="gfa-endpoint-hic" aria-busy="true">
        <h4>Endpoint contacts</h4>
        <p className="gfa-endpoint-status">Loading four terminal-window combinations…</p>
      </section>
    );
  }
  if (state.status === "ineligible") {
    return (
      <section className="gfa-endpoint-hic">
        <h4>Endpoint contacts</h4>
        <p className="gfa-endpoint-status">{state.reason}</p>
      </section>
    );
  }
  if (state.result.status !== "ready") {
    return (
      <section className={`gfa-endpoint-hic status-${state.result.status}`}>
        <h4>Endpoint contacts</h4>
        <p className="gfa-endpoint-status">{state.result.reason}</p>
        {state.result.resolution ? (
          <small>Attempted resolution: {formatEvidenceBasePairs(state.result.resolution)}/bin</small>
        ) : null}
      </section>
    );
  }

  const { evidence } = state.result;
  const source = issue.placements.find(
    (placement) => placement.nodeId === evidence.sourceBlockId,
  );
  const target = issue.placements.find(
    (placement) => placement.nodeId === evidence.targetBlockId,
  );
  if (!source || !target) {
    return (
      <section className="gfa-endpoint-hic status-unavailable">
        <h4>Endpoint contacts</h4>
        <p className="gfa-endpoint-status">The endpoint result no longer matches this evidence pair.</p>
      </section>
    );
  }

  const signalUnit = evidence.normalization === "raw"
    ? "contacts/Mb²"
    : `${endpointNormalizationLabel(evidence.normalization)} signal/Mb²`;
  const best = evidence.bestQuadrant;
  const endpoints: GfaDisplayedEndpoint[] = ["left", "right"];
  return (
    <section className="gfa-endpoint-hic">
      <h4>Endpoint contacts</h4>
      <p className="gfa-endpoint-intro">
        Displayed terminal windows for <strong>{source.segmentName}</strong> × <strong>{target.segmentName}</strong>.
      </p>
      <table className="gfa-endpoint-matrix">
        <caption>Length-normalized signal for each displayed endpoint pair</caption>
        <thead>
          <tr>
            <th scope="col">Source ↓ / target →</th>
            {endpoints.map((endpoint) => (
              <th scope="col" key={endpoint}>
                {endpointHeader(target, endpoint)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {endpoints.map((sourceEndpoint) => (
            <tr key={sourceEndpoint}>
              <th scope="row">{endpointHeader(source, sourceEndpoint)}</th>
              {endpoints.map((targetEndpoint) => {
                const quadrant = evidence.quadrants.find((candidate) => (
                  candidate.sourceEndpoint === sourceEndpoint
                  && candidate.targetEndpoint === targetEndpoint
                ));
                const isBest = best?.sourceEndpoint === sourceEndpoint
                  && best.targetEndpoint === targetEndpoint;
                return (
                  <td key={targetEndpoint} className={isBest ? "is-best" : undefined}>
                    <strong>{formatEvidenceNumber(quadrant?.normalizedCountPerMb2 ?? 0)}</strong>
                    <small>{signalUnit}</small>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      <dl className="gfa-evidence-facts gfa-endpoint-facts">
        <div><dt>Resolution</dt><dd>{formatEvidenceBasePairs(evidence.resolution)}/bin</dd></div>
        <div>
          <dt>Windows</dt>
          <dd>{formatEvidenceBasePairs(evidence.sourceWindowBp)} × {formatEvidenceBasePairs(evidence.targetWindowBp)}</dd>
        </div>
        <div><dt>Matrix</dt><dd>{endpointNormalizationLabel(evidence.normalization)}</dd></div>
        <div>
          <dt>Strongest pair</dt>
          <dd>{best ? `${endpointHeader(source, best.sourceEndpoint)} ↔ ${endpointHeader(target, best.targetEndpoint)}` : "No nonzero endpoint signal"}</dd>
        </div>
        <div>
          <dt>Contrast</dt>
          <dd>{evidence.contrastToNext === null ? "No nonzero runner-up" : `${formatEvidenceNumber(evidence.contrastToNext)}× vs next`}</dd>
        </div>
      </dl>
      {!evidence.complete ? (
        <p className="gfa-endpoint-warning">
          Partial result: {evidence.missingTileCount.toLocaleString()} requested tile(s) were missing.
        </p>
      ) : null}
      <p className="gfa-endpoint-caveat">
        This identifies where contact signal is concentrated; it remains evidence for review, not an automatic flip or move.
      </p>
    </section>
  );
}

function endpointHeader(
  placement: GfaCurationPlacementEvidence,
  endpoint: GfaDisplayedEndpoint,
) {
  const physicalSide = physicalSideForDisplayedEndpoint(placement.orientation, endpoint);
  return `${endpoint === "left" ? "L" : "R"} (${physicalSide ?? "physical ?"})`;
}

function endpointNormalizationLabel(
  normalization: "raw" | "ice" | "kr" | "vc" | "vc_sqrt",
) {
  switch (normalization) {
    case "raw": return "Raw";
    case "ice": return "ICE balanced";
    case "kr": return "KR balanced";
    case "vc": return "VC";
    case "vc_sqrt": return "VC sqrt";
  }
}

function issueKindLabel(kind: GfaCurationIssue["kind"]) {
  switch (kind) {
    case "orientation-conflict": return "Endpoint conflict";
    case "gap-bridge": return "Gap bridge";
    case "off-backbone": return "Non-adjacent evidence";
    case "unplaced-neighbor": return "Unplaced neighbor";
    case "copy-ambiguity": return "Copy ambiguity";
  }
}

function issuePriorityLabel(priority: GfaCurationIssue["priority"]) {
  return priority === "high" ? "High" : priority === "medium" ? "Review" : "Context";
}

function agpRelationshipLabel(relationship: NonNullable<GfaCurationIssue["agp"]>["relationship"]) {
  switch (relationship) {
    case "adjacent": return "Adjacent placements";
    case "same-scaffold-nonadjacent": return "Same chromosome, non-adjacent";
    case "cross-scaffold": return "Different chromosomes";
    case "unplaced": return "One unitig is not placed";
  }
}

function gfaLinkEndsLabel(issue: GfaCurationIssue) {
  if (!issue.gfa) {
    return "Not available";
  }
  const source = issue.placements.find((placement) => placement.nodeId === issue.gfa!.sourceNodeId);
  const target = issue.placements.find((placement) => placement.nodeId === issue.gfa!.targetNodeId);
  return `${source?.segmentName ?? issue.gfa.sourceNodeId}:${issue.gfa.sourceSide ?? "?"} ↔ ${target?.segmentName ?? issue.gfa.targetNodeId}:${issue.gfa.targetSide ?? "?"}`;
}

function formatEvidenceNumber(value: number) {
  return value.toLocaleString(undefined, { maximumFractionDigits: value >= 100 ? 1 : 2 });
}

function formatEvidenceBasePairs(value: number) {
  if (value >= 1_000_000) {
    return `${formatEvidenceNumber(value / 1_000_000)} Mb`;
  }
  if (value >= 1_000) {
    return `${formatEvidenceNumber(value / 1_000)} kb`;
  }
  return `${value.toLocaleString()} bp`;
}

export function graphForVisibleHomologScaffolds(
  graph: GfaAssemblyGraph,
  visibleScaffoldIds: ReadonlySet<string>,
  homologs: GfaHomologClassification,
  includeDisconnected = true,
  fallbackToAllChromosomes = true,
): GfaAssemblyGraph {
  const regexMatchedScaffolds = homologScaffoldIds(homologs);
  const requestedScaffolds = new Set(
    [...visibleScaffoldIds].filter((id) => regexMatchedScaffolds.has(id)),
  );
  const displayedScaffolds = requestedScaffolds.size > 0 || !fallbackToAllChromosomes
    ? requestedScaffolds
    : regexMatchedScaffolds;
  const chromosomeNodes = graph.nodes.filter((node) => displayedScaffolds.has(node.groupId));
  const displayedChromosomeIds = new Set(chromosomeNodes.map((node) => node.id));
  const allChromosomeIds = new Set(
    graph.nodes
      .filter((node) => regexMatchedScaffolds.has(node.groupId))
      .map((node) => node.id),
  );
  const unanchoredNodes = graph.nodes.filter((node) => !regexMatchedScaffolds.has(node.groupId));
  const unanchoredIds = new Set(unanchoredNodes.map((node) => node.id));
  const adjacency = new Map(unanchoredNodes.map((node) => [node.id, [] as string[]]));
  const linkedToDisplayed = new Set<string>();
  const linkedToAnyChromosome = new Set<string>();

  for (const edge of graph.edges) {
    if (edge.kind !== "gfa-link") {
      continue;
    }
    const sourceUnanchored = unanchoredIds.has(edge.source);
    const targetUnanchored = unanchoredIds.has(edge.target);
    if (sourceUnanchored && targetUnanchored) {
      adjacency.get(edge.source)!.push(edge.target);
      adjacency.get(edge.target)!.push(edge.source);
      continue;
    }
    if (sourceUnanchored && allChromosomeIds.has(edge.target)) {
      linkedToAnyChromosome.add(edge.source);
      if (displayedChromosomeIds.has(edge.target)) {
        linkedToDisplayed.add(edge.source);
      }
    }
    if (targetUnanchored && allChromosomeIds.has(edge.source)) {
      linkedToAnyChromosome.add(edge.target);
      if (displayedChromosomeIds.has(edge.source)) {
        linkedToDisplayed.add(edge.target);
      }
    }
  }

  const selectedUnanchoredIds = new Set<string>();
  const visited = new Set<string>();
  for (const node of unanchoredNodes) {
    if (visited.has(node.id)) {
      continue;
    }
    const component: string[] = [];
    const queue = [node.id];
    visited.add(node.id);
    while (queue.length > 0) {
      const current = queue.shift()!;
      component.push(current);
      for (const neighbor of adjacency.get(current) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    const touchesDisplayed = component.some((id) => linkedToDisplayed.has(id));
    const touchesAnyChromosome = component.some((id) => linkedToAnyChromosome.has(id));
    if (touchesDisplayed || (includeDisconnected && !touchesAnyChromosome)) {
      component.forEach((id) => selectedUnanchoredIds.add(id));
    }
  }

  const nodes = graph.nodes.filter((node) => (
    displayedScaffolds.has(node.groupId) || selectedUnanchoredIds.has(node.id)
  ));
  const nodeIds = new Set(nodes.map((node) => node.id));
  return {
    ...graph,
    nodes,
    edges: graph.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)),
    groupOrder: graph.groupOrder.filter((groupId) => (
      nodes.some((node) => node.groupId === groupId)
    )),
  };
}

/** Hide GFA-only nodes by occurrence membership, never by chromosome regex. */
export function graphForGfaOnlyNodeVisibility(
  graph: GfaAssemblyGraph,
  showGfaOnlyNodes: boolean,
): GfaAssemblyGraph {
  if (showGfaOnlyNodes) {
    return graph;
  }
  const nodes = graph.nodes.filter((node) => node.occurrenceId !== null);
  const nodeIds = new Set(nodes.map((node) => node.id));
  return {
    ...graph,
    nodes,
    edges: graph.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)),
    groupOrder: graph.groupOrder.filter((groupId) => (
      nodes.some((node) => node.groupId === groupId)
    )),
  };
}

/**
 * Hide graph components that have no GFA-link path to a regex-recognized
 * chromosome scaffold. Connectivity may be evaluated on the complete graph
 * while filtering a smaller Bandage viewport graph.
 */
export function graphForChromosomeConnectionVisibility(
  graph: GfaAssemblyGraph,
  connectivityGraph: GfaAssemblyGraph,
  homologs: GfaHomologClassification,
  showDisconnectedNodes: boolean,
): GfaAssemblyGraph {
  if (showDisconnectedNodes) {
    return graph;
  }
  const chromosomeScaffolds = homologScaffoldIds(homologs);
  const connectedIds = new Set(
    connectivityGraph.nodes
      .filter((node) => chromosomeScaffolds.has(node.groupId))
      .map((node) => node.id),
  );
  const adjacency = new Map(connectivityGraph.nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of connectivityGraph.edges) {
    if (edge.kind !== "gfa-link") {
      continue;
    }
    adjacency.get(edge.source)?.push(edge.target);
    adjacency.get(edge.target)?.push(edge.source);
  }
  const queue = [...connectedIds];
  for (let index = 0; index < queue.length; index += 1) {
    for (const neighbor of adjacency.get(queue[index]) ?? []) {
      if (!connectedIds.has(neighbor)) {
        connectedIds.add(neighbor);
        queue.push(neighbor);
      }
    }
  }
  const nodes = graph.nodes.filter((node) => connectedIds.has(node.id));
  const nodeIds = new Set(nodes.map((node) => node.id));
  return {
    ...graph,
    nodes,
    edges: graph.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)),
    groupOrder: graph.groupOrder.filter((groupId) => (
      nodes.some((node) => node.groupId === groupId)
    )),
  };
}

/**
 * Apply both node-visibility switches to Guided's local contig window.
 * Disconnected components must be selected from the complete graph before the
 * Non-AGP filter runs; otherwise the one-hop Guided crop makes the toggle a
 * no-op. The focused chromosome window is always retained.
 */
export function graphForGuidedNodeVisibility(
  graph: GfaAssemblyGraph,
  visibleContigIds: ReadonlySet<string>,
  homologs: GfaHomologClassification,
  showGfaOnlyNodes: boolean,
  showDisconnectedNodes: boolean,
  maxNodes = Number.POSITIVE_INFINITY,
  fallbackToAllContigs = true,
) {
  const focused = graphForVisibleContigs(graph, visibleContigIds, fallbackToAllContigs);
  let candidate = focused;
  if (showDisconnectedNodes) {
    const chromosomeConnected = graphForChromosomeConnectionVisibility(
      graph,
      graph,
      homologs,
      false,
    );
    const connectedIds = new Set(chromosomeConnected.nodes.map((node) => node.id));
    const selectedIds = new Set(focused.nodes.map((node) => node.id));
    for (const node of graph.nodes) {
      if (!connectedIds.has(node.id)) {
        selectedIds.add(node.id);
      }
    }
    candidate = inducedGfaGraph(graph, selectedIds);
  }
  const visible = graphForGfaOnlyNodeVisibility(candidate, showGfaOnlyNodes);
  return limitGfaAssemblyGraph(
    visible,
    maxNodes,
    new Set(focused.nodes.map((node) => node.id)),
  );
}

function homologScaffoldIds(homologs: GfaHomologClassification) {
  return new Set(
    homologs.columns.flatMap((column) => column.scaffolds.map((scaffold) => scaffold.id)),
  );
}

function graphForVisibleContigs(
  graph: GfaAssemblyGraph,
  visibleContigIds: ReadonlySet<string>,
  fallbackToAllContigs = true,
): GfaAssemblyGraph {
  if (visibleContigIds.size === 0) {
    return fallbackToAllContigs ? graph : inducedGfaGraph(graph, new Set());
  }
  const focalIds = gfaBandageFocalNodeIds(graph.nodes, visibleContigIds);
  const directNeighborIds = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.kind !== "gfa-link") {
      continue;
    }
    if (focalIds.has(edge.source)) {
      directNeighborIds.add(edge.target);
    }
    if (focalIds.has(edge.target)) {
      directNeighborIds.add(edge.source);
    }
  }
  const nodes = graph.nodes.filter((node) => (
    focalIds.has(node.id)
    || directNeighborIds.has(node.id)
  ));
  const nodeIds = new Set(nodes.map((node) => node.id));
  return {
    ...graph,
    nodes,
    edges: graph.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)),
    groupOrder: graph.groupOrder.filter((groupId) => (
      nodes.some((node) => node.groupId === groupId)
    )),
  };
}

function inducedGfaGraph(
  graph: GfaAssemblyGraph,
  nodeIds: ReadonlySet<string>,
): GfaAssemblyGraph {
  const nodes = graph.nodes.filter((node) => nodeIds.has(node.id));
  return {
    ...graph,
    nodes,
    edges: graph.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)),
    groupOrder: graph.groupOrder.filter((groupId) => (
      nodes.some((node) => node.groupId === groupId)
    )),
  };
}

function fitViewToNodes(
  canvas: HTMLCanvasElement,
  nodes: LayoutNode[],
  view: ViewTransform,
  layoutMode: GfaLayoutMode,
) {
  const bounds = canvas.getBoundingClientRect();
  if (nodes.length === 0 || bounds.width < 40 || bounds.height < 40) {
    return false;
  }
  // A curation view should open on chromosome-assigned unitigs. Debris and
  // unplaced components remain on the same pannable canvas, but must not shrink
  // the chromosome layout to an unreadable overview.
  const chromosomeNodes = layoutMode === "curation"
    ? nodes.filter((node) => node.homologColumn !== null)
    : [];
  const fitNodes = chromosomeNodes.length > 0 ? chromosomeNodes : nodes;
  const fitBounds = fitNodes.map(visualNodeBounds);
  const nodeMinX = Math.min(...fitBounds.map((bounds) => bounds.left)) - 28;
  // Curation rows have right-aligned chromosome labels at x=150. Include
  // their full text gutter in automatic framing instead of clipping "Chr".
  const minX = chromosomeNodes.length > 0 ? Math.min(-220, nodeMinX) : nodeMinX;
  const maxX = Math.max(...fitBounds.map((bounds) => bounds.right)) + 28;
  const minY = Math.min(...fitBounds.map((bounds) => bounds.top)) - 28;
  const maxY = Math.max(...fitBounds.map((bounds) => bounds.bottom)) + 72;
  // In the shallow bottom panel, fitting every chromosome and unanchored
  // component would collapse the curation rows. Fit chromosome width first;
  // the user can pan vertically across chromosome groups and rightward into
  // the unanchored evidence area.
  const scale = chromosomeNodes.length > 0
    ? clamp((bounds.width - 24) / Math.max(1, maxX - minX), 0.12, 0.8)
    : clamp(
      Math.min((bounds.width - 24) / Math.max(1, maxX - minX), (bounds.height - 20) / Math.max(1, maxY - minY)),
      0.06,
      1.25,
    );
  view.scale = scale;
  view.x = (bounds.width - (minX + maxX) * scale) / 2;
  view.y = chromosomeNodes.length > 0
    ? 14 - minY * scale
    : (bounds.height - (minY + maxY) * scale) / 2;
  return true;
}

function drawCurrentGraph(
  canvas: HTMLCanvasElement,
  graph: GfaAssemblyGraph | null,
  nodes: LayoutNode[],
  view: ViewTransform,
  selectedIds: ReadonlySet<string>,
  fitPending: { current: boolean },
  homologs: GfaHomologClassification,
  showGfaLinks: boolean,
  showHomologLinks: boolean,
  showNonHomologLinks: boolean,
  showAnchorUnanchorLinks: boolean,
  showAgpLinks: boolean,
  hiCLinks: ReadonlyArray<GfaEndpointHiCLink>,
  selectionBox: GfaSelectionBox | null = null,
) {
  if (!graph) {
    return;
  }
  if (fitPending.current && fitViewToNodes(canvas, nodes, view, layoutModeFromNodes(nodes))) {
    fitPending.current = false;
  }
  drawInteractiveGraph(
    canvas,
    nodes,
    graph,
    view,
    selectedIds,
    homologs,
    showGfaLinks,
    showHomologLinks,
    showNonHomologLinks,
    showAnchorUnanchorLinks,
    showAgpLinks,
    hiCLinks,
    selectionBox,
  );
}

function initializeLayoutNodes(
  graph: GfaAssemblyGraph,
  homologs: GfaHomologClassification,
  previous: LayoutNode[],
  layoutMode: GfaLayoutMode,
  evidenceGraph: GfaAssemblyGraph = graph,
  guidedFocalNodeIds: ReadonlySet<string> = new Set<string>(),
  savedBandagePaths: ReadonlyMap<string, GfaPathPoint[]> = new Map<string, GfaPathPoint[]>(),
  nativeBandagePaths?: ReadonlyMap<string, GfaPathPoint[]>,
) {
  const previousById = new Map(previous.map((node) => [node.id, node]));
  const homologByScaffold = new Map(
    homologs.columns.flatMap((column) => column.scaffolds.map((scaffold) => [scaffold.id, column.id] as const)),
  );
  const homologPaletteByScaffold = new Map(
    homologs.columns.flatMap((column, columnIndex) => (
      column.scaffolds.map((scaffold, memberIndex) => [
        scaffold.id,
        { columnIndex, memberIndex },
      ] as const)
    )),
  );
  const automaticBandagePaths = layoutMode === "bandage"
    ? nativeBandagePaths ?? layoutGfaNodePathsBandage(graph.nodes, graph.edges)
    : new Map<string, GfaPathPoint[]>();
  const positions = layoutMode === "bandage"
    ? new Map([...automaticBandagePaths].map(([nodeId, pathPoints]) => (
      [nodeId, bandagePathCenter(pathPoints)]
    )))
    : layoutMode === "guided"
      ? layoutGfaNodesGuided(graph.nodes, graph.edges, guidedFocalNodeIds)
      : layoutGfaNodesForCuration(
      graph.nodes,
      graph.edges,
      homologs,
      evidenceGraph.nodes,
      evidenceGraph.edges,
    );
  const bandageWidths = layoutMode !== "curation"
    ? gfaBandageNodeWidths(graph.nodes)
    : new Map<string, number>();
  const curationWidths = layoutMode === "curation"
    ? gfaCurationNodeWidths(graph.nodes)
    : new Map<string, number>();
  const output: LayoutNode[] = [];
  for (const node of graph.nodes) {
      const position = positions.get(node.id) ?? { x: 90, y: 64 };
      const targetX = position.x;
      const targetY = position.y;
      const existing = previousById.get(node.id);
      const width = layoutMode !== "curation"
        ? bandageWidths.get(node.id) ?? 18
        : curationWidths.get(node.id) ?? 12;
      const storedPath = layoutMode === "bandage"
        ? existing?.pathPoints.length
          ? existing.pathPoints
          : savedBandagePaths.get(node.id)
        : undefined;
      const pathPoints = layoutMode === "bandage"
        ? storedPath?.map(copyPathPoint)
          ?? automaticBandagePaths.get(node.id)?.map(copyPathPoint)
          ?? gfaInitialBandagePathPoints(targetX, targetY, width)
        : [];
      const pathCenter = bandagePathCenter(pathPoints);
      output.push({
        ...node,
        x: layoutMode === "bandage"
          ? pathCenter.x
          : existing?.manuallyPlaced ? existing.x : targetX,
        y: layoutMode === "bandage"
          ? pathCenter.y
          : existing?.manuallyPlaced ? existing.y : targetY,
        anchorX: targetX,
        anchorY: targetY,
        width,
        height: 14,
        scaffoldColor: homologByScaffold.has(node.groupId)
          ? homologScaffoldColor(
            homologPaletteByScaffold.get(node.groupId)?.columnIndex ?? 0,
            homologPaletteByScaffold.get(node.groupId)?.memberIndex ?? 0,
          )
          : unplacedAssemblyColor,
        homologColumn: homologByScaffold.get(node.groupId) ?? null,
        guidedFocal: layoutMode !== "guided" || guidedFocalNodeIds.has(node.id),
        manuallyPlaced: layoutMode === "bandage"
          ? Boolean(existing?.manuallyPlaced || savedBandagePaths.has(node.id))
          : existing?.manuallyPlaced ?? false,
        layoutMode,
        pathPoints,
      });
  }
  return output;
}

function drawInteractiveGraph(
  canvas: HTMLCanvasElement,
  nodes: LayoutNode[],
  graph: GfaAssemblyGraph,
  view: ViewTransform,
  selectedIds: ReadonlySet<string>,
  homologs: GfaHomologClassification,
  showGfaLinks: boolean,
  showHomologLinks: boolean,
  showNonHomologLinks: boolean,
  showAnchorUnanchorLinks: boolean,
  showAgpLinks: boolean,
  hiCLinks: ReadonlyArray<GfaEndpointHiCLink>,
  selectionBox: GfaSelectionBox | null,
) {
  resizeCanvas(canvas);
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.width / ratio;
  const height = canvas.height / ratio;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#fbfbfc";
  context.fillRect(0, 0, width, height);
  context.save();
  context.translate(view.x, view.y);
  context.scale(view.scale, view.scale);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const anchoredScaffoldIds = homologScaffoldIds(homologs);
  const agpGapPairs = new Set(
    graph.edges
      .filter((edge) => edge.kind === "agp-gap")
      .map((edge) => unorderedNodePair(edge.source, edge.target)),
  );

  if (layoutModeFromNodes(nodes) === "curation") {
    drawChromosomeRowLabels(context, nodes, view.scale, homologs);
  }
  drawEndpointHiCLinks(context, byId, hiCLinks, view.scale);
  for (const edge of graph.edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    const visible = edge.kind !== "gfa-link"
      ? showAgpLinks
      : (
        showGfaLinks
        && source
        && target
        && gfaRelationLinkVisible(
          source,
          target,
          homologs,
          anchoredScaffoldIds,
          showHomologLinks,
          showNonHomologLinks,
          showAnchorUnanchorLinks,
        )
      );
    if (source && target && visible) {
      drawGraphEdge(
        context,
        source,
        target,
        edge,
        view.scale,
        edge.kind === "gfa-link"
          && showAgpLinks
          && agpGapPairs.has(unorderedNodePair(edge.source, edge.target)),
      );
    }
  }
  const previewUnitIds = selectionBox
    ? new Set(gfaAssemblyUnitIdsInSelection(
      nodes,
      { x: selectionBox.startX, y: selectionBox.startY },
      { x: selectionBox.currentX, y: selectionBox.currentY },
    ))
    : new Set<string>();
  for (const node of nodes) {
    drawGraphNode(
      context,
      node,
      gfaNodeMatchesAssemblySelection(node, selectedIds)
        || Boolean(gfaAssemblyUnitId(node) && previewUnitIds.has(gfaAssemblyUnitId(node)!)),
      view.scale,
    );
  }
  if (selectionBox) {
    const left = Math.min(selectionBox.startX, selectionBox.currentX);
    const top = Math.min(selectionBox.startY, selectionBox.currentY);
    const width = Math.abs(selectionBox.currentX - selectionBox.startX);
    const height = Math.abs(selectionBox.currentY - selectionBox.startY);
    context.save();
    context.fillStyle = "rgba(37, 99, 235, 0.09)";
    context.strokeStyle = "#2563eb";
    context.lineWidth = Math.max(1.4, 1.4 / view.scale);
    context.setLineDash([6 / view.scale, 4 / view.scale]);
    context.fillRect(left, top, width, height);
    context.strokeRect(left, top, width, height);
    context.restore();
  }
  context.restore();
}

export interface GfaCanvasBenchmarkOptions {
  nodeCount?: number;
  edgeCount?: number;
  contactLinkCount?: number;
  iterations?: number;
  width?: number;
  height?: number;
}

export interface GfaCanvasBenchmarkResult {
  nodeCount: number;
  edgeCount: number;
  contactLinkCount: number;
  iterations: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

/**
 * Browser-only diagnostic that benchmarks the actual interactive GFA Canvas
 * renderer with deterministic synthetic geometry. It is exported so a local
 * Playwright run can capture repeatable before/after timings without adding a
 * hidden production UI or substituting a mock drawing implementation.
 */
export function benchmarkGfaCanvasRender(
  options: GfaCanvasBenchmarkOptions = {},
): GfaCanvasBenchmarkResult {
  if (typeof document === "undefined") {
    throw new Error("The GFA Canvas benchmark requires a browser document.");
  }
  const nodeCount = benchmarkPositiveInteger(options.nodeCount, 701);
  const edgeCount = benchmarkPositiveInteger(options.edgeCount, 870);
  const contactLinkCount = benchmarkPositiveInteger(options.contactLinkCount, 700);
  const iterations = benchmarkPositiveInteger(options.iterations, 40);
  const width = benchmarkPositiveInteger(options.width, 1_200);
  const height = benchmarkPositiveInteger(options.height, 700);
  const rowCount = Math.max(1, Math.min(12, Math.ceil(nodeCount / 100)));
  const groupIds = Array.from({ length: rowCount }, (_, index) => `Chr01g${index + 1}`);
  const homologs = classifyGfaScaffolds(groupIds);
  const columns = Math.ceil(nodeCount / rowCount);
  const nodes: LayoutNode[] = Array.from({ length: nodeCount }, (_, index) => {
    const row = index % rowCount;
    const column = Math.floor(index / rowCount);
    const id = `benchmark-utg-${index}`;
    const x = 168 + column * Math.max(7, 900 / Math.max(1, columns));
    const y = 52 + row * Math.max(38, 590 / Math.max(1, rowCount - 1));
    const scaffoldColor = homologScaffoldColor(0, row);
    return {
      id,
      occurrenceId: id,
      segmentName: id,
      groupId: groupIds[row],
      assemblyBlockId: `benchmark-block-${row}-${Math.floor(column / 8)}`,
      kind: "placed",
      orientation: index % 5 === 0 ? "-" : "+",
      length: 1_000_000,
      order: index,
      readDepth: null,
      x,
      y,
      anchorX: x,
      anchorY: y,
      width: 12,
      height: 14,
      scaffoldColor,
      homologColumn: "Chr01",
      guidedFocal: true,
      manuallyPlaced: false,
      layoutMode: "curation",
      pathPoints: [],
    };
  });
  const graphEdges: GfaGraphEdge[] = [];
  for (let index = 0; index < Math.min(edgeCount, Math.max(0, nodeCount - 1)); index += 1) {
    graphEdges.push({
      id: `benchmark-agp-${index}`,
      source: nodes[index].id,
      target: nodes[index + 1].id,
      kind: index % 11 === 0 ? "agp-gap" : "agp-joined",
    });
  }
  for (let index = graphEdges.length; index < edgeCount; index += 1) {
    const sourceIndex = index % nodeCount;
    const targetIndex = (sourceIndex + 17 + index % 31) % nodeCount;
    graphEdges.push({
      id: `benchmark-gfa-${index}`,
      source: nodes[sourceIndex].id,
      target: nodes[targetIndex].id,
      kind: "gfa-link",
      sourceSide: index % 2 === 0 ? "start" : "end",
      targetSide: index % 3 === 0 ? "end" : "start",
    });
  }
  const contactLinks: GfaEndpointHiCLink[] = Array.from(
    { length: contactLinkCount },
    (_, index) => {
      const sourceIndex = index % nodeCount;
      const targetIndex = (sourceIndex + 29 + index % 47) % nodeCount;
      return {
        id: `benchmark-contact-${index}`,
        source: nodes[sourceIndex].id,
        target: nodes[targetIndex].id,
        sourceEndpoint: index % 2 === 0 ? "left" : "right",
        targetEndpoint: index % 3 === 0 ? "right" : "left",
        sourceSide: index % 2 === 0 ? "start" : "end",
        targetSide: index % 3 === 0 ? "end" : "start",
        rawCount: contactLinkCount - index,
        normalizedCountPerMb2: contactLinkCount - index,
        overviewNormalizedCountPerMb2: contactLinkCount - index,
        contrastToNext: null,
        resolution: 10_000,
        overviewRank: index + 1,
        sourceEndpointRank: 1,
        targetEndpointRank: 1,
        lineWidth: 1.1 + 4.7 * Math.sqrt((contactLinkCount - index) / contactLinkCount),
      };
    },
  );
  const graph: GfaAssemblyGraph = {
    nodes,
    edges: graphEdges,
    groupOrder: groupIds,
    matchedSegmentCount: nodeCount,
    unmatchedSegmentCount: 0,
    ambiguousLinkCount: 0,
    truncated: false,
  };
  const canvas = document.createElement("canvas");
  canvas.style.position = "fixed";
  canvas.style.left = "-10000px";
  canvas.style.top = "0";
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  document.body.appendChild(canvas);
  const view: ViewTransform = { x: 0, y: 0, scale: 1 };
  const render = () => drawInteractiveGraph(
    canvas,
    nodes,
    graph,
    view,
    new Set<string>(),
    homologs,
    true,
    true,
    true,
    true,
    true,
    contactLinks,
    null,
  );
  try {
    for (let index = 0; index < 5; index += 1) {
      render();
    }
    const samples: number[] = [];
    for (let index = 0; index < iterations; index += 1) {
      const startedAt = performance.now();
      render();
      samples.push(performance.now() - startedAt);
    }
    samples.sort((left, right) => left - right);
    const meanMs = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    return {
      nodeCount,
      edgeCount,
      contactLinkCount,
      iterations,
      meanMs: roundBenchmarkMilliseconds(meanMs),
      p50Ms: roundBenchmarkMilliseconds(samples[Math.floor(samples.length * 0.5)]),
      p95Ms: roundBenchmarkMilliseconds(samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))]),
      maxMs: roundBenchmarkMilliseconds(samples[samples.length - 1]),
    };
  } finally {
    canvas.remove();
  }
}

function benchmarkPositiveInteger(value: number | undefined, fallback: number) {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function roundBenchmarkMilliseconds(value: number) {
  return Math.round(value * 1_000) / 1_000;
}

function drawChromosomeRowLabels(
  context: CanvasRenderingContext2D,
  nodes: LayoutNode[],
  displayScale: number,
  homologs: GfaHomologClassification,
) {
  const chromosomeScaffolds = homologScaffoldIds(homologs);
  const rows = gfaChromosomeRows(nodes, chromosomeScaffolds);
  context.save();
  context.fillStyle = "#334155";
  context.font = `650 ${Math.max(11, 8 / displayScale)}px Inter, system-ui, sans-serif`;
  context.textAlign = "right";
  context.textBaseline = "middle";
  for (const [label, values] of rows) {
    const rowY = values.reduce((sum, node) => sum + node.anchorY, 0) / values.length;
    context.fillText(label, 150, rowY);
  }
  const unplaced = nodes.filter((node) => !chromosomeScaffolds.has(node.groupId));
  if (unplaced.length > 0) {
    const minX = Math.min(...unplaced.map((node) => node.anchorX - node.width / 2));
    const minY = Math.min(...unplaced.map((node) => node.anchorY - node.height / 2));
    context.textAlign = "left";
    context.textBaseline = "bottom";
    context.fillStyle = "#64748b";
    context.fillText("Unanchored", minX, minY - 12);
  }
  context.restore();
}

interface EndpointHiCPathGeometry {
  source: GfaPathPoint;
  target: GfaPathPoint;
  control: GfaPathPoint;
  radius: number;
}

/**
 * Batch endpoint-contact curves into a small set of width buckets and fill all
 * endpoint dots in one path. The previous renderer issued one stroke and two
 * fills per link, which made overlay cost scale with thousands of Canvas state
 * transitions while the overlay was progressively loading.
 */
function drawEndpointHiCLinks(
  context: CanvasRenderingContext2D,
  nodesById: ReadonlyMap<string, LayoutNode>,
  links: ReadonlyArray<GfaEndpointHiCLink>,
  displayScale: number,
) {
  if (links.length === 0) {
    return;
  }
  const safeScale = Math.max(0.01, displayScale);
  const pathsByWidth = new Map<number, EndpointHiCPathGeometry[]>();
  for (const link of links) {
    const source = nodesById.get(link.source);
    const target = nodesById.get(link.target);
    if (!source || !target) {
      continue;
    }
    const sourcePoint = nodePort(source, link.sourceSide);
    const targetPoint = nodePort(target, link.targetSide);
    const widthBucket = Math.max(1, Math.round(link.lineWidth * 2) / 2);
    const geometries = pathsByWidth.get(widthBucket) ?? [];
    geometries.push({
      source: sourcePoint,
      target: targetPoint,
      control: gfaBandageControlPoint(
        sourcePoint,
        targetPoint,
        deterministicSign(link.id),
        0.18,
        16,
        92,
      ),
      radius: Math.max(1.8, Math.min(3.4, link.lineWidth * 0.58)) / safeScale,
    });
    pathsByWidth.set(widthBucket, geometries);
  }

  context.save();
  context.strokeStyle = "rgba(124, 58, 237, 0.46)";
  context.lineCap = "round";
  for (const [widthBucket, geometries] of pathsByWidth) {
    context.beginPath();
    for (const geometry of geometries) {
      context.moveTo(geometry.source.x, geometry.source.y);
      context.quadraticCurveTo(
        geometry.control.x,
        geometry.control.y,
        geometry.target.x,
        geometry.target.y,
      );
    }
    context.lineWidth = widthBucket / safeScale;
    context.stroke();
  }

  context.beginPath();
  for (const geometries of pathsByWidth.values()) {
    for (const geometry of geometries) {
      for (const point of [geometry.source, geometry.target]) {
        context.moveTo(point.x + geometry.radius, point.y);
        context.arc(point.x, point.y, geometry.radius, 0, Math.PI * 2);
      }
    }
  }
  context.fillStyle = "rgba(109, 40, 217, 0.82)";
  context.fill();
  context.restore();
}

function drawGraphEdge(
  context: CanvasRenderingContext2D,
  source: LayoutNode,
  target: LayoutNode,
  edge: GfaGraphEdge,
  displayScale: number,
  crossesAgpGap = false,
) {
  const isGfaLink = edge.kind === "gfa-link";
  const sourcePort = isGfaLink
    ? nodePortGeometry(source, edge.sourceSide ?? "end")
    : null;
  const targetPort = isGfaLink
    ? nodePortGeometry(target, edge.targetSide ?? "start")
    : null;
  const junction = sourcePort && targetPort
    ? { source: sourcePort.point, target: targetPort.point }
    : layoutAgpJunctionPoints(source, target);
  const sourcePoint = junction.source;
  const targetPoint = junction.target;
  context.save();
  context.beginPath();
  context.moveTo(sourcePoint.x, sourcePoint.y);
  if (isGfaLink && sourcePort && targetPort) {
    const curve = gfaSmoothLinkCurve(
      sourcePoint,
      targetPoint,
      sourcePort.outward,
      targetPort.outward,
      deterministicSign(edge.id),
    );
    context.bezierCurveTo(
      curve.sourceControl.x,
      curve.sourceControl.y,
      curve.midpointIn.x,
      curve.midpointIn.y,
      curve.midpoint.x,
      curve.midpoint.y,
    );
    context.bezierCurveTo(
      curve.midpointOut.x,
      curve.midpointOut.y,
      curve.targetControl.x,
      curve.targetControl.y,
      targetPoint.x,
      targetPoint.y,
    );
  } else {
    context.lineTo(targetPoint.x, targetPoint.y);
  }
  if (isGfaLink) {
    context.strokeStyle = crossesAgpGap
      ? "rgba(51, 65, 85, 0.9)"
      : "rgba(100, 116, 139, 0.48)";
    context.lineWidth = crossesAgpGap
      ? Math.max(1.8, 1 / displayScale)
      : Math.max(1.3, 0.75 / displayScale);
  } else {
    if (edge.kind === "agp-gap") {
      context.setLineDash([5, 4]);
      context.strokeStyle = "rgba(107, 114, 128, 0.8)";
      context.lineWidth = Math.max(2, 1.1 / displayScale);
    } else {
      context.strokeStyle = "rgba(17, 24, 39, 0.95)";
      context.lineWidth = Math.max(2.4, 1.25 / displayScale);
    }
  }
  context.stroke();
  context.restore();
}

function drawGraphNode(
  context: CanvasRenderingContext2D,
  node: LayoutNode,
  selected: boolean,
  displayScale: number,
) {
  if (node.layoutMode === "bandage" && node.pathPoints.length >= 2) {
    drawBandagePathNode(context, node, selected, displayScale);
    return;
  }
  context.save();
  context.translate(node.x, node.y);
  if (node.orientation === "-") {
    context.rotate(Math.PI);
  }
  const halfWidth = node.width / 2;
  const halfHeight = node.height / 2;
  context.beginPath();
  context.moveTo(-halfWidth, -halfHeight);
  context.lineTo(halfWidth - 7, -halfHeight);
  context.lineTo(halfWidth, 0);
  context.lineTo(halfWidth - 7, halfHeight);
  context.lineTo(-halfWidth, halfHeight);
  context.closePath();
  context.globalAlpha = node.layoutMode === "guided" && !node.guidedFocal
    ? 0.72
    : node.homologColumn === null ? 0.68 : 0.96;
  context.fillStyle = node.scaffoldColor;
  context.fill();
  context.globalAlpha = 1;
  context.strokeStyle = selected ? "#f59e0b" : darkenScaffoldColor(node.scaffoldColor);
  context.lineWidth = selected
    ? Math.max(3, 2 / displayScale)
    : Math.max(1.4, 0.9 / displayScale);
  context.stroke();
  context.restore();
  if (selected) {
    context.fillStyle = "#111827";
    context.font = "600 10px Inter, system-ui, sans-serif";
    context.textAlign = "center";
    context.fillText(node.segmentName, node.x, node.y - node.height / 2 - 6);
  }
}

function drawBandagePathNode(
  context: CanvasRenderingContext2D,
  node: LayoutNode,
  selected: boolean,
  displayScale: number,
) {
  const outlineColor = selected ? "#f59e0b" : darkenScaffoldColor(node.scaffoldColor);
  const outlineWidth = selected
    ? Math.max(4, 2.5 / displayScale)
    : Math.max(2, 1.2 / displayScale);
  const alpha = node.homologColumn === null ? 0.68 : 0.96;
  context.save();
  context.globalAlpha = alpha;
  context.lineCap = "butt";
  context.lineJoin = "round";
  traceSmoothBandagePath(context, node.pathPoints);
  context.strokeStyle = outlineColor;
  context.lineWidth = node.height + outlineWidth * 2;
  context.stroke();
  traceSmoothBandagePath(context, node.pathPoints);
  context.strokeStyle = node.scaffoldColor;
  context.lineWidth = node.height;
  context.stroke();
  drawBandageArrowHead(context, node, outlineColor, outlineWidth);
  context.restore();
  if (selected) {
    const bounds = visualNodeBounds(node);
    context.fillStyle = "#111827";
    context.font = "600 10px Inter, system-ui, sans-serif";
    context.textAlign = "center";
    context.fillText(node.segmentName, (bounds.left + bounds.right) / 2, bounds.top - 6);
  }
}

function traceSmoothBandagePath(
  context: CanvasRenderingContext2D,
  points: ReadonlyArray<GfaPathPoint>,
) {
  context.beginPath();
  context.moveTo(points[0].x, points[0].y);
  for (let index = 1; index < points.length - 1; index += 1) {
    const point = points[index];
    const next = points[index + 1];
    context.quadraticCurveTo(
      point.x,
      point.y,
      (point.x + next.x) / 2,
      (point.y + next.y) / 2,
    );
  }
  const last = points[points.length - 1];
  context.lineTo(last.x, last.y);
}

function drawBandageArrowHead(
  context: CanvasRenderingContext2D,
  node: LayoutNode,
  outlineColor: string,
  outlineWidth: number,
) {
  const points = node.pathPoints;
  const arrowAtStart = node.orientation === "-";
  const tip = arrowAtStart ? points[0] : points[points.length - 1];
  const neighbour = arrowAtStart ? points[1] : points[points.length - 2];
  const dx = tip.x - neighbour.x;
  const dy = tip.y - neighbour.y;
  const distance = Math.max(0.001, Math.hypot(dx, dy));
  const ux = dx / distance;
  const uy = dy / distance;
  const arrowLength = clamp(node.width * 0.1, 7, 11);
  const halfHeight = node.height / 2;
  const base = { x: tip.x - ux * arrowLength, y: tip.y - uy * arrowLength };
  context.beginPath();
  context.moveTo(tip.x, tip.y);
  context.lineTo(base.x - uy * halfHeight, base.y + ux * halfHeight);
  context.lineTo(base.x + uy * halfHeight, base.y - ux * halfHeight);
  context.closePath();
  context.fillStyle = node.scaffoldColor;
  context.fill();
  context.strokeStyle = outlineColor;
  context.lineWidth = outlineWidth;
  context.stroke();
}

function drawGraphPreview(
  canvas: HTMLCanvasElement,
  graph: GfaAssemblyGraph,
  homologs: GfaHomologClassification,
) {
  resizeCanvas(canvas);
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.width / ratio;
  const height = canvas.height / ratio;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#fafafa";
  context.fillRect(0, 0, width, height);
  if (graph.nodes.length === 0) {
    return;
  }
  const chromosomeScaffolds = homologScaffoldIds(homologs);
  const placements = gfaPreviewPlacements(graph, homologs, width, height);
  const previewPoint = (nodeId: string) => {
    const point = placements.get(nodeId)!;
    return {
      x: point.x,
      y: point.y,
    };
  };
  context.lineWidth = 0.7;
  for (const edge of graph.edges.slice(0, 2_500)) {
    if (!placements.has(edge.source) || !placements.has(edge.target)) {
      continue;
    }
    const source = previewPoint(edge.source);
    const target = previewPoint(edge.target);
    context.beginPath();
    context.moveTo(source.x, source.y);
    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const distance = Math.max(1, Math.hypot(dx, dy));
    const bend = Math.min(18, Math.max(3, distance * 0.08)) * deterministicSign(edge.id);
    context.quadraticCurveTo(
      (source.x + target.x) / 2 - dy / distance * bend,
      (source.y + target.y) / 2 + dx / distance * bend,
      target.x,
      target.y,
    );
    context.strokeStyle = edge.kind === "agp-joined"
      ? "rgba(17,24,39,0.72)"
      : edge.kind === "agp-gap"
        ? "rgba(107,114,128,0.45)"
        : "rgba(37,99,235,0.16)";
    context.stroke();
  }
  for (const node of graph.nodes) {
    const placement = placements.get(node.id);
    if (!placement) {
      continue;
    }
    const point = previewPoint(node.id);
    context.fillStyle = chromosomeScaffolds.has(node.groupId)
      ? defaultAssemblyScaffoldColor(node.groupId, graph.groupOrder.indexOf(node.groupId))
      : "#94a3b8";
    context.fillRect(point.x - placement.width / 2, point.y - 1.5, placement.width, 3);
  }
}

interface GfaPreviewPlacement {
  x: number;
  y: number;
  width: number;
}

/**
 * Project the curation graph into a compact preview. Chromosome lanes use the
 * full preview height while linked unanchors receive a separate right-hand
 * zone, so a long graph cannot collapse every chromosome into the top-left.
 */
export function gfaPreviewPlacements(
  graph: GfaAssemblyGraph,
  homologs: GfaHomologClassification,
  width: number,
  height: number,
) {
  const positions = layoutGfaNodesForCuration(graph.nodes, graph.edges, homologs);
  const nodeWidths = gfaCurationNodeWidths(graph.nodes);
  const chromosomeScaffolds = homologScaffoldIds(homologs);
  const positionedNodes = graph.nodes.filter((node) => positions.has(node.id));
  const anchoredNodes = positionedNodes.filter((node) => chromosomeScaffolds.has(node.groupId));
  const unanchoredNodes = positionedNodes.filter((node) => !chromosomeScaffolds.has(node.groupId));
  const paddingX = Math.min(10, Math.max(4, width * 0.035));
  const paddingY = Math.min(12, Math.max(4, height * 0.08));
  const hasBothZones = anchoredNodes.length > 0 && unanchoredNodes.length > 0;
  const anchoredRange = {
    left: paddingX,
    right: hasBothZones ? Math.max(paddingX + 1, width * 0.72) : width - paddingX,
  };
  const unanchoredRange = {
    left: hasBothZones ? Math.min(width - paddingX - 1, width * 0.78) : paddingX,
    right: width - paddingX,
  };

  function horizontalProjection(
    nodes: GfaGraphNode[],
    range: { left: number; right: number },
  ) {
    if (nodes.length === 0) {
      return new Map<string, { x: number; width: number }>();
    }
    const minX = Math.min(...nodes.map((node) => (
      positions.get(node.id)!.x - (nodeWidths.get(node.id) ?? 12) / 2
    )));
    const maxX = Math.max(...nodes.map((node) => (
      positions.get(node.id)!.x + (nodeWidths.get(node.id) ?? 12) / 2
    )));
    const scale = (range.right - range.left) / Math.max(1, maxX - minX);
    return new Map(nodes.map((node) => {
      const point = positions.get(node.id)!;
      return [node.id, {
        x: range.left + (point.x - minX) * scale,
        width: Math.max(2, (nodeWidths.get(node.id) ?? 12) * scale),
      }];
    }));
  }

  const horizontal = new Map([
    ...horizontalProjection(anchoredNodes, anchoredRange),
    ...horizontalProjection(unanchoredNodes, unanchoredRange),
  ]);
  const visibleScaffoldOrder = homologs.columns
    .flatMap((column) => column.scaffolds.map((scaffold) => scaffold.id))
    .filter((scaffoldId) => anchoredNodes.some((node) => node.groupId === scaffoldId));
  const scaffoldLane = new Map(visibleScaffoldOrder.map((id, index) => [id, index]));
  const laneY = (index: number, count: number) => count <= 1
    ? height / 2
    : paddingY + index * (height - 2 * paddingY) / (count - 1);
  const unanchoredYValues = unanchoredNodes.map((node) => positions.get(node.id)!.y);
  const minUnanchoredY = unanchoredYValues.length ? Math.min(...unanchoredYValues) : 0;
  const maxUnanchoredY = unanchoredYValues.length ? Math.max(...unanchoredYValues) : 0;
  const placements = new Map<string, GfaPreviewPlacement>();
  for (const node of positionedNodes) {
    const projected = horizontal.get(node.id);
    if (!projected) {
      continue;
    }
    const laneIndex = scaffoldLane.get(node.groupId);
    const y = laneIndex !== undefined
      ? laneY(laneIndex, visibleScaffoldOrder.length)
      : minUnanchoredY === maxUnanchoredY
        ? height / 2
        : paddingY + (positions.get(node.id)!.y - minUnanchoredY)
          / (maxUnanchoredY - minUnanchoredY) * (height - 2 * paddingY);
    placements.set(node.id, { ...projected, y });
  }
  return placements;
}

function nodePort(node: LayoutNode, side: GfaSegmentSide) {
  return nodePortGeometry(node, side).point;
}

function nodePortGeometry(node: LayoutNode, side: GfaSegmentSide) {
  if (node.layoutMode === "bandage" && node.pathPoints.length >= 2) {
    return gfaBandagePathPortGeometry(node.pathPoints, node.orientation, side)!;
  }
  const visualSide = node.orientation === "-"
    ? side === "start" ? "end" : "start"
    : side;
  return {
    point: {
      x: node.x + (visualSide === "start" ? -node.width / 2 : node.width / 2),
      y: node.y,
    },
    outward: { x: visualSide === "start" ? -1 : 1, y: 0 },
  };
}

function layoutAgpJunctionPoints(source: LayoutNode, target: LayoutNode) {
  if (
    source.layoutMode !== "bandage"
    || target.layoutMode !== "bandage"
    || source.pathPoints.length < 2
    || target.pathPoints.length < 2
  ) {
    return gfaAgpJunctionPoints(source, target);
  }
  return gfaAgpBandageJunctionPoints(source.pathPoints, target.pathPoints)
    ?? gfaAgpJunctionPoints(source, target);
}

function graphPointFromPointer(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
  view: ViewTransform,
) {
  const bounds = canvas.getBoundingClientRect();
  return {
    x: (clientX - bounds.left - view.x) / view.scale,
    y: (clientY - bounds.top - view.y) / view.scale,
  };
}

function nodeAtPoint(nodes: LayoutNode[], x: number, y: number) {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (
      node.layoutMode === "bandage"
      && gfaBandagePathContainsPoint(node.pathPoints, { x, y }, node.height / 2 + 6)
    ) {
      return node;
    }
    if (
      node.layoutMode !== "bandage"
      && Math.abs(x - node.x) <= node.width / 2 + 4
      && Math.abs(y - node.y) <= node.height / 2 + 6
    ) {
      return node;
    }
  }
  return null;
}

export function gfaBandagePathContainsPoint(
  pathPoints: ReadonlyArray<GfaPathPoint>,
  point: GfaPathPoint,
  radius: number,
) {
  for (let index = 1; index < pathPoints.length; index += 1) {
    if (distanceToSegment(point, pathPoints[index - 1], pathPoints[index]) <= radius) {
      return true;
    }
  }
  return false;
}

function closestBandageControlPointIndex(
  pathPoints: ReadonlyArray<GfaPathPoint>,
  point: GfaPathPoint,
) {
  let nearestIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < pathPoints.length; index += 1) {
    const distance = Math.hypot(point.x - pathPoints[index].x, point.y - pathPoints[index].y);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  }
  return nearestIndex;
}

function distanceToSegment(point: GfaPathPoint, start: GfaPathPoint, end: GfaPathPoint) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= Number.EPSILON) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }
  const projection = clamp(
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared,
    0,
    1,
  );
  return Math.hypot(
    point.x - (start.x + projection * dx),
    point.y - (start.y + projection * dy),
  );
}

function resizeCanvas(canvas: HTMLCanvasElement) {
  const bounds = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(bounds.width * ratio));
  const height = Math.max(1, Math.round(bounds.height * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}

function deterministicJitter(value: string, salt: number) {
  let hash = salt;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return ((Math.abs(hash) % 1_000) / 1_000 - 0.5) * 22;
}

function darkenScaffoldColor(color: string) {
  const hsl = /^hsl\((\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%\)$/.exec(color);
  if (hsl) {
    const saturation = Math.min(82, Number(hsl[2]) + 8);
    const lightness = Math.max(25, Number(hsl[3]) - 20);
    return `hsl(${hsl[1]} ${saturation}% ${lightness}%)`;
  }
  return color === "#94a3b8" || color === "#64748b" ? "#475569" : color;
}

function deterministicSign(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return hash % 2 === 0 ? 1 : -1;
}

function unorderedNodePair(left: string, right: string) {
  return left < right ? `${left}\u0000${right}` : `${right}\u0000${left}`;
}

function layoutModeFromNodes(nodes: LayoutNode[]): GfaLayoutMode {
  return nodes[0]?.layoutMode ?? "curation";
}

function copyPathPoint(point: GfaPathPoint): GfaPathPoint {
  return { x: point.x, y: point.y };
}

function bandagePathCenter(pathPoints: ReadonlyArray<GfaPathPoint>) {
  if (pathPoints.length === 0) {
    return { x: 0, y: 0 };
  }
  return {
    x: pathPoints.reduce((sum, point) => sum + point.x, 0) / pathPoints.length,
    y: pathPoints.reduce((sum, point) => sum + point.y, 0) / pathPoints.length,
  };
}

function updateNodeCenterFromPath(node: LayoutNode) {
  const center = bandagePathCenter(node.pathPoints);
  node.x = center.x;
  node.y = center.y;
}

function rememberBandagePaths(
  state: Map<string, GfaPathPoint[]>,
  nodes: ReadonlyArray<LayoutNode>,
  nodeIds?: ReadonlySet<string>,
) {
  for (const node of nodes) {
    if (
      node.layoutMode === "bandage"
      && node.pathPoints.length >= 2
      && (!nodeIds || nodeIds.has(node.id))
    ) {
      state.set(node.id, node.pathPoints.map(copyPathPoint));
    }
  }
}

function visualNodeBounds(node: LayoutNode) {
  return visualBoundsForNodeData(node);
}

function visualBoundsForNodeData(node: {
  x: number;
  y: number;
  width: number;
  height: number;
  pathPoints?: ReadonlyArray<GfaPathPoint>;
}) {
  const padding = node.height / 2;
  if (node.pathPoints && node.pathPoints.length >= 2) {
    return {
      left: Math.min(...node.pathPoints.map((point) => point.x)) - padding,
      right: Math.max(...node.pathPoints.map((point) => point.x)) + padding,
      top: Math.min(...node.pathPoints.map((point) => point.y)) - padding,
      bottom: Math.max(...node.pathPoints.map((point) => point.y)) + padding,
    };
  }
  return {
    left: node.x - node.width / 2,
    right: node.x + node.width / 2,
    top: node.y - node.height / 2,
    bottom: node.y + node.height / 2,
  };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
