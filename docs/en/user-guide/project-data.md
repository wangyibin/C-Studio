# Project data

## Supported inputs

| Evidence | Extensions | Role | Required for editing? |
| --- | --- | --- | --- |
| Assembly | `.agp`, `.agp.gz` | Authoritative editable layout | Yes |
| Contact map | `.cool`, `.mcool` | Heatmap and 3D-contact evidence | No |
| Assembly graph | `.gfa`, `.gfa1`, optional `.gz` | Topology and overlap evidence | No |
| Synteny | `.paf`, optional `.gz` | Reference/query alignment view | No |
| Coverage | `.depth`, `.bedgraph`, `.bg`, optional `.gz` | Coverage track | No |

Individual file inputs also accept selected `.txt` and `.txt.gz` forms for AGP,
GFA, PAF, and coverage. Project-folder discovery uses the specific extensions in
the table.

## Project-folder discovery

**Load project folder…** scans regular files in the selected directory's top
level. It does not recurse into subdirectories.

For each evidence type:

1. filenames are ordered deterministically;
2. one file is selected;
3. other files of the same type are reported as ignored candidates.

For contact maps, an `.mcool` candidate is preferred over `.cool`; ties are
resolved by the deterministic filename ordering. Text inputs can be gzip
compressed. `.cool` and `.mcool` are HDF5 containers and must not be gzip
wrapped.

## Identifier compatibility

AGP component IDs provide the immutable lookup keys used to project evidence
into the edited visual layout. The following identifiers should agree:

- AGP component column 6;
- contact-map chromosome/bin names;
- PAF query names;
- coverage chromosome names;
- GFA segment names.

Renaming a contig in C-Studio changes its exported display name while retaining
the immutable source lookup key during the session.

## Partial projects

C-Studio can load a folder containing only a subset of the supported types. An
AGP-only project supports layout editing and AGP export. Evidence panes remain
empty or disabled until their corresponding files are loaded.

Loading a new project folder replaces the current workspace. Use **Clear all
loaded data…** to explicitly remove every source; use **Reload assembly…** to
restore the initially loaded AGP while retaining other evidence sources.

## Platform note

The native folder picker and native `.cool/.mcool`, PAF, and coverage pickers
are implemented only on macOS in the current backend. AGP and GFA use web file
inputs, but that does not make the complete Windows project-loading workflow
equivalent yet.

