# 故障排查

## 选择器报告 “only implemented for macOS”

原生项目目录、`.cool/.mcool`、PAF 和覆盖度选择器目前没有非 macOS 后端。这是
当前实现限制，不代表文件格式错误。AGP 与 GFA 有 Web 文件输入，但完整 Windows
工作流仍需要后端支持。

## “No supported project files found”

确认支持的文件是所选目录顶层的普通文件，并使用专用扩展名：`.agp`、
`.gfa`/`.gfa1`、`.paf`、`.depth`/`.bedgraph`/`.bg`、`.cool` 或 `.mcool`。
文本格式可以增加 `.gz`。目录扫描不会发现子目录和通用 `.txt` 文件。

## 热图或轨道为空

比较 AGP component ID 与接触矩阵 chromosome 名、PAF query 名、覆盖度
chromosome 名和 GFA segment 名。只有源 ID 匹配且区间相交的证据才会被投影。

同时检查视口、所选分辨率、颜色最大值、轨道可见性和归一化。可用 **Fit** 和
**Auto** 颜色范围安全复位。

## 普通 COOL 文件很慢

单分辨率 `.cool` 在新尺度下可能反复执行昂贵的投影和聚合。日常浏览建议准备
`.mcool` 金字塔。不要比较 debug 与 release 构建的计时。

仅用于开发诊断：

```bash
CSTUDIO_PERF_LOG=1 npm run tauri dev
```

输出的计时字段属于诊断信息，不是稳定公开 API。

## GFA 导入后没有图

C-Studio 需要有效的 `S` 记录。只包含其他记录类型的输入会报告没有找到 GFA
`S` 记录。请检查制表符分隔、segment 名称、序列为 `*` 时的 `LN` 标签和解析警告。

## 同源布局缺失或无效

修改 **Homolog regex**，使捕获组 1 标识同源组、捕获组 2 提供成员顺序。对于
`Chr01g1` 这类名称，默认 `(Chr\d+)g(\d+)` 合适。表达式必须是有效的
JavaScript 正则。

## 自动保存不可用

自动保存需要可写的普通 AGP 目标。先手动保存一次以选择路径；`.agp.gz` 源文件
不能被覆盖。如果源路径消失或不可写，C-Studio 会退回另存为或报告错误。

## 无法打开打包应用

当前 macOS 包未公证；确认包来源后右键并选择**打开**。Windows 包没有签名，
可能触发 SmartScreen。这些警告不能通过修改 C-Studio 设置消除。

## 安装包中 “Load example project” 失败

当前辅助功能依赖源码检出目录中的 `examples/`，尚未验证为安装包资源。在完成
bundling 前，请从源码运行或逐个加载示例文件。

