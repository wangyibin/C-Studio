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
