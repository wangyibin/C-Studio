# Testing C-Studio

C-Studio uses Vitest for TypeScript state, component and workflow tests, and
Rust's built-in test harness for the core engine, desktop commands, remote
server and `cool2mcool`. The [Tests workflow](.github/workflows/tests.yml) runs
on pushes, pull requests and manual dispatches. Tests use committed or synthetic
data; no institutional data or running remote service is required.

## Quick start

Run these commands from the repository root with Node.js 22:

```bash
npm ci
npm test
npm run build
```

`npm test` runs every discovered Vitest test, including `tests/integration/`.
`npm run build` checks the application TypeScript and builds the frontend.
To run only the small curation workflow or create the CI report:

```bash
npm run test:integration
npm run test:ci
```

The CI command writes `test-results/vitest.xml` as JUnit XML in addition to the
console report. A failed assertion returns a nonzero exit status.

## Rust tests

CI uses Rust 1.91.1 on Ubuntu 22.04. Install a C/C++ compiler, CMake, pkg-config
and the platform's [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).
On Ubuntu 22.04 the required packages can be installed with:

```bash
sudo apt-get update
sudo apt-get install -y build-essential cmake ninja-build pkg-config zlib1g-dev \
  libwebkit2gtk-4.1-dev libxdo-dev libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev
```

Run each crate explicitly: the repository does not have a single root Cargo
workspace. `--locked` uses its committed `Cargo.lock`. `portable-hdf5` builds
HDF5 from source, avoiding a dependency on a separately installed HDF5 runtime;
`cool2mcool` already enables static HDF5 in its manifest.

```bash
cargo test --locked --manifest-path crates/cstudio-core/Cargo.toml --features portable-hdf5
cargo test --locked --manifest-path src-tauri/Cargo.toml --features portable-hdf5
cargo test --locked --manifest-path crates/cstudio-server/Cargo.toml --features portable-hdf5
cargo test --locked --manifest-path tools/cool2mcool/Cargo.toml
```

These commands require dependency downloads on the first run. After dependencies
are cached, add `--offline` to disallow network access. The existing Pixi package
environment can also supply Node, Rust and build tools: prefix a command with
`pixi run --locked -e package` after installing a Pixi version compatible with
the repository lockfile. CI's Rust version and the release-packaging Pixi
environment are separate, explicitly versioned environments.

To run only the synthetic contact-matrix regression:

```bash
cargo test --locked --manifest-path crates/cstudio-core/Cargo.toml \
  --features portable-hdf5 --test curation_workflow
```

## Coverage of behavior

| Area | Tests | Main checks |
|---|---|---|
| AGP and assembly editing | `src/state/importers.test.ts`, `agpExport.test.ts`, `assemblyEditing.test.ts` | Coordinate conversion, component/gap metadata, move, reverse, split and copy behavior |
| History and UI state | `src/state/uiState.test.ts`, `operationHistoryPersistence.test.ts` | Undo/redo, history validation and restoration |
| Complete curation sequence | `tests/integration/curationWorkflow.test.ts` | Import → move → reverse → split → undo/redo → save AGP/history → reopen → undo/redo again |
| Numerical workflow | `crates/cstudio-core/tests/curation_workflow.rs` | Read a synthetic `.cool`; compare original/edited layouts and two output resolutions to manually calculated cells, with and without caching |
| Contact processing | `crates/cstudio-core/src/{cool,contact_map,contact_normalization}.rs` | Cooler reading, projection, aggregation, normalization and cancellation |
| Desktop file operations and requests | `src-tauri/src/commands.rs` and cache modules | File bundles, layout registration, request generations and cache behavior |
| Remote service | `crates/cstudio-server/src/` | Request handling, layout registration, raster equivalence and cache behavior |
| Conversion utility | `tools/cool2mcool/src/` | Resolution aggregation, normalization, file generation and CLI arguments |
| Viewport and rendering logic | `src/components/*.test.*`, `src/state/contact*.test.ts` | Rectangular viewports, coordinate mapping, tile state and rendering calculations |

The small regression fixture and its calculations are documented in
[`tests/fixtures/curation/README.md`](tests/fixtures/curation/README.md). Golden
AGP and contact-cell files are literal reviewed expectations, never updated
automatically during tests. Other existing Rust tests also use the committed
`examples/` files; keep those files when making a source checkout.

