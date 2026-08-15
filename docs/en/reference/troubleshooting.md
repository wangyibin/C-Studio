# Troubleshooting

## A picker reports “only implemented for macOS”

The native project-directory, `.cool/.mcool`, PAF, and coverage pickers have no
non-macOS backend yet. This is a current implementation limit, not a malformed
file. AGP and GFA have web file inputs, but a complete Windows workflow still
requires backend work.

## “No supported project files found”

Check that supported files are regular files in the selected directory's top
level and use specific extensions: `.agp`, `.gfa`/`.gfa1`, `.paf`,
`.depth`/`.bedgraph`/`.bg`, `.cool`, or `.mcool`. Text formats may add `.gz`.
Subdirectories and generic `.txt` files are not discovered by the folder scan.

## The heatmap or a track is empty

Compare AGP component IDs with contact-map chromosome names, PAF query names,
coverage chromosome names, and GFA segment names. Evidence is projected only
for matching source IDs and overlapping intervals.

Also confirm the viewport, selected resolution, color maximum, track visibility,
and normalization. Use **Fit** and **Auto** color range as a safe reset.

## A plain COOL file is slow

A single-resolution `.cool` may require expensive projection and aggregation
for every new scale. Convert or prepare an `.mcool` pyramid for routine browsing.
Do not compare debug-build timings with release timings.

For development diagnostics only:

```bash
CSTUDIO_PERF_LOG=1 npm run tauri dev
```

The emitted timing fields are diagnostics, not a stable public API.

## GFA imports but has no graph

C-Studio requires valid `S` records. An import containing only other record
types reports that no GFA `S` records were found. Verify tab separation,
segment names, `LN` tags when sequence is `*`, and any parser warnings.

## Homolog layout is missing or invalid

Update **Homolog regex** so capture group 1 identifies a homolog group and
capture group 2 provides member order. For names such as `Chr01g1`, the default
`(Chr\d+)g(\d+)` is appropriate. The pattern must be a valid JavaScript regular
expression.

## Auto-save is unavailable

Auto-save requires a writable plain AGP target. Use manual save once to choose
a path. A `.agp.gz` source cannot be overwritten. If a source path disappears
or becomes unwritable, C-Studio falls back to Save As or reports the error.

## I cannot open a packaged app

Current macOS packages are not notarized; right-click and choose **Open** after
verifying the package source. Windows packages are unsigned and can trigger
SmartScreen. These warnings cannot be removed by changing a C-Studio setting.

## “Load example project” fails in a package

The current helper expects the source checkout's `examples/` directory and is
not verified as a packaged resource. Run from a source checkout or load the
example files individually until bundling is implemented.

