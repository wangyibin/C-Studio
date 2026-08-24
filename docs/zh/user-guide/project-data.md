# 项目数据

AGP、COOL/MCOOL、PAF、覆盖度和 GFA 的生成命令见[准备输入文件](input-preparation.md)。

## 支持的输入

| 证据 | 扩展名 | 作用 | 编辑是否必需 |
| --- | --- | --- | --- |
| 组装 | `.agp`、`.agp.gz` | 权威且可编辑的布局 | 是 |
| 编辑历史 | `<AGP-prefix>.history.json` | 可兼容恢复的撤销/重做时间线 | 否 |
| 接触矩阵 | `.cool`、`.mcool` | 热图与三维接触证据 | 否 |
| 组装图 | `.gfa`、`.gfa1`，可带 `.gz` | 拓扑与重叠证据 | 否 |
| 共线性 | `.paf`，可带 `.gz` | 参考/查询比对视图 | 否 |
| 覆盖度 | `.depth`、`.bedgraph`、`.bg`，可带 `.gz` | 覆盖度轨道 | 否 |

单文件入口还接受部分 AGP、GFA、PAF 和覆盖度的 `.txt`、`.txt.gz` 形式；项目
目录自动发现只使用表中的专用扩展名。history sidecar 不会被独立选择；
只有当它的前缀与所选 AGP 一致，且其内嵌的规范 AGP 与当前布局匹配时，
C-Studio 才会加载。

## 项目目录发现

**Load project folder…** 只扫描所选目录顶层的普通文件，不递归进入子目录。

每种证据类型都会：

1. 对文件名进行确定性排序；
2. 选择一个文件；
3. 将同类型其他文件报告为忽略候选。

接触矩阵优先选择 `.mcool`，其次为 `.cool`；同类文件再按确定性文件名顺序决定。
文本输入可以 gzip 压缩；`.cool` 和 `.mcool` 是 HDF5 容器，不能再用 gzip 包裹。

如果选中的 AGP 为 `assembly.agp` 或 `assembly.agp.gz`，对应历史文件名为
`assembly.history.json`。不兼容或格式错误的 sidecar 会被忽略，不会套用到
其他布局。

## 标识符兼容性

AGP 的 component ID 是证据投影到编辑后可视布局时使用的不可变查询键。以下
标识应一致：

- AGP 第 6 列的 component ID；
- 接触矩阵的 chromosome/bin 名称；
- PAF query 名称；
- 覆盖度 chromosome 名称；
- GFA segment 名称。

在 C-Studio 中重命名 contig 会改变导出的显示名称，但会在当前会话中保留不可变
的源数据查询键。

## 不完整项目

C-Studio 可以加载只包含部分支持类型的目录。只有 AGP 的项目也能编辑布局并导出
AGP；对应文件未加载前，其他证据面板保持为空或禁用。

加载新项目目录会替换当前工作区。使用 **Clear all loaded data…** 明确移除全部
来源；使用 **Reload assembly…** 恢复最初加载的 AGP，同时保留其他证据。

## 平台说明

桌面应用在 macOS 和 Windows 上使用 Tauri 原生对话框插件选择项目目录和
单项数据文件。完整的真实 Windows 点击验证仍是独立的发布 QA 步骤。浏览器预览
可以使用 Web 文本文件入口，但不提供桌面端 HDF5 后端。
