import type { ContactMapLayoutBlock } from "./importers";
import type { PafPreviewRecord } from "./pafPreview";
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
    alignmentCount: number;
    fragments?: Array<{
      queryStart: number;
      queryEnd: number;
      targetStart: number;
      targetEnd: number;
      residueMatches: number;
      alignmentBlockLen: number;
      mapq: number;
    }>;
  }>;
  minMapq: number;
  minAlignmentLen: number;
  maxQueryGap: number;
  maxTargetGap: number;
}

interface BuildSyntenyViewRequestInput {
  pafRecords: ReadonlyArray<PafPreviewRecord>;
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
  pafRecords,
  viewport,
  layoutBlocks,
}: BuildSyntenyViewRequestInput): SyntenyViewRequest {
  return {
    viewport,
    layoutBlocks,
    pafRecords: pafRecords.map((record) => ({
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
      alignmentCount: record.alignmentCount ?? 1,
      fragments: record.fragments?.map((fragment) => ({
        queryStart: fragment.queryStart,
        queryEnd: fragment.queryEnd,
        targetStart: fragment.targetStart,
        targetEnd: fragment.targetEnd,
        residueMatches: fragment.residueMatches,
        alignmentBlockLen: fragment.alignmentBlockLen,
        mapq: fragment.mapq,
      })),
    })),
    minMapq: 0,
    minAlignmentLen: 10_000,
    maxQueryGap: 100_000,
    maxTargetGap: 100_000,
  };
}

export function buildBrowserSyntenyView(request: SyntenyViewRequest): SyntenyView {
  const layoutBlocksBySource = new Map<string, ContactMapLayoutBlock[]>();
  for (const layoutBlock of request.layoutBlocks) {
    const sourceBlocks = layoutBlocksBySource.get(layoutBlock.sourceId);
    if (sourceBlocks) {
      sourceBlocks.push(layoutBlock);
    } else {
      layoutBlocksBySource.set(layoutBlock.sourceId, [layoutBlock]);
    }
  }

  const blocks = request.pafRecords.flatMap((record) => {
    const retainedChainFragments = record.fragments?.length ? record.fragments : null;
    const fragments = retainedChainFragments ?? [{
      queryStart: record.queryStart,
      queryEnd: record.queryEnd,
      targetStart: record.targetStart,
      targetEnd: record.targetEnd,
      residueMatches: record.residueMatches,
      alignmentBlockLen: record.alignmentBlockLen,
      mapq: record.mapq,
    }];
    return fragments.flatMap((fragment) => {
      if (
        fragment.mapq < request.minMapq
        || (
          retainedChainFragments === null
          && fragment.alignmentBlockLen < request.minAlignmentLen
        )
      ) {
        return [];
      }
      const querySpan = fragment.queryEnd - fragment.queryStart;
      if (querySpan <= 0 || fragment.targetEnd <= fragment.targetStart) {
        return [];
      }
      return (layoutBlocksBySource.get(record.queryName) ?? []).flatMap((layoutBlock) => {
        const overlapStart = Math.max(fragment.queryStart, layoutBlock.sourceStart);
        const overlapEnd = Math.min(fragment.queryEnd, layoutBlock.sourceEnd);
        if (
          overlapEnd <= overlapStart
          || (
            retainedChainFragments === null
            && overlapEnd - overlapStart < request.minAlignmentLen
          )
        ) {
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

        const targetSpan = fragment.targetEnd - fragment.targetStart;
        const targetStart = fragment.targetStart
          + Math.floor((targetSpan * (overlapStart - fragment.queryStart)) / querySpan);
        const targetEnd = fragment.targetStart
          + Math.floor((targetSpan * (overlapEnd - fragment.queryStart)) / querySpan);
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
          mapq: fragment.mapq,
          alignmentCount: record.alignmentCount,
        }];
      });
    });
  });

  return { viewport: request.viewport, blocks };
}
