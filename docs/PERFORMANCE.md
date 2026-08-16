# Contact tile performance

The contact-tile backend can emit one structured timing line for each successful
top-level request. Timing is disabled by default. Enable it for a desktop run
with:

```sh
CSTUDIO_PERF_LOG=1 npm run tauri dev
```

Each line starts with `CSTUDIO_PERF event=contact_tiles` and uses `key=value`
fields so it can be filtered or parsed without collecting ordinary application
output. Runtime `scenario` distinguishes `visible`, `spatial_prefetch`,
`adjacent_prefetch`, and the post-paint `overview`; the ignored release
benchmark uses its own cold/reprojection scenario names. Request metadata includes
both resolutions, tile size,
normalization, layout-block count, and requested/returned tile counts. Durations
are integer microseconds (`*_us`):

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

### POJ whole-genome background benchmark

The ignored POJ benchmark uses `../benchmark/poj/groups.final.agp` and compares
the dedicated whole-map LOD response with the 17-by-17 upper-triangle ordinary
tile plan. It runs entirely in the Rust test process; no desktop window or
Computer Use is involved. Select one scenario per process so application caches
cannot leak across formats:

```sh
CSTUDIO_POJ_BENCH_SCENARIO=overview_mcool CSTUDIO_POJ_BENCH_SAMPLES=7 cargo test \
  --manifest-path src-tauri/Cargo.toml --release \
  commands::tests::poj_whole_genome_lod_vs_tiles_release_benchmark \
  -- --ignored --exact --nocapture --test-threads=1
```

Supported scenarios are `overview_mcool`, `overview_cool`,
`overview_cool_cache`, `lod_tiles_mcool`, `lod_tiles_cool`, `tiles_mcool`,
`tiles_cool`, `delta_mcool_visible`, and `delta_cool`. The `lod_tiles_*`
scenarios use the central canvas's screen-scale resolution, fixed 256-bin
tiles, and two-tile center-first batches.
`overview_cool_cache` computes and persists one exact projected overview, then
loads and byte-for-byte validates repeated hits. The last scenario measures the local exact-view
single-scan delta protocol and reconstructs the final tiles in the benchmark to
check cell counts. `CSTUDIO_POJ_BENCH_CONTACT` and `CSTUDIO_POJ_BENCH_AGP`
override the input paths. `CSTUDIO_POJ_BENCH_TILE_LIMIT=8` restricts a tile
scenario to the center-first initial batch. `CSTUDIO_POJ_BENCH_TARGET_BINS=640`
measures the main-canvas screen-scale LOD instead of the default 320-bin
inspector overview. Treat sample 1 as process-cold, not as a claim that the
operating-system page cache was flushed.

On the 10,327,171,329 bp POJ layout (11,744 component blocks), the 2026-08-12
release run measured `.mcool` overview LOD at 2.83-3.16 s (median 2.93 s) for
50,721 cells. Its first eight exact 2.5 Mb tiles took 17.27-17.44 s and 383,412
cells; the full 153-tile run exceeded five minutes and was stopped. Plain
`.cool` overview LOD took 24.61-29.91 s (median 25.93 s) for 51,360 cells, while
153 ordinary tiles took 165.03 s for 7,591,003 cells. These are backend
measurements; they exclude WebView IPC, decode, and GPU paint.

After wiring reusable coarse tiles into the 640 px central heatmap, the current
POJ `.mcool` plan selects 17.5 Mb output bins and six canonical 256-bin tiles.
The 2026-08-15 optimized dev/test-profile check on the 10,356,056,497 bp,
12,089-block layout completed three process-cold tile generations in
0.687-0.736 s. Each generation performed one HDF5 scan, returned 175,528 cells
in three center-first 2-tile chunks, and encoded 2,106,528 bytes. One plain
`.cool` check of the same tiled request shape completed in 6.67 s and returned
205,120 cells. These are backend measurements, not desktop IPC/decode/GPU paint
timings; they are deliberately not labelled release measurements.

