# 数据格式

## AGP

C-Studio 期望制表符分隔的九列 AGP。component 行提供 object 坐标、component
类型、component ID、源坐标和方向；`N`、`U` 行提供 gap 长度、类型、linkage
和 evidence。

- AGP 坐标为 1-based closed；
- C-Studio 内部区间为 0-based half-open；
- component ID 是其他证据查询源数据的键；
- `+`、`-`、`?`、`0`、`na` 会作为合法方向值保留并导出；
- gap 存在时保留其元数据；**Delete gap / join blocks** 会明确删除该 gap。

导出时，object 坐标与 part number 会按当前放置顺序重新生成；源 component 坐标
仍与编辑后的源区间绑定。

## COOL 与 MCOOL

`.cool`、`.mcool` 是 Cooler 兼容的 HDF5 接触矩阵容器。C-Studio 读取
chromosome/bin 标识、稀疏 pixel、已存分辨率和所选归一化需要的可用 weight。

- `.cool` 包含一个矩阵分辨率；
- `.mcool` 可包含分辨率金字塔，大型数据优先使用；
- 这些文件不能再用 gzip 包裹；
- 矩阵标识必须与 AGP component ID 一致。

## PAF

C-Studio 读取标准 PAF 前 12 列，使用 query 名称、query 长度与区间、strand、
target 名称与区间、匹配残基数、比对 block 长度和 mapping quality 构建共线性
视图。query 名称必须与 AGP component ID 一致。

## 覆盖度

覆盖度输入用空白字符分隔，格式类似 bedGraph：

```text
chrom  start  end  value
```

区间为 0-based half-open。`start` 不能为负，`end` 必须大于 `start`，`value`
必须为数值。以 `#`、`track`、`browser` 开头的行会被忽略。

## GFA

当前解析器使用以下 GFA 记录：

- `S`：segment 名称、序列或 `LN` 长度，以及可选的 `rd` 深度标签；
- `L`：带方向的 segment link 与 overlap CIGAR/字符串；
- `A`：每个 segment 的记录计数及可选 `HG` 单倍型标签。

`A` 记录和 `rd` 标签属于 segment 元数据，不会被提升为 GFA 边支持。只有明确且
有效的 `L` 记录会创建拓扑连接。指向缺失 `S` segment 的 link、无效行和重复
link 会被警告或过滤。

## gzip 文本输入

AGP、GFA、PAF、depth 和 bedGraph 文本可使用最终 `.gz` 后缀。C-Studio 支持
多成员 gzip 解码。自动保存不会覆盖压缩 AGP，请另存到普通 `.agp` 目标。

