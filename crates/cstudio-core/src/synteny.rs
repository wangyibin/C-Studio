use std::collections::{BTreeMap, HashMap, HashSet};

use crate::{
    agp::Orientation,
    contact_map::{LayoutBlock, Viewport},
    CStudioError, CStudioResult,
};

#[derive(Debug, Clone, PartialEq)]
pub struct SyntenyQuery {
    pub viewport: Viewport,
    pub layout_blocks: Vec<LayoutBlock>,
    pub min_mapq: u8,
    pub min_alignment_len: u64,
    pub max_query_gap: u64,
    pub max_target_gap: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PafAlignmentType {
    Primary,
    Secondary,
    Inversion,
    Other,
}

impl PafAlignmentType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Primary => "primary",
            Self::Secondary => "secondary",
            Self::Inversion => "inversion",
            Self::Other => "other",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PafFragment {
    pub query_start: u64,
    pub query_end: u64,
    pub target_start: u64,
    pub target_end: u64,
    pub residue_matches: u64,
    pub alignment_block_len: u64,
    pub mapq: u8,
    pub alignment_type: Option<PafAlignmentType>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PafRecord {
    pub query_name: String,
    pub query_len: u64,
    pub query_start: u64,
    pub query_end: u64,
    pub strand: char,
    pub target_name: String,
    pub target_len: u64,
    pub target_start: u64,
    pub target_end: u64,
    pub residue_matches: u64,
    pub alignment_block_len: u64,
    pub mapq: u8,
    pub alignment_type: Option<PafAlignmentType>,
    pub alignment_count: usize,
    pub fragments: Vec<PafFragment>,
}

impl PafRecord {
    pub fn parse_line(line: &str) -> CStudioResult<Option<Self>> {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            return Ok(None);
        }

        let columns: Vec<&str> = line.split_whitespace().collect();
        if columns.len() < 12 {
            return Err(CStudioError::InvalidContactMapQuery(
                "PAF line must contain at least 12 columns".to_string(),
            ));
        }

        let strand = columns[4].chars().next().ok_or_else(|| {
            CStudioError::InvalidContactMapQuery("PAF strand cannot be empty".to_string())
        })?;
        if strand != '+' && strand != '-' {
            return Err(CStudioError::InvalidContactMapQuery(
                "PAF strand must be + or -".to_string(),
            ));
        }

        let alignment_type = columns[12..]
            .iter()
            .find_map(|column| column.strip_prefix("tp:A:"))
            .map(|value| match value {
                "P" => PafAlignmentType::Primary,
                "S" => PafAlignmentType::Secondary,
                "I" => PafAlignmentType::Inversion,
                _ => PafAlignmentType::Other,
            });

        Ok(Some(Self {
            query_name: columns[0].to_string(),
            query_len: parse_u64(columns[1], "PAF query length")?,
            query_start: parse_u64(columns[2], "PAF query start")?,
            query_end: parse_u64(columns[3], "PAF query end")?,
            strand,
            target_name: columns[5].to_string(),
            target_len: parse_u64(columns[6], "PAF target length")?,
            target_start: parse_u64(columns[7], "PAF target start")?,
            target_end: parse_u64(columns[8], "PAF target end")?,
            residue_matches: parse_u64(columns[9], "PAF residue matches")?,
            alignment_block_len: parse_u64(columns[10], "PAF alignment block length")?,
            mapq: columns[11].parse::<u8>().map_err(|_| {
                CStudioError::InvalidContactMapQuery("PAF mapq must be an integer".to_string())
            })?,
            alignment_type,
            alignment_count: 1,
            fragments: Vec::new(),
        }))
    }
}

pub const MINIMUM_PAF_ALIGNMENT_BP: u64 = 10_000;
pub const MAXIMUM_PAF_CHAIN_OVERLAP_BP: u64 = 1_000;
pub const MINIMUM_PAF_SECONDARY_CHAIN_RATIO_NUMERATOR: u128 = 1;
pub const MINIMUM_PAF_SECONDARY_CHAIN_RATIO_DENOMINATOR: u128 = 5;

#[derive(Debug, Clone, Copy)]
struct PafChainState {
    predecessor: Option<usize>,
    target_aligned_span: u128,
    residue_matches: u128,
    alignment_block_len: u128,
    mapq_weight: u128,
    fragment_count: usize,
}

#[derive(Debug, Clone)]
struct PafChainSegment {
    record: PafRecord,
    oriented_target_start: u64,
    oriented_target_end: u64,
    effective_query_end: u64,
    effective_oriented_target_end: u64,
}

/// Retain one best collinear split-alignment chain per directed query-target
/// pair. All valid fragments first participate in forward/reverse weighted LIS,
/// then only chains with at least `minimum_alignment_len` total target-aligned
/// support survive. Short collinear fragments can therefore extend a strong
/// chain but cannot survive independently as short noise chains. Adjacent chain
/// fragments may overlap by up to 1 kb, capped at half of either fragment's
/// span.
pub fn consolidate_paf_split_alignments(records: Vec<PafRecord>) -> Vec<PafRecord> {
    consolidate_paf_split_alignments_with_minimum(records, MINIMUM_PAF_ALIGNMENT_BP)
}

fn consolidate_paf_split_alignments_with_minimum(
    records: Vec<PafRecord>,
    minimum_alignment_len: u64,
) -> Vec<PafRecord> {
    let mut by_pair: HashMap<(String, String), Vec<PafRecord>> = HashMap::new();
    for record in records {
        by_pair
            .entry((record.query_name.clone(), record.target_name.clone()))
            .or_default()
            .push(record);
    }

    let mut consolidated = Vec::with_capacity(by_pair.len());
    for pair_records in by_pair.into_values() {
        let (forward, reverse): (Vec<_>, Vec<_>) = pair_records
            .into_iter()
            .partition(|record| record.strand == '+');
        let forward = best_paf_collinear_chain(forward);
        let reverse = best_paf_collinear_chain(reverse);
        let best = match (forward, reverse) {
            (Some(left), Some(right)) => {
                if compare_paf_chain_states(&left.1, &right.1).is_lt() {
                    right
                } else {
                    left
                }
            }
            (Some(chain), None) | (None, Some(chain)) => chain,
            (None, None) => continue,
        };
        let chain = merge_paf_chain(best.0);
        if paf_chain_target_aligned_span(&chain) >= u128::from(minimum_alignment_len) {
            consolidated.push(chain);
        }
    }
    let globally_supported = retain_haphic_global_query_chains(consolidated);
    let mut consolidated = retain_best_paf_query_intervals(globally_supported);
    consolidated.sort_by(|left, right| {
        (
            left.query_name.as_str(),
            left.target_name.as_str(),
            left.query_start,
            left.target_start,
        )
            .cmp(&(
                right.query_name.as_str(),
                right.target_name.as_str(),
                right.query_start,
                right.target_start,
            ))
    });
    consolidated
}

/// Adapt HapHiC's global-chain support filter to dotplot records. For each
/// query, keep the best query-target chain and secondary chains whose summed
/// target-aligned span is at least 20% of the best chain. Query-interval
/// arbitration runs afterwards, so disjoint intervals may still map to
/// different targets.
pub fn retain_haphic_global_query_chains(chains: Vec<PafRecord>) -> Vec<PafRecord> {
    let mut best_score_by_query = HashMap::<String, u128>::new();
    for chain in &chains {
        let score = paf_chain_target_aligned_span(chain);
        best_score_by_query
            .entry(chain.query_name.clone())
            .and_modify(|best| *best = (*best).max(score))
            .or_insert(score);
    }

    chains
        .into_iter()
        .filter(|chain| {
            let score = paf_chain_target_aligned_span(chain);
            let best_score = best_score_by_query
                .get(chain.query_name.as_str())
                .copied()
                .unwrap_or(0);
            best_score == 0
                || score * MINIMUM_PAF_SECONDARY_CHAIN_RATIO_DENOMINATOR
                    >= best_score * MINIMUM_PAF_SECONDARY_CHAIN_RATIO_NUMERATOR
        })
        .collect()
}

fn paf_chain_target_aligned_span(chain: &PafRecord) -> u128 {
    if chain.fragments.is_empty() {
        return u128::from(chain.target_end.saturating_sub(chain.target_start));
    }
    chain
        .fragments
        .iter()
        .map(|fragment| u128::from(fragment.target_end.saturating_sub(fragment.target_start)))
        .sum()
}

fn best_paf_collinear_chain(records: Vec<PafRecord>) -> Option<(Vec<PafRecord>, PafChainState)> {
    if records.is_empty() {
        return None;
    }
    let mut segments = records
        .into_iter()
        .map(|record| {
            let (oriented_target_start, oriented_target_end) = if record.strand == '+' {
                (record.target_start, record.target_end)
            } else {
                (
                    record.target_len.saturating_sub(record.target_end),
                    record.target_len.saturating_sub(record.target_start),
                )
            };
            let query_overlap = MAXIMUM_PAF_CHAIN_OVERLAP_BP
                .min((record.query_end.saturating_sub(record.query_start)) / 2);
            let target_overlap = MAXIMUM_PAF_CHAIN_OVERLAP_BP
                .min((oriented_target_end.saturating_sub(oriented_target_start)) / 2);
            let effective_query_end = record.query_end.saturating_sub(query_overlap);
            let effective_oriented_target_end = oriented_target_end.saturating_sub(target_overlap);
            PafChainSegment {
                record,
                oriented_target_start,
                oriented_target_end,
                effective_query_end,
                effective_oriented_target_end,
            }
        })
        .collect::<Vec<_>>();
    segments.sort_by_key(|segment| {
        (
            segment.record.query_start,
            segment.record.query_end,
            segment.oriented_target_start,
            segment.oriented_target_end,
        )
    });
    let mut target_ends = segments
        .iter()
        .map(|segment| segment.effective_oriented_target_end)
        .collect::<Vec<_>>();
    target_ends.sort_unstable();
    target_ends.dedup();
    let mut by_query_end = (0..segments.len()).collect::<Vec<_>>();
    by_query_end.sort_by_key(|index| {
        (
            segments[*index].effective_query_end,
            segments[*index].record.query_start,
        )
    });
    let mut states = Vec::<PafChainState>::with_capacity(segments.len());
    let mut best_ending_at_target = vec![None; target_ends.len() + 1];
    let mut eligible_end_index = 0;

    for (index, segment) in segments.iter().enumerate() {
        while eligible_end_index < by_query_end.len()
            && segments[by_query_end[eligible_end_index]].effective_query_end
                <= segment.record.query_start
        {
            let predecessor = by_query_end[eligible_end_index];
            update_paf_chain_fenwick(
                &mut best_ending_at_target,
                lower_bound(
                    &target_ends,
                    segments[predecessor].effective_oriented_target_end,
                ) + 1,
                predecessor,
                &states,
            );
            eligible_end_index += 1;
        }
        let predecessor = query_paf_chain_fenwick(
            &best_ending_at_target,
            upper_bound(&target_ends, segment.oriented_target_start),
            &states,
        );
        let previous = predecessor.map(|value| states[value]);
        states.push(PafChainState {
            predecessor,
            target_aligned_span: previous.map_or(0, |state| state.target_aligned_span)
                + u128::from(
                    segment
                        .record
                        .target_end
                        .saturating_sub(segment.record.target_start),
                ),
            residue_matches: previous.map_or(0, |state| state.residue_matches)
                + u128::from(segment.record.residue_matches),
            alignment_block_len: previous.map_or(0, |state| state.alignment_block_len)
                + u128::from(segment.record.alignment_block_len),
            mapq_weight: previous.map_or(0, |state| state.mapq_weight)
                + u128::from(segment.record.mapq) * u128::from(segment.record.alignment_block_len),
            fragment_count: previous.map_or(0, |state| state.fragment_count)
                + segment.record.alignment_count,
        });
        debug_assert_eq!(index, states.len() - 1);
    }

    let mut best_state = None;
    for index in 0..states.len() {
        best_state = better_paf_chain_state_index(best_state, Some(index), &states);
    }
    let best_state = best_state?;
    let mut chain = Vec::new();
    let mut cursor = Some(best_state);
    while let Some(index) = cursor {
        chain.push(segments[index].record.clone());
        cursor = states[index].predecessor;
    }
    chain.reverse();
    Some((chain, states[best_state]))
}

fn compare_paf_chain_states(left: &PafChainState, right: &PafChainState) -> std::cmp::Ordering {
    left.target_aligned_span
        .cmp(&right.target_aligned_span)
        .then_with(|| left.residue_matches.cmp(&right.residue_matches))
        .then_with(|| left.alignment_block_len.cmp(&right.alignment_block_len))
        .then_with(|| left.mapq_weight.cmp(&right.mapq_weight))
        .then_with(|| right.fragment_count.cmp(&left.fragment_count))
}

fn better_paf_chain_state_index(
    left: Option<usize>,
    right: Option<usize>,
    states: &[PafChainState],
) -> Option<usize> {
    match (left, right) {
        (Some(left), Some(right)) => {
            if compare_paf_chain_states(&states[left], &states[right]).is_lt() {
                Some(right)
            } else {
                Some(left)
            }
        }
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    }
}

#[derive(Debug, Clone)]
struct PafQueryIntervalCandidate {
    chain_index: usize,
    fragment_index: usize,
    fragment: PafFragment,
}

#[derive(Debug, Clone, Copy)]
struct SelectedPafQueryInterval {
    candidate_index: usize,
    query_start: u64,
    query_end: u64,
}

#[derive(Debug, Default)]
struct PafQueryIntervalEvents {
    starts: Vec<usize>,
    ends: Vec<usize>,
}

/// Keep at most one alignment over each half-open query interval while still
/// allowing disjoint parts of one query to map to different targets.
pub fn retain_best_paf_query_intervals(chains: Vec<PafRecord>) -> Vec<PafRecord> {
    let mut candidates = Vec::<PafQueryIntervalCandidate>::new();
    let mut candidates_by_query = HashMap::<String, Vec<usize>>::new();
    for (chain_index, chain) in chains.iter().enumerate() {
        for (fragment_index, fragment) in paf_record_fragments(chain).into_iter().enumerate() {
            if fragment.query_start >= fragment.query_end
                || fragment.target_start >= fragment.target_end
            {
                continue;
            }
            let candidate_index = candidates.len();
            candidates.push(PafQueryIntervalCandidate {
                chain_index,
                fragment_index,
                fragment,
            });
            candidates_by_query
                .entry(chain.query_name.clone())
                .or_default()
                .push(candidate_index);
        }
    }

    let mut selected_by_chain = HashMap::<usize, Vec<SelectedPafQueryInterval>>::new();
    for query_candidates in candidates_by_query.into_values() {
        let mut events = BTreeMap::<u64, PafQueryIntervalEvents>::new();
        for candidate_index in query_candidates {
            let candidate = &candidates[candidate_index];
            events
                .entry(candidate.fragment.query_start)
                .or_default()
                .starts
                .push(candidate_index);
            events
                .entry(candidate.fragment.query_end)
                .or_default()
                .ends
                .push(candidate_index);
        }
        let boundaries = events.keys().copied().collect::<Vec<_>>();
        let mut active = HashSet::<usize>::new();
        let mut previous_selection: Option<(usize, usize)> = None;
        for boundary_index in 0..boundaries.len().saturating_sub(1) {
            let query_start = boundaries[boundary_index];
            let query_end = boundaries[boundary_index + 1];
            let event = events
                .get(&query_start)
                .expect("PAF query boundary must have an event");
            for candidate_index in &event.ends {
                active.remove(candidate_index);
            }
            for candidate_index in &event.starts {
                active.insert(*candidate_index);
            }
            if query_end <= query_start || active.is_empty() {
                previous_selection = None;
                continue;
            }
            let winner = active.iter().copied().max_by(|left, right| {
                compare_paf_query_interval_candidates(
                    &candidates[*left],
                    &candidates[*right],
                    &chains,
                )
            });
            let Some(winner) = winner else {
                previous_selection = None;
                continue;
            };
            if let Some((previous_winner, previous_chain_selection)) = previous_selection {
                if previous_winner == winner {
                    let chain_index = candidates[winner].chain_index;
                    if let Some(selection) = selected_by_chain
                        .get_mut(&chain_index)
                        .and_then(|values| values.get_mut(previous_chain_selection))
                    {
                        if selection.query_end == query_start {
                            selection.query_end = query_end;
                            continue;
                        }
                    }
                }
            }
            let chain_index = candidates[winner].chain_index;
            let selections = selected_by_chain.entry(chain_index).or_default();
            let selection_index = selections.len();
            selections.push(SelectedPafQueryInterval {
                candidate_index: winner,
                query_start,
                query_end,
            });
            previous_selection = Some((winner, selection_index));
        }
    }

    let mut selected_chains = selected_by_chain.into_iter().collect::<Vec<_>>();
    selected_chains.sort_by_key(|(chain_index, _)| *chain_index);
    selected_chains
        .into_iter()
        .map(|(chain_index, selections)| {
            merge_selected_paf_query_intervals(&chains[chain_index], &selections, &candidates)
        })
        .collect()
}

fn paf_record_fragments(record: &PafRecord) -> Vec<PafFragment> {
    if record.fragments.is_empty() {
        vec![PafFragment {
            query_start: record.query_start,
            query_end: record.query_end,
            target_start: record.target_start,
            target_end: record.target_end,
            residue_matches: record.residue_matches,
            alignment_block_len: record.alignment_block_len,
            mapq: record.mapq,
            alignment_type: record.alignment_type,
        }]
    } else {
        record.fragments.clone()
    }
}

fn compare_paf_query_interval_candidates(
    left: &PafQueryIntervalCandidate,
    right: &PafQueryIntervalCandidate,
    chains: &[PafRecord],
) -> std::cmp::Ordering {
    let left_identity =
        u128::from(left.fragment.residue_matches) * u128::from(right.fragment.alignment_block_len);
    let right_identity =
        u128::from(right.fragment.residue_matches) * u128::from(left.fragment.alignment_block_len);
    left.fragment
        .mapq
        .cmp(&right.fragment.mapq)
        .then_with(|| left_identity.cmp(&right_identity))
        .then_with(|| {
            left.fragment
                .residue_matches
                .cmp(&right.fragment.residue_matches)
        })
        .then_with(|| {
            left.fragment
                .alignment_block_len
                .cmp(&right.fragment.alignment_block_len)
        })
        .then_with(|| {
            chains[right.chain_index]
                .target_name
                .cmp(&chains[left.chain_index].target_name)
        })
        .then_with(|| {
            chains[right.chain_index]
                .strand
                .cmp(&chains[left.chain_index].strand)
        })
        .then_with(|| right.fragment.target_start.cmp(&left.fragment.target_start))
        .then_with(|| right.chain_index.cmp(&left.chain_index))
        .then_with(|| right.fragment_index.cmp(&left.fragment_index))
}

fn merge_selected_paf_query_intervals(
    chain: &PafRecord,
    selections: &[SelectedPafQueryInterval],
    candidates: &[PafQueryIntervalCandidate],
) -> PafRecord {
    let fragments = selections
        .iter()
        .map(|selection| {
            trim_paf_fragment_to_query_interval(
                &candidates[selection.candidate_index].fragment,
                chain.strand,
                selection.query_start,
                selection.query_end,
            )
        })
        .collect::<Vec<_>>();
    let retained_original_fragments = selections
        .iter()
        .map(|selection| candidates[selection.candidate_index].fragment_index)
        .collect::<HashSet<_>>()
        .len();
    PafRecord {
        query_name: chain.query_name.clone(),
        query_len: chain.query_len,
        query_start: fragments
            .iter()
            .map(|fragment| fragment.query_start)
            .min()
            .unwrap_or(chain.query_start),
        query_end: fragments
            .iter()
            .map(|fragment| fragment.query_end)
            .max()
            .unwrap_or(chain.query_end),
        strand: chain.strand,
        target_name: chain.target_name.clone(),
        target_len: chain.target_len,
        target_start: fragments
            .iter()
            .map(|fragment| fragment.target_start)
            .min()
            .unwrap_or(chain.target_start),
        target_end: fragments
            .iter()
            .map(|fragment| fragment.target_end)
            .max()
            .unwrap_or(chain.target_end),
        residue_matches: fragments.iter().fold(0_u64, |sum, fragment| {
            sum.saturating_add(fragment.residue_matches)
        }),
        alignment_block_len: fragments.iter().fold(0_u64, |sum, fragment| {
            sum.saturating_add(fragment.alignment_block_len)
        }),
        mapq: fragments
            .iter()
            .map(|fragment| fragment.mapq)
            .min()
            .unwrap_or(chain.mapq),
        alignment_type: chain.alignment_type,
        alignment_count: retained_original_fragments,
        fragments,
    }
}

fn trim_paf_fragment_to_query_interval(
    fragment: &PafFragment,
    strand: char,
    query_start: u64,
    query_end: u64,
) -> PafFragment {
    let query_span = fragment.query_end - fragment.query_start;
    let target_span = fragment.target_end - fragment.target_start;
    let start_offset = query_start - fragment.query_start;
    let end_offset = query_end - fragment.query_start;
    let project_boundary = |offset: u64| {
        let projected =
            (u128::from(target_span) * u128::from(offset) / u128::from(query_span)) as u64;
        if strand == '+' {
            fragment.target_start + projected
        } else {
            fragment.target_end - projected
        }
    };
    let first_target_boundary = project_boundary(start_offset);
    let second_target_boundary = project_boundary(end_offset);
    let mut target_start = first_target_boundary.min(second_target_boundary);
    let mut target_end = first_target_boundary.max(second_target_boundary);
    if target_start >= target_end {
        if target_start > fragment.target_start {
            target_start -= 1;
        } else {
            target_end = (target_start + 1).min(fragment.target_end);
        }
    }
    let selected_span = query_end - query_start;
    PafFragment {
        query_start,
        query_end,
        target_start,
        target_end,
        residue_matches: scale_paf_fragment_field(
            fragment.residue_matches,
            selected_span,
            query_span,
        ),
        alignment_block_len: scale_paf_fragment_field(
            fragment.alignment_block_len,
            selected_span,
            query_span,
        ),
        mapq: fragment.mapq,
        alignment_type: fragment.alignment_type,
    }
}

fn scale_paf_fragment_field(value: u64, selected_span: u64, original_span: u64) -> u64 {
    let scaled = (u128::from(value) * u128::from(selected_span) + u128::from(original_span / 2))
        / u128::from(original_span);
    if value > 0 {
        (scaled as u64).max(1)
    } else {
        0
    }
}

fn update_paf_chain_fenwick(
    tree: &mut [Option<usize>],
    mut index: usize,
    state_index: usize,
    states: &[PafChainState],
) {
    while index < tree.len() {
        tree[index] = better_paf_chain_state_index(tree[index], Some(state_index), states);
        index += index & index.wrapping_neg();
    }
}

fn query_paf_chain_fenwick(
    tree: &[Option<usize>],
    mut index: usize,
    states: &[PafChainState],
) -> Option<usize> {
    let mut best = None;
    while index > 0 {
        best = better_paf_chain_state_index(best, tree[index], states);
        index -= index & index.wrapping_neg();
    }
    best
}

fn lower_bound(values: &[u64], value: u64) -> usize {
    let mut left = 0;
    let mut right = values.len();
    while left < right {
        let middle = (left + right) / 2;
        if values[middle] < value {
            left = middle + 1;
        } else {
            right = middle;
        }
    }
    left
}

fn upper_bound(values: &[u64], value: u64) -> usize {
    let mut left = 0;
    let mut right = values.len();
    while left < right {
        let middle = (left + right) / 2;
        if values[middle] <= value {
            left = middle + 1;
        } else {
            right = middle;
        }
    }
    left
}

fn merge_paf_chain(records: Vec<PafRecord>) -> PafRecord {
    let first = records.first().expect("PAF chain cannot be empty");
    let fragments = records
        .iter()
        .flat_map(paf_record_fragments)
        .collect::<Vec<_>>();
    let alignment_type = if records
        .iter()
        .any(|record| record.alignment_type == Some(PafAlignmentType::Primary))
    {
        Some(PafAlignmentType::Primary)
    } else {
        records.iter().find_map(|record| record.alignment_type)
    };
    PafRecord {
        query_name: first.query_name.clone(),
        query_len: records
            .iter()
            .map(|record| record.query_len)
            .max()
            .unwrap_or(first.query_len),
        query_start: records
            .iter()
            .map(|record| record.query_start)
            .min()
            .unwrap_or(first.query_start),
        query_end: records
            .iter()
            .map(|record| record.query_end)
            .max()
            .unwrap_or(first.query_end),
        strand: first.strand,
        target_name: first.target_name.clone(),
        target_len: records
            .iter()
            .map(|record| record.target_len)
            .max()
            .unwrap_or(first.target_len),
        target_start: records
            .iter()
            .map(|record| record.target_start)
            .min()
            .unwrap_or(first.target_start),
        target_end: records
            .iter()
            .map(|record| record.target_end)
            .max()
            .unwrap_or(first.target_end),
        residue_matches: records.iter().fold(0_u64, |sum, record| {
            sum.saturating_add(record.residue_matches)
        }),
        alignment_block_len: records.iter().fold(0_u64, |sum, record| {
            sum.saturating_add(record.alignment_block_len)
        }),
        mapq: records
            .iter()
            .map(|record| record.mapq)
            .min()
            .unwrap_or(first.mapq),
        alignment_type,
        alignment_count: records.iter().map(|record| record.alignment_count).sum(),
        fragments,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SyntenyView {
    pub viewport: Viewport,
    pub blocks: Vec<SyntenyBlock>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SyntenyBlock {
    pub assembly_block_id: String,
    pub query_source_id: String,
    pub visual_start: u64,
    pub visual_end: u64,
    pub target_id: String,
    pub target_length: u64,
    pub target_start: u64,
    pub target_end: u64,
    pub strand: char,
    pub mapq: u8,
    pub alignment_count: usize,
}

pub fn build_synteny_view<I>(query: &SyntenyQuery, records: I) -> CStudioResult<SyntenyView>
where
    I: IntoIterator<Item = PafRecord>,
{
    let mut builder = SyntenyViewBuilder::new(query)?;

    for record in records {
        builder.add_record(record)?;
    }

    Ok(builder.finish())
}

pub struct SyntenyViewBuilder<'a> {
    query: &'a SyntenyQuery,
    block_index: SyntenyBlockIndex<'a>,
    segments: Vec<SyntenyBlock>,
}

impl<'a> SyntenyViewBuilder<'a> {
    pub fn new(query: &'a SyntenyQuery) -> CStudioResult<Self> {
        validate_query(query)?;

        Ok(Self {
            query,
            block_index: SyntenyBlockIndex::new(&query.layout_blocks),
            segments: Vec::new(),
        })
    }

    pub fn add_record(&mut self, record: PafRecord) -> CStudioResult<()> {
        self.add_record_ref(&record)
    }

    pub fn add_record_ref(&mut self, record: &PafRecord) -> CStudioResult<()> {
        if !record.fragments.is_empty() {
            for fragment in &record.fragments {
                let fragment_record = PafRecord {
                    query_name: record.query_name.clone(),
                    query_len: record.query_len,
                    query_start: fragment.query_start,
                    query_end: fragment.query_end,
                    strand: record.strand,
                    target_name: record.target_name.clone(),
                    target_len: record.target_len,
                    target_start: fragment.target_start,
                    target_end: fragment.target_end,
                    residue_matches: fragment.residue_matches,
                    alignment_block_len: fragment.alignment_block_len,
                    mapq: fragment.mapq,
                    alignment_type: fragment.alignment_type,
                    alignment_count: 1,
                    fragments: Vec::new(),
                };
                self.add_record_interval(&fragment_record, false)?;
            }
            return Ok(());
        }
        self.add_record_interval(record, true)
    }

    fn add_record_interval(
        &mut self,
        record: &PafRecord,
        enforce_minimum_alignment_len: bool,
    ) -> CStudioResult<()> {
        if record.mapq < self.query.min_mapq
            || (enforce_minimum_alignment_len
                && record.alignment_block_len < self.query.min_alignment_len)
        {
            return Ok(());
        }
        if record.query_start >= record.query_end || record.target_start >= record.target_end {
            return Err(CStudioError::InvalidContactMapQuery(
                "PAF alignment start must be less than end".to_string(),
            ));
        }

        let Some(blocks) = self.block_index.by_source.get(record.query_name.as_str()) else {
            return Ok(());
        };

        for block in blocks {
            let overlap_start = record.query_start.max(block.source_start);
            let overlap_end = record.query_end.min(block.source_end);
            if overlap_start >= overlap_end {
                continue;
            }

            let Some(mut segment) = map_overlap_to_segment(
                self.query,
                block,
                record,
                overlap_start,
                overlap_end,
                enforce_minimum_alignment_len,
            ) else {
                continue;
            };
            if segment.visual_start > segment.visual_end {
                std::mem::swap(&mut segment.visual_start, &mut segment.visual_end);
            }
            if overlaps_viewport(
                self.query.viewport,
                segment.visual_start,
                segment.visual_end,
            ) {
                self.segments.push(segment);
            }
        }

        Ok(())
    }

    pub fn finish(self) -> SyntenyView {
        SyntenyView {
            viewport: self.query.viewport,
            blocks: merge_segments(self.query, self.segments),
        }
    }
}

fn map_overlap_to_segment(
    query: &SyntenyQuery,
    block: &LayoutBlock,
    record: &PafRecord,
    overlap_start: u64,
    overlap_end: u64,
    enforce_minimum_alignment_len: bool,
) -> Option<SyntenyBlock> {
    let (visual_start, visual_end) = visual_interval(block, overlap_start, overlap_end)?;
    let overlap_len = overlap_end - overlap_start;
    if enforce_minimum_alignment_len && overlap_len < query.min_alignment_len {
        return None;
    }

    let query_offset_start = overlap_start - record.query_start;
    let query_offset_end = overlap_end - record.query_start;
    let target_span = record.target_end - record.target_start;
    let query_span = record.query_end - record.query_start;
    let target_start = record.target_start + target_span * query_offset_start / query_span;
    let target_end = record.target_start + target_span * query_offset_end / query_span;
    let strand = relative_strand(record.strand, block.orientation.clone());

    Some(SyntenyBlock {
        assembly_block_id: block.id.clone(),
        query_source_id: record.query_name.clone(),
        visual_start,
        visual_end,
        target_id: record.target_name.clone(),
        target_length: record.target_len,
        target_start,
        target_end,
        strand,
        mapq: record.mapq,
        alignment_count: record.alignment_count,
    })
}

fn visual_interval(block: &LayoutBlock, source_start: u64, source_end: u64) -> Option<(u64, u64)> {
    if source_start < block.source_start
        || source_end > block.source_end
        || source_start >= source_end
    {
        return None;
    }

    let result = match block.orientation {
        Orientation::Forward | Orientation::Unknown => {
            let start = block.visual_start + (source_start - block.source_start);
            let end = block.visual_start + (source_end - block.source_start);
            (start, end)
        }
        Orientation::Reverse => {
            let start = block.visual_start + (block.source_end - source_end);
            let end = block.visual_start + (block.source_end - source_start);
            (start, end)
        }
    };

    Some(result)
}

fn merge_segments(query: &SyntenyQuery, mut segments: Vec<SyntenyBlock>) -> Vec<SyntenyBlock> {
    segments.sort_by(|a, b| {
        (
            a.assembly_block_id.as_str(),
            a.query_source_id.as_str(),
            a.target_id.as_str(),
            a.strand,
            a.visual_start,
            a.target_start,
        )
            .cmp(&(
                b.assembly_block_id.as_str(),
                b.query_source_id.as_str(),
                b.target_id.as_str(),
                b.strand,
                b.visual_start,
                b.target_start,
            ))
    });

    let mut merged: Vec<SyntenyBlock> = Vec::new();
    for segment in segments {
        if let Some(last) = merged.last_mut() {
            let query_gap = segment.visual_start.saturating_sub(last.visual_end);
            let target_gap = if segment.target_start >= last.target_end {
                segment.target_start - last.target_end
            } else {
                last.target_start.saturating_sub(segment.target_end)
            };

            if last.assembly_block_id == segment.assembly_block_id
                && last.query_source_id == segment.query_source_id
                && last.target_id == segment.target_id
                && last.strand == segment.strand
                && query_gap <= query.max_query_gap
                && target_gap <= query.max_target_gap
            {
                last.visual_end = last.visual_end.max(segment.visual_end);
                last.target_start = last.target_start.min(segment.target_start);
                last.target_end = last.target_end.max(segment.target_end);
                last.mapq = last.mapq.min(segment.mapq);
                last.alignment_count += segment.alignment_count;
                continue;
            }
        }

        merged.push(segment);
    }

    merged
}

fn validate_query(query: &SyntenyQuery) -> CStudioResult<()> {
    if query.viewport.x_start >= query.viewport.x_end {
        return Err(CStudioError::InvalidContactMapQuery(
            "viewport x_start must be less than x_end".to_string(),
        ));
    }

    for block in &query.layout_blocks {
        if block.source_id.trim().is_empty() {
            return Err(CStudioError::InvalidContactMapQuery(
                "layout block source_id cannot be empty".to_string(),
            ));
        }
        if block.source_start >= block.source_end {
            return Err(CStudioError::InvalidContactMapQuery(format!(
                "layout block {} source_start must be less than source_end",
                block.id
            )));
        }
    }

    Ok(())
}

fn overlaps_viewport(viewport: Viewport, start: u64, end: u64) -> bool {
    start < viewport.x_end && end > viewport.x_start
}

fn relative_strand(paf_strand: char, orientation: Orientation) -> char {
    match (paf_strand, orientation) {
        ('+', Orientation::Reverse) | ('-', Orientation::Forward) | ('-', Orientation::Unknown) => {
            '-'
        }
        _ => '+',
    }
}

fn parse_u64(value: &str, label: &str) -> CStudioResult<u64> {
    value
        .parse::<u64>()
        .map_err(|_| CStudioError::InvalidContactMapQuery(format!("{label} must be an integer")))
}

struct SyntenyBlockIndex<'a> {
    by_source: HashMap<&'a str, Vec<&'a LayoutBlock>>,
}

impl<'a> SyntenyBlockIndex<'a> {
    fn new(blocks: &'a [LayoutBlock]) -> Self {
        let mut by_source: HashMap<&'a str, Vec<&'a LayoutBlock>> = HashMap::new();
        for block in blocks {
            by_source
                .entry(block.source_id.as_str())
                .or_default()
                .push(block);
        }

        Self { by_source }
    }
}

#[cfg(test)]
mod tests {
    use crate::{
        agp::Orientation,
        contact_map::{LayoutBlock, Viewport},
        synteny::{
            build_synteny_view, consolidate_paf_split_alignments,
            consolidate_paf_split_alignments_with_minimum, PafAlignmentType, PafRecord,
            SyntenyQuery,
        },
    };

    #[test]
    fn parses_standard_paf_line() {
        let record = PafRecord::parse_line(
            "contig-a\t10000\t1000\t3000\t+\tmono1\t50000\t20000\t22000\t1900\t2000\t60\ttp:A:P",
        )
        .expect("valid paf")
        .expect("data record");

        assert_eq!(record.query_name, "contig-a");
        assert_eq!(record.query_start, 1_000);
        assert_eq!(record.query_end, 3_000);
        assert_eq!(record.strand, '+');
        assert_eq!(record.target_name, "mono1");
        assert_eq!(record.target_start, 20_000);
        assert_eq!(record.target_end, 22_000);
        assert_eq!(record.mapq, 60);
        assert_eq!(record.alignment_type, Some(PafAlignmentType::Primary));
    }

    #[test]
    fn uses_short_collinear_fragments_to_extend_the_best_split_chain_after_lis() {
        let records = [
            "contig-a\t10000\t0\t2000\t+\tmono1\t20000\t1000\t3000\t1900\t2000\t60",
            "contig-a\t10000\t1900\t4000\t+\tmono1\t20000\t2900\t5000\t1850\t2000\t50",
            "contig-a\t10000\t4500\t4700\t+\tmono1\t20000\t6000\t6200\t180\t200\t60",
            "contig-a\t10000\t0\t1500\t-\tmono1\t20000\t15000\t16500\t1400\t1500\t60",
        ]
        .into_iter()
        .map(|line| PafRecord::parse_line(line).unwrap().unwrap())
        .collect();

        let consolidated = consolidate_paf_split_alignments_with_minimum(records, 1_000);

        assert_eq!(consolidated.len(), 1);
        let record = &consolidated[0];
        assert_eq!(record.query_start, 0);
        assert_eq!(record.query_end, 4_700);
        assert_eq!(record.target_start, 1_000);
        assert_eq!(record.target_end, 6_200);
        assert_eq!(record.strand, '+');
        assert_eq!(record.residue_matches, 3_842);
        assert_eq!(record.alignment_block_len, 4_105);
        assert_eq!(record.alignment_count, 3);
        assert_eq!(record.fragments.len(), 3);
    }

    #[test]
    fn keeps_one_best_target_per_overlapping_query_interval() {
        let records = [
            "contig-a\t10000\t0\t3000\t+\tmono1\t20000\t1000\t4000\t2850\t3000\t10",
            "contig-a\t10000\t1000\t2000\t+\tmono2\t20000\t5000\t6000\t900\t1000\t60",
        ]
        .into_iter()
        .map(|line| PafRecord::parse_line(line).unwrap().unwrap())
        .collect();

        let consolidated = consolidate_paf_split_alignments_with_minimum(records, 1_000);

        assert_eq!(consolidated.len(), 2);
        let mono1 = consolidated
            .iter()
            .find(|record| record.target_name == "mono1")
            .unwrap();
        assert_eq!(
            mono1
                .fragments
                .iter()
                .map(|fragment| (fragment.query_start, fragment.query_end))
                .collect::<Vec<_>>(),
            vec![(0, 1_000), (2_000, 3_000)]
        );
        let mono2 = consolidated
            .iter()
            .find(|record| record.target_name == "mono2")
            .unwrap();
        assert_eq!(
            mono2
                .fragments
                .iter()
                .map(|fragment| (fragment.query_start, fragment.query_end))
                .collect::<Vec<_>>(),
            vec![(1_000, 2_000)]
        );
    }

    #[test]
    fn removes_sub_10kb_chains_after_lis_before_interval_arbitration() {
        let records = [
            "contig-a\t100000\t0\t10000\t+\tmono1\t200000\t10000\t20000\t9500\t10000\t10",
            "contig-a\t100000\t0\t9000\t+\tmono2\t200000\t50000\t59000\t8900\t9000\t60",
        ]
        .into_iter()
        .map(|line| PafRecord::parse_line(line).unwrap().unwrap())
        .collect();

        let consolidated = consolidate_paf_split_alignments(records);

        assert_eq!(consolidated.len(), 1);
        assert_eq!(consolidated[0].target_name, "mono1");
        assert_eq!(consolidated[0].alignment_count, 1);
    }

    #[test]
    fn retains_a_chain_whose_short_collinear_fragments_sum_to_10kb() {
        let records = [
            "contig-a\t100000\t0\t4000\t+\tmono1\t200000\t10000\t14000\t3800\t4000\t60",
            "contig-a\t100000\t5000\t9000\t+\tmono1\t200000\t15000\t19000\t3700\t4000\t60",
            "contig-a\t100000\t10000\t14000\t+\tmono1\t200000\t20000\t24000\t3600\t4000\t60",
        ]
        .into_iter()
        .map(|line| PafRecord::parse_line(line).unwrap().unwrap())
        .collect();

        let consolidated = consolidate_paf_split_alignments(records);

        assert_eq!(consolidated.len(), 1);
        assert_eq!(consolidated[0].query_start, 0);
        assert_eq!(consolidated[0].query_end, 14_000);
        assert_eq!(consolidated[0].target_start, 10_000);
        assert_eq!(consolidated[0].target_end, 24_000);
        assert_eq!(consolidated[0].alignment_count, 3);
        assert_eq!(consolidated[0].fragments.len(), 3);
    }

    #[test]
    fn allows_disjoint_query_intervals_to_map_to_different_targets() {
        let records = [
            "contig-a\t10000\t0\t1000\t+\tmono1\t20000\t1000\t2000\t950\t1000\t20",
            "contig-a\t10000\t2000\t3000\t+\tmono2\t20000\t5000\t6000\t900\t1000\t60",
        ]
        .into_iter()
        .map(|line| PafRecord::parse_line(line).unwrap().unwrap())
        .collect();

        let consolidated = consolidate_paf_split_alignments_with_minimum(records, 1_000);

        assert_eq!(consolidated.len(), 2);
        assert_eq!(consolidated[0].target_name, "mono1");
        assert_eq!(consolidated[0].query_start, 0);
        assert_eq!(consolidated[0].query_end, 1_000);
        assert_eq!(consolidated[1].target_name, "mono2");
        assert_eq!(consolidated[1].query_start, 2_000);
        assert_eq!(consolidated[1].query_end, 3_000);
    }

    #[test]
    fn applies_haphic_global_chain_support_before_interval_arbitration() {
        let records = [
            "contig-a\t20000\t0\t5000\t+\tmono1\t30000\t0\t5000\t4800\t5000\t60",
            "contig-a\t20000\t5000\t10000\t+\tmono1\t30000\t5000\t10000\t4700\t5000\t60",
            "contig-a\t20000\t12000\t13900\t+\tmono2\t30000\t1000\t2900\t1800\t1900\t60",
            "contig-a\t20000\t15000\t17000\t+\tmono3\t30000\t2000\t4000\t1900\t2000\t60",
        ]
        .into_iter()
        .map(|line| PafRecord::parse_line(line).unwrap().unwrap())
        .collect();

        let consolidated = consolidate_paf_split_alignments_with_minimum(records, 1_000);

        assert_eq!(
            consolidated
                .iter()
                .map(|record| record.target_name.as_str())
                .collect::<Vec<_>>(),
            vec!["mono1", "mono3"]
        );
        assert_eq!(
            consolidated
                .iter()
                .map(|record| record.alignment_count)
                .sum::<usize>(),
            3
        );
    }

    #[test]
    fn consolidates_reverse_split_alignments_in_decreasing_target_order() {
        let records = [
            "contig-a\t10000\t0\t2000\t-\tmono1\t20000\t8000\t10000\t1900\t2000\t60",
            "contig-a\t10000\t2000\t4000\t-\tmono1\t20000\t6000\t8000\t1850\t2000\t50",
        ]
        .into_iter()
        .map(|line| PafRecord::parse_line(line).unwrap().unwrap())
        .collect();

        let consolidated = consolidate_paf_split_alignments_with_minimum(records, 1_000);

        assert_eq!(consolidated.len(), 1);
        assert_eq!(consolidated[0].query_start, 0);
        assert_eq!(consolidated[0].query_end, 4_000);
        assert_eq!(consolidated[0].target_start, 6_000);
        assert_eq!(consolidated[0].target_end, 10_000);
        assert_eq!(consolidated[0].strand, '-');
        assert_eq!(consolidated[0].alignment_count, 2);
    }

    #[test]
    fn maps_paf_records_to_current_visual_layout_and_merges_adjacent_blocks() {
        let query = SyntenyQuery {
            viewport: Viewport {
                x_start: 0,
                x_end: 5_000,
                y_start: 0,
                y_end: 1,
            },
            layout_blocks: vec![LayoutBlock {
                id: "block-a".to_string(),
                source_id: "contig-a".to_string(),
                source_start: 0,
                source_end: 5_000,
                visual_start: 0,
                orientation: Orientation::Forward,
            }],
            min_mapq: 20,
            min_alignment_len: 500,
            max_query_gap: 200,
            max_target_gap: 200,
        };
        let records = vec![
            PafRecord::parse_line(
                "contig-a\t5000\t0\t1000\t+\tmono1\t50000\t10000\t11000\t950\t1000\t60",
            )
            .unwrap()
            .unwrap(),
            PafRecord::parse_line(
                "contig-a\t5000\t1100\t2000\t+\tmono1\t50000\t11100\t12000\t850\t900\t55",
            )
            .unwrap()
            .unwrap(),
        ];

        let view = build_synteny_view(&query, records).expect("valid synteny query");

        assert_eq!(view.blocks.len(), 1);
        assert_eq!(view.blocks[0].assembly_block_id, "block-a");
        assert_eq!(view.blocks[0].visual_start, 0);
        assert_eq!(view.blocks[0].visual_end, 2_000);
        assert_eq!(view.blocks[0].target_id, "mono1");
        assert_eq!(view.blocks[0].target_length, 50_000);
        assert_eq!(view.blocks[0].target_start, 10_000);
        assert_eq!(view.blocks[0].target_end, 12_000);
        assert_eq!(view.blocks[0].alignment_count, 2);
    }

    #[test]
    fn renders_short_fragments_from_a_retained_post_lis_chain() {
        let query = SyntenyQuery {
            viewport: Viewport {
                x_start: 0,
                x_end: 100_000,
                y_start: 0,
                y_end: 1,
            },
            layout_blocks: vec![LayoutBlock {
                id: "block-a".to_string(),
                source_id: "contig-a".to_string(),
                source_start: 0,
                source_end: 100_000,
                visual_start: 0,
                orientation: Orientation::Forward,
            }],
            min_mapq: 0,
            min_alignment_len: 10_000,
            max_query_gap: 0,
            max_target_gap: 0,
        };
        let records = [
            "contig-a\t100000\t0\t8000\t+\tmono1\t200000\t10000\t18000\t7600\t8000\t60",
            "contig-a\t100000\t20000\t28000\t+\tmono1\t200000\t50000\t58000\t7200\t8000\t50",
        ]
        .into_iter()
        .map(|line| PafRecord::parse_line(line).unwrap().unwrap())
        .collect();
        let records = consolidate_paf_split_alignments(records);

        let view = build_synteny_view(&query, records).expect("valid synteny query");

        assert_eq!(view.blocks.len(), 2);
        assert_eq!(view.blocks[0].visual_start, 0);
        assert_eq!(view.blocks[0].visual_end, 8_000);
        assert_eq!(view.blocks[1].visual_start, 20_000);
        assert_eq!(view.blocks[1].visual_end, 28_000);
    }

    #[test]
    fn reverse_layout_blocks_flip_visual_coordinates_and_relative_strand() {
        let query = SyntenyQuery {
            viewport: Viewport {
                x_start: 0,
                x_end: 5_000,
                y_start: 0,
                y_end: 1,
            },
            layout_blocks: vec![LayoutBlock {
                id: "block-a".to_string(),
                source_id: "contig-a".to_string(),
                source_start: 0,
                source_end: 5_000,
                visual_start: 0,
                orientation: Orientation::Reverse,
            }],
            min_mapq: 0,
            min_alignment_len: 1,
            max_query_gap: 100,
            max_target_gap: 100,
        };
        let records = vec![PafRecord::parse_line(
            "contig-a\t5000\t0\t1000\t+\tmono1\t50000\t10000\t11000\t900\t1000\t60",
        )
        .unwrap()
        .unwrap()];

        let view = build_synteny_view(&query, records).expect("valid synteny query");

        assert_eq!(view.blocks.len(), 1);
        assert_eq!(view.blocks[0].visual_start, 4_000);
        assert_eq!(view.blocks[0].visual_end, 5_000);
        assert_eq!(view.blocks[0].strand, '-');
    }

    #[test]
    fn copied_blocks_reuse_paf_alignments_and_deleted_blocks_are_absent() {
        let query = SyntenyQuery {
            viewport: Viewport {
                x_start: 0,
                x_end: 6_000,
                y_start: 0,
                y_end: 1,
            },
            layout_blocks: vec![
                LayoutBlock {
                    id: "copy-1".to_string(),
                    source_id: "contig-a".to_string(),
                    source_start: 0,
                    source_end: 2_000,
                    visual_start: 0,
                    orientation: Orientation::Forward,
                },
                LayoutBlock {
                    id: "copy-2".to_string(),
                    source_id: "contig-a".to_string(),
                    source_start: 0,
                    source_end: 2_000,
                    visual_start: 3_000,
                    orientation: Orientation::Forward,
                },
            ],
            min_mapq: 0,
            min_alignment_len: 1,
            max_query_gap: 100,
            max_target_gap: 100,
        };
        let records = vec![
            PafRecord::parse_line(
                "contig-a\t2000\t0\t1000\t+\tmono1\t50000\t10000\t11000\t900\t1000\t60",
            )
            .unwrap()
            .unwrap(),
            PafRecord::parse_line(
                "deleted-contig\t2000\t0\t1000\t+\tmono2\t50000\t20000\t21000\t900\t1000\t60",
            )
            .unwrap()
            .unwrap(),
        ];

        let view = build_synteny_view(&query, records).expect("valid synteny query");

        assert_eq!(view.blocks.len(), 2);
        assert_eq!(
            view.blocks
                .iter()
                .map(|block| block.assembly_block_id.as_str())
                .collect::<Vec<_>>(),
            vec!["copy-1", "copy-2"]
        );
        assert_eq!(
            view.blocks
                .iter()
                .map(|block| block.visual_start)
                .collect::<Vec<_>>(),
            vec![0, 3_000]
        );
        assert!(view.blocks.iter().all(|block| block.target_id == "mono1"));
    }
}