For a local exact view of the plain 251 MiB `.cool`, the 2026-08-12 matched
16-tile release run reduced median backend completion from 14.14 s with two
ordinary eight-tile scans to 5.08 s with one scan (64% lower, 2.78x faster).
The warm single-scan samples emitted their first useful delta after 122-131 ms
and completed in 5.04-5.08 s. All samples reconstructed exactly 806,221
non-empty cells with a summed count of 21,988,531, matching the ordinary path.
The delta path emitted 35 chunks and 10.35 MiB of CST1 data. These are still
backend timings; WebView decode, React merge, and GPU paint require a separate
real-window measurement. A separate non-adaptive smoke run against the 1.3 GiB
`.mcool` selected its stored 2.5 Mb level, emitted its first delta at 40 ms, and
completed the same 16-tile request in 0.77 s; this validates the stored-level
single-scan path but is not a comparison with the default adaptive refinement.

The follow-up scan hot-path pass derives `bin1_id` from the validated Cooler
`indexes/bin1_offset` CSR index instead of reading the redundant
`pixels/bin1_id` array, removes the two per-contact projected-position `Vec`
allocations, and rejects cells outside the requested tile set before sparse
aggregation. On the same 16-tile `.cool` benchmark, the single-scan median fell
again from 5.08 s to 3.70 s (27% lower); warm first-delta latency remained about
124 ms and the exact 806,221-cell / 21,988,531-count result was unchanged. The
matched legacy two-batch path also benefited from the shared reader/projector
changes but still took a 10.02 s median, making single-scan 2.71x faster in the
same build. Relative to the original 14.14 s two-batch baseline, the combined
path is 3.82x faster. The non-adaptive stored 2.5 Mb `.mcool` smoke case fell
from 0.77 s to 0.54 s with its final result unchanged.

### Persistent plain-COOL LOD cache

Plain `.cool` overview and main-canvas LOD responses are persisted under the
Tauri application cache directory in `contact-lod-v1/`; the input file is never
modified. A cache key includes the canonical source path, source byte length,
modification timestamp, source/target resolutions, normalization, viewport,
and every layout block field. A file change, resolution/normalization change,
viewport change, or AGP edit therefore produces a miss and an exact
reprojection instead of reusing stale scientific output. `.mcool` is excluded
because it already carries native pyramid levels.

On a miss, the normal exact `.cool` computation returns first. Its completed
response is then written on a blocking background worker without another Cooler
scan. Files use the versioned `CSL1` binary format, store the complete key for
collision verification, preserve `f64` bits, validate lengths before allocation,
and install through a fully flushed same-directory temporary file. A truncated
or incompatible entry is ignored, removed, and rebuilt. The default budget is
1 GiB and 128 entries; pruning only considers `.cslod` files in this dedicated
directory. Override the budget with `CSTUDIO_PERSISTENT_LOD_CACHE_MB` (clamped
to 64-4096 MiB), or set `CSTUDIO_PERSISTENT_LOD_CACHE=0` for rollback/control.

The 2026-08-12 POJ release benchmark used the 251 MiB `.cool`, 11,744 layout
blocks, and a 640-bin whole-genome target. The miss took 24.35 s and returned
205,120 cells; its background-format write took 62 ms and produced a 5.88 MB
entry. Five exact cache reads took 3.35-24.15 ms (median 4.29 ms), and every
loaded response matched the computed response exactly. These timings cover
backend disk decode and allocation, not frontend IPC or GPU paint.

With `CSTUDIO_PERF_LOG=1`, the overview completion reports
`persistent_cache=hit|miss|disabled`; background writes use the separate
`contact_lod_cache` event with entry size, write time, and pruning totals.

`CSTUDIO_PERF_LOG` is diagnostic output, not a stable API. Keep it unset during
ordinary use and automated correctness tests.

## Frontend color-scale and raster hot path

Automatic color fitting selects the visible positive-count P95 with an in-place
median-of-three, three-way quickselect. It intentionally retains Juicebox's
existing percentile index while avoiding a full numeric sort.

