# 构建文档

文档的英文与中文使用独立源目录和配置文件。Zensical 使用
`mkdocs_*.yml` 配置构建两种语言的站点。

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
```

## 安装文档环境

先安装 [Pixi](https://pixi.sh/latest/installation/)，再创建已锁定的 `docs`
环境：

```bash
pixi install -e docs
```

Pixi 会安装 Python、Git、Zensical 和已锁定的文档依赖。无需再为这些工具
创建独立虚拟环境。

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
