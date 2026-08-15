# Evidence views

## Contact map

The contact map is read from `.cool` or `.mcool` and reprojected through the
current AGP order, orientation, splits, moves, and copies. Available
normalizations are:

- **None (Raw)**
- **ICE (Balanced)**
- **KR (Balanced)**
- **VC (Coverage)**
- **VC_SQRT**

Normalization availability and cost depend on what is stored in the input and
what must be computed. `.mcool` is preferred for large, multi-scale browsing
because stored pyramid levels avoid repeatedly aggregating a single fine
`.cool` level.

Color range can be entered manually or estimated with **Auto**. Changing color
range affects rendering, not the underlying counts or AGP.

## Coverage track

Coverage accepts four-column bedGraph-like records:

```text
chrom  start  end  value
```

Blank lines, comments, and `track`/`browser` directives are ignored. Intervals
must be valid 0-based half-open intervals. Values are length-weighted while
records are projected through every matching AGP placement.

The track supports visibility, manual/automatic range controls, synchronized
selection, pan, and zoom.

## PAF synteny

PAF query names are matched to AGP source component IDs. The compact inspector
preview can be expanded into an interactive split pane. The query axis follows
the edited assembly and shared heatmap X viewport; the target axis remains the
PAF reference coordinate system.

PAF is evidence only. Selecting a dotplot block selects the corresponding AGP
unit, but the alignment does not automatically rename, orient, or move it.

## GFA assembly graph

GFA segment names are matched to AGP component IDs. The graph panel provides
three layouts:

- **Curation**: chromosomes in AGP order, with unitigs kept in their assembly
  blocks;
- **Guided**: the AGP backbone plus a local layer of GFA neighbors around the
  selection or heatmap focus;
- **Whole**: topology-first graph layout, with AGP links as an optional layer.

Independent layers and filters include GFA links, endpoint **3D Contacts**, AGP
adjacency/gaps, homolog, non-homolog, anchor–unanchor, unplaced unitigs, and
disconnected islands. Evidence layers start as display controls and do not
rewrite AGP.

The **Review** queue is explicitly read-only. It can report endpoint conflicts,
gap bridges, strong non-adjacent 3D-contact pairs, and copy ambiguities, together
with what the evidence supports and its limits. Users may focus a candidate and
then choose a separate assembly operation.

Unplaced GFA segments have an explicit placement dialog. Confirming placement
is an AGP edit and is recorded in history; merely dragging graph nodes changes
the graph layout, not the assembly.

## Homolog regular expression

The global regular expression classifies scaffold names for GFA layouts. Capture
group 1 defines a homolog column; capture group 2 orders chromosomes within the
column. The default is:

```regex
(Chr\d+)g(\d+)
```

Use a pattern that matches the project's actual scaffold naming scheme. An
invalid or non-matching pattern limits homolog-aware layout and filters; it does
not change AGP identities.