Each populated contact tile is painted as one complete `ImageData` upload. The
rasterizer normalizes counts into a cached 256-entry packed RGBA lookup table, writes the
tile's byte buffer, then calls `putImageData` once instead of building an RGBA
string and calling `fillRect` for every contact cell. The canvas backing size is
kept equal to `tileSizeBins`, so one contact bin remains one backing pixel.
Diagonal symmetry and off-diagonal transpose are performed in the rasterizer.
Each canvas reuses its `ImageData`; explicit empty tiles take a `clearRect` fast
path without allocating or uploading an RGBA buffer.

The optional palettes have discrete color stops. Their LUT lookup remains
colormap-aware so values exactly on Viridis/Magma/Inferno/Turbo boundaries keep
the same color as the direct renderer; do not replace it with a generic
`floor(intensity * 255)` lookup. Pixel-differential tests also cover linear and
log normalization, non-finite values, empty-tile clearing, and mirrored tiles.

## Frontend resolution-to-paint timing

Resolution and render-style transitions use two fixed tile surfaces. The
presented surface keeps its immutable colormap and color-scale snapshot while
the complete target generation is rasterized into a `visibility: hidden`
staging surface. The staging surface never receives pointer events or enters
the accessibility tree. Once every authoritative visible source/mirror canvas
has either uploaded its `ImageData` or completed the explicit empty-tile clear,
React removes the old surface and reveals the new one in one pre-paint commit.
An unavailable 2D context fails closed: the staging surface is discarded and
the last presented surface remains visible.

Automatic color fitting is resolved before a complete target map is published,
including full frontend-cache hits. This prevents a provisional target color
scale from producing an extra reveal in the same resolution generation.
Hidden staging commits are deliberately excluded from the public performance
milestones below. For a buffered transition, `react_commit_ms` records the
atomic reveal commit; when no retained front exists, it records the complete
front surface's presentation commit.

The same `CSTUDIO_PERF_LOG=1 npm run tauri dev` command also enables one WebView
line for every explicit resolution change that reaches a painted tile layer:

```text
CSTUDIO_PERF event=contact_tiles_frontend generation=... resolution=... visible_tiles=... canvas_count=... cache_hit=... ipc_count=... resolution_commit_ms=0 ipc_response_ms=... cache_merge_ms=... react_commit_ms=... last_tile_paint_ms=... total_ms=...
```

All frontend values are cumulative milliseconds from the instant immediately
before the resolution-changing UI action is dispatched. This covers explicit
slider commits plus zoom/fit/viewport actions that actually change the selected
contact resolution:

- `ipc_response_ms`: the latest visible tile-batch response. Prefetch responses
  do not move this milestone.
- `cache_merge_ms`: completion of the latest visible response's frontend cache
  merge.
- `react_commit_ms`: the commit that presents the complete target layer. For a
  buffered transition this is the atomic reveal after hidden target canvases
  are ready; an initial/direct complete front uses its presentation commit.
- `last_tile_paint_ms`: an upper bound for presentation. Every visible source
  and mirror canvas is ready, followed by two animation frames so at least one
  browser paint opportunity has passed.
- `total_ms`: equal to `last_tile_paint_ms`.

`generation` rejects late callbacks from the retained old frame or cancelled
requests. A full frontend cache hit intentionally reports
`ipc_response_ms=null`, `cache_merge_ms=null`, and `ipc_count=0`; React and paint
milestones are still measured. `canvas_count` is the visible source/mirror
canvas count. Prefetch canvases are not awaited explicitly, although any work
they perform in the same browser commit is naturally included in the upper
bound.

For a frontend-only diagnostic session, either set
`VITE_CSTUDIO_PERF_LOG=1`, use `?cstudioPerf=1`, or set the WebView's
`localStorage` entry with `localStorage.setItem("CSTUDIO_PERF_LOG", "1")` and
reload. The normal
`CSTUDIO_PERF_LOG=1` desktop command is preferred because it produces both
backend and frontend lines. A newly issued visible request shares the frontend
generation, but a retained spatial/adjacent/overview flight keeps the generation
and `scenario` of its original backend request while its cancellation ownership
is promoted. Use `scenario`, `request_id`, and the resolution fields when
correlating that reused work instead of assuming every line has the new
frontend generation.

