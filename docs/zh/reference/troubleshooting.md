# 故障排查

## 文件或目录选择器没有打开

当前桌面版在 macOS 和 Windows 上使用 Tauri 原生对话框插件。如果旧版本报告
“only implemented for macOS”，请更新到当前版本。否则，请确认应用具有
所选目录的访问权限，并检查是否有原生对话框隐藏在主窗口后面。真实 Windows
桌面行为仍应在发布 QA 中单独检查。

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
不能被覆盖；仅加载 AGP 不会建立保存目标。如果已选目标消失或不可写，
C-Studio 会退回另存为或报告错误。

## 已保存历史没有恢复

请把 `<AGP-prefix>.history.json` 与对应 AGP 放在同一目录。C-Studio 会拒绝
格式错误的 sidecar，也会拒绝内嵌规范 AGP 与当前布局不匹配的 sidecar。
AGP 仍会正常加载，应用日志会记录该 sidecar 已被忽略。

## 无法打开打包应用

当前 macOS 包未公证；确认包来源后右键并选择**打开**。Windows 包没有签名，
可能触发 SmartScreen。这些警告不能通过修改 C-Studio 设置消除。

## 安装包中 “Load example project” 失败

当前辅助功能依赖源码检出目录中的 `examples/`，尚未验证为安装包资源。在完成
bundling 前，请从源码运行或逐个加载示例文件。
