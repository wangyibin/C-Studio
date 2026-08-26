# Current limitations

This page records boundaries that matter when interpreting, distributing, or
validating the current implementation. C-Studio is under active development,
so these boundaries will change as the implementation and platform validation
evolve.

## Distribution and platforms

- The desktop packaging workflow targets macOS on Apple Silicon and Windows
  x86-64. It can produce reproducible build artifacts, but does not by itself
  establish a stable, signed public distribution.
- macOS packages use ad-hoc signing and are not notarized with an Apple
  Developer ID.
- Windows NSIS and MSI installers are unsigned and may trigger SmartScreen.
- Native file and folder dialogs support macOS and Windows, but a real Windows
  desktop click-through and WebView2 interaction validation remain separate
  release-QA work.
- There is no Linux desktop packaging or release-QA workflow. Linux artifacts
  in the packaging workflow belong to the standalone `cool2mcool` converter,
  not to the C-Studio desktop application.

## Example data

**Load example project** reads files from the source checkout's `examples/`
directory. Those files are not declared as Tauri bundle resources, so this
helper is not established for packaged applications. Run from a source checkout
or load the example files individually.

## Export

- Saving writes the edited AGP and a same-prefix C-Studio `.history.json`
  sidecar. The AGP remains independently usable, but other assembly tools do
  not consume the sidecar.
- A malformed or layout-mismatched history sidecar is ignored; the AGP still
  loads without restoring its undo/redo timeline.
- Auto-save requires a writable save target selected by the user. A compressed
  `.agp.gz` source cannot be overwritten automatically.
- The inspector's FASTA **Ready** state only indicates that a dataset is
  loaded. The user interface does not currently provide FASTA export.

## Scientific interpretation

- The edited AGP layout remains the authority for ordering, orientation,
  boundaries, and export. Contact maps, PAF, coverage, and GFA are synchronized
  evidence views; they do not silently rewrite the layout.
- Evidence-guided placement recommendations are review aids. Applying a change
  remains a user-approved edit and does not establish a biological correction.
- C-Studio does not automatically decide breakpoints, orientation, grouping,
  chromosome naming, or copy number.
- Passing automated tests does not validate an edited assembly on real
  biological data.
- A complete curation should still be checked with independent continuity,
  copy-number, synteny, contact-map, and sequence-level validation.

## Performance evidence

Large single-resolution `.cool` files can require expensive projection and
aggregation at each new scale. Prefer an `.mcool` file with stored resolutions
for routine multi-scale browsing. Backend or automated timings do not establish
visible desktop interaction latency: IPC, frontend work, GPU presentation, and
the platform webview are separate stages. Measure the target desktop workflow
before making a performance claim.

## GFA parser scope

The current evidence parser recognizes `S`, `L`, and `A` records. Only explicit
valid `L` records create graph edges. `A` record counts and `rd` tags remain
segment metadata and are not treated as edge support.
