# Contact tile backend performance

The contact-tile backend can emit one structured timing line for each successful
top-level request. Timing is disabled by default. Enable it for a desktop run
with:

```sh
CSTUDIO_PERF_LOG=1 npm run tauri dev
```

Each line starts with `CSTUDIO_PERF event=contact_tiles` and uses `key=value`
fields so it can be filtered or parsed without collecting ordinary application
output. Request metadata includes both resolutions, tile size, normalization,
layout-block count, and requested/returned tile counts. Durations are integer
microseconds (`*_us`):

- `prepare_us`: request canonicalization, tile geometry, projection
  fingerprints, and visual-cache key construction.
- `visual_cache_us`: visual tile-cache lookup and hit/miss collection.
- `source_planning_us`: sparse work-region partitioning, viewport-to-source
  range mapping, query construction, source-window planning, and source-cache
  key construction.
- `source_cache_us`: source-cache hit probing and cold-path insertion/bookkeeping.
- `cool_read_us`: Cooler/HDF5 contact reads, including Cooler index and
  normalization-cache work reached by the read.
- `projection_us`: projection and aggregation of source contacts into visual
  contact-map cells. On a source-cache hit, this includes retrieving the cached
  contacts needed by that projection.
- `response_pack_us`: conversion of projected cells into requested tile
  responses and final response ordering.
- `store_us`: visual tile-cache eviction and insertion.
- `total_us`: end-to-end time in the synchronous tile worker, including small
  unclassified gaps and cancellation checks. It excludes Tauri async scheduling,
  IPC serialization, frontend transfer, and rendering.

Stage durations are accumulated across all recursively partitioned sparse work
regions. A request therefore produces one line, not one line per region. The
stages are intended to be non-overlapping, so their sum should be no greater
than `total_us`; the remainder is orchestration overhead.

## Reproducible release benchmark

The ignored benchmark uses the bundled example dataset and exercises a cold
request, source-cache reprojection, and a visual tile-cache hit. Run it from the
repository root in release mode and with one test thread:

```sh
CSTUDIO_PERF_LOG=1 cargo test \
  --manifest-path src-tauri/Cargo.toml \
  --release commands::tests::contact_tile_backend_release_benchmark \
  -- --ignored --exact --nocapture --test-threads=1
```

Do not compare debug-build timings. For comparisons between commits, run each
scenario enough times on an otherwise idle machine to report both p50 (typical)
and p95 (tail) latency. Keep the first process run separate because it can
include filesystem and HDF5 warm-up effects. Record the commit, machine, dataset,
resolution, tile count, normalization, and sample count with the result.

These measurements are diagnostic baselines, not CI gates. Do not add a fixed
latency threshold to CI: shared-runner load, filesystem caching, HDF5 startup,
and host hardware introduce enough variance to make a hard limit flaky. CI
should continue to enforce correctness; compare p50/p95 manually or in a
hardware-controlled performance job.

Useful interpretations:

- A cold request should have non-zero `cool_read_us`.
- Source-cache reprojection should have zero `cool_read_us` and non-zero
  `projection_us`.
- A visual tile-cache hit should have zero `cool_read_us`, `projection_us`, and
  `store_us`; most of its measured work should be preparation and visual-cache
  lookup.

`CSTUDIO_PERF_LOG` is diagnostic output, not a stable API. Keep it unset during
ordinary use and automated correctness tests.
