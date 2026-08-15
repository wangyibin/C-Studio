# 证据视图

## 接触矩阵

接触矩阵从 `.cool` 或 `.mcool` 读取，并通过当前 AGP 的顺序、方向、拆分、移动和
复制关系重新投影。可用归一化包括：

- **None (Raw)**
- **ICE (Balanced)**
- **KR (Balanced)**
- **VC (Coverage)**
- **VC_SQRT**

归一化是否可用、计算代价多大，取决于输入中已经存储的内容以及还需要计算的内容。
大型多尺度浏览优先使用 `.mcool`，因为其已存储的金字塔层级可以避免反复聚合单个
精细 `.cool` 层级。

颜色范围可以手动输入，也可用 **Auto** 估计。改变颜色范围只影响渲染，不改变
底层计数或 AGP。

## 覆盖度轨道

覆盖度接受四列 bedGraph 风格记录：

```text
chrom  start  end  value
```

空行、注释以及 `track`/`browser` 指令会被忽略。区间必须是有效的 0-based
half-open 区间。记录投影到每个匹配 AGP 放置时按长度加权。

该轨道支持显示/隐藏、手动/自动范围、同步选择、平移与缩放。

## PAF 共线性

PAF query 名称与 AGP 源 component ID 匹配。检查器中的紧凑预览可展开为交互式
分屏。query 轴跟随编辑后的组装和共享热图 X 视口；target 轴仍使用 PAF 参考
坐标系。

PAF 只是证据。选择 dotplot block 会选中相应 AGP 单元，但比对不会自动重命名、
调整方向或移动它。

## GFA 组装图

GFA segment 名称与 AGP component ID 匹配。图面板提供三种布局：

- **Curation**：按 AGP 顺序排列染色体，并保持 unitig 位于各自 assembly block；
- **Guided**：保留 AGP 主干，并显示选择或热图焦点周围一层 GFA 邻居；
- **Whole**：以图拓扑为主，AGP link 作为独立可选图层。

可独立控制的图层与过滤包括 GFA link、端点 **3D Contacts**、AGP 邻接/gap、
homolog、non-homolog、anchor–unanchor、未放置 unitig 和断开岛。证据图层首先
是显示控制，不会改写 AGP。

**Review** 队列明确为只读。它可以报告端点冲突、跨 gap 连接、强非邻接三维
接触对和拷贝歧义，并同时给出证据支持内容与限制。用户可以先定位候选，再单独选择
组装操作。

未放置 GFA segment 使用明确的放置对话框。确认放置属于 AGP 编辑，会写入历史；
仅拖动图节点只改变图布局，不改变组装。

## 同源正则表达式

全局正则用于在 GFA 布局中分类 scaffold 名称。捕获组 1 定义同源列，捕获组 2
定义列内染色体顺序。默认值为：

```regex
(Chr\d+)g(\d+)
```

请使用与项目实际 scaffold 命名方式匹配的表达式。无效或不匹配的表达式会限制
同源感知布局与过滤，但不会改变 AGP 标识。