## Tile response IPC and binary wire format

Tile requests use the versioned `get_contact_map_tiles_from_cool_binary_v1`
command by default. Rust returns `tauri::ipc::Response`, so the normal desktop
custom-protocol path delivers one real `ArrayBuffer` rather than serializing a
`Vec<u8>` as a JSON number array. The strict little-endian `CST1` payload is:

- a 16-byte header: magic, `u16` version/flags, `u32 tileSizeBins`, and
  `u32 tileCount`;
- one 24-byte directory record per tile: `u64 tileX`, `u64 tileY`,
  `u32 cellCount`, and `u32 dataOffset`;
- per-tile SoA data: tile-local `u16 x[]`, tile-local `u16 y[]`, alignment to
  eight bytes, then `f64 count[]`.

Empty requested tiles remain explicit directory entries. The WebView validates
the complete buffer, then copies each tile into independent typed arrays so one
LRU entry cannot retain an entire multi-tile IPC batch. Raster, automatic color
fitting, overview, and bounded layout preview iterate these arrays without
materializing one JavaScript object per contact. A diagnostic/rollback build can
retain the old JSON response with:

```sh
VITE_CSTUDIO_TILE_BINARY=0 CSTUDIO_PERF_LOG=1 npm run tauri dev
```

With performance logging enabled, correlate these lines by `request_id` and
also verify generation, scenario, and target resolution:

```text
CSTUDIO_PERF event=contact_tiles_binary_command ... response_cells=... response_bytes=... command_us=...
CSTUDIO_PERF event=contact_tiles_invoke ... response_cells=... response_bytes=... transport=array_buffer invoke_us=... decode_us=...
```

`command_us` ends after the synchronous worker and binary encoder, but before
Tauri transports the response. `invoke_us` ends when the raw `ArrayBuffer`
arrives; `decode_us` is the strict validation plus per-tile typed-array copy.
For user-visible response comparison, use old JSON `invoke_us` versus new
binary `invoke_us + decode_us`. The difference `invoke_us - command_us` is an
IPC/dispatch upper bound, not pure wire time: it can include WebView scheduling.
Do not subtract the cumulative frontend `ipc_response_ms`, which starts at the
UI action rather than the individual invoke.

The 2026-08-11 release/WKWebView check used the bundled 5.0 MiB COOL and
1,298-block AGP. A frontend miss backed by nine Rust visual-cache hits returned
388,445 cells at 500 kb. JSON took 176 ms from invoke to parsed response while
the Rust command took 4.971 ms. The binary response was 4,661,592 bytes; across
six repetitions its `invoke_us + decode_us` values were 17, 115, 115, 16, 115,
and 115 ms (`transport=array_buffer` in every sample). Thus the observed median
fell to 115 ms (35% below the matched JSON sample), with a 16-17 ms best case;
the remaining tail is real WebView/IPC scheduling and must not be presented as
eliminated. Smaller matched cold-path batches consistently removed about
7-22 ms from response completion. This is why the binary protocol was adopted,
but it also shows that reducing full-tile overfetch is the next relevant wire
optimization for dense views.

## Local exact-view single-scan delta streaming

The default binary path for a non-adaptive local exact view sends all missing
visible tiles to `stream_contact_map_tile_deltas_from_cool_binary_v1`. Rust
builds one viewport/source-range plan, scans the selected `.cool` or `.mcool`
resolution once, and incrementally projects contacts into the requested tile
set. About 32,768 pending projected cells are coalesced before a CST1 delta is
sent; the HDF5 reader itself is capped at 100,000 pixels per raw chunk. It reads
only bin2 and count payload arrays for that chunk (about 1.6 MiB at the widest
types) and advances bin1 directly through the validated CSR offsets. An empty
CST1 tile list is the explicit end-of-stream marker.

