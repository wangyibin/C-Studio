import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  buildAssemblyEditModel,
  type AssemblySelectionModifiers,
} from "../state/assemblyEditing";
import type { ContactMapLayoutBlock } from "../state/importers";
import type { SyntenyBlockView, SyntenyView } from "../state/syntenyView";
import type { UiAction, UiState } from "../state/uiState";
import {
  AssemblyContextMenu,
  type AssemblyContextMenuPosition,
} from "./AssemblyContextMenu";

export type SyntenySelectionModifiers = AssemblySelectionModifiers;

export interface DotplotTargetLane {
  id: string;
  top: number;
  height: number;
  targetLength: number;
}

export interface DotplotBlock {
  key: string;
  assemblyBlockId: string;
  targetId: string;
  left: number;
  top: number;
  width: number;
  angle: number;
  strand: string;
  mapq: number;
  title: string;
}

export interface DotplotLayout {
  blocks: DotplotBlock[];
  targetLanes: DotplotTargetLane[];
}

interface SyntenyDotplotProps {
  syntenyView: SyntenyView | null;
  assemblyBlocks?: ContactMapLayoutBlock[];
  emptyLabel?: string;
  onDoubleClick?: () => void;
  onSelectBlock?: (assemblyBlockId: string, modifiers: SyntenySelectionModifiers) => void;
  selectedAssemblyBlockIds?: string[];
  uiState?: UiState;
  onUiAction?: (action: UiAction) => void;
}

export function SyntenyDotplot({
  syntenyView,
  assemblyBlocks = [],
  emptyLabel = "No reference alignments in the heatmap X region",
  onDoubleClick,
  onSelectBlock,
  selectedAssemblyBlockIds = [],
  uiState,
  onUiAction,
}: SyntenyDotplotProps) {
  const layout = useMemo(() => buildDotplotLayout(syntenyView), [syntenyView]);
  const assemblyTrack = useMemo(
    () => buildAssemblyTrack(syntenyView, assemblyBlocks),
    [assemblyBlocks, syntenyView],
  );
  const selected = new Set(selectedAssemblyBlockIds);
  const [contextMenu, setContextMenu] = useState<AssemblyContextMenuPosition | null>(null);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextMenu(null);
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [contextMenu]);

  function selectBlock(id: string, event: ReactMouseEvent<HTMLElement>) {
    event.stopPropagation();
    onSelectBlock?.(id, selectionModifiers(event));
  }

  function openContextMenu(event: ReactMouseEvent<HTMLElement>, id?: string) {
    event.preventDefault();
    event.stopPropagation();
    if (id && !selected.has(id)) {
      onSelectBlock?.(id, { shiftKey: false, metaKey: false, ctrlKey: false });
    }
    setContextMenu({ x: event.clientX, y: event.clientY });
  }

  return (
    <div className="synteny-view">
      <div
        className="synteny-canvas"
        aria-label="Synteny dotplot for heatmap X region"
        onDoubleClick={onDoubleClick}
        onClick={() => setContextMenu(null)}
        onContextMenu={(event) => openContextMenu(event)}
      >
        <div className="synteny-axis query-axis">Heatmap X · assembly</div>
        <div className="synteny-axis target-axis">Reference</div>

        <div className="synteny-query-track" aria-label="Assembly contigs in heatmap X region">
          {assemblyTrack.chromosomes.map((chromosome) => (
            <span
              className="synteny-chromosome-band"
              key={chromosome.id}
              style={{ left: `${chromosome.left}%`, width: `${chromosome.width}%` }}
              title={chromosome.id}
            />
          ))}
          {assemblyTrack.contigs.map((contig) => (
            <button
              type="button"
              className={`synteny-contig-segment ${selected.has(contig.id) ? "selected" : ""}`}
              key={contig.id}
              data-block-id={contig.id}
              aria-label={`Select ${contig.sourceId} in synteny`}
              aria-pressed={selected.has(contig.id)}
              title={`${contig.objectId} · ${contig.sourceId}`}
              style={{ left: `${contig.left}%`, width: `${contig.width}%` }}
              onClick={(event) => selectBlock(contig.id, event)}
              onDoubleClick={(event) => event.stopPropagation()}
              onContextMenu={(event) => openContextMenu(event, contig.id)}
            />
          ))}
        </div>

        {layout.targetLanes.map((lane) => (
          <div
            className="synteny-target-lane"
            key={lane.id}
            data-target-id={lane.id}
            style={{ top: `${lane.top}%`, height: `${lane.height}%` }}
          >
            <span>{lane.id}</span>
          </div>
        ))}

        {layout.blocks.map((block) => {
          const shade = Math.max(0.32, Math.min(1, block.mapq / 60));
          const isSelected = selected.has(block.assemblyBlockId);

          return (
            <button
              type="button"
              className={`dotplot-segment ${block.strand === "-" ? "reverse" : ""} ${
                isSelected ? "selected" : ""
              }`}
              key={block.key}
              data-block-id={block.assemblyBlockId}
              data-target-id={block.targetId}
              title={block.title}
              aria-label={`Select ${block.assemblyBlockId} synteny block`}
              aria-pressed={isSelected}
              onClick={(event) => selectBlock(block.assemblyBlockId, event)}
              onDoubleClick={(event) => event.stopPropagation()}
              onContextMenu={(event) => openContextMenu(event, block.assemblyBlockId)}
              style={{
                left: `${block.left}%`,
                top: `${block.top}%`,
                width: `${block.width}%`,
                opacity: shade,
                transform: `rotate(${block.angle}deg)`,
              }}
            />
          );
        })}

        {layout.blocks.length === 0 ? <p>{emptyLabel}</p> : null}
        {syntenyView ? (
          <small className="dotplot-range">
            X {formatMb(syntenyView.viewport.xStart)}–{formatMb(syntenyView.viewport.xEnd)} Mb
          </small>
        ) : null}
      </div>

      {contextMenu && uiState && onUiAction ? (
        <AssemblyContextMenu
          position={contextMenu}
          uiState={uiState}
          onUiAction={onUiAction}
          onClose={() => setContextMenu(null)}
          fixed
        />
      ) : null}
    </div>
  );
}

