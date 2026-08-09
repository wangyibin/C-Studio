export interface PafPreviewRecord {
  queryName: string;
  queryStart: number;
  queryEnd: number;
  queryLength: number;
  strand: "+" | "-";
  targetName: string;
  targetStart: number;
  targetEnd: number;
  targetLength: number;
  residueMatches: number;
  alignmentBlockLen: number;
  mapq: number;
}

export interface PafSyntenyPreview {
  records: PafPreviewRecord[];
  querySpan: number;
  targetSpan: number;
  ignoredLines: number;
}

export interface PafTextSummary {
  alignmentCount: number;
  ignoredLines: number;
  queryCount: number;
  targetCount: number;
}

export function buildPafSyntenyPreview(text: string): PafSyntenyPreview {
  const records: PafPreviewRecord[] = [];
  let ignoredLines = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const columns = line.split("\t");
    if (columns.length < 12) {
      ignoredLines += 1;
      continue;
    }

    const record = parsePafRecord(columns);
    if (!record) {
      ignoredLines += 1;
      continue;
    }

    records.push(record);
  }

  return {
    records,
    querySpan: Math.max(1, ...records.map((record) => record.queryLength)),
    targetSpan: Math.max(1, ...records.map((record) => record.targetLength)),
    ignoredLines,
  };
}

export function summarizePafText(text: string): PafTextSummary {
  const preview = buildPafSyntenyPreview(text);

  return {
    alignmentCount: preview.records.length,
    ignoredLines: preview.ignoredLines,
    queryCount: new Set(preview.records.map((record) => record.queryName)).size,
    targetCount: new Set(preview.records.map((record) => record.targetName)).size,
  };
}

function parsePafRecord(columns: string[]): PafPreviewRecord | null {
  const queryLength = Number(columns[1]);
  const queryStart = Number(columns[2]);
  const queryEnd = Number(columns[3]);
  const strand = columns[4] === "-" ? "-" : "+";
  const targetLength = Number(columns[6]);
  const targetStart = Number(columns[7]);
  const targetEnd = Number(columns[8]);
  const residueMatches = Number(columns[9]);
  const alignmentBlockLen = Number(columns[10]);
  const mapq = Number(columns[11]);

  if (
    !Number.isFinite(queryLength) ||
    !Number.isFinite(queryStart) ||
    !Number.isFinite(queryEnd) ||
    !Number.isFinite(targetLength) ||
    !Number.isFinite(targetStart) ||
    !Number.isFinite(targetEnd) ||
    !Number.isFinite(residueMatches) ||
    !Number.isFinite(alignmentBlockLen) ||
    !Number.isFinite(mapq) ||
    queryStart >= queryEnd ||
    targetStart >= targetEnd
  ) {
    return null;
  }

  return {
    queryName: columns[0],
    queryStart,
    queryEnd,
    queryLength,
    strand,
    targetName: columns[5],
    targetStart,
    targetEnd,
    targetLength,
    residueMatches,
    alignmentBlockLen,
    mapq,
  };
}
