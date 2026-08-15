# Get started

This walkthrough keeps the source AGP recoverable and makes the boundary
between evidence and edits explicit.

## 1. Prepare a project directory

For a real project, place copies of the inputs in one dedicated directory. An
AGP is required for assembly editing. Other evidence is optional.

```text
my-project/
├── assembly.agp
├── contacts.mcool
├── alignments.paf
├── coverage.depth
└── assembly.gfa
```

Only the top level is scanned. If a type has several candidates, C-Studio loads
one deterministic candidate and reports the others as skipped. See
[project data](user-guide/project-data.md) for the exact rules.

## 2. Load data

On macOS, choose **Add Data → Load project folder…**. Alternatively, use the
individual entries below **Add Data**.

To inspect the bundled development example, choose **Load example project**.
That helper currently resolves files from the source checkout and should not be
treated as verified packaged-app data.

## 3. Check the workspace

Confirm the status bar and **Project Info** show the expected assembly and
matrix. Then inspect:

- the main heatmap and coverage track;
- the **Overview**, **Synteny**, and **GFA** inspector tabs;
- the chromosome, block, and contig annotation boxes;
- the homolog regular expression when a GFA is present.

If contig identifiers do not match across AGP, contact-map bins, PAF, coverage,
and GFA, the corresponding evidence cannot be projected reliably.

## 4. Navigate and select

- Drag the heatmap to pan.
- Scroll to pan diagonally; use the platform-specific modified scroll gestures
  for resolution switching or vertical movement.
- Use **Fit** to return to the whole assembly.
- Enter `contig` or `contig:start-end` in the X/Y **Jump** fields.
- Shift-click an assembly overlay to select a contig or chromosome. Shift-drag
  selects several contigs; Command/Control-click in synchronized tracks toggles
  individual contigs.

See [navigation and selection](user-guide/navigation-selection.md) for the full
interaction model.

## 5. Make one reversible edit

Right-click the selected assembly item and choose an operation such as
**Reverse / rotate selection**, **Copy**, or **Move to debris**. Watch the
contact map, tracks, and evidence views reproject to the edited AGP layout.

Use **Undo** or the **History** list to verify reversibility before continuing.
Deletion requires confirmation and reports whether any source interval will
have no copies left.

## 6. Save an edited AGP

Press ++cmd+s++ on macOS or ++ctrl+s++ on Windows, or click the save icon.

!!! warning "Auto-save may overwrite a project AGP"

    A plain `.agp` loaded through **Load project folder…** is treated as a
    writable save target. If auto-save is enabled, edits are written about five
    seconds after a change. Work on a copy if the input must remain immutable.

Compressed `.agp.gz` input is never overwritten directly. A first **Save As**
creates a plain AGP target and enables auto-save for that target.