export function buildDotplotLayout(syntenyView: SyntenyView | null): DotplotLayout {
  if (!syntenyView || syntenyView.viewport.xEnd <= syntenyView.viewport.xStart) {
    return { blocks: [], targetLanes: [] };
  }

  const targetOrder: string[] = [];
  const targetLengths = new Map<string, number>();
  for (const block of syntenyView.blocks) {
    if (!targetLengths.has(block.targetId)) {
      targetOrder.push(block.targetId);
    }
    targetLengths.set(
      block.targetId,
      Math.max(
        targetLengths.get(block.targetId) ?? 1,
        Number.isFinite(block.targetLength) ? block.targetLength : 0,
        block.targetEnd,
        1,
      ),
    );
  }
  targetOrder.sort((left, right) => left.localeCompare(right, undefined, {
    numeric: true,
    sensitivity: "base",
  }));

  const plotTop = 23;
  const plotBottom = 88;
  const plotHeight = plotBottom - plotTop;
  const laneGap = targetOrder.length > 1 ? Math.min(3, 12 / targetOrder.length) : 0;
  const laneHeight = targetOrder.length > 0
    ? Math.max(3, (plotHeight - laneGap * (targetOrder.length - 1)) / targetOrder.length)
    : plotHeight;
  const targetLanes = targetOrder.map((id, index) => ({
    id,
    top: plotTop + index * (laneHeight + laneGap),
    height: laneHeight,
    targetLength: targetLengths.get(id) ?? 1,
  }));
  const lanesById = new Map(targetLanes.map((lane) => [lane.id, lane]));
  const viewportWidth = syntenyView.viewport.xEnd - syntenyView.viewport.xStart;

  const blocks = syntenyView.blocks.flatMap((block) => {
    const lane = lanesById.get(block.targetId);
    const visualSpan = block.visualEnd - block.visualStart;
    if (!lane || visualSpan <= 0) {
      return [];
    }

    const visibleStart = Math.max(block.visualStart, syntenyView.viewport.xStart);
    const visibleEnd = Math.min(block.visualEnd, syntenyView.viewport.xEnd);
    if (visibleEnd <= visibleStart) {
      return [];
    }

    const startRatio = (visibleStart - block.visualStart) / visualSpan;
    const endRatio = (visibleEnd - block.visualStart) / visualSpan;
    const targetAtVisualStart = block.strand === "-" ? block.targetEnd : block.targetStart;
    const targetAtVisualEnd = block.strand === "-" ? block.targetStart : block.targetEnd;
    const targetAtVisibleStart = interpolate(targetAtVisualStart, targetAtVisualEnd, startRatio);
    const targetAtVisibleEnd = interpolate(targetAtVisualStart, targetAtVisualEnd, endRatio);
    const x1 = ((visibleStart - syntenyView.viewport.xStart) / viewportWidth) * 100;
    const x2 = ((visibleEnd - syntenyView.viewport.xStart) / viewportWidth) * 100;
    const y1 = lane.top + (clamp(targetAtVisibleStart, 0, lane.targetLength) / lane.targetLength) * lane.height;
    const y2 = lane.top + (clamp(targetAtVisibleEnd, 0, lane.targetLength) / lane.targetLength) * lane.height;
    const deltaX = x2 - x1;
    const deltaY = y2 - y1;

    return [{
      key: `${block.assemblyBlockId}-${block.targetId}-${block.visualStart}-${block.targetStart}`,
      assemblyBlockId: block.assemblyBlockId,
      targetId: block.targetId,
      left: x1,
      top: y1,
      width: Math.max(0.35, Math.hypot(deltaX, deltaY)),
      angle: (Math.atan2(deltaY, deltaX) * 180) / Math.PI,
      strand: block.strand,
      mapq: block.mapq,
      title: `${block.querySourceId}:${Math.round(visibleStart)}-${Math.round(visibleEnd)} → ${
        block.targetId
      }:${Math.round(Math.min(targetAtVisibleStart, targetAtVisibleEnd))}-${Math.round(
        Math.max(targetAtVisibleStart, targetAtVisibleEnd),
      )}`,
    }];
  });

  return { blocks, targetLanes };
}

