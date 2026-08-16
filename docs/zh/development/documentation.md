# 构建文档

文档沿用当前 C-Phasing 的双语模式，英文与中文使用独立源目录和配置文件。构建器
为 Zensical；保留 `mkdocs_*.yml` 格式，是因为 Zensical 原生兼容 Material for
MkDocs 配置。

## 目录结构

```text
docs/
├── en/                 # 英文源文件
└── zh/                 # 简体中文源文件
mkdocs_en.yml           # 英文 -> site/
mkdocs_zh.yml           # 中文 -> site/zh/
pixi.toml               # 文档环境与可复用任务
pixi.lock               # Conda 与 PyPI 依赖的精确锁定
scripts/build-docs.sh   # Pixi 任务的兼容包装脚本
.github/workflows/docs.yml
```

## 安装文档环境

先安装 [Pixi](https://pixi.sh/latest/installation/)，再创建已锁定的 `docs`
环境：

```bash
pixi install -e docs
```

Pixi 会安装 Python、Git、Zensical，以及固定到指定提交的 Zensical 兼容版 Mike。
无需再为这些工具创建独立虚拟环境。

## 构建两种语言

```bash
pixi run --locked -e docs docs-build
```

该任务执行：

```bash
zensical build --strict --clean -f mkdocs_en.yml
zensical build --strict --clean -f mkdocs_zh.yml
```

英文写入 `site/`，中文写入 `site/zh/`。Zensical 默认启用链接验证，严格模式会
把警告转为构建失败。

预览合并结果：

```bash
pixi run --locked -e docs docs-serve
```

分别打开 `http://127.0.0.1:8000/` 与
`http://127.0.0.1:8000/zh/`。

撰写时只实时预览一种语言：

```bash
pixi run --locked -e docs docs-serve-en
```

## 保持翻译同步

新增或重命名页面时：

1. 同时更新 `docs/en/` 与 `docs/zh/`；
2. 同时更新两个 `nav`；
3. 保持对应的相对链接；
4. 运行两种语言的严格构建；
5. 对照当前应用实现审查所有功能声明。

不要把不确定性翻译成确定性。平台支持、生物学验证、发布可用性和性能，都应明确
说明真正验证过的内容。

## 多版本 GitHub Pages

发布采用与 C-Phasing 一致的 Mike 目录结构。英文和中文在同一个 `gh-pages`
分支上分别维护版本索引：

| 来源事件 | 英文 URL | 中文 URL |
| --- | --- | --- |
| 推送到 `main` | `/C-Studio/dev/` | `/C-Studio/zh/dev/` |
| `v0.2.0` 等标签 | `/C-Studio/v0.2.0/` | `/C-Studio/zh/v0.2.0/` |
| 最新正式版别名 | `/C-Studio/latest/` | `/C-Studio/zh/latest/` |

第一次发布 `main` 时，站点根目录会跳转到 `dev`；第一次发布版本标签后，两种
语言的根目录都会改为跳转到 `latest`。旧版本继续保留在 `gh-pages`，重新发布
某个版本只会替换该版本。

工作流提供两个可选的手动输入：

- `backfill_tags` 发布一个或多个历史标签中保存的文档。每个标签必须同时包含
  `docs/en/index.md` 与 `docs/zh/index.md`。
- `update_docs_version` 用运行工作流时所选 ref 的文档覆盖一个已有版本。它只
  用于修订已发布文档，不会重新构建应用程序版本。

两个输入都留空时，会发布所选标签，或从所选分支刷新 `dev`。工作流会拒绝同时
使用两个输入。

Mike 固定到 `pixi.lock` 中记录的 Zensical 兼容分支及提交。每次发布前，工作流
先运行严格的 `docs-build` 双语构建任务；随后 Mike 把各版本产物提交到
`gh-pages`。

在 **Settings → Pages → Source** 中选择 **Deploy from a branch**，分支选择
`gh-pages`，目录选择 `/ (root)`。只有规范仓库 `wangyibin/C-Studio` 的发布任务
具有写权限；拉取请求只执行严格构建，不发布页面。

如需本地检查完整版本站点，请在一次性克隆中运行不带 `--push` 的命令：

```bash
pixi run --locked -e docs mike deploy -F mkdocs_en.yml v0.0.0-test latest
pixi run --locked -e docs mike deploy -F mkdocs_zh.yml --deploy-prefix zh v0.0.0-test latest
pixi run --locked -e docs mike set-default -F mkdocs_en.yml latest
pixi run --locked -e docs mike set-default -F mkdocs_zh.yml --deploy-prefix zh latest
pixi run --locked -e docs mike serve
```

这些命令会在本地创建 `gh-pages` 提交。仅测试时不要添加 `--push`。

当前配置假定仓库和站点地址为 `wangyibin/C-Studio` 与
`wangyibin.github.io/C-Studio`。如果发布到其他位置，需要同步修改 `repo_url`、
`site_url`、工作流中的规范仓库条件和两个语言切换链接。
