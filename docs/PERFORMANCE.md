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

The 320-bin inspector overview uses the same tile pipeline instead of the legacy
full-view command. It is admitted only after the current generation is acknowledged,
and the complete visible layer is painted. It starts directly rather than waiting for
layout debounce, a global flight drain, or speculative adjacent-resolution prefetch;
that prefetch yields while the overview tile flight is active. The last complete
overview stays on screen during layout edits and is atomically replaced only after
every new overview tile is available. Rust registers this work only against the
already current generation, so overview cannot advance the cancellation clock; a
newer visible generation cancels an obsolete overview at the normal HDF5 checkpoints.