interface AssemblyTrackSegment {
  id: string;
  left: number;
  width: number;
}

interface AssemblyContigTrackSegment extends AssemblyTrackSegment {
  objectId: string;
  sourceId: string;
}

function buildAssemblyTrack(
  syntenyView: SyntenyView | null,
  assemblyBlocks: ContactMapLayoutBlock[],
): { chromosomes: AssemblyTrackSegment[]; contigs: AssemblyContigTrackSegment[] } {
  if (!syntenyView || syntenyView.viewport.xEnd <= syntenyView.viewport.xStart) {
    return { chromosomes: [], contigs: [] };
  }
  const { xStart, xEnd } = syntenyView.viewport;
  const viewportSpan = xEnd - xStart;
  const toTrackSegment = <T extends { id: string; visualStart: number; visualEnd: number }>(item: T) => {
    const visibleStart = Math.max(xStart, item.visualStart);
    const visibleEnd = Math.min(xEnd, item.visualEnd);
    if (visibleEnd <= visibleStart) {
      return null;
    }
    return {
      ...item,
      left: ((visibleStart - xStart) / viewportSpan) * 100,
      width: ((visibleEnd - visibleStart) / viewportSpan) * 100,
    };
  };

  const chromosomes = buildAssemblyEditModel(assemblyBlocks).chromosomes
    .map(toTrackSegment)
    .filter((segment): segment is NonNullable<typeof segment> => segment !== null)
    .map(({ id, left, width }) => ({ id, left, width }));
  const contigs = assemblyBlocks
    .map(toTrackSegment)
    .filter((segment): segment is NonNullable<typeof segment> => segment !== null)
    .map(({ id, objectId, sourceId, left, width }) => ({
      id,
      objectId,
      sourceId,
      left,
      width,
    }));

  return { chromosomes, contigs };
}

function selectionModifiers(event: ReactMouseEvent<HTMLElement>): SyntenySelectionModifiers {
  return {
    shiftKey: event.shiftKey,
    metaKey: event.metaKey,
    ctrlKey: event.ctrlKey,
  };
}

function interpolate(start: number, end: number, ratio: number) {
  return start + (end - start) * ratio;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function formatMb(valueBp: number) {
  return Number((valueBp / 1_000_000).toFixed(2)).toLocaleString();
}
