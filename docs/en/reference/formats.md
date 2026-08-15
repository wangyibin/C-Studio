# Data formats

## AGP

C-Studio expects tab-delimited AGP with nine columns. Component rows provide
object coordinates, component type, component ID, source coordinates, and
orientation. `N` and `U` rows provide gap length, type, linkage, and evidence.

- AGP coordinates are 1-based closed.
- Internal C-Studio intervals are 0-based half-open.
- Component IDs are the source lookup keys for other evidence.
- `+`, `-`, `?`, `0`, and `na` orientations are retained as legal input/export
  values.
- Gap metadata is retained while the gap exists. **Delete gap / join blocks**
  explicitly removes it.

On export, object coordinates and part numbers are regenerated from the current
placement order. Source component coordinates remain tied to the edited source
intervals.

## COOL and MCOOL

`.cool` and `.mcool` are Cooler-compatible HDF5 contact containers. C-Studio
reads chromosome/bin identifiers, sparse pixels, stored resolutions, and
available weights needed by the selected normalization.

- `.cool` contains one matrix resolution.
- `.mcool` can contain a resolution pyramid and is preferred for large data.
- These files must not be gzip wrapped.
- Matrix identifiers must match AGP component IDs.

## PAF

C-Studio reads standard PAF's first 12 fields. Query name, query length and
interval, strand, target name and interval, residue matches, alignment block
length, and mapping quality are used to construct the synteny view. Query names
must match AGP component IDs.

## Coverage

Coverage input is whitespace-delimited and bedGraph-like:

```text
chrom  start  end  value
```

Intervals are 0-based half-open. `start` must be non-negative, `end` must be
greater than `start`, and `value` must be numeric. Lines beginning with `#`,
`track`, or `browser` are ignored.

## GFA

The current parser uses these GFA records:

- `S`: segment name, sequence or `LN` length, and optional `rd` depth tag;
- `L`: oriented segment link and overlap CIGAR/string;
- `A`: per-segment count and optional `HG` haplotype tag.

`A` records and an `rd` tag are segment metadata; they are not promoted to GFA
edge support. Only explicit valid `L` records create topology links. Links to
missing `S` segments, invalid rows, and duplicate links are warned about or
filtered.

## Gzip text input

AGP, GFA, PAF, depth, and bedGraph text may use a final `.gz` suffix. C-Studio
uses multi-member gzip decoding. Auto-save never overwrites compressed AGP;
save to a plain `.agp` target instead.

