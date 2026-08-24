# Prepare input files

C-Studio does not align reads or build contact matrices itself. Prepare the
evidence files before loading a project.

!!! important "Use one source-contig coordinate system"

    AGP column 6, COOL/MCOOL chromosome names, PAF query names, coverage
    chromosome names, and GFA segment names must identify the same source
    contigs. If the AGP places unitigs, build the other evidence against those
    unitigs rather than against the final chromosome-scale FASTA. C-Studio uses
    the AGP to project source evidence into the edited layout.

## Prepare the AGP

Prefer the AGP produced by the scaffolder or assembly-curation pipeline. It
preserves component order, orientation, coordinates, and gaps.

If the starting point is a component FASTA with no scaffold relationships, a
minimal identity AGP can be created with one component per object:

```bash
samtools faidx source-contigs.fa
awk 'BEGIN { OFS="\t" } { print $1, 1, $2, 1, "W", $1, 1, $2, "+" }' \
  source-contigs.fa.fai > assembly.agp
```

This is only an initial contig-level layout. It does not reconstruct scaffold
order, gaps, phasing, or chromosome assignments.

## Prepare a COOL contact map

Start with mapped, filtered, and deduplicated contacts in 4DN `.pairs` format.
If starting from FASTQ or BAM, use an assay-appropriate Hi-C/Pore-C pipeline to
produce the pairs first. [pairtools](https://pairtools.readthedocs.io/en/latest/)
provides parse, sort, select, and dedup stages, but mapping and filtering
parameters must match the library and the intended MAPQ policy.

Create chromosome sizes from the same source-contig FASTA used by the AGP:

```bash
samtools faidx source-contigs.fa
cut -f1,2 source-contigs.fa.fai > source-contigs.chrom.sizes
```

For standard 4DN pairs, columns 2/3 and 4/5 are `chrom1/pos1` and
`chrom2/pos2`. Create a fixed 1 kb symmetric-upper COOL with
[`cooler cload pairs`](https://cooler.readthedocs.io/en/latest/cli.html#cooler-cload-pairs):

```bash
cooler cload pairs \
  -c1 2 -p1 3 -c2 4 -p2 5 \
  source-contigs.chrom.sizes:1000 \
  contacts.pairs.gz \
  contacts.1k.cool
```

The standard pairs positions are 1-based. Add `--zero-based` only when the
actual input positions are 0-based. Decide MAPQ filtering before creating the
COOL: aggregated counts cannot recover contacts that were discarded earlier.

## Convert COOL to MCOOL with cool2mcool

Download the `linux-x86_64`, `linux-aarch64`, or `macos-arm64` package from the
[C-Studio releases](https://github.com/wangyibin/C-Studio/releases). The
standalone Rust command requires a fixed-bin, symmetric-upper 1 kb COOL. It
writes a multi-resolution MCOOL and stores ICE, KR, VC, and VC_SQRT vectors at
every output resolution.

For example, after downloading the Linux package:

```bash
tar -xzf cool2mcool-*-linux-x86_64.tar.gz
./cool2mcool-*-linux-x86_64/cool2mcool \
  /absolute/path/contacts.1k.cool \
  /absolute/path/contacts.mcool
```

On Linux ARM64 use the `linux-aarch64` package; on Apple Silicon macOS use the
`macos-arm64` package.

To build from source instead, run from the repository root:

```bash
cd tools/cool2mcool
pixi install
pixi run run /absolute/path/contacts.1k.cool /absolute/path/contacts.mcool
```

The default output ladder is 1 kb, 5 kb, 10 kb, 25 kb, 50 kb, 100 kb, 250 kb,
500 kb, 1 Mb, and 2.5 Mb. Use `--threads`, `--level-parallelism`, or
`--resolutions` when needed; use `--force` only to replace an existing output
after successful generation:

```bash
pixi run run \
  --threads 8 \
  --level-parallelism 2 \
  --resolutions 2500000,1000000,500000,250000,100000,50000,25000,10000,5000,1000 \
  /absolute/path/contacts.1k.cool \
  /absolute/path/contacts.mcool
```

As a standard Cooler alternative, use
[`cooler zoomify`](https://cooler.readthedocs.io/en/latest/cli.html#cooler-zoomify):

```bash
cooler zoomify \
  --resolutions 1000,5000,10000,25000,50000,100000,250000,500000,1000000,2500000 \
  --balance \
  --out contacts.mcool \
  contacts.1k.cool
```

The normalization columns produced by standard Cooler are not identical to the
four columns written by `cool2mcool`; inspect the file before selecting a
normalization in C-Studio.

## Generate PAF synteny alignments

C-Studio treats the PAF query as the editable source-contig axis and the PAF
target as the reference axis. Therefore, the second FASTA passed to minimap2
must contain record names matching AGP column 6:

```bash
minimap2 -cx asm5 -t 16 \
  reference.fa \
  source-contigs.fa \
  > alignments.paf
```

Use the `asm5`, `asm10`, or `asm20` preset appropriate for the expected
assembly divergence. C-Studio reads the first 12 PAF columns; optional `cg` or
`cs` tags are allowed but not required. See the
[minimap2 assembly-alignment documentation](https://github.com/lh3/minimap2#full-genomeassembly-alignment).

## Generate a coverage track

Align the reads used for coverage against `source-contigs.fa`, then provide a
four-column, 0-based half-open bedGraph. For a coordinate-sorted BAM:

```bash
samtools sort -@ 16 -o reads.sorted.bam reads.bam
samtools index reads.sorted.bam
bedtools genomecov -ibam reads.sorted.bam -bga > coverage.bedgraph
```

`-bga` includes zero-coverage intervals; use `-bg` for a smaller nonzero-only
track. See the
[`bedtools genomecov` documentation](https://bedtools.readthedocs.io/en/latest/content/tools/genomecov.html).

Raw `samtools depth` output has three columns and is not directly accepted as a
C-Studio coverage track. Convert it to bedGraph coordinates if needed:

```bash
samtools depth -aa reads.sorted.bam \
  | awk 'BEGIN { OFS="\t" } { print $1, $2 - 1, $2, $3 }' \
  > coverage.bedgraph
```

## Prepare GFA evidence

Use the GFA emitted by the assembler, such as a primary-unitig GFA. Do not
invent graph links from AGP adjacency. Each required segment must have an `S`
record whose name matches the AGP component ID; its length must be available
from the segment sequence or an `LN` tag. Explicit `L` records provide graph
topology.

## Validate identifiers before loading

Compare the AGP component IDs with the COOL chromosome names:

```bash
awk '$5 != "N" && $5 != "U" { print $6 }' assembly.agp \
  | sort -u > agp.components.txt
cooler dump -t chroms contacts.1k.cool \
  | cut -f1 | sort -u > cool.chroms.txt
comm -3 agp.components.txt cool.chroms.txt
```

No output means the two identifier sets match. Also inspect the matrix and
MCOOL levels before opening C-Studio:

```bash
cooler info contacts.1k.cool
cooler ls contacts.mcool
cooler info contacts.mcool::/resolutions/1000
```

Finally, place the prepared files together and follow the
[project-folder discovery rules](project-data.md).
