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
  alignmentCount?: number;
  fragments?: PafPreviewFragment[];
}

export interface PafPreviewFragment {
  queryStart: number;
  queryEnd: number;
  targetStart: number;
  targetEnd: number;
  residueMatches: number;
  alignmentBlockLen: number;
  mapq: number;
  alignmentType?: PafPreviewRecord["alignmentType"];
  editDistance?: number;
}

export interface PafSyntenyPreview {
  records: PafPreviewRecord[];
  querySpan: number;
  targetSpan: number;
  ignoredLines: number;
  inputAlignmentCount: number;
  retainedAlignmentCount: number;
  discardedAlignmentCount: number;
}

export interface PafTextSummary {
  alignmentCount: number;
  ignoredLines: number;
  queryCount: number;
  targetCount: number;
  chainCount: number;
  discardedAlignmentCount: number;
}

export interface PreparedPafSummary extends PafTextSummary {
  retainedAlignmentCount: number;
}

export interface PreparedPafFile {
  path: string;
  name: string;
  sizeBytes: number;
  cacheHit: boolean;
  summary: PreparedPafSummary;
  records: PafPreviewRecord[];
}

export const minimumPafAlignmentBp = 10_000;
export const maximumPafChainOverlapBp = 1_000;
export const minimumPafSecondaryChainRatio = 0.2;

export function buildPafSyntenyPreview(
  text: string,
  minimumAlignmentLen = minimumPafAlignmentBp,
): PafSyntenyPreview {
  const inputRecords: PafPreviewRecord[] = [];
  let ignoredLines = 0;
  let querySpan = 1;
  let targetSpan = 1;

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

    inputRecords.push(record);
    querySpan = Math.max(querySpan, record.queryLength);
    targetSpan = Math.max(targetSpan, record.targetLength);
  }

  const records = consolidatePafSplitAlignments(inputRecords, minimumAlignmentLen);
  const retainedAlignmentCount = records.reduce(
    (sum, record) => sum + (record.alignmentCount ?? 1),
    0,
  );

  return {
    records,
    querySpan,
    targetSpan,
    ignoredLines,
    inputAlignmentCount: inputRecords.length,
    retainedAlignmentCount,
    discardedAlignmentCount: inputRecords.length - retainedAlignmentCount,
  };
}

export function summarizePafText(text: string): PafTextSummary {
  return summarizePafPreview(buildPafSyntenyPreview(text));
}

export function summarizePafPreview(preview: PafSyntenyPreview): PafTextSummary {
  return {
    alignmentCount: preview.inputAlignmentCount,
    ignoredLines: preview.ignoredLines,
    queryCount: new Set(preview.records.map((record) => record.queryName)).size,
    targetCount: new Set(preview.records.map((record) => record.targetName)).size,
    chainCount: preview.records.length,
    discardedAlignmentCount: preview.discardedAlignmentCount,
  };
}

interface PafChainState {
  predecessor: number;
  targetAlignedSpan: number;
  residueMatches: number;
  alignmentBlockLen: number;
  mapqWeight: number;
  fragmentCount: number;
}

interface PafChainSegment {
  record: PafPreviewRecord;
  orientedTargetStart: number;
  orientedTargetEnd: number;
  effectiveQueryEnd: number;
  effectiveOrientedTargetEnd: number;
  stateIndex: number;
}

interface PafChainResult {
  records: PafPreviewRecord[];
  state: PafChainState;
}

interface PafQueryIntervalCandidate {
  id: number;
  chainIndex: number;
  fragmentIndex: number;
  chain: PafPreviewRecord;
  fragment: PafPreviewFragment;
}

interface SelectedPafQueryInterval {
  candidate: PafQueryIntervalCandidate;
  queryStart: number;
  queryEnd: number;
}

