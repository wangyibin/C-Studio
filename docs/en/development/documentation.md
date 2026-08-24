# Build the documentation

The documentation uses separate English and Chinese source trees and
configuration files. Zensical builds both sites from the `mkdocs_*.yml`
configuration.

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
```

## Install the documentation environment

Install [Pixi](https://pixi.sh/latest/installation/), then create the locked
`docs` environment:

```bash
pixi install -e docs
```

Pixi installs Python, Git, Zensical, and the locked documentation dependencies.
Do not install these tools into a separate virtual environment.

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
