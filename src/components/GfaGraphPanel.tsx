import { ChevronDown, Maximize2, RotateCcw, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ContactMapLayoutBlock } from "../state/importers";
import {
  defaultAssemblyScaffoldColor,
  homologScaffoldColor,
  unplacedAssemblyColor,
} from "../state/assemblyPalette";
import {
  buildGfaAssemblyGraph,
  type GfaAssemblyGraph,
  type GfaEvidenceDocument,
  type GfaGraphEdge,
  type GfaGraphNode,
  type GfaSegmentSide,
} from "../state/gfa";
import {
  classifyGfaScaffolds,
  gfaBandageControlPoint,
  gfaBandageNodeWidths,
  gfaCurationNodeWidths,
  gfaLinkScope,
  layoutGfaNodesBandage,
  layoutGfaNodesForCuration,
  type GfaLayoutMode,
  type GfaHomologClassification,
} from "../state/gfaHomologLayout";

interface GfaPreviewCardProps {
  document: GfaEvidenceDocument;
  assemblyBlocks: ContactMapLayoutBlock[];
  homologPattern: string;
  onExpand: () => void;
  embedded?: boolean;
  visibleScaffoldIds?: ReadonlySet<string>;
}

interface GfaGraphPanelProps {
  document: GfaEvidenceDocument;
  assemblyBlocks: ContactMapLayoutBlock[];
  selectedAssemblyBlockIds: string[];
  homologPattern: string;
  visibleScaffoldIds: ReadonlySet<string>;
  visibleContigIds: ReadonlySet<string>;
  onRestoreHeatmap?: () => void;
  onClose: () => void;
  onSelectOccurrences: (ids: string[]) => void;
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
  manuallyPlaced: boolean;
  layoutMode: GfaLayoutMode;
}

interface ViewTransform {
  x: number;
  y: number;
  scale: number;
}

