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
  alignmentType?: "primary" | "secondary" | "inversion" | "other";
  editDistance?: number;
  cigar?: string;
  differenceString?: string;
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
  const optionalTags = parseOptionalTags(columns.slice(12));

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

  const record: PafPreviewRecord = {
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
  const alignmentType = pafAlignmentType(optionalTags.get("tp")?.value);
  const editDistance = optionalTags.get("NM");
  const cigar = optionalTags.get("cg");
  const differenceString = optionalTags.get("cs");
  if (alignmentType) record.alignmentType = alignmentType;
  if (editDistance?.type === "i" && Number.isFinite(Number(editDistance.value))) {
    record.editDistance = Number(editDistance.value);
  }
  if (cigar?.type === "Z") record.cigar = cigar.value;
  if (differenceString?.type === "Z") record.differenceString = differenceString.value;
  return record;
}

function parseOptionalTags(columns: ReadonlyArray<string>) {
  const tags = new Map<string, { type: string; value: string }>();
  for (const column of columns) {
    const firstSeparator = column.indexOf(":");
    const secondSeparator = column.indexOf(":", firstSeparator + 1);
    if (firstSeparator <= 0 || secondSeparator <= firstSeparator + 1) {
      continue;
    }
    tags.set(column.slice(0, firstSeparator), {
      type: column.slice(firstSeparator + 1, secondSeparator),
      value: column.slice(secondSeparator + 1),
    });
  }
  return tags;
}

function pafAlignmentType(value: string | undefined): PafPreviewRecord["alignmentType"] {
  if (value === "P") return "primary";
  if (value === "S") return "secondary";
  if (value === "I") return "inversion";
  return value === undefined ? undefined : "other";
}
