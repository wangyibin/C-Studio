# Build the documentation

The documentation follows the current C-Phasing bilingual pattern, with
separate English and Chinese source trees and configuration files. Zensical is
the builder; the `mkdocs_*.yml` format is retained because Zensical natively
supports Material for MkDocs-compatible configuration.

## Layout

```text
docs/
├── en/                 # English source
└── zh/                 # Simplified Chinese source
mkdocs_en.yml           # English -> site/
mkdocs_zh.yml           # Chinese -> site/zh/
pixi.toml               # docs environment and reusable tasks
pixi.lock               # exact Conda and PyPI dependency lock
scripts/build-docs.sh   # compatibility wrapper around the Pixi task
.github/workflows/docs.yml
```

## Install the documentation environment

Install [Pixi](https://pixi.sh/latest/installation/), then create the locked
`docs` environment:

```bash
pixi install -e docs
```

Pixi installs Python, Git, Zensical, and the pinned Zensical-compatible Mike
commit. Do not install these tools into a separate virtual environment.

## Build both languages

```bash
pixi run --locked -e docs docs-build
```

The task runs:

```bash
zensical build --strict --clean -f mkdocs_en.yml
zensical build --strict --clean -f mkdocs_zh.yml
```

English is written to `site/`; Chinese is written to `site/zh/`. Zensical link
validation is enabled, and strict mode turns warnings into build failures.

Preview the combined result:

```bash
pixi run --locked -e docs docs-serve
```

Open `http://127.0.0.1:8000/` and
`http://127.0.0.1:8000/zh/`.

For live preview of one language while writing:

```bash
pixi run --locked -e docs docs-serve-en
```

## Keep translations synchronized

When adding or renaming a page:

1. update both `docs/en/` and `docs/zh/`;
2. update both `nav` sections;
3. preserve equivalent relative links;
4. run the strict two-language build;
5. review claims against the current application implementation.

Do not translate uncertainty into certainty. Platform support, biological
validation, release availability, and performance should state what was
actually verified.

## Versioned GitHub Pages

The deployment follows C-Phasing's Mike layout. English and Chinese have
independent version indexes on the same `gh-pages` branch:

| Source event | English URL | Chinese URL |
| --- | --- | --- |
| Push to `main` | `/C-Studio/dev/` | `/C-Studio/zh/dev/` |
| Tag such as `v0.2.0` | `/C-Studio/v0.2.0/` | `/C-Studio/zh/v0.2.0/` |
| Latest release alias | `/C-Studio/latest/` | `/C-Studio/zh/latest/` |

On the first `main` deployment, the site roots redirect to `dev`. The first
version tag moves both roots to `latest`. Older generated versions remain on
`gh-pages`; redeploying one version replaces only that version.

The workflow provides two optional manual inputs:

- `backfill_tags` publishes the documentation stored in one or more historical
  tags. Every requested tag must contain both `docs/en/index.md` and
  `docs/zh/index.md`.
- `update_docs_version` intentionally publishes the documentation from the
  selected workflow ref over an existing version. Use this only to correct
  released documentation without rebuilding the application release.

Leave both inputs empty to deploy the selected tag, or to refresh `dev` from
the selected branch. The workflow rejects using the two inputs together.

Mike is pinned to the Zensical-compatible fork and commit in `pixi.lock`. The
workflow runs the strict `docs-build` task before any deployment, and Mike then
commits each generated version to `gh-pages`.

Configure **Settings → Pages → Source** as **Deploy from a branch**, choose
`gh-pages`, and select `/ (root)`. The workflow has write permission only in
the canonical `wangyibin/C-Studio` repository; pull requests run the strict
build without publishing.

To inspect a versioned site locally in a disposable clone, omit `--push`:

```bash
pixi run --locked -e docs mike deploy -F mkdocs_en.yml v0.0.0-test latest
pixi run --locked -e docs mike deploy -F mkdocs_zh.yml --deploy-prefix zh v0.0.0-test latest
pixi run --locked -e docs mike set-default -F mkdocs_en.yml latest
pixi run --locked -e docs mike set-default -F mkdocs_zh.yml --deploy-prefix zh latest
pixi run --locked -e docs mike serve
```

These commands create local `gh-pages` commits. Do not add `--push` when only
testing.

The current configuration assumes the repository and site locations
`wangyibin/C-Studio` and `wangyibin.github.io/C-Studio`. Update `repo_url`,
`site_url`, the repository guard in the workflow, and both language-switch
links if the project is published elsewhere.