interface GraphInteraction {
  pointerId: number;
  kind: "node" | "pan" | "selection";
  nodeId?: string;
  draggedNodes?: Array<{ id: string; x: number; y: number }>;
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

/** GFA editing is block-based even when a node is an individually selectable source segment. */
export function gfaAssemblyUnitId(
  node: Pick<GfaGraphNode, "occurrenceId" | "assemblyBlockId">,
) {
  return node.assemblyBlockId || node.occurrenceId;
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
    const nodeLeft = node.x - node.width / 2;
    const nodeRight = node.x + node.width / 2;
    const nodeTop = node.y - node.height / 2;
    const nodeBottom = node.y + node.height / 2;
    if (nodeRight >= left && nodeLeft <= right && nodeBottom >= top && nodeTop <= bottom) {
      ids.add(unitId);
    }
  }
  return [...ids];
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
 * AGP junctions describe adjacency in the edited chromosome layout, not GFA
 * segment sides. Always connect the two node faces that point at one another;
 * component orientation only changes the arrow shape inside those positions.
 */
export function gfaAgpJunctionPoints(
  source: { x: number; y: number; width: number },
  target: { x: number; y: number; width: number },
) {
  const sourceIsLeft = source.x <= target.x;
  return {
    source: {
      x: source.x + (sourceIsLeft ? source.width / 2 : -source.width / 2),
      y: source.y,
    },
    target: {
      x: target.x + (sourceIsLeft ? -target.width / 2 : target.width / 2),
      y: target.y,
    },
  };
}

export function GfaPreviewCard({
  document,
  assemblyBlocks,
  homologPattern,
  onExpand,
  embedded = false,
  visibleScaffoldIds = new Set<string>(),
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
      graphForVisibleHomologScaffolds(fullGraph, visibleScaffoldIds, homologs, false),
      false,
    ),
    [fullGraph, homologs, visibleScaffoldIds],
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
  selectedAssemblyBlockIds,
  homologPattern,
  visibleScaffoldIds,
  visibleContigIds,
  onRestoreHeatmap,
  onClose,
  onSelectOccurrences,
}: GfaGraphPanelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nodesRef = useRef<LayoutNode[]>([]);
  const graphRef = useRef<GfaAssemblyGraph | null>(null);
  const viewRef = useRef<ViewTransform>({ ...defaultView });
  const interactionRef = useRef<GraphInteraction | null>(null);
  const selectionBoxRef = useRef<GfaSelectionBox | null>(null);
  const fitViewPendingRef = useRef(true);
  const [layoutRevision, setLayoutRevision] = useState(0);
  const [layoutMode, setLayoutMode] = useState<GfaLayoutMode>("curation");
  const [showGfaOnlyNodes, setShowGfaOnlyNodes] = useState(false);
  const [showDisconnectedNodes, setShowDisconnectedNodes] = useState(false);
  const [showHomologLinks, setShowHomologLinks] = useState(true);
  const [showNonHomologLinks, setShowNonHomologLinks] = useState(true);
  const [toolbarDetailsOpen, setToolbarDetailsOpen] = useState(false);
  const visibleScaffoldKey = [...visibleScaffoldIds].sort().join("\u0000");
  const visibleContigKey = [...visibleContigIds].sort().join("\u0000");
  const graph = useMemo(
    () => buildGfaAssemblyGraph(document, assemblyBlocks, graphNodeLimit),
    [assemblyBlocks, document],
  );
  const selectedIdsRef = useRef(new Set(selectedAssemblyBlockIds));
  selectedIdsRef.current = new Set(selectedAssemblyBlockIds);
  const homologs = useMemo(
    () => classifyGfaScaffolds(graph.groupOrder, homologPattern),
    [graph.groupOrder, homologPattern],
  );
  const visibleGraphWithGfaOnlyNodes = useMemo(
    () => graphForVisibleHomologScaffolds(
      graph,
      visibleScaffoldIds,
      homologs,
      showDisconnectedNodes,
    ),
    [graph, homologs, showDisconnectedNodes, visibleScaffoldKey],
  );
  const visibleBandageGraphWithGfaOnlyNodes = useMemo(
    () => graphForVisibleContigs(graph, visibleContigIds),
    [graph, visibleContigKey],
  );
  const visibleConnectedBandageGraphWithGfaOnlyNodes = useMemo(
    () => graphForChromosomeConnectionVisibility(
      visibleBandageGraphWithGfaOnlyNodes,
      graph,
      homologs,
      showDisconnectedNodes,
    ),
    [graph, homologs, showDisconnectedNodes, visibleBandageGraphWithGfaOnlyNodes],
  );
  const visibleGraph = useMemo(
    () => graphForGfaOnlyNodeVisibility(visibleGraphWithGfaOnlyNodes, showGfaOnlyNodes),
    [showGfaOnlyNodes, visibleGraphWithGfaOnlyNodes],
  );
  const visibleBandageGraph = useMemo(
    () => graphForGfaOnlyNodeVisibility(
      visibleConnectedBandageGraphWithGfaOnlyNodes,
      showGfaOnlyNodes,
    ),
    [showGfaOnlyNodes, visibleConnectedBandageGraphWithGfaOnlyNodes],
  );

