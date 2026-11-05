# Small curation regression dataset

These synthetic fixtures contain no biological or personal data. Their expected
values are calculated below and checked into version control; tests never
regenerate the expected files from the implementation under test.

## Assembly and operation sequence

`input.agp` contains four 4,000 bp contigs on two chromosomes:

- Chr01: ctgA (+), a 100 bp U gap, ctgB (+); span 8,100 bp.
- Chr02: ctgC (+), a 200 bp N gap, ctgD (+); span 8,200 bp.

The frontend regression applies these production reducer actions:

1. Move Chr02 before Chr01, retaining the chromosome identities and gap metadata.
2. Reverse ctgB. The result is `before-split.agp`.
3. Split ctgB at visual coordinate 14,300 (0-based) and insert the standard
   100 bp gap. Since ctgB is reversed, its first displayed half uses source
   coordinates 2,001–4,000 and its second half uses 1–2,000 in AGP notation.

`edited.agp` is the literal expected output. Component sequence still totals
16,000 bp; gaps now total 400 bp, so the total visual span is 16,400 bp.
The test also exercises undo/redo, disk persistence of the AGP and history
sidecar, reopening with an undone branch, and rejection of mismatched history.

## Contact matrix oracle

`contacts.tsv` contains five upper-triangle raw observations at 1,000 bp source
bins. Source starts are 0-based. Counts sum to 28. The Rust integration test
materializes these observations as a small HDF5 `.cool` file with four sources
and 16 bins, then uses the production reader, projector and contact cache. The
file includes the required fixed-bin, symmetric-upper metadata from
[Cooler schema v3](https://cooler.readthedocs.io/en/latest/schema.html).

After curation, the relevant source starts have these visual coordinates:

| Source position | Visual position | 1,000 bp output bin |
|---|---:|---:|
| ctgA:0 | 8,200 | 8 |
| ctgA:1,000 | 9,200 | 9 |
| ctgB:0 | 16,399 | 16 |
| ctgB:2,000 | 14,299 | 14 |
| ctgB:3,000 | 13,299 | 13 |
| ctgC:0 | 0 | 0 |
| ctgD:0 | 4,200 | 4 |
| ctgD:3,000 | 7,200 | 7 |

For a reversed half-open source interval `[s, e)`, source position `p` maps to
`visual_start + e - p - 1`. Output bin IDs are `floor(position / resolution)`.
Pairs are stored in upper-triangle order. For example, the ctgB:2,000–ctgD:0
observation with count 11 moves to `(4, 14)` at 1 kb and `(2, 7)` at 2 kb.

`expected-contact-cells.tsv` records the independently calculated cells for the
original 1 kb layout and the edited layout at 1 kb and 2 kb. Both cached and
uncached projection must match these cells exactly and retain the raw count
sum of 28. The fixture uses exactly representable integer counts; tests of
floating-point normalization elsewhere use tolerances.

## Scope and maintenance

The frontend test runs real application state and serialization code and reads
and writes temporary files through Node. The Rust test checks Cooler file I/O
and numerical projection against the same AGP fixtures. Its small AGP-to-query
adapter is test code; production AGP import/export is checked by the frontend
test. These are headless integration tests, not a live GUI or Tauri IPC test.

When an intentional behavior change requires an oracle update, document the
new coordinate/count calculation and review the fixture diff with the code
change. Do not replace the oracle automatically with current program output.
