# Troubleshooting

## I cannot open C-Studio

Download the package for your platform from the official
[GitHub Releases](https://github.com/wangyibin/C-Studio/releases) page. On
macOS, verify the download source, then Control-click the app and choose
**Open**. On Windows, verify the source before continuing through a SmartScreen
warning.

## C-Studio cannot find my project files

Select a folder containing regular files at its top level. Supported files are
`.agp`, `.gfa`/`.gfa1`, `.paf`, `.depth`/`.bedgraph`/`.bg`, `.cool`, and
`.mcool`; text files may end in `.gz`. Grant C-Studio access to the selected
folder if macOS or Windows asks for permission.

## The heatmap or an evidence view is empty

AGP component IDs must match the chromosome or segment names in the contact
map, PAF, coverage, and GFA files. Then check the current view, resolution,
colour range, normalisation, and layer visibility. Returning to the full
assembly view and using **Auto** colour range is a safe reset.

## I cannot save or restore history

Use **Save As** once to choose a writable, uncompressed AGP destination.
Auto-save cannot overwrite an `.agp.gz` input. To restore history, keep
`<AGP-prefix>.history.json` next to the matching AGP; C-Studio ignores a
malformed or incompatible sidecar but still opens the AGP.

## The GFA view or homolog layout is missing

The GFA needs valid `S` records with matching segment names. For homolog
layout, set **Homolog regex** so capture group 1 is the group and capture group
2 is its member order; for example, `(Chr\d+)g(\d+)` matches `Chr01g1`.

## “Load example project” does not work

This helper requires the source checkout's `examples/` directory. In a packaged
application, load the example files individually instead.