  useEffect(() => {
    const firstLayout = nodesRef.current.length === 0;
    graphRef.current = layoutMode === "curation" ? visibleGraph : visibleBandageGraph;
    if (homologs.error && layoutMode === "curation") {
      return;
    }
    nodesRef.current = initializeLayoutNodes(
      layoutMode === "curation" ? visibleGraph : visibleBandageGraph,
      homologs,
      nodesRef.current,
      layoutMode,
      graph,
    );
    if (firstLayout) {
      fitViewPendingRef.current = true;
    }
  }, [graph, homologs, layoutMode, layoutRevision, visibleGraph, visibleBandageGraph]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) {
      drawCurrentGraph(canvas, graphRef.current, nodesRef.current, viewRef.current, selectedIdsRef.current, fitViewPendingRef, homologs, showHomologLinks, showNonHomologLinks, selectionBoxRef.current);
    }
  }, [homologs, selectedAssemblyBlockIds, showHomologLinks, showNonHomologLinks]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const draw = () => drawCurrentGraph(canvas, graphRef.current, nodesRef.current, viewRef.current, selectedIdsRef.current, fitViewPendingRef, homologs, showHomologLinks, showNonHomologLinks, selectionBoxRef.current);
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => {
      observer.disconnect();
    };
  }, [graph, homologs, layoutMode, layoutRevision, showHomologLinks, showNonHomologLinks]);

  function switchLayoutMode(mode: GfaLayoutMode) {
    if (mode === layoutMode) {
      return;
    }
    nodesRef.current = [];
    fitViewPendingRef.current = true;
    setLayoutMode(mode);
  }

  function resetLayout() {
    if (homologs.error && layoutMode === "curation") {
      return;
    }
    nodesRef.current = [];
    fitViewPendingRef.current = true;
    setLayoutRevision((revision) => revision + 1);
  }

  function toggleGfaOnlyNodes() {
    nodesRef.current = [];
    fitViewPendingRef.current = true;
    setShowGfaOnlyNodes((visible) => !visible);
  }

  function toggleDisconnectedNodes() {
    nodesRef.current = [];
    fitViewPendingRef.current = true;
    setShowDisconnectedNodes((visible) => !visible);
  }

  function pointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    const canvas = event.currentTarget;
    const point = graphPointFromPointer(canvas, event.clientX, event.clientY, viewRef.current);
    const node = nodeAtPoint(nodesRef.current, point.x, point.y);
    const rigidNodeIds = node
      ? new Set(gfaRigidBlockNodeIds(nodesRef.current, node.id))
      : new Set<string>();
    interactionRef.current = {
      pointerId: event.pointerId,
      kind: event.shiftKey ? "selection" : node ? "node" : "pan",
      nodeId: event.shiftKey ? undefined : node?.id,
      draggedNodes: node && !event.shiftKey
        ? nodesRef.current
          .filter((candidate) => rigidNodeIds.has(candidate.id))
          .map((candidate) => ({ id: candidate.id, x: candidate.x, y: candidate.y }))
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
      drawCurrentGraph(canvas, graphRef.current, nodesRef.current, viewRef.current, selectedIdsRef.current, fitViewPendingRef, homologs, showHomologLinks, showNonHomologLinks, selectionBoxRef.current);
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
      drawCurrentGraph(event.currentTarget, graphRef.current, nodesRef.current, viewRef.current, selectedIdsRef.current, fitViewPendingRef, homologs, showHomologLinks, showNonHomologLinks, selectionBoxRef.current);
      return;
    }
    if (interaction.kind === "pan") {
      viewRef.current.x = interaction.startViewX + deltaX;
      viewRef.current.y = interaction.startViewY + deltaY;
      drawCurrentGraph(event.currentTarget, graphRef.current, nodesRef.current, viewRef.current, selectedIdsRef.current, fitViewPendingRef, homologs, showHomologLinks, showNonHomologLinks);
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
      const startsById = new Map(interaction.draggedNodes.map((node) => [node.id, node]));
      for (const node of nodesRef.current) {
        const start = startsById.get(node.id);
        if (start) {
          node.x = start.x + graphDeltaX;
          node.y = start.y + graphDeltaY;
        }
      }
      drawCurrentGraph(event.currentTarget, graphRef.current, nodesRef.current, viewRef.current, selectedIdsRef.current, fitViewPendingRef, homologs, showHomologLinks, showNonHomologLinks);
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
        onSelectOccurrences(gfaAssemblyUnitIdsInSelection(
          nodesRef.current,
          { x: box.startX, y: box.startY },
          { x: box.currentX, y: box.currentY },
        ));
      } else {
        const point = graphPointFromPointer(event.currentTarget, event.clientX, event.clientY, viewRef.current);
        const node = nodeAtPoint(nodesRef.current, point.x, point.y);
        const unitId = node ? gfaAssemblyUnitId(node) : null;
        if (unitId) {
          onSelectOccurrences([unitId]);
        } else {
          onSelectOccurrences([]);
        }
      }
      selectionBoxRef.current = null;
      event.currentTarget.classList.remove("gfa-selecting");
      drawCurrentGraph(event.currentTarget, graphRef.current, nodesRef.current, viewRef.current, selectedIdsRef.current, fitViewPendingRef, homologs, showHomologLinks, showNonHomologLinks);
    } else if (interaction.kind === "node" && interaction.nodeId) {
      const node = nodesRef.current.find((candidate) => candidate.id === interaction.nodeId);
      const unitId = node ? gfaAssemblyUnitId(node) : null;
      if (!interaction.moved && unitId) {
        onSelectOccurrences([unitId]);
      }
      if (interaction.moved) {
        const draggedIds = new Set(interaction.draggedNodes?.map((dragged) => dragged.id));
        for (const candidate of nodesRef.current) {
          if (draggedIds.has(candidate.id)) {
            candidate.manuallyPlaced = true;
          }
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
    if (interaction.kind === "node" && interaction.draggedNodes) {
      const startsById = new Map(interaction.draggedNodes.map((node) => [node.id, node]));
      for (const node of nodesRef.current) {
        const start = startsById.get(node.id);
        if (start) {
          node.x = start.x;
          node.y = start.y;
        }
      }
    }
    selectionBoxRef.current = null;
    interactionRef.current = null;
    event.currentTarget.classList.remove("gfa-selecting");
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    drawCurrentGraph(event.currentTarget, graphRef.current, nodesRef.current, viewRef.current, selectedIdsRef.current, fitViewPendingRef, homologs, showHomologLinks, showNonHomologLinks);
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
    drawCurrentGraph(canvas, graphRef.current, nodesRef.current, viewRef.current, selectedIdsRef.current, fitViewPendingRef, homologs, showHomologLinks, showNonHomologLinks);
  }

  return (
    <section className="gfa-graph-panel" aria-label="GFA assembly graph">
      <header className={`gfa-graph-toolbar${toolbarDetailsOpen ? " details-open" : ""}`}>
        <div className="gfa-toolbar-primary">
          <span className="gfa-toolbar-title">
            <strong>GFA Assembly Graph</strong>
            <small>
              {(layoutMode === "curation" ? visibleGraph.nodes.length : visibleBandageGraph.nodes.length).toLocaleString()} nodes · {(layoutMode === "curation" ? visibleGraph.edges.length : visibleBandageGraph.edges.length).toLocaleString()} visible relations
              {graph.ambiguousLinkCount ? ` · ${graph.ambiguousLinkCount.toLocaleString()} ambiguous links hidden` : ""}
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
                aria-pressed={layoutMode === "bandage"}
                title="Arrange blocks by graph topology while preserving AGP order inside each block"
                onClick={() => switchLayoutMode("bandage")}
              >Bandage</button>
            </div>
            <span className="gfa-toolbar-divider" aria-hidden="true" />
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
              aria-label="Show non-AGP unitigs"
              aria-pressed={showGfaOnlyNodes}
              title="Show or hide GFA unitigs that do not occur in the current AGP"
              onClick={toggleGfaOnlyNodes}
            >Non-AGP utgs</button>
            <button
              type="button"
              className="gfa-link-toggle"
              aria-label="Show nodes disconnected from chromosome groups"
              aria-pressed={showDisconnectedNodes}
              title="Show or hide components with no GFA-link path to the displayed chromosome group"
              onClick={toggleDisconnectedNodes}
            >Disconnected</button>
          </div>
          <div className="gfa-toolbar-link-filters" role="group" aria-label="GFA link visibility">
            <span className="gfa-toolbar-section-label">Show links</span>
            <button
              type="button"
              className="gfa-link-toggle"
              aria-label="Toggle links between homologous chromosomes"
              aria-pressed={showHomologLinks}
              title="Show or hide GFA links between homologous chromosome members"
              onClick={() => setShowHomologLinks((visible) => !visible)}
            >Homolog</button>
            <button
              type="button"
              className="gfa-link-toggle"
              aria-label="Toggle links between non-homologous chromosomes"
              aria-pressed={showNonHomologLinks}
              title="Show or hide GFA links between non-homologous chromosomes and unplaced unitigs"
              onClick={() => setShowNonHomologLinks((visible) => !visible)}
            >Non-homolog</button>
          </div>
          <div className="gfa-toolbar-legend" aria-label="GFA graph line legend">
            <span className="gfa-toolbar-section-label">Lines</span>
            <span className="gfa-legend"><i className="joined" />Joined</span>
            <span className="gfa-legend"><i className="gap" />AGP gap</span>
            <span className="gfa-legend"><i className="link" />GFA link</span>
            <span className="gfa-legend"><i className="gap-link" />GFA across gap</span>
          </div>
        </div> : null}
      </header>
      <div className="gfa-canvas-frame">
        <canvas
          ref={canvasRef}
          className="gfa-graph-canvas"
          aria-label="Interactive GFA curation graph; drag a unitig to move its whole block, Shift-drag to select multiple blocks, drag empty space to pan, and scroll to zoom"
          onPointerDown={pointerDown}
          onPointerMove={pointerMove}
          onPointerUp={pointerUp}
          onPointerCancel={pointerCancel}
          onWheel={zoom}
        />
      </div>
    </section>
  );
}

