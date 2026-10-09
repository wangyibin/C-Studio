# 快速开始

本页介绍如何加载一个项目、尝试编辑并保存结果。建议保留源 AGP，把编辑结果
另存为新文件，方便之后对照或重新开始。证据视图用于辅助判断，编辑由你手动执行。

如果尚未生成输入文件，请先按[准备输入文件](user-guide/input-preparation.md)操作。

## 下载示例数据

从 [C-Studio v0.5.0 Release](https://github.com/wangyibin/C-Studio/releases/tag/v0.5.0)
下载 [`examples.tar.gz`](https://github.com/wangyibin/C-Studio/releases/download/v0.5.0/examples.tar.gz)
并解压。在 C-Studio 中选择 **Add Data → Load project folder…**，
然后选择解压后的示例项目目录。

压缩包包含以下示例文件：

```text
groups.final.agp
alfalfa.mapq1.mcool
alfalfa.coverage.bedgraph
ref.align.paf
alfalfa.p_utg.noseq.gfa
```

## 1. 准备项目目录

使用自己的数据时，建议把输入文件复制到一个单独的项目目录中。编辑组装需要
AGP 文件，接触矩阵、共线性、覆盖度和组装图均为可选输入。

```text
my-project/
├── assembly.agp
├── contacts.mcool
├── alignments.paf
├── coverage.depth
└── assembly.gfa
```

程序只读取项目目录顶层的文件，不进入子目录。同一类型有多个文件时，C-Studio
会按固定规则选择其中一个，并列出跳过的文件。具体规则见[项目数据](user-guide/project-data.md)。

## 2. 加载数据

选择 **Add Data → Load project folder…**。也可以使用 **Add Data** 菜单中的
单文件加载选项逐个添加文件。

从源码目录运行时，**Load example project** 可以打开该目录下的 `examples/`。
使用安装包时，请先按上文下载并解压 v0.5.0 示例数据，再通过
**Load project folder…** 加载示例项目目录。

## 3. 检查工作区

先在状态栏和 **Project Info** 中确认加载的是正确的组装与接触矩阵，再检查：

- 主热图和覆盖度轨道；
- 检查面板中的 **Overview**、**Synteny** 和 **GFA** 标签页；
- 染色体、组装块（block）和 contig 的标注框；
- 已加载 GFA 时，用于识别同源染色体的正则表达式。

AGP、接触矩阵 bin、PAF、覆盖度和 GFA 中的 contig 标识需要一致，否则相应证据
可能无法正确对应到组装中的位置。

## 4. 导航与选择

- 拖动热图进行平移。
- 滚轮默认沿对角线平移；配合平台对应的修饰键，可以切换分辨率或垂直平移。
- 点击 **Fit** 回到全组装视图。
- 在 X/Y **Jump** 输入框中输入 `contig` 或 `contig:start-end`，跳转到对应区域。
- 按住 Shift 单击组装标注，选择 contig 或染色体；按住 Shift 拖动，选择多个 contig。
  在同步轨道中，按住 Command/Control 单击可选中或取消选中单个 contig。

完整操作说明见[导航与选择](user-guide/navigation-selection.md)。

## 5. 尝试编辑并撤销

右键单击选中的组装对象，选择 **Reverse / rotate selection**、**Copy** 或
**Move to debris** 等操作。编辑后，接触图、轨道和其他证据视图会按照新的 AGP
布局更新。

继续编辑前，先用 **Undo** 撤销这次操作，或在 **History** 中查看编辑记录，
确认能够恢复到编辑前的状态。删除操作需要确认；如果某段源序列在删除后一个
拷贝也不剩，对话框会提示。

## 6. 保存编辑后的 AGP

macOS 按 ++cmd+s++，Windows 按 ++ctrl+s++，也可以点击保存图标。
C-Studio 会同时保存编辑后的 AGP 和同前缀的 `.history.json` 历史文件。
历史文件记录已执行和已撤销的操作；与 AGP 匹配时，重新打开项目后可以恢复
这些记录，继续撤销或重做。

!!! important "首次保存需要选择文件位置"

    加载 AGP 后，程序不会自动把源文件设为保存目标。第一次手动保存时，
    需要选择文件位置。设置好保存位置后，可以启用自动保存；每次编辑约五秒后，
    程序会同时写入 AGP 和历史文件。

压缩的 `.agp.gz` 只作为输入文件，不会被直接覆盖。请先另存为未压缩的 `.agp`，
再启用自动保存。
