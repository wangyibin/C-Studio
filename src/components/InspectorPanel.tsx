import { useEffect, useRef, useState } from "react";
import type { AppStatus, ContactMapView, ExampleDatasetSummary } from "../App";
import { contactColorCss } from "../state/contactColor";
import {
  contactCountSampleForColorScale,
  estimateContactColorScale,
  normalizeContactValue,
  type ContactColorScale,
} from "../state/contactColorScale";
import { forEachContactTileCell } from "../state/contactTileData";
import {
  assemblyCopyInstanceId,
  assemblyCopyIntervalGroups,
  assemblyContigDisplayName,
  assemblyRenameValidationError,
  assemblyUnitId,
  buildAssemblyEditModel,
  groupAssemblyBlocksByChromosome,
  selectedBlockIds,
  type AssemblyBlockGroup,
} from "../state/assemblyEditing";
import type { ContactMapLayoutBlock } from "../state/importers";
import {
  SyntenyDotplot,
} from "./SyntenyDotplot";
import type { SyntenyView } from "../state/syntenyView";
import type { OperationRecord, UiAction, UiState } from "../state/uiState";
import { fitContextMenuToViewport } from "./AssemblyContextMenu";

interface InspectorPanelProps {
  dataset: ExampleDatasetSummary | null;
  contactMap: ContactMapView | null;
  overviewContactMap: ContactMapView | null;
  status: AppStatus;
  statusMessage: string;
  isAgpDirty?: boolean;
  uiState: UiState;
  onUiAction: (action: UiAction) => void;
  syntenyView: SyntenyView | null;
  assemblyBlocks: ContactMapLayoutBlock[];
  selectedAssemblyBlockIds: string[];
  pafText: string;
  onPafTextChange: (value: string) => void;
}

