# 准备输入文件

C-Studio 本身不负责比对 reads 或构建接触矩阵。请先在外部准备好证据文件，
再加载项目。

!!! important "统一使用源 contig 坐标系"

    AGP 第 6 列、COOL/MCOOL chromosome 名、PAF query 名、coverage
    chromosome 名和 GFA segment 名必须指向同一批源 contig。如果 AGP
    放置的是 unitig，其他证据也应建立在这些 unitig 上，而不是最终染色体
    FASTA 上。C-Studio 再通过 AGP 把源证据投影到编辑后布局。

## 准备 AGP

优先使用 scaffolder 或组装校订流程输出的 AGP，因为它保留了 component 顺序、
方向、坐标和 gap。

如果只有 component FASTA，且没有 scaffold 关系，可生成每个 component 对应一个
object 的最小 identity AGP：

```bash
samtools faidx source-contigs.fa
awk 'BEGIN { OFS="\t" } { print $1, 1, $2, 1, "W", $1, 1, $2, "+" }' \
  source-contigs.fa.fai > assembly.agp
```

这只是 contig 级起始布局，不会恢复 scaffold 顺序、gap、分相或染色体归属。

## 准备 COOL 接触矩阵

从已比对、过滤和去重的 4DN `.pairs` 接触数据开始。如果起点是 FASTQ 或 BAM，
请先使用与实验类型匹配的 Hi-C/Pore-C 流程生成 pairs。
[pairtools](https://pairtools.readthedocs.io/en/latest/) 提供 parse、sort、select 和
dedup，但比对与过滤参数必须根据建库方式和 MAPQ 策略确定。

=== "C-Phasing"

    C-Phasing 可以直接从 `.pairs.pqs` 数据集或压缩的 `.pairs.gz` 文件生成
    相同的源 contig 级 COOL。按照官方
    [C-Phasing `pairs2cool` 流程](https://wangyibin.github.io/CPhasing/zh/latest/CLI/plot/)，
    先生成 contig size，并明确指定 `cool2mcool` 所需的 1 kb 分辨率：

    ```bash
    cphasing-rs contigsizes source-contigs.fa > source-contigs.contigsizes
    cphasing pairs2cool \
      contacts.pairs.pqs \
      source-contigs.contigsizes \
      contacts.1k.cool \
      --binsize 1k \
      --min-mapq 1 \
      --threads 16
    ```

    如果输入是标准压缩 pairs 文件，将 `contacts.pairs.pqs` 替换为
    `contacts.pairs.gz` 即可。应根据建库、比对与过滤策略设置 `--min-mapq`；
    常规转换超出可用内存时可增加 `--low-memory`。

    FASTA、contig size 和 pairs 数据必须与 AGP 第 6 列使用相同的源 contig
    名称。C-Studio 的主矩阵应停在 `pairs2cool` 这一步，不要使用
    `cphasing plot -a` 生成的 chromosome-level `*.chrom.cool`，因为 AGP
    投影由 C-Studio 自己完成。

=== "Cooler"

    从与 AGP 一致的源 contig FASTA 生成 chromosome sizes：

    ```bash
    samtools faidx source-contigs.fa
    cut -f1,2 source-contigs.fa.fai > source-contigs.chrom.sizes
    ```

    标准 4DN pairs 的第 2/3 列和第 4/5 列分别是 `chrom1/pos1` 和
    `chrom2/pos2`。使用
    [`cooler cload pairs`](https://cooler.readthedocs.io/en/latest/cli.html#cooler-cload-pairs)
    生成固定 1 kb、symmetric-upper 的 COOL：

    ```bash
    cooler cload pairs \
      -c1 2 -p1 3 -c2 4 -p2 5 \
      source-contigs.chrom.sizes:1000 \
      contacts.pairs.gz \
      contacts.1k.cool
    ```

    标准 pairs 位点是 1-based。只有当实际输入位点为 0-based 时才添加
    `--zero-based`。应在构建 COOL 前决定 MAPQ 过滤标准；已聚合计数无法恢复
    之前丢弃的接触。

## 使用 cool2mcool 转换为 MCOOL

从 [C-Studio Releases](https://github.com/wangyibin/C-Studio/releases) 下载
`linux-x86_64`、`linux-aarch64` 或 `macos-arm64` 软件包。这个独立 Rust
命令要求输入为固定 bin、symmetric-upper 的 1 kb COOL；输出为多分辨率
MCOOL，每个输出分辨率都会写入 ICE、KR、VC 和 VC_SQRT 向量。

例如，下载 Linux 软件包后运行：

```bash
tar -xzf cool2mcool-*-linux-x86_64.tar.gz
./cool2mcool-*-linux-x86_64/cool2mcool \
  /absolute/path/contacts.1k.cool \
  /absolute/path/contacts.mcool
```

Linux ARM64 用户改用 `linux-aarch64`，Apple Silicon macOS 用户改用
`macos-arm64` 软件包。

如需从源码构建，则在仓库根目录中运行：

```bash
cd tools/cool2mcool
pixi install
pixi run run /absolute/path/contacts.1k.cool /absolute/path/contacts.mcool
```

默认输出分辨率为 1 kb、5 kb、10 kb、25 kb、50 kb、100 kb、250 kb、500 kb、
1 Mb 和 2.5 Mb。可使用 `--threads`、`--level-parallelism` 和
`--resolutions`；只在需要用成功生成的新文件替换旧输出时使用 `--force`：

```bash
pixi run run \
  --threads 8 \
  --level-parallelism 2 \
  --resolutions 2500000,1000000,500000,250000,100000,50000,25000,10000,5000,1000 \
  /absolute/path/contacts.1k.cool \
  /absolute/path/contacts.mcool
```

作为标准 Cooler 替代方案，可使用
[`cooler zoomify`](https://cooler.readthedocs.io/en/latest/cli.html#cooler-zoomify)：

```bash
cooler zoomify \
  --resolutions 1000,5000,10000,25000,50000,100000,250000,500000,1000000,2500000 \
  --balance \
  --out contacts.mcool \
  contacts.1k.cool
```

标准 Cooler 生成的归一化列与 `cool2mcool` 写入的四列不完全相同；在
C-Studio 中选择归一化前应先检查输出文件。

## 生成 PAF 共线性比对

C-Studio 把 PAF query 作为可编辑源 contig 轴，把 PAF target 作为参考轴。
因此，传给 minimap2 的第二个 FASTA 必须使用与 AGP 第 6 列一致的序列名：

```bash
minimap2 -cx asm5 -t 16 \
  reference.fa \
  source-contigs.fa \
  > alignments.paf
```

根据预期组装差异选择 `asm5`、`asm10` 或 `asm20` preset。C-Studio 读取
PAF 前 12 列；可以保留可选 `cg` 或 `cs` tag，但不是必需。参见
[minimap2 assembly alignment 文档](https://github.com/lh3/minimap2#full-genomeassembly-alignment)。

## 生成覆盖度轨道

先把用于覆盖度的 reads 比对到 `source-contigs.fa`，然后输出四列、0-based
half-open bedGraph。对坐标排序 BAM 可运行：

```bash
samtools sort -@ 16 -o reads.sorted.bam reads.bam
samtools index reads.sorted.bam
bedtools genomecov -ibam reads.sorted.bam -bga > coverage.bedgraph
```

`-bga` 包含零覆盖区间；如需更小的仅非零轨道，可使用 `-bg`。参见
[`bedtools genomecov` 文档](https://bedtools.readthedocs.io/en/latest/content/tools/genomecov.html)。

原始 `samtools depth` 输出为三列，不能直接作为 C-Studio coverage 轨道。
如有需要，请转为 bedGraph 坐标：

```bash
samtools depth -aa reads.sorted.bam \
  | awk 'BEGIN { OFS="\t" } { print $1, $2 - 1, $2, $3 }' \
  > coverage.bedgraph
```

## 准备 GFA 证据

使用组装器输出的 GFA，例如 primary-unitig GFA。不要根据 AGP 邻接关系虚构图连接。
所需的每个 segment 都应有 `S` 记录，名称与 AGP component ID 一致，并从 segment
序列或 `LN` tag 获取长度。显式 `L` 记录提供图拓扑。

## 加载前验证标识符

对比 AGP component ID 与 COOL chromosome 名：

```bash
awk '$5 != "N" && $5 != "U" { print $6 }' assembly.agp \
  | sort -u > agp.components.txt
cooler dump -t chroms contacts.1k.cool \
  | cut -f1 | sort -u > cool.chroms.txt
comm -3 agp.components.txt cool.chroms.txt
```

如果没有输出，表示两组标识符一致。打开 C-Studio 前还应检查矩阵和 MCOOL 层级：

```bash
cooler info contacts.1k.cool
cooler ls contacts.mcool
cooler info contacts.mcool::/resolutions/1000
```

最后，把准备好的文件放入同一目录，并按[项目目录发现规则](project-data.md)加载。
