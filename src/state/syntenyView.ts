import type { ContactMapLayoutBlock } from "./importers";
import { buildPafSyntenyPreview } from "./pafPreview";
import { buildCenteredContactViewport, type ContactViewport } from "./contactViewport";

export interface SyntenyBlockView {
  assemblyBlockId: string;
  querySourceId: string;
  visualStart: number;
  visualEnd: number;
  targetId: string;
  targetLength: number;
  targetStart: number;
  targetEnd: number;
  strand: string;
  mapq: number;
  alignmentCount: number;
}

export interface SyntenyView {
  viewport: ContactViewport;
  blocks: SyntenyBlockView[];
}

export interface SyntenyViewRequest {
  viewport: ContactViewport;
  layoutBlocks: ContactMapLayoutBlock[];
  pafRecords: Array<{
    queryName: string;
    queryLen: number;
    queryStart: number;
    queryEnd: number;
    strand: string;
    targetName: string;
    targetLen: number;
    targetStart: number;
    targetEnd: number;
    residueMatches: number;
    alignmentBlockLen: number;
    mapq: number;
  }>;
  minMapq: number;
  minAlignmentLen: number;
  maxQueryGap: number;
  maxTargetGap: number;
}

interface BuildSyntenyViewRequestInput {
  pafText: string;
  viewport: ContactViewport;
  layoutBlocks: ContactMapLayoutBlock[];
}

interface BuildSyntenyViewportInput {
  centerXMb: number;
  totalSpanBp: number;
  windowSizeBp: number;
  viewportWidthPx: number;
  viewportHeightPx: number;
}

export function buildSyntenyViewport({
  centerXMb,
  totalSpanBp,
  windowSizeBp,
  viewportWidthPx,
  viewportHeightPx,
}: BuildSyntenyViewportInput): ContactViewport {
  return buildCenteredContactViewport({
    centerMb: centerXMb,
    centerXMb,
    // Synteny has one assembly axis. Mirror X into the unused response Y
    // fields instead of coupling the view to an off-diagonal heatmap Y pan.
    centerYMb: centerXMb,
    totalSpanBp,
    windowSizeBp,
    viewportWidthPx,
    viewportHeightPx,
  });
}

export function buildSyntenyViewRequest({
  pafText,
  viewport,
  layoutBlocks,
}: BuildSyntenyViewRequestInput): SyntenyViewRequest {
  const preview = buildPafSyntenyPreview(pafText);

  return {
    viewport,
    layoutBlocks,
    pafRecords: preview.records.map((record) => ({
      queryName: record.queryName,
      queryLen: record.queryLength,
      queryStart: record.queryStart,
      queryEnd: record.queryEnd,
      strand: record.strand,
      targetName: record.targetName,
      targetLen: record.targetLength,
      targetStart: record.targetStart,
      targetEnd: record.targetEnd,
      residueMatches: record.residueMatches,
      alignmentBlockLen: record.alignmentBlockLen,
      mapq: record.mapq,
    })),
    minMapq: 0,
    minAlignmentLen: 1,
    maxQueryGap: 100_000,
    maxTargetGap: 100_000,
  };
}

export function buildBrowserSyntenyView(request: SyntenyViewRequest): SyntenyView {
  const blocks = request.pafRecords.flatMap((record) => {
    if (record.mapq < request.minMapq || record.alignmentBlockLen < request.minAlignmentLen) {
      return [];
    }

    const querySpan = record.queryEnd - record.queryStart;
    if (querySpan <= 0 || record.targetEnd <= record.targetStart) {
      return [];
    }

    return request.layoutBlocks.flatMap((layoutBlock) => {
      if (layoutBlock.sourceId !== record.queryName) {
        return [];
      }

      const overlapStart = Math.max(record.queryStart, layoutBlock.sourceStart);
      const overlapEnd = Math.min(record.queryEnd, layoutBlock.sourceEnd);
      if (overlapEnd - overlapStart < request.minAlignmentLen) {
        return [];
      }

      const visualStart = layoutBlock.orientation === "-"
        ? layoutBlock.visualStart + layoutBlock.sourceEnd - overlapEnd
        : layoutBlock.visualStart + overlapStart - layoutBlock.sourceStart;
      const visualEnd = layoutBlock.orientation === "-"
        ? layoutBlock.visualStart + layoutBlock.sourceEnd - overlapStart
        : layoutBlock.visualStart + overlapEnd - layoutBlock.sourceStart;
      if (visualEnd <= request.viewport.xStart || visualStart >= request.viewport.xEnd) {
        return [];
      }

      const targetSpan = record.targetEnd - record.targetStart;
      const targetStart = record.targetStart
        + Math.floor((targetSpan * (overlapStart - record.queryStart)) / querySpan);
      const targetEnd = record.targetStart
        + Math.floor((targetSpan * (overlapEnd - record.queryStart)) / querySpan);
      const strand = layoutBlock.orientation === "-"
        ? record.strand === "+" ? "-" : record.strand === "-" ? "+" : record.strand
        : record.strand;

      return [{
        assemblyBlockId: layoutBlock.id,
        querySourceId: record.queryName,
        visualStart,
        visualEnd,
        targetId: record.targetName,
        targetLength: record.targetLen,
        targetStart,
        targetEnd,
        strand,
        mapq: record.mapq,
        alignmentCount: 1,
      }];
    });
  });

  return { viewport: request.viewport, blocks };
}
