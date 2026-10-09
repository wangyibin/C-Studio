# Remote projects and files

C-Studio Desktop can open an HTTP/HTTPS project directory or file URL without
installing a C-Studio service on the remote machine. Choose
**Add Data → Remote project or file…** and enter, for example:

```text
http://host.example/project/
http://host.example/project/input.mcool
```

A project address must return a conventional HTML directory listing. C-Studio
recognizes `.agp`, `.cool/.mcool`, `.depth/.bedgraph/.bg`, `.paf`, and `.gfa`
files in that directory, downloads them into the application cache, and loads
them in the same order as a local project. A direct file URL downloads and opens
only that file without clearing other loaded data. Direct URLs ending in
ambiguous `.txt` are not guessed.

This mode downloads each selected file completely. It is suited to ordinary
static file servers, shared projects, and small or medium datasets. The desktop
backend performs the download, so the server does not need CORS headers. A
bearer token can be supplied for a protected static server.


## Simple launcher package

Once maintainers build and distribute the Linux package for this version, extract it,
enter its directory, and run:

```bash
./cstudio /data/project/input.mcool
```

The launcher creates a bearer token, starts the server in the background, and prints
connection details. Paste the URL and token into **Add Data → Remote project or file…**.
Prebuilt-package users do not need Rust, Node.js or a desktop environment.

```bash
./cstudio status
./cstudio stop
```

The default port is 8787; use `./cstudio /data/other.mcool 8788` for another dataset.
It can continue after logout, subject to the host's user-process policy, but does not
restart automatically after a reboot. Run the same command again after reboot.
Direct HTTP access is for trusted private networks; public access needs HTTPS.
The launcher does not change firewall rules.

Maintainers build packages on Linux with `bash scripts/package-server.sh`, or use the
manual **Package C-Studio server** workflow for x86_64 and ARM64 artifacts. The workflow
does not publish a release. Source-build instructions below remain available.

## On-demand access for large contact maps

For `.cool` or `.mcool` files that are too large to download, C-Studio can use
the read-only `cstudio-server` HTTP API. The desktop application reads metadata
once, then requests only overviews and visible tiles as the user navigates.

The on-demand service currently covers contact maps only. AGP, PAF, GFA, and
coverage are downloaded from static links and then imported locally.

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
| `POST` | `/v1/datasets/{id}/overview` | A bounded overview for navigation |
| `POST` | `/v1/datasets/{id}/tiles` | Sparse binary `CST1` contact tiles |

The client sends the current AGP-derived layout with view requests, so server
projection follows the same order, orientation, and source intervals as the
desktop workspace. Dataset files are opened read-only; no endpoint modifies the
source file.

## Operational requirements

- The service process must be able to read every registered `.cool` or `.mcool`
  file and traverse its parent directories.
- Keep dataset files stable while the service is running. Replace a file by
  restarting the service rather than overwriting it in place.
- Allow inbound traffic to the selected port and allow the desktop client to
  reach the advertised hostname.
- Use a reverse proxy for TLS, access logs, rate limits, and organization-level
  authentication when exposing the service beyond one trusted workstation.

The initial implementation uses the existing C-Studio reader caches within one
service process. It does not yet provide a distributed tile cache, resumable
offline downloads, or remote imports for the text evidence formats.

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
uses the same Bearer authentication. Layout interaction remains local while
matrix reading and heatmap rendering remain remote. Saving edits exports locally
and does not overwrite the server file.

### Remote read optimization

Remote main views use the local main surface's LOD decision function and send
explicit source/display resolutions. The server must not silently replace that
plan. Prefetch margins cannot change bin sizes or visible image density; margins
shrink first when image capacity is limited. Auto scale samples every tenth
record per complete visible tile, excludes diagonal cells, and uses the same P99
and scale-cache rules. Prefetch tiles are excluded. Both paths wait for the
complete visible tile set before fitting the initial scale so arrival order
cannot change the threshold. Palette steps, opacity and log mapping also match.

The server caches projected views with a 64 MiB budget and at most 256 LRU entries.
Palette and scale changes reuse counts while encoding a fresh PNG. Keys include
file path, size, modification time, layout, viewport, read/display resolutions,
and normalization. In-flight work and references held by requests are additional
memory; this is not a process RSS limit. Response headers
`x-cstudio-source-resolution` and `x-cstudio-cache` report the chosen level and
cache result. The desktop local reader does not use this server cache.

The remote main image includes about 25% extra context per side within the existing
pixel limit. Small pans at the same zoom/style/layout reuse that image. Approaching
its edge starts background warming, retaining at most one request or completed
result. Pointer-up reuses that request without the former fixed 100 ms delay.
Previews do not publish UI state; layout, resolution, or style changes invalidate
them. Large pans and cold reads can still expose empty edges while a new image loads.

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
Authenticated `GET /v1/datasets/{id}/cache` reports process-wide cache and worker
statistics. Warming starts when a layout is registered; first registration and
uncached fine levels can still incur computation.
