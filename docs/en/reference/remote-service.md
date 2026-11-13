# Remote service deployment and caching

For connection steps, see [Using remote files](../user-guide/remote-contact-service.md). This page covers service deployment and maintenance.

Maintainers build Linux x86_64 / ARM64 packages with `bash scripts/package-server.sh` or the **Package C-Studio server** GitHub workflow. The build does not publish a release automatically.

## Build the service

From the C-Studio source directory:

```bash
cargo build --release \
  --manifest-path crates/cstudio-server/Cargo.toml \
  --features portable-hdf5
```

The `portable-hdf5` build compiles HDF5 and zlib into the service build, so the
server machine does not need a separately installed HDF5 runtime. The resulting
binary is under `crates/cstudio-server/target/release/`.

## Start on the local machine

```bash
crates/cstudio-server/target/release/cstudio-server \
  --dataset example=/absolute/path/to/input.mcool
```

The safe default listens only on `127.0.0.1:8787`. In C-Studio, choose
**Add Data → Remote project or file…** and enter:

```text
http://127.0.0.1:8787/v1/datasets/example
```

Repeat `--dataset ID=PATH` to publish more than one whitelisted file. The
service does not accept arbitrary filesystem paths from clients.

## Serve another machine

Create a file containing one strong bearer token, then start the service on a
private interface:

```bash
crates/cstudio-server/target/release/cstudio-server \
  --bind 0.0.0.0:8787 \
  --token-file /absolute/path/to/cstudio-token.txt \
  --dataset example=/absolute/path/to/input.mcool
```

Enter the same token in C-Studio's connection dialog. The token stays in the
current application memory and is not written into a project file.

For traffic outside a trusted private network, put the service behind an HTTPS
reverse proxy and use an `https://` dataset URL. A bearer token over plain HTTP
can be read in transit. The service refuses a non-loopback listener without a
token unless `--allow-unauthenticated-remote` is explicitly supplied.

## API boundary