/**
 * Collapse split PAF alignments before they reach recommendation analysis or
 * the dotplot. All valid fragments first participate in forward/reverse
 * weighted LIS, then only chains with at least `minimumAlignmentLen` total
 * target-aligned support survive. This lets short, collinear fragments extend
 * a strong chain without allowing a short fragment to survive as its own
 * noise chain. The original chain fragments stay attached to the merged record
 * so coverage and identity calculations do not turn unaligned gaps into
 * observed sequence.
 */
export function consolidatePafSplitAlignments(
  records: ReadonlyArray<PafPreviewRecord>,
  minimumAlignmentLen = minimumPafAlignmentBp,
): PafPreviewRecord[] {
  const byPair = new Map<string, PafPreviewRecord[]>();
  for (const record of records) {
    const key = `${record.queryName}\u0000${record.targetName}`;
    const values = byPair.get(key) ?? [];
    values.push(record);
    byPair.set(key, values);
  }

  const consolidated: PafPreviewRecord[] = [];
  for (const pairRecords of byPair.values()) {
    const forward = bestPafCollinearChain(
      pairRecords.filter((record) => record.strand === "+"),
    );
    const reverse = bestPafCollinearChain(
      pairRecords.filter((record) => record.strand === "-"),
    );
    const best = betterPafChainResult(forward, reverse);
    if (best) {
      const chain = mergePafChain(best.records);
      if (pafChainTargetAlignedSpan(chain) >= minimumAlignmentLen) {
        consolidated.push(chain);
      }
    }
  }

  const globallySupported = retainHapHiCGlobalQueryChains(consolidated);
  return retainBestPafQueryIntervals(globallySupported).sort((left, right) => (
    left.queryName.localeCompare(right.queryName)
    || left.targetName.localeCompare(right.targetName)
    || left.queryStart - right.queryStart
    || left.targetStart - right.targetStart
  ));
}

/**
 * Adapt HapHiC's global-chaining support filter to dotplot records. For each
 * query, retain the best query-target chain and secondary chains whose summed
 * target-aligned span is at least 20% of the best chain. The later interval
 * arbitration still decides the single winner wherever retained chains overlap
 * on the query, so disjoint query intervals can map to different targets.
 */
export function retainHapHiCGlobalQueryChains(
  chains: ReadonlyArray<PafPreviewRecord>,
): PafPreviewRecord[] {
  const bestScoreByQuery = new Map<string, number>();
  for (const chain of chains) {
    const score = pafChainTargetAlignedSpan(chain);
    bestScoreByQuery.set(
      chain.queryName,
      Math.max(bestScoreByQuery.get(chain.queryName) ?? 0, score),
    );
  }

  return chains.filter((chain) => {
    const bestScore = bestScoreByQuery.get(chain.queryName) ?? 0;
    const score = pafChainTargetAlignedSpan(chain);
    return bestScore === 0 || score >= bestScore * minimumPafSecondaryChainRatio;
  });
}

function pafChainTargetAlignedSpan(chain: PafPreviewRecord) {
  return pafRecordFragments(chain).reduce(
    (sum, fragment) => sum + Math.max(0, fragment.targetEnd - fragment.targetStart),
    0,
  );
}

/**
 * Resolve cross-target competition at query-interval resolution. Different,
 * non-overlapping parts of one query may still map to different targets. When
 * candidates cover the same half-open query interval, only the candidate with
 * the strongest MAPQ, identity, and aligned-residue evidence survives.
 */
