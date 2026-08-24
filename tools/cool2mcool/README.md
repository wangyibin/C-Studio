# cool2mcool

`cool2mcool` is a standalone command that converts a fixed-bin, symmetric-upper
1 kb `.cool` file into a normalized multi-resolution `.mcool` file. It is a
self-contained crate with no host-application or workspace dependencies.

Version 0.7 generates the MCOOL v2 pyramid directly in Rust, then
computes and stores ICE, VC, and VC_SQRT normalization vectors at every
physical resolution, plus KR at configured resolutions. It does not require
Python or invoke `cooler`. Independent
resolution branches use two level lanes by default. HDF5 calls remain serialized
by the library lock, while bounded pixel batches from those lanes share one
configurable Rayon pool and are committed in source-row order within each level.
In pyramid mode, two eligible levels with the same parent share one physical
parent-pixel read and aggregate independently from that shared batch. Common
work spans end only where both target bin1 rows end, preserving deterministic
floating-point accumulation.
The same bounded worker configuration then runs ICE row products and KR
matrix/vector kernels. Exactly one pool is alive at a time: the phase-scoped
zoomify pool is released before the normalization pool is created, returning
worker-local allocation caches without ever nesting or oversubscribing pools.

The normalization scopes match C-Studio: KR and ICE balance
the whole assembly (including cis and inter contacts), while VC and VC_SQRT are
calculated independently from chromosome-cis contacts. KR uses the shared
global symmetric CSR for bounded percentile retries and only changes the active
mask. Before a large staged level enters its final extended retry, it compacts
active rows and columns in place, preserving row order while reusing the
existing column/count allocations. KR
support construction, matrix-vector products, and independent vector kernels
use the configured worker pool while preserving stable per-row and scalar
reduction order. The final retry warm-starts from the last bounded KR iterate,
maps it by stable global bin ID, removes degree-one leaf-to-hub rows that do not
have a finite matrix-balancing solution, and performs 16 compact-support
prebalance products before BNEWT. It follows Juicebox's
0, 1, 2, 3, 4, and 10 percent retries, then permits a 15 percent retry for a
whole-assembly matrix that remains structurally unscalable at 10 percent. The
selected threshold is stored as `cool2mcool_coverage_percentile` on each `KR`
dataset.

If ICE does not reach its strict tolerance at a sparse coarse level, the command
stores its final 200-iteration vector and marks it with
`cool2mcool_fallback=final-iterate-not-converged` plus the observed relative
marginal variance. Other normalization columns are unchanged, and consumers can
distinguish this explicitly from a converged `weight` vector.

## Prerequisites