export function InspectorPanel({
  dataset,
  contactMap,
  overviewContactMap,
  status,
  statusMessage,
  isAgpDirty = false,
  uiState,
  onUiAction,
  syntenyView,
  assemblyBlocks,
  selectedAssemblyBlockIds,
  pafText,
  onPafTextChange,
}: InspectorPanelProps) {
  const [historyMenu, setHistoryMenu] = useState<{
    id: number;
    anchorX: number;
    anchorY: number;
    x: number;
    y: number;
  } | null>(null);
  const historyMenuRef = useRef<HTMLDivElement>(null);
  const timelineOperations = [
    ...uiState.operationHistory.map((operation) => ({ operation, undone: false })),
    ...[...uiState.redoStack].reverse().map((operation) => ({ operation, undone: true })),
  ];

  useEffect(() => {
    if (!historyMenu || !historyMenuRef.current) {
      return;
    }
    const bounds = historyMenuRef.current.getBoundingClientRect();
    const fitted = fitContextMenuToViewport(
      { x: historyMenu.anchorX, y: historyMenu.anchorY },
      { width: bounds.width, height: bounds.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    if (fitted.x !== historyMenu.x || fitted.y !== historyMenu.y) {
      setHistoryMenu({ ...historyMenu, ...fitted });
    }
  }, [historyMenu]);

  useEffect(() => {
    if (!historyMenu) {
      return;
    }
    function closeHistoryMenu(event: PointerEvent) {
      if (!historyMenuRef.current?.contains(event.target as Node)) {
        setHistoryMenu(null);
      }
    }
    function handleHistoryMenuKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setHistoryMenu(null);
      }
    }
    function closeHistoryMenuOnResize() {
      setHistoryMenu(null);
    }
    window.addEventListener("pointerdown", closeHistoryMenu);
    window.addEventListener("keydown", handleHistoryMenuKey);
    window.addEventListener("resize", closeHistoryMenuOnResize);
    return () => {
      window.removeEventListener("pointerdown", closeHistoryMenu);
      window.removeEventListener("keydown", handleHistoryMenuKey);
      window.removeEventListener("resize", closeHistoryMenuOnResize);
    };
  }, [historyMenu]);

  return (
    <aside className="inspector" aria-label="Inspector">
      <section className={`overview-panel inspector-overview${
        uiState.activeOverviewMode === "synteny" ? " synteny-overview-active" : ""
      }`}>
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
            totalSpanBp={Math.max(
              1,
              assemblyBlocks.length > 0
                ? assemblyBlocks.reduce(
                  (largestEnd, block) => Math.max(largestEnd, block.visualEnd),
                  0,
                )
                : dataset?.agp_layout.totalSpan ?? 0,
            )}
            uiState={uiState}
            onUiAction={onUiAction}
          />
        ) : (
          <SyntenyPreview
            syntenyView={syntenyView}
            onExpand={() => onUiAction({ type: "setSyntenySplitOpen", open: true })}
            assemblyBlocks={assemblyBlocks}
            selectedAssemblyBlockIds={selectedAssemblyBlockIds}
            uiState={uiState}
            onUiAction={onUiAction}
          />
        )}
      </section>

      <section>
        <h2>Selection</h2>
        <SelectionSummary uiState={uiState} onUiAction={onUiAction} />
      </section>

      <section>
        <h2>History</h2>
        <p className="empty-state history-count">
          {uiState.operationHistory.length} applied
          {uiState.redoStack.length > 0 ? ` · ${uiState.redoStack.length} undone` : ""}
        </p>
        {timelineOperations.length > 0 ? (
          <ol className="operation-list">
            {timelineOperations.map(({ operation, undone }, index) => (
              <li
                key={operation.id}
                className={`${undone ? "undone" : "applied"}${
                  !undone && index === uiState.operationHistory.length - 1 ? " current" : ""
                }`}
                onContextMenu={(event) => {
                  if (undone) {
                    return;
                  }
                  event.preventDefault();
                  setHistoryMenu({
                    id: operation.id,
                    anchorX: event.clientX,
                    anchorY: event.clientY,
                    x: event.clientX,
                    y: event.clientY,
                  });
                }}
              >
                <button
                  type="button"
                  className="history-entry-button"
                  aria-label={`Focus ${operation.label}`}
                  onClick={() => onUiAction({ type: "focusHistoryOperation", id: operation.id })}
                  onMouseEnter={() => onUiAction({ type: "previewHistoryOperation", id: operation.id })}
                  onMouseLeave={() => onUiAction({ type: "previewHistoryOperation", id: null })}
                  onFocus={() => onUiAction({ type: "previewHistoryOperation", id: operation.id })}
                  onBlur={() => onUiAction({ type: "previewHistoryOperation", id: null })}
                >
                  <span className="history-entry-heading">
                    <strong>{operation.label}</strong>
                    {undone ? <em>Undone</em> : null}
                  </span>
                  <small className="history-entry-object">{historyOperationObject(operation)}</small>
                  <small>{historyOperationCounts(operation)}</small>
                </button>
              </li>
            ))}
          </ol>
        ) : (
          <div className="history-empty">No operations yet</div>
        )}
        {historyMenu ? (
          <div
            ref={historyMenuRef}
            className="history-context-menu"
            role="menu"
            style={{ left: historyMenu.x, top: historyMenu.y }}
          >
            <button
              type="button"
              role="menuitem"
              disabled={historyMenu.id === uiState.operationHistory[
                uiState.operationHistory.length - 1
              ]?.id}
              onClick={() => {
                onUiAction({ type: "undoToHistoryOperation", id: historyMenu.id });
                setHistoryMenu(null);
              }}
            >
              Undo to here
            </button>
          </div>
        ) : null}
      </section>

      <section>
        <h2>Project Info</h2>
        {dataset ? (
          <dl>
            <div>
              <dt>Assembly (AGP)</dt>
              <dd>{dataset.agp_path ? `${dataset.agp_path}${isAgpDirty ? "*" : ""}` : "Not loaded"}</dd>
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

export function historyOperationObject(operation: OperationRecord) {
  const sourceIds = operation.impact?.sourceIds ?? [];
  if (sourceIds.length === 0) {
    return "Assembly";
  }
  const visible = sourceIds.slice(0, 2).join(", ");
  return sourceIds.length > 2 ? `${visible} +${sourceIds.length - 2}` : visible;
}

export function historyOperationCounts(operation: OperationRecord) {
  const chromosomeCount = new Set(operation.impact?.chromosomeIds ?? []).size;
  const contigCount = new Set(operation.impact?.sourceIds ?? []).size;
  return `${chromosomeCount} ${chromosomeCount === 1 ? "chromosome" : "chromosomes"} · ${contigCount} ${
    contigCount === 1 ? "contig" : "contigs"
  }`;
}

interface SelectionSummaryProps {
  uiState: UiState;
  onUiAction: (action: UiAction) => void;
}

function SelectionSummary({ uiState, onUiAction }: SelectionSummaryProps) {
  const selection = uiState.assembly.selection;
  const model = buildAssemblyEditModel(uiState.assembly.blocks);
  const groups = groupAssemblyBlocksByChromosome(uiState.assembly.blocks, selection);
  const selectedContigIds = new Set(selectedBlockIds(model.blocks, selection));
  const selectedContigs = model.blocks.filter((block) => selectedContigIds.has(block.id));
  const selectedBlocks = model.assemblyBlocks.filter((block) => (
    block.contigIds.some((id) => selectedContigIds.has(id))
  ));

  if (!selection) {
    return <p className="empty-state">No blocks selected</p>;
  }

  if (selection.kind === "chromosome") {
    const group = groups.find((item) => item.id === selection.id);
    const selectedCount = group?.selectedCount ?? 0;
    const totalCount = group?.totalCount ?? 0;
    const totalLength = group?.totalLength ?? 0;
    const chromosomeContigCount = model.assemblyBlocks
      .filter((block) => block.objectId === selection.id)
      .reduce((count, block) => count + block.contigIds.length, 0);
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
            <dt>Blocks</dt>
            <dd>{selectedCount}/{totalCount}</dd>
          </div>
          <div>
            <dt>Contigs</dt>
            <dd>{chromosomeContigCount}</dd>
          </div>
          <div>
            <dt>Length</dt>
            <dd>{formatSpan(totalLength)}</dd>
          </div>
        </dl>
        <ChromosomeGroupList
          groups={group ? [group] : []}
          assemblyBlocks={model.assemblyBlocks}
          contigs={model.blocks}
          selection={selection}
          onUiAction={onUiAction}
        />
      </div>
    );
  }

  const selectedGroups = groups.filter((group) => group.selectedCount > 0);
  const selectedLength = selectedBlocks.reduce(
    (total, block) => total + Math.max(0, block.visualEnd - block.visualStart),
    0,
  );
  const selectedContigLength = selectedContigs.reduce(
    (total, block) => total + Math.max(0, block.visualEnd - block.visualStart),
    0,
  );
  const selectedContig = selectedContigs.length === 1 ? selectedContigs[0] : null;

  return (
    <div className="selection-summary">
      <dl>
        <div>
          <dt>Type</dt>
          <dd>Blocks</dd>
        </div>
        <div>
          <dt>Selected</dt>
          <dd>{formatCount(selectedBlocks.length, "block")}</dd>
        </div>
        <div>
          <dt>Contigs</dt>
          <dd>{formatCount(selectedContigs.length, "contig")}</dd>
        </div>
        <div>
          <dt>Chromosomes</dt>
          <dd>{formatCount(selectedGroups.length, "chromosome")}</dd>
        </div>
        <div>
          <dt>Length</dt>
          <dd>{formatSpan(selectedContigLength || selectedLength)}</dd>
        </div>
      </dl>
      {selectedContig ? (
        <ContigOccurrenceSummary
          contig={selectedContig}
          blocks={model.blocks}
          onUiAction={onUiAction}
        />
      ) : null}
      <ChromosomeGroupList
        groups={selectedGroups}
        assemblyBlocks={model.assemblyBlocks}
        contigs={model.blocks}
        selection={selection}
        onUiAction={onUiAction}
      />
    </div>
  );
}

interface ContigOccurrenceSummaryProps {
  contig: ContactMapLayoutBlock;
  blocks: ContactMapLayoutBlock[];
  onUiAction: (action: UiAction) => void;
}

function ContigOccurrenceSummary({
  contig,
  blocks,
  onUiAction,
}: ContigOccurrenceSummaryProps) {
  const copyGroups = assemblyCopyIntervalGroups(blocks, contig);
  const currentCopyId = assemblyCopyInstanceId(contig);
  const currentCopy = copyGroups.find((group) => group.id === currentCopyId);
  const coveringCopyCount = copyGroups.filter((group) => group.coversInterval).length;
  const siblingSegments = currentCopy?.blocks.filter((block) => block.id !== contig.id) ?? [];
  const otherCopyGroups = copyGroups.filter((group) => (
    group.id !== currentCopyId && group.overlappingBlocks.length > 0
  ));

  return (
    <section className="contig-occurrences" aria-label="Contig occurrences">
      <div className="contig-occurrence-heading">
        <span>{assemblyContigDisplayName(contig)}</span>
        <strong>{formatCount(coveringCopyCount, "copy", "copies")}</strong>
      </div>
      <dl>
        <div>
          <dt>Source interval</dt>
          <dd>{contig.sourceId}:{formatGenomicInterval(contig.sourceStart, contig.sourceEnd)}</dd>
        </div>
        <div>
          <dt>Current location</dt>
          <dd>{formatContigLocation(contig)}</dd>
        </div>
      </dl>
      <div className={`contig-current-copy-state${currentCopy?.isSplit ? " split" : ""}`}>
        <span>Current copy</span>
        <strong>{currentCopy?.isSplit
          ? `Split copy · ${currentCopy.blocks.length} segments`
          : "Unsplit copy"}</strong>
      </div>
      {currentCopy?.isSplit ? (
        <ContigPlacementList
          label="Other segments in this copy"
          placements={siblingSegments}
          emptyText="No other segments"
          onUiAction={onUiAction}
        />
      ) : null}
      <div className="contig-other-locations">
        <span>Other copies</span>
        {otherCopyGroups.length > 0 ? (
          <div className="contig-copy-groups">
            {otherCopyGroups.map((group) => (
              <section
                className={`contig-copy-group${group.isSplit ? " split" : ""}`}
                key={group.id}
              >
                <div className="contig-copy-group-heading">
                  <strong>{group.isSplit
                    ? `Split copy · ${group.blocks.length} segments`
                    : "Unsplit copy"}</strong>
                  <small>{group.coversInterval ? "Covers current interval" : "Partial overlap"}</small>
                </div>
                <ContigPlacementItems
                  placements={group.blocks}
                  onUiAction={onUiAction}
                />
              </section>
            ))}
          </div>
        ) : <small>No other copies</small>}
      </div>
    </section>
  );
}

interface ContigPlacementListProps {
  label: string;
  placements: ContactMapLayoutBlock[];
  emptyText: string;
  onUiAction: (action: UiAction) => void;
}

function ContigPlacementList({
  label,
  placements,
  emptyText,
  onUiAction,
}: ContigPlacementListProps) {
  return (
    <div className="contig-other-locations">
      <span>{label}</span>
      {placements.length > 0
        ? <ContigPlacementItems placements={placements} onUiAction={onUiAction} />
        : <small>{emptyText}</small>}
    </div>
  );
}

function ContigPlacementItems({
  placements,
  onUiAction,
}: Pick<ContigPlacementListProps, "placements" | "onUiAction">) {
  return (
    <ol>
      {placements.map((placement) => (
        <li key={placement.id}>
          <button
            type="button"
            aria-label={`Select ${assemblyContigDisplayName(placement)} at ${formatContigLocation(placement)}`}
            onClick={() => onUiAction({
              type: "selectAssemblyContig",
              id: placement.id,
              additive: false,
            })}
          >
            <span>{assemblyContigDisplayName(placement)} · {placement.objectId}</span>
            <small>
              Source {formatGenomicInterval(placement.sourceStart, placement.sourceEnd)} bp
              {` · Visual ${formatGenomicInterval(placement.visualStart, placement.visualEnd)} bp`}
              {` · ${placement.orientation}`}
            </small>
          </button>
        </li>
      ))}
    </ol>
  );
}

function formatGenomicInterval(start: number, end: number) {
  return `${Math.max(0, start) + 1}-${Math.max(0, end)}`;
}

function formatContigLocation(contig: ContactMapLayoutBlock) {
  return `${contig.objectId} · ${assemblyUnitId(contig)} · ${formatGenomicInterval(
    contig.visualStart,
    contig.visualEnd,
  )} bp · ${contig.orientation}`;
}

interface ChromosomeGroupListProps {
  groups: ReturnType<typeof groupAssemblyBlocksByChromosome>;
  assemblyBlocks: AssemblyBlockGroup[];
  contigs: ContactMapLayoutBlock[];
  selection: UiState["assembly"]["selection"];
  onUiAction: (action: UiAction) => void;
}

function ChromosomeGroupList({
  groups,
  assemblyBlocks,
  contigs,
  selection,
  onUiAction,
}: ChromosomeGroupListProps) {
  const [renamingChromosome, setRenamingChromosome] = useState<{
    id: string;
    value: string;
    error: string | null;
  } | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const blocksById = new Map(assemblyBlocks.map((block) => [block.id, block]));
  const contigsById = new Map(contigs.map((contig) => [contig.id, contig]));

  useEffect(() => {
    if (renamingChromosome) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renamingChromosome?.id]);

  const beginChromosomeRename = (id: string) => {
    onUiAction({ type: "selectAssemblyChromosome", id });
    setRenamingChromosome({ id, value: id, error: null });
  };
  const commitChromosomeRename = () => {
    if (!renamingChromosome) {
      return;
    }
    const name = renamingChromosome.value.trim();
    const chromosomeSelection = {
      kind: "chromosome" as const,
      id: renamingChromosome.id,
    };
    const error = assemblyRenameValidationError(contigs, chromosomeSelection, name);
    if (error) {
      setRenamingChromosome({ ...renamingChromosome, error });
      return;
    }
    if (name !== renamingChromosome.id) {
      onUiAction({ type: "selectAssemblyChromosome", id: renamingChromosome.id });
      onUiAction({ type: "renameAssemblySelection", name });
    }
    setRenamingChromosome(null);
  };

  return (
    <div className="selection-groups">
      {groups.map((group) => (
        <article key={group.id} className={`selection-group ${selection?.kind === "chromosome" && selection.id === group.id ? "selected" : ""}`}>
          {renamingChromosome?.id === group.id ? (
            <form
              className="selection-group-header selection-group-rename-form"
              onSubmit={(event) => {
                event.preventDefault();
                commitChromosomeRename();
              }}
            >
              <input
                ref={renameInputRef}
                value={renamingChromosome.value}
                aria-label={`Rename chromosome ${group.id}`}
                aria-invalid={Boolean(renamingChromosome.error)}
                onChange={(event) => setRenamingChromosome({
                  ...renamingChromosome,
                  value: event.target.value,
                  error: null,
                })}
                onBlur={commitChromosomeRename}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setRenamingChromosome(null);
                  }
                }}
              />
              <strong>
                {group.selectedCount}/{group.totalCount}
              </strong>
              {renamingChromosome.error ? (
                <small className="selection-group-rename-error" role="alert">
                  {renamingChromosome.error}
                </small>
              ) : null}
            </form>
          ) : (
            <button
              type="button"
              className="selection-group-header"
              title={`Double-click to rename ${group.id}`}
              onClick={() => onUiAction({ type: "selectAssemblyChromosome", id: group.id })}
              onDoubleClick={() => beginChromosomeRename(group.id)}
            >
              <span>{group.id}</span>
              <strong>
                {group.selectedCount}/{group.totalCount}
              </strong>
            </button>
          )}
          <div className="selection-group-list">
            {group.blockIds.filter((blockId) => {
              const block = blocksById.get(blockId);
              return block ? isBlockSelected(selection, group.id, block) : false;
            }).map((blockId) => {
              const block = blocksById.get(blockId);
              if (!block) {
                return null;
              }
              const childContigs = block.contigIds
                .map((id) => contigsById.get(id))
                .filter((contig): contig is ContactMapLayoutBlock => Boolean(contig));
              const label = block.isComposite
                ? block.id
                : childContigs[0] ? assemblyContigDisplayName(childContigs[0]) : block.id;
              return (
                <div
                  className={`selection-block-entry${block.isComposite ? " composite" : ""}`}
                  key={blockId}
                >
                  <button
                    type="button"
                    className={`selection-chip ${isBlockSelected(selection, group.id, block) ? "selected" : ""}`}
                    aria-label={`Select block ${label}`}
                    title={label}
                    onClick={() => onUiAction({
                      type: "selectAssemblyContig",
                      id: blockId,
                      additive: Boolean(
                        selection?.kind === "contigs"
                        && (selection.ids.includes(blockId)
                          || block.contigIds.some((id) => selection.ids.includes(id))),
                      ),
                    })}
                  >
                    <span className={block.isComposite ? undefined : "selection-contig-label"}>
                      {label}
                    </span>
                    <small>{block.isComposite ? `${block.contigIds.length} contigs` : "contig"}</small>
                  </button>
                  {block.isComposite ? (
                    <div className="selection-contig-children" aria-label={`Contigs in ${block.id}`}>
                      {childContigs.map((contig) => (
                        <span key={contig.id} title={`${assemblyContigDisplayName(contig)} ${contig.orientation}`}>
                          {assemblyContigDisplayName(contig)}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </article>
      ))}
    </div>
  );
}

function isBlockSelected(
  selection: UiState["assembly"]["selection"],
  groupId: string,
  block: AssemblyBlockGroup,
) {
  return selection?.kind === "chromosome"
    ? selection.id === groupId
    : selection?.kind === "contigs"
      && (selection.ids.includes(block.id)
        || block.contigIds.some((id) => selection.ids.includes(id)));
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

function formatCount(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

interface ContactOverviewProps {
  contactMap: ContactMapView | null;
  overviewContactMap: ContactMapView | null;
  totalSpanBp: number;
  uiState: UiState;
  onUiAction: (action: UiAction) => void;
}

export function contactOverviewMapForDisplayedNormalization(
  contactMap: ContactMapView | null,
  overviewContactMap: ContactMapView | null,
): ContactMapView | null {
  if (overviewContactMap?.normalization === contactMap?.normalization) {
    return overviewContactMap;
  }
  return null;
}

function ContactOverview({
  contactMap,
  overviewContactMap,
  totalSpanBp,
  uiState,
  onUiAction,
}: ContactOverviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const displayedOverview = contactOverviewMapForDisplayedNormalization(
    contactMap,
    overviewContactMap,
  );
  // Keep the transitional pixels and their coordinate span from the same
  // last-complete snapshot. A copy/delete edit swaps both atomically.
  const displayedTotalSpanBp = Math.max(
    1,
    displayedOverview?.viewport.xEnd ?? totalSpanBp,
  );
  const totalSpanMb = Math.max(1, Math.round(displayedTotalSpanBp / 1_000_000));
  const [dragRatio, setDragRatio] = useState<{ x: number; y: number } | null>(null);
  const dragRatioRef = useRef<{ x: number; y: number } | null>(null);
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
    drawOverviewHeatmap(
      canvasRef.current,
      displayedOverview,
      uiState,
      displayedTotalSpanBp,
    );
  }, [
    displayedOverview,
    displayedTotalSpanBp,
    uiState.contact.colorScale.log,
  ]);

  function ratioFromEvent(event: React.PointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / Math.max(1, bounds.width))),
      y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / Math.max(1, bounds.height))),
    };
  }

  function startDrag(event: React.PointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    const ratio = ratioFromEvent(event);
    dragRatioRef.current = ratio;
    setDragRatio(ratio);
    moveMainViewport(ratio, true);
  }

  function moveDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (dragRatioRef.current !== null) {
      const ratio = ratioFromEvent(event);
      dragRatioRef.current = ratio;
      setDragRatio(ratio);
      moveMainViewport(ratio, true);
    }
  }

  function stopDrag(event: React.PointerEvent<HTMLDivElement>) {
    const ratio = ratioFromEvent(event);
    dragRatioRef.current = null;
    setDragRatio(null);
    moveMainViewport(ratio, false);
  }

  function cancelDrag() {
    dragRatioRef.current = null;
    setDragRatio(null);
  }

  function moveMainViewport(ratio: { x: number; y: number }, transient: boolean) {
    onUiAction({
      type: "setContactViewportCenterFromOverview",
      xRatio: ratio.x,
      yRatio: ratio.y,
      totalSpanMb,
      transient,
    });
  }

  return (
    <div
      className="overview-map interactive-overview"
      aria-label="Contact map overview"
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onPointerUp={stopDrag}
      onPointerCancel={cancelDrag}
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
    contactCountSampleForColorScale(contactMap),
    uiState.contact.colorScale.log,
  );
  const binSize = Math.max(1, (contactMap.resolution / Math.max(1, totalSpanBp)) * width);

  const drawCell = (xBin: number, yBin: number, count: number) => {
    drawOverviewCell(context, xBin, yBin, count, contactMap.resolution, totalSpanBp, width, height, binSize, scale);
    if (xBin !== yBin) {
      drawOverviewCell(context, yBin, xBin, count, contactMap.resolution, totalSpanBp, width, height, binSize, scale);
    }
  };
  if (contactMap.tiles && contactMap.tiles.length > 0) {
    const tileSizeBins = contactMap.tileSizeBins ?? 256;
    for (const tile of contactMap.tiles) {
      forEachContactTileCell(tile, tileSizeBins, drawCell);
    }
  } else {
    for (const cell of contactMap.cells) {
      drawCell(cell.xBin, cell.yBin, cell.count);
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
  assemblyBlocks: ContactMapLayoutBlock[];
  onExpand: () => void;
  selectedAssemblyBlockIds: string[];
  uiState: UiState;
  onUiAction: (action: UiAction) => void;
}

function SyntenyPreview({
  syntenyView,
  assemblyBlocks,
  onExpand,
  selectedAssemblyBlockIds,
  uiState,
  onUiAction,
}: SyntenyPreviewProps) {
  return (
    <div className="synteny-panel">
      <SyntenyDotplot
        syntenyView={syntenyView}
        assemblyBlocks={assemblyBlocks}
        interactionMode="preview"
        onDoubleClick={onExpand}
        selectedAssemblyBlockIds={selectedAssemblyBlockIds}
        uiState={uiState}
        onUiAction={onUiAction}
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