export function retainBestPafQueryIntervals(
  chains: ReadonlyArray<PafPreviewRecord>,
): PafPreviewRecord[] {
  const candidatesByQuery = new Map<string, PafQueryIntervalCandidate[]>();
  let nextCandidateId = 0;
  for (let chainIndex = 0; chainIndex < chains.length; chainIndex += 1) {
    const chain = chains[chainIndex];
    const fragments = pafRecordFragments(chain);
    for (let fragmentIndex = 0; fragmentIndex < fragments.length; fragmentIndex += 1) {
      const fragment = fragments[fragmentIndex];
      if (fragment.queryEnd <= fragment.queryStart || fragment.targetEnd <= fragment.targetStart) {
        continue;
      }
      const values = candidatesByQuery.get(chain.queryName) ?? [];
      values.push({
        id: nextCandidateId,
        chainIndex,
        fragmentIndex,
        chain,
        fragment,
      });
      nextCandidateId += 1;
      candidatesByQuery.set(chain.queryName, values);
    }
  }

  const selectedByChain = new Map<number, SelectedPafQueryInterval[]>();
  for (const candidates of candidatesByQuery.values()) {
    const events = new Map<number, {
      starts: PafQueryIntervalCandidate[];
      ends: PafQueryIntervalCandidate[];
    }>();
    for (const candidate of candidates) {
      const startEvent = events.get(candidate.fragment.queryStart) ?? { starts: [], ends: [] };
      startEvent.starts.push(candidate);
      events.set(candidate.fragment.queryStart, startEvent);
      const endEvent = events.get(candidate.fragment.queryEnd) ?? { starts: [], ends: [] };
      endEvent.ends.push(candidate);
      events.set(candidate.fragment.queryEnd, endEvent);
    }
    const boundaries = [...events.keys()].sort((left, right) => left - right);
    const active = new Map<number, PafQueryIntervalCandidate>();
    let previousSelection: SelectedPafQueryInterval | null = null;
    for (let index = 0; index + 1 < boundaries.length; index += 1) {
      const queryStart = boundaries[index];
      const event = events.get(queryStart);
      for (const candidate of event?.ends ?? []) active.delete(candidate.id);
      for (const candidate of event?.starts ?? []) active.set(candidate.id, candidate);
      const queryEnd = boundaries[index + 1];
      if (queryEnd <= queryStart || active.size === 0) {
        previousSelection = null;
        continue;
      }
      let winner: PafQueryIntervalCandidate | null = null;
      for (const candidate of active.values()) {
        if (!winner || comparePafQueryIntervalCandidates(candidate, winner) > 0) {
          winner = candidate;
        }
      }
      if (!winner) {
        previousSelection = null;
        continue;
      }
      if (
        previousSelection?.candidate.id === winner.id
        && previousSelection.queryEnd === queryStart
      ) {
        previousSelection.queryEnd = queryEnd;
        continue;
      }
      const selection: SelectedPafQueryInterval = { candidate: winner, queryStart, queryEnd };
      const chainSelections = selectedByChain.get(winner.chainIndex) ?? [];
      chainSelections.push(selection);
      selectedByChain.set(winner.chainIndex, chainSelections);
      previousSelection = selection;
    }
  }

  return [...selectedByChain.entries()]
    .sort(([left], [right]) => left - right)
    .map(([chainIndex, selections]) => mergeSelectedPafQueryIntervals(
      chains[chainIndex],
      selections,
    ));
}

function pafRecordFragments(record: PafPreviewRecord): PafPreviewFragment[] {
  return record.fragments ?? [{
    queryStart: record.queryStart,
    queryEnd: record.queryEnd,
    targetStart: record.targetStart,
    targetEnd: record.targetEnd,
    residueMatches: record.residueMatches,
    alignmentBlockLen: record.alignmentBlockLen,
    mapq: record.mapq,
    alignmentType: record.alignmentType,
    editDistance: record.editDistance,
  }];
}

function comparePafQueryIntervalCandidates(
  left: PafQueryIntervalCandidate,
  right: PafQueryIntervalCandidate,
) {
  const identityComparison = left.fragment.residueMatches * right.fragment.alignmentBlockLen
    - right.fragment.residueMatches * left.fragment.alignmentBlockLen;
  return left.fragment.mapq - right.fragment.mapq
    || identityComparison
    || left.fragment.residueMatches - right.fragment.residueMatches
    || left.fragment.alignmentBlockLen - right.fragment.alignmentBlockLen
    || right.chain.targetName.localeCompare(left.chain.targetName)
    || right.chain.strand.localeCompare(left.chain.strand)
    || right.fragment.targetStart - left.fragment.targetStart
    || right.id - left.id;
}