Deltas are additive, because contacts for one final cell can arrive in more
than one raw Cooler chunk. The frontend therefore keeps one dense accumulator
per requested tile. A transient Canvas overlay subscribes to each decoded CST1
delta, reads the updated cumulative values from those fixed buffers, and paints
only the cells named by the delta on the next animation frame. React, the LRU,
and the immutable tile renderer are not entered for every chunk. The end marker
builds exactly one final sparse snapshot per requested tile; the authoritative
layer then replaces the overlay after its final paint completes.

At the normal 256-bin tile size, fixed temporary storage is 589,824 bytes per
tile (eight-byte count plus one-byte occupancy flag per bin), or 9 MiB for the
maximum 16-tile local exact view. Direct consumption adds one reusable RGBA
ImageData buffer per visible source/mirror canvas, rather than retaining a
history of complete tile snapshots. Each 256x256 JavaScript RGBA buffer is
256 KiB; the 32-descriptor source-plus-mirror upper bound is 8 MiB, excluding
the browser's own canvas backing store. Final sparse tile arrays are still
retained by the existing cache; dense accumulators and overlay rasters are
released when the stream finishes. Backend working memory is bounded by the 100,000-pixel raw
read chunk, the requested visible tile universe, and the pending sparse
projection map; it does not retain 20 complete batch responses.

Whole-genome or otherwise large views return earlier through main-canvas
LOD-first and do not allocate these exact-tile accumulators. Raw 2.5 Mb `.mcool`
requests that use adaptive refinement also remain on the older progressive
path, so the second refinement scan and its exact-count semantics are not
silently changed. Set `VITE_CSTUDIO_TILE_SINGLE_SCAN=0` to restore the former
multi-scan visible-tile path. `VITE_CSTUDIO_TILE_STREAM=0` remains the broader
non-streaming control. To keep single-scan backend streaming while restoring
the former per-chunk immutable frontend snapshots, set
`VITE_CSTUDIO_TILE_DIRECT_DELTA=0`.

Run the allocation-path microbenchmark without opening the desktop UI:

```sh
npm run benchmark:contact-delta
```

It reports median accumulator time, snapshot builds, and full 256x256 snapshot
cell visits for a synthetic 16-tile, 35-chunk stream. This isolates the removed
frontend snapshot work; it is not a WKWebView frame-time or GPU-paint result.
On 2026-08-12, seven local samples processed 430,080 additive records in a
52.25 ms legacy median versus 11.69 ms direct median (4.47x for this isolated
stage). Snapshot builds fell from 576 to 16 and full-buffer cell visits from
37,748,736 to 1,048,576.

With `CSTUDIO_PERF_LOG=1`, a completed single-scan request emits:

```text
CSTUDIO_PERF event=contact_tile_delta_stream ... emitted_chunks=... response_cells=... response_bytes=... visited_contacts=... first_emit_us=... command_us=...
```

`response_cells` counts transmitted delta records and can exceed the final
non-empty cell count when a cell receives more than one delta. `first_emit_us`
ends when the channel accepts the first non-empty CST1 batch; it is not a GPU
paint measurement.

## Legacy center-first progressive tile streaming

The fallback binary path uses `stream_contact_map_tiles_from_cool_binary_v1`.
The frontend sorts missing
tiles by distance from the visible viewport center (accounting for upper-triangle
canonicalization), then submits that order as small chunks. The Rust worker
validates that the complete chunk plan covers the requested canonical tile set
exactly before registering the request or mutating either cache.

Each validated chunk now runs through visual-cache lookup, source-window cache,
Cooler reading when needed, projection, response packing, CST1 encoding, and
channel delivery before the next outer chunk begins. This is deliberately
different from computing the whole viewport and only splitting the finished
response: a cancelled drag can stop before outer tiles are read or projected,
and an initial or compatible pan view can merge the center tiles while outer
work is still pending. Source windows and completed visual tiles remain shared
through the existing caches, so overlapping later chunks reuse earlier work.

