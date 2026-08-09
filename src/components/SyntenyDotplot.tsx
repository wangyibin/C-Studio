import type { SyntenyView } from "../state/syntenyView";

interface DotplotBlock {
  key: string;
  assemblyBlockId: string;
  left: number;
  top: number;
  width: number;
  height: number;
  angle: number;
  strand: string;
  mapq: number;
  title: string;
}

interface SyntenyDotplotProps {
  syntenyView: SyntenyView | null;
  emptyLabel?: string;
  onDoubleClick?: () => void;
  onSelectBlock?: (assemblyBlockId: string, additive: boolean) => void;
  selectedAssemblyBlockIds?: string[];
}

export function SyntenyDotplot({
  syntenyView,
  emptyLabel = "No synteny blocks in current viewport",
  onDoubleClick,
  onSelectBlock,
  selectedAssemblyBlockIds = [],
}: SyntenyDotplotProps) {
  const blocks = buildDotplotBlocks(syntenyView);
  const selected = new Set(selectedAssemblyBlockIds);

  return (
    <div className="synteny-canvas" aria-label="Synteny dotplot" onDoubleClick={onDoubleClick}>
      <div className="synteny-axis query-axis">Assembly viewport</div>
      <div className="synteny-axis target-axis">Target</div>
      {blocks.map((block) => {
        const shade = Math.max(0.32, Math.min(1, block.mapq / 60));

        return (
          <button
            type="button"
            className={`dotplot-segment ${block.strand === "-" ? "reverse" : ""} ${
              selected.has(block.assemblyBlockId) ? "selected" : ""
            }`}
            key={block.key}
            title={block.title}
            aria-label={`Select ${block.assemblyBlockId} synteny block`}
            aria-pressed={selected.has(block.assemblyBlockId)}
            onClick={(event) => {
              event.stopPropagation();
              onSelectBlock?.(block.assemblyBlockId, event.shiftKey);
            }}
            style={{
              left: `${block.left}%`,
              top: `${block.top}%`,
              width: `${Math.hypot(block.width, block.height)}%`,
              opacity: shade,
              transform: `rotate(${block.angle}deg)`,
            }}
          />
        );
      })}
      {blocks.map((block) => (
        <span
          className="dotplot-point"
          key={`${block.key}-point`}
          style={{
            left: `${block.left}%`,
            top: `${block.top}%`,
          }}
        />
      ))}
      {blocks.length === 0 ? <p>{emptyLabel}</p> : null}
      {syntenyView ? (
        <small className="dotplot-range">
          {Math.round(syntenyView.viewport.xStart / 1_000_000).toLocaleString()}-
          {Math.round(syntenyView.viewport.xEnd / 1_000_000).toLocaleString()} Mb
        </small>
      ) : null}
    </div>
  );
}

function buildDotplotBlocks(syntenyView: SyntenyView | null): DotplotBlock[] {
  const viewportWidth = Math.max(1, (syntenyView?.viewport.xEnd ?? 1) - (syntenyView?.viewport.xStart ?? 0));
  const targetStart = Math.min(...(syntenyView?.blocks.map((block) => block.targetStart) ?? [0]));
  const targetEnd = Math.max(...(syntenyView?.blocks.map((block) => block.targetEnd) ?? [1]));
  const targetSpan = Math.max(1, targetEnd - targetStart);

  return (
    syntenyView?.blocks.map((block) => {
      const x1 = ((block.visualStart - syntenyView.viewport.xStart) / viewportWidth) * 100;
      const x2 = ((block.visualEnd - syntenyView.viewport.xStart) / viewportWidth) * 100;
      const y1 = 100 - ((block.targetStart - targetStart) / targetSpan) * 100;
      const y2 = 100 - ((block.targetEnd - targetStart) / targetSpan) * 100;
      const left = Math.min(x1, x2);
      const top = Math.min(y1, y2);
      const width = Math.max(1, Math.abs(x2 - x1));
      const height = Math.max(1, Math.abs(y2 - y1));
      const angle = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;

      return {
        key: `${block.querySourceId}-${block.targetId}-${block.visualStart}-${block.targetStart}`,
        assemblyBlockId: block.assemblyBlockId,
        left,
        top,
        width,
        height,
        angle,
        strand: block.strand,
        mapq: block.mapq,
        title: `${block.querySourceId}:${block.visualStart}-${block.visualEnd} -> ${block.targetId}:${block.targetStart}-${block.targetEnd}`,
      };
    }) ?? []
  );
}