function mergeSelectedPafQueryIntervals(
  chain: PafPreviewRecord,
  selections: ReadonlyArray<SelectedPafQueryInterval>,
): PafPreviewRecord {
  const fragments = selections.map((selection) => trimPafFragmentToQueryInterval(
    selection.candidate.fragment,
    chain.strand,
    selection.queryStart,
    selection.queryEnd,
  ));
  const retainedOriginalFragments = new Set(
    selections.map((selection) => selection.candidate.fragmentIndex),
  ).size;
  const editDistances = fragments
    .map((fragment) => fragment.editDistance)
    .filter((value): value is number => value !== undefined);
  const preservesSingleOriginalFragment = selections.length === 1
    && selections[0].queryStart === selections[0].candidate.fragment.queryStart
    && selections[0].queryEnd === selections[0].candidate.fragment.queryEnd
    && pafRecordFragments(chain).length === 1;
  return {
    ...chain,
    queryStart: Math.min(...fragments.map((fragment) => fragment.queryStart)),
    queryEnd: Math.max(...fragments.map((fragment) => fragment.queryEnd)),
    targetStart: Math.min(...fragments.map((fragment) => fragment.targetStart)),
    targetEnd: Math.max(...fragments.map((fragment) => fragment.targetEnd)),
    residueMatches: fragments.reduce((sum, fragment) => sum + fragment.residueMatches, 0),
    alignmentBlockLen: fragments.reduce(
      (sum, fragment) => sum + fragment.alignmentBlockLen,
      0,
    ),
    mapq: Math.min(...fragments.map((fragment) => fragment.mapq)),
    alignmentCount: retainedOriginalFragments,
    fragments,
    editDistance: editDistances.length === fragments.length
      ? editDistances.reduce((sum, value) => sum + value, 0)
      : undefined,
    cigar: preservesSingleOriginalFragment ? chain.cigar : undefined,
    differenceString: preservesSingleOriginalFragment ? chain.differenceString : undefined,
  };
}

function trimPafFragmentToQueryInterval(
  fragment: PafPreviewFragment,
  strand: "+" | "-",
  queryStart: number,
  queryEnd: number,
): PafPreviewFragment {
  const querySpan = fragment.queryEnd - fragment.queryStart;
  const targetSpan = fragment.targetEnd - fragment.targetStart;
  const startOffset = queryStart - fragment.queryStart;
  const endOffset = queryEnd - fragment.queryStart;
  const firstTargetBoundary = strand === "+"
    ? fragment.targetStart + Math.floor((targetSpan * startOffset) / querySpan)
    : fragment.targetEnd - Math.floor((targetSpan * startOffset) / querySpan);
  const secondTargetBoundary = strand === "+"
    ? fragment.targetStart + Math.floor((targetSpan * endOffset) / querySpan)
    : fragment.targetEnd - Math.floor((targetSpan * endOffset) / querySpan);
  let targetStart = Math.min(firstTargetBoundary, secondTargetBoundary);
  let targetEnd = Math.max(firstTargetBoundary, secondTargetBoundary);
  if (targetStart >= targetEnd) {
    if (targetStart > fragment.targetStart) targetStart -= 1;
    else targetEnd = Math.min(fragment.targetEnd, targetStart + 1);
  }
  const selectedQuerySpan = queryEnd - queryStart;
  return {
    ...fragment,
    queryStart,
    queryEnd,
    targetStart,
    targetEnd,
    residueMatches: scalePafFragmentField(
      fragment.residueMatches,
      selectedQuerySpan,
      querySpan,
    ),
    alignmentBlockLen: scalePafFragmentField(
      fragment.alignmentBlockLen,
      selectedQuerySpan,
      querySpan,
    ),
    editDistance: fragment.editDistance === undefined
      ? undefined
      : scalePafFragmentField(fragment.editDistance, selectedQuerySpan, querySpan, false),
  };
}

function scalePafFragmentField(
  value: number,
  selectedSpan: number,
  originalSpan: number,
  preservePositive = true,
) {
  const scaled = Math.round((value * selectedSpan) / originalSpan);
  return preservePositive && value > 0 ? Math.max(1, scaled) : Math.max(0, scaled);
}