With `CSTUDIO_PERF_LOG=1`, every delivered chunk emits:

```text
CSTUDIO_PERF event=contact_tiles_progressive_chunk ... chunk_index=1 chunk_count=... requested_tiles=... returned_tiles=... response_cells=... response_bytes=... compute_us=... encode_send_us=... elapsed_us=...
```

`elapsed_us` is cumulative from command entry and therefore makes first-chunk
latency directly comparable with full command completion. `compute_us` covers
the chunk's cache/read/projection/packing work; `encode_send_us` ends when the
Tauri channel accepts the CST1 response. The final
`contact_tiles_binary_command` line still reports total completion. Set
`VITE_CSTUDIO_TILE_STREAM=0` for the non-streaming binary control build.

For a streamed pan, `contact_pan_pipeline.ipc_ms` and
`pointer_to_cache_merge_ms` retain the first delivered center chunk rather than
being overwritten by later outer chunks. `pointer_to_gpu_paint_ms` and
`total_ms` still end only after the complete visible layer has had a browser
paint opportunity. The difference exposes progressive first-useful-data versus
full-frame latency in one record.

## Resolution cache and idle prefetch

Frontend contact tiles use a resolution-aware LRU. A cache scope is the
explicit Cooler path, target resolution, tile size, and normalization tuple;
the physical tile key remains opaque and keeps its tile-local layout projection
fingerprint. The cache retains at most three scopes, 96 tiles, and 750,000
contact cells. The currently displayed scope and its visible/padded keys are
preferred during eviction, but all three limits remain strict.
The visible layer being assembled keeps references outside the reusable LRU
until it is published, so an unusually dense visible working set cannot become
permanently incomplete merely because it exceeds a cache budget.

Pointer panning keeps the displayed matrix on the compositor/WebGL path and
uses a separate data-only look-ahead viewport. The look-ahead is velocity
aware on each axis: slow motion requests half a tile ahead, rising smoothly to
one and a half tiles at four tiles per second. Direction reversals switch the
prefetch side immediately, motion samples are smoothed, and the existing tile
coverage signature suppresses requests until the intersecting tile set changes.
This policy changes only spatial prefetch timing; it does not alter the visible
viewport, contact resolution, normalization, or AGP projection.

After every visible batch and the same-resolution padding ring have completed,
the frontend waits for two animation frames and schedules the immediately
coarser and finer visible layers through `requestIdleCallback`. WebViews without
that API use a 250 ms timer fallback. Neighbor queues are round-robined and each
idle request contains at most two tiles. Idle work never updates React state,
status text, automatic color scale, or frontend timing milestones.

Idle requests reuse the current contact-tile generation and the normal in-flight
registry. They must not call `begin_contact_tile_generation`: advancing the
backend generation would cancel the visible layer. If the user selects a layer
while its idle request is in flight, the foreground generation retains that
request ID and shares the same promise. A new UI generation cancels remaining
idle scheduling; late completion from the old effect is ignored. Background
cache entries stay cold and are evicted before protected foreground tiles under
tile or cell pressure.

To avoid retransmitting the complete assembly layout on every tile IPC, the
frontend registers each immutable layout identity once with
`register_contact_map_layout`. Visible, spatial-prefetch,
adjacent-resolution, and overview tile requests then carry only a string
`layoutHandle`. If the backend reports an unknown or evicted handle, the
frontend re-registers that same immutable layout snapshot and retries the failed
tile request once; it does not enter an unbounded retry loop. The handle is only
IPC indirection: after resolving it, the backend still derives each tile's
projection fingerprint from the tile-local layout contents. The handle must not
replace that fingerprint in visual or source cache identity.

The 320-bin inspector overview uses the dedicated
`build_contact_map_overview_from_cool` command and does not create ordinary
256-bin viewport tiles, enter the interactive tile-flight registry, or consume the
three-resolution frontend tile LRU. For `.mcool`, the frontend selects the stored
resolution nearest to `whole-genome span / 320` and aggregates it only when the
display still needs a coarser integer multiple. It therefore does not read the
finest stored level by default. For single-resolution `.cool`, import samples the
native fixed-bin width and the same command aggregates that source directly to the
overview scale.

