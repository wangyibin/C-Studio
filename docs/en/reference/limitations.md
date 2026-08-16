# Current limitations

This page records boundaries of the current `0.1.0` checkout. It should be
updated whenever the corresponding implementation or validation changes.

## Distribution and platforms

- macOS packages use ad-hoc signing and are not notarized with an Apple
  Developer ID.
- Windows installers are unsigned and may trigger SmartScreen.
- Project-directory, contact-map, PAF, and coverage selection now use Tauri's
  cross-platform dialog plugin. A real Windows desktop click-through remains a
  separate release QA requirement.
- No Linux packaging workflow is defined.
- Stable public releases, archival source/test-data URLs, and a citation record
  are not established by this checkout alone.

## Example data

**Load example project** resolves paths from the source checkout at build time.
The example files are not declared as Tauri bundle resources, so successful use
from a packaged app has not been established.

## Export

Edited AGP saving is implemented. The inspector can display FASTA as “Ready”
when a dataset is loaded, but the current user interface does not expose a
FASTA export action. Do not treat that readiness label as a completed FASTA
export workflow.

## Scientific interpretation

- C-Studio does not automatically decide breakpoints, orientation, grouping,
  chromosome naming, or copy number.
- GFA and contact review candidates are evidence prompts, not biological calls.
- Passing unit tests does not validate an edited assembly on real biological
  data.
- A complete curation should still be checked with independent continuity,
  copy-number, synteny, contact-map, and sequence-level validation.

## Performance evidence

Large plain `.cool` matrices can be substantially slower than `.mcool` with
stored resolutions. Backend benchmarks do not by themselves establish desktop
interaction latency: IPC, frontend merge, and GPU paint remain separate stages.
Use `.mcool` for routine multi-scale work where possible, and measure the real
desktop workflow before making performance claims.

## GFA parser scope

The current evidence parser recognizes `S`, `L`, and `A` records. Only explicit
valid `L` records create graph edges. `A` record counts and `rd` tags remain
segment metadata and are not treated as edge support.
