#!/usr/bin/env python3
"""Benchmark the no-PAF Hi-C allelic-contig inference paths.

The prediction side reproduces the current desktop defaults:

* raw whole-layout overview at about 320 bins;
* length-normalized top 24 coarse partners for every selected contig;
* raw fine contacts at about 50 windows across the shorter contig;
* support >= 20, at least 3 observed cells, at least 3 and 10% covered
  shorter-contig windows, and concordance ratio > 0.2.

PAF is never used to form a prediction or candidate. A separate TypeScript
helper runs C-Studio's current sequence-synteny implementation and supplies
high-confidence direct PAF allele edges as proxy labels after prediction.

The optimized path first detects distributed cross-object h-trans lines in the
overview, projects those lines to per-contig candidates, and retains the direct
concordance score during fine validation. A three-mode thin band may also pass
when it is significant against the observed row/column marginal background and
agrees with the object-line orientation. Reciprocal line coverage, effective
windows, and span define separate supported and high-confidence Hi-C tiers.
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
import time
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path

import cooler
import numpy as np


OVERVIEW_TARGET_BINS = 320
PARTNERS_PER_CONTIG = 24
REQUESTED_WINDOWS = 50
MINIMUM_SUPPORT = 20.0
CONCORDANCE_CUTOFF = 0.2
MINIMUM_RESOLVED_WINDOWS = 5
MINIMUM_OBSERVED_CELLS = 3
MINIMUM_COVERED_WINDOWS = 3
MINIMUM_COVERED_FRACTION = 0.1
MAXIMUM_TILES_PER_PAIR = 16
TILE_SIZE_BINS = 256
OBJECT_LINE_MINIMUM_SUPPORT = 100.0
OBJECT_LINE_MINIMUM_ENRICHMENT = 1.3
OBJECT_LINE_MINIMUM_EXCESS_RATIO = 0.02
OBJECT_LINE_MINIMUM_COVERAGE_FRACTION = 0.75
OBJECT_LINE_MINIMUM_SPAN_FRACTION = 0.75
OBJECT_LINE_PROJECTION_PADDING_WINDOWS = 1.0
FINE_LINE_MINIMUM_WEIGHT = 5.0
FINE_LINE_MINIMUM_ENRICHMENT = 1.5
FINE_LINE_MINIMUM_Z_SCORE = 3.0
FINE_LINE_MINIMUM_RECIPROCAL_COVERAGE = 0.1
FINE_LINE_MINIMUM_EFFECTIVE_WINDOW_FRACTION = 0.0
FINE_LINE_MINIMUM_RECIPROCAL_SPAN_FRACTION = 0.1
HIGH_CONFIDENCE_LINE_MINIMUM_RECIPROCAL_COVERAGE = 0.2
HIGH_CONFIDENCE_LINE_MINIMUM_EFFECTIVE_WINDOW_FRACTION = 0.1
HIGH_CONFIDENCE_LINE_MINIMUM_RECIPROCAL_SPAN_FRACTION = 0.2
HIGH_CONFIDENCE_LINE_MINIMUM_Z_SCORE = 4.0


@dataclass(frozen=True)
class Block:
    id: str
    object_id: str
    source_id: str
    source_start: int
    source_end: int
    visual_start: int
    visual_end: int
    orientation: str
    order: int

    @property
    def length(self) -> int:
        return self.visual_end - self.visual_start


@dataclass
class Accumulator:
    left: Block
    right: Block
    bin_width: int
    resolved_windows: int
    shorter_side: str
    support: float
    observed_cells: int
    covered_windows: set[int]
    differences: dict[int, float]
    sums: dict[int, float]
    left_windows: int
    right_windows: int
    left_window_weights: dict[int, float]
    right_window_weights: dict[int, float]
    cell_weights: dict[int, float]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dataset",
        action="append",
        choices=("hifi-only",),
        help="Accuracy dataset to run. The default is hifi-only.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="Write full JSON here; defaults to benchmark-results/hic-allele-accuracy.json.",
    )
    return parser.parse_args()


def parse_agp(path: Path) -> tuple[list[Block], int]:
    object_order: list[str] = []
    object_span: dict[str, int] = {}
    components: dict[str, list[tuple[int, list[str]]]] = defaultdict(list)
    with path.open("r", encoding="utf-8") as handle:
        for raw in handle:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            columns = line.split("\t")
            if len(columns) != 9:
                continue
            object_id = columns[0]
            if object_id not in object_span:
                object_order.append(object_id)
                object_span[object_id] = 0
            object_span[object_id] = max(object_span[object_id], int(columns[2]))
            if columns[4] in {"N", "U"}:
                continue
            components[object_id].append((int(columns[1]) - 1, columns))

    blocks: list[Block] = []
    object_offset = 0
    for object_id in object_order:
        for object_start, columns in components[object_id]:
            source_start = int(columns[6]) - 1
            source_end = int(columns[7])
            visual_start = object_offset + object_start
            blocks.append(Block(
                id=f"{object_id}:{columns[3]}:{columns[5]}",
                object_id=object_id,
                source_id=columns[5],
                source_start=source_start,
                source_end=source_end,
                visual_start=visual_start,
                visual_end=visual_start + source_end - source_start,
                orientation="-" if columns[8] == "-" else "+",
                order=len(blocks),
            ))
        object_offset += object_span[object_id]
    return blocks, object_offset


def pair_key(left: str, right: str) -> tuple[str, str]:
    return (left, right) if left <= right else (right, left)


def load_paf_truth(repo_root: Path, agp_path: Path, paf_path: Path) -> dict:
    command = [
        "npm", "exec", "--", "vite-node",
        "scripts/export-paf-allele-truth.ts",
        str(agp_path),
        str(paf_path),
    ]
    completed = subprocess.run(
        command,
        cwd=repo_root,
        check=True,
        text=True,
        capture_output=True,
    )
    return json.loads(completed.stdout)


def load_projected_pixels(
    cool_path: Path,
    blocks: list[Block],
):
    contact = cooler.Cooler(str(cool_path))
    bins = contact.bins()[:]
    pixels = contact.pixels()[:]
    chrom_names = list(contact.chromnames)
    chrom_index = {name: index for index, name in enumerate(chrom_names)}
    blocks_by_source: dict[str, list[Block]] = defaultdict(list)
    for block in blocks:
        blocks_by_source[block.source_id].append(block)
    duplicate_sources = sorted(
        source for source, values in blocks_by_source.items() if len(values) != 1
    )
    if duplicate_sources:
        raise ValueError(
            "This benchmark currently requires one AGP occurrence per source; "
            f"found duplicates: {duplicate_sources[:10]}"
        )

    bin_chrom = bins["chrom"].map(chrom_index).to_numpy(dtype=np.int32)
    bin_start = bins["start"].to_numpy(dtype=np.int64)
    visual_by_bin = np.full(len(bins), -1, dtype=np.int64)
    placed_source_by_bin = np.full(len(bins), -1, dtype=np.int32)
    for source_name, block_values in blocks_by_source.items():
        source_index = chrom_index.get(source_name)
        if source_index is None:
            continue
        block = block_values[0]
        selected = np.flatnonzero(bin_chrom == source_index)
        starts = bin_start[selected]
        inside = (starts >= block.source_start) & (starts < block.source_end)
        selected = selected[inside]
        starts = starts[inside]
        if block.orientation == "-":
            visual = (
                block.visual_start
                + block.source_end
                - block.source_start
                - (starts - block.source_start)
                - 1
            )
        else:
            visual = block.visual_start + starts - block.source_start
        visual_by_bin[selected] = visual
        placed_source_by_bin[selected] = source_index

    bin1 = pixels["bin1_id"].to_numpy(dtype=np.int64)
    bin2 = pixels["bin2_id"].to_numpy(dtype=np.int64)
    counts = pixels["count"].to_numpy(dtype=np.float64)
    visual1 = visual_by_bin[bin1]
    visual2 = visual_by_bin[bin2]
    source1 = placed_source_by_bin[bin1]
    source2 = placed_source_by_bin[bin2]
    valid = (visual1 >= 0) & (visual2 >= 0) & np.isfinite(counts) & (counts > 0)
    visual1 = visual1[valid]
    visual2 = visual2[valid]
    source1 = source1[valid]
    source2 = source2[valid]
    counts = counts[valid]
    x_visual = np.minimum(visual1, visual2)
    y_visual = np.maximum(visual1, visual2)
    return x_visual, y_visual, counts, source1, source2, chrom_names, {
        "coolChromosomes": len(chrom_names),
        "coolBins": int(len(bins)),
        "coolPixels": int(len(pixels)),
        "projectedPixels": int(valid.sum()),
        "projectedRawContactWeight": float(counts.sum()),
        "placedSourcesPresentInCooler": sum(
            source in chrom_index for source in blocks_by_source
        ),
        "coolerBinSize": int(contact.binsize or 0),
    }


def build_direct_source_candidates(
    blocks: list[Block],
    source1: np.ndarray,
    source2: np.ndarray,
    counts: np.ndarray,
    chrom_names: list[str],
):
    cross = source1 != source2
    left_code = np.minimum(source1[cross], source2[cross]).astype(np.int64)
    right_code = np.maximum(source1[cross], source2[cross]).astype(np.int64)
    cross_counts = counts[cross]
    chrom_count = len(chrom_names)
    encoded = left_code * chrom_count + right_code
    keys, inverse = np.unique(encoded, return_inverse=True)
    weights = np.bincount(inverse, weights=cross_counts)
    block_by_source = {block.source_id: block for block in blocks}
    ranked = []
    for key, raw_count in zip(keys, weights):
        left = chrom_names[int(key // chrom_count)]
        right = chrom_names[int(key % chrom_count)]
        left_block = block_by_source.get(left)
        right_block = block_by_source.get(right)
        if not left_block or not right_block:
            continue
        denominator = (left_block.length / 1_000_000) * (
            right_block.length / 1_000_000
        )
        score = float(raw_count) / denominator if denominator > 0 else 0
        if score > 0 and math.isfinite(score):
            ranked.append((
                pair_key(left, right),
                float(raw_count),
                score,
                left_block.id,
                right_block.id,
            ))
    ranked.sort(key=lambda row: (-row[2], -row[1], row[3], row[4]))
    partners: dict[str, list[str]] = {block.source_id: [] for block in blocks}
    for key, _, _, _, _ in ranked:
        left, right = key
        if len(partners[left]) < PARTNERS_PER_CONTIG:
            partners[left].append(right)
        if len(partners[right]) < PARTNERS_PER_CONTIG:
            partners[right].append(left)
    candidates = {
        pair_key(source, partner)
        for source, values in partners.items()
        for partner in values
    }
    return candidates, partners, {
        "method": "Raw direct source-contig totals per placement-length Mb2; diagnostic only.",
        "allNonzeroDirectSourcePairs": len(ranked),
        "uniqueCandidatePairsAcrossAllSelections": len(candidates),
    }


def aggregate_cells(
    x_visual: np.ndarray,
    y_visual: np.ndarray,
    counts: np.ndarray,
    resolution: int,
    total_span: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    n_bins = max(1, math.ceil(total_span / resolution))
    x_bin = x_visual // resolution
    y_bin = y_visual // resolution
    encoded = x_bin * n_bins + y_bin
    keys, inverse = np.unique(encoded, return_inverse=True)
    weights = np.bincount(inverse, weights=counts)
    return keys // n_bins, keys % n_bins, weights


def overview_memberships(blocks: list[Block], resolution: int):
    overlaps: dict[int, list[tuple[Block, int]]] = defaultdict(list)
    for block in blocks:
        first = block.visual_start // resolution
        last = (block.visual_end - 1) // resolution
        for bin_index in range(first, last + 1):
            overlap = min(block.visual_end, (bin_index + 1) * resolution) - max(
                block.visual_start, bin_index * resolution
            )
            if overlap > 0:
                overlaps[bin_index].append((block, overlap))
    memberships = {}
    for bin_index, values in overlaps.items():
        total = sum(overlap for _, overlap in values)
        if total > 0:
            memberships[bin_index] = [
                (block, overlap / total) for block, overlap in values
            ]
    return memberships


def build_overview_candidates(
    blocks: list[Block],
    total_span: int,
    source_resolution: int,
    x_visual: np.ndarray,
    y_visual: np.ndarray,
    counts: np.ndarray,
):
    raw_resolution = max(1, math.ceil(total_span / OVERVIEW_TARGET_BINS))
    target_resolution = max(
        source_resolution,
        math.ceil(raw_resolution / source_resolution) * source_resolution,
    )
    x_bins, y_bins, cell_counts = aggregate_cells(
        x_visual, y_visual, counts, target_resolution, total_span
    )
    memberships = overview_memberships(blocks, target_resolution)
    raw_by_pair: dict[tuple[str, str], float] = defaultdict(float)
    block_by_source = {block.source_id: block for block in blocks}
    for x_bin, y_bin, count in zip(x_bins, y_bins, cell_counts):
        x_values = memberships.get(int(x_bin))
        y_values = memberships.get(int(y_bin))
        if not x_values or not y_values:
            continue
        for x_block, x_weight in x_values:
            for y_block, y_weight in y_values:
                if x_block.id == y_block.id:
                    continue
                key = pair_key(x_block.source_id, y_block.source_id)
                contribution = float(count) * x_weight * y_weight
                if contribution > 0 and math.isfinite(contribution):
                    raw_by_pair[key] += contribution

    ranked = []
    for key, raw_count in raw_by_pair.items():
        left, right = key
        left_block = block_by_source[left]
        right_block = block_by_source[right]
        denominator = (left_block.length / 1_000_000) * (
            right_block.length / 1_000_000
        )
        score = raw_count / denominator if denominator > 0 else 0
        if score > 0 and math.isfinite(score):
            visual_left, visual_right = sorted(
                (left_block, right_block), key=lambda block: block.order
            )
            ranked.append((
                key,
                raw_count,
                score,
                visual_left.id,
                visual_right.id,
            ))
    ranked.sort(key=lambda row: (-row[2], -row[1], row[3], row[4]))

    partners: dict[str, list[str]] = {block.source_id: [] for block in blocks}
    union_links = []
    for key, raw_count, score, _, _ in ranked:
        left, right = key
        left_rank = len(partners[left]) + 1
        right_rank = len(partners[right]) + 1
        if left_rank <= PARTNERS_PER_CONTIG:
            partners[left].append(right)
        if right_rank <= PARTNERS_PER_CONTIG:
            partners[right].append(left)
        if left_rank <= PARTNERS_PER_CONTIG or right_rank <= PARTNERS_PER_CONTIG:
            union_links.append((key, raw_count, score))
    candidates = {
        pair_key(source, partner)
        for source, values in partners.items()
        for partner in values
    }
    return candidates, partners, {
        "sourceResolution": source_resolution,
        "targetResolution": target_resolution,
        "targetBins": OVERVIEW_TARGET_BINS,
        "aggregatedCells": int(len(cell_counts)),
        "allNonzeroCoarsePairs": len(ranked),
        "topPartnerUnionLinks": len(union_links),
        "uniqueCandidatePairsAcrossAllSelections": len(candidates),
    }


def object_spans(blocks: list[Block]):
    spans: dict[str, list[int]] = {}
    blocks_by_object: dict[str, list[Block]] = defaultdict(list)
    for block in blocks:
        span = spans.setdefault(block.object_id, [block.visual_start, block.visual_end])
        span[0] = min(span[0], block.visual_start)
        span[1] = max(span[1], block.visual_end)
        blocks_by_object[block.object_id].append(block)
    return spans, blocks_by_object


def object_memberships_by_bin(
    spans: dict[str, list[int]],
    resolution: int,
):
    memberships = defaultdict(list)
    for object_id, (start, end) in spans.items():
        length = end - start
        if length <= 0:
            continue
        for bin_index in range(start // resolution, (end - 1) // resolution + 1):
            overlap_start = max(start, bin_index * resolution)
            overlap_end = min(end, (bin_index + 1) * resolution)
            if overlap_end <= overlap_start:
                continue
            memberships[bin_index].append((
                object_id,
                (overlap_end - overlap_start) / resolution,
                ((overlap_start + overlap_end) / 2 - start) / length,
            ))
    return memberships


def object_mode_opportunities(window_count: int, orientation: str, mode: int) -> int:
    if orientation == "parallel":
        return max(0, window_count - abs(mode))
    return max(0, window_count - abs(mode - (window_count - 1)))


def build_trans_line_candidates(
    blocks: list[Block],
    total_span: int,
    source_resolution: int,
    x_visual: np.ndarray,
    y_visual: np.ndarray,
    counts: np.ndarray,
):
    """Infer cross-object thin lines, then project them to bounded contig candidates."""

    raw_resolution = max(1, math.ceil(total_span / OVERVIEW_TARGET_BINS))
    resolution = max(
        source_resolution,
        math.ceil(raw_resolution / source_resolution) * source_resolution,
    )
    x_bins, y_bins, cell_counts = aggregate_cells(
        x_visual, y_visual, counts, resolution, total_span
    )
    spans, blocks_by_object = object_spans(blocks)
    memberships = object_memberships_by_bin(spans, resolution)
    accumulators = {}
    for x_bin, y_bin, count in zip(x_bins, y_bins, cell_counts):
        for x_object, x_weight, x_coordinate in memberships.get(int(x_bin), []):
            for y_object, y_weight, y_coordinate in memberships.get(int(y_bin), []):
                if x_object == y_object:
                    continue
                if x_object <= y_object:
                    key = (x_object, y_object)
                    left_coordinate, right_coordinate = x_coordinate, y_coordinate
                else:
                    key = (y_object, x_object)
                    left_coordinate, right_coordinate = y_coordinate, x_coordinate
                shorter_length = min(
                    spans[key[0]][1] - spans[key[0]][0],
                    spans[key[1]][1] - spans[key[1]][0],
                )
                window_count = max(
                    MINIMUM_RESOLVED_WINDOWS,
                    min(REQUESTED_WINDOWS, shorter_length // resolution),
                )
                accumulator = accumulators.setdefault(key, {
                    "windowCount": window_count,
                    "support": 0.0,
                    "differences": defaultdict(float),
                    "sums": defaultdict(float),
                    "coveredLeft": set(),
                    "coveredRight": set(),
                    "cellWeights": defaultdict(float),
                })
                left_window = min(
                    window_count - 1,
                    max(0, math.floor(left_coordinate * window_count)),
                )
                right_window = min(
                    window_count - 1,
                    max(0, math.floor(right_coordinate * window_count)),
                )
                contribution = float(count) * x_weight * y_weight
                if contribution <= 0 or not math.isfinite(contribution):
                    continue
                accumulator["support"] += contribution
                accumulator["differences"][right_window - left_window] += contribution
                accumulator["sums"][right_window + left_window] += contribution
                accumulator["coveredLeft"].add(left_window)
                accumulator["coveredRight"].add(right_window)
                accumulator["cellWeights"][(left_window, right_window)] += contribution

    object_lines = []
    for (left_object, right_object), accumulator in accumulators.items():
        window_count = accumulator["windowCount"]
        support = accumulator["support"]
        minimum_span = math.ceil(
            window_count * OBJECT_LINE_MINIMUM_SPAN_FRACTION
        )
        candidates = []
        for orientation, weights, modes in (
            (
                "parallel",
                accumulator["differences"],
                range(-window_count + 1, window_count),
            ),
            (
                "antiparallel",
                accumulator["sums"],
                range(2 * window_count - 1),
            ),
        ):
            for mode in modes:
                opportunities = object_mode_opportunities(
                    window_count, orientation, mode
                )
                if opportunities < minimum_span:
                    continue
                ratio = weights.get(mode, 0.0) / support if support > 0 else 0.0
                expected_ratio = opportunities / (window_count * window_count)
                line_cell_weights = [
                    weight
                    for (left_window, right_window), weight
                    in accumulator["cellWeights"].items()
                    if (
                        right_window - left_window == mode
                        if orientation == "parallel"
                        else right_window + left_window == mode
                    )
                ]
                line_weight = sum(line_cell_weights)
                squared_line_weight = sum(weight * weight for weight in line_cell_weights)
                effective_line_window_count = (
                    line_weight * line_weight / squared_line_weight
                    if squared_line_weight > 0 else 0.0
                )
                if effective_line_window_count < max(3.0, opportunities * 0.4):
                    continue
                candidates.append({
                    "orientation": orientation,
                    "mode": mode,
                    "ratio": ratio,
                    "expectedRatio": expected_ratio,
                    "enrichment": ratio / expected_ratio if expected_ratio > 0 else 0.0,
                    "excessRatio": ratio - expected_ratio,
                    "opportunities": opportunities,
                    "lineCoveredWindowCount": len(line_cell_weights),
                    "effectiveLineWindowCount": effective_line_window_count,
                    "distributedExcessScore": (
                        (ratio - expected_ratio)
                        * math.sqrt(effective_line_window_count)
                    ),
                })
        best = max(
            candidates,
            key=lambda value: (
                value["distributedExcessScore"],
                value["excessRatio"],
                value["enrichment"],
                value["ratio"],
            ),
            default=None,
        )
        required_coverage = math.ceil(
            window_count * OBJECT_LINE_MINIMUM_COVERAGE_FRACTION
        )
        if (
            best is None
            or support < OBJECT_LINE_MINIMUM_SUPPORT
            or len(accumulator["coveredLeft"]) < required_coverage
            or len(accumulator["coveredRight"]) < required_coverage
            or best["enrichment"] < OBJECT_LINE_MINIMUM_ENRICHMENT
            or best["excessRatio"] < OBJECT_LINE_MINIMUM_EXCESS_RATIO
        ):
            continue
        object_lines.append({
            "id": f"{left_object}\0{right_object}",
            "leftObjectId": left_object,
            "rightObjectId": right_object,
            "windowCount": window_count,
            "support": support,
            "coveredLeftWindowCount": len(accumulator["coveredLeft"]),
            "coveredRightWindowCount": len(accumulator["coveredRight"]),
            **best,
        })

    candidates_by_source_line = defaultdict(lambda: defaultdict(list))
    for line in object_lines:
        left_object = line["leftObjectId"]
        right_object = line["rightObjectId"]
        window_count = line["windowCount"]
        for source_object, target_object in (
            (left_object, right_object),
            (right_object, left_object),
        ):
            source_start, source_end = spans[source_object]
            target_start, target_end = spans[target_object]
            source_length = source_end - source_start
            target_length = target_end - target_start
            for source_block in blocks_by_object[source_object]:
                source_window_start = (
                    (source_block.visual_start - source_start)
                    / source_length
                    * window_count
                )
                source_window_end = (
                    (source_block.visual_end - source_start)
                    / source_length
                    * window_count
                )
                if line["orientation"] == "parallel":
                    signed_mode = line["mode"] if source_object == left_object else -line["mode"]
                    projected_start = source_window_start + signed_mode
                    projected_end = source_window_end + signed_mode
                else:
                    projected_start = line["mode"] - source_window_end
                    projected_end = line["mode"] - source_window_start
                projected_start -= OBJECT_LINE_PROJECTION_PADDING_WINDOWS
                projected_end += OBJECT_LINE_PROJECTION_PADDING_WINDOWS
                projected_midpoint = (projected_start + projected_end) / 2
                for target_block in blocks_by_object[target_object]:
                    target_window_start = (
                        (target_block.visual_start - target_start)
                        / target_length
                        * window_count
                    )
                    target_window_end = (
                        (target_block.visual_end - target_start)
                        / target_length
                        * window_count
                    )
                    overlap = min(projected_end, target_window_end) - max(
                        projected_start, target_window_start
                    )
                    if overlap <= 0:
                        continue
                    target_midpoint = (target_window_start + target_window_end) / 2
                    candidates_by_source_line[source_block.source_id][line["id"]].append((
                        abs(target_midpoint - projected_midpoint),
                        -overlap,
                        -line["enrichment"],
                        target_block.source_id,
                    ))

    partners = {block.source_id: [] for block in blocks}
    for source, by_line in candidates_by_source_line.items():
        queues = [
            sorted(values)
            for _, values in sorted(
                by_line.items(),
                key=lambda item: min(value[2] for value in item[1]),
            )
        ]
        cursor = 0
        while len(partners[source]) < PARTNERS_PER_CONTIG and queues:
            queue = queues[cursor % len(queues)]
            if queue:
                target = queue.pop(0)[3]
                if target not in partners[source]:
                    partners[source].append(target)
            queues = [values for values in queues if values]
            cursor += 1
    candidates = {
        pair_key(source, partner)
        for source, values in partners.items()
        for partner in values
    }
    block_by_source = {block.source_id: block for block in blocks}
    line_by_object_pair = {
        pair_key(line["leftObjectId"], line["rightObjectId"]): line
        for line in object_lines
    }
    expected_orientation = {}
    for left_source, right_source in candidates:
        left_block = block_by_source[left_source]
        right_block = block_by_source[right_source]
        line = line_by_object_pair.get(pair_key(
            left_block.object_id, right_block.object_id
        ))
        if line is None:
            continue
        same_block_orientation = (
            (left_block.orientation == "-") == (right_block.orientation == "-")
        )
        expected_orientation[(left_source, right_source)] = (
            "parallel"
            if (line["orientation"] == "parallel") == same_block_orientation
            else "antiparallel"
        )
    return candidates, partners, expected_orientation, {
        "method": (
            "Whole-object cross-contact thin-line enrichment over a uniform window null, "
            "followed by coordinate projection and round-robin per-line candidate quotas."
        ),
        "sourceResolution": source_resolution,
        "targetResolution": resolution,
        "acceptedObjectLines": len(object_lines),
        "objectLines": sorted(
            object_lines,
            key=lambda value: (
                -value["enrichment"],
                value["leftObjectId"],
                value["rightObjectId"],
            ),
        ),
        "uniqueCandidatePairsAcrossAllSelections": len(candidates),
    }


def plan_pair(left: Block, right: Block, source_resolution: int):
    shorter_length = min(left.length, right.length)
    desired_resolution = max(1, shorter_length // REQUESTED_WINDOWS)
    target_resolution = max(
        source_resolution,
        math.ceil(desired_resolution / source_resolution) * source_resolution,
    )
    if shorter_length < target_resolution * MINIMUM_RESOLVED_WINDOWS:
        return None, "resolution-limited"
    tile_span = target_resolution * TILE_SIZE_BINS
    left_tiles = range(
        left.visual_start // tile_span,
        (left.visual_end - 1) // tile_span + 1,
    )
    right_tiles = range(
        right.visual_start // tile_span,
        (right.visual_end - 1) // tile_span + 1,
    )
    tiles = {
        (min(x, y), max(x, y)) for x in left_tiles for y in right_tiles
    }
    if len(tiles) > MAXIMUM_TILES_PER_PAIR:
        return None, "tile-safety-limit"
    return target_resolution, None


def fine_memberships(blocks: set[Block], resolution: int):
    memberships: dict[int, list[tuple[Block, float, float]]] = defaultdict(list)
    for block in blocks:
        first = block.visual_start // resolution
        last = (block.visual_end - 1) // resolution
        for bin_index in range(first, last + 1):
            overlap_start = max(block.visual_start, bin_index * resolution)
            overlap_end = min(block.visual_end, (bin_index + 1) * resolution)
            overlap = overlap_end - overlap_start
            if overlap <= 0:
                continue
            midpoint = (overlap_start + overlap_end) / 2
            displayed_offset = midpoint - block.visual_start
            local_coordinate = (
                block.length - displayed_offset
                if block.orientation == "-"
                else displayed_offset
            )
            memberships[bin_index].append((
                block,
                overlap / resolution,
                local_coordinate,
            ))
    return memberships


def make_accumulator(left: Block, right: Block, resolution: int) -> Accumulator:
    shorter_length = min(left.length, right.length)
    resolved_windows = max(
        1, min(REQUESTED_WINDOWS, shorter_length // resolution)
    )
    bin_width = max(1, shorter_length // resolved_windows)
    return Accumulator(
        left=left,
        right=right,
        bin_width=bin_width,
        resolved_windows=resolved_windows,
        shorter_side="left" if left.length <= right.length else "right",
        support=0.0,
        observed_cells=0,
        covered_windows=set(),
        differences=defaultdict(float),
        sums=defaultdict(float),
        left_windows=max(1, math.ceil(left.length / bin_width)),
        right_windows=max(1, math.ceil(right.length / bin_width)),
        left_window_weights=defaultdict(float),
        right_window_weights=defaultdict(float),
        cell_weights=defaultdict(float),
    )


def line_band_metrics(accumulator: Accumulator, radius: int = 1) -> dict:
    """Score a thin diagonal against a row/column-marginal independence null."""

    if accumulator.support <= 0:
        return {
            "lineRatio": 0.0,
            "lineExpectedRatio": 0.0,
            "lineEnrichment": 0.0,
            "lineZScore": 0.0,
            "lineWeight": 0.0,
            "lineOrientation": "parallel",
            "lineMode": 0,
            "lineCoveredLeftWindowCount": 0,
            "lineCoveredRightWindowCount": 0,
            "lineCoveredLeftWindowFraction": 0.0,
            "lineCoveredRightWindowFraction": 0.0,
            "lineReciprocalCoverage": 0.0,
            "lineEffectiveWindowCount": 0.0,
            "lineEffectiveWindowFraction": 0.0,
            "lineReciprocalSpanFraction": 0.0,
        }

    candidates = []
    for orientation, mode_weights, modes in (
        (
            "parallel",
            accumulator.differences,
            range(-accumulator.left_windows + 1, accumulator.right_windows),
        ),
        (
            "antiparallel",
            accumulator.sums,
            range(accumulator.left_windows + accumulator.right_windows - 1),
        ),
    ):
        for mode in modes:
            observed = sum(
                mode_weights.get(mode + offset, 0.0)
                for offset in range(-radius, radius + 1)
            )
            expected = 0.0
            for left_window, left_weight in accumulator.left_window_weights.items():
                for offset in range(-radius, radius + 1):
                    right_window = (
                        left_window + mode + offset
                        if orientation == "parallel"
                        else mode + offset - left_window
                    )
                    right_weight = accumulator.right_window_weights.get(right_window, 0.0)
                    expected += left_weight * right_weight / accumulator.support
            expected_floor = max(expected, 1.0)
            candidates.append({
                "lineRatio": observed / accumulator.support,
                "lineExpectedRatio": expected / accumulator.support,
                "lineEnrichment": observed / expected_floor,
                "lineZScore": (observed - expected) / math.sqrt(expected_floor),
                "lineWeight": observed,
                "lineOrientation": orientation,
                "lineMode": mode,
            })
    best = max(
        candidates,
        key=lambda value: (
            value["lineZScore"],
            value["lineEnrichment"],
            value["lineRatio"],
        ),
        default={
            "lineRatio": 0.0,
            "lineExpectedRatio": 0.0,
            "lineEnrichment": 0.0,
            "lineZScore": 0.0,
            "lineWeight": 0.0,
            "lineOrientation": "parallel",
            "lineMode": 0,
        },
    )
    left_weights = defaultdict(float)
    right_weights = defaultdict(float)
    for cell_key, weight in accumulator.cell_weights.items():
        left_window = cell_key // accumulator.right_windows
        right_window = cell_key % accumulator.right_windows
        cell_mode = (
            right_window - left_window
            if best["lineOrientation"] == "parallel"
            else right_window + left_window
        )
        if abs(cell_mode - best["lineMode"]) <= radius:
            left_weights[left_window] += weight
            right_weights[right_window] += weight
    line_weight = sum(left_weights.values())

    def effective_count(weights: dict[int, float]) -> float:
        squared = sum(weight * weight for weight in weights.values())
        return line_weight * line_weight / squared if squared > 0 else 0.0

    def span_fraction(weights: dict[int, float], windows: int) -> float:
        if not weights or windows <= 0:
            return 0.0
        return (max(weights) - min(weights) + 1) / windows

    effective_left = effective_count(left_weights)
    effective_right = effective_count(right_weights)
    left_fraction = len(left_weights) / accumulator.left_windows
    right_fraction = len(right_weights) / accumulator.right_windows
    return {
        **best,
        "lineCoveredLeftWindowCount": len(left_weights),
        "lineCoveredRightWindowCount": len(right_weights),
        "lineCoveredLeftWindowFraction": left_fraction,
        "lineCoveredRightWindowFraction": right_fraction,
        "lineReciprocalCoverage": min(left_fraction, right_fraction),
        "lineEffectiveWindowCount": min(effective_left, effective_right),
        "lineEffectiveWindowFraction": min(
            effective_left / accumulator.left_windows,
            effective_right / accumulator.right_windows,
        ),
        "lineReciprocalSpanFraction": min(
            span_fraction(left_weights, accumulator.left_windows),
            span_fraction(right_weights, accumulator.right_windows),
        ),
    }


def score_candidates(
    blocks: list[Block],
    candidates: set[tuple[str, str]],
    source_resolution: int,
    total_span: int,
    x_visual: np.ndarray,
    y_visual: np.ndarray,
    counts: np.ndarray,
):
    block_by_source = {block.source_id: block for block in blocks}
    groups: dict[int, set[tuple[str, str]]] = defaultdict(set)
    unresolved: dict[tuple[str, str], str] = {}
    for key in candidates:
        resolution, reason = plan_pair(
            block_by_source[key[0]], block_by_source[key[1]], source_resolution
        )
        if resolution is None:
            unresolved[key] = reason or "unresolved"
        else:
            groups[resolution].add(key)

    accumulators: dict[tuple[str, str], Accumulator] = {}
    for group_index, (resolution, group_pairs) in enumerate(sorted(groups.items()), 1):
        print(
            f"  fine resolution {resolution:,} bp "
            f"({group_index}/{len(groups)}, {len(group_pairs)} candidates)",
            file=sys.stderr,
            flush=True,
        )
        group_blocks = {
            block_by_source[source]
            for key in group_pairs
            for source in key
        }
        memberships = fine_memberships(group_blocks, resolution)
        x_bins, y_bins, cell_counts = aggregate_cells(
            x_visual, y_visual, counts, resolution, total_span
        )
        for x_bin, y_bin, count in zip(x_bins, y_bins, cell_counts):
            x_values = memberships.get(int(x_bin))
            y_values = memberships.get(int(y_bin))
            if not x_values or not y_values:
                continue
            for x_block, x_weight, x_coordinate in x_values:
                for y_block, y_weight, y_coordinate in y_values:
                    if x_block.id == y_block.id or x_block.source_id == y_block.source_id:
                        continue
                    key = pair_key(x_block.source_id, y_block.source_id)
                    if key not in group_pairs:
                        continue
                    if x_block.id <= y_block.id:
                        left, right = x_block, y_block
                        left_coordinate, right_coordinate = x_coordinate, y_coordinate
                    else:
                        left, right = y_block, x_block
                        left_coordinate, right_coordinate = y_coordinate, x_coordinate
                    accumulator = accumulators.get(key)
                    if accumulator is None:
                        accumulator = make_accumulator(left, right, resolution)
                        accumulators[key] = accumulator
                    contribution = float(count) * x_weight * y_weight
                    if contribution <= 0 or not math.isfinite(contribution):
                        continue
                    difference = math.floor(
                        (right_coordinate - left_coordinate) / accumulator.bin_width
                    )
                    summed = math.floor(
                        (right_coordinate + left_coordinate) / accumulator.bin_width
                    )
                    accumulator.differences[difference] += contribution
                    accumulator.sums[summed] += contribution
                    accumulator.support += contribution
                    accumulator.observed_cells += 1
                    left_window = min(
                        accumulator.left_windows - 1,
                        max(0, math.floor(left_coordinate / accumulator.bin_width)),
                    )
                    right_window = min(
                        accumulator.right_windows - 1,
                        max(0, math.floor(right_coordinate / accumulator.bin_width)),
                    )
                    accumulator.left_window_weights[left_window] += contribution
                    accumulator.right_window_weights[right_window] += contribution
                    accumulator.cell_weights[
                        left_window * accumulator.right_windows + right_window
                    ] += contribution
                    shorter_coordinate = (
                        left_coordinate
                        if accumulator.shorter_side == "left"
                        else right_coordinate
                    )
                    window = min(
                        accumulator.resolved_windows - 1,
                        max(0, math.floor(shorter_coordinate / accumulator.bin_width)),
                    )
                    accumulator.covered_windows.add(window)

    stats = {}
    for key in candidates:
        if key in unresolved:
            stats[key] = {"status": "unresolved", "reason": unresolved[key]}
            continue
        accumulator = accumulators.get(key)
        resolution, _ = plan_pair(
            block_by_source[key[0]], block_by_source[key[1]], source_resolution
        )
        if accumulator is None:
            shorter = min(block_by_source[key[0]].length, block_by_source[key[1]].length)
            resolved = max(1, min(REQUESTED_WINDOWS, shorter // int(resolution)))
            stats[key] = {
                "status": "ready",
                "resolution": int(resolution),
                "support": 0.0,
                "observedCellCount": 0,
                "coveredShorterWindowCount": 0,
                "resolvedWindowCount": resolved,
                "parallelRatio": 0.0,
                "antiparallelRatio": 0.0,
                "concordanceRatio": 0.0,
                "orientation": "parallel",
                "lineRatio": 0.0,
                "lineExpectedRatio": 0.0,
                "lineEnrichment": 0.0,
                "lineZScore": 0.0,
                "lineWeight": 0.0,
                "lineOrientation": "parallel",
                "lineMode": 0,
                "lineCoveredLeftWindowCount": 0,
                "lineCoveredRightWindowCount": 0,
                "lineCoveredLeftWindowFraction": 0.0,
                "lineCoveredRightWindowFraction": 0.0,
                "lineReciprocalCoverage": 0.0,
                "lineEffectiveWindowCount": 0.0,
                "lineEffectiveWindowFraction": 0.0,
                "lineReciprocalSpanFraction": 0.0,
            }
            continue
        parallel_weight = max(accumulator.differences.values(), default=0.0)
        antiparallel_weight = max(accumulator.sums.values(), default=0.0)
        parallel_ratio = (
            parallel_weight / accumulator.support if accumulator.support > 0 else 0.0
        )
        antiparallel_ratio = (
            antiparallel_weight / accumulator.support if accumulator.support > 0 else 0.0
        )
        stats[key] = {
            "status": "ready",
            "resolution": int(resolution),
            "support": accumulator.support,
            "observedCellCount": accumulator.observed_cells,
            "coveredShorterWindowCount": len(accumulator.covered_windows),
            "resolvedWindowCount": accumulator.resolved_windows,
            "parallelRatio": parallel_ratio,
            "antiparallelRatio": antiparallel_ratio,
            "concordanceRatio": max(parallel_ratio, antiparallel_ratio),
            "orientation": (
                "parallel" if parallel_ratio >= antiparallel_ratio else "antiparallel"
            ),
            **line_band_metrics(accumulator),
        }
    return stats, Counter(unresolved.values())


def passes(stats: dict, cutoff: float, minimum_support: float) -> bool:
    if stats.get("status") != "ready":
        return False
    required_covered = max(
        MINIMUM_COVERED_WINDOWS,
        math.ceil(stats["resolvedWindowCount"] * MINIMUM_COVERED_FRACTION),
    )
    return (
        stats["support"] >= minimum_support
        and stats["observedCellCount"] >= MINIMUM_OBSERVED_CELLS
        and stats["coveredShorterWindowCount"] >= required_covered
        and stats["concordanceRatio"] > cutoff
    )


def passes_trans_line(
    stats: dict,
    expected_orientation: str | None,
    minimum_z_score: float = FINE_LINE_MINIMUM_Z_SCORE,
    minimum_reciprocal_coverage: float = FINE_LINE_MINIMUM_RECIPROCAL_COVERAGE,
    minimum_effective_window_fraction: float = FINE_LINE_MINIMUM_EFFECTIVE_WINDOW_FRACTION,
    minimum_reciprocal_span_fraction: float = FINE_LINE_MINIMUM_RECIPROCAL_SPAN_FRACTION,
) -> bool:
    if stats.get("status") != "ready" or expected_orientation is None:
        return False
    required_covered = max(
        MINIMUM_COVERED_WINDOWS,
        math.ceil(stats["resolvedWindowCount"] * MINIMUM_COVERED_FRACTION),
    )
    common_quality = (
        stats["support"] >= MINIMUM_SUPPORT
        and stats["observedCellCount"] >= MINIMUM_OBSERVED_CELLS
        and stats["coveredShorterWindowCount"] >= required_covered
    )
    classic_concordance = (
        stats["concordanceRatio"] > CONCORDANCE_CUTOFF
        and stats["orientation"] == expected_orientation
    )
    significant_line = (
        stats["lineWeight"] >= FINE_LINE_MINIMUM_WEIGHT
        and stats["lineEnrichment"] >= FINE_LINE_MINIMUM_ENRICHMENT
        and stats["lineZScore"] >= minimum_z_score
        and stats["lineReciprocalCoverage"] >= minimum_reciprocal_coverage
        and stats["lineEffectiveWindowFraction"] >= minimum_effective_window_fraction
        and stats["lineReciprocalSpanFraction"] >= minimum_reciprocal_span_fraction
        and stats["lineOrientation"] == expected_orientation
    )
    return common_quality and (classic_concordance or significant_line)


def trans_line_metric_row(
    stats_by_pair: dict,
    truth_pairs: set[tuple[str, str]],
    accepted_sources: set[str],
    expected_paf_orientation: dict[tuple[str, str], str],
    expected_line_orientation: dict[tuple[str, str], str],
    minimum_z_score: float = FINE_LINE_MINIMUM_Z_SCORE,
    minimum_reciprocal_coverage: float = FINE_LINE_MINIMUM_RECIPROCAL_COVERAGE,
    minimum_effective_window_fraction: float = FINE_LINE_MINIMUM_EFFECTIVE_WINDOW_FRACTION,
    minimum_reciprocal_span_fraction: float = FINE_LINE_MINIMUM_RECIPROCAL_SPAN_FRACTION,
):
    predicted = {
        key for key, stats in stats_by_pair.items()
        if passes_trans_line(
            stats,
            expected_line_orientation.get(key),
            minimum_z_score,
            minimum_reciprocal_coverage,
            minimum_effective_window_fraction,
            minimum_reciprocal_span_fraction,
        )
    }
    candidate_pairs = set(stats_by_pair)
    candidate_truth = candidate_pairs & truth_pairs
    labeled_negatives = {
        key for key in candidate_pairs
        if key not in truth_pairs and key[0] in accepted_sources and key[1] in accepted_sources
    }
    true_positive = predicted & truth_pairs
    false_positive = predicted & labeled_negatives
    false_negative = truth_pairs - predicted
    true_negative = labeled_negatives - predicted
    precision = divide(len(true_positive), len(true_positive) + len(false_positive))
    recall = divide(len(true_positive), len(truth_pairs))
    f1 = (
        2 * precision * recall / (precision + recall)
        if precision is not None and recall is not None and precision + recall > 0
        else 0.0
    )
    direction_correct = 0
    for key in true_positive:
        stats = stats_by_pair[key]
        line_orientation = expected_line_orientation.get(key)
        predicted_orientation = (
            stats["orientation"]
            if stats["concordanceRatio"] > CONCORDANCE_CUTOFF
            and stats["orientation"] == line_orientation
            else stats["lineOrientation"]
        )
        direction_correct += predicted_orientation == expected_paf_orientation.get(key)
    return {
        "minimumLineZScore": minimum_z_score,
        "minimumLineEnrichment": FINE_LINE_MINIMUM_ENRICHMENT,
        "minimumLineWeight": FINE_LINE_MINIMUM_WEIGHT,
        "minimumLineReciprocalCoverage": minimum_reciprocal_coverage,
        "minimumLineEffectiveWindowFraction": minimum_effective_window_fraction,
        "minimumLineReciprocalSpanFraction": minimum_reciprocal_span_fraction,
        "candidatePairs": len(candidate_pairs),
        "candidateTruthPairs": len(candidate_truth),
        "candidateRecall": divide(len(candidate_truth), len(truth_pairs)),
        "predictedPairs": len(predicted),
        "truePositive": len(true_positive),
        "falsePositiveWithinPafLabeledCandidates": len(false_positive),
        "falseNegativeEndToEnd": len(false_negative),
        "trueNegativeWithinCandidateSet": len(true_negative),
        "precisionOnPafLabeledPredictions": precision,
        "precisionWilson95": wilson_interval(
            len(true_positive), len(true_positive) + len(false_positive)
        ),
        "recallEndToEnd": recall,
        "recallWilson95": wilson_interval(len(true_positive), len(truth_pairs)),
        "recallConditionalOnCandidateGeneration": divide(
            len(true_positive), len(candidate_truth)
        ),
        "f1EndToEnd": f1,
        "specificityWithinCandidateSet": divide(
            len(true_negative), len(true_negative) + len(false_positive)
        ),
        "orientationCorrectTruePositive": direction_correct,
        "orientationAccuracyOnTruePositive": divide(
            direction_correct, len(true_positive)
        ),
        "predictedPairKeys": [list(key) for key in sorted(predicted)],
    }
def divide(numerator: float, denominator: float) -> float | None:
    return numerator / denominator if denominator else None


def wilson_interval(successes: int, trials: int, z: float = 1.959963984540054):
    if trials <= 0:
        return None
    estimate = successes / trials
    denominator = 1 + z * z / trials
    center = (estimate + z * z / (2 * trials)) / denominator
    margin = (
        z
        * math.sqrt(
            estimate * (1 - estimate) / trials + z * z / (4 * trials * trials)
        )
        / denominator
    )
    return {"lower": max(0.0, center - margin), "upper": min(1.0, center + margin)}


def metric_row(
    stats_by_pair: dict,
    truth_pairs: set[tuple[str, str]],
    accepted_sources: set[str],
    expected_orientation: dict[tuple[str, str], str],
    cutoff: float,
    minimum_support: float,
):
    predicted = {
        key for key, stats in stats_by_pair.items()
        if passes(stats, cutoff, minimum_support)
    }
    candidate_pairs = set(stats_by_pair)
    candidate_truth = candidate_pairs & truth_pairs
    labeled_negatives = {
        key for key in candidate_pairs
        if key not in truth_pairs and key[0] in accepted_sources and key[1] in accepted_sources
    }
    unknown_candidates = candidate_pairs - truth_pairs - labeled_negatives
    true_positive = predicted & truth_pairs
    false_positive = predicted & labeled_negatives
    unknown_predicted = predicted & unknown_candidates
    false_negative = truth_pairs - predicted
    true_negative = labeled_negatives - predicted
    precision = divide(len(true_positive), len(true_positive) + len(false_positive))
    recall = divide(len(true_positive), len(truth_pairs))
    f1 = None
    if precision is not None and recall is not None:
        f1 = (
            2 * precision * recall / (precision + recall)
            if precision + recall > 0
            else 0.0
        )
    direction_correct = sum(
        stats_by_pair[key]["orientation"] == expected_orientation.get(key)
        for key in true_positive
    )
    return {
        "concordanceRatioCutoff": cutoff,
        "minimumSupport": minimum_support,
        "candidatePairs": len(candidate_pairs),
        "candidateTruthPairs": len(candidate_truth),
        "candidateRecall": divide(len(candidate_truth), len(truth_pairs)),
        "predictedPairs": len(predicted),
        "truePositive": len(true_positive),
        "falsePositiveWithinPafLabeledCandidates": len(false_positive),
        "unknownLabelPredictions": len(unknown_predicted),
        "falseNegativeEndToEnd": len(false_negative),
        "trueNegativeWithinCandidateSet": len(true_negative),
        "precisionOnPafLabeledPredictions": precision,
        "precisionWilson95": wilson_interval(
            len(true_positive), len(true_positive) + len(false_positive)
        ),
        "conservativePrecisionTreatingUnknownAsFalse": divide(
            len(true_positive), len(predicted)
        ),
        "recallEndToEnd": recall,
        "recallWilson95": wilson_interval(len(true_positive), len(truth_pairs)),
        "recallConditionalOnCandidateGeneration": divide(
            len(true_positive), len(candidate_truth)
        ),
        "f1EndToEnd": f1,
        "specificityWithinCandidateSet": divide(
            len(true_negative), len(true_negative) + len(false_positive)
        ),
        "orientationCorrectTruePositive": direction_correct,
        "orientationAccuracyOnTruePositive": divide(
            direction_correct, len(true_positive)
        ),
        "predictedPairKeys": [list(key) for key in sorted(predicted)],
    }


def failure_reason(stats: dict) -> str:
    if stats.get("status") != "ready":
        return stats.get("reason", "unresolved")
    required_covered = max(
        MINIMUM_COVERED_WINDOWS,
        math.ceil(stats["resolvedWindowCount"] * MINIMUM_COVERED_FRACTION),
    )
    if stats["support"] < MINIMUM_SUPPORT:
        return "support-below-20"
    if stats["observedCellCount"] < MINIMUM_OBSERVED_CELLS:
        return "fewer-than-3-observed-cells"
    if stats["coveredShorterWindowCount"] < required_covered:
        return "insufficient-shorter-window-coverage"
    if stats["concordanceRatio"] <= CONCORDANCE_CUTOFF:
        return "concordance-ratio-at-or-below-0.2"
    return "passed"


def synthetic_coarse_validation(predicted_keys: list[list[str]]):
    def parse_name(value: str):
        if not value.startswith("Chr") or ".ctg" not in value:
            return None
        prefix = value.split(".ctg", 1)[0]
        haplotype = prefix[-1]
        chromosome = prefix[3:-1]
        if haplotype not in {"A", "B", "C", "D"} or not chromosome.isdigit():
            return None
        return chromosome, haplotype

    labeled = []
    for left, right in predicted_keys:
        left_label = parse_name(left)
        right_label = parse_name(right)
        if left_label and right_label:
            labeled.append((left_label, right_label))
    correct = sum(
        left[0] == right[0] and left[1] != right[1]
        for left, right in labeled
    )
    return {
        "scope": "Synthetic contig-name chromosome/haplotype labels; not locus truth.",
        "labeledPredictions": len(labeled),
        "sameChromosomeCrossHaplotype": correct,
        "coarsePrecision": divide(correct, len(labeled)),
    }


def compact_examples(
    pairs: set[tuple[str, str]],
    stats_by_pair: dict,
    limit: int = 20,
):
    ranked = sorted(
        pairs,
        key=lambda key: (
            -stats_by_pair.get(key, {}).get("concordanceRatio", 0),
            -stats_by_pair.get(key, {}).get("support", 0),
            key,
        ),
    )
    return [
        {
            "pair": list(key),
            **{
                field: stats_by_pair[key].get(field)
                for field in (
                    "status", "resolution", "support", "observedCellCount",
                    "coveredShorterWindowCount", "resolvedWindowCount",
                    "concordanceRatio", "orientation", "lineRatio",
                    "lineExpectedRatio", "lineEnrichment", "lineZScore",
                    "lineWeight", "lineOrientation", "lineMode",
                    "lineCoveredLeftWindowCount",
                    "lineCoveredRightWindowCount",
                    "lineReciprocalCoverage", "lineEffectiveWindowCount",
                    "lineEffectiveWindowFraction",
                    "lineReciprocalSpanFraction",
                )
            },
        }
        for key in ranked[:limit]
    ]


def truth_sensitivity_rows(
    truth_stats: dict,
    expected_orientation: dict[tuple[str, str], str],
    cutoff: float,
    minimum_support: float,
):
    passing = {
        key for key, stats in truth_stats.items()
        if passes(stats, cutoff, minimum_support)
    }
    direction_correct = sum(
        truth_stats[key].get("orientation") == expected_orientation.get(key)
        for key in passing
    )
    return {
        "concordanceRatioCutoff": cutoff,
        "minimumSupport": minimum_support,
        "truthPairsPassing": len(passing),
        "sensitivityIfEveryTruthPairWereQueried": divide(
            len(passing), len(truth_stats)
        ),
        "orientationCorrect": direction_correct,
        "orientationAccuracy": divide(direction_correct, len(passing)),
    }


def evaluate_dataset(
    repo_root: Path,
    name: str,
    agp_path: Path,
    cool_path: Path,
    paf_path: Path,
):
    started = time.perf_counter()
    print(f"{name}: exporting PAF proxy truth", file=sys.stderr, flush=True)
    blocks, total_span = parse_agp(agp_path)
    truth = load_paf_truth(repo_root, agp_path, paf_path)
    truth_pairs = {
        pair_key(edge["left"], edge["right"])
        for edge in truth["positiveEdges"]
    }
    expected_orientation = {
        pair_key(edge["left"], edge["right"]): edge["expectedOrientation"]
        for edge in truth["positiveEdges"]
    }
    accepted_sources = {anchor["sourceId"] for anchor in truth["anchors"]}

    print(f"{name}: projecting Cooler pixels", file=sys.stderr, flush=True)
    (
        x_visual,
        y_visual,
        counts,
        source1,
        source2,
        chrom_names,
        cool_summary,
    ) = load_projected_pixels(cool_path, blocks)
    source_resolution = cool_summary["coolerBinSize"]
    if source_resolution <= 0:
        raise ValueError(f"{cool_path} has no fixed positive bin size")
    print(f"{name}: reproducing overview candidate selection", file=sys.stderr, flush=True)
    candidates, partners, overview_summary = build_overview_candidates(
        blocks,
        total_span,
        source_resolution,
        x_visual,
        y_visual,
        counts,
    )
    (
        trans_line_candidates,
        trans_line_partners,
        expected_line_orientation,
        trans_line_summary,
    ) = build_trans_line_candidates(
        blocks,
        total_span,
        source_resolution,
        x_visual,
        y_visual,
        counts,
    )
    direct_candidates, direct_partners, direct_summary = build_direct_source_candidates(
        blocks, source1, source2, counts, chrom_names
    )
    print(f"{name}: scoring fine concordance", file=sys.stderr, flush=True)
    all_stats, _ = score_candidates(
        blocks,
        candidates | trans_line_candidates | truth_pairs,
        source_resolution,
        total_span,
        x_visual,
        y_visual,
        counts,
    )
    stats_by_pair = {key: all_stats[key] for key in candidates}
    trans_line_stats = {key: all_stats[key] for key in trans_line_candidates}
    truth_stats = {key: all_stats[key] for key in truth_pairs}
    current = metric_row(
        stats_by_pair,
        truth_pairs,
        accepted_sources,
        expected_orientation,
        CONCORDANCE_CUTOFF,
        MINIMUM_SUPPORT,
    )
    trans_line_accuracy = trans_line_metric_row(
        trans_line_stats,
        truth_pairs,
        accepted_sources,
        expected_orientation,
        expected_line_orientation,
    )
    trans_line_high_confidence_accuracy = trans_line_metric_row(
        trans_line_stats,
        truth_pairs,
        accepted_sources,
        expected_orientation,
        expected_line_orientation,
        minimum_z_score=HIGH_CONFIDENCE_LINE_MINIMUM_Z_SCORE,
        minimum_reciprocal_coverage=(
            HIGH_CONFIDENCE_LINE_MINIMUM_RECIPROCAL_COVERAGE
        ),
        minimum_effective_window_fraction=(
            HIGH_CONFIDENCE_LINE_MINIMUM_EFFECTIVE_WINDOW_FRACTION
        ),
        minimum_reciprocal_span_fraction=(
            HIGH_CONFIDENCE_LINE_MINIMUM_RECIPROCAL_SPAN_FRACTION
        ),
    )
    trans_line_z_sweep = [
        trans_line_metric_row(
            trans_line_stats,
            truth_pairs,
            accepted_sources,
            expected_orientation,
            expected_line_orientation,
            minimum_z_score,
        )
        for minimum_z_score in (2.0, 3.0, 4.0, 5.0, 6.0)
    ]
    trans_line_distribution_sweep = [
        trans_line_metric_row(
            trans_line_stats,
            truth_pairs,
            accepted_sources,
            expected_orientation,
            expected_line_orientation,
            minimum_reciprocal_coverage=minimum_coverage,
            minimum_effective_window_fraction=minimum_effective,
            minimum_reciprocal_span_fraction=minimum_span,
        )
        for minimum_coverage, minimum_effective, minimum_span in (
            (0.0, 0.0, 0.0),
            (0.1, 0.0, 0.0),
            (0.15, 0.05, 0.15),
            (0.2, 0.1, 0.2),
            (0.25, 0.1, 0.25),
            (0.3, 0.1, 0.3),
        )
    ]
    predicted = {tuple(value) for value in current["predictedPairKeys"]}
    true_positive = predicted & truth_pairs
    labeled_false_positive = {
        key for key in predicted
        if key not in truth_pairs and key[0] in accepted_sources and key[1] in accepted_sources
    }
    candidate_truth = candidates & truth_pairs
    directional_truth_total = 2 * len(truth_pairs)
    directional_truth_recalled = sum(
        right in partners.get(left, []) for left, right in truth_pairs
    ) + sum(
        left in partners.get(right, []) for left, right in truth_pairs
    )
    direct_candidate_truth = direct_candidates & truth_pairs
    direct_directional_truth_recalled = sum(
        right in direct_partners.get(left, []) for left, right in truth_pairs
    ) + sum(
        left in direct_partners.get(right, []) for left, right in truth_pairs
    )
    cr_sweep = [
        metric_row(
            stats_by_pair, truth_pairs, accepted_sources, expected_orientation,
            cutoff, MINIMUM_SUPPORT,
        )
        for cutoff in (0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5)
    ]
    support_sweep = [
        metric_row(
            stats_by_pair, truth_pairs, accepted_sources, expected_orientation,
            CONCORDANCE_CUTOFF, support,
        )
        for support in (10, 20, 30, 50, 100)
    ]
    truth_cr_sweep = [
        truth_sensitivity_rows(
            truth_stats, expected_orientation, cutoff, MINIMUM_SUPPORT
        )
        for cutoff in (0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5)
    ]
    truth_support_sweep = [
        truth_sensitivity_rows(
            truth_stats, expected_orientation, CONCORDANCE_CUTOFF, support
        )
        for support in (10, 20, 30, 50, 100)
    ]
    for rows in (cr_sweep, support_sweep):
        for row in rows:
            row.pop("predictedPairKeys", None)

    result = {
        "dataset": name,
        "inputs": {
            "agp": str(agp_path),
            "cool": str(cool_path),
            "pafProxyLabels": str(paf_path),
            "agpBlocks": len(blocks),
            "layoutSpanBp": total_span,
            **cool_summary,
        },
        "labelScope": {
            **truth["method"],
            "acceptedPafAnchors": len(accepted_sources),
            "placedContigLabelCoverage": divide(len(accepted_sources), len(blocks)),
            "positivePafProxyPairs": len(truth_pairs),
            "exclusions": truth["counts"]["exclusionReasons"],
            "biologicalGroundTruth": False,
        },
        "currentDefaults": {
            "overviewTargetBins": OVERVIEW_TARGET_BINS,
            "partnersPerSelectedContig": PARTNERS_PER_CONTIG,
            "requestedFineWindows": REQUESTED_WINDOWS,
            "minimumSupport": MINIMUM_SUPPORT,
            "concordanceRatioRule": f"> {CONCORDANCE_CUTOFF}",
            "minimumObservedCells": MINIMUM_OBSERVED_CELLS,
            "minimumCoveredWindows": MINIMUM_COVERED_WINDOWS,
            "minimumCoveredWindowFraction": MINIMUM_COVERED_FRACTION,
            "minimumLineReciprocalCoverage": FINE_LINE_MINIMUM_RECIPROCAL_COVERAGE,
            "minimumLineEffectiveWindowFraction": (
                FINE_LINE_MINIMUM_EFFECTIVE_WINDOW_FRACTION
            ),
            "minimumLineReciprocalSpanFraction": (
                FINE_LINE_MINIMUM_RECIPROCAL_SPAN_FRACTION
            ),
            "highConfidenceLineReciprocalCoverage": (
                HIGH_CONFIDENCE_LINE_MINIMUM_RECIPROCAL_COVERAGE
            ),
            "highConfidenceLineMinimumZScore": HIGH_CONFIDENCE_LINE_MINIMUM_Z_SCORE,
            "highConfidenceLineEffectiveWindowFraction": (
                HIGH_CONFIDENCE_LINE_MINIMUM_EFFECTIVE_WINDOW_FRACTION
            ),
            "highConfidenceLineReciprocalSpanFraction": (
                HIGH_CONFIDENCE_LINE_MINIMUM_RECIPROCAL_SPAN_FRACTION
            ),
            "normalization": "raw",
        },
        "overviewCandidateGeneration": {
            **overview_summary,
            "truthPairsReachingEitherEndpointsTop24": len(candidate_truth),
            "uniquePairCandidateRecall": divide(len(candidate_truth), len(truth_pairs)),
            "truthEndpointSelections": directional_truth_total,
            "truthEndpointSelectionsWithPartnerInTop24": directional_truth_recalled,
            "directionalCandidateRecall": divide(
                directional_truth_recalled, directional_truth_total
            ),
        },
        "transLineCandidateGeneration": {
            **trans_line_summary,
            "truthPairsReachingCandidateGeneration": len(
                trans_line_candidates & truth_pairs
            ),
            "uniquePairCandidateRecall": divide(
                len(trans_line_candidates & truth_pairs), len(truth_pairs)
            ),
            "truthEndpointSelections": directional_truth_total,
            "truthEndpointSelectionsWithPartnerInTop24": sum(
                right in trans_line_partners.get(left, [])
                for left, right in truth_pairs
            ) + sum(
                left in trans_line_partners.get(right, [])
                for left, right in truth_pairs
            ),
        },
        "directSourceCandidateDiagnostic": {
            **direct_summary,
            "truthPairsReachingEitherEndpointsTop24": len(direct_candidate_truth),
            "uniquePairCandidateRecall": divide(
                len(direct_candidate_truth), len(truth_pairs)
            ),
            "truthEndpointSelectionsWithPartnerInTop24": direct_directional_truth_recalled,
            "directionalCandidateRecall": divide(
                direct_directional_truth_recalled, directional_truth_total
            ),
            "interpretation": (
                "Removes 320-bin overview mixing but is not the current desktop path; "
                "it separates candidate-resolution loss from absence of strong direct contacts."
            ),
        },
        "finePlan": {
            "readyCandidatePairs": sum(
                value.get("status") == "ready" for value in stats_by_pair.values()
            ),
            "unresolvedCandidatePairs": sum(
                value.get("status") != "ready" for value in stats_by_pair.values()
            ),
            "unresolvedReasons": dict(Counter(
                value.get("reason", "unresolved")
                for value in stats_by_pair.values()
                if value.get("status") != "ready"
            )),
            "failureReasonsAtCurrentDefaults": dict(Counter(
                failure_reason(value) for value in stats_by_pair.values()
            )),
        },
        "currentAccuracy": current,
        "transLineAccuracy": trans_line_accuracy,
        "transLineHighConfidenceAccuracy": trans_line_high_confidence_accuracy,
        "transLineZScoreSensitivity": trans_line_z_sweep,
        "transLineDistributionSensitivity": trans_line_distribution_sweep,
        "thresholdSensitivity": {
            "concordanceRatioAtSupport20": cr_sweep,
            "minimumSupportAtRatio0.2": support_sweep,
        },
        "allTruthPairFineQueryDiagnostic": {
            "role": (
                "Sensitivity diagnostic only: directly query every PAF proxy-positive pair "
                "to remove top-24 candidate loss."
            ),
            "failureReasonsAtCurrentDefaults": dict(Counter(
                failure_reason(value) for value in truth_stats.values()
            )),
            "currentDefaults": truth_sensitivity_rows(
                truth_stats,
                expected_orientation,
                CONCORDANCE_CUTOFF,
                MINIMUM_SUPPORT,
            ),
            "concordanceRatioAtSupport20": truth_cr_sweep,
            "minimumSupportAtRatio0.2": truth_support_sweep,
        },
        "syntheticCoarseValidation": synthetic_coarse_validation(
            current["predictedPairKeys"]
        ),
        "errorExamples": {
            "labeledFalsePositive": compact_examples(
                labeled_false_positive, stats_by_pair
            ),
            "truePositive": compact_examples(true_positive, stats_by_pair),
            "truthMissedAfterCandidateGeneration": compact_examples(
                candidate_truth - predicted, stats_by_pair
            ),
            "truthMissedByCandidateGeneration": [
                list(key) for key in sorted(truth_pairs - candidates)[:30]
            ],
        },
        "runtimeSeconds": time.perf_counter() - started,
    }
    return result


def main() -> None:
    args = parse_args()
    repo_root = Path(__file__).resolve().parents[1]
    workspace_root = repo_root.parent
    data_root = workspace_root / "benchmark" / "ploidy-4"
    definitions = {
        "hifi-only": (
            data_root / "hifi-only" / "groups.final.agp",
            data_root / "hifi-only" / "input.1k.cool",
            data_root / "hifi-only" / "mono.hifi.asm.bp.p_utg.paf",
        ),
    }
    selected = args.dataset or ["hifi-only"]
    output_path = args.output or (
        repo_root / "benchmark-results" / "hic-allele-accuracy.json"
    )
    output_path = output_path.resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    results = [
        evaluate_dataset(repo_root, name, *definitions[name]) for name in selected
    ]
    aggregate_truth = sum(
        result["labelScope"]["positivePafProxyPairs"] for result in results
    )
    aggregate_candidates = sum(
        result["currentAccuracy"]["candidateTruthPairs"] for result in results
    )
    aggregate_predictions = sum(
        result["currentAccuracy"]["predictedPairs"] for result in results
    )
    aggregate_true_positive = sum(
        result["currentAccuracy"]["truePositive"] for result in results
    )
    aggregate_false_positive = sum(
        result["currentAccuracy"]["falsePositiveWithinPafLabeledCandidates"]
        for result in results
    )
    aggregate_precision = divide(
        aggregate_true_positive,
        aggregate_true_positive + aggregate_false_positive,
    )
    aggregate_recall = divide(aggregate_true_positive, aggregate_truth)
    aggregate_f1 = None
    if aggregate_precision is not None and aggregate_recall is not None:
        aggregate_f1 = (
            2 * aggregate_precision * aggregate_recall
            / (aggregate_precision + aggregate_recall)
            if aggregate_precision + aggregate_recall > 0
            else 0.0
        )
    optimized_truth_candidates = sum(
        result["transLineAccuracy"]["candidateTruthPairs"] for result in results
    )
    optimized_predictions = sum(
        result["transLineAccuracy"]["predictedPairs"] for result in results
    )
    optimized_true_positive = sum(
        result["transLineAccuracy"]["truePositive"] for result in results
    )
    optimized_false_positive = sum(
        result["transLineAccuracy"]["falsePositiveWithinPafLabeledCandidates"]
        for result in results
    )
    optimized_precision = divide(
        optimized_true_positive,
        optimized_true_positive + optimized_false_positive,
    )
    optimized_recall = divide(optimized_true_positive, aggregate_truth)
    optimized_f1 = (
        2 * optimized_precision * optimized_recall
        / (optimized_precision + optimized_recall)
        if optimized_precision is not None
        and optimized_recall is not None
        and optimized_precision + optimized_recall > 0
        else 0.0
    )
    payload = {
        "benchmark": "C-Studio no-PAF Hi-C allelic-contig inference: current vs trans-line",
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "evidenceBoundary": (
            "Accuracy is measured against independent PAF sequence-synteny proxy labels, "
            "not experimentally curated biological allele truth. Precision excludes "
            "predictions whose PAF label is unknown and also reports a conservative value."
        ),
        "pooledCurrentAccuracy": {
            "role": "Count-weighted summary across the selected benchmark datasets.",
            "truthPairs": aggregate_truth,
            "truthPairsReachingCandidateGeneration": aggregate_candidates,
            "candidateRecall": divide(aggregate_candidates, aggregate_truth),
            "predictedPairs": aggregate_predictions,
            "truePositive": aggregate_true_positive,
            "falsePositiveWithinPafLabeledCandidates": aggregate_false_positive,
            "precision": aggregate_precision,
            "precisionWilson95": wilson_interval(
                aggregate_true_positive,
                aggregate_true_positive + aggregate_false_positive,
            ),
            "recall": aggregate_recall,
            "recallWilson95": wilson_interval(
                aggregate_true_positive, aggregate_truth
            ),
            "f1": aggregate_f1,
        },
        "pooledTransLineAccuracy": {
            "role": (
                "Count-weighted summary for cross-object thin-line candidate generation "
                "and marginal-background fine-line validation."
            ),
            "truthPairs": aggregate_truth,
            "truthPairsReachingCandidateGeneration": optimized_truth_candidates,
            "candidateRecall": divide(optimized_truth_candidates, aggregate_truth),
            "predictedPairs": optimized_predictions,
            "truePositive": optimized_true_positive,
            "falsePositiveWithinPafLabeledCandidates": optimized_false_positive,
            "precision": optimized_precision,
            "precisionWilson95": wilson_interval(
                optimized_true_positive,
                optimized_true_positive + optimized_false_positive,
            ),
            "recall": optimized_recall,
            "recallWilson95": wilson_interval(
                optimized_true_positive, aggregate_truth
            ),
            "f1": optimized_f1,
        },
        "datasets": results,
        "totalRuntimeSeconds": time.perf_counter() - started,
    }
    output_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "output": str(output_path),
        "datasets": [
            {
                "name": result["dataset"],
                "truthPairs": result["labelScope"]["positivePafProxyPairs"],
                "candidateRecall": result["overviewCandidateGeneration"]["uniquePairCandidateRecall"],
                "precision": result["currentAccuracy"]["precisionOnPafLabeledPredictions"],
                "recall": result["currentAccuracy"]["recallEndToEnd"],
                "f1": result["currentAccuracy"]["f1EndToEnd"],
                "predictedPairs": result["currentAccuracy"]["predictedPairs"],
                "transLineCandidateRecall": result["transLineAccuracy"]["candidateRecall"],
                "transLinePrecision": result["transLineAccuracy"]["precisionOnPafLabeledPredictions"],
                "transLineRecall": result["transLineAccuracy"]["recallEndToEnd"],
                "transLineF1": result["transLineAccuracy"]["f1EndToEnd"],
                "transLinePredictedPairs": result["transLineAccuracy"]["predictedPairs"],
            }
            for result in results
        ],
        "runtimeSeconds": payload["totalRuntimeSeconds"],
    }, indent=2))


if __name__ == "__main__":
    main()