API version 1 exposes:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/health` | Liveness and API version |
| `GET` | `/v1/datasets` | Registered datasets |
| `GET` | `/v1/datasets/{id}/metadata` | Format, size, resolutions, and sources |
| `GET` | `/v1/datasets/{id}/assembly` | Companion AGP |
| `POST` | `/v1/datasets/{id}/layouts` | Register a layout revision |
| `POST` | `/v1/datasets/{id}/render` | Server-rendered heatmap PNG |
| `GET` | `/v1/datasets/{id}/cache` | Cache and warming status |
| `POST` | `/v1/datasets/{id}/overview` | A bounded overview for navigation |
| `POST` | `/v1/datasets/{id}/tiles` | Sparse binary `CST1` contact tiles |

The client registers the AGP-derived layout and references its revision, so server
projection follows the desktop order, orientation, and source intervals. Older
servers receive the full layout. Dataset files remain read-only; no endpoint
modifies the source file.

## Operational requirements

- The service process must be able to read every registered `.cool` or `.mcool`
  file and traverse its parent directories.
- Keep dataset files stable while the service is running. Replace a file by
  restarting the service rather than overwriting it in place.
- Use an SSH tunnel for a loopback listener; for direct access, make the advertised
  service address reachable from the client.
- Use a reverse proxy for TLS, access logs, rate limits, and organization-level
  authentication when exposing the service beyond one trusted workstation.

The initial implementation uses the existing C-Studio reader caches within one
service process. It does not yet provide a distributed tile cache, resumable
offline downloads, or server-side PAF/GFA/coverage processing.

## Server-side rendering

Updated clients automatically use server rendering when dataset metadata advertises `png-v1`.
The Linux service reads, projects through the current AGP layout, aggregates and colors the
matrix. `POST /v1/datasets/{id}/render` returns a PNG for both the main viewport and overview.
The desktop keeps selection, axes and editing controls; it does not download matrix tiles or
build a matrix GPU atlas for these views.

Build and connect as above after updating both client and server. The status bar reports
`server rendering` / `Server rendered contact map`. Older servers without this capability
continue using client rendering, with an upgrade notice in the connection status.

Each image is limited to 1,048,576 pixels and 2048 pixels per side. Display bins are aggregated
to screen size in integer multiples of the selected stored resolution; the status bar reports
the actual display resolution. Each process admits two concurrent PNG jobs. Busy requests
return 429 and the client retries with backoff. Replaced viewport requests are aborted, stale
responses are discarded, and workers cooperatively stop reading when cancellation is observed.
Images retain their original viewport coordinates while panning. Assembly edits, normalization,
resolution and palette changes request a new rendering. Automatic color thresholds are reused
per dataset, selected resolution and log setting across normalization changes.

AGP editing remains local. PAF, GFA, coverage and explicitly requested numerical evidence
queries can still consume client memory. This is not a full browser application or a migration
of every computation. Image and aggregation limits do not bound total process RSS: HDF5 readers,
normalization weights, layouts and concurrent reads also consume memory. Measure peak client and
server memory and interaction latency with representative datasets before sizing deployment.

### Automatic remote AGP loading

Place an AGP beside the published `.cool/.mcool`. On startup the server prefers
an AGP with the same basename, otherwise it selects the sole `.agp` in that
directory. Ambiguous candidates are not selected. Only regular files are served;
symlinks are excluded and the size limit is 32 MiB. Restart after adding or
changing the AGP.

Connecting with an empty assembly automatically loads the companion AGP; an
existing assembly and its edits are preserved. `GET /v1/datasets/{id}/assembly`
uses the same authentication settings; no token is needed when authentication is
disabled. Layout interaction remains local while
matrix reading and heatmap rendering remain remote. Saving edits exports locally
and does not overwrite the server file.

### Remote read optimization

Remote main views use the local main surface's LOD decision function and send
explicit source/display resolutions. The server must not silently replace that
plan. Prefetch margins cannot change bin sizes or visible image density; margins
shrink first when image capacity is limited. Auto scale samples positive off-diagonal bins intersecting the current viewport
(including mirrored bins), using a coordinate hash independent of tile storage
format. Views with up to 10,000 eligible bins use every value; larger views sample
approximately one tenth. Both paths retain P99 and wait for complete visible
tiles. Scale caches are per resolution and retain at most 128 entries. Panning keeps
Max stable; switching levels restores that level’s estimate. Clicking Auto
explicitly refits the current viewport at the current level, including when Auto
is already active. Manual ranges remain unchanged.
Palette steps, opacity and log mapping also match.

The server caches projected views with a 64 MiB budget and at most 256 LRU entries.
Palette and scale changes reuse counts while encoding a fresh PNG. Keys include
file path, size, modification time, layout, viewport, read/display resolutions,
and normalization. In-flight work and references held by requests are additional
memory; this is not a process RSS limit. Response headers
`x-cstudio-source-resolution` and `x-cstudio-cache` report the chosen level and
cache result. The desktop local reader does not use this server cache.

Ordinary remote main views fill newly exposed regions with fixed PNG tiles during
pan and switch to an exact viewport image at rest. Layout, zoom, or style changes
invalidate the old tile layer; see “Image tiles during pan” below.

Both Overview paths use the same fixed 320-bin plan, independent of main-layer
completion order. Overview opacity is 0.9 and main opacity is 0.88 in both paths.
New clients verify the display contract and returned display resolution; an old
server triggers an upgrade message instead of silently using different rules.

Complete-tile projection caches use the read extent rather than the PNG crop.
Pans within the same tile set reuse counts and redraw the new camera; layout,
resolution, normalization and file changes invalidate the relevant cache. Cold
reads and entry into uncached tiles still require server computation.


### Layout revisions and independent tile reuse

`POST /v1/datasets/{id}/layouts` registers a layout and returns `layoutId`.
Main, overview, and pan-prefetch render requests then send the revision only.
Identical layouts share registration; edits create a new revision. The registry
retains at most 32 revisions / 32 MiB. Expiry or restart returns HTTP 410;
the client registers again and retries once. Older servers retain inline layouts.

Ordinary projected counts are cached per tile, including empty tiles. Only missing
tiles are read/projected on a boundary crossing. Keys include layout revision,
file identity, source/target resolution, normalization and tile size. The shared
count cache retains at most 256 entries / 64 MiB (not a process RSS limit).
Adaptive refinement retains its complete-neighborhood cache to preserve semantics.
Pan prefetch and pointer-up reuse remain enabled; cold reads still take time.


### Background warming and persistent counts

Layout registration warms Overview and bounded global coarse levels. The queue
holds at most 128 tiles. A successful foreground render schedules up to 16
neighbor tiles; the latest neighborhood has priority. One background worker waits
for idle render capacity and cooperatively cancels when foreground work arrives.
Adaptive refinement is excluded from independent neighbor warming.

Count tiles persist under `$XDG_CACHE_HOME/cstudio-server/port-<port>/counts-v1`
(or `~/.cache/cstudio-server/port-<port>/counts-v1`). Default budget: 4 GiB.
`CSTUDIO_DISK_CACHE_DIR` selects a dedicated root; `counts-v1` is created beneath
it. `CSTUDIO_DISK_CACHE_MB` sets the MiB budget (0 disables persistence), and
`CSTUDIO_PREWARM=0` disables warming. Restart to apply settings; use a separate
custom directory for each server instance.

Keys include stable layout content, file state, resolution, normalization and
tile size. SHA-256 checksums reject corrupt entries; missing/corrupt entries are
recomputed, and write failures do not fail the render. Budgets are not RSS limits.
`GET /v1/datasets/{id}/cache` reports process-wide cache and worker statistics;
authentication is required only when a token is configured. Warming starts when a layout is registered; first registration and
uncached fine levels can still incur computation.

### Image tiles during pan

Remote pans compose retained images immediately and prefetch PNG tiles on a fixed genomic grid. Decoded tiles repaint the canvas during the gesture without waiting for pointer release. Reversals reuse retained tiles. Visible tiles take priority, with two concurrent loads, a bounded queue, a 32 MiB decoded-image budget, and look-ahead based on direction, velocity and recent latency.

Tiles share the main view's resolution, normalization, palette and fixed color scale. Layout, style or zoom changes discard the old layer. An exact viewport image is retained at rest to preserve final pixel boundaries. Neighborhood-dependent adaptive refinement keeps the full-frame path. Newly exposed uncached areas may still need time to arrive.

The server caches encoded PNG results, skipping projection, painting and encoding on a hit. Its encoded-image memory budget is 32 MiB. Persistent images share the existing `CSTUDIO_DISK_CACHE_MB` budget with count tiles and survive restarts. Keys cover file identity, layout content and the complete render parameters. `x-cstudio-image-cache: hit` identifies finished-image reuse; `/cache` reports process-local image cache statistics under `images`. These budgets are not process RSS limits.

Updating the server enables finished-image reuse. In-gesture tile presentation also requires the updated desktop client; save edits before quitting and reopening it.
