# 快速开始

下面的流程会保留可恢复的源 AGP，并明确区分证据与编辑操作。

如果尚未生成输入文件，请先按[准备输入文件](user-guide/input-preparation.md)操作。

## 下载示例数据

从 [C-Studio v0.5.0 Release](https://github.com/wangyibin/C-Studio/releases/tag/v0.5.0)
下载 [`examples.tar.gz`](https://github.com/wangyibin/C-Studio/releases/download/v0.5.0/examples.tar.gz)
并解压。若要打开解压后的示例，请选择 **Add Data → Load project folder…**，
然后选中对应的项目目录。

压缩包包含以下示例文件：

```text
groups.final.agp
alfalfa.mapq1.mcool
alfalfa.coverage.bedgraph
ref.align.paf
alfalfa.p_utg.noseq.gfa
```

## 1. 准备项目目录

处理真实项目时，建议把输入文件的副本放到一个独立目录中。组装编辑需要 AGP，
其他证据均为可选。

```text
my-project/
├── assembly.agp
├── contacts.mcool
├── alignments.paf
├── coverage.depth
└── assembly.gfa
```

程序只扫描目录顶层。同一类型存在多个候选文件时，C-Studio 会按确定性规则加载
一个，并把其他候选报告为已跳过。精确规则见[项目数据](user-guide/project-data.md)。

## 2. 加载数据

选择 **Add Data → Load project folder…**。也可以使用 **Add Data** 下的
单文件入口逐个加载。

从源码检出目录运行时，**Load example project** 可以打开检出目录中的
`examples/` 目录。使用安装包时，请按上文下载并解压 v0.5.0 示例数据，
再手动加载对应的示例项目目录。

## 3. 检查工作区

先确认状态栏和 **Project Info** 显示了预期的组装与矩阵，再检查：

- 主热图和覆盖度轨道；
- 检查器中的 **Overview**、**Synteny** 和 **GFA** 标签；
- 染色体、block 与 contig 标注框；
- 存在 GFA 时的同源染色体正则表达式。

如果 AGP、接触矩阵 bin、PAF、覆盖度和 GFA 中的 contig 标识不一致，相应证据
将无法可靠投影。

## 4. 导航与选择

- 拖动热图进行平移。
- 滚轮默认沿对角线平移；使用平台对应的组合滚轮切换分辨率或垂直移动。
- 点击 **Fit** 回到全组装视图。
- 在 X/Y **Jump** 中输入 `contig` 或 `contig:start-end`。
- Shift 单击组装标注可选择 contig 或染色体；Shift 拖动选择多个 contig；
  在同步轨道中用 Command/Control 单击切换单个 contig。

完整交互见[导航与选择](user-guide/navigation-selection.md)。

## 5. 执行一次可撤销编辑

右键选中的组装对象，选择 **Reverse / rotate selection**、**Copy** 或
**Move to debris** 等操作。观察接触矩阵、轨道和证据视图如何按编辑后的 AGP
重新投影。

继续操作前，使用 **Undo** 或 **History** 验证可恢复性。删除需要确认，并会报告
是否有源区间在删除后不再保留任何拷贝。

## 6. 保存编辑后的 AGP

macOS 按 ++cmd+s++，Windows 按 ++ctrl+s++，也可以点击保存图标。
C-Studio 会同时保存编辑后的 AGP 和同前缀 `.history.json` sidecar，后者记录
可兼容恢复的撤销/重做时间线。

!!! important "首次保存会选择目标路径"

    加载 AGP 不会把源文件自动设为保存目标。首次手动保存会询问写入
    位置。建立目标后，可选自动保存会在变更约五秒后同时写入 AGP 和
    history sidecar。

压缩的 `.agp.gz` 不会被直接覆盖。请先保存到普通 AGP 目标，再启用自动
保存。