Overview remains subordinate to the visible layer: it is admitted only after the
current generation is acknowledged and the complete visible layer is painted. The
last complete overview stays on screen during layout edits and is atomically
replaced by one sparse whole-map response. Rust registers this work only against
the already current generation, so overview cannot advance the cancellation clock;
a newer visible generation cancels an obsolete overview at the normal HDF5
checkpoints.

The central heatmap switches to reusable coarse tiles when the selected exact
layer would require more than 16 visible tiles or more than two matrix bins per
screen pixel. Its target resolution follows the longer genomic span per canvas
axis; `.mcool` reads the nearest stored level and `.cool` reads its native level.
The coarse layer is aligned to the same genomic origin on a fixed 256-by-256-bin
grid. Panning at one LOD level therefore reuses every overlapping tile and asks
only for the newly exposed edge. Cold visible tiles are ordered by distance from
the viewport center in batches of two; directional spatial prefetch remains
bounded to eight off-screen tiles.

The visible request carries the chosen stored `sourceResolution` separately
from the coarser tile `targetResolution`. Rust performs one bounded dense,
indexed HDF5 scan for the complete visible set, stores all canonical tile
results, and then emits them in the two-tile center-first chunk order. The
source resolution participates in backend visual-cache identity. This avoids
both requests for nonexistent synthetic `.mcool` groups (for example 17.5 Mb)
and the cold-start regression of scanning once per presentation chunk.

Coarse navigation has a dedicated four-scope LRU (64 tiles, 1,500,000 cells)
and in-flight registry, so whole-genome motion cannot evict exact local editing
tiles. Resolution/layout transitions retain the previous complete surface;
same-LOD pans can immediately compose cached overlap while missing edge tiles
arrive. Zooming into a local view automatically restores the exact AGP-aware
tile path. A complete whole-genome tiled LOD is reused by the inspector Overview
rather than scanning the same matrix again. Set
`VITE_CSTUDIO_MAIN_LOD=0` for the ordinary-tile control build.

## Exact AGP-aware 2.5 Mb mcool refinement

Raw 2.5 Mb tile requests against a multiresolution `.mcool` use an exact
short refinement chain when the file contains `2.5M, 500k, 100k, 10k, 1k`:

```text
2.5M -> 500k -> 100k -> 10k -> 1k
```

A source bin is accepted at its current level only when its complete half-open
interval projects through exactly one current AGP component and remains inside
one visual 2.5 Mb bin. Otherwise its parent pixel is replaced by child pixels.
The reader uses `indexes/bin1_offset`, batches adjacent child rows into one HDF5
slice, and binary-searches the sorted `bin2_id` values inside each row. A
128 MiB byte-bounded LRU caches child blocks by file fingerprint, parent/child
resolution, and parent bin pair. Missing levels, non-Raw normalization, other
target resolutions, duplicate source names, and unsupported requests retain the
conventional reader. Set `CSTUDIO_ADAPTIVE_MCOOL=0` for a complete rollback.

For `.mcool` imports, the resolution slider selects an existing pyramid level
without changing the genomic viewport. Import reads `/resolutions`, filters out
levels absent from the file, and hides levels whose current visible matrix
would exceed 6,144 bins on either axis. Plain `.cool` imports retain the
existing resolution-coupled zoom and realtime aggregation behavior.

On the 10.327 Gb POJ layout, a 640 Mb center interval produced 28,878 cells and
a total count of 2,399,859 in both the 1 kb baseline and adaptive result (zero
cell or count difference). The production adaptive path took 1.531 s cold and
339 ms with all 179,775 requested parent blocks cached; the exact 1 kb baseline
took 881 ms in the same release process. This supports the cached drag path but
does not claim a cold-start improvement. Direct 2.5 Mb projection took 124 ms
but was scientifically different and is therefore not used as the exact result.
