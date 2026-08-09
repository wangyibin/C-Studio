import { useEffect, useRef, useState } from "react";
import type { AppStatus, ContactMapView, ExampleDatasetSummary } from "../App";
import { contactColorCss } from "../state/contactColor";
import { estimateContactColorScale, normalizeContactValue, type ContactColorScale } from "../state/contactColorScale";
import { groupAssemblyBlocksByChromosome } from "../state/assemblyEditing";
import { SyntenyDotplot } from "./SyntenyDotplot";
import type { SyntenyView } from "../state/syntenyView";
import type { UiAction, UiState } from "../state/uiState";

interface InspectorPanelProps {
  dataset: ExampleDatasetSummary | null;
  contactMap: ContactMapView | null;
  overviewContactMap: ContactMapView | null;
  status: AppStatus;
  statusMessage: string;
  uiState: UiState;
  onUiAction: (action: UiAction) => void;
  syntenyView: SyntenyView | null;
  pafText: string;
  onPafTextChange: (value: string) => void;
}

export function InspectorPanel({
  dataset,
  contactMap,
  overviewContactMap,
  status,
  statusMessage,
  uiState,
  onUiAction,
  syntenyView,
  pafText,
  onPafTextChange,
}: InspectorPanelProps) {
  return (
    <aside className="inspector" aria-label="Inspector">
      <section className="overview-panel inspector-overview">
        <div className="panel-tabs compact-tabs" role="tablist" aria-label="Overview mode">
          <button
            type="button"
            className={`panel-tab ${uiState.activeOverviewMode === "overview" ? "active" : ""}`}
            onClick={() => onUiAction({ type: "setOverviewMode", mode: "overview" })}
          >
            Overview
          </button>
          <button
            type="button"
            className={`panel-tab ${uiState.activeOverviewMode === "synteny" ? "active" : ""}`}
            onClick={() => onUiAction({ type: "setOverviewMode", mode: "synteny" })}
          >
            Synteny
          </button>
        </div>
        {uiState.activeOverviewMode === "overview" ? (
          <ContactOverview
            contactMap={contactMap}
            overviewContactMap={overviewContactMap}
            dataset={dataset}
            uiState={uiState}
            onUiAction={onUiAction}
          />
        ) : (
          <SyntenyPreview
            syntenyView={syntenyView}
            onExpand={() => onUiAction({ type: "setSyntenySplitOpen", open: true })}
            selectedAssemblyBlockIds={
              uiState.assembly.selection?.kind === "contigs" ? uiState.assembly.selection.ids : []
            }
            onSelectBlock={(id, additive) =>
              onUiAction({ type: "selectAssemblyContig", id, additive })
            }
          />
        )}
      </section>

      <section>
        <h2>Selection</h2>
        <SelectionSummary uiState={uiState} onUiAction={onUiAction} />
      </section>

      <section>
        <h2>History</h2>
        <p className="empty-state">{uiState.operationHistory.length} operations</p>
        {uiState.operationHistory.length > 0 ? (
          <ol className="operation-list">
            {uiState.operationHistory.map((operation) => (
              <li key={operation.id}>
                <span>{operation.label}</span>
                <small>
                  {Math.round(operation.position.x)}, {Math.round(operation.position.y)}
                </small>
              </li>
            ))}
          </ol>
        ) : (
          <div className="history-empty">No operations yet</div>
        )}
      </section>

      <section>
        <h2>Project Info</h2>
        {dataset ? (
          <dl>
            <div>
              <dt>Assembly (AGP)</dt>
              <dd>{dataset.agp_path || "Not loaded"}</dd>
            </div>
            <div>
              <dt>Contact Map (.mcool)</dt>
              <dd>{dataset.mcool_path || "Not loaded"}</dd>
            </div>
            <div>
              <dt>Matrix size</dt>
              <dd>{dataset.mcool_size_bytes ? formatBytes(dataset.mcool_size_bytes) : "Not loaded"}</dd>
            </div>
            <div>
              <dt>Scaffolds</dt>
              <dd>{dataset.agp_objects.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Components</dt>
              <dd>{dataset.agp_components.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Max span</dt>
              <dd>{dataset.max_object_span.toLocaleString()} bp</dd>
            </div>
          </dl>
        ) : (
          <dl>
            <div>
              <dt>Assembly (AGP)</dt>
              <dd>Not loaded</dd>
            </div>
            <div>
              <dt>Contact Map (.mcool)</dt>
              <dd>Not loaded</dd>
            </div>
            <div>
              <dt>Coverage</dt>
              <dd>Not loaded</dd>
            </div>
          </dl>
        )}
      </section>

      <section>
        <h2>Export</h2>
        <dl>
          <div>
            <dt>AGP</dt>
            <dd className={uiState.assembly.blocks.length ? "export-ready" : ""}>
              {uiState.assembly.blocks.length ? "Ready" : "Not ready"}
            </dd>
          </div>
          <div>
            <dt>FASTA</dt>
            <dd className={dataset ? "export-ready" : ""}>{dataset ? "Ready" : "Not ready"}</dd>
          </div>
        </dl>
      </section>
    </aside>
  );
}

interface SelectionSummaryProps {
  uiState: UiState;
  onUiAction: (action: UiAction) => void;
}

function SelectionSummary({ uiState, onUiAction }: SelectionSummaryProps) {
  const selection = uiState.assembly.selection;
  const groups = groupAssemblyBlocksByChromosome(uiState.assembly.blocks, selection);

  if (!selection) {
    return <p className="empty-state">No contigs selected</p>;
  }

  if (selection.kind === "chromosome") {
    const group = groups.find((item) => item.id === selection.id);
    const selectedCount = group?.selectedCount ?? 0;
    const totalCount = group?.totalCount ?? 0;
    const totalLength = group?.totalLength ?? 0;
    return (
      <div className="selection-summary">
        <dl>
          <div>
            <dt>Type</dt>
            <dd>Chromosome</dd>
          </div>
          <div>
            <dt>ID</dt>
            <dd>{selection.id}</dd>
          </div>
          <div>
            <dt>Contigs</dt>
            <dd>{selectedCount}/{totalCount}</dd>
          </div>
          <div>
            <dt>Length</dt>
            <dd>{formatSpan(totalLength)}</dd>
          </div>
        </dl>
        <ChromosomeGroupList groups={groups} selection={selection} onUiAction={onUiAction} />
      </div>
    );
  }

  const selectedBlocks = uiState.assembly.blocks.filter((block) => selection.ids.includes(block.id));
  const selectedGroups = groups.filter((group) => group.selectedCount > 0);
  const selectedLength = selectedGroups.reduce((total, group) => total + group.selectedLength, 0);

  return (
    <div className="selection-summary">
      <dl>
        <div>
          <dt>Type</dt>
          <dd>Contigs</dd>
        </div>
        <div>
          <dt>Selected</dt>
          <dd>{selectedBlocks.length} contigs</dd>
        </div>
        <div>
          <dt>Groups</dt>
          <dd>{selectedGroups.length} chromosomes</dd>
        </div>
        <div>
          <dt>Length</dt>
          <dd>{formatSpan(selectedLength)}</dd>
        </div>
      </dl>
      <ChromosomeGroupList groups={groups} selection={selection} onUiAction={onUiAction} />
    </div>
  );
}

interface ChromosomeGroupListProps {
  groups: ReturnType<typeof groupAssemblyBlocksByChromosome>;
  selection: UiState["assembly"]["selection"];
  onUiAction: (action: UiAction) => void;
}

function ChromosomeGroupList({ groups, selection, onUiAction }: ChromosomeGroupListProps) {
  return (
    <div className="selection-groups">
      {groups.map((group) => (
        <article key={group.id} className={`selection-group ${selection?.kind === "chromosome" && selection.id === group.id ? "selected" : ""}`}>
          <button
            type="button"
            className="selection-group-header"
            onClick={() => onUiAction({ type: "selectAssemblyChromosome", id: group.id })}
          >
            <span>{group.id}</span>
            <strong>
              {group.selectedCount}/{group.totalCount}
            </strong>
          </button>
          <div className="selection-group-list">
            {group.blockIds.map((blockId) => {
              return (
                <button
                  key={blockId}
                  type="button"
                  className={`selection-chip ${isBlockSelected(selection, group.id, blockId) ? "selected" : ""}`}
                  onClick={() => onUiAction({
                    type: "selectAssemblyContig",
                    id: blockId,
                    additive: Boolean(selection?.kind === "contigs" && selection.ids.includes(blockId)),
                  })}
                >
                  {blockId.split(":")[2] ?? blockId}
                </button>
              );
            })}
          </div>
        </article>
      ))}
    </div>
  );
}

function isBlockSelected(selection: UiState["assembly"]["selection"], groupId: string, blockId: string) {
  return selection?.kind === "chromosome"
    ? selection.id === groupId
    : selection?.kind === "contigs" && selection.ids.includes(blockId);
}

function formatSpan(bp: number) {
  if (bp >= 1_000_000) {
    return `${(bp / 1_000_000).toFixed(2)} Mb`;
  }
  if (bp >= 1_000) {
    return `${(bp / 1_000).toFixed(1)} kb`;
  }
  return `${bp} bp`;
}

interface ContactOverviewProps {
  contactMap: ContactMapView | null;
  overviewContactMap: ContactMapView | null;
  dataset: ExampleDatasetSummary | null;
  uiState: UiState;
  onUiAction: (action: UiAction) => void;
}

function ContactOverview({ contactMap, overviewContactMap, dataset, uiState, onUiAction }: ContactOverviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const totalSpanBp = Math.max(1, dataset?.agp_layout.totalSpan ?? contactMap?.viewport.xEnd ?? 200_000_000);
  const totalSpanMb = Math.max(1, Math.round(totalSpanBp / 1_000_000));
  const [dragRatio, setDragRatio] = useState<{ x: number; y: number } | null>(null);
  const windowSpanRatio = Math.min(1, Math.max(0.001, uiState.contact.viewportSpanMb / totalSpanMb));
  const maxWindowStartRatio = Math.max(0, 1 - windowSpanRatio);
  const viewportXCenterRatio = Math.min(1, Math.max(0, uiState.contact.viewportCenterXMb / totalSpanMb));
  const viewportYCenterRatio = Math.min(1, Math.max(0, uiState.contact.viewportCenterYMb / totalSpanMb));
  const viewportXStartRatio = Math.min(maxWindowStartRatio, Math.max(0, viewportXCenterRatio - windowSpanRatio / 2));
  const viewportXEndRatio = Math.min(1, viewportXStartRatio + windowSpanRatio);
  const viewportYStartRatio = Math.min(maxWindowStartRatio, Math.max(0, viewportYCenterRatio - windowSpanRatio / 2));
  const viewportYEndRatio = Math.min(1, viewportYStartRatio + windowSpanRatio);
  const committedCenterRatio = {
    x: (viewportXStartRatio + viewportXEndRatio) / 2,
    y: (viewportYStartRatio + viewportYEndRatio) / 2,
  };
  const centerRatio = dragRatio ?? committedCenterRatio;
  const windowWidth = Math.min(100, Math.max(3, (viewportXEndRatio - viewportXStartRatio) * 100));
  const windowHeight = Math.min(100, Math.max(3, (viewportYEndRatio - viewportYStartRatio) * 100));
  const windowLeft = Math.min(100 - windowWidth, Math.max(0, centerRatio.x * 100 - windowWidth / 2));
  const windowTop = Math.min(100 - windowHeight, Math.max(0, centerRatio.y * 100 - windowHeight / 2));

  useEffect(() => {
    drawOverviewHeatmap(canvasRef.current, overviewContactMap ?? contactMap, uiState, totalSpanBp);
  }, [contactMap, overviewContactMap, totalSpanBp]);

  function ratioFromEvent(event: React.PointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / Math.max(1, bounds.width))),
      y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / Math.max(1, bounds.height))),
    };
  }

  function startDrag(event: React.PointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragRatio(ratioFromEvent(event));
  }

  function moveDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (event.buttons === 1) {
      setDragRatio(ratioFromEvent(event));
    }
  }

  function stopDrag(event: React.PointerEvent<HTMLDivElement>) {
    const ratio = dragRatio ?? ratioFromEvent(event);
    setDragRatio(null);
    onUiAction({
      type: "setContactViewportCenterFromOverview",
      xRatio: ratio.x,
      yRatio: ratio.y,
      totalSpanMb,
    });
  }

  return (
    <div
      className="overview-map interactive-overview"
      aria-label="Contact map overview"
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onPointerUp={stopDrag}
      onPointerCancel={() => setDragRatio(null)}
    >
      <canvas
        ref={canvasRef}
        className="overview-heatmap-canvas"
        width="320"
        height="320"
        aria-hidden="true"
      />
      <div
        className="overview-window"
        style={{
          left: `${windowLeft}%`,
          top: `${windowTop}%`,
          width: `${windowWidth}%`,
          height: `${windowHeight}%`,
        }}
      />
      <span className="overview-start">0 Mb</span>
      <span className="overview-end">{totalSpanMb.toLocaleString()} Mb</span>
    </div>
  );
}