The curation integration test uses production reducers and persistence
serializers, with real temporary-file I/O. The numerical test exercises the
Rust file reader and processing APIs. They do not launch a desktop window or
exercise the actual frontend-to-Tauri IPC connection. Component markup/style
checks do not replace browser or desktop visual testing. CI currently runs on
Linux; successful Linux tests alone do not establish cross-platform GUI or
installer correctness.

Test totals can differ by platform. For example,
`sampling_webcontent_processes_is_safe` is compiled only on macOS, so it does
not appear in Linux test totals.

Two existing desktop performance diagnostics are ignored by default:
`contact_tile_backend_release_benchmark` requires a release build, and
`poj_whole_genome_lod_vs_tiles_release_benchmark` additionally requires the local
POJ benchmark dataset. They are not counted as passing correctness tests and
are not required for the self-contained curation regression.

## CI results and reproducibility

### Run the Ubuntu workflow locally

On macOS, install `act` with `brew install act` and start Docker Desktop. Then
run the same workflow against the current working tree:

```bash
npm run test:local-ci
```

The helper runs `.github/workflows/tests.yml` with `act` in an Ubuntu 22.04
`linux/amd64` container, including on Apple Silicon. The initial run downloads
the runner image, Actions and locked build dependencies. Jobs run one at a time,
with four container CPUs, 6 GB memory and two Cargo build workers. Source files
are copied into containers; host `node_modules` and Cargo build outputs are not
bind-mounted. The helper uses Docker's selected context and does not load local
`.env`, `.secrets`, `.vars` or `.input` files.

The workflow also sets `strategy.max-parallel: 1`: `act`'s top-level job limit
alone does not serialize matrix entries. Rust matrix jobs run sequentially in
both local and hosted CI.

To rerun only one job after a failure:

```bash
npm run test:local-ci -- --job frontend
npm run test:local-ci -- --job rust --matrix name:core
```

Local logs are under `test-results/act-logs/`, uploaded reports under
`test-results/act-artifacts/`, and reusable caches under `.cache/act/`. These
paths are ignored by Git. The helper exits nonzero if `act` fails.
Only one helper invocation can run per checkout, including dry runs, because
`act` reuses container names. If a forced termination leaves `.cache/act/run.lock`,
check the recorded PID and remove that lock directory only after the run stops.

`act` validates execution in a Linux container, but it does not fully reproduce
GitHub permissions, concurrency, event delivery or hosted-runner infrastructure.
See the [act compatibility notes](https://nektosact.com/not_supported.html).
Keep a real GitHub Actions run for release and manuscript validation.

### Hosted reports

The workflow has a frontend job and four independent Rust jobs. Failed tests
fail the corresponding job; there is no `continue-on-error` or automatic
snapshot update. Frontend JUnit reports and Rust logs are uploaded even after
test failures and retained for 30 days. Rust logs record the commit and toolchain.

Repository maintainers can require these five checks in the branch rules:

- `Frontend and curation workflow`
- `Rust (core)`
- `Rust (desktop)`
- `Rust (server)`
- `Rust (cool2mcool)`

Adding the workflow does not itself change GitHub branch-protection settings.
For a manuscript or release, report the actual tag/commit, OS and toolchain,
test totals (including failures or ignored tests) and the matching CI run URL.
Archive the report with the release before artifact retention expires. A local
passing run is evidence for that checkout, not evidence that hosted CI has run.

## Adding a regression test

1. Reduce the bug to a small fixed input and define its correct output from the
   file-format rules or an independently checked calculation.
2. Assert user-visible data or behavior. For coordinates and AGP text, use exact
   checks; for numerical methods, choose and explain the error tolerance.
3. Include the relevant boundary case, such as a reversed split, a gap, a stale
   history sidecar or an empty input. Use temporary directories for output.
4. Verify the test detects the bug before fixing it, then run the affected suite.
5. Run the full frontend and affected Rust tests before publishing the change.

Expected-output changes require review with the associated algorithm or format
change. Do not remove assertions or increase tolerances merely to obtain a
passing result. Test counts are reported by the runners rather than maintained
as a fixed number in this document.