function bestPafCollinearChain(
  records: ReadonlyArray<PafPreviewRecord>,
): PafChainResult | null {
  if (records.length === 0) {
    return null;
  }
  const segments: PafChainSegment[] = records.map((record) => {
    const orientedTargetStart = record.strand === "+"
      ? record.targetStart
      : Math.max(0, record.targetLength - record.targetEnd);
    const orientedTargetEnd = record.strand === "+"
      ? record.targetEnd
      : Math.max(0, record.targetLength - record.targetStart);
    const queryOverlap = Math.min(
      maximumPafChainOverlapBp,
      Math.floor((record.queryEnd - record.queryStart) / 2),
    );
    const targetOverlap = Math.min(
      maximumPafChainOverlapBp,
      Math.floor((orientedTargetEnd - orientedTargetStart) / 2),
    );
    return {
      record,
      orientedTargetStart,
      orientedTargetEnd,
      effectiveQueryEnd: record.queryEnd - queryOverlap,
      effectiveOrientedTargetEnd: orientedTargetEnd - targetOverlap,
      stateIndex: -1,
    };
  }).sort((left, right) => (
    left.record.queryStart - right.record.queryStart
    || left.record.queryEnd - right.record.queryEnd
    || left.orientedTargetStart - right.orientedTargetStart
    || left.orientedTargetEnd - right.orientedTargetEnd
  ));
  const targetEnds = [...new Set(segments.map(
    (segment) => segment.effectiveOrientedTargetEnd,
  ))]
    .sort((left, right) => left - right);
  const byQueryEnd = [...segments].sort((left, right) => (
    left.effectiveQueryEnd - right.effectiveQueryEnd
    || left.record.queryStart - right.record.queryStart
  ));
  const states: PafChainState[] = [];
  const bestEndingAtTarget = new Array<number>(targetEnds.length + 1).fill(-1);
  let eligibleEndIndex = 0;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    while (
      eligibleEndIndex < byQueryEnd.length
      && byQueryEnd[eligibleEndIndex].effectiveQueryEnd <= segment.record.queryStart
    ) {
      const predecessor = byQueryEnd[eligibleEndIndex];
      if (predecessor.stateIndex >= 0) {
        updatePafChainFenwick(
          bestEndingAtTarget,
          lowerBound(targetEnds, predecessor.effectiveOrientedTargetEnd) + 1,
          predecessor.stateIndex,
          states,
        );
      }
      eligibleEndIndex += 1;
    }

    const predecessor = queryPafChainFenwick(
      bestEndingAtTarget,
      upperBound(targetEnds, segment.orientedTargetStart),
      states,
    );
    const previous = predecessor >= 0 ? states[predecessor] : null;
    const alignmentCount = segment.record.alignmentCount ?? 1;
    states.push({
      predecessor,
      targetAlignedSpan: (previous?.targetAlignedSpan ?? 0)
        + Math.max(0, segment.record.targetEnd - segment.record.targetStart),
      residueMatches: (previous?.residueMatches ?? 0) + segment.record.residueMatches,
      alignmentBlockLen: (previous?.alignmentBlockLen ?? 0) + segment.record.alignmentBlockLen,
      mapqWeight: (previous?.mapqWeight ?? 0)
        + segment.record.mapq * segment.record.alignmentBlockLen,
      fragmentCount: (previous?.fragmentCount ?? 0) + alignmentCount,
    });
    segment.stateIndex = index;
  }

  let bestState = -1;
  for (let index = 0; index < states.length; index += 1) {
    bestState = betterPafChainStateIndex(bestState, index, states);
  }
  const chain: PafPreviewRecord[] = [];
  for (let index = bestState; index >= 0; index = states[index].predecessor) {
    chain.push(segments[index].record);
  }
  chain.reverse();
  return { records: chain, state: states[bestState] };
}

