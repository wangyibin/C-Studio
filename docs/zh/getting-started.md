# 快速开始

下面的流程会保留可恢复的源 AGP，并明确区分证据与编辑操作。

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

在 macOS 上选择 **Add Data → Load project folder…**。也可以使用 **Add Data** 下
的单文件入口逐个加载。

若要检查随源码提供的开发示例，选择 **Load example project**。当前该功能从源码
检出目录解析文件，不能视为已经验证过的安装包内置数据。

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

!!! warning "自动保存可能覆盖项目 AGP"

    通过 **Load project folder…** 加载的普通 `.agp` 会被视为可写保存目标。
    启用自动保存后，编辑约在变更五秒后写回。若输入必须保持不变，请先复制。

压缩的 `.agp.gz` 不会被直接覆盖。首次 **Save As** 会创建普通 AGP 目标，之后
才能为该目标启用自动保存。

