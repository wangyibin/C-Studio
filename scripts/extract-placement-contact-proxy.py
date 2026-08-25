"""Extract a compact source-contig contact proxy for placement benchmarks.

Usage:
  python scripts/extract-placement-contact-proxy.py \
    input.cool groups.agp groups.edited.agp output.json

This benchmark helper intentionally uses raw 1 kb source-bin counts. It does
not reproduce the desktop projected 5-25 kb tile path and must not be treated
as independent assembly truth.
"""

import json
import sys

import cooler
import numpy as np
import pandas as pd


def parse_agp(path):
    rows = []
    with open(path, "r", encoding="utf-8") as handle:
        for raw in handle:
            if not raw.strip() or raw.startswith("#"):
                continue
            columns = raw.rstrip("\n").split("\t")
            if len(columns) != 9 or columns[4] in {"N", "U"}:
                continue
            rows.append({
                "object": columns[0],
                "id": columns[5],
                "orientation": columns[8],
            })
    return rows


def neighborhoods(rows):
    result = {}
    for index, row in enumerate(rows):
        previous = (
            rows[index - 1]
            if index > 0 and rows[index - 1]["object"] == row["object"]
            else None
        )
        following = (
            rows[index + 1]
            if index + 1 < len(rows) and rows[index + 1]["object"] == row["object"]
            else None
        )
        result[row["id"]] = {
            "object": row["object"],
            "orientation": row["orientation"],
            "previous": previous["id"] if previous else None,
            "next": following["id"] if following else None,
        }
    return result


def main():
    if len(sys.argv) != 5:
        raise SystemExit(
            "usage: extract-placement-contact-proxy.py "
            "input.cool groups.agp groups.edited.agp output.json"
        )
    cool_path, input_agp_path, edited_agp_path, output_path = sys.argv[1:5]
    input_neighborhoods = neighborhoods(parse_agp(input_agp_path))
    edited_neighborhoods = neighborhoods(parse_agp(edited_agp_path))
    changed_ids = {
        contig_id
        for contig_id, current in input_neighborhoods.items()
        if contig_id in edited_neighborhoods
        and (
            current["orientation"] != edited_neighborhoods[contig_id]["orientation"]
            or current["previous"] != edited_neighborhoods[contig_id]["previous"]
            or current["next"] != edited_neighborhoods[contig_id]["next"]
        )
    }

    contact = cooler.Cooler(cool_path)
    chrom_names = list(contact.chromnames)
    chrom_count = len(chrom_names)
    chrom_lengths = contact.chromsizes.reindex(chrom_names).to_numpy(dtype=np.float64)
    bins = contact.bins()[:]
    pixels = contact.pixels()[:]

    chrom_index = {name: index for index, name in enumerate(chrom_names)}
    bin_chrom = bins["chrom"].map(chrom_index).to_numpy(dtype=np.int32)
    bin_start = bins["start"].to_numpy(dtype=np.float64)
    bin_end = bins["end"].to_numpy(dtype=np.float64)
    bin_span = np.maximum(1.0, bin_end - bin_start)
    bin_length = chrom_lengths[bin_chrom]
    terminal_window = np.minimum(500_000.0, np.floor(bin_length * 0.25))
    start_weight = np.maximum(
        0.0,
        np.minimum(bin_end, terminal_window) - bin_start,
    ) / bin_span
    end_weight = np.maximum(
        0.0,
        bin_end - np.maximum(bin_start, bin_length - terminal_window),
    ) / bin_span

    bin1 = pixels["bin1_id"].to_numpy(dtype=np.int64)
    bin2 = pixels["bin2_id"].to_numpy(dtype=np.int64)
    counts = pixels["count"].to_numpy(dtype=np.float64)
    left_code = bin_chrom[bin1]
    right_code = bin_chrom[bin2]
    inter_contig = left_code != right_code
    bin1 = bin1[inter_contig]
    bin2 = bin2[inter_contig]
    counts = counts[inter_contig]
    left_code = left_code[inter_contig]
    right_code = right_code[inter_contig]

    observations = pd.DataFrame({
        "left": left_code,
        "right": right_code,
        "raw": counts,
        "ss": counts * start_weight[bin1] * start_weight[bin2],
        "se": counts * start_weight[bin1] * end_weight[bin2],
        "es": counts * end_weight[bin1] * start_weight[bin2],
        "ee": counts * end_weight[bin1] * end_weight[bin2],
    })
    pair_counts = observations.groupby(
        ["left", "right"], sort=False, as_index=False
    ).sum()
    length_products_mb2 = (
        chrom_lengths[pair_counts["left"].to_numpy()] / 1_000_000.0
    ) * (
        chrom_lengths[pair_counts["right"].to_numpy()] / 1_000_000.0
    )
    pair_counts["score"] = pair_counts["raw"].to_numpy() / length_products_mb2
    pair_counts["left_name"] = [chrom_names[index] for index in pair_counts["left"]]
    pair_counts["right_name"] = [chrom_names[index] for index in pair_counts["right"]]
    pair_counts.sort_values(
        ["score", "raw", "left_name", "right_name"],
        ascending=[False, False, True, True],
        inplace=True,
        kind="mergesort",
    )

    incident_ranks = np.zeros(chrom_count, dtype=np.int32)
    coarse_rows = []
    for row in pair_counts.itertuples(index=False):
        incident_ranks[row.left] += 1
        incident_ranks[row.right] += 1
        if incident_ranks[row.left] <= 24 or incident_ranks[row.right] <= 24:
            coarse_rows.append([
                row.left_name,
                row.right_name,
                float(row.raw),
                float(row.score),
            ])

    endpoint_rows = []
    for row in pair_counts.itertuples(index=False):
        if row.left_name not in changed_ids and row.right_name not in changed_ids:
            continue
        endpoint_rows.append([
            row.left_name,
            row.right_name,
            float(row.ss),
            float(row.se),
            float(row.es),
            float(row.ee),
        ])

    payload = {
        "method": {
            "normalization": "raw",
            "coarse": (
                "exact source-contig totals per Mb2; union of each contig's "
                "top 24 partners"
            ),
            "endpoint": (
                "1 kb source-bin terminal-quarter overlap; not the desktop "
                "projected 5-25 kb tile path"
            ),
        },
        "changedIds": sorted(changed_ids),
        "chromLengths": {
            name: int(length) for name, length in zip(chrom_names, chrom_lengths)
        },
        "coarse": coarse_rows,
        "endpointPhysical": endpoint_rows,
    }
    with open(output_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, separators=(",", ":"))

    print(json.dumps({
        "changedContigs": len(changed_ids),
        "allInterContigPairs": int(len(pair_counts)),
        "coarsePairs": len(coarse_rows),
        "endpointPairs": len(endpoint_rows),
        "output": output_path,
    }, indent=2))


if __name__ == "__main__":
    main()