- [Pixi](https://pixi.prefix.dev/) 0.43.3 or newer.

Pixi locks Rust/Cargo, CMake, Make, and the Linux C/C++ toolchain for
`linux-64`, `linux-aarch64`, and `osx-arm64`. `hdf5-sys/static` compiles its
bundled, supported HDF5 1.10.7 release, so neither HDF5 headers nor shared
libraries need to be installed on the host. macOS still requires the standard
Xcode Command Line Tools for the Apple SDK, linker, and archive tools.

## Build with Pixi

```sh
pixi install
pixi run check
pixi run build
```

## Benchmark environment

The default environment is limited to the native Rust converter. The optional
Linux-only benchmark environment adds Bioconda's `pretext-suite` 0.0.2 and
`3d-dna` 201008 without changing the default environment. Pretext Suite's
`pretextgraph` dependency has no `osx-arm64` build, so install these tools on
the Linux benchmark host:

```sh
pixi install -e benchmark
pixi run -e benchmark benchmark-tools
```

Run converter benchmarks in the same environment with `pixi run -e benchmark
run ...`. Pretext and 3D-DNA require their own contact-map/assembly inputs;
they are installed for controlled external-tool comparisons and are not invoked
by `cool2mcool` itself.

Run the release binary through the same locked environment:

```sh
pixi run run input.1k.cool output.mcool
```

For a manual Cargo build outside Pixi, install Rust 1.80 or newer and make an
HDF5 development/runtime installation discoverable to the Rust `hdf5` crate.

## Install

From this repository:

```sh
cargo install --path tools/cool2mcool
```

Or build a local release binary:

```sh
cargo build --release --manifest-path tools/cool2mcool/Cargo.toml
```

## Run

```sh
cool2mcool input.1k.cool output.mcool
```

The native Rust engine uses up to eight workers and two dependency-aware resolution
lanes by default. Both lanes share the same worker pool; they do not create two
eight-thread pools. Set the bounded worker count with `--threads N`. Use
`--level-parallelism 1` to restore serial level execution, or choose any positive
lane count no greater than `--threads`.

Two lanes target large contact maps. Because HDF5 and compressed dataset I/O
still contend on a process-wide library lock, small maps can be faster and use
less peak memory with `--level-parallelism 1`; the flag is the explicit
performance rollback when that workload is more important.

`--aggregation-mode pyramid` is the default: every target level reuses the
closest completed divisor to avoid rescanning the 1 kb pixels. For a direct
comparison, `--aggregation-mode direct` makes every requested coarse level an
independent aggregation from the 1 kb input. Direct mode can start all nine
coarse levels in the default ladder concurrently with `--threads 9
--level-parallelism 9`; pyramid mode still follows its parent dependencies and
uses the same setting only as a high-lane comparison:

```sh
pixi run run --threads 9 --level-parallelism 9 --aggregation-mode pyramid input.1k.cool pyramid.mcool
pixi run run --threads 9 --level-parallelism 9 --aggregation-mode direct input.1k.cool direct.mcool
```

The generated contact counts are mathematically equivalent; direct mode is a
comparison baseline and can consume substantially more input I/O and memory.

Generated and rebuilt datasets use gzip level 1 by default for faster output.
For a smaller file at the cost of additional compression time, select level 6:

```sh
cool2mcool --compression-level 6 input.1k.cool output.compact.mcool
```

`--compression-level` accepts 1 through 9. It applies to datasets created or
rebuilt by `cool2mcool`, including normalization columns. The 1 kb level and
coarse-level `chroms` tables are copied as HDF5 objects and retain the source
filters instead of being recompressed.

The default resolution selection is:

```text
2500000,1000000,500000,250000,100000,50000,25000,10000,5000,1000
```

Use `--resolutions` for another comma-separated selection. It can be supplied
from coarse to fine or fine to coarse; `cool2mcool` canonicalizes it to an
increasing 1 kb-based ladder. The 1 kb input acts as the internal source level,
but it need not be included in the output: for example, `--resolutions 5000,10000`
writes only `/resolutions/5000` and `/resolutions/10000`. Every value must be a
positive multiple of 1,000 bp.

KR is generated at every level by default. To skip the expensive 1 kb KR phase
while retaining true KR at 5 kb and coarser levels, set its minimum resolution:

```sh
cool2mcool --kr-min-resolution 5000 input.1k.cool output.mcool
```

`--kr-min-resolution` defaults to `1000` for backward-compatible output and must
be a positive multiple of 1,000 bp. Levels below the threshold retain their
standard ICE `weight`, VC, and VC_SQRT columns but do not contain `bins/KR`;
ICE is never relabeled as KR. Consumers should select ICE at those levels rather
than silently calculating or claiming KR.

Existing outputs are rejected. Add `--force` to atomically replace one only
after the new file has been fully generated, flushed, and synchronized.

## Stored columns

Every `/resolutions/<bp>/bins` table receives:

| Normalization | Column | Convention | Scope |
| --- | --- | --- | --- |
| ICE | `weight` | multiplicative | whole assembly |
| KR | `KR` | divisive | whole assembly, cis + inter; only at or above `--kr-min-resolution` |
| VC | `VC` | divisive | chromosome cis |
| VC_SQRT | `VC_SQRT` | divisive | chromosome cis |

Invalid or excluded bins are stored as `NaN`. Each resolution group records its
actual columns in `cool2mcool_normalizations`; the file-level manifest records
their union, and `cool2mcool_kr_min_resolution` records the configured threshold.
Each dataset includes a boolean
`divisive_weights` attribute, a `cool2mcool_normalization` label, its scope, and
the normalization schema version. When at least one level contains KR, the
file-level manifest records its algorithm as
`whole-assembly-compact-csr-continuation-warm-start-v4`.

Before reading each level, the command estimates the peak matrix/CSR working
set and limits it to 80% of currently available memory. Pixel columns are read
twice in bounded chunks to construct one shared symmetric CSR directly; a full
COO matrix is never retained beside the CSR. The selected normalizations reuse
that same row-stable matrix. Generated output is installed atomically only after
every resolution and every selected normalization column passes validation.

At a level that includes KR, ICE and KR share one global coverage vector. ICE
reuses its matrix-product and marginal buffers across iterations, and VC plus
VC_SQRT share one chromosome-cis coverage pass. Their final chromosome scaling
is fused into one upper-triangle scan. When six simultaneously retained
normalization vectors
would exceed 128 MiB, the generator switches to a staged path that writes and
releases ICE and the fused VC pair before KR consumes the shared matrix. The
final extended KR retry then rewrites that matrix as an active-only compact CSR
in place, eliminating the global expansion vector without coexisting adjacency
copies. This bounds large-map resident memory; structurally unscalable
leaf-to-hub bins are explicitly excluded from KR and stored as `NaN`.
On supported allocators, spare pages from zoomification are returned before
normalization begins.

KR reuses its scaled-direction buffer for the subsequent sparse product and
recomputes inexpensive Hessian terms when needed. It therefore does not retain
separate `z`, `next_y`, product, or Hessian vectors across BNEWT iterations.
Active global bin indexes use `u32`, matching the validated CSR index range.

Set `COOL2MCOOL_PERF_LOG=1` to print native coarsening, shared coverage, ICE,
KR, fused VC, scaling, compact-CSR retention, exact outer/inner/MVP counts, MVP
time, effective CSR bandwidth, support, and percentile timings. Each completed
native coarsening record includes per-level `read_ms`, `aggregate_ms`,
`write_ms`, residual `other_ms`, source/output pixel counts, work spans, and
successful non-empty pixel append calls. It also reports PixelWriter
`write_batches` and the final buffered batch size, `final_batch_pixels`.
Eligible sibling pairs additionally emit `rust_coarsen_siblings` with
`source_spans_read`, `hdf5_slice_reads`, `physical_read_pixels`, and
`logical_target_pixels`; the last value counts the same shared source pixels
once per target.
Pixel columns are committed in four-chunk batches aligned to the
262,144-element HDF5 chunk, followed by one tail write. Native zoomify opens the
input with an 8 MiB raw chunk cache and the
destination with a 16 MiB cache (`w0=1.0`); HDF5 applies this limit per open
dataset, so peak RSS should be checked when changing level parallelism. Phase
times are wall times within one level and can overlap when level lanes run
concurrently; use each batch's critical path rather than summing concurrent
level totals.