export function graphForVisibleHomologScaffolds(
  graph: GfaAssemblyGraph,
  visibleScaffoldIds: ReadonlySet<string>,
  homologs: GfaHomologClassification,
  includeDisconnected = true,
): GfaAssemblyGraph {
  const regexMatchedScaffolds = homologScaffoldIds(homologs);
  const requestedScaffolds = new Set(
    [...visibleScaffoldIds].filter((id) => regexMatchedScaffolds.has(id)),
  );
  const displayedScaffolds = requestedScaffolds.size > 0
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

function homologScaffoldIds(homologs: GfaHomologClassification) {
  return new Set(
    homologs.columns.flatMap((column) => column.scaffolds.map((scaffold) => scaffold.id)),
  );
}

function graphForVisibleContigs(
  graph: GfaAssemblyGraph,
  visibleContigIds: ReadonlySet<string>,
): GfaAssemblyGraph {
  if (visibleContigIds.size === 0) {
    return graph;
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
  const nodeMinX = Math.min(...fitNodes.map((node) => node.x - node.width / 2)) - 28;
  // Curation rows have right-aligned chromosome labels at x=150. Include
  // their full text gutter in automatic framing instead of clipping "Chr".
  const minX = chromosomeNodes.length > 0 ? Math.min(-220, nodeMinX) : nodeMinX;
  const maxX = Math.max(...fitNodes.map((node) => node.x + node.width / 2)) + 28;
  const minY = Math.min(...fitNodes.map((node) => node.y - node.height / 2)) - 28;
  const maxY = Math.max(...fitNodes.map((node) => node.y + node.height / 2)) + 72;
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
  showHomologLinks: boolean,
  showNonHomologLinks: boolean,
  selectionBox: GfaSelectionBox | null = null,
) {
  if (!graph) {
    return;
  }
  if (fitPending.current && fitViewToNodes(canvas, nodes, view, layoutModeFromNodes(nodes))) {
    fitPending.current = false;
  }
  drawInteractiveGraph(canvas, nodes, graph, view, selectedIds, homologs, showHomologLinks, showNonHomologLinks, selectionBox);
}

function initializeLayoutNodes(
  graph: GfaAssemblyGraph,
  homologs: GfaHomologClassification,
  previous: LayoutNode[],
  layoutMode: GfaLayoutMode,
  evidenceGraph: GfaAssemblyGraph = graph,
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
  const positions = layoutMode === "bandage"
    ? layoutGfaNodesBandage(graph.nodes, graph.edges)
    : layoutGfaNodesForCuration(
      graph.nodes,
      graph.edges,
      homologs,
      evidenceGraph.nodes,
      evidenceGraph.edges,
    );
  const bandageWidths = layoutMode === "bandage"
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
      output.push({
        ...node,
        x: existing?.manuallyPlaced ? existing.x : targetX,
        y: existing?.manuallyPlaced ? existing.y : targetY,
        anchorX: targetX,
        anchorY: targetY,
        width: layoutMode === "bandage"
          ? bandageWidths.get(node.id) ?? 18
          : curationWidths.get(node.id) ?? 12,
        height: 14,
        scaffoldColor: homologByScaffold.has(node.groupId)
          ? homologScaffoldColor(
            homologPaletteByScaffold.get(node.groupId)?.columnIndex ?? 0,
            homologPaletteByScaffold.get(node.groupId)?.memberIndex ?? 0,
          )
          : unplacedAssemblyColor,
        homologColumn: homologByScaffold.get(node.groupId) ?? null,
        manuallyPlaced: existing?.manuallyPlaced ?? false,
        layoutMode,
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
  showHomologLinks: boolean,
  showNonHomologLinks: boolean,
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
  const agpGapPairs = new Set(
    graph.edges
      .filter((edge) => edge.kind === "agp-gap")
      .map((edge) => unorderedNodePair(edge.source, edge.target)),
  );

  if (layoutModeFromNodes(nodes) === "curation") {
    drawChromosomeRowLabels(context, nodes, view.scale, homologs);
  }
  for (const edge of graph.edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    const scope = source && target && edge.kind === "gfa-link"
      ? gfaLinkScope(source.groupId, target.groupId, homologs)
      : "within-scaffold";
    const visible = scope === "within-scaffold"
      || (scope === "homolog" ? showHomologLinks : showNonHomologLinks);
    if (source && target && visible) {
      drawGraphEdge(
        context,
        source,
        target,
        edge,
        view.scale,
        edge.kind === "gfa-link"
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
      selectedIds.has(node.id)
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

function drawChromosomeRowLabels(
  context: CanvasRenderingContext2D,
  nodes: LayoutNode[],
  displayScale: number,
  homologs: GfaHomologClassification,
) {
  const chromosomeScaffolds = homologScaffoldIds(homologs);
  const rows = new Map<string, LayoutNode[]>();
  for (const node of nodes) {
    if (!chromosomeScaffolds.has(node.groupId)) {
      continue;
    }
    const values = rows.get(node.groupId) ?? [];
    values.push(node);
    rows.set(node.groupId, values);
  }
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

function drawGraphEdge(
  context: CanvasRenderingContext2D,
  source: LayoutNode,
  target: LayoutNode,
  edge: GfaGraphEdge,
  displayScale: number,
  crossesAgpGap = false,
) {
  const isGfaLink = edge.kind === "gfa-link";
  const junction = isGfaLink
    ? {
      source: nodePort(source, edge.sourceSide ?? "end"),
      target: nodePort(target, edge.targetSide ?? "start"),
    }
    : gfaAgpJunctionPoints(source, target);
  const sourcePoint = junction.source;
  const targetPoint = junction.target;
  context.save();
  context.beginPath();
  context.moveTo(sourcePoint.x, sourcePoint.y);
  if (isGfaLink) {
    const control = gfaBandageControlPoint(
      sourcePoint,
      targetPoint,
      deterministicSign(edge.id),
      0.2,
      18,
      96,
    );
    context.quadraticCurveTo(control.x, control.y, targetPoint.x, targetPoint.y);
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
  context.globalAlpha = node.homologColumn === null ? 0.68 : 0.96;
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
  const visualSide = node.orientation === "-"
    ? side === "start" ? "end" : "start"
    : side;
  return {
    x: node.x + (visualSide === "start" ? -node.width / 2 : node.width / 2),
    y: node.y,
  };
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
    if (Math.abs(x - node.x) <= node.width / 2 + 4 && Math.abs(y - node.y) <= node.height / 2 + 6) {
      return node;
    }
  }
  return null;
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

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
