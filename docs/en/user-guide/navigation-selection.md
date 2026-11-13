# Navigation and selection

## Heatmap navigation

| Action | Result |
| --- | --- |
| Drag | Pan X and Y together using the pointer trajectory |
| Scroll | Pan both axes diagonally using the dominant signed wheel delta |
| Shift + scroll | Pan horizontally |
| Command/Control + Shift + scroll | Pan vertically |
| Command/Control + scroll | Switch resolution |
| Double-click | Zoom in around the pointer and snap to an appropriate resolution |
| **Fit** | Restore the whole-assembly viewport |

When resolution is locked with **L**, Command/Control + scroll zooms the
viewport around the pointer without switching the selected matrix level.

The heatmap fills the available plotting area with the same genomic length per
pixel on both axes. Wider windows show more sequence horizontally; taller
windows show more sequence vertically. Resizing preserves square matrix bins.
Areas beyond the assembly end remain empty; zoom in to view a smaller interval.

The whole-genome navigators along the axes can also move one axis independently.
While dragging the X or Y chromosome bar, the heatmap follows the pointer and
each arriving tile appears immediately, without waiting for pointer release or
the rest of the viewport to load. Releasing confirms the position.
Pan positions are constrained by the assembly extent.

While new contact-map tiles load, the existing heatmap continues to follow the
pointer. Newly exposed areas may briefly remain white, then fill when their
tiles arrive. This temporary blank area does not indicate missing contacts.

The coverage track follows the X viewport during heatmap dragging, X chromosome
bar dragging, and wheel panning, including its bars, chromosome boundaries, and
selection. Newly loaded coverage appears without waiting for release. The depth
scale stays stable during panning; moving only Y leaves coverage in place.

The Overview viewport window also follows heatmap dragging, X/Y chromosome bar
dragging, and wheel panning before release. Cancelling a drag restores both the
window and the main heatmap to their previous position.

When switching resolution or normalization, the current frame remains visible
until the new frame is ready, then the heatmap switches to the new viewport.

## Jump to a region

The X and Y **Jump** fields accept either:

```text
contig_name
contig_name:start-end
```

Coordinates in the typed interval are interpreted on the source contig. If one
axis is blank, the other input is used for both axes. C-Studio centers the
viewport and selects the matching placed block. Ambiguous or missing contig
names produce an error rather than silently selecting one.

## Select from the heatmap

Ordinary dragging is reserved for panning. Hold Shift to work with assembly
overlays:

- Shift-click a contig to replace the current selection.
- Shift-click a chromosome boundary to select the chromosome.
- Shift-click empty space to clear the selection.
- Shift-drag a box to select every intersecting contig.

The selected interval is projected as horizontal and vertical bands. Drag the
selection handles to expand or contract the selected set at contig boundaries.

## Select from synchronized evidence

Coverage and the interactive synteny view share the heatmap X viewport:

- click replaces the current contig selection;
- Command/Control-click toggles one contig;
- Shift-drag selects multiple contigs;
- double-click zooms at the pointer;
- drag empty plot space pans the shared X region.

In the GFA panel, Shift-drag selects multiple AGP blocks, right-click opens the
same assembly-operation menu, and scrolling zooms the graph canvas. Graph
layout movement changes only the graph drawing unless an explicit assembly
operation is confirmed.

## Clear or cancel

Press ++esc++ to clear the current assembly selection or cancel an active
context interaction. Application shortcuts are ignored while typing in an
input, text area, select box, or editable control.

