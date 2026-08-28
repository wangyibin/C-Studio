# 故障排查

## 无法打开 C-Studio

请从官方 [GitHub Releases](https://github.com/wangyibin/C-Studio/releases)
下载与平台匹配的安装包。macOS 上确认下载来源后，按住 Control 点按应用并选择**打开**；
Windows 上出现 SmartScreen 警告时，也应先确认安装程序来源。

## C-Studio 没有找到项目文件

选择的文件夹顶层应包含普通文件。支持 `.agp`、`.gfa`/`.gfa1`、`.paf`、
`.depth`/`.bedgraph`/`.bg`、`.cool` 和 `.mcool`；文本文件可以使用 `.gz` 后缀。
当 macOS 或 Windows 请求权限时，请允许 C-Studio 访问所选文件夹。

## 热图或证据视图为空

AGP component ID 必须与接触矩阵、PAF、覆盖度和 GFA 中的 chromosome 或 segment
名称一致。随后检查当前视图、分辨率、颜色范围、归一化和图层可见性。回到全组装视图并
使用 **Auto** 颜色范围可作为安全复位。

## 无法保存或恢复历史

请先使用**另存为**选择一个可写、未压缩的 AGP 目标；自动保存不能覆盖 `.agp.gz`
输入文件。若要恢复历史，将 `<AGP-prefix>.history.json` 放在匹配 AGP 旁边。格式错误或
不兼容的 sidecar 会被忽略，但 AGP 仍可正常打开。

## GFA 视图或同源布局缺失

GFA 需要名称匹配的有效 `S` 记录。若同源布局未出现，请设置 **Homolog regex**：捕获组
1 表示同源组，捕获组 2 表示组内顺序；例如 `(Chr\d+)g(\d+)` 可匹配 `Chr01g1`。

## “Load example project” 无法使用

该辅助功能依赖源码检出目录的 `examples/`。在安装包中，请改为逐个加载示例文件。
