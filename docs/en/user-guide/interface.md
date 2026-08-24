# Interface

## Global toolbar

The top row contains project-wide actions:

- the current AGP name and **Auto-save** setting;
- **Add Data** for project folders and individual evidence files;
- the global **Homolog regex** used to arrange GFA homolog groups;
- the **Chromosomes** display filter shared by the heatmap, synteny, coverage,
  and GFA views without modifying the AGP;
- undo, redo, AGP save/Save As, inspector visibility, and application
  information.

Saving writes both the edited AGP and its same-prefix operation-history
sidecar.

The information menu also lists the active keyboard shortcuts and the core's
coordinate convention.

## Heatmap toolbar

The second row controls the contact-map view:

- resolution slider and resolution lock;
- color minimum, maximum, and **Auto** range;
- contact-map normalization;
- chromosome, block, and contig annotation visibility;
- whole-genome **Fit** and X/Y region **Jump**.

For `.mcool`, the resolution slider uses the pyramid levels physically present
in the file. Other views are constrained by the current viewport and supported
display levels.

## Central workspace

The heatmap is the primary workspace. It can show:

- contact tiles projected through the current AGP layout;
- chromosome, composite-block, and contig overlays;
- synchronized selection bands on both matrix axes;
- the coverage track below the matrix;
- an optional side-by-side synteny pane;
- an optional resizable GFA graph panel.

The heatmap and evidence windows can be closed or expanded. Closing one does
not unload its source data.

## Inspector

The right inspector is resizable and can be hidden with ++f9++. It contains:

- **Overview**: whole-assembly contact overview;
- **Synteny**: compact PAF view; double-click opens the interactive split pane;
- **GFA**: compact assembly-graph preview; double-click opens the graph panel;
- **Selection**: selected chromosome, block, contig, and copy information;
- **History**: applied and undone operations;
- **Project Info** and export readiness.

Hovering or focusing a history entry previews the affected area. Clicking it
focuses the view. Right-clicking an applied history entry offers **Undo to
here**.

## Status bar

The bottom status bar reports resolution, normalization, matrix, assembly,
selected tool, X/Y centers, and the latest status message. Diagnostic timing
text appears only when performance logging is explicitly enabled.