function betterPafChainResult(
  left: PafChainResult | null,
  right: PafChainResult | null,
) {
  if (!left) return right;
  if (!right) return left;
  return comparePafChainStates(left.state, right.state) >= 0 ? left : right;
}

function comparePafChainStates(left: PafChainState, right: PafChainState) {
  return left.targetAlignedSpan - right.targetAlignedSpan
    || left.residueMatches - right.residueMatches
    || left.alignmentBlockLen - right.alignmentBlockLen
    || left.mapqWeight - right.mapqWeight
    || right.fragmentCount - left.fragmentCount;
}

function betterPafChainStateIndex(
  left: number,
  right: number,
  states: ReadonlyArray<PafChainState>,
) {
  if (left < 0) return right;
  if (right < 0) return left;
  return comparePafChainStates(states[left], states[right]) >= 0 ? left : right;
}

function updatePafChainFenwick(
  tree: number[],
  startIndex: number,
  stateIndex: number,
  states: ReadonlyArray<PafChainState>,
) {
  for (let index = startIndex; index < tree.length; index += index & -index) {
    tree[index] = betterPafChainStateIndex(tree[index], stateIndex, states);
  }
}

function queryPafChainFenwick(
  tree: ReadonlyArray<number>,
  endIndex: number,
  states: ReadonlyArray<PafChainState>,
) {
  let best = -1;
  for (let index = endIndex; index > 0; index -= index & -index) {
    best = betterPafChainStateIndex(best, tree[index], states);
  }
  return best;
}

function lowerBound(values: ReadonlyArray<number>, value: number) {
  let left = 0;
  let right = values.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (values[middle] < value) left = middle + 1;
    else right = middle;
  }
  return left;
}

function upperBound(values: ReadonlyArray<number>, value: number) {
  let left = 0;
  let right = values.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (values[middle] <= value) left = middle + 1;
    else right = middle;
  }
  return left;
}

function mergePafChain(records: ReadonlyArray<PafPreviewRecord>): PafPreviewRecord {
  const first = records[0];
  const fragments = records.flatMap((record): PafPreviewFragment[] => (
    record.fragments ?? [{
      queryStart: record.queryStart,
      queryEnd: record.queryEnd,
      targetStart: record.targetStart,
      targetEnd: record.targetEnd,
      residueMatches: record.residueMatches,
      alignmentBlockLen: record.alignmentBlockLen,
      mapq: record.mapq,
      alignmentType: record.alignmentType,
      editDistance: record.editDistance,
    }]
  ));
  const alignmentType = records.some((record) => record.alignmentType === "primary")
    ? "primary"
    : records.find((record) => record.alignmentType !== undefined)?.alignmentType;
  const editDistances = records
    .map((record) => record.editDistance)
    .filter((value): value is number => value !== undefined);
  return {
    queryName: first.queryName,
    queryStart: Math.min(...records.map((record) => record.queryStart)),
    queryEnd: Math.max(...records.map((record) => record.queryEnd)),
    queryLength: Math.max(...records.map((record) => record.queryLength)),
    strand: first.strand,
    targetName: first.targetName,
    targetStart: Math.min(...records.map((record) => record.targetStart)),
    targetEnd: Math.max(...records.map((record) => record.targetEnd)),
    targetLength: Math.max(...records.map((record) => record.targetLength)),
    residueMatches: records.reduce((sum, record) => sum + record.residueMatches, 0),
    alignmentBlockLen: records.reduce((sum, record) => sum + record.alignmentBlockLen, 0),
    mapq: Math.min(...records.map((record) => record.mapq)),
    alignmentCount: records.reduce((sum, record) => sum + (record.alignmentCount ?? 1), 0),
    fragments,
    alignmentType,
    editDistance: editDistances.length === records.length
      ? editDistances.reduce((sum, value) => sum + value, 0)
      : undefined,
    cigar: records.length === 1 ? first.cigar : undefined,
    differenceString: records.length === 1 ? first.differenceString : undefined,
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
    alignmentCount: 1,
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
