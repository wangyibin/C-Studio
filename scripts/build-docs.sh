#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"

zensical build --strict --clean -f mkdocs_en.yml
zensical build --strict --clean -f mkdocs_zh.yml

printf 'Documentation built at %s/site/index.html and %s/site/zh/index.html\n' \
  "$project_dir" "$project_dir"
