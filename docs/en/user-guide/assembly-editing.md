# Assembly editing

## Editing model

C-Studio edits the current AGP placement list. Internal intervals are 0-based
half-open; imported and exported AGP coordinates are 1-based closed. Contact,
coverage, PAF, and GFA sources retain their original coordinate systems and are
reprojected through the edited placements.

!!! important

    Every edit is user-directed. Evidence views can focus or preview a
    candidate, but they do not choose the biological action.

## Select before editing

Use Shift-click or Shift-drag in the heatmap, or select from coverage, synteny,
or GFA. Right-click the selection to open the shared operation menu.

## Available operations

| Operation | Effect |
| --- | --- |
| **Rename…** | Change a chromosome, block, or contig display/export name after validation |
| **Reverse / rotate selection** | Reverse selected order and flip orientations |
| **Copy** | Create another placement of the selected source interval(s) |
| **Dissolve block** | Split a selected composite block into singleton contigs |
| **Add chr boundaries** | Create chromosome boundaries around selected contigs |
| **Remove chr boundaries** | Remove eligible selected chromosome boundaries |
| **Delete gap / join blocks** | Remove eligible AGP gap rows and join the neighboring blocks |
| **Move to debris** | Retain the selected sequence in a debris object |
| **Delete contig…** | Remove selected placements after a copy-aware confirmation |

To split a contig, first select it, then hover an internal point of its diagonal
box. When the cut cursor appears, click to split. End regions are guarded so an
unsafe near-end click is not treated as a cut.

To move a selection, hover a valid insertion boundary until the insertion
cursor appears, then click to confirm that target. Movement and copying operate
on placements; neither claims a biological grouping or copy-number decision.

## Copy-aware deletion

**Delete contig…** opens a confirmation dialog. It distinguishes split and
unsplit copies and reports how many copies remain for each selected source
interval. If no copies will remain, the dialog highlights that loss.

Deletion removes the placement from the assembly rather than moving it to
debris. It can be recovered with Undo and remains recoverable after reopening
when a compatible saved history sidecar is present.

## History, undo, and redo

Every reducer edit records before/after assembly state and an impact summary.

- ++cmd+z++ / ++ctrl+z++ undoes one operation.
- ++shift+cmd+z++ / ++ctrl+y++ redoes one operation.
- Hover a History item to preview before/after state.
- Click a History item to focus its affected region.
- Right-click an applied item and choose **Undo to here** to roll back later
  operations in one step.

Loading a new project replaces the current timeline and restores the selected
AGP's compatible history sidecar when one is present. Clearing all data or
reloading the source assembly clears the edit history.

## Saving and auto-save

Manual save writes the canonical current layout as AGP, including retained
`N`/`U` gap metadata and legal unknown orientations such as `0` or `na`. It
also writes a same-prefix `.history.json` sidecar containing applied and undone
operations. The sidecar is restored only when it matches the saved AGP.

Loading a source AGP does not authorize overwriting it. The first manual save
always chooses a destination. Once a writable plain AGP save path is known,
auto-save writes both files roughly five seconds after a change. Gzip AGP is
read-only as an input target; save to a new plain `.agp` first.

Use **Reload assembly…** only when you intend to discard every edit and restore
the initially loaded source AGP. Other loaded evidence remains in the
workspace.