function drawOverviewHeatmap(
  canvas: HTMLCanvasElement | null,
  contactMap: ContactMapView | null,
  uiState: UiState,
  totalSpanBp: number,
) {
  if (!canvas) {
    return;
  }

  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }

  const { width, height } = canvas;
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);

  if (!contactMap) {
    return;
  }

  const scale = estimateContactColorScale(
    contactMap.cells.map((cell) => cell.count),
    uiState.contact.colorScale.log,
  );
  const binSize = Math.max(1, (contactMap.resolution / Math.max(1, totalSpanBp)) * width);
  const cells = contactMap.tiles?.flatMap((tile) => tile.cells) ?? contactMap.cells;

  for (const cell of cells) {
    drawOverviewCell(context, cell.xBin, cell.yBin, cell.count, contactMap.resolution, totalSpanBp, width, height, binSize, scale);
    if (cell.xBin !== cell.yBin) {
      drawOverviewCell(context, cell.yBin, cell.xBin, cell.count, contactMap.resolution, totalSpanBp, width, height, binSize, scale);
    }
  }
}

function drawOverviewCell(
  context: CanvasRenderingContext2D,
  xBin: number,
  yBin: number,
  count: number,
  resolution: number,
  totalSpanBp: number,
  width: number,
  height: number,
  binSize: number,
  scale: Pick<ContactColorScale, "log" | "min" | "max">,
) {
  const x = ((xBin * resolution) / totalSpanBp) * width;
  const y = ((yBin * resolution) / totalSpanBp) * height;
  const intensity = normalizeContactValue(count, scale);
  context.fillStyle = contactColorCss("Reds", intensity);
  context.fillRect(x, y, binSize, binSize);
}

interface SyntenyPreviewProps {
  syntenyView: SyntenyView | null;
  onExpand: () => void;
  onSelectBlock: (assemblyBlockId: string, additive: boolean) => void;
  selectedAssemblyBlockIds: string[];
}

function SyntenyPreview({
  syntenyView,
  onExpand,
  onSelectBlock,
  selectedAssemblyBlockIds,
}: SyntenyPreviewProps) {
  return (
    <div className="synteny-panel">
      <SyntenyDotplot
        syntenyView={syntenyView}
        onDoubleClick={onExpand}
        onSelectBlock={onSelectBlock}
        selectedAssemblyBlockIds={selectedAssemblyBlockIds}
      />
    </div>
  );
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
  }

  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  }

  return `${(bytes / 1024).toFixed(1)} KiB`;
}
